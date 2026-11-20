/**
 * Responsibility: Checks that rows a write path stored carry the derived
 *   columns and number rows their records derive (ADR-0013), and strips the
 *   columns to stand for rows written before they existed.
 * Layer: Test. Fixture over convex-test; never shipped in the build.
 * Dependencies: vitest, convex-test, convex/schema, convex/collections,
 *   convex/recordNumbers.
 */
import { expect } from "vitest";
import type { TestConvex } from "convex-test";
import type schema from "../../convex/schema";
import type { Doc } from "../../convex/_generated/dataModel";
import {
  decode,
  derivedColumns,
  encode,
  flightColumns,
} from "../../convex/collections";
import { recordNumberOf } from "../../convex/recordNumbers";

/** The tables whose rows carry derived columns. */
export type DerivedTable =
  | "flights"
  | "workOrders"
  | "taskCards"
  | "archivedTaskCards"
  | "costs"
  | "partsRequests"
  | "purchaseOrders";

/**
 * Expects each row to hold exactly the derived columns its record derives:
 * a column the record derives as undefined must be absent.
 *
 * @param t - The convex-test instance holding the rows.
 * @param table - The rows' table.
 * @param uuids - The rows' record uuids; each must exist.
 */
export async function expectDerivedColumns(
  t: TestConvex<typeof schema>,
  table: DerivedTable,
  uuids: readonly string[],
): Promise<void> {
  expect(uuids.length, table).toBeGreaterThan(0);
  for (const uuid of uuids) {
    const row = await t.run((ctx) =>
      ctx.db
        .query(table)
        .withIndex("uuid", (q) => q.eq("uuid", uuid))
        .unique(),
    );
    expect(row, `${table} ${uuid}`).not.toBeNull();
    const expected = derive(table, row!);
    const stored = Object.fromEntries(
      Object.keys(expected).map((key) => [key, row![key as keyof typeof row]]),
    );
    expect(stored, `${table} ${uuid}`).toEqual(expected);
  }
}

/**
 * Expects each record's number row to be the one its record derives: a work
 * order's or live job card's row as `recordNumberOf` gives it, and none for
 * a uuid no longer among them (an archived or deleted job card).
 *
 * @param t - The convex-test instance holding the rows.
 * @param table - The records' table: `archivedTaskCards` for archived cards.
 * @param uuids - The records' uuids.
 */
export async function expectRecordNumbers(
  t: TestConvex<typeof schema>,
  table: "workOrders" | "taskCards" | "archivedTaskCards",
  uuids: readonly string[],
): Promise<void> {
  expect(uuids.length, table).toBeGreaterThan(0);
  for (const uuid of uuids) {
    const { row, number } = await t.run(async (ctx) => ({
      row:
        table === "archivedTaskCards"
          ? null
          : await ctx.db
              .query(table)
              .withIndex("uuid", (q) => q.eq("uuid", uuid))
              .unique(),
      number: await ctx.db
        .query("recordNumbers")
        .withIndex("uuid", (q) => q.eq("uuid", uuid))
        .unique(),
    }));
    const expected = row && numberOf(table as "workOrders", row);
    const stored = number && {
      aircraftUuid: number.aircraftUuid,
      kind: number.kind,
      key: number.key,
      uuid: number.uuid,
    };
    expect(stored, `${table} ${uuid}`).toEqual(expected);
  }
}

/**
 * Removes the derived columns from rows, as they were stored before the
 * columns existed.
 *
 * @param t - The convex-test instance holding the rows.
 * @param table - The rows' table.
 * @param uuids - The rows' record uuids; each must exist.
 */
export async function forgetDerivedColumns(
  t: TestConvex<typeof schema>,
  table: DerivedTable,
  uuids: readonly string[],
): Promise<void> {
  for (const uuid of uuids)
    await t.run(async (ctx) => {
      const row = (await ctx.db
        .query(table)
        .withIndex("uuid", (q) => q.eq("uuid", uuid))
        .unique())!;
      const columns = Object.keys(derive(table, row));
      await ctx.db.patch(
        row._id,
        Object.fromEntries(columns.map((key) => [key, undefined])),
      );
    });
}

function derive(table: DerivedTable, row: Doc<DerivedTable>): object {
  if (table === "flights") return flightColumns(row as Doc<"flights">);
  const [record] = decode(table, [row as Doc<typeof table>]);
  return derivedColumns(table, record);
}

function numberOf(
  table: "workOrders" | "taskCards",
  row: Doc<"workOrders" | "taskCards">,
) {
  const [record] = decode(table, [row]);
  return recordNumberOf(table, encode(table, record));
}
