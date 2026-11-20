/**
 * Responsibility: Fills the history window's derived columns and the
 *   purchasing lookup keys on rows written before they existed, rebuilds
 *   the recordNumbers and costLedger tables, and checks the ledger against
 *   its records each night.
 * Layer: Server. Internal functions run by hand with `npx convex run`, and
 *   the reconcile by crons.ts; no public entry point and no change-log rows.
 * Dependencies: convex/values, convex/server, ./_generated, ./collections,
 *   ./recordNumbers, ./costLedger, ./fileColumns, ./purchasingKeys.
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
  internalQuery,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
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
import {
  expectedLedger,
  storedLedger,
  syncWorkOrderLedger,
  type StoredLedgerRow,
} from "./costLedger";
import { storedFileColumns } from "./fileColumns";
import { syncPurchasingKeys } from "./purchasingKeys";

const BACKFILL_TABLES = [
  "flights",
  "workOrders",
  "taskCards",
  "archivedTaskCards",
  "costs",
  "partsRequests",
  "purchaseOrders",
  "flightPlans",
  // After the cards, whose work order their evidence copies.
  "taskEvidence",
  "inventoryFiles",
] as const;
type BackfillTable = (typeof BACKFILL_TABLES)[number];
type FileTable = "taskEvidence" | "inventoryFiles";
type PayloadTable = Exclude<BackfillTable, "flights" | FileTable>;
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
type LedgerStep = "workOrders" | "costLedger";
const LEDGER_PAGE = makeFunctionReference<
  "mutation",
  { step: LedgerStep; cursor: string | null },
  FilledPage
>("migrations:rebuildCostLedgerPage");
type ReconciledPage = { differing: string[]; cursor: string | null };
const RECONCILE_PAGE = makeFunctionReference<
  "query",
  { cursor: string | null },
  ReconciledPage
>("migrations:reconcileCostLedgerPage");
// Work orders named in the reconcile's log line; the count gives the rest.
const LOGGED_DIFFERENCES = 20;

/**
 * Fills the derived columns on one page of a table's rows, where any is
 * missing or differs from what the row's record derives (for a file row,
 * its owner: the card's aircraft and work order, the item's program), and a
 * parts request's or purchase order's lookup keys (convex/purchasingKeys.ts).
 * Writes only those, never the record, so no change-log row is due.
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
    for (const row of page.page) if (await fillRow(ctx, table, row)) filled++;
    const next = page.isDone ? null : page.continueCursor;
    return { filled, cursor: next } satisfies FilledPage;
  },
});

/**
 * Fills the history window's derived columns on every row that lacks them,
 * and the parts requests' and purchase orders' lookup keys, table by table,
 * one page per transaction. Idempotent and safe beside live traffic, since
 * every write since the columns and keys sets them; run it until it reports
 * 0 missing. Interrupted, a rerun skips the rows already filled.
 *
 * @returns The rows found missing or stale columns or keys, now filled:
 *   `missing` in all, `tables` by table.
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

// A row counts once, whether its columns, its keys or both were missing.
async function fillRow(
  ctx: MutationCtx,
  table: BackfillTable,
  row: Doc<BackfillTable>,
): Promise<boolean> {
  const columns = await columnsOf(ctx, table, row);
  const keys = await fillKeys(ctx, table, row);
  if (holdsColumns(row, columns)) return keys > 0;
  await ctx.db.patch(row._id, columns);
  return true;
}

function fillKeys(
  ctx: MutationCtx,
  table: BackfillTable,
  row: Doc<BackfillTable>,
): Promise<number> {
  if (table !== "partsRequests" && table !== "purchaseOrders")
    return Promise.resolve(0);
  const record = recordOf(table, row as Doc<typeof table>);
  return syncPurchasingKeys(ctx, table, record);
}

async function columnsOf(
  ctx: MutationCtx,
  table: BackfillTable,
  row: Doc<BackfillTable>,
): Promise<object> {
  if (table === "flights") return flightColumns(row as Doc<"flights">);
  if (table === "taskEvidence" || table === "inventoryFiles")
    return storedFileColumns(ctx, table, row as Doc<FileTable>);
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

/**
 * Brings one page of the cost ledger in step with the records: for a page of
 * work orders, rewrites each one's rows for every program that paid; for a
 * page of ledger rows, deletes those whose work order no longer exists.
 * Writes no record and no change-log row.
 *
 * @param step - The table to page.
 * @param cursor - The page; null for the first.
 * @returns How many rows the page wrote or deleted, and the next cursor,
 *   null once the table is done.
 */
export const rebuildCostLedgerPage = internalMutation({
  args: {
    step: v.union(v.literal("workOrders"), v.literal("costLedger")),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { step, cursor }): Promise<FilledPage> => {
    if (step === "costLedger") return pruneLedger(ctx, cursor);
    const page = await ctx.db
      .query("workOrders")
      .paginate({ cursor, numItems: BACKFILL_PAGE });
    let written = 0;
    for (const order of page.page)
      written += await syncWorkOrderLedger(ctx, order.uuid);
    return {
      filled: written,
      cursor: page.isDone ? null : page.continueCursor,
    };
  },
});

/**
 * Rebuilds the cost ledger from the work orders' cost records and parts
 * requests, one page per transaction, then deletes rows of work orders that
 * no longer exist. Idempotent and safe beside live traffic, since every cost
 * write since the ledger keeps its rows; run it until it reports 0 missing.
 *
 * @returns The rows written or deleted: `missing` in all, `tables` by the
 *   table paged (`costLedger` counts the deleted rows).
 */
export const rebuildCostLedger = internalAction({
  args: {},
  handler: async (ctx) => {
    const tables: [LedgerStep, number][] = [];
    for (const step of ["workOrders", "costLedger"] as const)
      tables.push([step, await pageLedger(ctx, step)]);
    return {
      missing: tables.reduce((sum, [, written]) => sum + written, 0),
      tables: Object.fromEntries(tables),
    };
  },
});

/**
 * Compares one page of work orders' ledger rows with what their records
 * derive, without writing.
 *
 * @param cursor - The page; null for the first.
 * @returns The uuids of the work orders whose rows differ, and the next
 *   cursor, null once done.
 */
export const reconcileCostLedgerPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }): Promise<ReconciledPage> => {
    const page = await ctx.db
      .query("workOrders")
      .paginate({ cursor, numItems: BACKFILL_PAGE });
    const differing = [];
    for (const order of page.page)
      if (await ledgerDiffers(ctx, order.uuid)) differing.push(order.uuid);
    return { differing, cursor: page.isDone ? null : page.continueCursor };
  },
});

/**
 * Checks every work order's ledger rows against its records, the nightly
 * reconcile (ADR-0013). A difference is logged with the work orders' uuids
 * (the first 20) and their count, for an operator to run
 * migrations:rebuildCostLedger; nothing is changed.
 *
 * @returns How many work orders' rows differ, and the uuids it logged.
 */
export const reconcileCostLedger = internalAction({
  args: {},
  handler: async (ctx) => {
    const differing: string[] = [];
    let cursor: string | null = null;
    do {
      const page: ReconciledPage = await ctx.runQuery(RECONCILE_PAGE, {
        cursor,
      });
      differing.push(...page.differing);
      cursor = page.cursor;
    } while (cursor !== null);
    const logged = differing.slice(0, LOGGED_DIFFERENCES);
    if (differing.length)
      console.error("The cost ledger differs from its records.", {
        workOrders: differing.length,
        first: logged,
      });
    return { differing: differing.length, logged };
  },
});

async function pageLedger(ctx: ActionCtx, step: LedgerStep) {
  let written = 0;
  let cursor: string | null = null;
  do {
    const page: FilledPage = await ctx.runMutation(LEDGER_PAGE, {
      step,
      cursor,
    });
    written += page.filled;
    cursor = page.cursor;
  } while (cursor !== null);
  return written;
}

async function pruneLedger(ctx: MutationCtx, cursor: string | null) {
  const page = await ctx.db
    .query("costLedger")
    .paginate({ cursor, numItems: BACKFILL_PAGE });
  let removed = 0;
  for (const row of page.page) {
    const order = await ctx.db
      .query("workOrders")
      .withIndex("uuid", (q) => q.eq("uuid", row.workOrderUuid))
      .first();
    if (order) continue;
    await ctx.db.delete(row._id);
    removed++;
  }
  return { filled: removed, cursor: page.isDone ? null : page.continueCursor };
}

// Rows compare by program, date, aircraft and amounts, in any stored order.
async function ledgerDiffers(ctx: QueryCtx, workOrderUuid: string) {
  const canonical = (rows: StoredLedgerRow[]) =>
    rows
      .map((r) =>
        [
          r.programUuid,
          r.date,
          r.aircraftUuid,
          r.laborSeconds,
          r.laborCents,
          r.partsCents,
          r.otherCents,
        ].join(" "),
      )
      .sort()
      .join("\n");
  const [expected, stored] = await Promise.all([
    expectedLedger(ctx, workOrderUuid),
    storedLedger(ctx, workOrderUuid),
  ]);
  return canonical(expected) !== canonical(stored);
}
