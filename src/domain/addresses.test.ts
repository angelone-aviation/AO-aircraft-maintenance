/**
 * Responsibility: Pins the structured-address rules and the confirmation gate
 *   on issuing a purchase order.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/addresses.ts, src/domain/management.ts,
 *   src/domain/purchaseOrders.ts, src/data/demo.ts (fixture).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  addressSchema,
  blankAddress,
  addressIssues,
  assertConfirmedAddress,
  formatAddress,
  addressFromForm,
  type Address,
} from "./addresses";
import { demoSnapshot } from "../data/demo";
import { applyManagement } from "./management";
import { applyPOCommand, poDraftSchema } from "./purchaseOrders";
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
    confirmed: true,
  });
describe("structured addresses", () => {
  it("checks required fields, ZIP codes and contacts without claiming postal verification", () => {
    expect(addressIssues(address())).toEqual([]);
    expect(addressIssues({ ...address(), postalCode: "bad" })).toContain(
      "US ZIP code must be 5 digits or ZIP+4.",
    );
    expect(
      addressSchema.safeParse({ ...address(), email: "bad" }).success,
    ).toBe(false);
    expect(
      addressSchema.safeParse({ ...address(), phone: "bad" }).success,
    ).toBe(false);
    // Not postal verification, so a person must still confirm.
    expect(() =>
      assertConfirmedAddress({ ...address(), confirmed: false }),
    ).toThrow(/confirm/);
    expect(formatAddress(address())).toContain(
      "Washington, DC, 20500\nUnited States\nContact: Receiving\nEmail: receiving@example.com\nPhone: +1 202 555 0100",
    );
    // Legacy free-text addresses move into the street line so no text is lost.
    expect(blankAddress("Original address text").street).toBe(
      "Original address text",
    );
  });
  it("persists location contacts and requires confirmation when issuing a structured PO", () => {
    const s = demoSnapshot();
    s.user.isAdmin = true;
    applyManagement(s, {
      action: "record.save",
      requestUuid: crypto.randomUUID(),
      reason: "Create location",
      record: {
        uuid: "store",
        version: 0,
        kind: "location",
        name: "Receiving",
        address: "legacy",
        contact: "legacy",
        addressDetails: address(),
      },
    });
    // The legacy text fields are regenerated from the structured address.
    expect(s.management?.find((r) => r.uuid === "store")).toMatchObject({
      address: formatAddress(address()),
      contact: "Receiving",
      addressDetails: address(),
    });
    const draft = poDraftSchema.parse({
      uuid: "po",
      version: 0,
      vendor: "Vendor",
      vendorContact: "",
      shipTo: "old text",
      shippingAddress: { ...address(), confirmed: false },
      expectedDate: "",
      currency: "USD",
      shippingCents: 0,
      notes: "",
      lines: [
        {
          uuid: "line",
          locationUuid: "store",
          partNumber: "PART",
          description: "Part",
          quantity: 1,
          unitCents: 100,
          kind: "part",
        },
      ],
    });
    const command = {
      kind: "save" as const,
      requestUuid: "save",
      drafts: [draft],
    };
    // Applied twice with one request id: the replay must not add a second PO.
    applyPOCommand(s, command);
    applyPOCommand(s, command);
    expect(s.purchaseOrders?.[0].shipTo).toBe(formatAddress(address()));
    // An unconfirmed address blocks issue, even when every field is valid.
    expect(() =>
      applyPOCommand(s, {
        kind: "issue",
        requestUuid: "issue",
        uuid: "po",
        version: 1,
        reason: "",
      }),
    ).toThrow(/confirm/);
    applyPOCommand(s, {
      kind: "save",
      requestUuid: "confirmed",
      drafts: [{ ...draft, version: 1, shippingAddress: address() }],
    });
    applyPOCommand(s, {
      kind: "issue",
      requestUuid: "issue",
      uuid: "po",
      version: 2,
      reason: "",
    });
    expect(s.purchaseOrders?.[0].phase).toBe("issued");
  });
});

// Mirrors the private limits in addresses.ts; a change to either fails here.
const FIELD_MAX_LENGTH = 300;
const COMBINED_MAX_LENGTH = 1900;
// blankAddress() has ten string fields, so joining them adds nine separators.
const BLANK_ADDRESS_SEPARATORS = 9;
const POSTAL_CODE_REQUIRED =
  "ZIP / postal code is required (enter N/A where no postal code is used).";
const REGION_REQUIRED = "State / province is required.";

describe("addressIssues: required fields and regions", () => {
  it("lists every missing required field once, in form order", () => {
    expect(addressIssues(blankAddress())).toEqual([
      "Street address is required.",
      "City is required.",
      "Country is required.",
      "Contact name is required.",
      "Email is required.",
      "Phone is required.",
      POSTAL_CODE_REQUIRED,
    ]);
    // Whitespace alone does not count as a value.
    expect(addressIssues({ ...address(), city: "   " })).toEqual([
      "City is required.",
    ]);
  });
  it.each(["USA", "united states of america", "Canada", "AU", " Philippines "])(
    "requires a state or province for %j",
    (country) => {
      expect(addressIssues({ ...address(), country, region: " " })).toContain(
        REGION_REQUIRED,
      );
    },
  );
  it("does not require a state or province elsewhere", () => {
    expect(
      addressIssues({ ...address(), country: "Mexico", region: "" }),
    ).toEqual([]);
  });
});

describe("addressIssues: postal codes", () => {
  it("accepts a ZIP or ZIP+4 and checks the raw, untrimmed value", () => {
    expect(addressIssues({ ...address(), postalCode: "20500-0003" })).toEqual(
      [],
    );
    // Characterizes current behaviour: "Check & confirm address" checks the
    // value before the schema trims it, so a leading space blocks confirming.
    expect(addressIssues({ ...address(), postalCode: " 20500" })).toEqual([
      "US ZIP code must be 5 digits or ZIP+4.",
    ]);
    // Characterizes current behaviour: a missing US ZIP is also malformed.
    expect(addressIssues({ ...address(), postalCode: "" })).toEqual([
      POSTAL_CODE_REQUIRED,
      "US ZIP code must be 5 digits or ZIP+4.",
    ]);
  });
  it("checks Canadian postal codes as A1A 1A1, with or without the space", () => {
    const canadian = { ...address(), city: "Ottawa", region: "ON" };
    for (const postalCode of ["K1A 0B1", "k1a0b1"]) {
      expect(
        addressIssues({ ...canadian, country: "Canada", postalCode }),
      ).toEqual([]);
    }
    expect(
      addressIssues({ ...canadian, country: "CA", postalCode: "K1A-0B1" }),
    ).toEqual(["Canadian postal code must use the format A1A 1A1."]);
  });
  it("skips the postal code only where none is used, and accepts N/A elsewhere", () => {
    const abroad = { ...address(), region: "", postalCode: "" };
    expect(addressIssues({ ...abroad, country: "Hong Kong" })).toEqual([]);
    expect(addressIssues({ ...abroad, country: "mo" })).toEqual([]);
    expect(addressIssues({ ...abroad, country: "Japan" })).toEqual([
      POSTAL_CODE_REQUIRED,
    ]);
    expect(
      addressIssues({ ...abroad, country: "Japan", postalCode: "N/A" }),
    ).toEqual([]);
  });
});

describe("addressIssues: order and schema messages", () => {
  it("orders issues: missing fields, region, postal code", () => {
    expect(addressIssues({ ...blankAddress(), country: "USA" })).toEqual([
      "Street address is required.",
      "City is required.",
      "Contact name is required.",
      "Email is required.",
      "Phone is required.",
      REGION_REQUIRED,
      POSTAL_CODE_REQUIRED,
      "US ZIP code must be 5 digits or ZIP+4.",
    ]);
  });
  it("adds schema messages after the rule checks, without repeats", () => {
    const tooLong = "x".repeat(FIELD_MAX_LENGTH + 1);
    const issues = addressIssues({
      ...address(),
      organization: tooLong,
      street2: tooLong,
      phone: "555 010",
    });
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatch(String(FIELD_MAX_LENGTH));
    expect(issues[1]).toBe(
      "Enter a valid phone number, including area/country code.",
    );
  });
});

describe("addressSchema field rules", () => {
  const accepts = (patch: Partial<Address>) =>
    addressSchema.safeParse({ ...address(), ...patch }).success;
  it("accepts a phone with at least seven digits, separators and an extension", () => {
    expect(accepts({ phone: "" })).toBe(true);
    expect(accepts({ phone: "555 0100" })).toBe(true);
    expect(accepts({ phone: "555 010" })).toBe(false);
    expect(accepts({ phone: "(202) 555-0100 ext. 12" })).toBe(true);
    expect(accepts({ phone: "+1 202 555 0100 x12" })).toBe(true);
    expect(accepts({ phone: "202-555-0100 call" })).toBe(false);
    // Characterizes current behaviour: extension letters may go anywhere.
    expect(accepts({ phone: "e202 555 0100 t" })).toBe(true);
  });
  it("validates the email as typed, without trimming it", () => {
    expect(accepts({ email: " receiving@example.com" })).toBe(false);
  });
  it("limits each field after trimming, with a longer street for legacy text", () => {
    const limit = "x".repeat(FIELD_MAX_LENGTH);
    expect(accepts({ city: limit })).toBe(true);
    expect(accepts({ city: ` ${limit} ` })).toBe(true);
    expect(accepts({ city: `${limit}x` })).toBe(false);
    expect(accepts({ street: `${limit}x` })).toBe(true);
  });
  it("caps the combined text of all fields", () => {
    const longest = COMBINED_MAX_LENGTH - BLANK_ADDRESS_SEPARATORS;
    expect(
      addressSchema.safeParse(blankAddress("x".repeat(longest))).success,
    ).toBe(true);
    const over = addressSchema.safeParse(blankAddress("x".repeat(longest + 1)));
    expect(over.error?.issues.map((issue) => issue.message)).toEqual([
      "Address and contact details are too long.",
    ]);
  });
});

describe("assertConfirmedAddress", () => {
  it("passes a complete, confirmed address", () => {
    expect(() => assertConfirmedAddress(address())).not.toThrow();
  });
  it("reports field problems before the missing confirmation", () => {
    expect(() =>
      assertConfirmedAddress({
        ...address(),
        city: "",
        phone: "",
        confirmed: false,
      }),
    ).toThrow(Error("Shipping address: City is required. Phone is required."));
    expect(() =>
      assertConfirmedAddress({ ...address(), confirmed: false }),
    ).toThrow(
      Error("Review and confirm the shipping address before issuing this PO."),
    );
  });
});

describe("addressFromForm", () => {
  it("reads the JSON the address fields post, by default under addressDetails", () => {
    const form = new FormData();
    expect(addressFromForm(form)).toBeUndefined();
    form.set("addressDetails", "");
    expect(addressFromForm(form)).toBeUndefined();
    form.set(
      "addressDetails",
      JSON.stringify({ street: " 1 Main St ", city: "Wichita" }),
    );
    expect(addressFromForm(form)).toEqual({
      ...blankAddress("1 Main St"),
      city: "Wichita",
    });
    form.set("shipTo", JSON.stringify(address()));
    expect(addressFromForm(form, "shipTo")).toEqual(address());
  });
  it("throws on malformed JSON or an invalid address", () => {
    const form = new FormData();
    form.set("addressDetails", "{not json");
    expect(() => addressFromForm(form)).toThrow(SyntaxError);
    form.set("addressDetails", JSON.stringify({ email: "bad" }));
    expect(() => addressFromForm(form)).toThrow(z.ZodError);
  });
});

describe("formatAddress and blankAddress", () => {
  it("drops empty parts so a partial address leaves no blank lines", () => {
    expect(formatAddress(blankAddress())).toBe("");
    expect(
      formatAddress({
        ...blankAddress(),
        organization: "Hangar 4",
        city: "Wichita",
        postalCode: "67209",
      }),
    ).toBe("Hangar 4\nWichita, 67209");
  });
  it("starts unconfirmed, with the legacy text as the street and the known contact", () => {
    expect(
      blankAddress("Old text", "Receiving", "receiving@example.com"),
    ).toStrictEqual({
      organization: "",
      street: "Old text",
      street2: "",
      city: "",
      region: "",
      postalCode: "",
      country: "",
      contactName: "Receiving",
      email: "receiving@example.com",
      phone: "",
      confirmed: false,
    });
  });
});
