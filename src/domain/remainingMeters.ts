/**
 * Responsibility: How much of an inspection's interval remains on each limit,
 *   as a share for the "hours left" meters.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ./maintenance (limits, due date), ./componentCalendar
 *   (service month), ./model (types).
 */
import { daysPerServiceMonth } from "./componentCalendar";
import type { DueLevel } from "./dueItems";
import {
  inspectionDueDate,
  inspectionLimits,
  type inspectionStatus,
  type InspectionDimension,
  type InspectionLimit,
} from "./maintenance";
import type { Inspection } from "./model";

const HOUR_SECONDS = 3600;
const DAY_MS = 86_400_000;

/** One limit of an inspection, measured for a remaining meter. */
export interface RemainingMeter {
  dimension: InspectionDimension;
  /** In hours, days, cycles or landings, as {@link inspectionStatus} gives. */
  remaining: number;
  /** From 0 to 1; undefined when the interval is not known. */
  share?: number;
  level: Exclude<DueLevel, "unknown">;
}

/**
 * The part of an interval still to run before its limit.
 *
 * @param remaining - What is left, in the interval's unit; 0 or less is none.
 * @param interval - The whole interval.
 * @returns From 0 to 1, capped at 1 when more than the interval is left;
 *   undefined when either value is missing or the interval is not positive.
 */
export function remainingShare(
  remaining: number | undefined,
  interval: number | undefined,
): number | undefined {
  if (remaining === undefined || interval === undefined || interval <= 0)
    return undefined;
  return Math.min(1, Math.max(0, remaining / interval));
}

/**
 * The length of an inspection's current interval on one limit, in the unit of
 * its remainder: hours, days, cycles or landings.
 *
 * @param inspection - The inspection.
 * @param dimension - The limit.
 * @returns The recorded interval, else the span from the last compliance to
 *   the due value; for days, from the last date to the due date, else the
 *   months at 30.4375 days. Undefined when neither is recorded, or calendar
 *   exempt.
 * @throws As {@link inspectionDueDate}, for days.
 */
export function inspectionInterval(
  inspection: Inspection,
  dimension: InspectionDimension,
): number | undefined {
  const i = inspection;
  switch (dimension) {
    case "hours": {
      const seconds = span(i.intervalSeconds, i.dueSeconds, i.lastSeconds);
      return seconds === undefined ? undefined : seconds / HOUR_SECONDS;
    }
    case "cycles":
      return span(i.intervalCycles, i.dueCycles, i.lastCycles);
    case "landings":
      return span(i.intervalLandings, i.dueLandings, i.lastLandings);
    case "days":
      return calendarInterval(i);
  }
}

/**
 * A meter for each limit the inspection sets, with the level the due-soon
 * and overdue thresholds of {@link inspectionStatus} give that limit.
 *
 * @param inspection - The inspection.
 * @param remaining - Its {@link inspectionStatus}.
 * @returns One meter per limit, in hours, days, cycles, landings order.
 * @throws As {@link inspectionInterval}.
 */
export function inspectionRemainingMeters(
  inspection: Inspection,
  remaining: ReturnType<typeof inspectionStatus>,
): RemainingMeter[] {
  return inspectionLimits(remaining).map((limit) =>
    limitMeter(inspection, limit),
  );
}

/**
 * The meter of one of an inspection's limits, such as the one
 * `inspectionDueLimit` names as driving its status.
 *
 * @param inspection - The inspection.
 * @param limit - One of its limits, as {@link inspectionLimits} lists them.
 * @returns The limit's remainder, share of the interval left and level.
 * @throws As {@link inspectionInterval}.
 */
export function limitMeter(
  inspection: Inspection,
  limit: InspectionLimit,
): RemainingMeter {
  const interval = inspectionInterval(inspection, limit.dimension);
  return {
    dimension: limit.dimension,
    remaining: limit.remaining,
    share: remainingShare(limit.remaining, interval),
    level: limitLevel(limit),
  };
}

function limitLevel(limit: InspectionLimit) {
  if (limit.overdue) return "overdue";
  return limit.dueSoon ? "due-soon" : "ok";
}

function span(interval?: number, due?: number, last?: number) {
  if (interval !== undefined) return interval;
  return due !== undefined && last !== undefined ? due - last : undefined;
}

function calendarInterval(i: Inspection) {
  const dueDate = inspectionDueDate(i);
  if (!dueDate) return undefined;
  if (i.lastDate)
    return (Date.parse(dueDate) - Date.parse(i.lastDate)) / DAY_MS;
  return i.intervalMonths === undefined
    ? undefined
    : i.intervalMonths * daysPerServiceMonth;
}
