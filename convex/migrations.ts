/**
 * Responsibility: Fills the history window's derived columns on rows written
 *   before they existed, and rebuilds the recordNumbers table.
 * Layer: Server. Internal functions run by hand with `npx convex run`; no
 *   public entry point and no change-log rows.
 * Dependencies: convex/values, convex/server, ./_generated, ./collections,
 *   ./recordNumbers.
 *
 * The window's indexes (ADR-0013) find only rows that carry the columns, and
 * numbering reads only the number rows, so every deployment holding data
 * from before them runs both once, and again after restoring a backup
 * (docs/history-paging.md).
 */
import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import {
  internalAction,
  internalMutation,
  type ActionCtx,
  type MutationCtx,
} from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import {
  decode,
  derivedColumns,
  encode,
  flightColumns,
  type StoredRecord,
} from "./collections";
import {
  dropRecordNumber,
  recordNumberOf,
  syncRecordNumber,
} from "./recordNumbers";

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
const NUMBERED_TABLES = ["workOrders", "taskCards"] as const;
type NumberedTable = (typeof NUMBERED_TABLES)[number];
type RebuildStep = NumberedTable | "recordNumbers";
const REBUILD_PAGE = makeFunctionReference<
  "mutation",
  { step: RebuildStep; cursor: string | null },
  FilledPage
>("migrations:rebuildRecordNumbersPage");

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

function recordOf<T extends PayloadTable>(
  table: T,
  row: { uuid: string; payload: string },
): StoredRecord<T> {
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

/**
 * Brings one page of the number rows in step with the records: for a work
 * order or job card page, writes each record's row where it is missing or
 * differs; for a page of the number table, deletes rows whose record is no
 * longer a live work order or job card. Writes no record and no change-log
 * row.
 *
 * @param step - The table to page.
 * @param cursor - The page; null for the first.
 * @returns How many rows the page wrote or deleted, and the next cursor,
 *   null once the table is done.
 * @throws {Error} "Cannot derive the columns of <table> row <uuid>." for a
 *   payload its schema refuses; the page then writes nothing.
 */
export const rebuildRecordNumbersPage = internalMutation({
  args: {
    step: v.union(
      ...[...NUMBERED_TABLES, "recordNumbers" as const].map((t) =>
        v.literal(t),
      ),
    ),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { step, cursor }): Promise<FilledPage> => {
    if (step === "recordNumbers") return pruneNumbers(ctx, cursor);
    const page = await ctx.db
      .query(step)
      .paginate({ cursor, numItems: BACKFILL_PAGE });
    let filled = 0;
    for (const row of page.page)
      if (await fillNumber(ctx, step, row as Doc<NumberedTable>)) filled++;
    return { filled, cursor: page.isDone ? null : page.continueCursor };
  },
});

/**
 * Rebuilds the recordNumbers table from the work orders and job cards, one
 * page per transaction: writes each record's missing or stale row, then
 * deletes rows no live record holds (an archived or deleted job card's).
 * Idempotent and safe beside live traffic, since every write since the
 * table sets its row; run it until it reports 0 missing.
 *
 * @returns The rows written or deleted: `missing` in all, `tables` by the
 *   table paged (`recordNumbers` counts the deleted rows).
 * @throws {Error} {@link rebuildRecordNumbersPage}'s refusal of a damaged
 *   payload, after the pages before it are written.
 */
export const rebuildRecordNumbers = internalAction({
  args: {},
  handler: async (ctx) => {
    const tables: [RebuildStep, number][] = [];
    for (const step of [...NUMBERED_TABLES, "recordNumbers" as const])
      tables.push([step, await pageThrough(ctx, step)]);
    return {
      missing: tables.reduce((sum, [, written]) => sum + written, 0),
      tables: Object.fromEntries(tables),
    };
  },
});

async function pageThrough(ctx: ActionCtx, step: RebuildStep) {
  let written = 0;
  let cursor: string | null = null;
  do {
    const page: FilledPage = await ctx.runMutation(REBUILD_PAGE, {
      step,
      cursor,
    });
    written += page.filled;
    cursor = page.cursor;
  } while (cursor !== null);
  return written;
}

// The row is derived from the record, not the row's own number column, which
// a row written before the columns lacks.
async function fillNumber(
  ctx: MutationCtx,
  table: NumberedTable,
  row: Doc<NumberedTable>,
) {
  const encoded = encode(table, recordOf(table, row));
  const next = recordNumberOf(table, encoded)!;
  const stored = await ctx.db
    .query("recordNumbers")
    .withIndex("uuid", (q) => q.eq("uuid", next.uuid))
    .unique();
  if (
    stored?.aircraftUuid === next.aircraftUuid &&
    stored.kind === next.kind &&
    stored.key === next.key
  )
    return false;
  await syncRecordNumber(ctx, table, encoded);
  return true;
}

async function pruneNumbers(ctx: MutationCtx, cursor: string | null) {
  const page = await ctx.db
    .query("recordNumbers")
    .paginate({ cursor, numItems: BACKFILL_PAGE });
  let removed = 0;
  for (const row of page.page) {
    const table = row.kind === "workOrder" ? "workOrders" : "taskCards";
    const live = await ctx.db
      .query(table)
      .withIndex("uuid", (q) => q.eq("uuid", row.uuid))
      .first();
    if (live) continue;
    await dropRecordNumber(ctx, row.uuid);
    removed++;
  }
  return { filled: removed, cursor: page.isDone ? null : page.continueCursor };
}
