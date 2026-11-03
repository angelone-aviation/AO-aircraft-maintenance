import { describe, expect, it, vi, afterEach } from "vitest";
import {
  addressSchema,
  blankAddress,
  addressIssues,
  assertConfirmedAddress,
  formatAddress,
} from "./addresses";
import {
  lookupInput,
  fetchAddressSuggestions,
  parseAddressSuggestions,
} from "./addressLookup";
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
afterEach(() => vi.unstubAllGlobals());
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
    expect(() =>
      assertConfirmedAddress({ ...address(), confirmed: false }),
    ).toThrow(/confirm/);
    expect(formatAddress(address())).toContain(
      "Washington, DC, 20500\nUnited States\nContact: Receiving\nEmail: receiving@example.com\nPhone: +1 202 555 0100",
    );
    expect(blankAddress("Original address text").street).toBe(
      "Original address text",
    );
  });
  it("sends only physical address fields to the external service and preserves partial-match levels", async () => {
    const input = lookupInput(address());
    expect(input).not.toHaveProperty("email");
    expect(input).not.toHaveProperty("contactName");
    expect(input).not.toHaveProperty("phone");
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [
              {
                formatted: "Washington, DC",
                city: "Washington",
                state_code: "DC",
                country: "United States",
                result_type: "city",
                rank: { confidence: 0.4 },
              },
            ],
          }),
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    const results = await fetchAddressSuggestions(input, "secret-test-key");
    const url = String(fetcher.mock.calls[0][0]);
    expect(url).not.toContain("receiving");
    expect(url).not.toContain("555");
    expect(results[0]).toMatchObject({
      street: "",
      matchLevel: "city",
      confidence: 0.4,
    });
    expect(parseAddressSuggestions({ results: [] })).toEqual([]);
  });
  it("does not leak the provider key when a network error includes the request URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(Error("URL failed with apiKey=private-key")),
    );
    await expect(
      fetchAddressSuggestions(lookupInput(address()), "private-key"),
    ).rejects.toThrow("Address lookup could not connect.");
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
    applyPOCommand(s, command);
    applyPOCommand(s, command);
    expect(s.purchaseOrders?.[0].shipTo).toBe(formatAddress(address()));
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
