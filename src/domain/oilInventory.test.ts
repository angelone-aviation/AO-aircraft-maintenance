/**
 * Responsibility: Pins flight-line oil deductions and their refusals, the oil
 *   change-log entry, review protection, and stock change-log visibility.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/oilInventory.ts, ./programs, ./requiredParts,
 *   ./shelfLife, ./rejection, src/data/demo.ts (seed).
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { AuditEntry, FlightInput, Snapshot } from "./model";
import type { ManagedRecord, Stock } from "./management";
import {
  oilInventoryDeductions,
  oilUsageAudit,
  preserveOilInventory,
} from "./oilInventory";
import { Rejection } from "./rejection";
import { auditVisible, scopedSnapshot } from "./programs";
import { partsInventory } from "./requiredParts";
import { assertNotExpired } from "./shelfLife";

const location: ManagedRecord = {
  kind: "location",
  uuid: "oil-store",
  version: 0,
  programUuid: "demo-program",
  name: "Oil store",
  address: "",
  contact: "",
};
const stock = (over: Partial<Stock> = {}): Stock => ({
  kind: "stock",
  uuid: "oil-part",
  version: 0,
  programUuid: "demo-program",
  locationUuid: "oil-store",
  partNumber: "OIL-1",
  description: "Engine oil quart",
  category: "supply",
  condition: "new",
  alternates: "",
  quantity: 5,
  minimum: 0,
  vendor: "Secret Vendor",
  invoiceNumber: "INV-9",
  poRef: "PO-9",
  cost: 12.5,
  oil: true,
  ...over,
});
const vendor: ManagedRecord = {
  kind: "vendor",
  uuid: "vendor-1",
  version: 0,
  programUuid: "demo-program",
  name: "Secret Vendor",
  website: "",
  accountNumber: "",
  paymentTerms: "",
  notes: "",
};

function pilot(s: Snapshot): Snapshot {
  return {
    ...s,
    user: {
      ...s.members.find((m) => m.id === "demo-pilot")!,
      activeProgramUuid: "demo-program",
    },
  };
}
function world(records: ManagedRecord[] = [location, stock()]) {
  const s = demoSnapshot();
  s.management = records;
  return s;
}
const flight = (s: Snapshot, stockUuid = "oil-part"): FlightInput => ({
  aircraftUuid: s.aircraft[0].uuid,
  pilotId: "demo-pilot",
  startTime: "2026-01-01T10:00:00Z",
  hobbsOn: s.aircraft[0].currentHobbs + 3600,
  landings: 1,
  cycles: 1,
  origin: "AAA",
  destination: "BBB",
  operation: "Mission",
  flightRules: "VFR",
  remarks: "",
  discrepancy: "",
  oil: [
    {
      engine: "single",
      unit: "US qt",
      start: 6,
      added: 1,
      inventory: { locationUuid: "oil-store", stockUuid, quantity: 1 },
    },
  ],
});

describe("flight-line oil deductions", () => {
  it("deducts stock marked as oil for a flight user", () => {
    const s = pilot(world());
    const [change] = oilInventoryDeductions(s, flight(s));
    expect(change.after.quantity).toBe(4);
    expect(change.after.version).toBe(1);
    expect(change.before).toBe(s.management![1]);
  });
  it("draws nothing when no oil comes from inventory", () => {
    const s = pilot(world());
    const input = { ...flight(s), oil: [] };
    expect(oilInventoryDeductions(s, input)).toEqual([]);
  });
  it("refuses a user without flight permission", () => {
    const s = pilot(world());
    s.groups = s.groups.map((g) => ({ ...g, permissions: ["read"] }));
    const refused = () => oilInventoryDeductions(s, flight(s));
    expect(refused).toThrow(Rejection);
    expect(refused).toThrow("Flight permission is required to issue oil.");
  });
  it("refuses stock at another location or in another program", () => {
    const message =
      "Select an oil stock item and location in this Flight Program.";
    const moved = pilot(
      world([location, stock({ locationUuid: "elsewhere" })]),
    );
    const refused = () => oilInventoryDeductions(moved, flight(moved));
    expect(refused).toThrow(Rejection);
    expect(refused).toThrow(message);
    const other = pilot(world([location, stock({ programUuid: "other" })]));
    expect(() => oilInventoryDeductions(other, flight(other))).toThrow(message);
  });
  it("adds up both engines' draws against the unreserved quantity", () => {
    const s = pilot(world([location, stock({ reservedQuantity: 4 })]));
    const [left] = flight(s).oil!;
    const input = {
      ...flight(s),
      oil: [
        { ...left, engine: "left" as const },
        { ...left, engine: "right" as const },
      ],
    };
    const refused = () => oilInventoryDeductions(s, input);
    expect(refused).toThrow(Rejection);
    expect(refused).toThrow(
      "Insufficient stock for OIL-1. Available: 1; requested: 2.",
    );
    s.management = [location, stock({ reservedQuantity: 3 })];
    const changes = oilInventoryDeductions(s, input);
    expect(changes.map((c) => c.after.quantity)).toEqual([3]);
  });
  it("refuses a stock item that is not marked as oil", () => {
    const s = pilot(
      world([
        location,
        stock({ uuid: "tire", partNumber: "TIRE-1", oil: undefined }),
      ]),
    );
    expect(() => oilInventoryDeductions(s, flight(s, "tire"))).toThrow(
      /not marked as oil/,
    );
    const marked = pilot(world([location, stock({ oil: false })]));
    expect(() => oilInventoryDeductions(marked, flight(marked))).toThrow(
      /not marked as oil/,
    );
    const refused = () => oilInventoryDeductions(marked, flight(marked));
    expect(refused).toThrow(Rejection);
    expect(refused).toThrow(
      "OIL-1 is not marked as oil. Flight-line usage can only draw down oil stock.",
    );
  });
  it("refuses an expired oil lot like every other issue path (#47)", () => {
    const now = Date.parse("2026-10-20T12:00:00Z");
    const s = pilot(world([location, stock({ expirationDate: "2026-09-20" })]));
    expect(() => oilInventoryDeductions(s, flight(s), now)).toThrow(
      "OIL-1 expired on 2026-09-20. Expired stock cannot be issued or reserved.",
    );
    expect(() =>
      assertNotExpired(stock({ expirationDate: "2026-09-20" }), now),
    ).toThrow(
      "OIL-1 expired on 2026-09-20. Expired stock cannot be issued or reserved.",
    );
    const fresh = pilot(
      world([location, stock({ expirationDate: "2026-10-21" })]),
    );
    expect(oilInventoryDeductions(fresh, flight(fresh), now)[0].after).toEqual(
      expect.objectContaining({ quantity: 4 }),
    );
  });
  it("lists expired oil lots for the flight-line picker so they can be shown as expired", () => {
    const s = world([location, stock({ expirationDate: "2026-09-20" })]);
    const inventory = partsInventory(scopedSnapshot(pilot(s)));
    expect(inventory.stock.find((x) => x.uuid === "oil-part")).toMatchObject({
      oil: true,
      expirationDate: "2026-09-20",
    });
  });
  it("records only the stock id and quantities in the change log", () => {
    const s = pilot(world());
    const [change] = oilInventoryDeductions(s, flight(s));
    const entry = oilUsageAudit(change);
    expect(entry).toEqual({
      before: { stockUuid: "oil-part", quantity: 5 },
      after: { stockUuid: "oil-part", quantity: 4 },
    });
    const text = JSON.stringify(entry);
    for (const secret of [
      "Secret Vendor",
      "INV-9",
      "PO-9",
      "12.5",
      "oil-store",
    ])
      expect(text).not.toContain(secret);
  });
  it("lists only oil stock for the flight-line picker", () => {
    const s = world([
      location,
      stock(),
      stock({ uuid: "tire", partNumber: "TIRE-1", oil: undefined }),
    ]);
    const inventory = partsInventory(scopedSnapshot(pilot(s)));
    expect(inventory.stock.find((x) => x.uuid === "oil-part")?.oil).toBe(true);
    expect(inventory.stock.find((x) => x.uuid === "tire")?.oil).toBeFalsy();
  });
});

describe("flight review", () => {
  it("keeps posted oil usage, in any engine order", () => {
    const s = world();
    const [single] = flight(s).oil!;
    const left = { ...single, engine: "left" as const };
    const right = { ...single, engine: "right" as const, start: 5 };
    const posted = { ...flight(s), oil: [left, right] };
    expect(() =>
      preserveOilInventory(posted, { ...posted, oil: [right, left] }),
    ).not.toThrow();
    const changed = {
      ...posted,
      oil: [
        left,
        { ...right, inventory: { ...right.inventory!, quantity: 2 } },
      ],
    };
    const refused = () => preserveOilInventory(posted, changed);
    expect(refused).toThrow(Rejection);
    expect(refused).toThrow(
      "A flight review cannot change posted oil inventory usage. Correct stock through an inventory adjustment.",
    );
  });
});

describe("stock change-log visibility", () => {
  const entry = (over: Partial<AuditEntry>): AuditEntry => ({
    uuid: crypto.randomUUID(),
    at: 1,
    actorId: "demo-admin",
    action: "stock.oil_used",
    entityUuid: "oil-part",
    aircraftUuid: "demo-206",
    programUuid: "demo-program",
    before: JSON.stringify(stock()),
    after: JSON.stringify(stock({ quantity: 4 })),
    ...over,
  });
  const rows = () => [
    // Historic row written with the full admin-only stock record.
    entry({}),
    entry({ action: "record.save", entityUuid: "oil-store" }),
    entry({ action: "record.save", entityUuid: "vendor-1" }),
    // Row about a stock record that is no longer loaded.
    entry({ entityUuid: "gone-stock" }),
    entry({ action: "flight.created", entityUuid: "flight-1" }),
  ];
  it("hides stock, location and vendor rows from a non-admin even with an aircraft tag", () => {
    const s = pilot(world([location, stock(), vendor]));
    s.audit = rows();
    const canSee = auditVisible(s);
    expect(s.audit.filter(canSee).map((a) => a.entityUuid)).toEqual([
      "flight-1",
    ]);
    expect(scopedSnapshot(s).audit.map((a) => a.entityUuid)).toEqual([
      "flight-1",
    ]);
  });
  it("still shows the full stock history to a program administrator", () => {
    const s = world([location, stock(), vendor]);
    s.audit = rows();
    const visible = scopedSnapshot(s).audit;
    expect(visible.map((a) => a.entityUuid)).toEqual([
      "oil-part",
      "oil-store",
      "vendor-1",
      "gone-stock",
      "flight-1",
    ]);
    expect(visible[0].before).toContain("Secret Vendor");
  });
});
