/**
 * Responsibility: The Inventory screen's chart of stock lots that are in
 *   stock against those at or below their reorder point.
 * Layer: UI. Presentational component; the reorder rule lives in src/domain.
 * Dependencies: src/domain (management types, shopCharts), ./charts,
 *   ./design, src/styles/screens/shop.css.
 */
import type { Stock } from "../domain/management";
import { stockLevels } from "../domain/shopCharts";
import { StackedBar } from "./charts";
import { SectionHeading } from "./design";
import "../styles/screens/shop.css";

/**
 * A bar of the stock lots split into "In stock" and "Reorder", the words
 * each lot's pill uses, over a legend with each count and share. Hidden on
 * phones, where the tiles above give the same counts.
 *
 * @param props.stock - Every stock lot of the Flight Program, unfiltered.
 * @returns The chart card, or nothing when there are no lots.
 */
export function StockLevelChart({ stock }: { stock: Stock[] }) {
  if (!stock.length) return null;
  const { inStock, reorder } = stockLevels(stock);
  return (
    <section className="ds-card shop-chart-card shop-hide-phone">
      <SectionHeading
        title="Stock levels"
        note={`${stock.length} stock ${stock.length === 1 ? "item" : "items"}`}
      />
      <StackedBar
        label="Stock items by level"
        segments={[
          // A lot in stock is simply fine, not airworthy or done, so it
          // takes the accent; only Reorder wears a status colour.
          { label: "In stock", value: inStock, tone: "1" },
          { label: "Reorder", value: reorder, tone: "warn" },
        ]}
      />
    </section>
  );
}
