/**
 * Responsibility: Builds the parts requests, purchase orders, flight plans
 *   and held flight that exercise each rule of the purchasing window, for
 *   one aircraft of the volume fixture.
 * Layer: Test. Fixture builder for convex-test suites; never shipped.
 * Dependencies: convex/collections.ts (codec), src/domain stored-record
 *   schemas (partsRequests, purchaseOrders, flightPlans).
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
import { flightPlanSchema } from "../../src/domain/flightPlans";

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
  "partsRequests" | "purchaseOrders" | "flightPlans" | "flights",
  Row[]
>;

/**
 * The aircraft's edges:
 * - kept requests: open; partly received on a closed order (kept with it);
 *   on a kept work order's task and on its job card, issued in full; a
 *   recurring list; issued in full but allocated to an issued order (kept);
 *   with `stockRequest`, an open one for stock on no aircraft;
 * - paged requests: a repair its closed order fulfilled; a cancelled one;
 * - kept orders besides those: closed with a core still owed; paged: a
 *   cancelled one;
 * - plans: one filed late, kept; one flown by a held flight, kept; a
 *   cancelled one, paged.
 *
 * @param a - What the edges point at.
 * @param uuid - The fixture's uuid counter, so runs store the same rows.
 */
export function purchasingEdges(a: EdgeAnchors, uuid: () => string): EdgeRows {
  const old = a.end - OLD_DAYS * DAY;
  const at = (days: number) => old + days * DAY;
  const req = (fields: Partial<PartsRequest> & { lines: Line[] }) =>
    request(a, uuid(), fields);
  const open = req({ lines: [line(uuid(), a.stock, 2)] });
  const partly = req({ lines: [line(uuid(), a.stock, 4)] });
  const onTask = issued(
    req({
      source: { kind: "workTask", uuid: uuid(), workOrderUuid: a.order.uuid },
      lines: [line(uuid(), a.stock, 1)],
    }),
    a,
  );
  const onCard = issued(
    req({
      source: { kind: "jobCard", uuid: a.order.card, workOrderUuid: "" },
      createdAt: at(70),
      lines: [line(uuid(), a.stock, 1)],
    }),
    a,
  );
  const list = req({
    recurring: true,
    source: { kind: "inspection", uuid: a.inspection, workOrderUuid: "" },
    lines: [line(uuid(), a.stock, 1)],
  });
  const ordered = issued(req({ lines: [line(uuid(), a.stock, 1)] }), a);
  const repair = req({
    mode: "repair",
    source: { kind: "component", uuid: a.component, workOrderUuid: "" },
    lines: [
      {
        ...line(uuid(), a.stock, 1),
        componentUuid: a.component,
        defect: "Rough running",
        workRequested: "Overhaul",
      },
    ],
  });
  const cancelled = req({ cancelled: true, lines: [line(uuid(), a.stock, 1)] });
  const forStock = a.stockRequest
    ? [req({ aircraftUuid: "", lines: [line(uuid(), a.stock, 3)] })]
    : [];
  const orders = [
    order(a, uuid(), {
      phase: "closed",
      lines: [poLine(uuid(), a, 4, { cancelled: 2 }, [partly, 4])],
      receivedAt: at(10),
    }),
    order(a, uuid(), {
      phase: "issued",
      lines: [poLine(uuid(), a, 2, {}, [ordered, 1])],
    }),
    order(a, uuid(), {
      phase: "closed",
      lines: [repairLine(uuid(), a, repair)],
      shippedAt: at(5),
      receivedAt: at(20),
    }),
    withCore(
      order(a, uuid(), {
        phase: "closed",
        lines: [poLine(uuid(), a, 1, { exchange: true }, undefined)],
        receivedAt: at(10),
      }),
      uuid(),
    ),
    order(a, uuid(), {
      phase: "cancelled",
      lines: [poLine(uuid(), a, 1, { cancelled: 1 }, undefined)],
    }),
  ];
  const requests = [open, partly, onTask, onCard, list, ordered, repair];
  requests.push(...forStock);
  const flown = plan(a, uuid(), { createdAt: old - DAY });
  return {
    partsRequests: [...requests, cancelled].map((r) =>
      encode("partsRequests", r),
    ),
    purchaseOrders: orders.map((p) => encode("purchaseOrders", p)),
    flightPlans: [
      plan(a, uuid(), { createdAt: a.end - 30 * DAY }),
      flown,
      plan(a, uuid(), { createdAt: old - DAY, status: "cancelled" }),
    ].map((p) => encode("flightPlans", p)),
    flights: [heldFlight(a, uuid(), flown.uuid)],
  };
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
    number: `PR-EDGE-${uuid.slice(-6)}`,
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
function order(a: EdgeAnchors, uuid: string, f: OrderFields): PurchaseOrder {
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
    number: `PO-EDGE-${uuid.slice(-6)}`,
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
  fields: { createdAt: number; status?: "proposed" | "cancelled" },
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
    sourceName: "",
    sourceHash: uuid.replace(/-/g, "").padEnd(64, "e"),
    status: fields.status ?? "proposed",
    createdAt: fields.createdAt,
  });
}

// Held for review, which keeps it, and the plan it was logged against,
// however old.
function heldFlight(a: EdgeAnchors, uuid: string, planUuid: string): Row {
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
