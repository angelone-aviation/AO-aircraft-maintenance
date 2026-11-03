import { latestLocalDate } from "./model";
export const EXPIRING_SOON_DAYS = 30;
const dayMs = 86400000;
export type ShelfLife = "expired" | "soon";
/** Shelf-life state on `today`; usable through the expiration date itself. */
export function shelfLifeStatus(
  expirationDate: string | undefined,
  today: string,
): ShelfLife | undefined {
  if (!expirationDate) return undefined;
  if (expirationDate < today) return "expired";
  return (Date.parse(expirationDate) - Date.parse(today)) / dayMs <=
    EXPIRING_SOON_DAYS
    ? "soon"
    : undefined;
}
export const shelfLifeLabels: Record<ShelfLife, string> = {
  expired: "Expired",
  soon: "Expires soon",
};
/**
 * Whether stock is too old to issue or reserve. The server cannot see the
 * user's time zone, so "today" is the latest local date anywhere: stock is
 * treated as expired as soon as its date has passed in any zone. Availability
 * shown to users uses the same rule, so "available" always means "can reserve".
 */
export function expiredForUse(
  expirationDate: string | undefined,
  now = Date.now(),
) {
  return shelfLifeStatus(expirationDate, latestLocalDate(now)) === "expired";
}
/**
 * Units of a stock lot that can still be reserved or issued: on hand less
 * reservations, or none once the lot is past its shelf life (expiredForUse).
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
/** Blocks issuing or reserving expired stock (see expiredForUse). */
export function assertNotExpired(
  stock: { partNumber: string; expirationDate?: string },
  now = Date.now(),
) {
  if (expiredForUse(stock.expirationDate, now))
    throw new Error(
      `${stock.partNumber} expired on ${stock.expirationDate}. Expired stock cannot be issued or reserved.`,
    );
}
export function addDays(date: string, days: number) {
  return new Date(Date.parse(date) + days * dayMs).toISOString().slice(0, 10);
}
