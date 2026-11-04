/**
 * Responsibility: Calendar arithmetic for component limits: interval due
 *   dates, whole days between dates, and the "not in the future" rule.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: zod; ../model (latestLocalDate), ../rejection.
 */
import { z } from "zod";
import { latestLocalDate } from "../model";
import { Rejection } from "../rejection";

const DAY_MS = 86_400_000;
const MONTHS_PER_YEAR = 12;
const LAST_SUPPORTED_YEAR = 9999;

/**
 * The due date of a calendar interval. Month and year intervals run to the
 * last day of the month they end in (calendar months).
 *
 * @param start - An ISO date.
 * @returns The due date, as an ISO date.
 * @throws {z.ZodError} When `start` is not an ISO date.
 * @throws {Rejection} "Calendar interval exceeds supported dates." outside
 *   years 1–9999.
 */
export function calendarDue(
  start: string,
  value: number,
  unit: "DAYS" | "MONTHS" | "YEARS",
): string {
  return shiftCalendarDate(start, value, unit, true);
}

/**
 * Moves an ISO date by a calendar interval, which may be negative.
 *
 * @param monthEnd - True to land on the last day of the final month; false to
 *   keep the day of the month, clamped to that month's length.
 * @throws As {@link calendarDue}.
 */
export function shiftCalendarDate(
  start: string,
  value: number,
  unit: "DAYS" | "MONTHS" | "YEARS",
  monthEnd: boolean,
): string {
  z.iso.date().parse(start);
  const d = new Date(start + "T00:00:00Z");
  if (unit === "DAYS") d.setUTCDate(d.getUTCDate() + value);
  else {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(
      d.getUTCMonth() + value * (unit === "YEARS" ? MONTHS_PER_YEAR : 1),
    );
    const end = new Date(d);
    end.setUTCMonth(end.getUTCMonth() + 1);
    end.setUTCDate(0);
    d.setUTCDate(monthEnd ? end.getUTCDate() : Math.min(day, end.getUTCDate()));
  }
  if (
    !Number.isFinite(d.getTime()) ||
    d.getUTCFullYear() > LAST_SUPPORTED_YEAR ||
    d.getUTCFullYear() < 1
  )
    throw new Rejection("Calendar interval exceeds supported dates.");
  return d.toISOString().slice(0, 10);
}

/**
 * Whole days from one ISO date to another, rounded.
 *
 * @returns Negative when `to` is before `from`.
 */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

/**
 * Refuses a date later than today anywhere.
 *
 * @throws {Rejection} "Dates cannot be in the future."
 */
export function assertPastDate(d: string | undefined, now: number) {
  if (d && d > latestLocalDate(now))
    throw new Rejection("Dates cannot be in the future.");
}
