/**
 * Responsibility: Pins the checks a saved address passes before it is stored.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/savedAddresses.ts, src/domain/addresses.ts,
 *   src/domain/rejection.ts, src/data/demo.ts (fixture).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { demoSnapshot } from "../data/demo";
import { addressSchema } from "./addresses";
import { Rejection } from "./rejection";
import {
  MAX_SAVED_ADDRESSES,
  parseAddressSave,
  prepareSavedAddress,
  saveAddress,
  savedAddressNameKey,
  type SavedAddress,
} from "./savedAddresses";

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

describe("parseAddressSave", () => {
  const incomplete = Error(
    "Enter an address name and complete the recipient name, address, email and phone fields.",
  );
  it("refuses without a program, then a caller who is not an administrator, before reading the entry", () => {
    const s = demoSnapshot();
    s.user = { ...s.user, isAdmin: false, groupIds: ["demo-pilots"] };
    for (const [programUuid, message] of [
      ["", "Select a Flight Program."],
      ["demo-program", "Flight Program administrator required."],
    ]) {
      const run = () => parseAddressSave(s, programUuid, "not an entry");
      expect(run).toThrow(Rejection);
      expect(run).toThrow(Error(message));
    }
  });
  it("answers any invalid or incomplete entry with one summary Rejection", () => {
    const s = demoSnapshot();
    for (const raw of [
      undefined,
      { ...entry(), name: " " },
      { ...entry(), address: { ...entry().address, phone: "" } },
    ]) {
      expect(() => parseAddressSave(s, "demo-program", raw)).toThrow(Rejection);
      expect(() => parseAddressSave(s, "demo-program", raw)).toThrow(
        incomplete,
      );
    }
    expect(parseAddressSave(s, "demo-program", entry())).toEqual(
      prepareSavedAddress(entry()),
    );
  });
});

describe("saveAddress", () => {
  const input = () => prepareSavedAddress(entry());
  const stored = (previous: SavedAddress | null = null) => ({
    previous,
    sameName: null,
    count: 0,
  });
  const kept = (fields: Partial<SavedAddress> = {}): SavedAddress => ({
    ...input(),
    programUuid: "demo-program",
    ...fields,
  });
  const refused = (message: string) => [Rejection, Error(message)] as const;
  function expectRefusal(run: () => unknown, message: string) {
    for (const error of refused(message)) expect(run).toThrow(error);
  }

  it("returns a new address as version 1 of its program", () => {
    expect(saveAddress("demo-program", input(), stored())).toEqual({
      ...input(),
      version: 1,
      programUuid: "demo-program",
    });
  });
  it("refuses another program's address before a stale version", () => {
    const foreign = kept({ programUuid: "other", version: 3 });
    expectRefusal(
      () => saveAddress("demo-program", input(), stored(foreign)),
      "Address not found in this Flight Program.",
    );
  });
  it("refuses a stale version before a taken name", () => {
    expectRefusal(
      () =>
        saveAddress("demo-program", input(), {
          ...stored(kept({ version: 1 })),
          sameName: kept({ uuid: "other" }),
        }),
      "Address changed. Reopen it before saving.",
    );
    expectRefusal(
      () => saveAddress("demo-program", { ...input(), version: 1 }, stored()),
      "Address changed. Reopen it before saving.",
    );
  });
  it("refuses a name another address holds before the cap, and caps only new addresses", () => {
    const full = { ...stored(), count: MAX_SAVED_ADDRESSES };
    expectRefusal(
      () =>
        saveAddress("demo-program", input(), {
          ...full,
          sameName: kept({ uuid: "other" }),
        }),
      "An address with this name already exists in this program. Select it or use another name.",
    );
    expectRefusal(
      () => saveAddress("demo-program", input(), full),
      "A Flight Program can keep up to 200 saved addresses. Edit an existing address instead.",
    );
    expect(
      saveAddress(
        "demo-program",
        { ...input(), version: 1 },
        { ...full, previous: kept({ version: 1 }), sameName: kept() },
      ).version,
    ).toBe(2);
    expect(MAX_SAVED_ADDRESSES).toBe(200);
  });
  it("keys names without case", () => {
    expect(savedAddressNameKey("Receiving HANGAR")).toBe("receiving hangar");
  });
});
