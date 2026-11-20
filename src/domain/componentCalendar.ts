/**
 * Responsibility: Converts a component's time in service between the days
 *   stored and the months people type and read.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ./rejection.
 *
 * Service age is a duration, so a month is an average month; calendar
 * deadlines still use calendar dates.
 */
import { Rejection } from "./rejection";

// About 1,000 years.
const MAX_SERVICE_DAYS = 365000;

/** Days in an average month (365.25 / 12), for durations in service. */
export const daysPerServiceMonth = 30.4375;

/**
 * Shows stored days in service as months.
 *
 * @param days - Days in service.
 * @returns Months to three decimals, enough for {@link serviceDaysFromMonths}
 *   to give back the same days for any count up to the cap.
 */
export const serviceMonthsFromDays = (days: number): number =>
  Number((days / daysPerServiceMonth).toFixed(3));

// The cap as people type it, so the check and its refusal state one number.
const MAX_SERVICE_MONTHS = serviceMonthsFromDays(MAX_SERVICE_DAYS);

/**
 * Reads the prior months in service a person typed as the days to store.
 *
 * @param value - The months as typed; decimals allowed.
 * @returns Days, rounded to the nearest whole day.
 * @throws {Rejection} "Enter valid prior months in service between 0 and
 *   11991.786." when the value is blank, not a finite number, negative, or
 *   over that cap, 365,000 days shown in months.
 */
export function serviceDaysFromMonths(value: string): number {
  const months = Number(value);
  if (
    !value.trim() ||
    !Number.isFinite(months) ||
    months < 0 ||
    months > MAX_SERVICE_MONTHS
  )
    throw new Rejection(
      `Enter valid prior months in service between 0 and ${MAX_SERVICE_MONTHS}.`,
    );
  return Math.round(months * daysPerServiceMonth);
}
