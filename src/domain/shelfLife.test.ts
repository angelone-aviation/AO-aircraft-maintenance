/**
 * Responsibility: Pins shelf-life flags, usable quantity, and the refusal to
 *   issue or reserve expired stock on every path that moves it.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/shelfLife.ts, ./management, ./partsRequests,
 *   ./purchaseOrders, src/data/demo.ts (seed).
 */
import { describe, it, expect } from "vitest";
import { demoSnapshot } from "../data/demo";
import { applyManagement, type Stock } from "./management";
import { applyRequestCommand, requestDraftSchema } from "./partsRequests";
import { applyPOCommand, poDraftSchema } from "./purchaseOrders";
import {
  addDays,
  assertNotExpired,
  expiredForUse,
  shelfLifeLabels,
  shelfLifeStatus,
  usableQuantity,
} from "./shelfLife";
const now = Date.parse("2026-10-20T12:00:00Z");
function fixture(expirationDate?: string) {
  const s = demoSnapshot();
  const stock: Stock = {
    uuid: "stock",
    version: 1,
    programUuid: "demo-program",
    kind: "stock",
    partNumber: "SEALANT",
    description: "Sealant",
    category: "supply",
    condition: "new",
    locationUuid: "store",
    quantity: 4,
    minimum: 0,
    alternates: "",
    expirationDate,
  };
  s.management = [
    {
      uuid: "store",
      version: 1,
      programUuid: "demo-program",
      kind: "location",
      name: "Main store",
      address: "Hangar",
      contact: "",
    },
    stock,
  ];
  return s;
}
const stockOf = (s: ReturnType<typeof fixture>, uuid = "stock") =>
  s.management!.find((r) => r.uuid === uuid) as Stock;
describe("shelf life", () => {
  it("flags expired, expiring within 30 days, and leaves later or blank dates alone", () => {
    const today = "2026-10-20";
    expect(shelfLifeStatus(undefined, today)).toBeUndefined();
    expect(shelfLifeStatus("2026-10-19", today)).toBe("expired");
    expect(shelfLifeStatus("2026-10-20", today)).toBe("soon");
    expect(shelfLifeStatus("2026-11-19", today)).toBe("soon");
    expect(shelfLifeStatus("2026-11-20", today)).toBeUndefined();
  });
  it("adds calendar days across month and year ends", () => {
    expect(addDays("2026-12-15", 30)).toBe("2027-01-14");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
  });
  it("labels each flag and counts a lot without reservations in full", () => {
    expect(shelfLifeLabels).toEqual({
      expired: "Expired",
      soon: "Expires soon",
    });
    expect(usableQuantity({ quantity: 4 }, now)).toBe(4);
  });
  it("blocks issuing expired stock but still allows receipts and counts", () => {
    const s = fixture("2026-10-01");
    const move = (operation: "issue" | "receive" | "adjust") =>
      applyManagement(
        s,
        {
          action: "stock.move",
          requestUuid: crypto.randomUUID(),
          reason: "Test",
          uuid: "stock",
          version: stockOf(s).version,
          operation,
          quantity: 1,
        },
        now,
      );
    expect(() => move("issue")).toThrow(
      "SEALANT expired on 2026-10-01. Expired stock cannot be issued",
    );
    expect(stockOf(s).quantity).toBe(4);
    move("receive");
    move("adjust");
    expect(stockOf(s).quantity).toBe(1);
    expect(() => assertNotExpired(stockOf(s), now)).toThrow("expired");
    expect(() =>
      assertNotExpired({ partNumber: "X", expirationDate: "2026-10-21" }, now),
    ).not.toThrow();
  });
  it("counts expired stock as unavailable by the same rule that refuses it (#40)", () => {
    const lot = (expirationDate?: string) => ({
      partNumber: "SEALANT",
      quantity: 4,
      reservedQuantity: 1,
      expirationDate,
    });
    for (const date of [undefined, "2026-10-01", "2026-10-20", "2026-10-21"]) {
      const refused = (() => {
        try {
          assertNotExpired(lot(date), now);
          return false;
        } catch {
          return true;
        }
      })();
      expect(expiredForUse(date, now)).toBe(refused);
      expect(usableQuantity(lot(date), now)).toBe(refused ? 0 : 3);
    }
    // Refused as soon as the date has passed anywhere (UTC+14).
    expect(
      expiredForUse("2026-10-20", Date.parse("2026-10-20T10:00:00Z")),
    ).toBe(true);
  });
  it("blocks reserving or issuing expired stock to a parts request", () => {
    const s = fixture("2026-11-01");
    const draft = requestDraftSchema.parse({
      uuid: "request",
      version: 0,
      source: { kind: "stock" },
      mode: "parts",
      date: "2026-10-20",
      engineer: "Engineer",
      priority: "P2 Routine",
      requiredBy: "",
      vendor: "Vendor",
      currency: "USD",
      shipTo: "Hangar",
      lines: [
        { uuid: "item", partNumber: "SEALANT", description: "S", quantity: 2 },
      ],
    });
    applyRequestCommand(s, { kind: "save", requestUuid: "create", draft }, now);
    const act = (kind: "reserve" | "issue" | "release", at = now) =>
      applyRequestCommand(
        s,
        {
          kind,
          requestUuid: crypto.randomUUID(),
          uuid: "request",
          version: s.partsRequests![0].version,
          lineUuid: "item",
          stockUuid: "stock",
          quantity: 1,
          alternateConfirmed: false,
        },
        at,
      );
    act("reserve");
    const later = Date.parse("2026-11-05T12:00:00Z");
    expect(() => act("issue", later)).toThrow("expired on 2026-11-01");
    expect(() => act("reserve", later)).toThrow("expired");
    expect(stockOf(s)).toMatchObject({ quantity: 4, reservedQuantity: 1 });
    act("release", later);
    expect(stockOf(s).reservedQuantity).toBe(0);
  });
  it("captures expiration on PO receipt as its own lot and refuses to reserve expired receipts", () => {
    const s = fixture("2027-01-01");
    const draft = (uuid: string) =>
      poDraftSchema.parse({
        uuid,
        version: 0,
        vendor: "Vendor",
        vendorContact: "",
        shipTo: "Hangar",
        expectedDate: "",
        currency: "USD",
        shippingCents: 0,
        notes: "",
        lines: [
          {
            uuid: "line",
            stockUuid: "stock",
            locationUuid: "store",
            partNumber: "SEALANT",
            description: "Sealant",
            quantity: 4,
            unitCents: 500,
            kind: "supply",
          },
        ],
      });
    let [p] = applyPOCommand(
      s,
      { kind: "save", requestUuid: "save", drafts: [draft("po")] },
      now,
    );
    [p] = applyPOCommand(
      s,
      {
        kind: "issue",
        requestUuid: "issue",
        uuid: p.uuid,
        version: p.version,
        reason: "",
      },
      now,
    );
    const receive = (quantity: number, expirationDate?: string) =>
      ([p] = applyPOCommand(
        s,
        {
          kind: "receive",
          requestUuid: crypto.randomUUID(),
          uuid: p.uuid,
          version: p.version,
          date: "2026-10-20",
          invoice: "INV",
          notes: "",
          lines: [
            {
              lineUuid: "line",
              quantity,
              condition: "new",
              serials: [],
              expirationDate,
            },
          ],
        },
        now,
      ));
    receive(1, "2027-01-01");
    expect(stockOf(s).quantity).toBe(5);
    receive(1, "2027-06-30");
    const lots = s.management!.filter(
      (r): r is Stock => r.kind === "stock" && r.partNumber === "SEALANT",
    );
    expect(lots).toHaveLength(2);
    expect(lots.find((l) => l.uuid !== "stock")).toMatchObject({
      quantity: 1,
      expirationDate: "2027-06-30",
    });
    expect(p.receipts[1].lines[0].expirationDate).toBe("2027-06-30");
  });
});
