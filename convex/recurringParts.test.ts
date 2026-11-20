/**
 * Responsibility: Pins recurring parts occurrences: one per owed task, written
 *   with the work order and its derived columns, never duplicated on later
 *   saves, and none for a finished task or a closed work order.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/recurringParts, convex/workOrders, convex/partsRequests,
 *   src/domain fixtures, tests/fixtures (workOrders, derivedColumns).
 */
import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { TableNames } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { demoSnapshot } from "../src/data/demo";
import { requestDraftSchema } from "../src/domain/partsRequests";
import { workOrderCommand } from "../tests/fixtures/workOrders";
import { blankAD, blankADTask } from "../src/domain/airworthiness";
import { newWorkTask, type WorkOrder } from "../src/domain/workOrders";
import { prepareRecurringParts } from "./recurringParts";
import { expectDerivedColumns } from "../tests/fixtures/derivedColumns";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
async function setup() {
  const t = convexTest(schema, modules),
    s = demoSnapshot();
  s.inspections[0].intervalSeconds = 360000;
  s.inspections[0].lastSeconds = 2250 * 3600;
  const ad = blankAD(s.aircraft[0].uuid);
  ad.source.number = "2026-01-01";
  ad.applicability = "Applicable";
  ad.reviewRequired = false;
  ad.tasks = [
    {
      ...blankADTask(),
      description: "AD inspection",
      recurrence: "Recurring",
      intervalHours: 100,
    },
  ];
  const identity = await t.run(async (ctx) => {
    await ctx.db.insert("programs", s.programs![0]);
    for (const a of s.aircraft) await ctx.db.insert("aircraft", a);
    for (const i of s.inspections) await ctx.db.insert("inspections", i);
    await ctx.db.insert("airworthiness", {
      uuid: ad.uuid,
      aircraftUuid: ad.aircraftUuid,
      payload: JSON.stringify(ad),
    });
    const userId = await ctx.db.insert("users", {
      name: "Tech",
      active: true,
      isAdmin: true,
      groupIds: [],
    });
    const sessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 86400000,
    });
    return { subject: `${userId}|${sessionId}` };
  });
  const user = t.withIdentity(identity);
  const args = (payload: unknown) => ({
    programUuid: "demo-program",
    payload: JSON.stringify(payload),
  });
  const inspection = s.inspections.find(
    (i) => i.aircraftUuid === ad.aircraftUuid && i.intervalSeconds,
  )!;
  for (const source of [
    { kind: "airworthiness", uuid: ad.tasks[0].uuid },
    { kind: "inspection", uuid: inspection.uuid },
  ])
    await saveRecurringList(user, args, source);
  return { t, s, ad, user, args, inspection };
}

// Saves a recurring parts list for `source`, with the kind as its uuid.
async function saveRecurringList(
  user: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>,
  args: (payload: unknown) => { programUuid: string; payload: string },
  source: { kind: string; uuid: string },
) {
  const draft = requestDraftSchema.parse({
    uuid: source.kind,
    version: 0,
    source,
    recurring: true,
    mode: "parts",
    date: "2026-10-20",
    engineer: "Tech",
    priority: "P2 Routine",
    requiredBy: "",
    currency: "USD",
    lines: [
      {
        uuid: "filter",
        partNumber: "FILTER",
        description: "Filter",
        quantity: 2,
      },
    ],
  });
  await user.mutation(
    api.partsRequests.execute,
    args({ kind: "save", requestUuid: source.kind, draft }),
  );
}

function savedWorkOrder(
  t: Awaited<ReturnType<typeof setup>>["t"],
  uuid: string,
) {
  return t.run(async (ctx) => {
    const doc = await ctx.db
      .query("workOrders")
      .withIndex("uuid", (q) => q.eq("uuid", uuid))
      .unique();
    return JSON.parse(doc!.payload) as WorkOrder;
  });
}

// The mutation context with its table reads recorded, in order.
function traceQueries(ctx: MutationCtx) {
  const tables: string[] = [];
  const db = new Proxy(ctx.db, {
    get(target, key) {
      if (key === "query")
        return (table: TableNames) => {
          tables.push(table);
          return target.query(table);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { traced: { ...ctx, db }, tables };
}

it("persists recurring AD and fast-path inspection occurrences atomically without duplicating on edits", async () => {
  const { t, ad, user, args, inspection } = await setup();
  const command = workOrderCommand();
  command.tasks = [
    newWorkTask(
      { kind: "airworthiness", uuid: ad.tasks[0].uuid },
      "AD inspection",
    ),
  ];
  await user.mutation(api.workOrders.save, args(command));
  await user.mutation(
    api.workOrders.save,
    args({
      action: "add",
      uuid: command.uuid,
      version: 1,
      source: { kind: "inspection", uuid: inspection.uuid },
    }),
  );
  const read = () =>
    t.run(async (ctx) =>
      (await ctx.db.query("partsRequests").collect()).map((d) =>
        JSON.parse(d.payload),
      ),
    );
  let requests = await read();
  expect(requests.filter((r) => r.recurring)).toHaveLength(2);
  expect(requests.filter((r) => r.templateUuid)).toHaveLength(2);
  const doc = await t.run(async (ctx) =>
    ctx.db
      .query("workOrders")
      .withIndex("uuid", (q) => q.eq("uuid", command.uuid))
      .unique(),
  );
  const order = JSON.parse(doc!.payload);
  await user.mutation(
    api.workOrders.save,
    args({ ...command, version: order.version, tasks: order.tasks }),
  );
  requests = await read();
  expect(requests.filter((r) => r.templateUuid)).toHaveLength(2);
  await expectDerivedColumns(
    t,
    "partsRequests",
    requests.map((r) => r.uuid),
  );
});

it("owes nothing to a finished task or a closed work order, and reads nothing more", async () => {
  const { t, s, ad, user, args, inspection } = await setup();
  const command = workOrderCommand();
  command.tasks = [
    newWorkTask(
      { kind: "airworthiness", uuid: ad.tasks[0].uuid },
      "AD inspection",
    ),
  ];
  await user.mutation(api.workOrders.save, args(command));
  const saved = await savedWorkOrder(t, command.uuid);
  const unserved = { ...saved.tasks[0], uuid: "unserved-task" };
  const owe = (order: WorkOrder) =>
    t.run(async (ctx) => {
      const { traced, tables } = traceQueries(ctx);
      const state = { ...s, airworthiness: undefined };
      const entries = await prepareRecurringParts(traced, state, order);
      return { entries, tables };
    });
  const nothing = { entries: [], tables: ["partsRequests"] };
  for (const status of ["completed", "cancelled"] as const) {
    expect(await owe({ ...saved, status, tasks: [unserved] })).toEqual(nothing);
    expect(await owe({ ...saved, tasks: [{ ...unserved, status }] })).toEqual(
      nothing,
    );
  }
  expect(await owe({ ...saved, tasks: [unserved] })).toEqual({
    entries: [
      expect.objectContaining({
        action: "partsRequest.recurring",
        aircraftUuid: saved.aircraftUuid,
      }),
    ],
    tables: ["partsRequests", "airworthiness"],
  });
  const source = { kind: "inspection" as const, uuid: inspection.uuid };
  expect(
    (await owe({ ...saved, tasks: [{ ...unserved, source }] })).tables,
  ).toEqual(["partsRequests", "inspections"]);
});

it("owes a recurring component requirement's list, reading the requirement by its uuid", async () => {
  const { t, s, user, args } = await setup();
  const requirement = overhaulRequirement(s.aircraft[0].uuid);
  await t.run((ctx) =>
    ctx.db.insert("management", {
      uuid: requirement.uuid,
      programUuid: "demo-program",
      kind: requirement.kind,
      aircraftUuid: requirement.aircraftUuid,
      payload: JSON.stringify(requirement),
    }),
  );
  const source = { kind: requirement.kind, uuid: requirement.uuid };
  await saveRecurringList(user, args, source);
  const command = workOrderCommand();
  await user.mutation(api.workOrders.save, args(command));
  const order = await savedWorkOrder(t, command.uuid);
  const task = { ...newWorkTask(source, "Overhaul"), uuid: "overhaul-task" };
  const owed = await t.run(async (ctx) => {
    const { traced, tables } = traceQueries(ctx);
    const state = { ...s, management: undefined };
    const entries = await prepareRecurringParts(traced, state, {
      ...order,
      tasks: [task],
    });
    const rows = await ctx.db.query("partsRequests").collect();
    return { entries, tables, rows: rows.map((r) => JSON.parse(r.payload)) };
  });
  expect(owed.tables).toEqual(["partsRequests", "management"]);
  expect(owed.entries).toEqual([
    expect.objectContaining({ action: "partsRequest.recurring" }),
  ]);
  expect(owed.rows).toContainEqual(
    expect.objectContaining({
      templateUuid: source.kind,
      source: { kind: "workTask", uuid: task.uuid, workOrderUuid: order.uuid },
    }),
  );
});

// Overhauled every 60 months from the last compliance: a recurring source.
function overhaulRequirement(aircraftUuid: string) {
  return {
    kind: "componentRequirement" as const,
    uuid: "overhaul-1",
    version: 1,
    programUuid: "demo-program",
    componentUuid: "prop-1",
    aircraftUuid,
    requirementType: "Overhaul Requirement",
    description: "Propeller overhaul",
    notes: "",
    calendarIntervalValue: 60,
    calendarIntervalUnit: "MONTHS",
    timeBasis: "TSO",
    timeLimitMode: "FROM_LAST_COMPLIED",
    cycleLimitMode: "ABSOLUTE",
    warningCalendarMonths: 1,
    warningSeconds: 0,
    warningCycles: 0,
  };
}
