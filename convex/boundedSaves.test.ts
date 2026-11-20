/**
 * Responsibility: Pins that each bounded save (ADR-0013, stage S3) returns
 *   the same result and writes the same rows with two more fleet-years of
 *   history behind it, so what it leaves unread never changes what it does.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex (schema, collections, recordNumbers, workOrders,
 *   taskCards), tests/fixtures (programVolume, volumeSaves, workOrders,
 *   taskCards), src/domain (taskCards, partsRequests).
 *
 * Both databases hold the same newest year, so every save meets the same
 * records; the clock and new uuids are fixed per save, so equal writes are
 * equal rows.
 */
import { convexTest } from "convex-test";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { TableNames } from "./_generated/dataModel";
import schema from "./schema";
import { decode, encode } from "./collections";
import { syncRecordNumber } from "./recordNumbers";
import { save as saveWorkOrder } from "./workOrders";
import { save as saveTaskCard } from "./taskCards";
import { seedProgramVolume } from "../tests/fixtures/programVolume";
import {
  findVolumeTargets,
  measuredUuid,
  volumeCommand,
  volumeOperations,
  type VolumeOperation,
  type VolumeTargets,
} from "../tests/fixtures/volumeSaves";
import { workOrderCommand } from "../tests/fixtures/workOrders";
import { taskCardCommand } from "../tests/fixtures/taskCards";
import { taskCardSchema } from "../src/domain/taskCards";
import { partsRequestSchema } from "../src/domain/partsRequests";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const SEEDED_AT = Date.UTC(2026, 10, 3, 12);
const YEARS = [1, 3] as const;
const AIRCRAFT = "volume-aircraft-1";
const TEMPLATE = measuredUuid(0);
const RECURRING_LIST = measuredUuid(7);
// Two databases of up to about 22,000 rows each on a shared machine.
const SEED_TIMEOUT_MS = 180_000;
const TABLES = Object.keys(schema.tables) as TableNames[];
// Built once, so both databases get the same commands, step uuids included.
const TEMPLATE_FIELDS = taskCardCommand().fields;
const NEW_ORDER = {
  ...workOrderCommand(),
  uuid: measuredUuid(0).replace("a000", "b000"),
};
const NEW_CARD = {
  ...taskCardCommand(),
  uuid: measuredUuid(0).replace("a000", "c000"),
};

/** A save run in each database, its arguments read from that database. */
interface Save {
  name: string;
  kind: "query" | "mutation";
  fn: unknown;
  args: (ctx: QueryCtx) => Promise<object>;
}

/** What a save did: its result, and each row it wrote as it now stands. */
interface Outcome {
  result: string;
  writes: string[];
}

type Handler = (ctx: unknown, args: object) => Promise<unknown>;

const outcomes = new Map<string, Outcome[]>();

beforeAll(async () => {
  vi.useFakeTimers({ now: SEEDED_AT, toFake: ["Date"] });
  for (const years of YEARS) await runYear(years);
}, SEED_TIMEOUT_MS);

afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([
  "workOrder.save",
  "workOrder.newNumber",
  "workOrder.addItem",
  "taskCard.save",
  "taskCard.newNumber",
  "taskCard.evidence",
  "partsRequest.save",
  "cost.partUnitCost",
  "purchaseOrder.save",
  "auditHistory.weeklySummary",
  "history.costReport",
  "partsRequest.edit",
  "purchaseOrder.edit",
  "purchaseOrder.issue",
  "purchaseOrder.receive",
  "partsRequest.reserve",
  "partsRequest.issue",
  "purchaseOrder.core",
  "purchaseOrder.close",
  "partsRequest.cancel",
])("%s: the same result and writes at one and three fleet-years", (name) => {
  const [one, three] = outcomes.get(name)!;
  expect(three).toEqual(one);
});

it("writes what the saves are for", () => {
  const writes = (name: string) => outcomes.get(name)![0].writes.join("\n");
  expect(writes("workOrder.newNumber")).toContain('"key":"wo-2026-0001"');
  expect(writes("taskCard.newNumber")).toContain('"key":"tc-2026-0001"');
  expect(writes("workOrder.addItem")).toContain("partsRequest.recurring");
  expect(writes("workOrder.addItem")).toContain("workOrderCopyJobs");
  // The receipt reserves for the request it was allocated to, which holds
  // the receipt's request id from then on.
  expect(writes("purchaseOrder.receive")).toContain("Received from PO");
  for (const [name, [one]] of outcomes)
    expect(one.result, name).not.toMatch(/^"?refused/);
});

async function runYear(years: number) {
  const t = convexTest(schema, modules);
  const { accounts } = await t.run((ctx) =>
    seedProgramVolume(ctx, SEEDED_AT, years),
  );
  const targets = await t.run(async (ctx) => {
    const found = await findVolumeTargets(ctx);
    await addTemplateAndList(ctx);
    return found;
  });
  const as = t.withIdentity({ subject: accounts.admin });
  for (const save of saves(targets)) {
    const outcome = await (save.kind === "query"
      ? as.query((ctx) => run(ctx, save))
      : as.mutation((ctx) => run(ctx, save)));
    outcomes.set(save.name, [...(outcomes.get(save.name) ?? []), outcome]);
  }
}

// A job-card template for the first aircraft's first inspection, and an
// active recurring parts list for it, so adding the inspection to the open
// order copies one and owes the other.
async function addTemplateAndList(ctx: MutationCtx) {
  const inspection = (await ctx.db
    .query("inspections")
    .withIndex("aircraft", (q) => q.eq("aircraftUuid", AIRCRAFT))
    .first())!;
  const template = taskCardSchema.parse({
    ...TEMPLATE_FIELDS,
    aircraftUuid: AIRCRAFT,
    inspectionUuid: inspection.uuid,
    cardNumber: "TEMPLATE-1",
    uuid: TEMPLATE,
    version: 1,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    createdBy: "admin",
    technicianSignoff: null,
    inspectionSignoff: null,
    stepSignoffs: {},
  });
  const row = encode("taskCards", template);
  await ctx.db.insert("taskCards", row);
  await syncRecordNumber(ctx, "taskCards", row);
  const [request] = decode("partsRequests", [
    (await ctx.db.query("partsRequests").first())!,
  ]);
  const list = partsRequestSchema.parse({
    ...request,
    uuid: RECURRING_LIST,
    number: "PR-LIST",
    recurring: true,
    aircraftUuid: AIRCRAFT,
    source: { kind: "inspection", uuid: inspection.uuid, workOrderUuid: "" },
    reservations: [],
    issues: [],
  });
  await ctx.db.insert("partsRequests", encode("partsRequests", list));
}

function saves(targets: VolumeTargets): Save[] {
  const measured = volumeOperations(targets).map(fixedArgs);
  const [workOrder, taskCard, ...rest] = measured;
  return [
    workOrder,
    newWorkOrder(),
    addInspection(targets),
    taskCard,
    newTaskCard(),
    ...rest,
  ];
}

function fixedArgs(operation: VolumeOperation): Save {
  return { ...operation, args: async () => operation.args };
}

function newWorkOrder(): Save {
  const command = {
    ...NEW_ORDER,
    fields: { ...NEW_ORDER.fields, aircraftUuid: AIRCRAFT },
  };
  return {
    name: "workOrder.newNumber",
    kind: "mutation",
    fn: saveWorkOrder,
    args: async () => volumeCommand(command),
  };
}

function addInspection({ order }: VolumeTargets): Save {
  return {
    name: "workOrder.addItem",
    kind: "mutation",
    fn: saveWorkOrder,
    args: async (ctx) => {
      const stored = (await ctx.db
        .query("workOrders")
        .withIndex("uuid", (q) => q.eq("uuid", order.uuid))
        .unique())!;
      const template = (await ctx.db
        .query("taskCards")
        .withIndex("uuid", (q) => q.eq("uuid", TEMPLATE))
        .unique())!;
      const inspectionUuid = decode("taskCards", [template])[0].inspectionUuid;
      return volumeCommand({
        action: "add",
        uuid: order.uuid,
        version: decode("workOrders", [stored])[0].version,
        source: { kind: "inspection", uuid: inspectionUuid },
      });
    },
  };
}

function newTaskCard(): Save {
  const command = {
    ...NEW_CARD,
    fields: { ...NEW_CARD.fields, aircraftUuid: AIRCRAFT },
  };
  return {
    name: "taskCard.newNumber",
    kind: "mutation",
    fn: saveTaskCard,
    args: async () => volumeCommand(command),
  };
}

// Runs a registered function's handler with new uuids numbered from 1, and
// records each row it inserts, patches, replaces or deletes.
async function run(ctx: MutationCtx | QueryCtx, save: Save): Promise<Outcome> {
  let next = 0;
  const uuid = vi
    .spyOn(crypto, "randomUUID")
    .mockImplementation(
      () =>
        `00000000-0000-4000-8000-${(++next).toString(16).padStart(12, "0")}`,
    );
  const args = await save.args(ctx);
  const recorder = recordWrites(ctx);
  const handler = (save.fn as { _handler: Handler })._handler;
  try {
    const result = await handler(recorder.ctx, args);
    return await recorder.outcome(result);
  } catch (error) {
    return { result: `refused: ${String(error)}`, writes: [] };
  } finally {
    uuid.mockRestore();
  }
}

function recordWrites(ctx: MutationCtx | QueryCtx) {
  const created: string[] = [];
  const touched = new Map<string, string>();
  // A deleted row is named by its record's uuid: ids differ between the
  // databases.
  const deleted = new Map<string, string>();
  const tableOf = (id: string) =>
    TABLES.find((table) => ctx.db.normalizeId(table, id) !== null)!;
  const db = new Proxy(ctx.db, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      if (key === "insert")
        return async (table: TableNames, doc: object) => {
          const id = await value.call(target, table, doc);
          created.push(id);
          touched.set(id, table);
          return id;
        };
      if (key === "patch" || key === "replace" || key === "delete")
        return async (id: string, ...rest: unknown[]) => {
          touched.set(id, tableOf(id));
          const doc = (await target.get(id as never)) as { uuid?: string };
          if (key === "delete") deleted.set(id, doc?.uuid ?? "a row");
          return value.call(target, id, ...rest);
        };
      return value.bind(target);
    },
  });
  const scheduler = scheduledIds(ctx, created);
  return {
    ctx: { ...ctx, db, scheduler },
    outcome: async (result: unknown): Promise<Outcome> => {
      const rows = [];
      for (const [id, table] of touched) {
        const doc = await ctx.db.get(id as never);
        const { _id, _creationTime, ...row } = (doc ?? {}) as object & {
          _id?: string;
          _creationTime?: number;
        };
        const written = doc
          ? JSON.stringify(row)
          : `deleted ${deleted.get(id)}`;
        rows.push(`${table} ${written}`);
      }
      const named = (text: string) =>
        created.reduce((s, id, n) => s.replaceAll(id, `#${n}`), text);
      return {
        result: named(JSON.stringify(result ?? null)),
        writes: rows.map(named).sort(),
      };
    },
  };
}

// The scheduler, recording the ids of the jobs it schedules as created.
function scheduledIds(ctx: MutationCtx | QueryCtx, created: string[]) {
  if (!("scheduler" in ctx)) return undefined;
  const scheduler = ctx.scheduler;
  return new Proxy(scheduler, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const id = await value.apply(target, args);
        if (typeof id === "string") created.push(id);
        return id;
      };
    },
  });
}
