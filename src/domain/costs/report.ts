/**
 * Responsibility: An aircraft's cost report over a period (work-order costs,
 *   flight hours, cost per flight hour), its budget status and CSV rows.
 * Layer: Domain. Pure functions over a snapshot; no I/O, no React.
 * Dependencies: ../model, ../flights, ./period, ./units, ./workOrderCosts.
 */
import { localDate, type Aircraft, type Flight, type Snapshot } from "../model";
import { meterAtFlight } from "../flights";
import { inPeriod, type Period } from "./period";
import { CENTS_PER_DOLLAR, SECONDS_PER_HOUR } from "./units";
import {
  aircraftSpendCents,
  findBudget,
  workOrderCosts,
} from "./workOrderCosts";

/** Meter seconds an accepted flight added, on the meter in use at the time. */
export function flightSeconds(a: Aircraft, f: Flight) {
  if (f.status !== "accepted") return 0;
  const [start, end] = meterReadings(f, meterAtFlight(a, f.startTime));
  return start === undefined || end === undefined
    ? 0
    : Math.max(0, end - start);
}

/**
 * The meter seconds an aircraft's accepted flights added in a period, each
 * matched by the local date it started (the date the Flight log shows).
 *
 * @param a - The aircraft, for the meter each flight used.
 * @param flights - Flights of any aircraft; others are left out.
 */
export function periodFlightSeconds(
  a: Aircraft,
  flights: readonly Flight[],
  period: Period,
): number {
  return flights
    .filter(
      (f) =>
        f.aircraftUuid === a.uuid &&
        inPeriod(localDate(Date.parse(f.startTime)), period),
    )
    .reduce((n, f) => n + flightSeconds(a, f), 0);
}

/**
 * An aircraft's maintenance costs and flying over a period.
 *
 * @returns The work orders with costs in the period, oldest opened first; the
 *   totals; the flight seconds of accepted flights started in the period; and
 *   the cost per flight hour, undefined when nothing was flown.
 */
export function aircraftCostReport(
  s: Snapshot,
  aircraftUuid: string,
  period: Period,
) {
  const orders = (s.workOrders ?? [])
    .filter((w) => w.aircraftUuid === aircraftUuid)
    .map((order) => ({ order, costs: workOrderCosts(s, order, period) }))
    .filter(
      ({ costs }) =>
        costs.labor.length || costs.other.length || costs.parts.length,
    )
    .sort((x, y) => x.order.dateOpened.localeCompare(y.order.dateOpened));
  const total = (k: TotalKey) => orders.reduce((n, o) => n + o.costs[k], 0);
  const seconds = flownSeconds(s, aircraftUuid, period);
  const totalCents = total("totalCents");
  return {
    period,
    orders,
    laborSeconds: total("laborSeconds"),
    laborCents: total("laborCents"),
    partsCents: total("partsCents"),
    otherCents: total("otherCents"),
    missingPartCosts: total("missingPartCosts"),
    totalCents,
    flightSeconds: seconds,
    // Undefined when no hours were flown: shown as "—", never divided by zero.
    costPerHourCents: seconds
      ? Math.round((totalCents / seconds) * SECONDS_PER_HOUR)
      : undefined,
  };
}
/** An aircraft cost report, as {@link aircraftCostReport} returns it. */
export type AircraftCostReport = ReturnType<typeof aircraftCostReport>;

/**
 * An aircraft's spending against its budget for a calendar year.
 *
 * @returns The budget (undefined if none), actual spend, what remains, the
 *   whole percent spent (undefined for no or a zero budget), and whether
 *   spend is over budget.
 */
export function budgetStatus(s: Snapshot, aircraftUuid: string, year: number) {
  const budgetCents = findBudget(s, aircraftUuid, year)?.amountCents;
  const actualCents = aircraftSpendCents(s, aircraftUuid, {
    from: `${year}-01-01`,
    to: `${year}-12-31`,
  });
  return budgetStatusOf(budgetCents, actualCents);
}

/**
 * A spend measured against a budget, as {@link budgetStatus} reports it.
 *
 * @param budgetCents - The year's budget; undefined when none is set.
 * @param actualCents - What was spent in the year, such as the cost
 *   ledger's total.
 */
export function budgetStatusOf(
  budgetCents: number | undefined,
  actualCents: number,
) {
  return {
    budgetCents,
    actualCents,
    remainingCents:
      budgetCents === undefined ? undefined : budgetCents - actualCents,
    percent: budgetCents
      ? Math.round((actualCents / budgetCents) * 100)
      : undefined,
    over: budgetCents !== undefined && actualCents > budgetCents,
  };
}

/**
 * The rows of a cost report's CSV export: one per work order, then a total
 * row with the period, flight hours and cost per flight hour ("—" when
 * nothing was flown). Money is in dollars and time in hours.
 */
export function costReportCsvRows(report: AircraftCostReport) {
  const money = (c: number) => c / CENTS_PER_DOLLAR;
  const hours = (seconds: number) => seconds / SECONDS_PER_HOUR;
  return [
    ...report.orders.map(({ order, costs }) => ({
      "Work order": order.number,
      Status: order.status,
      Opened: order.dateOpened,
      "Labor hours": hours(costs.laborSeconds),
      Labor: money(costs.laborCents),
      Parts: money(costs.partsCents),
      Other: money(costs.otherCents),
      Total: money(costs.totalCents),
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

type TotalKey =
  | "laborSeconds"
  | "laborCents"
  | "partsCents"
  | "otherCents"
  | "totalCents"
  | "missingPartCosts";

function flownSeconds(s: Snapshot, aircraftUuid: string, period: Period) {
  const a = s.aircraft.find((a) => a.uuid === aircraftUuid);
  return a ? periodFlightSeconds(a, s.flights, period) : 0;
}

// The "Off" reading is taken at the start of the flight, "On" at its end.
function meterReadings(f: Flight, meter: ReturnType<typeof meterAtFlight>) {
  if (meter === "tach") return [f.tachOff, f.tachOn];
  if (meter === "flightTimeLog") return [f.flightTimeLogOff, f.flightTimeLogOn];
  if (meter === "cyclic") return [f.cyclicHobbsOff, f.cyclicHobbsOn];
  return [f.hobbsOff, f.hobbsOn];
}
