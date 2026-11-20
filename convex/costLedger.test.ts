/**
 * Responsibility: Pins the cost ledger (ADR-0013, stage S4): it equals the
 *   domain's totals for every period on three fleet-years, keeps an issue's
 *   recorded price through a stock cost correction, follows a job card onto
 *   a work order, its rebuild and nightly reconcile, and the cost report
 *   query.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex (costs, partsRequests, workOrders, taskCards,
 *   management, history, migrations, costLedger, collections, schema),
 *   tests/fixtures (programVolume, sampleRoles, workOrders, taskCards),
 *   src/domain (costs, workOrders, partsRequests, model).
 */
import { convexTest } from "convex-test";
import { describe, expect, it, vi, afterEach } from "vitest";
import { makeFunctionReference } from "convex/server";
import schema from "./schema";
import { api } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import { decode } from "./collections";
import { ledgerRowsOf, storedLedger } from "./costLedger";
import {
  seedProgramVolume,
  VOLUME,
  VOLUME_PROGRAM,
} from "../tests/fixtures/programVolume";
import {
  OWNED_AIRCRAFT,
  PROGRAM,
  seedSampleRoles,
  type SampleRoles,
} from "../tests/fixtures/sampleRoles";
import { workOrderCommand } from "../tests/fixtures/workOrders";
import { taskCardCommand } from "../tests/fixtures/taskCards";
import { aircraftSpendCents } from "../src/domain/costs/workOrderCosts";
import { ledgerTotals } from "../src/domain/costs/ledger";
import type { Period } from "../src/domain/costs/period";
import {
  isOpenWorkOrder,
  newWorkTask,
  workOrderFieldsSchema,
  type WorkOrder,
} from "../src/domain/workOrders";
import { requestDraftSchema } from "../src/domain/partsRequests";
import type { Member, Snapshot } from "../src/domain/model";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const SEEDED_AT = Date.UTC(2026, 10, 3, 12);
const TODAY = "2026-11-03";
const YEARS = [2024, 2025, 2026];
// Seeding three fleet-years on a shared machine.
const SEED_TIMEOUT_MS = 180_000;
const MANUAL_CENTS = 1999;
const ISSUED_DOLLARS = 1234.57;
const ISSUED_CENTS = 123_457;
const CORRECTED_DOLLARS = 1500;
const rebuild = makeFunctionReference<
  "action",
  Record<string, never>,
  { missing: number; tables: Record<string, number> }
>("migrations:rebuildCostLedger");
const reconcile = makeFunctionReference<
  "action",
  Record<string, never>,
  { differing: number; logged: string[] }
>("migrations:reconcileCostLedger");

type Client = ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;

afterEach(() => vi.useRealTimers());

describe("the cost ledger on three fleet-years", () => {
  it(
    "equals each aircraft's domain total for every month, quarter and year, with stock costs left out",
    async () => {
      vi.useFakeTimers({ now: SEEDED_AT, toFake: ["Date"] });
      const t = convexTest(schema, modules);
      const { accounts } = await t.run((ctx) =>
        seedProgramVolume(ctx, SEEDED_AT, 3),
      );
      const admin = t.withIdentity({ subject: accounts.admin });
      await costTheOpenOrder(t, admin);
      const { s, rows } = await t.run(async (ctx) => ({
        s: await programRecords(ctx),
        rows: await ledgerOf(ctx),
      }));
      const ledger = new Map(rows);
      for (const aircraftUuid of s.aircraft.map((a) => a.uuid))
        for (const period of periodsOf(YEARS))
          expect(
            ledgerTotals(ledger.get(aircraftUuid) ?? [], period).totalCents,
            `${aircraftUuid} ${period.from} ${period.to}`,
          ).toBe(aircraftSpendCents(s, aircraftUuid, period));
      expect(await t.action(reconcile, {})).toEqual({
        differing: 0,
        logged: [],
      });
    },
    SEED_TIMEOUT_MS,
  );
});

describe("the cost ledger as records change", () => {
  it("keeps an issue's recorded price after the stock item's cost is corrected", async () => {
    vi.useFakeTimers({
      now: Date.parse(`${TODAY}T16:00:00Z`),
      toFake: ["Date"],
    });
    const roles = await seedSampleRoles();
    const { t, manager } = roles;
    await addLot(t);
    const order = await openOrderWithRequest(manager, "workTask");
    await issue(manager, 2);
    await correctCost(manager, CORRECTED_DOLLARS);
    const rows = await t.run((ctx) => storedLedger(ctx, order));
    expect(rows.map((r) => [r.programUuid, r.date, r.partsCents])).toEqual([
      [PROGRAM, TODAY, 2 * ISSUED_CENTS],
    ]);
    expect(await t.action(reconcile, {})).toMatchObject({ differing: 0 });
  });

  it("brings a job card's issued parts into the work order it joins", async () => {
    vi.useFakeTimers({
      now: Date.parse(`${TODAY}T16:00:00Z`),
      toFake: ["Date"],
    });
    const roles = await seedSampleRoles();
    const { t, manager } = roles;
    await addLot(t);
    const card = await looseCard(manager);
    const order = await openOrderWithRequest(manager, "jobCard", card.uuid);
    await issue(manager, 1);
    expect(await t.run((ctx) => storedLedger(ctx, order))).toEqual([]);
    await send(manager, api.taskCards.save, {
      action: "link",
      uuid: card.uuid,
      version: 1,
      link: { kind: "workOrder", uuid: order },
    });
    await send(manager, api.costs.execute, {
      action: "part.unitCost",
      workOrderUuid: order,
      stockUuid: LOT.uuid,
      unitCents: MANUAL_CENTS,
    });
    const rows = await t.run((ctx) => storedLedger(ctx, order));
    expect(rows.map((r) => [r.date, r.partsCents])).toEqual([
      [TODAY, MANUAL_CENTS],
    ]);
    expect(await t.action(reconcile, {})).toMatchObject({ differing: 0 });
  });

  it("rebuilds rows that went missing or stale, finds nothing on a second run, and logs what the reconcile finds", async () => {
    vi.useFakeTimers({
      now: Date.parse(`${TODAY}T16:00:00Z`),
      toFake: ["Date"],
    });
    const { t, manager } = await seedSampleRoles();
    await addLot(t);
    const order = await openOrderWithRequest(manager, "workTask");
    await issue(manager, 1);
    await t.run(async (ctx) => {
      const [row] = await storedLedger(ctx, order);
      await ctx.db.patch(row._id, { partsCents: 1 });
      await ctx.db.insert("costLedger", {
        ...strip(row),
        workOrderUuid: "gone",
      });
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await t.action(reconcile, {})).toEqual({
      differing: 1,
      logged: [order],
    });
    expect(error).toHaveBeenCalledWith(
      "The cost ledger differs from its records.",
      { workOrders: 1, first: [order] },
    );
    error.mockRestore();
    expect(await t.action(rebuild, {})).toEqual({
      missing: 2,
      tables: { workOrders: 1, costLedger: 1 },
    });
    expect(await t.action(rebuild, {})).toMatchObject({ missing: 0 });
    expect(await t.action(reconcile, {})).toMatchObject({ differing: 0 });
  });
});

describe("the cost report", () => {
  it("sums each work order's ledger rows in the period for an administrator, with the year's budget", async () => {
    vi.useFakeTimers({
      now: Date.parse(`${TODAY}T16:00:00Z`),
      toFake: ["Date"],
    });
    const { t, manager, tech, board } = await seedSampleRoles();
    await addLot(t);
    const order = await openOrderWithRequest(manager, "workTask");
    await issue(manager, 1);
    await send(manager, api.costs.execute, {
      action: "budget.set",
      aircraftUuid: OWNED_AIRCRAFT,
      year: 2026,
      amountCents: 500_000,
    });
    const ask = {
      programUuid: PROGRAM,
      aircraftUuid: OWNED_AIRCRAFT,
      from: "2026-01-01",
      to: "2026-12-31",
    };
    const report = await manager.query(api.history.costReport, ask);
    expect(report.orders.map((o) => [o.workOrderUuid, o.partsCents])).toEqual([
      [order, ISSUED_CENTS],
    ]);
    expect(report.totalCents).toBe(ISSUED_CENTS);
    expect(report.budgets).toEqual([{ year: 2026, amountCents: 500_000 }]);
    const before = await manager.query(api.history.costReport, {
      ...ask,
      to: "2026-11-02",
    });
    expect(before.orders).toEqual([]);
    await expect(tech.query(api.history.costReport, ask)).rejects.toThrow(
      "Flight Program administrator required.",
    );
    await expect(board.query(api.history.costReport, ask)).rejects.toThrow(
      "Board access is read-only.",
    );
    await expect(
      manager.query(api.history.costReport, {
        ...ask,
        aircraftUuid: "another-program-aircraft",
      }),
    ).rejects.toThrow("History not found.");
    await expect(
      manager.query(api.history.costReport, { ...ask, from: "2027-01-01" }),
    ).rejects.toThrow("Choose a start date on or before the end date.");
  });
});

const LOT = {
  uuid: "ledger-lot",
  version: 1,
  programUuid: PROGRAM,
  kind: "stock",
  partNumber: "CYL-1",
  description: "Cylinder",
  category: "part",
  condition: "new",
  locationUuid: "sample-location-1",
  quantity: 4,
  minimum: 0,
  alternates: "",
  cost: ISSUED_DOLLARS,
};

function addLot(t: SampleRoles["t"]) {
  return t.run((ctx) =>
    ctx.db.insert("management", {
      uuid: LOT.uuid,
      programUuid: PROGRAM,
      kind: "stock",
      payload: JSON.stringify(LOT),
    }),
  );
}

// An open work order on the owned aircraft with one manual task, and a
// request for the lot's part on that task or on the job card named.
async function openOrderWithRequest(
  manager: Client,
  on: "workTask" | "jobCard",
  cardUuid = "",
) {
  const order = workOrderCommand();
  order.fields.aircraftUuid = OWNED_AIRCRAFT;
  order.fields.dateOpened = TODAY;
  order.tasks = [
    newWorkTask({ kind: "manual", uuid: crypto.randomUUID() }, "Cylinder"),
  ];
  await send(manager, api.workOrders.save, order);
  const source =
    on === "workTask"
      ? { kind: on, uuid: order.tasks[0].uuid, workOrderUuid: order.uuid }
      : { kind: on, uuid: cardUuid, workOrderUuid: "" };
  await send(manager, api.partsRequests.execute, {
    kind: "save",
    requestUuid: crypto.randomUUID(),
    draft: requestDraftSchema.parse({
      uuid: "ledger-request",
      version: 0,
      source,
      mode: "parts",
      date: TODAY,
      engineer: "Tech",
      priority: "P2 Routine",
      requiredBy: "",
      currency: "USD",
      lines: [
        { uuid: "line", partNumber: "CYL-1", description: "Cyl", quantity: 4 },
      ],
    }),
  });
  return order.uuid;
}

async function looseCard(manager: Client) {
  const card = taskCardCommand();
  card.fields.aircraftUuid = OWNED_AIRCRAFT;
  await send(manager, api.taskCards.save, card);
  return card;
}

async function issue(manager: Client, quantity: number) {
  for (const kind of ["reserve", "issue"])
    await send(manager, api.partsRequests.execute, {
      kind,
      requestUuid: crypto.randomUUID(),
      uuid: "ledger-request",
      version: await requestVersion(manager),
      lineUuid: "line",
      stockUuid: LOT.uuid,
      quantity,
      alternateConfirmed: false,
      date: TODAY,
    });
}

async function correctCost(manager: Client, cost: number) {
  const view = (await manager.query(api.operations.snapshot, {}))!;
  const lot = view.management!.find((r) => r.uuid === LOT.uuid)!;
  await send(manager, api.management.execute, {
    action: "record.save",
    requestUuid: crypto.randomUUID(),
    reason: "Vendor invoice",
    record: { ...lot, cost },
  });
}

async function requestVersion(manager: Client) {
  const view = (await manager.query(api.operations.snapshot, {}))!;
  return view.partsRequests!.find((r) => r.uuid === "ledger-request")!.version;
}

function send(
  as: Client,
  fn:
    | typeof api.workOrders.save
    | typeof api.taskCards.save
    | typeof api.costs.execute
    | typeof api.partsRequests.execute
    | typeof api.management.execute,
  payload: object,
  programUuid = PROGRAM,
) {
  return as.mutation(fn, { programUuid, payload: JSON.stringify(payload) });
}

// Labor and another cost on the first aircraft's open order, and a part
// issued to it at its recorded price, then given a manual unit cost.
async function costTheOpenOrder(
  t: ReturnType<typeof convexTest>,
  admin: Client,
) {
  const { order, stock } = await t.run(async (ctx) => ({
    order: await openOrderOf(ctx),
    stock: decode(
      "management",
      await ctx.db.query("management").collect(),
    ).flatMap((r) => (r.kind === "stock" ? [r] : []))[0],
  }));
  const task = newWorkTask(
    { kind: "manual", uuid: crypto.randomUUID() },
    "Part",
  );
  await send(
    admin,
    api.workOrders.save,
    {
      action: "save",
      uuid: order.uuid,
      version: order.version,
      fields: workOrderFieldsSchema.parse(order),
      componentUuids: [],
      tasks: [task],
    },
    VOLUME_PROGRAM,
  );
  const cost = (command: object) =>
    send(
      admin,
      api.costs.execute,
      { workOrderUuid: order.uuid, ...command },
      VOLUME_PROGRAM,
    );
  await cost({
    action: "labor.add",
    entry: {
      uuid: crypto.randomUUID(),
      date: "2026-10-20",
      technician: "A",
      minutes: 90,
    },
  });
  await cost({
    action: "other.add",
    entry: {
      uuid: crypto.randomUUID(),
      date: "2025-12-30",
      description: "Freight",
      amountCents: 4200,
    },
  });
  const request = (command: object) =>
    send(admin, api.partsRequests.execute, command, VOLUME_PROGRAM);
  await request({
    kind: "save",
    requestUuid: crypto.randomUUID(),
    draft: requestDraftSchema.parse({
      uuid: "volume-request",
      version: 0,
      source: { kind: "workTask", uuid: task.uuid, workOrderUuid: order.uuid },
      mode: "parts",
      date: TODAY,
      engineer: "Tech",
      priority: "P2 Routine",
      requiredBy: "",
      currency: "USD",
      lines: [
        {
          uuid: "line",
          partNumber: stock.partNumber,
          description: "Filter",
          quantity: 1,
        },
      ],
    }),
  });
  for (const [kind, version] of [
    ["reserve", 1],
    ["issue", 2],
  ] as const)
    await request({
      kind,
      requestUuid: crypto.randomUUID(),
      uuid: "volume-request",
      version,
      lineUuid: "line",
      stockUuid: stock.uuid,
      quantity: 1,
      alternateConfirmed: false,
      date: TODAY,
    });
  await cost({
    action: "part.unitCost",
    stockUuid: stock.uuid,
    unitCents: MANUAL_CENTS,
  });
}

async function openOrderOf(ctx: MutationCtx): Promise<WorkOrder> {
  const docs = await ctx.db
    .query("workOrders")
    .withIndex("aircraft", (q) => q.eq("aircraftUuid", "volume-aircraft-1"))
    .collect();
  return decode("workOrders", docs).find(isOpenWorkOrder)!;
}

// The program's records the domain totals read, with no stock record, so a
// part counts only at a price the records fix.
async function programRecords(ctx: MutationCtx): Promise<Snapshot> {
  const all = <T extends "workOrders" | "taskCards" | "archivedTaskCards">(
    table: T,
  ) => ctx.db.query(table).collect();
  const ofProgram = <D extends { programUuid: string }>(rows: D[]) =>
    rows.filter((r) => r.programUuid === VOLUME_PROGRAM);
  return {
    user: NO_ONE,
    authenticatedAt: 0,
    syncedAt: 0,
    groups: [],
    members: [],
    aircraft: await ctx.db.query("aircraft").collect(),
    flights: [],
    discrepancies: [],
    inspections: [],
    audit: [],
    management: [],
    workOrders: decode("workOrders", await all("workOrders")),
    taskCards: decode("taskCards", await all("taskCards")),
    archivedTaskCards: decode(
      "archivedTaskCards",
      await all("archivedTaskCards"),
    ),
    costs: decode("costs", ofProgram(await ctx.db.query("costs").collect())),
    partsRequests: decode(
      "partsRequests",
      ofProgram(await ctx.db.query("partsRequests").collect()),
    ),
  };
}

async function ledgerOf(ctx: MutationCtx) {
  const whole = { from: `${YEARS[0]}-01-01`, to: `${YEARS.at(-1)}-12-31` };
  const rows = [];
  for (let n = 1; n <= VOLUME.aircraft; n++) {
    const uuid = `volume-aircraft-${n}`;
    rows.push([
      uuid,
      await ledgerRowsOf(ctx, VOLUME_PROGRAM, uuid, whole),
    ] as const);
  }
  return rows;
}

// Every month and quarter of the years, and each year.
function periodsOf(years: number[]): Period[] {
  const pad = (n: number) => String(n).padStart(2, "0");
  return years.flatMap((y) => [
    ...Array.from({ length: 12 }, (_, m) => ({
      from: `${y}-${pad(m + 1)}-01`,
      to: `${y}-${pad(m + 1)}-31`,
    })),
    ...[1, 4, 7, 10].map((m) => ({
      from: `${y}-${pad(m)}-01`,
      to: `${y}-${pad(m + 2)}-31`,
    })),
    { from: `${y}-01-01`, to: `${y}-12-31` },
  ]);
}

function strip<R extends { _id: unknown; _creationTime: unknown }>(row: R) {
  const { _id, _creationTime, ...rest } = row;
  return rest;
}

const NO_ONE: Member = {
  id: "",
  name: "",
  email: "",
  active: false,
  isAdmin: false,
  groupIds: [],
};
