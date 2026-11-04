/**
 * Responsibility: Pins the purchase-order rules the screens apply: limits
 *   that match the schemas, statuses, the overdue rule, inspection shortfalls
 *   and per-vendor drafts with their refusals in order.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/purchaseOrderRules.ts, ./purchaseOrders,
 *   ./management, ./addresses, ./rejection.
 */
import { describe, expect, it } from "vitest";
import {
  CURRENCY_CODE_LENGTH,
  CURRENCY_CODE_PATTERN,
  MAX_CORE_DUE_DAYS,
  PO_STATUSES,
  deliveryOverdue,
  draftsToSave,
  inspectionShortfalls,
  type DraftSave,
} from "./purchaseOrderRules";
import {
  poDraftSchema,
  poLineSchema,
  poSchema,
  poStatus,
  type PODraft,
  type POLine,
  type PurchaseOrder,
} from "./purchaseOrders";
import {
  locationSchema,
  stockSchema,
  vendorSchema,
  type Vendor,
} from "./management";
import { addressSchema, formatAddress } from "./addresses";
import { Rejection } from "./rejection";

const TODAY = "2026-11-04";
const ADDRESS = addressSchema.parse({
  street: "1 Hangar Rd",
  city: "Town",
  region: "CA",
  postalCode: "94000",
  country: "US",
});

// The editor holds lines of quantity 0, which the schemas refuse, so the
// fixtures apply overrides after parsing.
function line(o: Partial<POLine> = {}): POLine {
  const parsed = poLineSchema.parse({
    uuid: "l1",
    locationUuid: "store",
    partNumber: "TIRE",
    description: "Tire",
    quantity: 2,
    unitCents: 100,
    kind: "part",
  });
  return { ...parsed, ...o };
}

function draft(o: Partial<PODraft> = {}): PODraft {
  const parsed = poDraftSchema.parse({
    uuid: "d",
    version: 0,
    vendor: "Vendor A",
    vendorContact: "typed contact",
    shipTo: "Main hangar",
    expectedDate: "",
    currency: "USD",
    shippingCents: 0,
    notes: "",
    lines: [line()],
  });
  return { ...parsed, ...o };
}

function order(o: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return poSchema.parse({
    ...draft(),
    programUuid: "program",
    number: "PO-1",
    phase: "issued",
    revision: 0,
    createdAt: 0,
    updatedAt: 0,
    shipments: [],
    receipts: [],
    history: [],
    ...o,
  });
}

function vendor(name: string, o: Partial<Vendor> = {}): Vendor {
  return vendorSchema.parse({
    uuid: name,
    version: 1,
    kind: "vendor",
    name,
    ...o,
  });
}

const moved = (lineUuid: string, quantity: number) => ({ lineUuid, quantity });
const shipment = (quantity: number): PurchaseOrder["shipments"][number] => ({
  uuid: "sh",
  date: TODAY,
  carrier: "",
  tracking: "",
  lines: [moved("l1", quantity)],
});
const receipt = (quantity: number): PurchaseOrder["receipts"][number] => ({
  uuid: "rc",
  date: TODAY,
  invoice: "",
  notes: "",
  actorId: "user",
  lines: [
    { ...moved("l1", quantity), condition: "new", itemUuids: [], serials: [] },
  ],
});

describe("purchase order limits", () => {
  it("allow the core due days and currency codes the schemas allow", () => {
    const core = (days: number) =>
      poLineSchema.safeParse(line({ exchange: true, coreDueDays: days }))
        .success;
    expect(MAX_CORE_DUE_DAYS).toBe(365);
    expect(core(MAX_CORE_DUE_DAYS)).toBe(true);
    expect(core(MAX_CORE_DUE_DAYS + 1)).toBe(false);
    const pattern = new RegExp(`^${CURRENCY_CODE_PATTERN}$`);
    for (const code of ["USD", "CAD", "usd", "US", "USDX", "U5D"]) {
      const valid = poDraftSchema.safeParse(draft({ currency: code })).success;
      expect(pattern.test(code)).toBe(valid);
      if (valid) expect(code).toHaveLength(CURRENCY_CODE_LENGTH);
    }
  });

  it("list exactly the statuses an order can reach", () => {
    const reached = [
      order({ phase: "draft" }),
      order(),
      order({ shipments: [shipment(1)] }),
      order({ shipments: [shipment(2)] }),
      order({ receipts: [receipt(1)] }),
      order({ receipts: [receipt(2)] }),
      order({ phase: "closed" }),
      order({ phase: "cancelled" }),
    ].map(poStatus);
    expect(new Set(reached)).toEqual(new Set(PO_STATUSES));
  });
});

describe("deliveryOverdue", () => {
  it("flags an issued order past its date with units to arrive", () => {
    const late = order({ expectedDate: "2026-11-03" });
    expect(deliveryOverdue(late, TODAY)).toBe(true);
    expect(deliveryOverdue({ ...late, expectedDate: TODAY }, TODAY)).toBe(
      false,
    );
    expect(deliveryOverdue({ ...late, expectedDate: "" }, TODAY)).toBe(false);
    expect(deliveryOverdue({ ...late, phase: "draft" }, TODAY)).toBe(false);
    expect(deliveryOverdue({ ...late, receipts: [receipt(2)] }, TODAY)).toBe(
      false,
    );
  });
});

describe("inspectionShortfalls", () => {
  const stock = (uuid: string, quantity: number) =>
    stockSchema.parse({
      uuid,
      version: 1,
      kind: "stock",
      partNumber: uuid.toUpperCase(),
      description: uuid,
      category: "part",
      condition: "new",
      locationUuid: "store",
      quantity,
      minimum: 0,
      alternates: "",
    });
  const location = (uuid: string) =>
    locationSchema.parse({
      uuid,
      version: 1,
      kind: "location",
      name: uuid,
      address: "",
      contact: "",
    });
  const forInspection = (phase: PurchaseOrder["phase"], uuid: string) =>
    order({
      phase,
      lines: [line({ stockUuid: "tire", inspectionUuid: uuid, quantity: 1 })],
    });

  it("leaves what stock, issued orders and its own drafts do not cover", () => {
    const s = {
      management: [stock("tire", 1), stock("nut", 9), location("loc")],
      purchaseOrders: [
        forInspection("issued", "insp"),
        forInspection("draft", "insp"),
        forInspection("draft", "other"),
      ],
    };
    const required = [
      { stockUuid: "nut", locationUuid: "store", quantity: 2 },
      { stockUuid: "gone", locationUuid: "store", quantity: 1 },
      { stockUuid: "loc", locationUuid: "store", quantity: 1 },
      { stockUuid: "tire", locationUuid: "store", quantity: 5 },
    ];
    const shortfalls = inspectionShortfalls(s, {
      uuid: "insp",
      requiredParts: required,
    });
    expect(shortfalls.map((x) => [x.stock.uuid, x.quantity])).toEqual([
      ["nut", 0],
      ["tire", 2],
    ]);
  });
});

describe("draftsToSave", () => {
  const vendors = [
    vendor("Vendor A"),
    vendor("Bolt Co", { addressDetails: ADDRESS }),
  ];
  const save = (o: Partial<DraftSave> = {}): DraftSave => ({
    draft: draft(),
    initial: draft(),
    lineVendors: {},
    vendors,
    target: "",
    orders: [],
    ...o,
  });
  const refusal = (o: Partial<DraftSave>) => {
    try {
      draftsToSave(save(o));
    } catch (e) {
      expect(e).toBeInstanceOf(Rejection);
      return (e as Error).message;
    }
    return "saved";
  };
  const twoLines = draft({
    shippingCents: 500,
    lines: [line(), line({ uuid: "l2", quantity: 0 }), line({ uuid: "l3" })],
  });

  it("refuses in order: no quantity, a saved PO's vendor, vendors, shipping", () => {
    expect(
      refusal({
        draft: draft({ vendor: "", lines: [line({ quantity: 0 })] }),
        initial: draft({ version: 2 }),
        lineVendors: { l1: "Bolt Co" },
      }),
    ).toBe("Select at least one part quantity to purchase.");
    expect(
      refusal({
        draft: draft({ vendor: "" }),
        initial: draft({ version: 2 }),
        lineVendors: { l1: "Bolt Co" },
      }),
    ).toBe("A saved PO must stay with one vendor.");
    expect(refusal({ draft: draft({ vendor: " " }) })).toBe(
      "Select a vendor for each part.",
    );
    expect(refusal({ draft: draft({ vendor: " Nobody " }) })).toBe(
      "Add vendor “Nobody” using Quick add or Add vendor before saving.",
    );
    expect(refusal({ draft: twoLines, lineVendors: { l3: "bolt co" } })).toBe(
      "Set shipping cost to zero here, then enter each vendor’s shipping charge on its separate draft PO.",
    );
  });

  it("writes one draft per vendor, skipping zero quantities", () => {
    const drafts = draftsToSave(
      save({
        draft: { ...twoLines, shippingCents: 0 },
        lineVendors: { l1: "bolt co" },
      }),
    );
    expect(drafts.map((d) => [d.uuid, d.vendor, d.lines.length])).toEqual([
      ["d", "Bolt Co", 1],
      ["d-1", "Vendor A", 1],
    ]);
    expect(drafts.map((d) => d.vendorContact)).toEqual([
      formatAddress(ADDRESS),
      "typed contact",
    ]);
    expect(drafts[0].vendorUuid).toBe("Bolt Co");
  });

  it("keeps shipping for one vendor and drops a contact typed for another", () => {
    const [only] = draftsToSave(
      save({
        draft: draft({ shippingCents: 500, vendor: "Vendor A" }),
        initial: draft({ vendor: "Old vendor" }),
      }),
    );
    expect([only.shippingCents, only.vendorContact]).toEqual([500, ""]);
  });

  it("adds lines only to an open draft with the same vendor, ship-to and currency", () => {
    const existing = order({ uuid: "open", phase: "draft" });
    const add = (o: Partial<PODraft>, orders = [existing]) =>
      refusal({ draft: draft(o), target: "open", orders });
    expect(add({}, [{ ...existing, phase: "issued" }])).toBe(
      "An existing draft must match the selected vendor.",
    );
    expect(add({ vendor: "Bolt Co" })).toBe(
      "An existing draft must match the selected vendor.",
    );
    expect(
      refusal({
        draft: draft({ lines: [line(), line({ uuid: "l2" })] }),
        lineVendors: { l2: "Bolt Co" },
        target: "open",
        orders: [existing],
      }),
    ).toBe("An existing draft must match the selected vendor.");
    expect(add({ shipTo: "Elsewhere" })).toBe(
      "Ship-to must match the existing draft.",
    );
    expect(add({ currency: "CAD" })).toBe(
      "Currency must match the existing draft.",
    );
    const [merged] = draftsToSave(
      save({
        draft: draft({ shipTo: " Main hangar " }),
        target: "open",
        orders: [existing],
      }),
    );
    expect([merged.uuid, merged.lines.length]).toEqual(["open", 2]);
  });
});
