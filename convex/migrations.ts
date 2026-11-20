/**
 * Responsibility: Fills the history window's derived columns on rows written
 *   before they existed.
 * Layer: Server. Internal functions run by hand with `npx convex run`; no
 *   public entry point and no change-log rows.
 * Dependencies: convex/values, convex/server, ./_generated, ./collections.
 *
 * The window's indexes (ADR-0013) find only rows that carry the columns, so
 * every deployment holding data from before them runs the backfill once,
 * and again after restoring an older backup (docs/history-paging.md).
 */
import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import {
  internalAction,
  internalMutation,
  type ActionCtx,
} from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { decode, derivedColumns, flightColumns } from "./collections";

const BACKFILL_TABLES = [
  "flights",
  "workOrders",
  "taskCards",
  "archivedTaskCards",
  "costs",
  "partsRequests",
  "purchaseOrders",
] as const;
type BackfillTable = (typeof BACKFILL_TABLES)[number];
type PayloadTable = Exclude<BackfillTable, "flights">;
type FilledPage = { filled: number; cursor: string | null };
// Rows per transaction: a page of job cards, the largest payloads here, stays
// far inside Convex's per-mutation read and write limits.
const BACKFILL_PAGE = 100;
// By name, with its types spelled out: the generated reference to this
// module's own mutation would make the action's type circular.
const FILL_PAGE = makeFunctionReference<
  "mutation",
  { table: BackfillTable; cursor: string | null },
  FilledPage
>("migrations:fillHistoryColumns");

/**
 * Fills the derived columns on one page of a table's rows, where any is
 * missing or differs from what the row's record derives. Writes only those
 * columns, never the record, so no change-log row is due.
 *
 * @param table - The table to fill.
 * @param cursor - The page to fill; null for the first.
 * @returns How many of the page's rows were filled, and the next page's
 *   cursor, null once the table is done.
 * @throws {Error} "Cannot derive the columns of <table> row <uuid>." for a
 *   payload its schema refuses; the page then writes nothing.
 */
export const fillHistoryColumns = internalMutation({
  args: {
    table: v.union(...BACKFILL_TABLES.map((t) => v.literal(t))),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { table, cursor }) => {
    const page = await ctx.db
      .query(table)
      .paginate({ cursor, numItems: BACKFILL_PAGE });
    let filled = 0;
    for (const row of page.page) {
      const columns = columnsOf(table, row);
      if (holdsColumns(row, columns)) continue;
      await ctx.db.patch(row._id, columns);
      filled++;
    }
    const next = page.isDone ? null : page.continueCursor;
    return { filled, cursor: next } satisfies FilledPage;
  },
});

/**
 * Fills the history window's derived columns on every row that lacks them,
 * table by table, one page per transaction. Idempotent and safe beside live
 * traffic, since every write since the columns sets them; run it until it
 * reports 0 missing. Interrupted, a rerun skips the rows already filled.
 *
 * @returns The rows found missing or stale columns, now filled: `missing` in
 *   all, `tables` by table.
 * @throws {Error} {@link fillHistoryColumns}'s refusal of a damaged payload,
 *   after the pages before it are filled.
 */
export const backfillHistoryColumns = internalAction({
  args: {},
  handler: async (ctx) => {
    const tables: [BackfillTable, number][] = [];
    for (const table of BACKFILL_TABLES)
      tables.push([table, await fillTable(ctx, table)]);
    return {
      missing: tables.reduce((sum, [, filled]) => sum + filled, 0),
      tables: Object.fromEntries(tables),
    };
  },
});

async function fillTable(ctx: ActionCtx, table: BackfillTable) {
  let filled = 0;
  let cursor: string | null = null;
  do {
    // Annotated, as the loop's narrowing of `cursor` would make it circular.
    const page: FilledPage = await ctx.runMutation(FILL_PAGE, {
      table,
      cursor,
    });
    filled += page.filled;
    cursor = page.cursor;
  } while (cursor !== null);
  return filled;
}

function columnsOf(table: BackfillTable, row: Doc<BackfillTable>): object {
  if (table === "flights") return flightColumns(row as Doc<"flights">);
  return derivedColumns(table, recordOf(table, row as Doc<PayloadTable>));
}

function recordOf(table: PayloadTable, row: Doc<PayloadTable>) {
  try {
    return decode(table, [row])[0];
  } catch (error) {
    throw new Error(`Cannot derive the columns of ${table} row ${row.uuid}.`, {
      cause: error,
    });
  }
}

// A column the record derives as undefined holds when the row lacks it.
function holdsColumns(row: Doc<BackfillTable>, columns: object): boolean {
  return Object.entries(columns).every(
    ([key, value]) => row[key as keyof typeof row] === value,
  );
}
