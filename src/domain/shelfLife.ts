/**
 * Responsibility: Shelf life of stock lots: expired or expiring soon, how much
 *   of a lot is usable, and the guard that stops expired stock being used.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ./model.
 *
 * A lot is usable through its expiration date.
 */
import { latestLocalDate } from "./model";

const DAY_MS = 86400000;

/** Lots expiring within this many days are flagged as expiring soon. */
export const EXPIRING_SOON_DAYS = 30;

/** A lot's shelf-life flag: past its date, or within the warning window. */
export type ShelfLife = "expired" | "soon";

/**
 * Flags a lot's shelf life on a given day.
 *
 * @param expirationDate - The lot's expiration date (YYYY-MM-DD), if any.
 * @param today - The day to judge on (YYYY-MM-DD).
 * @returns "expired" after the expiration date, "soon" from
 *   {@link EXPIRING_SOON_DAYS} days before it through the date itself, else
 *   undefined (also for no date).
 */
export function shelfLifeStatus(
  expirationDate: string | undefined,
  today: string,
): ShelfLife | undefined {
  if (!expirationDate) return undefined;
  if (expirationDate < today) return "expired";
  const daysLeft = (Date.parse(expirationDate) - Date.parse(today)) / DAY_MS;
  return daysLeft <= EXPIRING_SOON_DAYS ? "soon" : undefined;
}

/** Display name of each shelf-life flag. */
export const shelfLifeLabels: Record<ShelfLife, string> = {
  expired: "Expired",
  soon: "Expires soon",
};

/**
 * Tells whether stock is too old to issue or reserve. The server cannot see
 * the user's time zone, so it judges by the latest local date anywhere;
 * availability uses the same rule, so "available" always means "can reserve".
 *
 * @param expirationDate - The lot's expiration date, if any.
 * @param now - The time to judge at, in epoch milliseconds.
 * @returns True once the expiration date has passed in any time zone.
 */
export function expiredForUse(
  expirationDate: string | undefined,
  now = Date.now(),
) {
  return shelfLifeStatus(expirationDate, latestLocalDate(now)) === "expired";
}

/**
 * Counts the units of a stock lot that can still be reserved or issued.
 *
 * @param stock - The lot.
 * @param now - The time to judge shelf life at.
 * @returns On-hand quantity less reservations, or 0 once
 *   {@link expiredForUse}.
 */
export function usableQuantity(
  stock: {
    quantity: number;
    reservedQuantity?: number;
    expirationDate?: string;
  },
  now = Date.now(),
) {
  return expiredForUse(stock.expirationDate, now)
    ? 0
    : stock.quantity - (stock.reservedQuantity ?? 0);
}

/**
 * Stops expired stock being issued or reserved (see {@link expiredForUse}).
 *
 * @param stock - The lot.
 * @param now - The time to judge shelf life at.
 * @throws {Error} "<part number> expired on <date>. Expired stock cannot be
 *   issued or reserved."
 */
export function assertNotExpired(
  stock: { partNumber: string; expirationDate?: string },
  now = Date.now(),
) {
  // A plain Error, not a Rejection: flight submission turns only plain Errors
  // from oil draw-down into a FlightRejection.
  if (expiredForUse(stock.expirationDate, now))
    throw new Error(
      `${stock.partNumber} expired on ${stock.expirationDate}. Expired stock cannot be issued or reserved.`,
    );
}

/**
 * Adds calendar days to a date.
 *
 * @param date - A date as YYYY-MM-DD.
 * @param days - Days to add; negative goes back.
 * @returns The new date as YYYY-MM-DD, counted in UTC.
 */
export function addDays(date: string, days: number) {
  return new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);
}
