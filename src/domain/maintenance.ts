/**
 * Responsibility: When an aircraft inspection falls due: its calendar due
 *   date, what remains on each limit, its status, the limit that drives it,
 *   and which inspection is most urgent.
 * Layer: Domain. Pure functions; no I/O, no React (a `today` left to its
 *   default reads the clock).
 * Dependencies: src/domain/components.ts, model.ts, rejection.ts.
 */
import { componentAircraftSeconds } from "./components";
import { localDate, type Aircraft, type Inspection } from "./model";
import { Rejection } from "./rejection";

const HOUR_SECONDS = 3600;
const DAY_MS = 86_400_000;

/**
 * How near each tracked limit an inspection becomes due soon: 10 hours,
 * cycles or landings, or 30 days.
 */
export const INSPECTION_DUE_SOON_WITHIN = {
  hours: 10,
  days: 30,
  cycles: 10,
  landings: 10,
} as const;

const STATUS_URGENCY: Record<InspectionState, number> = {
  overdue: 0,
  "due-soon": 1,
  scheduled: 2,
  unknown: 3,
};

/**
 * The calendar due date of a recurring inspection. Calendar months run to the
 * end of the due month, as in 14 CFR 91.409's "preceding 12 calendar months".
 *
 * @param lastDate - The last compliance date, YYYY-MM-DD.
 * @param intervalMonths - The interval in whole months, at least 1.
 * @returns The last day of the month `intervalMonths` after `lastDate`'s, such
 *   as "2027-01-31" for "2026-01-15" and 12.
 * @throws {Rejection} "A valid date and positive month interval are
 *   required." for a malformed date or interval; "Invalid calendar date." for
 *   a date that does not exist, such as "2026-02-30".
 */
export function endOfDueMonth(
  lastDate: string,
  intervalMonths: number,
): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(lastDate) ||
    !Number.isInteger(intervalMonths) ||
    intervalMonths < 1
  )
    throw new Rejection(
      "A valid date and positive month interval are required.",
    );
  const date = new Date(lastDate + "T00:00:00Z");
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== lastDate
  )
    throw new Rejection("Invalid calendar date.");
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + intervalMonths + 1, 0),
  )
    .toISOString()
    .slice(0, 10);
}

/**
 * An inspection's calendar due date. A recurring deadline is derived from the
 * last compliance, because a saved due date may be stale.
 *
 * @param inspection - The inspection.
 * @returns Undefined when calendar exempt; else {@link endOfDueMonth} of the
 *   last date and interval when both are set; else the saved due date.
 * @throws As {@link endOfDueMonth}.
 */
export function inspectionDueDate(inspection: Inspection): string | undefined {
  if (inspection.calendarExempt) return undefined;
  return inspection.lastDate && inspection.intervalMonths
    ? endOfDueMonth(inspection.lastDate, inspection.intervalMonths)
    : inspection.dueDate;
}

/**
 * What remains on each of an inspection's limits and the status they give.
 *
 * @param inspection - The inspection.
 * @param aircraft - Its aircraft, for cycles, landings and default hours.
 * @param today - A local date; today by default.
 * @param counters - Seconds and cycles to measure against; by default the
 *   aircraft's, with seconds from the meter the inspection tracks.
 * @returns Hours, cycles, landings and days remaining (undefined where the
 *   inspection sets no limit), and a status: "overdue" when any limit is
 *   overdue, else "due-soon" when any is due soon, else "scheduled"; with no
 *   limit at all, "scheduled" if calendar exempt, else "unknown".
 * @throws As {@link inspectionDueDate}, and "Collective component tracking …"
 *   for a collective-meter inspection on an aircraft without that reading.
 */
export function inspectionStatus(
  inspection: Inspection,
  aircraft: Aircraft,
  today = localDate(),
  counters = {
    seconds: componentAircraftSeconds(inspection, aircraft),
    cycles: aircraft.cycles,
  },
) {
  const hoursRemaining =
    inspection.dueSeconds === undefined
      ? undefined
      : (inspection.dueSeconds - counters.seconds) / HOUR_SECONDS;
  const cyclesRemaining =
    inspection.dueCycles === undefined
      ? undefined
      : inspection.dueCycles - counters.cycles;
  const landingsRemaining =
    inspection.dueLandings === undefined
      ? undefined
      : inspection.dueLandings - aircraft.landings;
  const dueDate = inspectionDueDate(inspection);
  const daysRemaining = dueDate ? daysBetween(today, dueDate) : undefined;
  const remaining = {
    hoursRemaining,
    cyclesRemaining,
    landingsRemaining,
    daysRemaining,
  };
  const known = inspectionLimits(remaining);
  return {
    ...remaining,
    status: classifyStatus(known, inspection.calendarExempt),
  } as const;
}

/** The name of each inspection status on screen. */
export const inspectionStatusLabels: Record<
  ReturnType<typeof inspectionStatus>["status"],
  string
> = {
  overdue: "Overdue",
  "due-soon": "Due soon",
  scheduled: "Scheduled",
  unknown: "Unknown",
};

/** A limit an inspection can be due by: hours, days, cycles or landings. */
export type InspectionDimension = keyof typeof INSPECTION_DUE_SOON_WITHIN;

type InspectionState = ReturnType<typeof inspectionStatus>["status"];
type Remaining = {
  [D in InspectionDimension as `${D}Remaining`]?: number;
};
type Urgency = { status: InspectionState; limit?: InspectionLimit };

/** One limit of an inspection, as {@link inspectionDueLimit} weighs it. */
export type InspectionLimit = ReturnType<typeof inspectionLimits>[number];

/**
 * The limit that drives an inspection's status: the most overdue one, or else
 * the one closest to its limit relative to its due-soon allowance. Its
 * `urgency` also orders inspections that share a status.
 *
 * @param remaining - What remains on each limit, as {@link inspectionStatus}
 *   returns it.
 * @returns The limit with the lowest urgency, the first in hours, days,
 *   cycles, landings order on a tie; undefined when no limit is set.
 */
export function inspectionDueLimit(
  remaining: Remaining,
): InspectionLimit | undefined {
  const known = inspectionLimits(remaining);
  const overdue = known.filter((l) => l.overdue);
  return (overdue.length ? overdue : known).reduce<InspectionLimit | undefined>(
    (most, l) => (!most || l.urgency < most.urgency ? l : most),
    undefined,
  );
}

/**
 * Orders inspections most urgent first: overdue, due soon, scheduled, then
 * unknown; within a status, by the urgency of the limit that drives it
 * ({@link inspectionDueLimit}), with no driving limit last.
 *
 * @param x - An inspection's status and driving limit.
 * @param y - Another inspection's.
 * @returns Negative when `x` is more urgent, for `Array.prototype.sort`.
 */
export function compareInspectionUrgency(x: Urgency, y: Urgency): number {
  return (
    STATUS_URGENCY[x.status] - STATUS_URGENCY[y.status] ||
    limitUrgency(x) - limitUrgency(y)
  );
}

const limitUrgency = (x: Urgency) => x.limit?.urgency ?? Number.MAX_VALUE;

function inspectionLimits(remaining: Remaining) {
  return (
    Object.keys(INSPECTION_DUE_SOON_WITHIN) as InspectionDimension[]
  ).flatMap((dimension) => {
    const value = remaining[`${dimension}Remaining`];
    if (value === undefined) return [];
    return [
      {
        dimension,
        remaining: value,
        // A calendar limit is still met on its due day; a counter at its
        // limit is not.
        overdue: dimension === "days" ? value < 0 : value <= 0,
        dueSoon: value <= INSPECTION_DUE_SOON_WITHIN[dimension],
        /** Remaining share of the due-soon allowance; lower is more urgent. */
        urgency: value / INSPECTION_DUE_SOON_WITHIN[dimension],
      },
    ];
  });
}

function daysBetween(from: string, to: string) {
  const ms = Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z");
  return Math.round(ms / DAY_MS);
}

// A calendar-exempt inspection with no hour or cycle limit has no active
// deadline (docs/inspection-templates.md), so it is not "unknown".
function classifyStatus(
  known: InspectionLimit[],
  calendarExempt: boolean | undefined,
): "overdue" | "due-soon" | "scheduled" | "unknown" {
  if (!known.length) return calendarExempt ? "scheduled" : "unknown";
  if (known.some((l) => l.overdue)) return "overdue";
  return known.some((l) => l.dueSoon) ? "due-soon" : "scheduled";
}
