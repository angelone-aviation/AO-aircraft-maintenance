/**
 * Responsibility: The history reads beyond list pages: one work order with
 *   everything filed on it, one aircraft's flights over a span of time, and
 *   records named by uuid.
 * Layer: Domain. Pure functions over a scoped snapshot; no I/O, no React.
 * Dependencies: ./model, ./workOrders, ./taskCards, ./costs, ./partsRequests
 *   (types), ./retention (order, named members), ./auditHistory (the
 *   not-found message), ./rejection.
 *
 * The server scopes a snapshot of just the records a read loads and calls
 * the same function the demo calls on its whole scoped snapshot (ADR-0013),
 * so both answer alike for records inside and outside the window.
 */
import type { Discrepancy, Flight, Member, Snapshot } from "./model";
import type { WorkOrder, WorkOrderAttachment } from "./workOrders";
import type { TaskCard, TaskEvidence } from "./taskCards";
import type { CostRecord } from "./costs";
import type { PartsRequest } from "./partsRequests";
import {
  compareHistoryPositions,
  historyPosition,
  namedMembers,
} from "./retention";
import { HISTORY_NOT_FOUND } from "./auditHistory";
import { Rejection } from "./rejection";

/**
 * The most flights one range may hold: a year of a busy aircraft. It bounds
 * what the server reads; a longer span is asked for in parts.
 */
export const MAX_RANGE_FLIGHTS = 1000;
/** The refusal of a range whose end is not after its start. */
export const FLIGHT_RANGE_INVALID = "Choose a start time before the end time.";
/** The refusal of a range holding more than {@link MAX_RANGE_FLIGHTS}. */
export const FLIGHT_RANGE_TOO_LONG =
  "Choose a shorter span: it holds more than 1,000 flights.";

/**
 * The most uuids one lookup may name. Screens ask for the few records a form
 * or list links to, so it bounds the server's reads, not a feature.
 */
export const MAX_RECORD_LOOKUPS = 100;
/** The refusal of a lookup naming more than {@link MAX_RECORD_LOOKUPS}. */
export const RECORD_LOOKUP_TOO_LARGE = "Ask for at most 100 records at a time.";

/**
 * Records a screen names by uuid, which may be older than the workspace's
 * window: no list pages them on their own.
 */
export interface RecordLookup {
  discrepancyUuids: string[];
  /** Job cards, live or archived. */
  taskCardUuids: string[];
  /** Flight plans whose logged flights are wanted. */
  flightPlanUuids: string[];
}

/** What a {@link RecordLookup} finds. */
export interface FoundRecords {
  discrepancies: Discrepancy[];
  taskCards: TaskCard[];
  archivedTaskCards: TaskCard[];
  /** Flights logged against the plans, rejected ones included. */
  flights: Flight[];
  /** The members the reports and flights name, for their names. */
  members: Member[];
}

/** One work order with everything filed on it, as its program shows it. */
export interface WorkOrderHistory {
  workOrder: WorkOrder;
  taskCards: TaskCard[];
  archivedTaskCards: TaskCard[];
  /** Its cost records, redacted as the caller's workspace redacts them. */
  costs: CostRecord[];
  /** The files on its job cards and archived job cards. */
  taskEvidence: TaskEvidence[];
  workOrderAttachments: WorkOrderAttachment[];
  /** The parts requests raised from it. */
  partsRequests: PartsRequest[];
}

/** One aircraft's flights over a span of start instants. */
export interface FlightRangeRequest {
  aircraftUuid: string;
  /** The span's first moment, in milliseconds; included. */
  from: number;
  /** The moment after its last; excluded. */
  to: number;
}

/** The flights of a {@link FlightRangeRequest}, and the members they name. */
export interface FlightRange {
  /** Newest first, as the flight history pages them. */
  flights: Flight[];
  /** Their pilots and copilots, for the names a screen shows. */
  members: Member[];
}

/**
 * One work order and everything filed on it, whether or not the workspace's
 * window keeps it.
 *
 * @param s - The scoped snapshot, holding at least the order's records.
 * @param uuid - The work order.
 * @returns Each collection in snapshot order.
 * @throws {Rejection} "History not found." for an order the snapshot does not
 *   hold, the same whether it does not exist or the caller may not read it.
 */
export function workOrderHistory(s: Snapshot, uuid: string): WorkOrderHistory {
  const workOrder = s.workOrders?.find((w) => w.uuid === uuid);
  if (!workOrder) throw new Rejection(HISTORY_NOT_FOUND);
  const onOrder = (c: TaskCard) => c.workOrderUuid === uuid;
  const taskCards = (s.taskCards ?? []).filter(onOrder);
  const archivedTaskCards = (s.archivedTaskCards ?? []).filter(onOrder);
  const cards = new Set(
    [...taskCards, ...archivedTaskCards].map((c) => c.uuid),
  );
  return {
    workOrder,
    taskCards,
    archivedTaskCards,
    costs: (s.costs ?? []).filter(
      (c) => c.kind === "workOrder" && c.workOrderUuid === uuid,
    ),
    taskEvidence: (s.taskEvidence ?? []).filter((f) =>
      cards.has(f.taskCardUuid),
    ),
    workOrderAttachments: (s.workOrderAttachments ?? []).filter(
      (f) => f.workOrderUuid === uuid,
    ),
    partsRequests: (s.partsRequests ?? []).filter(
      (r) => r.source.workOrderUuid === uuid,
    ),
  };
}

/**
 * Checks a span before anything is read for it.
 *
 * @param request - The span; its aircraft is not checked here.
 * @throws {Rejection} {@link FLIGHT_RANGE_INVALID} unless both ends are
 *   numbers and the end is after the start.
 */
export function assertFlightRange(request: FlightRangeRequest): void {
  const { from, to } = request;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from)
    throw new Rejection(FLIGHT_RANGE_INVALID);
}

/**
 * One aircraft's flights that started within a span, whether or not the
 * workspace's window keeps them: for the paper check, the records package
 * and the flight-log import.
 *
 * @param s - The scoped snapshot, holding at least the span's flights.
 * @param request - The aircraft and the span.
 * @throws {Rejection} {@link FLIGHT_RANGE_INVALID}; "History not found." for
 *   an aircraft the snapshot does not list, as for one that does not exist;
 *   {@link FLIGHT_RANGE_TOO_LONG}.
 */
export function flightRange(
  s: Snapshot,
  request: FlightRangeRequest,
): FlightRange {
  const { aircraftUuid, from, to } = request;
  assertFlightRange(request);
  if (!s.aircraft.some((a) => a.uuid === aircraftUuid))
    throw new Rejection(HISTORY_NOT_FOUND);
  const flights = s.flights
    .filter((f) => f.aircraftUuid === aircraftUuid)
    .filter((f) => Date.parse(f.startTime) >= from)
    .filter((f) => Date.parse(f.startTime) < to)
    .sort((a, b) =>
      compareHistoryPositions(
        historyPosition("flights", a),
        historyPosition("flights", b),
      ),
    );
  if (flights.length > MAX_RANGE_FLIGHTS)
    throw new Rejection(FLIGHT_RANGE_TOO_LONG);
  return {
    flights,
    members: namedMembers(s.members, { flights, discrepancies: [] }),
  };
}

/**
 * Checks a lookup before anything is read for it.
 *
 * @param request - The uuids named.
 * @throws {Rejection} {@link RECORD_LOOKUP_TOO_LARGE} when they number more
 *   than {@link MAX_RECORD_LOOKUPS}.
 */
export function assertRecordLookup(request: RecordLookup): void {
  const named =
    request.discrepancyUuids.length +
    request.taskCardUuids.length +
    request.flightPlanUuids.length;
  if (named > MAX_RECORD_LOOKUPS) throw new Rejection(RECORD_LOOKUP_TOO_LARGE);
}

/**
 * The records a lookup names, whether or not the workspace's window keeps
 * them. A uuid the snapshot does not hold is left out, the same whether the
 * record does not exist or the caller may not read it.
 *
 * @param s - The scoped snapshot, holding at least the named records.
 * @param request - The uuids.
 * @returns Each collection in snapshot order.
 * @throws {Rejection} {@link RECORD_LOOKUP_TOO_LARGE}.
 */
export function lookupRecords(
  s: Snapshot,
  request: RecordLookup,
): FoundRecords {
  assertRecordLookup(request);
  const named = (uuids: string[]) => {
    const wanted = new Set(uuids);
    return (r: { uuid: string }) => wanted.has(r.uuid);
  };
  const plans = new Set(request.flightPlanUuids);
  const discrepancies = s.discrepancies.filter(named(request.discrepancyUuids));
  const flights = s.flights.filter(
    (f) => !!f.flightPlanUuid && plans.has(f.flightPlanUuid),
  );
  return {
    discrepancies,
    taskCards: (s.taskCards ?? []).filter(named(request.taskCardUuids)),
    archivedTaskCards: (s.archivedTaskCards ?? []).filter(
      named(request.taskCardUuids),
    ),
    flights,
    members: namedMembers(s.members, { flights, discrepancies }),
  };
}
