/**
 * Responsibility: Pins what the address lookup sends to Geoapify, how it reads
 *   the reply, and the messages it fails with.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/addressLookup.ts, src/domain/addresses.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  fetchAddressSuggestions,
  lookupInput,
  parseAddressSuggestions,
} from "./addressLookup";
import { addressSchema } from "./addresses";

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
const reply = (body: unknown, status = 200) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
const result = (formatted: string, extra: object = {}) => ({
  formatted,
  ...extra,
});
afterEach(() => vi.unstubAllGlobals());

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
  });
  it("caps postal code and country below what an address stores", () => {
    // Characterizes current behaviour (roadmap Finding 8): an address the app
    // has saved can still fail the lookup.
    const long = { postalCode: "9".repeat(101), country: "C".repeat(151) };
    expect(addressSchema.safeParse({ ...address(), ...long }).success).toBe(
      true,
    );
    expect(() =>
      lookupInput({ ...address(), postalCode: long.postalCode }),
    ).toThrow(z.ZodError);
    expect(() => lookupInput({ ...address(), country: long.country })).toThrow(
      z.ZodError,
    );
    expect(() =>
      lookupInput({
        ...address(),
        postalCode: "9".repeat(100),
        country: "C".repeat(150),
      }),
    ).not.toThrow();
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

describe("fetchAddressSuggestions", () => {
  it("sends only the physical address and keeps partial-match levels", async () => {
    const fetcher = reply({
      results: [
        result("Washington, DC", {
          housenumber: "1600",
          street: "Pennsylvania Avenue NW",
          city: "Washington",
          state_code: "DC",
          country: "United States",
          result_type: "city",
          rank: { confidence: 0.4 },
          datasource: { attribution: "Source" },
        }),
      ],
    });
    vi.stubGlobal("fetch", fetcher);
    const results = await fetchAddressSuggestions(
      lookupInput({ ...address(), region: "" }),
      "secret-test-key",
    );
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe(
      "https://api.geoapify.com/v1/geocode/search",
    );
    expect(url.searchParams.get("text")).toBe(
      "1600 Pennsylvania Avenue NW, Washington, 20500, United States",
    );
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("apiKey")).toBe("secret-test-key");
    expect(String(url)).not.toMatch(/receiving|555/i);
    expect(results).toEqual([
      {
        formatted: "Washington, DC",
        street: "1600 Pennsylvania Avenue NW",
        city: "Washington",
        region: "DC",
        postalCode: "",
        country: "United States",
        confidence: 0.4,
        matchLevel: "city",
        attribution: "Source",
      },
    ]);
  });
  it("does not leak the key when a network error quotes the request URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(Error("URL failed with apiKey=private-key")),
    );
    await expect(
      fetchAddressSuggestions(lookupInput(address()), "private-key"),
    ).rejects.toThrow(
      Error(
        "Address lookup could not connect. Your address has not been changed.",
      ),
    );
  });
  it.each([
    [
      401,
      "The Geoapify key was not accepted. Ask a system administrator to check Address verification in Settings → System.",
    ],
    [
      403,
      "The Geoapify key was not accepted. Ask a system administrator to check Address verification in Settings → System.",
    ],
    [429, "Address lookup quota reached. Try again later."],
    [
      500,
      "The address service is unavailable. Your address has not been changed.",
    ],
  ])("explains HTTP %i", async (status, message) => {
    vi.stubGlobal("fetch", reply({}, status));
    await expect(
      fetchAddressSuggestions(lookupInput(address()), "key"),
    ).rejects.toThrow(Error(message));
  });
  it("reports an unreadable reply plainly", async () => {
    const unexpected = Error(
      "The address service returned an unexpected response. Your address has not been changed.",
    );
    vi.stubGlobal("fetch", reply({ results: "none" }));
    await expect(
      fetchAddressSuggestions(lookupInput(address()), "key"),
    ).rejects.toThrow(unexpected);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json")));
    await expect(
      fetchAddressSuggestions(lookupInput(address()), "key"),
    ).rejects.toThrow(unexpected);
  });
});
