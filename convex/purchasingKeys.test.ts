/**
 * Responsibility: Pins which lookup keys a parts request and a purchase
 *   order derive, and that a sync writes only the keys a record gained and
 *   deletes those it lost.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex (schema, purchasingKeys), src/domain (partsRequests,
 *   purchaseOrders).
 */
import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import schema from "./schema";
import {
  purchasingKeysOf,
  syncPurchasingKeys,
  type PurchasingKey,
} from "./purchasingKeys";
import { partsRequestSchema } from "../src/domain/partsRequests";
import { poSchema } from "../src/domain/purchaseOrders";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const PROGRAM = "demo-program";

it("keys a request by its history's request ids, its lines' components, and its aircraft while it is an active list", () => {
  const request = storedRequest({
    recurring: true,
    lines: [repairLine("l1", "pump"), repairLine("l2", "pump"), partLine()],
    history: [entry("save-1"), entry("receipt-1"), entry("receipt-1")],
  });
  expect(keysOf(purchasingKeysOf("partsRequests", request)!)).toEqual([
    "requestId save-1",
    "requestId receipt-1",
    "component pump",
    "list aircraft-1",
  ]);
  const cancelled = { ...request, cancelled: true };
  expect(keysOf(purchasingKeysOf("partsRequests", cancelled)!)).not.toContain(
    "list aircraft-1",
  );
});

it("keys an order by its history's request ids, the requests its lines are allocated to, and the components they return from repair", () => {
  const order = storedOrder([
    { ...orderLine("o1"), requestAllocations: [allocation("r1")] },
    {
      ...orderLine("o2"),
      repairComponentUuid: "pump",
      requestAllocations: [allocation("r2"), allocation("r1")],
    },
    { ...orderLine("o3"), repairComponentUuid: "" },
  ]);
  expect(keysOf(purchasingKeysOf("purchaseOrders", order)!)).toEqual([
    "requestId save-1",
    "allocation r1",
    "allocation r2",
    "component pump",
  ]);
});

it("holds no keys for another collection", () => {
  const plan = { uuid: "plan" } as never;
  expect(purchasingKeysOf("flightPlans", plan)).toBeUndefined();
});

it("writes only the keys a record gained and deletes those it lost", async () => {
  const t = convexTest(schema, modules);
  const first = storedOrder([
    { ...orderLine("o1"), requestAllocations: [allocation("r1")] },
  ]);
  const next = storedOrder([
    { ...orderLine("o1"), requestAllocations: [allocation("r2")] },
  ]);
  const stored = await t.run(async (ctx) => {
    const written = [
      await syncPurchasingKeys(ctx, "purchaseOrders", first),
      await syncPurchasingKeys(ctx, "purchaseOrders", first),
      await syncPurchasingKeys(ctx, "purchaseOrders", next),
    ];
    const rows = await ctx.db.query("purchasingKeys").collect();
    return { written, rows };
  });
  expect(stored.written).toEqual([2, 0, 2]);
  expect(keysOf(stored.rows)).toEqual(["requestId save-1", "allocation r2"]);
});

function keysOf(keys: PurchasingKey[]) {
  return keys.map((k) => `${k.kind} ${k.key}`);
}

function storedRequest(fields: object) {
  return partsRequestSchema.parse({
    uuid: "request-1",
    version: 1,
    source: { kind: "inspection", uuid: "inspection-1" },
    mode: "repair",
    date: "2026-11-03",
    engineer: "Tech",
    priority: "P2 Routine",
    requiredBy: "",
    currency: "USD",
    lines: [],
    programUuid: PROGRAM,
    aircraftUuid: "aircraft-1",
    sourceLabel: "Inspection",
    aircraftRegistration: "N1",
    aircraftSerial: "1",
    aircraftModel: "Model",
    number: "PR-00001",
    requesterId: "tech",
    createdAt: 1,
    updatedAt: 1,
    cancelled: false,
    reservations: [],
    issues: [],
    history: [],
    ...fields,
  });
}

function repairLine(uuid: string, componentUuid: string) {
  return { ...partLine(), uuid, componentUuid, quantity: 1 };
}

function partLine() {
  return { uuid: "l3", partNumber: "P", description: "Part", quantity: 1 };
}

function entry(requestUuid: string) {
  return { requestUuid, at: 1, actorId: "tech", action: "save", detail: "" };
}

function storedOrder(lines: object[]) {
  return poSchema.parse({
    uuid: "po-1",
    version: 1,
    vendor: "Vendor",
    vendorContact: "",
    shipTo: "Hangar",
    expectedDate: "",
    currency: "USD",
    shippingCents: 0,
    notes: "",
    lines,
    programUuid: PROGRAM,
    number: "PO-00001",
    phase: "draft",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    shipments: [],
    receipts: [],
    history: [{ ...entry("save-1"), reason: "" }],
  });
}

function orderLine(uuid: string) {
  return {
    uuid,
    locationUuid: "store",
    partNumber: "P",
    description: "Part",
    quantity: 1,
    unitCents: 100,
    kind: "part",
  };
}

function allocation(requestUuid: string) {
  return { requestUuid, lineUuid: "l1", quantity: 1 };
}
