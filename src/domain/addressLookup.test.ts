/**
 * Responsibility: Pins what the address lookup may send to Geoapify, how it
 *   reads the reply, and the messages its checks fail with.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/addressLookup.ts, src/domain/addresses.ts,
 *   src/domain/validationText.ts.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  addressLookupSchema,
  lookupInput,
  parseAddressSuggestions,
} from "./addressLookup";
import { addressSchema } from "./addresses";
import { validationText } from "./validationText";

const address = () =>
  addressSchema.parse({
    street: "1600 Pennsylvania Avenue NW",
    city: "Washington",
    region: "DC",
    postalCode: "20500",
    country: "United States",
    contactName: "Receiving",
    email: "receiving@example.com",
    phone: "+1 202 555 0100",
  });
const result = (formatted: string, extra: object = {}) => ({
  formatted,
  ...extra,
});
const refusal = (fields: object) => {
  const parsed = addressLookupSchema.safeParse({
    ...lookupInput(address()),
    ...fields,
  });
  return parsed.success ? "" : validationText(parsed.error);
};

describe("lookupInput", () => {
  it("keeps only the physical address fields", () => {
    expect(lookupInput({ ...address(), organization: "Hangar 4" })).toEqual({
      street: "1600 Pennsylvania Avenue NW",
      city: "Washington",
      region: "DC",
      postalCode: "20500",
      country: "United States",
    });
  });
  it("needs a street and a country", () => {
    expect(() => lookupInput({ ...address(), street: " " })).toThrow(
      z.ZodError,
    );
    expect(() => lookupInput({ ...address(), country: "" })).toThrow(
      z.ZodError,
    );
    expect(refusal({ street: " ", country: "" })).toBe(
      "Enter a street address to look up.\nEnter a country to look up.",
    );
  });
  it("names each field over its limit", () => {
    expect(
      refusal({
        street: "s".repeat(2001),
        city: "c".repeat(301),
        region: "r".repeat(301),
        postalCode: "9".repeat(301),
        country: "C".repeat(301),
      }),
    ).toBe(
      [
        "Street address is too long to look up (up to 2,000 characters).",
        "City is too long to look up (up to 300 characters).",
        "State / province is too long to look up (up to 300 characters).",
        "ZIP / postal code is too long to look up (up to 300 characters).",
        "Country is too long to look up (up to 300 characters).",
      ].join("\n"),
    );
    expect(
      refusal({
        street: "s".repeat(2000),
        city: "c".repeat(300),
        region: "r".repeat(300),
        postalCode: "9".repeat(300),
        country: "C".repeat(300),
      }),
    ).toBe("");
  });
  it("looks up any address the app can store", () => {
    const longest = {
      street: "s".repeat(1000),
      city: "c".repeat(150),
      postalCode: "9".repeat(300),
      country: "C".repeat(300),
    };
    expect(addressSchema.safeParse({ ...address(), ...longest }).success).toBe(
      true,
    );
    expect(() => lookupInput({ ...address(), ...longest })).not.toThrow();
  });
});

describe("parseAddressSuggestions", () => {
  it("keeps the first five results, filling missing parts", () => {
    const results = Array.from({ length: 6 }, (_, i) => result(`R${i}`));
    const parsed = parseAddressSuggestions({ results });
    expect(parsed.map((s) => s.formatted)).toEqual([
      "R0",
      "R1",
      "R2",
      "R3",
      "R4",
    ]);
    expect(parsed[0]).toEqual({
      formatted: "R0",
      street: "",
      city: "",
      region: "",
      postalCode: "",
      country: "",
      confidence: 0,
      matchLevel: "unknown",
      attribution: "© OpenStreetMap contributors",
    });
    expect(parseAddressSuggestions({ results: [] })).toEqual([]);
  });
  it("prefers city, then town, then village, and the state code over the state", () => {
    const [town, village] = parseAddressSuggestions({
      results: [
        result("A", { town: "Town", village: "Village", state: "Kansas" }),
        result("B", { village: "Village", state: "Kansas", state_code: "KS" }),
      ],
    });
    expect([town.city, town.region]).toEqual(["Town", "Kansas"]);
    expect([village.city, village.region]).toEqual(["Village", "KS"]);
  });
  it("refuses a reply not shaped like Geoapify's", () => {
    expect(() => parseAddressSuggestions({ results: [{}] })).toThrow(
      z.ZodError,
    );
  });
});
