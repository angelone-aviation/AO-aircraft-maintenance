/**
 * Responsibility: Shapes maintenance data for the charts on the Inspections
 *   and Planning screens: how many schedules hold each status, and how many
 *   forecast items fall due in each coming month.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ./dueCalendar (month arithmetic), ./forecast (item type),
 *   ./maintenance (status names).
 */
import { monthOf, shiftMonth } from "./dueCalendar";
import type { ForecastItem } from "./forecast";
import { inspectionStatus, inspectionStatusLabels } from "./maintenance";

/** The status of one inspection schedule. */
export type InspectionStatusName = ReturnType<
  typeof inspectionStatus
>["status"];

/** One status and how many schedules hold it, coloured as that status. */
export interface StatusSlice {
  label: string;
  value: number;
  tone: "danger" | "warn" | "good" | "5";
}

/** One month of the workload chart: its items by kind. */
export interface WorkloadMonth {
  /** YYYY-MM. */
  month: string;
  /** Such as "Nov 2026". */
  label: string;
  values: Record<ForecastItem["kind"], number>;
}

/** How far ahead the Planning workload chart looks. */
export const WORKLOAD_MONTHS = 12;

// Most urgent first. "Unknown" is not a status colour, so it takes a grey.
const STATUS_ORDER = [
  ["overdue", "danger"],
  ["due-soon", "warn"],
  ["scheduled", "good"],
  ["unknown", "5"],
] as const;

/**
 * Counts schedules by status for a share-of-the-whole chart.
 *
 * @param statuses - One entry per schedule.
 * @returns Overdue, due soon and scheduled in that order, each kept even at
 *   zero so the legend always names them; "Unknown" is added last only when
 *   a schedule has it.
 */
export function inspectionStatusSlices(
  statuses: readonly InspectionStatusName[],
): StatusSlice[] {
  return STATUS_ORDER.map(([status, tone]) => ({
    label: inspectionStatusLabels[status],
    value: statuses.filter((s) => s === status).length,
    tone,
  })).filter((slice) => slice.tone !== "5" || slice.value > 0);
}

/**
 * Counts the forecast items projected to fall due in each coming month.
 * Overdue items are projected on today (forecast.projectDue), so they count
 * in the first month.
 *
 * @param items - Forecast items; those with no projection are left out.
 * @param today - The day the months count from, as an ISO date.
 * @param months - How many months to return, starting with today's.
 * @returns One entry per month in order, every kind present even at zero.
 *   Items projected after the last month are left out.
 */
export function monthlyWorkload(
  items: readonly ForecastItem[],
  today: string,
  months = WORKLOAD_MONTHS,
): WorkloadMonth[] {
  const first = monthOf(today);
  return Array.from({ length: months }, (_, offset) => {
    const month = shiftMonth(first, offset);
    const due = items.filter(
      (i) => i.projection && monthOf(i.projection.date) === month,
    );
    const count = (kind: ForecastItem["kind"]) =>
      due.filter((i) => i.kind === kind).length;
    return {
      month,
      label: monthLabel(month),
      values: {
        inspection: count("inspection"),
        component: count("component"),
        ad: count("ad"),
      },
    };
  });
}

function monthLabel(month: string) {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
