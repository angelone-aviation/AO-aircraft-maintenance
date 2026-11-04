/**
 * Responsibility: Meter readings as people type and read them (decimal hours)
 *   and as records store them (whole seconds in tenths of an hour).
 * Layer: Domain. Pure functions and a zod schema; no I/O, no React.
 * Dependencies: zod, ./rejection.
 *
 * Hobbs, tach, collective and flight-time-log meters read in tenths of an
 * hour, so a stored reading is a whole multiple of 360 seconds.
 */
import { z } from "zod";
import { Rejection } from "./rejection";

const SECONDS_PER_HOUR = 3600;
const TENTH_HOUR_SECONDS = SECONDS_PER_HOUR / 10;

/**
 * A stored meter reading: whole, non-negative seconds in tenths of an hour.
 *
 * @throws {z.ZodError} From `parse()`, "Meter readings must use tenths of an
 *   hour" for a reading between tenths.
 */
export const meterReadingSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(
    (n) => n % TENTH_HOUR_SECONDS === 0,
    "Meter readings must use tenths of an hour",
  );

/**
 * Reads hours as typed, with at most one decimal, as whole seconds.
 *
 * @param value - The typed hours, such as "1234.5".
 * @returns The seconds, or undefined when the value is blank.
 * @throws {Rejection} "Use positive hours with at most one decimal place." for
 *   any other text (spaces around a number included; "0" passes); "Meter
 *   reading is too large." past the largest safe integer.
 */
export function parseHours(value: string): number | undefined {
  if (!value.trim()) return undefined;
  if (!/^\d+(\.\d)?$/.test(value))
    throw new Rejection("Use positive hours with at most one decimal place.");
  const result = Math.round(Number(value) * SECONDS_PER_HOUR);
  if (!Number.isSafeInteger(result))
    throw new Rejection("Meter reading is too large.");
  return result;
}

/**
 * Shows a reading as hours to one decimal, without thousands separators.
 *
 * @param seconds - The reading.
 * @returns Such as "1234.5", to the nearest tenth.
 */
export function readingText(seconds: number): string {
  return (seconds / SECONDS_PER_HOUR).toFixed(1);
}

/**
 * The text an hours field starts with for a time in seconds, unrounded, so a
 * stored reading reads back unchanged through {@link parseHours}.
 *
 * @param seconds - The time, if any.
 * @returns Such as "1234.5" or "-1"; "" for no time.
 */
export function hoursField(seconds?: number): string {
  return seconds === undefined ? "" : String(seconds / SECONDS_PER_HOUR);
}

/**
 * Converts hours to whole seconds without the tenths rule: for a time that is
 * not a meter reading, or a reading still being typed.
 *
 * @param hours - The hours.
 * @returns The nearest whole second.
 */
export function hoursToSeconds(hours: number): number {
  return Math.round(hours * SECONDS_PER_HOUR);
}
