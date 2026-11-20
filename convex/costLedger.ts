/**
 * Responsibility: Keeps the costLedger table (each work order's cost by day,
 *   for each program that paid) in step with the records it derives from,
 *   and reads an aircraft's rows over a period.
 * Layer: Server. Convex reads and writes of one derived table; the totals
 *   come from src/domain/costs/ledger.
 * Dependencies: ./_generated (types), ./collections, src/domain (costs/ledger,
 *   costs/period, costs/records, model, workOrders, taskCards, partsRequests:
 *   types).
 *
 * Derived rows, not records (ADR-0013): migrations:rebuildCostLedger
 * rebuilds them and they never reach the change log. Each carries the
 * program that paid (decision D14), so an aircraft's transfer leaves them
 * with it.
 */
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { decode } from "./collections";
import { workOrderLedger, type LedgerRow } from "../src/domain/costs/ledger";
import type { Period } from "../src/domain/costs/period";
import type { Member, Snapshot } from "../src/domain/model";
import type { WorkOrder } from "../src/domain/workOrders";
import type { TaskCard } from "../src/domain/taskCards";
import type { PartsRequest } from "../src/domain/partsRequests";
import type { CostRecord } from "../src/domain/costs/records";

type Ctx = QueryCtx | MutationCtx;
/** A ledger row as stored, without its system fields. */
export type StoredLedgerRow = Omit<Doc<"costLedger">, "_id" | "_creationTime">;
/** Every record the cost rules read for one work order, of any program. */
export interface CostedRecords {
  costs: CostRecord[];
  taskCards: TaskCard[];
  archivedTaskCards: TaskCard[];
  partsRequests: PartsRequest[];
}

// The cost rules read no person; the snapshot they take needs one.
const NO_ONE: Member = {
  id: "",
  name: "",
  email: "",
  active: false,
  isAdmin: false,
  groupIds: [],
};

/**
 * Rewrites one work order's ledger rows from its records, for every program
 * that paid for it: writes a missing or changed day, deletes a day no longer
 * costed. Writes no record and no change-log row.
 *
 * @returns How many rows it inserted, patched or deleted.
 */
export async function syncWorkOrderLedger(
  ctx: MutationCtx,
  workOrderUuid: string,
): Promise<number> {
  const expected = await expectedLedger(ctx, workOrderUuid);
  const stored = await storedLedger(ctx, workOrderUuid);
  const keep = new Map(expected.map((r) => [rowKey(r), r]));
  let written = 0;
  for (const row of stored) {
    const next = keep.get(rowKey(row));
    keep.delete(rowKey(row));
    if (next && holdsRow(row, next)) continue;
    if (next) await ctx.db.patch(row._id, next);
    else await ctx.db.delete(row._id);
    written++;
  }
  for (const row of keep.values()) await ctx.db.insert("costLedger", row);
  return written + keep.size;
}

/**
 * The rows a work order's records derive, as `syncWorkOrderLedger` would
 * store them, without writing.
 *
 * @returns By program, then date; none for a work order that does not exist.
 */
export async function expectedLedger(
  ctx: Ctx,
  workOrderUuid: string,
): Promise<StoredLedgerRow[]> {
  const orderRow = await ctx.db
    .query("workOrders")
    .withIndex("uuid", (q) => q.eq("uuid", workOrderUuid))
    .first();
  if (!orderRow) return [];
  const [order] = decode("workOrders", [orderRow]);
  return derivedLedger(order, await costedRecords(ctx, workOrderUuid));
}

/**
 * The ledger rows a work order's records derive, for each program whose
 * cost record or parts requests price it.
 *
 * @param records - Every record the cost rules read for the order, of any
 *   program.
 * @returns By program, then date.
 */
export function derivedLedger(
  order: WorkOrder,
  records: CostedRecords,
): StoredLedgerRow[] {
  return payingPrograms(records).flatMap((programUuid) =>
    workOrderLedger(programRecords(records, programUuid), order).map((d) => ({
      programUuid,
      aircraftUuid: order.aircraftUuid,
      workOrderUuid: order.uuid,
      ...d,
    })),
  );
}

/**
 * The ledger rows stored for one work order, for every program.
 *
 * @returns In index order.
 */
export function storedLedger(ctx: Ctx, workOrderUuid: string) {
  return ctx.db
    .query("costLedger")
    .withIndex("workOrder", (q) => q.eq("workOrderUuid", workOrderUuid))
    .collect();
}

/**
 * One aircraft's ledger rows of one paying program, dated within a period:
 * one index range, however long the history.
 *
 * @returns By date.
 */
export async function ledgerRowsOf(
  ctx: Ctx,
  programUuid: string,
  aircraftUuid: string,
  period: Period,
): Promise<LedgerRow[]> {
  const rows = await ctx.db
    .query("costLedger")
    .withIndex("program", (q) =>
      q
        .eq("programUuid", programUuid)
        .eq("aircraftUuid", aircraftUuid)
        .gte("date", period.from)
        .lte("date", period.to),
    )
    .collect();
  return rows.map(
    ({
      workOrderUuid,
      date,
      laborSeconds,
      laborCents,
      partsCents,
      otherCents,
    }) => ({
      workOrderUuid,
      date,
      laborSeconds,
      laborCents,
      partsCents,
      otherCents,
    }),
  );
}

// Every record the cost rules read for one work order, of any program: its
// cost records, its live and archived job cards, and the parts requests
// raised on it or on those cards.
async function costedRecords(
  ctx: Ctx,
  workOrderUuid: string,
): Promise<CostedRecords> {
  const [costs, cards, archived] = await Promise.all([
    ctx.db
      .query("costs")
      .withIndex("workOrder", (q) => q.eq("workOrderUuid", workOrderUuid))
      .collect(),
    ctx.db
      .query("taskCards")
      .withIndex("workOrder", (q) => q.eq("workOrderUuid", workOrderUuid))
      .collect(),
    ctx.db
      .query("archivedTaskCards")
      .withIndex("workOrder", (q) => q.eq("workOrderUuid", workOrderUuid))
      .collect(),
  ]);
  const requests = await Promise.all([
    ctx.db
      .query("partsRequests")
      .withIndex("sourceWorkOrder", (q) =>
        q.eq("sourceWorkOrderUuid", workOrderUuid),
      )
      .collect(),
    ...[...cards, ...archived].map((card) =>
      ctx.db
        .query("partsRequests")
        .withIndex("source", (q) => q.eq("sourceUuid", card.uuid))
        .collect(),
    ),
  ]);
  return {
    costs: decode("costs", costs),
    taskCards: decode("taskCards", cards),
    archivedTaskCards: decode("archivedTaskCards", archived),
    partsRequests: decode("partsRequests", unique(requests.flat())),
  };
}

// The programs whose cost record or parts requests price the order.
function payingPrograms({ costs, partsRequests }: CostedRecords) {
  return [
    ...new Set([
      ...costs.flatMap((r) => (r.kind === "workOrder" ? [r.programUuid] : [])),
      ...partsRequests.map((r) => r.programUuid),
    ]),
  ].sort();
}

// One program's records as the cost rules read them: its own cost record and
// requests, and every card of the order, which only say where requests count.
function programRecords(records: CostedRecords, programUuid: string): Snapshot {
  return {
    user: NO_ONE,
    authenticatedAt: 0,
    syncedAt: 0,
    groups: [],
    members: [],
    aircraft: [],
    flights: [],
    discrepancies: [],
    inspections: [],
    audit: [],
    taskCards: records.taskCards,
    archivedTaskCards: records.archivedTaskCards,
    costs: records.costs.filter((r) => r.programUuid === programUuid),
    partsRequests: records.partsRequests.filter(
      (r) => r.programUuid === programUuid,
    ),
  };
}

function unique<D extends { _id: string }>(rows: readonly D[]): D[] {
  return [...new Map(rows.map((r) => [r._id, r])).values()];
}

function rowKey(r: { programUuid: string; date: string }) {
  return `${r.programUuid} ${r.date}`;
}

function holdsRow(row: Doc<"costLedger">, next: StoredLedgerRow) {
  return (
    row.aircraftUuid === next.aircraftUuid &&
    row.laborSeconds === next.laborSeconds &&
    row.laborCents === next.laborCents &&
    row.partsCents === next.partsCents &&
    row.otherCents === next.otherCents
  );
}
