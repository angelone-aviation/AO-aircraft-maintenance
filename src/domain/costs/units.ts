/**
 * Responsibility: Money and labor time in cost records: their units and
 *   limits, and how people type and read them.
 * Layer: Domain. Pure functions and constants; no I/O, no React.
 * Dependencies: ../rejection, ../readings (comma rule); ./records (types).
 *
 * Money is integer cents. Labor time is integer seconds, exact for hours
 * entered to the hundredth (36 s); entries saved before that carry only whole
 * minutes and keep their amounts.
 */
import { Rejection } from "../rejection";
import { plainNumberText } from "../readings";
import type { LaborEntry } from "./records";

/** Seconds in a minute, the unit of labor saved before exact seconds. */
export const SECONDS_PER_MINUTE = 60;
/** Seconds in an hour, the unit labor rates and flight hours are priced in. */
export const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_HUNDREDTH_HOUR = 36;
/** Cents in a dollar; stock costs are kept in dollars. */
export const CENTS_PER_DOLLAR = 100;
const MAX_ENTRY_HOURS = 1000;

/** The largest amount of money a cost field holds: $1 billion, in cents. */
export const MAX_CENTS = 100_000_000_000;
/** The largest labor rate: $100,000 an hour, in cents. */
export const MAX_RATE_CENTS = 10_000_000;
/** The longest single labor entry, 1,000 hours, in whole minutes. */
export const MAX_ENTRY_MINUTES = MAX_ENTRY_HOURS * SECONDS_PER_MINUTE;
/** The longest single labor entry, 1,000 hours, in seconds. */
export const MAX_ENTRY_SECONDS = MAX_ENTRY_HOURS * SECONDS_PER_HOUR;

/**
 * Parses hours as typed, exactly: "1.33" is 4,788 seconds.
 *
 * @returns Whole seconds.
 * @throws {Rejection} "Enter hours as a number with up to two decimals.",
 *   "Labor hours must be greater than zero." or "A single labor entry cannot
 *   exceed 1,000 hours."
 */
export function parseLaborHours(value: string) {
  const v = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(v))
    throw new Rejection("Enter hours as a number with up to two decimals.");
  const [whole, fraction = ""] = v.split(".");
  const seconds =
    Number(whole) * SECONDS_PER_HOUR +
    Number(fraction.padEnd(2, "0")) * SECONDS_PER_HUNDREDTH_HOUR;
  if (seconds <= 0)
    throw new Rejection("Labor hours must be greater than zero.");
  if (!Number.isSafeInteger(seconds) || seconds > MAX_ENTRY_SECONDS)
    throw new Rejection("A single labor entry cannot exceed 1,000 hours.");
  return seconds;
}

/**
 * Parses money as typed: "$1,234.5" is 123,450 cents. Commas are read as
 * plainNumberText reads them, so "45,50" is refused, never $4,550.
 *
 * @param max - The largest amount accepted, in cents.
 * @throws {Rejection} As plainNumberText for a comma that may be a decimal
 *   comma; "Enter a positive amount with up to two decimals."; "Amount is too
 *   large."
 */
export function parseCents(value: string, max = MAX_CENTS) {
  const v = plainNumberText(value.trim().replace(/^\$/, ""));
  if (!/^\d+(\.\d{1,2})?$/.test(v))
    throw new Rejection("Enter a positive amount with up to two decimals.");
  const [whole, fraction = ""] = v.split(".");
  const result =
    Number(whole) * CENTS_PER_DOLLAR + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(result) || result > max)
    throw new Rejection("Amount is too large.");
  return result;
}

/**
 * Formats cents as US dollars.
 *
 * @returns Such as "$1,234.50".
 */
export function formatCents(c: number) {
  return (c / CENTS_PER_DOLLAR).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

/** Labor time in seconds: exact when recorded, else the stored whole minutes. */
export const laborSeconds = (e: Pick<LaborEntry, "minutes" | "seconds">) =>
  e.seconds ?? e.minutes * SECONDS_PER_MINUTE;

/**
 * The price of a labor entry, rounded to the cent.
 *
 * @returns Cents; 0 when the rate is hidden from the caller.
 */
export const laborCents = (
  e: Pick<LaborEntry, "minutes" | "seconds" | "rateCents">,
) => Math.round((laborSeconds(e) * (e.rateCents ?? 0)) / SECONDS_PER_HOUR);

/**
 * Formats labor seconds as hours, such as "1.33", with up to two decimals.
 */
export const formatLaborHours = (seconds: number) =>
  (seconds / SECONDS_PER_HOUR).toLocaleString("en-US", {
    maximumFractionDigits: 2,
  });
