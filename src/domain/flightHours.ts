/**
 * Responsibility: Adds up the hours each aircraft flew per week or month,
 *   for the Overview's and the aircraft detail's flight-hour charts.
 * Layer: Domain. Pure functions over a snapshot; no I/O, no React.
 * Dependencies: ./model (types, localDate), ./costs (flightSeconds).
 *
 * Only accepted flights count, on the meter in use at the time, the same as
 * the cost report: a flight held for review is not in the aircraft's totals.
 */
import { flightSeconds } from "./costs";
import { localDate, type Snapshot } from "./model";

const DAY_MS = 86_400_000;
const DAYS_PER_WEEK = 7;
// Date#getUTCDay counts from Sunday; the weeks here start on Monday.
const DAYS_SINCE_MONDAY = [6, 0, 1, 2, 3, 4, 5];

/** The flying of one week or month. */
export interface FlownPeriod {
  /** The period's first day, YYYY-MM-DD. */
  start: string;
  /** Meter seconds flown, by aircraft uuid; an aircraft that did not fly in
   * the period has no entry. */
  seconds: Record<string, number>;
}

/**
 * Flying per week, for the weeks up to and including the one `today` is in.
 *
 * @param today - The device's date, YYYY-MM-DD.
 * @param weeks - How many weeks to return.
 * @returns `weeks` periods, oldest first, each starting on a Monday. A flight
 *   counts in the week of its start time on this device's calendar; flights
 *   before the first week or of an aircraft outside the snapshot are left out.
 */
export function flownByWeek(
  s: Snapshot,
  today: string,
  weeks: number,
): FlownPeriod[] {
  const day = utcDay(today);
  const monday = day - DAYS_SINCE_MONDAY[new Date(day * DAY_MS).getUTCDay()];
  const starts = Array.from({ length: weeks }, (_, i) =>
    isoDay(monday - (weeks - 1 - i) * DAYS_PER_WEEK),
  );
  return flownByPeriod(s, starts);
}

/**
 * Flying per calendar month, for the months up to and including the one
 * `today` is in.
 *
 * @param today - The device's date, YYYY-MM-DD.
 * @param months - How many months to return.
 * @returns `months` periods, oldest first, each starting on the 1st, counted
 *   as {@link flownByWeek} counts weeks.
 */
export function flownByMonth(
  s: Snapshot,
  today: string,
  months: number,
): FlownPeriod[] {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7)) - 1;
  const starts = Array.from({ length: months }, (_, i) =>
    new Date(Date.UTC(year, month - (months - 1 - i), 1))
      .toISOString()
      .slice(0, 10),
  );
  return flownByPeriod(s, starts);
}

/**
 * The seconds one aircraft, or the whole fleet, flew in a period.
 *
 * @param aircraftUuid - The aircraft; every aircraft when left out.
 */
export function flownSeconds(period: FlownPeriod, aircraftUuid?: string) {
  if (aircraftUuid !== undefined) return period.seconds[aircraftUuid] ?? 0;
  return Object.values(period.seconds).reduce((sum, n) => sum + n, 0);
}

// `starts` ascend; a flight belongs to the last period starting on or before
// its date.
function flownByPeriod(s: Snapshot, starts: string[]): FlownPeriod[] {
  const periods = starts.map((start) => ({
    start,
    seconds: {} as Record<string, number>,
  }));
  const aircraft = new Map(s.aircraft.map((a) => [a.uuid, a]));
  for (const f of s.flights) {
    const a = aircraft.get(f.aircraftUuid);
    const date = localDate(Date.parse(f.startTime));
    const period = periods.findLast((p) => p.start <= date);
    const seconds = a ? flightSeconds(a, f) : 0;
    if (!period || !seconds) continue;
    period.seconds[f.aircraftUuid] =
      (period.seconds[f.aircraftUuid] ?? 0) + seconds;
  }
  return periods;
}

const utcDay = (iso: string) => Date.parse(iso + "T00:00:00Z") / DAY_MS;
const isoDay = (day: number) =>
  new Date(day * DAY_MS).toISOString().slice(0, 10);
