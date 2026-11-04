/**
 * Responsibility: Pins the parts-request rules the screen applies: the status
 *   list against every status a request can reach, and which selected
 *   requests become a purchase order draft.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/partsRequestRules.ts, ./partsRequests,
 *   ./management, ./rejection; src/data/demo.ts (seed).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { REQUEST_STATUSES, requestPODraft } from "./partsRequestRules";
import {
  partsRequestSchema,
  requestStatus,
  type PartsRequest,
  type RequestPurchase,
} from "./partsRequests";
import { applyManagement, type ManagedRecord } from "./management";
import { Rejection } from "./rejection";
import type { Snapshot } from "./model";

let s: Snapshot;

beforeEach(() => {
  s = demoSnapshot();
});

function request(o: Partial<PartsRequest> = {}): PartsRequest {
  const parsed = partsRequestSchema.parse({
    uuid: "r1",
    version: 1,
    source: { kind: "stock" },
    mode: "parts",
    date: "2026-11-04",
    engineer: "Sam",
    priority: "P2 Routine",
    requiredBy: "",
    vendor: "Acme",
    currency: "USD",
    lines: [
      { uuid: "l1", partNumber: "TIRE", description: "Tire", quantity: 2 },
    ],
    programUuid: "program",
    aircraftUuid: "",
    sourceLabel: "Stock",
    aircraftRegistration: "",
    aircraftSerial: "",
    aircraftModel: "",
    number: "PR-1",
    requesterId: "user",
    createdAt: 0,
    updatedAt: 0,
    cancelled: false,
    reservations: [],
    issues: [],
    history: [],
  });
  return { ...parsed, ...o };
}

function purchase(received: number, shipped = received): RequestPurchase {
  return {
    requestUuid: "r1",
    lineUuid: "l1",
    poUuid: "po",
    number: "PO-1",
    phase: "issued",
    quantity: 2,
    received,
    shipped,
    expectedDate: "",
    purchasedDate: "",
    purchasedBy: "",
  };
}

const held = (quantity: number) => [
  { lineUuid: "l1", stockUuid: "tire", quantity },
];
const issued = (quantity: number) =>
  held(quantity).map((x) => ({ ...x, at: 0, actorId: "user" }));

describe("REQUEST_STATUSES", () => {
  it("lists exactly the statuses a request can reach", () => {
    const statusOf = (r: PartsRequest, purchases: RequestPurchase[] = []) =>
      requestStatus({ ...s, partsRequestPurchases: purchases }, r);
    const reached = [
      statusOf(request({ recurring: true })),
      statusOf(request()),
      statusOf(request({ reservations: held(1) })),
      statusOf(request(), [purchase(0)]),
      statusOf(request({ mode: "repair" }), [purchase(0, 1)]),
      statusOf(request({ reservations: held(1) }), [purchase(1)]),
      statusOf(request({ issues: issued(1) })),
      statusOf(request({ issues: issued(2) })),
      statusOf(request({ cancelled: true })),
    ];
    expect(reached).toEqual([...REQUEST_STATUSES]);
  });
});

describe("requestPODraft", () => {
  it("skips cancelled requests and refuses with a Rejection", () => {
    s.partsRequests = [
      request(),
      request({ uuid: "r2", vendor: "Other", cancelled: true }),
    ];
    const draft = requestPODraft(s, ["r1", "r2"]);
    expect(draft.lines.map((l) => [l.quantity, l.requestAllocations])).toEqual([
      [2, [{ requestUuid: "r1", lineUuid: "l1", quantity: 2 }]],
    ]);
    const refuse = () => requestPODraft(s, ["r2"]);
    expect(refuse).toThrow(Rejection);
    expect(refuse).toThrow("Select an open request.");
  });

  it("takes the first request's terms; repairs return components", () => {
    s.user.isAdmin = true;
    const seed = (record: ManagedRecord) =>
      applyManagement(s, {
        action: "record.save",
        requestUuid: crypto.randomUUID(),
        reason: "Seed",
        record,
      });
    seed({
      uuid: "store",
      version: 0,
      kind: "location",
      name: "Store",
      address: "",
      contact: "",
    });
    seed({
      uuid: "tire",
      version: 0,
      kind: "stock",
      partNumber: "TIRE",
      description: "Tire",
      category: "supply",
      condition: "new",
      locationUuid: "store",
      quantity: 0,
      minimum: 0,
      alternates: "",
    });
    const inspection: PartsRequest["source"] = {
      kind: "inspection",
      uuid: "insp",
      workOrderUuid: "",
    };
    s.partsRequests = [
      request({
        requiredBy: "2026-12-01",
        shipTo: "Hangar",
        source: inspection,
      }),
      request({ uuid: "r2", shipTo: " Hangar ", mode: "repair" }),
    ];
    const draft = requestPODraft(s, ["r1", "r2"]);
    expect([draft.expectedDate, draft.shipTo]).toEqual([
      "2026-12-01",
      "Hangar",
    ]);
    expect(
      draft.lines.map((l) => [l.stockUuid, l.kind, l.inspectionUuid]),
    ).toEqual([
      ["tire", "supply", "insp"],
      ["", "component", ""],
    ]);
  });
});
