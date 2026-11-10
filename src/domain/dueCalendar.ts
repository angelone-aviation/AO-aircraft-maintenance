/**
 * Responsibility: Lays forecast items out on a month: a Monday-first grid of
 *   weeks, an agenda of the month's days that hold items, and the items with
 *   no date.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ./forecast (projections, ISO date arithmetic).
 *
 * Dates are calendar days as ISO strings, moved in UTC (forecast.addDays), so
 * a daylight-saving change in the device's zone never skips or repeats a day.
 */
import { addDays, weekOf, type Projection } from "./forecast";

const DAYS_PER_WEEK = 7;
const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** An item the calendar can place: dated when it has a projection. */
export interface CalendarItem {
  projection?: Projection;
}

/** One calendar day and the items due on it. */
export interface CalendarDay<T> {
  date: string;
  /** False for the days before and after the month that fill its weeks. */
  inMonth: boolean;
  items: T[];
}

/** A month of due items, as {@link dueMonth} lays it out. */
export interface DueMonth<T> {
  /** YYYY-MM. */
  month: string;
  /** Monday to Sunday rows covering the whole month. */
  weeks: CalendarDay<T>[][];
  /** The month's days that hold items, in date order. */
  agenda: CalendarDay<T>[];
  /** Items with no projected date, in the order given. */
  undated: T[];
}

/**
 * Places each item on the date it is projected to fall due. An overdue item
 * is projected on today (forecast.projectDue), so it shows on today.
 *
 * @param items - Forecast items; their order is kept within each day.
 * @param month - The month to show, YYYY-MM.
 * @returns The month's weeks (whole weeks, so days of the months either side
 *   are included with their items), its agenda and the undated items.
 * @throws {RangeError} "Invalid month: …" when `month` is not YYYY-MM.
 */
export function dueMonth<T extends CalendarItem>(
  items: readonly T[],
  month: string,
): DueMonth<T> {
  const days = gridDays(month).map((date) => ({
    date,
    inMonth: monthOf(date) === month,
    items: items.filter((i) => i.projection?.date === date),
  }));
  const weeks: CalendarDay<T>[][] = [];
  for (let at = 0; at < days.length; at += DAYS_PER_WEEK)
    weeks.push(days.slice(at, at + DAYS_PER_WEEK));
  return {
    month,
    weeks,
    agenda: days.filter((d) => d.inMonth && d.items.length > 0),
    undated: items.filter((i) => !i.projection),
  };
}

/**
 * The month an ISO date falls in.
 *
 * @param date - YYYY-MM-DD.
 * @returns YYYY-MM.
 */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/**
 * Moves a month forward or back.
 *
 * @param month - YYYY-MM.
 * @param delta - Whole months; negative goes back.
 * @returns YYYY-MM, across year ends ("2026-12" + 1 is "2027-01").
 * @throws {RangeError} "Invalid month: …" when `month` is not YYYY-MM.
 */
export function shiftMonth(month: string, delta: number): string {
  const { year, index } = parseMonth(month);
  const total = year * 12 + index + delta;
  const shifted = Math.floor(total / 12);
  const m = total - shifted * 12 + 1;
  return `${String(shifted).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
}

function gridDays(month: string) {
  const { year, index } = parseMonth(month);
  const first = `${month}-01`;
  const last = new Date(Date.UTC(year, index + 1, 0)).toISOString();
  const start = weekOf(first);
  const end = addDays(weekOf(last.slice(0, 10)), DAYS_PER_WEEK - 1);
  const days: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  return days;
}

function parseMonth(month: string) {
  const match = MONTH_PATTERN.exec(month);
  if (!match) throw new RangeError(`Invalid month: ${month}`);
  return { year: Number(match[1]), index: Number(match[2]) - 1 };
}
