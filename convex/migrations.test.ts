/**
 * Responsibility: Pins the derived-column backfill and the recordNumbers
 *   rebuild: each fills older rows page by page, changes nothing else, writes
 *   no change-log row, reports what it filled, finds nothing on a second
 *   run, and names a damaged row.
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
];
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
    missing: OLD_FLIGHTS + 7,
    tables: {
      flights: OLD_FLIGHTS,
      workOrders: 1,
      taskCards: 1,
      archivedTaskCards: 1,
      costs: 2,
      partsRequests: 1,
      purchaseOrders: 1,
    },
  });
  const after = await readRows(t);
  for (const { table, rows } of after.tables)
    await expectDerivedColumns(
      t,
      table,
      rows.map((r) => r.uuid),
    );
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
    tables: Object.fromEntries(TABLES.map((table) => [table, 0])),
  });
  expect(await readRows(t)).toEqual(filled);
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
