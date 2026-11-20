/**
 * Responsibility: Shapes what the shop screens already show into chart data:
 *   work orders by status, an aircraft's costs by month, and stock lots by
 *   reorder state.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ./workOrders (statuses), ./costs/costReport (report type),
 *   ./management (needsReorder).
 */
import { workOrderStatuses, type WorkOrder } from "./workOrders";
import type { CostReport } from "./costs/costReport";
import { needsReorder, type Stock } from "./management";

/** A count of work orders in one status. */
export interface StatusCount {
  status: WorkOrder["status"];
  count: number;
}

/** What an aircraft's work orders cost in one calendar month, in cents. */
export interface MonthCosts {
  /** The month as YYYY-MM. */
  month: string;
  laborCents: number;
  partsCents: number;
  otherCents: number;
}

/** Stock lots split by whether they have reached their reorder point. */
export interface StockLevels {
  inStock: number;
  reorder: number;
}

// A longer period would squeeze the month bars past reading.
const MAX_CHART_MONTHS = 24;
const MONTH_LENGTH = "YYYY-MM".length;
const DECEMBER = 12;

/**
 * How many work orders are in each status.
 *
 * @returns One entry per status that has a work order, in the order of
 *   `workOrderStatuses`; empty when there are no work orders.
 */
export function workOrderStatusCounts(
  orders: readonly Pick<WorkOrder, "status">[],
): StatusCount[] {
  return workOrderStatuses
    .map((status) => ({
      status,
      count: orders.filter((w) => w.status === status).length,
    }))
    .filter((entry) => entry.count > 0);
}

/**
 * A cost report's spending by calendar month, for its month chart.
 *
 * @param report - The report's period and its months with costs.
 * @returns One entry per month the period touches, oldest first, a month
 *   without costs at zero, so the months add up to the report's totals.
 *   Empty when the period spans more than 24 months.
 */
export function ledgerMonths(
  report: Pick<CostReport, "period" | "months">,
): MonthCosts[] {
  const months = monthsBetween(report.period.from, report.period.to);
  if (months.length > MAX_CHART_MONTHS) return [];
  const costed = new Map(report.months.map((m) => [m.month, m]));
  return months.map(
    (month) =>
      costed.get(month) ?? {
        month,
        laborCents: 0,
        partsCents: 0,
        otherCents: 0,
      },
  );
}

/**
 * How many stock lots are above, and how many at or below, their minimum.
 *
 * @returns Counts that add up to the number of lots.
 */
export function stockLevels(
  stock: readonly Pick<Stock, "quantity" | "minimum">[],
): StockLevels {
  const reorder = stock.filter(needsReorder).length;
  return { inStock: stock.length - reorder, reorder };
}

function monthsBetween(from: string, to: string): string[] {
  const last = to.slice(0, MONTH_LENGTH);
  const months: string[] = [];
  let month = from.slice(0, MONTH_LENGTH);
  // One past the cap is enough for the caller to see the period is too long.
  while (month <= last && months.length <= MAX_CHART_MONTHS) {
    months.push(month);
    month = nextMonth(month);
  }
  return months;
}

function nextMonth(month: string): string {
  const [year, number] = month.split("-").map(Number);
  if (number === DECEMBER) return `${year + 1}-01`;
  return `${year}-${String(number + 1).padStart(2, "0")}`;
}
