/**
 * Responsibility: Pins the history reads beyond pages: what one work order's
 *   history holds, and which flights a span returns, in what order.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/historyReads.ts, src/data/demo.ts (seed), src/domain
 *   schemas (work orders, job cards, costs, parts requests).
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  FLIGHT_RANGE_INVALID,
  FLIGHT_RANGE_TOO_LONG,
  MAX_RANGE_FLIGHTS,
  MAX_RECORD_LOOKUPS,
  RECORD_LOOKUP_TOO_LARGE,
  flightRange,
  lookupRecords,
  workOrderHistory,
} from "./historyReads";
import type { Discrepancy, Flight, Member, Snapshot } from "./model";
import { workOrderSchema, type WorkOrder } from "./workOrders";
import { taskCardDefaults, taskCardSchema } from "./taskCards";
import { costRecordSchema } from "./costs";
import { partsRequestSchema } from "./partsRequests";

const A = "aircraft-a";
const B = "aircraft-b";
const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 15, 12);

describe("workOrderHistory", () => {
  const order = workOrder("order");
  const other = workOrder("other");
  const s = snapshotOf({
    workOrders: [other, order],
    taskCards: [card("card", order.uuid), card("other-card", other.uuid)],
    archivedTaskCards: [card("archived", order.uuid)],
    costs: [
      cost("cost", order.uuid),
      cost("other-cost", other.uuid),
      costRecordSchema.parse({
        uuid: id("budget"),
        version: 1,
        programUuid: "demo-program",
        kind: "budget",
        aircraftUuid: A,
        year: 2024,
        amountCents: 100,
      }),
    ],
    taskEvidence: [
      evidence("on-card", "card"),
      evidence("on-archived", "archived"),
      evidence("elsewhere", "other-card"),
    ],
    workOrderAttachments: [attachment("file", order.uuid)],
    partsRequests: [
      request("raised", order.uuid),
      request("on-card", ""),
      request("on-other-card", "", "other-card"),
    ],
  });

  it("holds the order and only what is filed on it", () => {
    const history = workOrderHistory(s, order.uuid);
    expect(history.workOrder).toBe(order);
    expect(uuids(history.taskCards)).toEqual([id("card")]);
    expect(uuids(history.archivedTaskCards)).toEqual([id("archived")]);
    expect(uuids(history.costs)).toEqual([id("cost")]);
    expect(uuids(history.taskEvidence)).toEqual(
      ["on-card", "on-archived"].map(id),
    );
    expect(uuids(history.workOrderAttachments)).toEqual([id("file")]);
    expect(uuids(history.partsRequests)).toEqual(["raised", "on-card"].map(id));
    expect(history.partsRequestPurchases).toEqual([]);
  });

  it("refuses an order the snapshot does not hold, as one that does not exist", () => {
    expect(() => workOrderHistory(s, "missing")).toThrow("History not found.");
  });
});

describe("flightRange", () => {
  const [pilot, copilot, other] = ["pilot", "copilot", "other"].map(member);
  const s = snapshotOf({
    members: [other, copilot, pilot],
    flights: [
      flight("before", T0 - 1),
      flight("from", T0),
      flight("tie-a", T0 + DAY, { copilotId: "copilot" }),
      flight("tie-b", T0 + DAY),
      flight("offset", T0 + 2 * DAY, {
        startTime: new Date(T0 + 2 * DAY).toISOString().replace("Z", "+00:00"),
      }),
      flight("to", T0 + 3 * DAY),
      flight("other-aircraft", T0 + DAY, { aircraftUuid: B }),
    ],
  });
  const range = { aircraftUuid: A, from: T0, to: T0 + 3 * DAY };

  it("returns the aircraft's flights from its start up to its end, newest first", () => {
    const { flights } = flightRange(s, range);
    expect(uuids(flights)).toEqual(["offset", "tie-b", "tie-a", "from"]);
  });

  it("names the pilots and copilots of its flights only", () => {
    expect(flightRange(s, range).members).toEqual([pilot, copilot]);
  });

  it.each([
    ["an end before the start", { from: T0, to: T0 - 1 }],
    ["an empty span", { from: T0, to: T0 }],
    ["a start that is not a time", { from: Number.NaN, to: T0 }],
  ])("refuses %s", (_, span) => {
    expect(() => flightRange(s, { ...range, ...span })).toThrow(
      FLIGHT_RANGE_INVALID,
    );
  });

  it("refuses an aircraft the snapshot does not list, as one that does not exist", () => {
    expect(() =>
      flightRange(s, { ...range, aircraftUuid: "not-listed" }),
    ).toThrow("History not found.");
  });

  it(`refuses a span of more than ${MAX_RANGE_FLIGHTS} flights`, () => {
    const many = Array.from({ length: MAX_RANGE_FLIGHTS + 1 }, (_, i) =>
      flight(`f-${i}`, T0 + i),
    );
    const full = snapshotOf({ flights: many });
    const span = { aircraftUuid: A, from: T0, to: T0 + DAY };
    expect(() => flightRange(full, span)).toThrow(FLIGHT_RANGE_TOO_LONG);
    const fits = { ...span, to: T0 + MAX_RANGE_FLIGHTS };
    expect(flightRange(full, fits).flights).toHaveLength(MAX_RANGE_FLIGHTS);
  });
});

describe("lookupRecords", () => {
  const [reporter, pilot] = ["reporter", "pilot"].map(member);
  const reportA = report("report-a");
  const archived = card("archived", id("order"));
  const s = snapshotOf({
    members: [pilot, reporter],
    discrepancies: [report("report-b"), reportA],
    taskCards: [card("live", id("order")), card("other", id("order"))],
    archivedTaskCards: [archived],
    flights: [
      flight("flown", T0, { flightPlanUuid: id("plan") }),
      flight("rejected", T0, {
        flightPlanUuid: id("plan"),
        status: "rejected",
      }),
      flight("unplanned", T0),
    ],
  });
  const none = { discrepancyUuids: [], taskCardUuids: [], flightPlanUuids: [] };

  it("finds the named reports, live and archived job cards, and plans' flights", () => {
    const found = lookupRecords(s, {
      discrepancyUuids: [reportA.uuid, "missing"],
      taskCardUuids: [id("live"), archived.uuid],
      flightPlanUuids: [id("plan")],
    });
    expect(uuids(found.discrepancies)).toEqual([reportA.uuid]);
    expect(uuids(found.taskCards)).toEqual([id("live")]);
    expect(uuids(found.archivedTaskCards)).toEqual([archived.uuid]);
    expect(uuids(found.flights)).toEqual(["flown", "rejected"]);
    expect(found.members).toEqual([pilot, reporter]);
  });

  it("finds nothing for nothing named", () => {
    expect(lookupRecords(s, none)).toEqual({
      discrepancies: [],
      taskCards: [],
      archivedTaskCards: [],
      flights: [],
      members: [],
      partsRequests: [],
      purchaseOrders: [],
      partsRequestPurchases: [],
    });
  });

  it(`refuses more than ${MAX_RECORD_LOOKUPS} uuids`, () => {
    const many = Array.from({ length: MAX_RECORD_LOOKUPS }, (_, i) => `u-${i}`);
    expect(() =>
      lookupRecords(s, { ...none, discrepancyUuids: many }),
    ).not.toThrow();
    expect(() =>
      lookupRecords(s, {
        ...none,
        discrepancyUuids: many,
        taskCardUuids: ["x"],
      }),
    ).toThrow(RECORD_LOOKUP_TOO_LARGE);
  });
});

function snapshotOf(records: Partial<Snapshot>): Snapshot {
  const demo = demoSnapshot();
  const aircraft = [A, B].map((uuid) => ({ ...demo.aircraft[0], uuid }));
  return { ...demo, aircraft, flights: [], discrepancies: [], ...records };
}

function uuids(rows: { uuid: string }[]) {
  return rows.map((r) => r.uuid);
}

// Schema-checked records need real uuids; each derives from its name.
function id(name: string) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `00000000-0000-4000-8000-${hash.toString(16).padStart(12, "0")}`;
}

function member(id: string): Member {
  return { ...demoSnapshot().members[1], id, name: `Name of ${id}` };
}

function flight(
  uuid: string,
  start: number,
  overrides: Partial<Flight> = {},
): Flight {
  return {
    uuid,
    aircraftUuid: A,
    authorId: "pilot",
    pilotId: "pilot",
    submittedAt: start,
    status: "accepted",
    startTime: new Date(start).toISOString(),
    landings: 1,
    cycles: 1,
    origin: "KCHA",
    destination: "KAVL",
    operation: "Mission",
    flightRules: "VFR",
    remarks: "",
    discrepancy: "",
    ...overrides,
  };
}

function workOrder(name: string): WorkOrder {
  return workOrderSchema.parse({
    uuid: id(name),
    version: 1,
    number: name,
    aircraftUuid: A,
    dateOpened: "2024-01-01",
    supervisor: "Chief inspector",
    scope: "100-hour inspection.",
    priority: "routine",
    status: "completed",
    completionDate: "2024-01-10",
    releaseOutcome: "Approved for return to service.",
    finalReview: "",
    recordedAt: T0,
    createdBy: "admin",
    aircraft: {
      registration: "N1",
      make: "Cessna",
      model: "206",
      serial: "1",
      totalSeconds: 0,
      hobbs: 0,
      tach: 0,
      meter: "hobbs",
      cycles: 0,
    },
    componentReadings: [],
    tasks: [],
  });
}

function card(name: string, workOrderUuid: string) {
  return taskCardSchema.parse({
    ...taskCardDefaults(A),
    uuid: id(name),
    version: 1,
    createdBy: "admin",
    createdAt: T0,
    updatedAt: T0,
    cardNumber: name,
    title: "Inspect the engine compartment",
    workOrderUuid,
    status: "completed",
    technicianSignoff: null,
    inspectionSignoff: null,
    stepSignoffs: {},
  });
}

function cost(name: string, workOrderUuid: string) {
  return costRecordSchema.parse({
    uuid: id(name),
    version: 1,
    programUuid: "demo-program",
    kind: "workOrder",
    aircraftUuid: A,
    workOrderUuid,
    labor: [],
    other: [],
    partUnitCosts: [],
  });
}

function evidence(name: string, cardName: string) {
  return {
    uuid: id(name),
    taskCardUuid: id(cardName),
    name: `${name}.pdf`,
    size: 1,
    uploadedAt: T0,
    category: "photo" as const,
  };
}

function attachment(name: string, workOrderUuid: string) {
  return {
    uuid: id(name),
    workOrderUuid,
    name: `${name}.pdf`,
    size: 1,
    uploadedAt: T0,
  };
}

// Raised on a job card, and on its work order when one is given.
function request(name: string, workOrderUuid: string, card = "card") {
  return partsRequestSchema.parse({
    uuid: id(name),
    version: 1,
    mode: "parts",
    date: "2024-01-05",
    engineer: "Mechanic",
    base: "Test Field",
    priority: "P2 Routine",
    requiredBy: "2024-01-20",
    timeframe: "",
    vendor: "Example Aviation Supply",
    vendorAddress: "1 Supply Road",
    currency: "USD",
    shipTo: "Hangar 4",
    billTo: "Hangar 4",
    shipFrom: "",
    aircraftYear: "2006",
    notes: "",
    shippingInstructions: "Ground",
    returnInstructions: "",
    programUuid: "demo-program",
    cancelled: false,
    source: { kind: "jobCard", uuid: id(card), workOrderUuid },
    lines: [
      {
        uuid: id(`${name}-line`),
        partNumber: "LT-4000",
        description: "Oil filter",
        quantity: 1,
        quotedCents: 2495,
      },
    ],
    history: [],
    aircraftUuid: A,
    sourceLabel: "JC-1",
    aircraftRegistration: "N1",
    aircraftSerial: "1",
    aircraftModel: "206",
    number: `PR-${name}`,
    requesterId: "admin",
    createdAt: T0,
    updatedAt: T0,
    reservations: [],
    issues: [],
  });
}

function report(name: string): Discrepancy {
  return {
    uuid: id(name),
    aircraftUuid: A,
    description: "Landing light flickers.",
    status: "resolved",
    authorId: "reporter",
    createdAt: T0,
    resolvedAt: T0,
    resolution: "Replaced lamp.",
  };
}
