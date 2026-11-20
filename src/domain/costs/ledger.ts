/**
 * Responsibility: A work order's cost by day at the prices its records fix
 *   (the cost ledger's rows, ADR-0013), and the totals and cost report an
 *   aircraft's rows give over a period.
 * Layer: Domain. Pure functions over a snapshot; no I/O, no React.
 * Dependencies: ../model, ../workOrders (types), ./workOrderCosts, ./period.
 *
 * A part priced only by its stock item's current cost (an issue made before
 * D13 with no manual unit cost) counts nothing: that cost changes without a
 * cost write, so no stored total could follow it. The board, which cannot
 * read stock costs, has always totalled parts this way.
 */
import type { Snapshot } from "../model";
import type { WorkOrder } from "../workOrders";
import {
  findWorkOrderCost,
  partIssues,
  workOrderCosts,
} from "./workOrderCosts";
import { inPeriod, type Period } from "./period";

/** What one work order cost on one date. */
export interface LedgerDay {
  date: string;
  laborSeconds: number;
  laborCents: number;
  partsCents: number;
  otherCents: number;
}

/** A ledger row: one work order's cost on one date. */
export interface LedgerRow extends LedgerDay {
  workOrderUuid: string;
}

/** Labor time and money summed over ledger rows. */
export interface LedgerTotals {
  laborSeconds: number;
  laborCents: number;
  partsCents: number;
  otherCents: number;
  totalCents: number;
}

/** The work order a cost report row names, as far as the report shows it. */
export type ReportedOrder = Pick<
  WorkOrder,
  "uuid" | "number" | "status" | "dateOpened"
>;

/**
 * What a work order cost on each date it has a labor entry, other cost or
 * issued part, at the prices its records fix: a manual unit cost, else the
 * one recorded at issue. Summed over any period, the days give
 * `workOrderCosts` for it with stock costs left out.
 *
 * @param s - The paying program's cost record for the order, the parts
 *   requests that count toward it and its live and archived job cards.
 * @returns One day per date, oldest first, including days whose only issue
 *   is unpriced.
 */
export function workOrderLedger(s: Snapshot, w: WorkOrder): LedgerDay[] {
  const fixed: Snapshot = { ...s, management: [] };
  const record = findWorkOrderCost(fixed, w.uuid);
  const dates = new Set([
    ...(record?.labor ?? []).map((e) => e.date),
    ...(record?.other ?? []).map((e) => e.date),
    ...partIssues(fixed, w).map((i) => i.date),
  ]);
  return [...dates].sort().map((date) => {
    const day = workOrderCosts(fixed, w, { from: date, to: date });
    return {
      date,
      laborSeconds: day.laborSeconds,
      laborCents: day.laborCents,
      partsCents: day.partsCents,
      otherCents: day.otherCents,
    };
  });
}

/**
 * Sums ledger rows dated within a period.
 *
 * @param period - Inclusive dates; every row counts without one.
 */
export function ledgerTotals(
  rows: readonly LedgerDay[],
  period?: Period,
): LedgerTotals {
  const totals = {
    laborSeconds: 0,
    laborCents: 0,
    partsCents: 0,
    otherCents: 0,
    totalCents: 0,
  };
  for (const r of rows) {
    if (!inPeriod(r.date, period)) continue;
    totals.laborSeconds += r.laborSeconds;
    totals.laborCents += r.laborCents;
    totals.partsCents += r.partsCents;
    totals.otherCents += r.otherCents;
    totals.totalCents += r.laborCents + r.partsCents + r.otherCents;
  }
  return totals;
}

/**
 * An aircraft's work-order costs over a period from its ledger rows: each
 * work order with a row in the period, and the totals.
 *
 * @param rows - The aircraft's rows of the paying program.
 * @param orders - The work orders the rows name; one missing shows blank.
 * @returns Orders oldest opened first, then by uuid, each with its totals.
 */
export function ledgerCostReport(
  rows: readonly LedgerRow[],
  orders: readonly ReportedOrder[],
  period: Period,
) {
  const dated = rows.filter((r) => inPeriod(r.date, period));
  const uuids = [...new Set(dated.map((r) => r.workOrderUuid))];
  const named = new Map(orders.map((w) => [w.uuid, w]));
  const lines = uuids.map((uuid) => ({
    workOrderUuid: uuid,
    number: named.get(uuid)?.number ?? "",
    status: named.get(uuid)?.status ?? "",
    dateOpened: named.get(uuid)?.dateOpened ?? "",
    ...ledgerTotals(dated.filter((r) => r.workOrderUuid === uuid)),
  }));
  lines.sort(
    (x, y) =>
      x.dateOpened.localeCompare(y.dateOpened) ||
      x.workOrderUuid.localeCompare(y.workOrderUuid),
  );
  return { period, orders: lines, ...ledgerTotals(dated) };
}
