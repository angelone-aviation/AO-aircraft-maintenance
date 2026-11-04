/**
 * Responsibility: Pins the inventory's stock tallies: the reorder point,
 *   shelf-life counts over lots and stored components, and the stock value.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/management/stock.ts, ./schemas (types).
 */
import { describe, expect, it } from "vitest";
import { inventoryCounts, needsReorder } from "./stock";
import type { Stock } from "./schemas";

const TODAY = "2026-10-20";
const lot = (over: Partial<Stock>): Stock => ({
  kind: "stock",
  uuid: "lot",
  version: 1,
  partNumber: "PN",
  description: "Part",
  alternates: "",
  category: "part",
  condition: "new",
  locationUuid: "store",
  quantity: 5,
  minimum: 2,
  ...over,
});

describe("stock tallies", () => {
  it("reorders at or below the minimum", () => {
    expect(
      [1, 2, 3].map((quantity) => needsReorder({ quantity, minimum: 2 })),
    ).toEqual([true, true, false]);
  });

  it("counts lots to reorder, and lots and stored components expired or expiring", () => {
    const stock = [
      lot({ quantity: 4, cost: 2.5 }),
      lot({ quantity: 2, expirationDate: "2026-10-19" }),
      lot({ quantity: 1, expirationDate: "2026-11-01", cost: 3 }),
    ];
    const stored = [{ expirationDate: "2026-11-15" }, {}];
    expect(inventoryCounts(stock, stored, TODAY)).toEqual({
      stockItems: 3,
      atOrBelowReorder: 2,
      expiredOrExpiring: 3,
      recordedValue: 13,
    });
  });

  it("values only lots with a cost, and none without any", () => {
    expect(inventoryCounts([lot({})], [], TODAY).recordedValue).toBeUndefined();
    expect(inventoryCounts([lot({ cost: 0 })], [], TODAY).recordedValue).toBe(
      0,
    );
  });
});
