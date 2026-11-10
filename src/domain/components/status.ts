/**
 * Responsibility: When a component requirement falls due, what is left on
 *   each of its limits, and its status.
 * Layer: Domain. Pure functions; no I/O, no React (a `today` left to its
 *   default reads the clock).
 * Dependencies: ../model, ../rejection, ./records (types), ./usage,
 *   ./calendar.
 */
import { localDate, type Aircraft } from "../model";
import { Rejection } from "../rejection";
import { calendarDue, daysBetween, shiftCalendarDate } from "./calendar";
import type { Component, ComponentRequirement } from "./records";
import {
  componentTotals,
  componentTotalsWithoutTime,
  usageOnBasis,
} from "./usage";

const SECONDS_PER_HOUR = 3600;
// GLOSSARY "Overdue": a usage limit at exactly 0 is "Due now".
const REACHED_STATUSES = ["Past due", "Due now"];

type Totals = Parameters<typeof usageOnBasis>[1] & {
  cyclesSinceNew: number | null;
};

/**
 * The due-soon warnings a new requirement starts with. A stored requirement
 * without a landing warning warns at this one.
 */
export const REQUIREMENT_WARNING_DEFAULTS = {
  warningSeconds: 25 * SECONDS_PER_HOUR,
  warningCycles: 10,
  warningLandings: 10,
  warningCalendarMonths: 1,
} as const;

interface LimitsLeft {
  seconds: number | undefined;
  cycles: number | undefined;
  landings: number | undefined;
  days: number | undefined;
}

/**
 * When a requirement falls due by calendar: its interval counted from the
 * last compliance, or else the stored due date (older records).
 *
 * @returns An ISO date, or undefined when it has no calendar limit.
 * @throws As {@link calendarDue}.
 */
export function requirementDueDate(
  r: ComponentRequirement,
): string | undefined {
  return r.lastDate && r.calendarIntervalValue
    ? calendarDue(r.lastDate, r.calendarIntervalValue, r.calendarIntervalUnit)
    : r.dueDate;
}

/**
 * What is left on each of a requirement's limits, and its status.
 *
 * @returns Seconds, cycles, landings and days left (undefined where not
 *   limited or not computable), and the first status that applies: "Past
 *   due", "Due now" (a usage limit at 0), "Set landing baseline", "Set time
 *   baseline", "Due soon" (within a warning; see
 *   {@link REQUIREMENT_WARNING_DEFAULTS} for landings), or "Tracked". When
 *   the component's time cannot be read, a cycle, landing or calendar limit
 *   that is reached still gives "Past due" or "Due now", seconds undefined.
 * @throws As {@link componentTotals}, unless such a limit is reached, and
 *   {@link calendarDue}.
 */
export function requirementStatus(
  r: ComponentRequirement,
  c: Component,
  a?: Aircraft,
  today = localDate(),
) {
  try {
    return measureLimits(r, c, a, today, componentTotals(c, a, today));
  } catch (error) {
    const reached =
      error instanceof Rejection && measureWithoutTime(r, c, a, today);
    if (!reached) throw error;
    return reached;
  }
}

// A reached limit decides before a counter that cannot be read: a part past
// its calendar or cycle limit must not read "unknown" because the aircraft's
// meter has no reading. Anything short of reached keeps the failure.
function measureWithoutTime(
  r: ComponentRequirement,
  c: Component,
  a: Aircraft | undefined,
  today: string,
) {
  const totals = componentTotalsWithoutTime(c, a, today);
  const left = measureLimits(r, c, a, today, totals);
  return REACHED_STATUSES.includes(left.status) ? left : undefined;
}

function measureLimits(
  r: ComponentRequirement,
  c: Component,
  a: Aircraft | undefined,
  today: string,
  t: Totals,
) {
  const basis = usageOnBasis(r.timeBasis, t);
  const landingBaselineMissing = isLandingBaselineMissing(r, c, a);
  const dueDate = requirementDueDate(r);
  const left: LimitsLeft = {
    seconds:
      r.dueSeconds === undefined || basis === null
        ? undefined
        : r.dueSeconds - basis,
    cycles:
      r.dueCycles === undefined || t.cyclesSinceNew === null
        ? undefined
        : r.dueCycles - t.cyclesSinceNew,
    landings:
      r.dueLandings === undefined || !a || landingBaselineMissing
        ? undefined
        : r.dueLandings - a.landings,
    days: dueDate ? daysBetween(today, dueDate) : undefined,
  };
  const calendarSoon =
    !!dueDate &&
    today >=
      shiftCalendarDate(dueDate, -r.warningCalendarMonths, "MONTHS", false);
  const missing = {
    landings: landingBaselineMissing,
    time: r.dueSeconds !== undefined && basis === null,
  };
  return { ...left, status: classifyLimits(r, left, missing, calendarSoon) };
}

// Landing counts belong to the aircraft they were counted on, so a landing
// limit needs the component installed on that aircraft.
function isLandingBaselineMissing(
  r: ComponentRequirement,
  c: Component,
  a: Aircraft | undefined,
): boolean {
  return (
    r.dueLandings !== undefined &&
    (!a ||
      !c.installed ||
      (r.landingReferenceAircraftUuid !== undefined &&
        r.landingReferenceAircraftUuid !== a.uuid))
  );
}

// A computable overdue limit outranks a missing baseline on another
// dimension. A usage limit with nothing left is reached, because the next
// flight would exceed it; a calendar limit stays valid through its due date,
// so on that day it is only due soon (calendarSoon).
function classifyLimits(
  r: ComponentRequirement,
  left: LimitsLeft,
  missing: { landings: boolean; time: boolean },
  calendarSoon: boolean,
): string {
  const usage = [left.seconds, left.cycles, left.landings];
  if ([...usage, left.days].some((n) => n !== undefined && n < 0))
    return "Past due";
  if (usage.some((n) => n === 0)) return "Due now";
  if (missing.landings) return "Set landing baseline";
  if (missing.time) return "Set time baseline";
  if (calendarSoon || isWithinWarning(r, left)) return "Due soon";
  return "Tracked";
}

function isWithinWarning(r: ComponentRequirement, left: LimitsLeft): boolean {
  return (
    (left.seconds !== undefined && left.seconds <= r.warningSeconds) ||
    (left.cycles !== undefined && left.cycles <= r.warningCycles) ||
    (left.landings !== undefined &&
      left.landings <=
        (r.warningLandings ?? REQUIREMENT_WARNING_DEFAULTS.warningLandings))
  );
}
