/**
 * Responsibility: The inventory's stock tallies: which lots need reordering,
 *   how many are expired or expiring, and the recorded stock value.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ../shelfLife, ./schemas (types).
 */
import { shelfLifeStatus } from "../shelfLife";
import type { Stock } from "./schemas";

/** The tallies {@link inventoryCounts} returns. */
export interface InventoryCounts {
  stockItems: number;
  atOrBelowReorder: number;
  expiredOrExpiring: number;
  /** The sum of unit cost times quantity; undefined when no lot has a cost. */
  recordedValue: number | undefined;
}

/**
 * Whether a stock lot has fallen to its reorder point.
 *
 * @param lot - The lot.
 * @returns True at or below its minimum.
 */
export function needsReorder(lot: Pick<Stock, "quantity" | "minimum">) {
  return lot.quantity <= lot.minimum;
}

/**
 * Tallies a program's stock lots and stored components.
 *
 * @param stock - The stock lots.
 * @param stored - The components in storage, counted for shelf life only.
 * @param today - The day to judge shelf life on (YYYY-MM-DD).
 * @returns Lots, lots to reorder, lots and components expired or expiring,
 *   and the value of the lots that record a cost.
 */
export function inventoryCounts(
  stock: Stock[],
  stored: { expirationDate?: string }[],
  today: string,
): InventoryCounts {
  const costed = stock.filter((r) => r.cost !== undefined);
  return {
    stockItems: stock.length,
    atOrBelowReorder: stock.filter(needsReorder).length,
    expiredOrExpiring: [...stock, ...stored].filter((r) =>
      shelfLifeStatus(r.expirationDate, today),
    ).length,
    recordedValue: costed.length
      ? costed.reduce((n, r) => n + (r.cost ?? 0) * r.quantity, 0)
      : undefined,
  };
}
