/**
 * Responsibility: The cost report an aircraft's ledger rows give, as the
 *   Costs screen shows and exports it: who may read it, its budgets, flight
 *   hours, cost per flight hour and CSV rows, and the same report built from
 *   a snapshot for the demo.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ../model, ../programs, ../auditHistory (the not-found
 *   message), ../rejection, ./ledger, ./period, ./records, ./units.
 *
 * The server sums its costLedger rows (history.costReport); the demo derives
 * the same rows from its records, so both screens read one report shape.
 */
import { can, type Snapshot } from "../model";
import { programPermission } from "../programs";
import { HISTORY_NOT_FOUND } from "../auditHistory";
import { Rejection } from "../rejection";
import { ledgerCostReport, workOrderLedger } from "./ledger";
import { periodFor, type Period } from "./period";
import type { CostRecord } from "./records";
import { CENTS_PER_DOLLAR, SECONDS_PER_HOUR } from "./units";

/** The refusal of a cost report to anyone but a program administrator. */
export const COST_REPORT_ADMINS_ONLY = "Flight Program administrator required.";

/** One aircraft's cost report over inclusive ISO dates. */
export interface CostReportRequest {
  aircraftUuid: string;
  from: string;
  to: string;
}

/** An aircraft's ledger cost report with its budgets for the period's years. */
export type CostReport = ReturnType<typeof ledgerCostReport> & {
  budgets: { year: number; amountCents: number }[];
};

/** A {@link CostReport} with the flying it is measured against. */
export interface CostReportView extends CostReport {
  /** Accepted flights' meter seconds, started in the period. */
  flightSeconds: number;
  /** Undefined when nothing was flown: shown as "—", never divided by 0. */
  costPerHourCents?: number;
}

/**
 * Checks that the caller may read an aircraft's cost report.
 *
 * @param s - The caller's (scoped) state.
 * @param aircraftUuid - The aircraft.
 * @throws {Rejection} {@link COST_REPORT_ADMINS_ONLY}; "History not found."
 *   for an aircraft the caller cannot read, as for one that does not exist.
 */
export function assertCostReportReader(s: Snapshot, aircraftUuid: string) {
  if (!programPermission(s, "admin"))
    throw new Rejection(COST_REPORT_ADMINS_ONLY);
  if (!can(s, aircraftUuid, "read")) throw new Rejection(HISTORY_NOT_FOUND);
}

/**
 * An aircraft's budgets for the calendar years a period touches.
 *
 * @param costs - Cost records; only budgets of the aircraft count.
 * @returns Year and amount, by year.
 */
export function periodBudgets(
  costs: readonly CostRecord[],
  aircraftUuid: string,
  period: Period,
): CostReport["budgets"] {
  const first = Number(period.from.slice(0, 4));
  const last = Number(period.to.slice(0, 4));
  return costs
    .flatMap((r) =>
      r.kind === "budget" &&
      r.aircraftUuid === aircraftUuid &&
      r.year >= first &&
      r.year <= last
        ? [{ year: r.year, amountCents: r.amountCents }]
        : [],
    )
    .sort((x, y) => x.year - y.year);
}

/**
 * The cost report a snapshot's records give, as the server's ledger sums
 * them: each of the aircraft's work orders by day at the prices its records
 * fix.
 *
 * @param s - The caller's scoped snapshot, holding the work orders whole.
 * @param request - The aircraft and the dates.
 * @throws {Rejection} As {@link assertCostReportReader}; as `periodFor` for
 *   dates missing or reversed.
 */
export function snapshotCostReport(
  s: Snapshot,
  request: CostReportRequest,
): CostReport {
  const { aircraftUuid, from, to } = request;
  assertCostReportReader(s, aircraftUuid);
  const period = periodFor("custom", to, { from, to });
  const orders = (s.workOrders ?? []).filter(
    (w) => w.aircraftUuid === aircraftUuid,
  );
  const rows = orders.flatMap((w) =>
    workOrderLedger(s, w).map((day) => ({ ...day, workOrderUuid: w.uuid })),
  );
  return {
    ...ledgerCostReport(rows, orders, period),
    budgets: periodBudgets(s.costs ?? [], aircraftUuid, period),
  };
}

/**
 * The report with the period's flying and its cost per flight hour.
 *
 * @param report - From history.costReport or {@link snapshotCostReport}.
 * @param flightSeconds - Accepted flights' meter seconds in the period.
 */
export function costReportView(
  report: CostReport,
  flightSeconds: number,
): CostReportView {
  return {
    ...report,
    flightSeconds,
    costPerHourCents: flightSeconds
      ? Math.round((report.totalCents / flightSeconds) * SECONDS_PER_HOUR)
      : undefined,
  };
}

/**
 * The rows of the report's CSV export: one per work order, then a total row
 * with the period, flight hours and cost per flight hour ("—" when nothing
 * was flown). Money is in dollars and time in hours.
 *
 * @param report - The report as the screen shows it.
 */
export function ledgerReportCsvRows(report: CostReportView) {
  const money = (c: number) => c / CENTS_PER_DOLLAR;
  const hours = (seconds: number) => seconds / SECONDS_PER_HOUR;
  return [
    ...report.orders.map((o) => ({
      "Work order": o.number,
      Status: o.status,
      Opened: o.dateOpened,
      "Labor hours": hours(o.laborSeconds),
      Labor: money(o.laborCents),
      Parts: money(o.partsCents),
      Other: money(o.otherCents),
      Total: money(o.totalCents),
    })),
    {
      "Work order": "Total",
      Status: `${report.period.from} to ${report.period.to}`,
      Opened: "",
      "Labor hours": hours(report.laborSeconds),
      Labor: money(report.laborCents),
      Parts: money(report.partsCents),
      Other: money(report.otherCents),
      Total: money(report.totalCents),
      "Flight hours": hours(report.flightSeconds),
      "Cost per flight hour":
        report.costPerHourCents === undefined
          ? "—"
          : money(report.costPerHourCents),
    },
  ];
}
