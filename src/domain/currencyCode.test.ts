/**
 * Responsibility: Pins the shared currency-code rule at its edges, and that
 *   every schema holding a currency applies it.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/currencyCode.ts, ./aircraftSpruce, ./partsRequests,
 *   ./purchaseOrders.
 */
import { describe, expect, it } from "vitest";
import { spruceCredentials, sprucePartSchema } from "./aircraftSpruce";
import { CURRENCY_CODE_PATTERN, currencyCodeSchema } from "./currencyCode";
import { requestDraftSchema } from "./partsRequests";
import { poDraftSchema } from "./purchaseOrders";

const VALID = ["USD", "CAD", "EUR"];
const INVALID = ["usd", "Usd", "US", "USDX", "U5D", " USD", "USD ", ""];
const CODES = [...VALID, ...INVALID];
const accepts = (code: string) => currencyCodeSchema.safeParse(code).success;

describe("currency codes", () => {
  it("are exactly three capital letters", () => {
    expect(VALID.every(accepts)).toBe(true);
    expect(INVALID.some(accepts)).toBe(false);
  });

  it("match the input pattern as a browser applies it, to the whole value", () => {
    const pattern = new RegExp(`^(?:${CURRENCY_CODE_PATTERN})$`, "v");
    for (const code of CODES) expect(pattern.test(code)).toBe(accepts(code));
  });

  it.each([
    ["Aircraft Spruce credentials", spruceCredentials.shape.currency],
    ["linked catalog parts", sprucePartSchema.shape.currency],
    ["parts requests", requestDraftSchema.shape.currency],
    ["purchase orders", poDraftSchema.shape.currency],
  ])("apply to %s", (_, field) => {
    for (const code of CODES)
      expect(field.safeParse(code).success).toBe(accepts(code));
  });
});
