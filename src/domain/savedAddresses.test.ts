/**
 * Responsibility: Pins the check a saved address passes before it is stored.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/savedAddresses.ts, src/domain/addresses.ts,
 *   ./rejection.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { addressSchema } from "./addresses";
import { Rejection } from "./rejection";
import { prepareSavedAddress } from "./savedAddresses";

const entry = () => ({
  uuid: "saved",
  version: 0,
  name: " Receiving hangar ",
  address: addressSchema.parse({
    street: "123 Main St",
    city: "Wichita",
    region: "KS",
    postalCode: "67209",
    country: "USA",
    contactName: "Receiving",
    email: "receiving@example.com",
    phone: "316 555 0100",
  }),
});

describe("prepareSavedAddress", () => {
  it("stores the address confirmed and named after the trimmed entry name", () => {
    const prepared = prepareSavedAddress(entry());
    expect(prepared.name).toBe("Receiving hangar");
    expect(prepared.address).toEqual({
      ...entry().address,
      addressName: "Receiving hangar",
      confirmed: true,
    });
  });
  it("refuses a blank name", () => {
    const blank = { ...entry(), name: "  " };
    expect(() => prepareSavedAddress(blank)).toThrow(z.ZodError);
    expect(() => prepareSavedAddress(blank)).toThrow("Enter an address name.");
  });
  it("refuses an incomplete address with every issue, joined by spaces", () => {
    const incomplete = {
      ...entry(),
      address: { ...entry().address, city: "", phone: "" },
    };
    expect(() => prepareSavedAddress(incomplete)).toThrow(
      Error("City is required. Phone is required."),
    );
    expect(() => prepareSavedAddress(incomplete)).toThrow(Rejection);
  });
});
