/**
 * Responsibility: Pins the derived-column backfill, with the file rows'
 *   owner copies, the purchasing lookup keys and the purchase orders'
 *   allocation rows, and the recordNumbers rebuild: each fills older rows
 *   page by page, changes nothing else, writes no change-log row, reports
 *   what it filled, finds nothing on a second run, and names a damaged row.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/migrations.ts, convex/schema.ts,
 *   tests/fixtures (storedCollections, derivedColumns), src/data/demo.ts.
 */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { makeFunctionReference } from "convex/server";
import {
  seedStoredCollections,
  PROGRAM,
} from "../tests/fixtures/storedCollections";
import {
  expectDerivedColumns,
  expectPurchasingKeys,
  forgetDerivedColumns,
  type DerivedTable,
} from "../tests/fixtures/derivedColumns";
import { demoSnapshot } from "../src/data/demo";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const TABLES: DerivedTable[] = [
  "flights",
  "workOrders",
  "taskCards",
  "archivedTaskCards",
  "costs",
  "partsRequests",
  "purchaseOrders",
  "flightPlans",
];
// File rows that copy their owner, filled after the derived tables.
const FILE_TABLES = ["taskEvidence", "inventoryFiles"];
// More than one backfill page, so the backfill has to go on to the next.
const OLD_FLIGHTS = 150;
const backfill = makeFunctionReference<
  "action",
  Record<string, never>,
  { missing: number; tables: Record<string, number> }
>("migrations:backfillHistoryColumns");
const rebuild = makeFunctionReference<
  "action",
  Record<string, never>,
  { missing: number; tables: Record<string, number> }
>("migrations:rebuildRecordNumbers");
const [N206, , N182] = demoSnapshot().aircraft.map((a) => a.uuid);
// The fixture's live work order and job card, and its archived job card.
const ORDER = "00000000-0000-4000-8000-000000000005";
const CARD = "00000000-0000-4000-8000-000000000003";
const ARCHIVED_CARD = "00000000-0000-4000-8000-000000000004";
// The fixture's parts request and purchase order.
const REQUEST = "request-1";
const PO = "po-1";

// The seeded program, with every row of the derived tables written as it
// was before the columns: the fixture's payload rows, and OLD_FLIGHTS
// flights.
async function olderRows() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await seedStoredCollections(ctx);
    const aircraftUuid = demoSnapshot().aircraft[0].uuid;
    for (let n = 0; n < OLD_FLIGHTS; n++)
      await ctx.db.insert("flights", oldFlight(aircraftUuid, n));
  });
  return t;
}

function oldFlight(aircraftUuid: string, n: number) {
  return {
    uuid: `old-flight-${n}`,
    aircraftUuid,
    authorId: "pilot",
    pilotId: "pilot",
    startTime: new Date(Date.UTC(2025, 0, 1) + n * 3_600_000).toISOString(),
    submittedAt: Date.UTC(2025, 0, 1),
    status: "accepted" as const,
    landings: 1,
    cycles: 1,
    origin: "AAA",
    destination: "BBB",
    operation: "Mission" as const,
    flightRules: "VFR" as const,
    remarks: "",
    discrepancy: "",
  };
}

function readRows(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const tables = [];
    for (const table of TABLES)
      tables.push({ table, rows: await ctx.db.query(table).collect() });
    return { tables, audit: await ctx.db.query("audit").collect() };
  });
}

it("fills the derived columns on older rows, page by page, and changes nothing else", async () => {
  const t = await olderRows();
  const before = await readRows(t);
  const result = await t.action(backfill, {});
  expect(result).toEqual({
    missing: OLD_FLIGHTS + 8,
    tables: {
      flights: OLD_FLIGHTS,
      workOrders: 1,
      taskCards: 1,
      archivedTaskCards: 1,
      costs: 2,
      partsRequests: 1,
      purchaseOrders: 1,
      flightPlans: 1,
      taskEvidence: 0,
      inventoryFiles: 0,
    },
  });
  const after = await readRows(t);
  for (const { table, rows } of after.tables)
    await expectDerivedColumns(
      t,
      table,
      rows.map((r) => r.uuid),
    );
  await expectPurchasingKeys(t, "partsRequests", [REQUEST]);
  await expectPurchasingKeys(t, "purchaseOrders", [PO]);
  expect(after.audit).toEqual(before.audit);
  // Every field each row held before is as it was.
  expect(after.tables).toEqual(
    before.tables.map(({ table, rows }) => ({
      table,
      rows: rows.map((row) => expect.objectContaining(row)),
    })),
  );
});

it("finds nothing missing on a second run, and changes nothing", async () => {
  const t = await olderRows();
  await t.action(backfill, {});
  const filled = await readRows(t);
  expect(await t.action(backfill, {})).toEqual({
    missing: 0,
    tables: Object.fromEntries(
      [...TABLES, ...FILE_TABLES].map((table) => [table, 0]),
    ),
  });
  expect(await readRows(t)).toEqual(filled);
});

// Rows written before H5 hold no allocation rows; a stale one, such as a
// request taken off the order, is deleted. Only the order counts as filled.
it("writes each purchase order's allocation rows, and deletes stale ones", async () => {
  const t = await olderRows();
  await t.run(async (ctx) => {
    const row = (await ctx.db.query("purchaseOrders").first())!;
    const po = JSON.parse(row.payload) as { lines: object[] };
    const allocations = [
      { requestUuid: "request-1", lineUuid: "request-line-1", quantity: 1 },
    ];
    po.lines = po.lines.map((l) => ({ ...l, requestAllocations: allocations }));
    await ctx.db.patch(row._id, { payload: JSON.stringify(po) });
    await ctx.db.insert("purchaseAllocations", {
      programUuid: PROGRAM,
      poUuid: "po-1",
      requestUuid: "request-gone",
    });
  });
  expect((await t.action(backfill, {})).tables.purchaseOrders).toBe(1);
  const rows = await t.run((ctx) =>
    ctx.db.query("purchaseAllocations").collect(),
  );
  expect(
    rows.map(({ programUuid, poUuid, requestUuid }) => ({
      programUuid,
      poUuid,
      requestUuid,
    })),
  ).toEqual([
    { programUuid: PROGRAM, poUuid: "po-1", requestUuid: "request-1" },
  ]);
  expect((await t.action(backfill, {})).missing).toBe(0);
});

it("refills only the rows that lost a column", async () => {
  const t = await olderRows();
  await t.action(backfill, {});
  await forgetDerivedColumns(t, "flights", ["old-flight-7"]);
  await forgetDerivedColumns(t, "costs", ["budget-206"]);
  const result = await t.action(backfill, {});
  expect(result).toMatchObject({
    missing: 2,
    tables: { flights: 1, costs: 1 },
  });
  await expectDerivedColumns(t, "flights", ["old-flight-7"]);
  await expectDerivedColumns(t, "costs", ["budget-206"]);
});

it("refills an order's lost lookup keys and drops a request's stale one, counting each row once", async () => {
  const t = await olderRows();
  await t.action(backfill, {});
  await t.run(async (ctx) => {
    const keys = await ctx.db
      .query("purchasingKeys")
      .withIndex("record", (q) =>
        q.eq("table", "purchaseOrders").eq("uuid", PO),
      )
      .collect();
    expect(keys.map((k) => [k.kind, k.key])).toEqual([
      ["requestId", "request-1"],
    ]);
    for (const key of keys) await ctx.db.delete(key._id);
    await ctx.db.insert("purchasingKeys", {
      programUuid: PROGRAM,
      table: "partsRequests",
      kind: "component",
      key: "no-longer-repaired",
      uuid: REQUEST,
    });
  });
  expect(await t.action(backfill, {})).toMatchObject({
    missing: 2,
    tables: { partsRequests: 1, purchaseOrders: 1 },
  });
  await expectPurchasingKeys(t, "partsRequests", [REQUEST]);
  await expectPurchasingKeys(t, "purchaseOrders", [PO]);
});

it("files evidence under its card's aircraft and work order and an inventory file under its item's program, correcting stale copies", async () => {
  const t = await olderRows();
  const ids = await t.run(async (ctx) => {
    const blob = await ctx.storage.store(new Blob(["%PDF-1.4"]));
    const file = { storageId: blob, name: "f.pdf", size: 8, uploadedAt: 1 };
    const evidence = (taskCardUuid: string, workOrderUuid?: string) =>
      ctx.db.insert("taskEvidence", {
        ...file,
        taskCardUuid,
        workOrderUuid,
        category: "photo",
      });
    const item = (stockUuid: string, programUuid?: string) =>
      ctx.db.insert("inventoryFiles", {
        ...file,
        stockUuid,
        programUuid,
        type: "application/pdf",
      });
    return {
      live: await evidence(CARD),
      archived: await evidence(ARCHIVED_CARD),
      stale: await evidence(CARD, "another-order"),
      orphan: await evidence("gone-card"),
      stock: await item("stock-1"),
      moved: await item("stock-1", "another-program"),
      lost: await item("gone-stock"),
    };
  });
  const result = await t.action(backfill, {});
  expect(result.tables).toMatchObject({ taskEvidence: 3, inventoryFiles: 2 });
  const rows = await t.run(async (ctx) => ({
    live: await ctx.db.get(ids.live),
    archived: await ctx.db.get(ids.archived),
    stale: await ctx.db.get(ids.stale),
    orphan: await ctx.db.get(ids.orphan),
    stock: await ctx.db.get(ids.stock),
    moved: await ctx.db.get(ids.moved),
    lost: await ctx.db.get(ids.lost),
  }));
  // The fixture's cards are on no work order.
  const card = { aircraftUuid: N206, workOrderUuid: "" };
  expect(rows).toMatchObject({
    live: card,
    archived: { aircraftUuid: N182, workOrderUuid: "" },
    stale: card,
    stock: { programUuid: PROGRAM },
    moved: { programUuid: PROGRAM },
  });
  // A file whose owner is gone is shown nowhere, and left as it was.
  expect(rows.orphan).not.toHaveProperty("workOrderUuid");
  expect(rows.lost).not.toHaveProperty("programUuid");
});

it("names a row whose payload its schema refuses, and fills nothing on its page", async () => {
  const t = await olderRows();
  await t.run((ctx) =>
    ctx.db.insert("purchaseOrders", {
      uuid: "damaged",
      programUuid: PROGRAM,
      payload: "{}",
    }),
  );
  await expect(t.action(backfill, {})).rejects.toThrow(
    "Cannot derive the columns of purchaseOrders row damaged.",
  );
  const rows = await t.run((ctx) => ctx.db.query("purchaseOrders").collect());
  expect(rows.map((r) => r.numberValue)).toEqual([undefined, undefined]);
  await expectDerivedColumns(t, "partsRequests", ["request-1"]);
});

describe("the recordNumbers rebuild", () => {
  it("writes a row for each work order and live job card, none for an archived card, and no change-log row", async () => {
    const t = await olderRows();
    const audit = await t.run((ctx) => ctx.db.query("audit").collect());
    expect(await t.action(rebuild, {})).toEqual({
      missing: 2,
      tables: { workOrders: 1, taskCards: 1, recordNumbers: 0 },
    });
    expect(await numberRows(t)).toEqual([
      { aircraftUuid: N206, kind: "workOrder", key: "wo-1", uuid: ORDER },
      { aircraftUuid: N206, kind: "taskCard", key: "jc-1", uuid: CARD },
    ]);
    expect(await t.run((ctx) => ctx.db.query("audit").collect())).toEqual(
      audit,
    );
  });

  it("finds nothing missing on a second run, and changes nothing", async () => {
    const t = await olderRows();
    await t.action(rebuild, {});
    const rows = await numberRows(t);
    expect(await t.action(rebuild, {})).toEqual({
      missing: 0,
      tables: { workOrders: 0, taskCards: 0, recordNumbers: 0 },
    });
    expect(await numberRows(t)).toEqual(rows);
  });

  it("corrects a stale row and deletes one no live record holds", async () => {
    const t = await olderRows();
    await t.action(rebuild, {});
    await t.run(async (ctx) => {
      const order = await ctx.db
        .query("recordNumbers")
        .withIndex("uuid", (q) => q.eq("uuid", ORDER))
        .unique();
      await ctx.db.patch(order!._id, { key: "wo-2" });
      await ctx.db.insert("recordNumbers", {
        aircraftUuid: N182,
        kind: "taskCard",
        key: "jc-1",
        uuid: ARCHIVED_CARD,
      });
    });
    expect(await t.action(rebuild, {})).toEqual({
      missing: 2,
      tables: { workOrders: 1, taskCards: 0, recordNumbers: 1 },
    });
    expect((await numberRows(t)).map((r) => [r.uuid, r.key])).toEqual([
      [ORDER, "wo-1"],
      [CARD, "jc-1"],
    ]);
  });

  it("names a row whose payload its schema refuses", async () => {
    const t = await olderRows();
    await t.run((ctx) =>
      ctx.db.insert("taskCards", {
        uuid: "damaged",
        aircraftUuid: N206,
        payload: "{}",
      }),
    );
    await expect(t.action(rebuild, {})).rejects.toThrow(
      "Cannot derive the columns of taskCards row damaged.",
    );
  });
});

async function numberRows(t: ReturnType<typeof convexTest>) {
  const rows = await t.run((ctx) => ctx.db.query("recordNumbers").collect());
  return rows.map(({ _id, _creationTime, ...row }) => row);
}
