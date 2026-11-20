/**
 * Responsibility: Builds the parts requests, purchase orders, flight plans
 *   and held flight that exercise each rule of the purchasing window, for
 *   one aircraft of the volume fixture.
 * Layer: Test. Fixture builder for convex-test suites; never shipped.
 * Dependencies: convex/collections.ts (codec), src/domain stored-record
 *   schemas (partsRequests, purchaseOrders, flightPlans) and model (types).
 *
 * Every record is dated more than the window's 90 days before `end`, so only
 * the rule it was built for keeps it, or nothing does (ADR-0013, H5).
 */
import { encode } from "../../convex/collections";
import {
  partsRequestSchema,
  type PartsRequest,
} from "../../src/domain/partsRequests";
import { poSchema, type PurchaseOrder } from "../../src/domain/purchaseOrders";
import {
  flightPlanSchema,
  type FlightPlan,
} from "../../src/domain/flightPlans";
import type { Flight } from "../../src/domain/model";

const DAY = 86_400_000;
// Before the 90-day window and the 183-day flight window alike.
const OLD_DAYS = 200;
const HOUR = 3600;

/** The fixture's records an aircraft's edges point at. */
export interface EdgeAnchors {
  /** The newest record's time. */
  end: number;
  program: string;
  admin: string;
  pilot: string;
  aircraft: {
    uuid: string;
    registration: string;
    serial: string;
    model: string;
    currentHobbs: number;
  };
  /** A work order the window keeps, opened before the edges, and one of
   * its job cards. */
  order: { uuid: string; card: string };
  /** A component and an inspection of the aircraft. */
  component: string;
  inspection: string;
  stock: { uuid: string; locationUuid: string; partNumber: string };
  /** Adds an open request for stock, on no aircraft. */
  stockRequest?: boolean;
}

type Row = Record<string, unknown>;
/** Rows by table, as the fixture inserts them. */
export type EdgeRows = Record<
  "partsRequests" | "purchaseOrders" | "flightPlans",
  Row[]
> & { flights: Flight[] };

/**
 * The labels each edge's number (`PR-<label>-…`, `PO-<label>-…`) or plan
 * source name carries, by what the window does with it.
 * - kept requests: open; partly received on a closed order; issued in full
 *   on a kept work order's task and on its job card; a recurring list;
 *   issued in full but allocated to an issued order; for stock, open;
 * - paged requests: a repair its closed order fulfilled; a cancelled one;
 * - kept orders: the closed one a kept request was partly received on; the
 *   issued one; a closed one with a core still owed; paged: the repair's,
 *   and a cancelled one;
 * - plans: one filed late and one flown by a held flight, kept; a cancelled
 *   one, paged.
 */
export const EDGES = {
  kept: {
    requests: ["OPEN", "PARTLY", "TASK", "CARD", "LIST", "ORDERED", "STOCK"],
    orders: ["PARTLY", "ORDERED", "CORE"],
    plans: ["LATE", "FLOWN"],
  },
  paged: {
    requests: ["REPAIR", "CANCELLED"],
    orders: ["REPAIR", "CANCELLED"],
    plans: ["CANCELLED"],
  },
} as const;

/**
 * The label a request or order number carries after its "PR-" or "PO-", or
 * a plan's whole source name, to compare with {@link EDGES}.
 *
 * @param name - The number or source name.
 * @returns The leading capitals; "" when there are none.
 */
export function edgeLabel(name: string): string {
  return /^(?:P[RO]-)?([A-Z]+)(?:-|$)/.exec(name)?.[1] ?? "";
}

/** The edges as records, for a snapshot built without a database. */
export interface EdgeRecords {
  partsRequests: PartsRequest[];
  purchaseOrders: PurchaseOrder[];
  flightPlans: FlightPlan[];
  /** The held flight that flies the FLOWN plan. */
  flights: Flight[];
}

/**
 * The aircraft's edges as records, as {@link EDGES} lists them; the request
 * for stock only when `a.stockRequest` asks for it.
 *
 * @param a - What the edges point at.
 * @param uuid - A uuid counter, so runs build the same records.
 */
export function edgeRecords(a: EdgeAnchors, uuid: () => string): EdgeRecords {
  const requests = requestEdges(a, uuid);
  const purchaseOrders = orderEdges(a, uuid, requests);
  const flightPlans = planEdges(a, uuid);
  return {
    partsRequests: Object.values(requests),
    purchaseOrders,
    flightPlans,
    flights: [heldFlight(a, uuid(), flightPlans[1].uuid)],
  };
}

/**
 * The aircraft's edges as the rows the fixture inserts (encode).
 *
 * @param a - What the edges point at.
 * @param uuid - The fixture's uuid counter, so runs store the same rows.
 */
export function purchasingEdges(a: EdgeAnchors, uuid: () => string): EdgeRows {
  const edges = edgeRecords(a, uuid);
  return {
    partsRequests: edges.partsRequests.map((r) => encode("partsRequests", r)),
    purchaseOrders: edges.purchaseOrders.map((p) =>
      encode("purchaseOrders", p),
    ),
    flightPlans: edges.flightPlans.map((p) => encode("flightPlans", p)),
    flights: edges.flights,
  };
}

function requestEdges(a: EdgeAnchors, uuid: () => string) {
  const at = (days: number) => a.end - (OLD_DAYS - days) * DAY;
  const req = (label: string, fields: Partial<PartsRequest>, units = 1) =>
    request(a, uuid(), label, {
      lines: [line(uuid(), a.stock, units)],
      ...fields,
    });
  const order = { workOrderUuid: a.order.uuid };
  return {
    open: req("OPEN", {}, 2),
    partly: req("PARTLY", {}, 4),
    onTask: issued(
      req("TASK", { source: { kind: "workTask", uuid: uuid(), ...order } }),
      a,
    ),
    onCard: issued(
      req("CARD", {
        source: { kind: "jobCard", uuid: a.order.card, workOrderUuid: "" },
        createdAt: at(70),
      }),
      a,
    ),
    list: req("LIST", {
      recurring: true,
      source: { kind: "inspection", uuid: a.inspection, workOrderUuid: "" },
    }),
    ordered: issued(req("ORDERED", {}), a),
    repair: repairRequest(req("REPAIR", { mode: "repair" }), a),
    cancelled: req("CANCELLED", { cancelled: true }),
    ...(a.stockRequest && { stock: req("STOCK", { aircraftUuid: "" }, 3) }),
  };
}

// A repair of the aircraft's component, raised on the component.
function repairRequest(r: PartsRequest, a: EdgeAnchors): PartsRequest {
  return {
    ...r,
    source: { kind: "component", uuid: a.component, workOrderUuid: "" },
    lines: r.lines.map((l) => ({
      ...l,
      componentUuid: a.component,
      defect: "Rough running",
      workRequested: "Overhaul",
    })),
  };
}

function orderEdges(
  a: EdgeAnchors,
  uuid: () => string,
  r: ReturnType<typeof requestEdges>,
): PurchaseOrder[] {
  const at = (days: number) => a.end - (OLD_DAYS - days) * DAY;
  const po = (label: string, f: OrderFields) => order(a, uuid(), label, f);
  return [
    po("PARTLY", {
      phase: "closed",
      lines: [poLine(uuid(), a, 4, { cancelled: 2 }, [r.partly, 4])],
      receivedAt: at(10),
    }),
    po("ORDERED", {
      phase: "issued",
      lines: [poLine(uuid(), a, 2, {}, [r.ordered, 1])],
    }),
    po("REPAIR", {
      phase: "closed",
      lines: [repairLine(uuid(), a, r.repair)],
      shippedAt: at(5),
      receivedAt: at(20),
    }),
    withCore(
      po("CORE", {
        phase: "closed",
        lines: [poLine(uuid(), a, 1, { exchange: true }, undefined)],
        receivedAt: at(10),
      }),
      uuid(),
    ),
    po("CANCELLED", {
      phase: "cancelled",
      lines: [poLine(uuid(), a, 1, { cancelled: 1 }, undefined)],
    }),
  ];
}

// The second plan is the one the held flight flies.
function planEdges(a: EdgeAnchors, uuid: () => string) {
  const old = a.end - OLD_DAYS * DAY;
  return [
    plan(a, uuid(), { label: "LATE", createdAt: a.end - 30 * DAY }),
    plan(a, uuid(), { label: "FLOWN", createdAt: old - DAY }),
    plan(a, uuid(), {
      label: "CANCELLED",
      createdAt: old - DAY,
      status: "cancelled",
    }),
  ];
}

type Line = PartsRequest["lines"][number];
type OrderLine = PurchaseOrder["lines"][number];

function line(
  uuid: string,
  stock: EdgeAnchors["stock"],
  quantity: number,
): Line {
  return {
    uuid,
    partNumber: stock.partNumber,
    alternateNumber: "",
    description: "Oil filter",
    quantity,
    ipcReference: "",
    componentUuid: "",
    service: "repair",
    defect: "",
    workRequested: "",
    quotedCents: 2495,
  };
}

function request(
  a: EdgeAnchors,
  uuid: string,
  label: string,
  fields: Partial<PartsRequest> & { lines: Line[] },
): PartsRequest {
  const created = fields.createdAt ?? a.end - OLD_DAYS * DAY;
  return partsRequestSchema.parse({
    uuid,
    version: 2,
    source: { kind: "stock", uuid: a.stock.uuid, workOrderUuid: "" },
    mode: "parts",
    date: new Date(created).toISOString().slice(0, 10),
    engineer: "Mechanic",
    priority: "P2 Routine",
    requiredBy: "",
    currency: "USD",
    programUuid: a.program,
    aircraftUuid: a.aircraft.uuid,
    sourceLabel: a.stock.partNumber,
    aircraftRegistration: a.aircraft.registration,
    aircraftSerial: a.aircraft.serial,
    aircraftModel: a.aircraft.model,
    number: `PR-${label}-${uuid.slice(-4)}`,
    requesterId: a.admin,
    createdAt: created,
    updatedAt: created,
    cancelled: false,
    reservations: [],
    issues: [],
    history: [],
    ...fields,
  });
}

// Every line issued six days after the request, which settles it.
function issued(r: PartsRequest, a: EdgeAnchors): PartsRequest {
  const at = r.createdAt + 6 * DAY;
  return {
    ...r,
    updatedAt: at,
    issues: r.lines.map((l) => ({
      lineUuid: l.uuid,
      stockUuid: a.stock.uuid,
      quantity: l.quantity,
      at,
      actorId: a.admin,
    })),
  };
}

function poLine(
  uuid: string,
  a: EdgeAnchors,
  quantity: number,
  extra: Partial<OrderLine>,
  allocation: [PartsRequest, number] | undefined,
): OrderLine {
  const [r, units] = allocation ?? [];
  return {
    uuid,
    stockUuid: a.stock.uuid,
    locationUuid: a.stock.locationUuid,
    partNumber: a.stock.partNumber,
    description: "Oil filter",
    quantity,
    unitCents: 2495,
    kind: "part",
    componentType: "Appliance",
    manufacturer: "",
    model: "",
    inspectionUuid: "",
    aircraftUuid: a.aircraft.uuid,
    workOrderUuid: "",
    cancelled: 0,
    ...extra,
    ...(r && {
      requestAllocations: [
        { requestUuid: r.uuid, lineUuid: r.lines[0].uuid, quantity: units! },
      ],
    }),
  };
}

function repairLine(uuid: string, a: EdgeAnchors, r: PartsRequest): OrderLine {
  return {
    ...poLine(uuid, a, 1, {}, [r, 1]),
    stockUuid: "",
    kind: "component",
    repairComponentUuid: a.component,
    repairWork: "repair",
  };
}

interface OrderFields {
  phase: PurchaseOrder["phase"];
  lines: OrderLine[];
  shippedAt?: number;
  receivedAt?: number;
}

// Created with the requests, saved again at its last event.
function order(
  a: EdgeAnchors,
  uuid: string,
  label: string,
  f: OrderFields,
): PurchaseOrder {
  const created = a.end - OLD_DAYS * DAY + DAY;
  const moved = (date: number) => ({
    uuid: `${uuid.slice(0, -4)}${date % 10_000}`,
    date: new Date(date).toISOString().slice(0, 10),
    lines: f.lines.map((l) => ({ lineUuid: l.uuid, quantity: 1 })),
  });
  return poSchema.parse({
    uuid,
    version: 3,
    programUuid: a.program,
    number: `PO-${label}-${uuid.slice(-4)}`,
    vendor: "Example Aviation Supply",
    vendorContact: "orders@example.test",
    shipTo: "Hangar 4",
    expectedDate: "",
    currency: "USD",
    shippingCents: 0,
    notes: "",
    phase: f.phase,
    revision: 0,
    createdAt: created,
    updatedAt: Math.max(created, f.receivedAt ?? 0),
    ...(f.phase !== "draft" && { issuedAt: created }),
    lines: f.lines,
    shipments: f.shippedAt
      ? [{ ...moved(f.shippedAt), carrier: "UPS", tracking: "1Z" }]
      : [],
    receipts: f.receivedAt ? [receipt(moved(f.receivedAt), a, f.lines)] : [],
    history: [],
  });
}

function receipt(
  moved: { uuid: string; date: string },
  a: EdgeAnchors,
  lines: OrderLine[],
) {
  return {
    ...moved,
    invoice: "INV-EDGE",
    notes: "",
    actorId: a.admin,
    lines: lines.map((l) => ({
      lineUuid: l.uuid,
      quantity: l.repairComponentUuid ? 1 : l.quantity - l.cancelled,
      condition: "overhauled",
      itemUuids: [],
      serials: l.repairComponentUuid
        ? [{ serial: "SN-EDGE", hours: 1000, cycles: 0 }]
        : [],
    })),
  };
}

// An exchange unit received, its core not yet shipped back.
function withCore(p: PurchaseOrder, uuid: string): PurchaseOrder {
  const [l] = p.lines;
  return {
    ...p,
    coreReturns: [
      {
        uuid,
        lineUuid: l.uuid,
        receiptUuid: p.receipts[0].uuid,
        partNumber: l.partNumber,
        serial: "CORE-1",
        quantity: 1,
        dueDate: p.receipts[0].date,
        status: "pending",
        tracking: "",
        notes: "",
      },
    ],
  };
}

function plan(
  a: EdgeAnchors,
  uuid: string,
  fields: {
    label: string;
    createdAt: number;
    status?: "proposed" | "cancelled";
  },
) {
  return flightPlanSchema.parse({
    uuid,
    version: 1,
    aircraftUuid: a.aircraft.uuid,
    registration: a.aircraft.registration,
    departureAt: new Date(a.end - OLD_DAYS * DAY)
      .toISOString()
      .replace(".000Z", "Z"),
    origin: "KCHA",
    destination: "KAVL",
    alternate: "",
    durationMinutes: 60,
    cycles: 1,
    landings: 1,
    flightRules: "V",
    aircraftType: "C206",
    flightType: "G",
    speed: "N0140",
    level: "A080",
    route: "DCT",
    pilotText: "Pilot",
    equipment: "S",
    otherInformation: "",
    sourceName: fields.label,
    sourceHash: uuid.replace(/-/g, "").padEnd(64, "e"),
    status: fields.status ?? "proposed",
    createdAt: fields.createdAt,
  });
}

// Held for review, which keeps it, and the plan it was logged against,
// however old.
function heldFlight(a: EdgeAnchors, uuid: string, planUuid: string): Flight {
  const start = a.end - OLD_DAYS * DAY + HOUR * 1000;
  return {
    uuid,
    aircraftUuid: a.aircraft.uuid,
    authorId: a.pilot,
    pilotId: a.pilot,
    flightPlanUuid: planUuid,
    startTime: new Date(start).toISOString(),
    submittedAt: start + HOUR * 1000,
    status: "review",
    reviewReason: "Aircraft totals changed after this entry was started.",
    hobbsOff: a.aircraft.currentHobbs - 900 * HOUR,
    hobbsOn: a.aircraft.currentHobbs - 899 * HOUR,
    landings: 1,
    cycles: 1,
    origin: "KCHA",
    destination: "KAVL",
    operation: "Mission",
    flightRules: "VFR",
    remarks: "",
    discrepancy: "",
    fuel: { unit: "lb", start: 1800, added: 0, end: 1100 },
  };
}
