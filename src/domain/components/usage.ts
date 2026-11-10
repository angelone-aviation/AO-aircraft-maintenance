/**
 * Responsibility: A component's accrued usage: what it tracks, the meter its
 *   time accrues from, and its totals on a date.
 * Layer: Domain. Pure functions; no I/O, no React (a `today` left to its
 *   default reads the clock).
 * Dependencies: ../model, ../rejection, ./records (types), ./calendar.
 *
 * Usage is stored as a baseline and accrues from the aircraft's meters while
 * installed; movements and service actions re-base it rather than edit it.
 */
import { localDate, totalSeconds, type Aircraft } from "../model";
import { daysBetween } from "./calendar";
import type { Component, ComponentRequirement } from "./records";
import { Rejection } from "../rejection";

/** A component's since-new, since-overhaul and since-repair usage. */
export type UsageBefore = Pick<
  ReturnType<typeof componentTotals>,
  "timeSinceNew" | "timeSinceOverhaul" | "timeSinceRepair" | "cyclesSinceNew"
>;

/**
 * The usage dimensions a component tracks.
 *
 * @returns Whether it tracks time, cycles and calendar age.
 */
export const tracking = (c: Component) => ({
  time: c.trackTime,
  cycles: c.trackCycles,
  calendar: c.trackCalendar,
});

/**
 * The aircraft meter a component's time accrues from: airframe total time,
 * or the collective hourmeter, which can run independently of it.
 *
 * @returns The meter's reading in seconds.
 * @throws {Rejection} "Collective component tracking requires a helicopter
 *   collective hourmeter reading." for a collective component without one.
 * @throws As `totalSeconds` (../model) for an aircraft meter without a
 *   reading.
 */
export function componentAircraftSeconds(
  c: Pick<Component, "usageMeter">,
  a: Aircraft,
) {
  if (c.usageMeter !== "collective") return totalSeconds(a);
  if (!a.helicopter || a.currentCyclicHobbs === undefined)
    throw new Rejection(
      "Collective component tracking requires a helicopter collective hourmeter reading.",
    );
  return a.currentCyclicHobbs;
}

/**
 * The aircraft meter reading an inspection or limit is measured against,
 * tolerating a meter with no reading when no hours limit needs it. A
 * calendar-only inspection on such an aircraft (only damaged data lacks a
 * reading) must still go overdue by date (bug RM-66).
 *
 * @param r - The record: its meter choice and whether it sets an hours limit.
 * @param a - The aircraft.
 * @returns The reading in seconds, or undefined when the record sets no hours
 *   limit and the meter cannot be read.
 * @throws As {@link componentAircraftSeconds} when the record sets an hours
 *   limit.
 */
export function aircraftSecondsFor(
  r: Pick<Component, "usageMeter"> & { dueSeconds?: number },
  a: Aircraft,
) {
  if (r.dueSeconds !== undefined) return componentAircraftSeconds(r, a);
  try {
    return componentAircraftSeconds(r, a);
  } catch (error) {
    if (error instanceof Rejection) return undefined;
    throw error;
  }
}

/**
 * A component's usage on a date: its baseline plus what accrued while
 * installed, on each dimension it tracks. Nothing accrues in inventory.
 *
 * @param a - The aircraft it is installed on; ignored in inventory.
 * @param today - A local date. A stored date one day later counts as today.
 * @returns Since-new, since-overhaul and since-repair seconds, cycles since
 *   new, service days and calendar overhaul days; unknown values stay null.
 * @throws {Error} "Installed aircraft not found." without `a` when installed.
 * @throws {Rejection} "Aircraft readings or date precede the installation
 *   baseline." when any accrual is negative.
 * @throws As {@link componentAircraftSeconds}.
 */
export function componentTotals(
  c: Component,
  a?: Aircraft,
  today = localDate(),
) {
  if (c.installed && !a) throw new Error("Installed aircraft not found.");
  const { seconds, cycles, days, overhaulDays } =
    c.installed && a
      ? accrueUsage(c, a, today)
      : { seconds: 0, cycles: 0, days: 0, overhaulDays: 0 };
  if (seconds < 0 || cycles < 0 || days < 0 || overhaulDays < 0)
    throw new Rejection(
      "Aircraft readings or date precede the installation baseline.",
    );
  return {
    timeSinceNew: c.timeSinceNew + seconds,
    timeSinceOverhaul:
      c.timeSinceOverhaul === null ? null : c.timeSinceOverhaul + seconds,
    timeSinceRepair:
      c.timeSinceRepair === null ? null : c.timeSinceRepair + seconds,
    cyclesSinceNew: c.cyclesSinceNew + cycles,
    serviceDays: c.serviceDaysBase + days,
    calendarOverhaulDays:
      c.calendarOverhaulDaysBase == null
        ? null
        : c.calendarOverhaulDaysBase + overhaulDays,
  };
}

/**
 * What can still be read of a component's usage when {@link componentTotals}
 * cannot compute it, for judging the limits that need nothing unreadable.
 * GLOSSARY "Overdue": a limit that is reached decides, whatever cannot be
 * read on another.
 *
 * @param a - The aircraft it is installed on; ignored in inventory.
 * @param today - A local date, as for {@link componentTotals}.
 * @returns Every time value null, and cycles since new: counted when only
 *   the time is unreadable (an aircraft meter without a reading), else null.
 * @throws {Error} "Installed aircraft not found." without `a` when installed.
 */
export function componentTotalsWithoutTime(
  c: Component,
  a?: Aircraft,
  today = localDate(),
) {
  const times = {
    timeSinceNew: null,
    timeSinceOverhaul: null,
    timeSinceRepair: null,
  };
  try {
    const untimed = componentTotals({ ...c, trackTime: false }, a, today);
    return {
      ...times,
      cyclesSinceNew: untimed.cyclesSinceNew as number | null,
    };
  } catch (error) {
    if (error instanceof Rejection) return { ...times, cyclesSinceNew: null };
    throw error;
  }
}

/**
 * The time a requirement's basis counter shows.
 *
 * @returns Seconds since new, overhaul or repair; null when unknown.
 */
export function usageOnBasis(
  basis: ComponentRequirement["timeBasis"],
  usage: {
    timeSinceNew: number | null;
    timeSinceOverhaul: number | null;
    timeSinceRepair: number | null;
  },
): number | null {
  if (basis === "TSN") return usage.timeSinceNew;
  if (basis === "TSO") return usage.timeSinceOverhaul;
  return usage.timeSinceRepair;
}

// Usage since installation on each tracked dimension. A date one day ahead
// is time-zone skew (device-local dates checked on a UTC server, or the
// reverse), not a reading before the baseline, so it counts as zero days.
function accrueUsage(c: Component, a: Aircraft, today: string) {
  const track = tracking(c);
  const elapsedDays = (from: string) => {
    const days = daysBetween(from, today);
    return days === -1 ? 0 : days;
  };
  const overhaulDate = c.calendarOverhaulDate ?? c.installedDate;
  return {
    seconds: track.time
      ? componentAircraftSeconds(c, a) - c.installedSeconds
      : 0,
    cycles: track.cycles ? a.cycles - c.installedCycles : 0,
    days: track.calendar && c.installedDate ? elapsedDays(c.installedDate) : 0,
    overhaulDays:
      track.calendar && c.calendarOverhaulDaysBase != null && overhaulDate
        ? elapsedDays(overhaulDate)
        : 0,
  };
}
