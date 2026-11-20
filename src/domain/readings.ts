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

/** Seconds in an hour: the factor between typed hours and stored seconds. */
export const SECONDS_PER_HOUR = 3600;
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

/** Shown for a number typed with a comma that could be a decimal comma. */
export const DECIMAL_COMMA_MESSAGE =
  "Use a point for decimals, as in 2342.5, and leave out thousands commas.";

/** Shown for a number typed in exponent form, as in 1e5. */
export const EXPONENT_MESSAGE =
  "Type the number in plain digits, as in 2342.5.";

/**
 * The one rule every numeric and money field reads commas by. A comma counts
 * only as a thousands separator, in a number that also has a decimal point
 * ("2,342.5"). Any other comma ("2342,5", "45,50", "4,550") may be a decimal
 * comma, which would make the number 10 to 1,000 times too large, so it is
 * refused rather than guessed.
 *
 * @param text - The number as typed.
 * @returns The text with its thousands commas removed; text without a comma
 *   unchanged.
 * @throws {Rejection} {@link DECIMAL_COMMA_MESSAGE}.
 */
export function plainNumberText(text: string): string {
  if (!text.includes(",")) return text;
  if (!/^\d{1,3}(,\d{3})+\.\d+$/.test(text))
    throw new Rejection(DECIMAL_COMMA_MESSAGE);
  return text.replaceAll(",", "");
}

/**
 * What is wrong with text about to go into a number input, whose value the
 * browser keeps without commas or reads in exponent form: "2342,5" would
 * silently become 23425 and "1e5" 100000.
 *
 * @param inserted - The typed or pasted text.
 * @returns {@link DECIMAL_COMMA_MESSAGE} for a comma,
 *   {@link EXPONENT_MESSAGE} for an "e"; undefined otherwise.
 */
export function numberEntryProblem(inserted: string): string | undefined {
  if (inserted.includes(",")) return DECIMAL_COMMA_MESSAGE;
  if (/e/i.test(inserted)) return EXPONENT_MESSAGE;
  return undefined;
}

/**
 * Reads hours as typed, with at most one decimal, as whole seconds; commas
 * as {@link plainNumberText} reads them.
 *
 * @param text - The typed hours, such as "1234.5" or "1,234.5".
 * @returns The seconds, or undefined when the value is blank.
 * @throws {Rejection} {@link DECIMAL_COMMA_MESSAGE} for a comma that may be
 *   a decimal comma; "Use hours of 0 or more, with at most one decimal place."
 *   for any other text (spaces around a number included);
 *   "Meter reading is too large." past the largest safe integer.
 */
export function parseHours(text: string): number | undefined {
  if (!text.trim()) return undefined;
  const value = plainNumberText(text);
  if (!/^\d+(\.\d)?$/.test(value))
    throw new Rejection(
      "Use hours of 0 or more, with at most one decimal place.",
    );
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
