/**
 * Responsibility: The history retention window: which flights, problem
 *   reports, work orders, job cards, cost records, parts requests, purchase
 *   orders and flight plans the workspace keeps, and the order, cursors and
 *   pages of the older history it leaves out.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ./model, ./workOrders, ./taskCards, ./costs, ./flightPlans
 *   (types), ./partsRequests, ./purchaseOrders (types), ./purchasingWindow,
 *   ./vendors, ./programs (scopedSnapshot), ./ownerView, ./boardView,
 *   ./auditHistory (the not-found message), ./rejection.
 *
 * ADR-0013: the workspace keeps open items, recent history and the records
 * the owner portal shows; everything else stays on the server and loads page
 * by page. One rule here serves the server, the demo and the tests' oracle.
 */
import type { Discrepancy, Flight, Member, Snapshot } from "./model";
import { isOpenWorkOrder, type WorkOrder } from "./workOrders";
import { isTaskClosed, type TaskCard } from "./taskCards";
import type { CostRecord, WorkOrderCost } from "./costs";
import type { FlightPlan } from "./flightPlans";
import {
  requestMatchesSource,
  requestPurchases,
  type PartsRequest,
  type RequestPurchase,
  type RequestSource,
} from "./partsRequests";
import type { PurchaseOrder } from "./purchaseOrders";
import {
  countsToward,
  flownPlans,
  isKeptPlan,
  isKeptPurchaseOrder,
  isKeptRequest,
  planDepartedAt,
  purchasesByRequest,
  type WindowCutoffs,
} from "./purchasingWindow";
import { vendorKey } from "./vendors";
import { scopedSnapshot } from "./programs";
import { isOwnerView } from "./ownerView";
import { isBoardView } from "./boardView";
import { HISTORY_NOT_FOUND } from "./auditHistory";
import { Rejection } from "./rejection";

/**
 * Days of closed history the workspace keeps (Aaron, 19 Nov 2026, H1). It
 * bounds what the snapshot reads; older records load page by page.
 */
export const RETENTION_DAYS = 90;
/**
 * Days of flights the workspace keeps (H1): twice the 90-day utilization
 * window the due-date forecast prefers, so a quietly flown aircraft's
 * forecast can still fall back to longer history.
 */
export const FLIGHT_RETENTION_DAYS = 183;
/**
 * Completed work orders kept per aircraft whatever their age: the owner
 * portal's "Recently completed work" lists this many and reads only the
 * workspace.
 */
export const RECENT_COMPLETED_WORK_ORDERS = 5;
/** History rows a screen asks for per page. */
export const HISTORY_PAGE_SIZE = 50;
/** The most history rows one page request may return. */
export const MAX_HISTORY_PAGE_SIZE = 100;

const DAY_MS = 86_400_000;
// The mean Gregorian month, 365.25 / 12 days.
const DAYS_PER_MONTH = 30.4375;
const INVALID_CURSOR = "Invalid history cursor.";

/** The snapshot collections the window applies to. */
export interface HistoryRecords {
  flights: Flight[];
  discrepancies: Discrepancy[];
  workOrders: WorkOrder[];
  taskCards: TaskCard[];
  archivedTaskCards: TaskCard[];
  costs: CostRecord[];
  flightPlans: FlightPlan[];
  partsRequests: PartsRequest[];
  purchaseOrders: PurchaseOrder[];
  /** The requests' purchase-order allocations, which follow their request:
   * a non-administrator sees these, never the orders. */
  partsRequestPurchases: RequestPurchase[];
}

/** The lists that page older history. */
export type HistoryKind =
  | "flights"
  | "discrepancies"
  | "workOrders"
  | "partsRequests"
  | "purchaseOrders"
  | "flightPlans";

/** The row each list pages. */
export interface HistoryRows {
  flights: Flight;
  discrepancies: Discrepancy;
  workOrders: WorkOrder;
  partsRequests: PartsRequest;
  purchaseOrders: PurchaseOrder;
  flightPlans: FlightPlan;
}

/** Each list's sort key: see {@link historyPosition}. */
interface HistoryKeys {
  flights: number;
  discrepancies: number;
  workOrders: string;
  partsRequests: number;
  purchaseOrders: number;
  flightPlans: number;
}

/** Where a row sits in its list: its sort key, then its uuid. */
export type HistoryPosition<K extends HistoryKind = HistoryKind> = [
  key: HistoryKeys[K],
  uuid: string,
];

interface PageBase {
  /** The previous page's `continueCursor`; null for the first page. */
  cursor: string | null;
  /** Rows of `kind` wanted, bounded by {@link historyPageSize}. */
  numItems: number;
}

interface AircraftPage extends PageBase {
  /** One aircraft, or every aircraft in the snapshot when absent. */
  aircraftUuid?: string;
}

/**
 * One request for the next page of a list's older history. Parts requests
 * may be narrowed to one record's (requestMatchesSource), and purchase
 * orders, which belong to no aircraft, to one vendor (vendorKey).
 */
export type HistoryPageRequest =
  | (AircraftPage & { kind: "flights"; status?: Flight["status"] })
  | (AircraftPage & { kind: "discrepancies" | "workOrders" | "flightPlans" })
  | (AircraftPage & { kind: "partsRequests"; source?: RequestSource })
  | (PageBase & { kind: "purchaseOrders"; vendor?: string });

/** One page of older history, and where the next one starts. */
export interface HistoryPage {
  /** The page's rows of the requested kind, grouped in page order with what
   * follows them: a work order its job cards, archived job cards and cost
   * record; a parts request its purchase allocations; a flight plan the
   * flights logged against it. Other collections are empty. */
  records: HistoryRecords;
  /** The members the rows name ({@link namedMembers}), for their names. */
  members: Member[];
  /** True when no older row of the kind is left after this page. */
  isDone: boolean;
  /** Where the next page starts; the request's cursor on an empty page. */
  continueCursor: string | null;
}

/** What else decides whether the window keeps a closed work order. */
export interface WorkOrderContext {
  /** The order's job cards, archived job cards and cost records. */
  taskCards: TaskCard[];
  archivedTaskCards: TaskCard[];
  costs: CostRecord[];
  /** Its aircraft's {@link recentCompletionFloor}. */
  recentFloor: string | undefined;
}

/**
 * The window's first moment: `days` before `now`, rounded down to the start
 * of that UTC day.
 *
 * Rounding down only ever widens the window, and it fixes the cutoff for a
 * whole day, so the server, the demo and a device agree on any one day. A
 * later computation's cutoff is never earlier than an older one's, so a
 * record leaving the window shows in the older copy of the workspace and in
 * the newer history pages (an overlap, joined by uuid), never in neither.
 *
 * @param now - The current time, in milliseconds.
 * @param days - The window's length in days.
 * @returns Milliseconds at 00:00 UTC.
 */
export function retentionCutoff(now: number, days: number): number {
  return Math.floor((now - days * DAY_MS) / DAY_MS) * DAY_MS;
}

/**
 * Narrows a full snapshot's history to what the workspace keeps.
 *
 * - Flights: held for review, or started or submitted within
 *   {@link FLIGHT_RETENTION_DAYS}.
 * - Problem reports: open, or created, resolved or deferred within
 *   {@link RETENTION_DAYS}.
 * - Work orders: open; holding an open job card; opened, closed, revised,
 *   corrected or with a job card or cost entry changed within
 *   {@link RETENTION_DAYS}; or among the {@link RECENT_COMPLETED_WORK_ORDERS}
 *   latest completed on their aircraft, ties included.
 * - Job cards, archived job cards and work-order costs follow their work
 *   order; templates, cards of no loaded order, budgets and the labor rate
 *   stay.
 * - Parts requests: recurring lists; open; changed within
 *   {@link RETENTION_DAYS}; counted by a kept work order; or allocated to a
 *   draft or issued purchase order. Their purchase allocations follow them.
 * - Purchase orders: open (cores and repairs outstanding included), changed
 *   within {@link RETENTION_DAYS}, or allocating a kept request.
 * - Flight plans: departing within {@link FLIGHT_RETENTION_DAYS} or later,
 *   created within {@link RETENTION_DAYS}, or flown by a kept flight.
 *
 * @param s - The full (scoped) snapshot.
 * @param now - The current time, in milliseconds.
 * @returns The snapshot with only kept records in those collections, each in
 *   its original order; every other field, and any collection the snapshot
 *   lacks, as it was.
 */
export function retainedSnapshot(s: Snapshot, now: number): Snapshot {
  const { retained: r } = partition(s, now);
  return {
    ...s,
    flights: r.flights,
    discrepancies: r.discrepancies,
    ...(s.workOrders && { workOrders: r.workOrders }),
    ...(s.taskCards && { taskCards: r.taskCards }),
    ...(s.archivedTaskCards && { archivedTaskCards: r.archivedTaskCards }),
    ...(s.costs && { costs: r.costs }),
    ...(s.flightPlans && { flightPlans: r.flightPlans }),
    ...(s.partsRequests && { partsRequests: r.partsRequests }),
    ...(s.purchaseOrders && { purchaseOrders: r.purchaseOrders }),
    ...(s.partsRequestPurchases && {
      partsRequestPurchases: r.partsRequestPurchases,
    }),
  };
}

/**
 * The workspace a caller gets of their program: `full` scoped as
 * scopedSnapshot scopes it, with history narrowed to the window.
 *
 * The window is judged on the caller's scoped records, as historyPage judges
 * pages: a non-administrator's cost records carry no other costs, so an
 * order changed in the window only by one is older history for them. The
 * kept records are then scoped again, so members named only on older
 * flights leave with those flights. An owner's or board member's view holds
 * no job cards or cost entries to judge by, and its whitelist strips the
 * fields the window reads, so it is judged before scoping.
 *
 * Purchase orders are judged on the program's orders, not the caller's: a
 * non-administrator sees none, yet their requests' purchases and the parts
 * on order derive from them, so the orders kept for the caller's requests
 * stay until the last scoping turns them into those.
 *
 * @param full - The caller's program, unscoped: a whole-history load, or one
 *   holding every record the window keeps and all that decides it.
 * @param now - The current time, in milliseconds.
 * @param today - The program's local date, for a board member's periods.
 * @returns The scoped snapshot with only kept records in the windowed
 *   collections, each in its original order.
 */
export function workspaceWindow(
  full: Snapshot,
  now: number,
  today?: string,
): Snapshot {
  if (isOwnerView(full) || isBoardView(full))
    return scopedSnapshot(retainedSnapshot(full, now), today);
  const kept = retainedSnapshot(scopedSnapshot(full), now);
  const requests = new Set((kept.partsRequests ?? []).map((r) => r.uuid));
  const { closed } = windowCutoffs(now);
  const purchaseOrders = full.purchaseOrders?.filter((p) =>
    isKeptPurchaseOrder(p, requests, closed),
  );
  return scopedSnapshot(onlyKept(full, { ...kept, purchaseOrders }));
}

/**
 * The window's cutoffs at a moment.
 *
 * @param now - The current time, in milliseconds.
 * @returns The closed-history cutoff ({@link RETENTION_DAYS}) and the flight
 *   cutoff ({@link FLIGHT_RETENTION_DAYS}), as {@link retentionCutoff}
 *   rounds them.
 */
export function windowCutoffs(now: number): WindowCutoffs {
  return {
    closed: retentionCutoff(now, RETENTION_DAYS),
    flights: retentionCutoff(now, FLIGHT_RETENTION_DAYS),
  };
}

/**
 * The next page of a list's history that {@link retainedSnapshot} leaves
 * out, in {@link historyPosition} order. Paging from the first page to
 * `isDone` returns every left-out row of the kind once, and with work orders
 * every left-out job card and cost record.
 *
 * @param s - The full (scoped) snapshot.
 * @param request - The list, its filters, cursor and page size.
 * @param now - The current time, in milliseconds.
 * @returns The page; its cursor stays valid when newer records arrive.
 * @throws {Rejection} "History not found." for an aircraft the snapshot does
 *   not list, the same as for one that does not exist.
 * @throws {Error} "Invalid history cursor." for a cursor this list did not
 *   return.
 */
export function historyPage(
  s: Snapshot,
  request: HistoryPageRequest,
  now: number,
): HistoryPage {
  const aircraftUuid = "aircraftUuid" in request && request.aircraftUuid;
  if (aircraftUuid && !s.aircraft.some((a) => a.uuid === aircraftUuid))
    throw new Rejection(HISTORY_NOT_FOUND);
  const page = pageRecords(s, partition(s, now).older, request);
  return { ...page, members: namedMembers(s.members, page.records) };
}

/**
 * The page size a request gets.
 *
 * @param numItems - The size asked for.
 * @returns A whole number from 1 to {@link MAX_HISTORY_PAGE_SIZE}; 1 for a
 *   size that is not a number.
 */
export function historyPageSize(numItems: number): number {
  return Math.min(
    MAX_HISTORY_PAGE_SIZE,
    Math.max(1, Math.floor(numItems) || 1),
  );
}

/**
 * Where a row sits in its list. Lists run newest first: flights by start
 * instant (the `startedAt` column: the stored text keeps the pilot's offset
 * and does not sort by instant), reports, parts requests and purchase orders
 * by creation, work orders by completion date ("" for a cancelled order
 * without one, last), flight plans by departure instant; equal keys by uuid,
 * highest first. Each order is an index range on the server: per aircraft
 * ([aircraftUuid, startedAt, uuid]; [aircraftUuid, status, createdAt, uuid];
 * [aircraftUuid, status, completionDate, uuid]; [aircraftUuid, departedAt,
 * uuid]), per program and aircraft for requests ([programUuid,
 * aircraftUuid, createdAt, uuid]) and per program for orders
 * ([programUuid, createdAt, uuid]).
 *
 * @param kind - The list.
 * @param row - One of its rows.
 * @returns The row's key and uuid.
 */
export function historyPosition<K extends HistoryKind>(
  kind: K,
  row: HistoryRows[K],
): HistoryPosition<K> {
  const key = POSITION_KEYS[kind] as (row: HistoryRows[K]) => HistoryKeys[K];
  return [key(row), row.uuid];
}

/**
 * The position every row the window leaves out comes after: no flight
 * started, plan departing, report, request or order created, or work order
 * completed on or after the cutoff's day is older history.
 *
 * @param kind - The list.
 * @param now - The current time, in milliseconds.
 * @returns The cutoff as the key, with an empty uuid, which sorts after
 *   every row of that key.
 */
export function historyStart<K extends HistoryKind>(
  kind: K,
  now: number,
): HistoryPosition<K>;
export function historyStart(kind: HistoryKind, now: number): HistoryPosition {
  const { closed, flights } = windowCutoffs(now);
  if (kind === "flights" || kind === "flightPlans") return [flights, ""];
  if (kind !== "workOrders") return [closed, ""];
  return [new Date(closed).toISOString().slice(0, 10), ""];
}

/**
 * Orders two positions as their list does.
 *
 * @param a - One position.
 * @param b - The other, of the same list.
 * @returns Negative when `a` comes first, positive when `b` does, 0 when
 *   they are equal.
 */
export function compareHistoryPositions(
  [ak, au]: HistoryPosition,
  [bk, bu]: HistoryPosition,
): number {
  if (ak !== bk) return ak > bk ? -1 : 1;
  if (au !== bu) return au > bu ? -1 : 1;
  return 0;
}

/**
 * The Work orders screen's order: open orders first, newest opened first,
 * then closed orders in {@link historyPosition} order, so older pages
 * continue the list where the workspace's closed orders end. Equal keys go
 * by uuid, highest first.
 *
 * @param a - One order.
 * @param b - The other.
 * @returns Negative when `a` comes first, as Array.prototype.sort expects.
 */
export function compareWorkOrderList(a: WorkOrder, b: WorkOrder): number {
  const open = Number(isOpenWorkOrder(b)) - Number(isOpenWorkOrder(a));
  if (open) return open;
  if (isOpenWorkOrder(a))
    return compareHistoryPositions(
      [a.recordedAt, a.uuid],
      [b.recordedAt, b.uuid],
    );
  return compareHistoryPositions(
    historyPosition("workOrders", a),
    historyPosition("workOrders", b),
  );
}

/**
 * How many months of a list the workspace keeps, as a screen names them:
 * {@link FLIGHT_RETENTION_DAYS} reads as 6 (flights, and the plans they
 * fly), {@link RETENTION_DAYS} as 3.
 *
 * @param kind - The list.
 * @returns The window's days in whole months, rounded.
 */
export function historyWindowMonths(kind: HistoryKind): number {
  const flown = kind === "flights" || kind === "flightPlans";
  const days = flown ? FLIGHT_RETENTION_DAYS : RETENTION_DAYS;
  return Math.round(days / DAYS_PER_MONTH);
}

/**
 * The cursor naming a position: the next page starts after it.
 *
 * @param position - The last row's position on a page, or where a scan
 *   stopped.
 * @returns Opaque text that {@link readHistoryCursor} reads back.
 */
export function historyCursor(position: HistoryPosition): string {
  return JSON.stringify(position);
}

/**
 * Reads a cursor of one list.
 *
 * @param kind - The list the cursor must belong to.
 * @param cursor - The previous page's `continueCursor`.
 * @returns The position; undefined for null, the first page.
 * @throws {Error} "Invalid history cursor." for text {@link historyCursor}
 *   did not write for this list's key type.
 */
export function readHistoryCursor<K extends HistoryKind>(
  kind: K,
  cursor: string | null,
): HistoryPosition<K> | undefined {
  if (cursor === null) return undefined;
  const keyType = kind === "workOrders" ? "string" : "number";
  const position = readJson(cursor);
  if (
    !Array.isArray(position) ||
    position.length !== 2 ||
    typeof position[0] !== keyType ||
    typeof position[1] !== "string"
  )
    throw new Error(INVALID_CURSOR);
  return [position[0], position[1]] as HistoryPosition<K>;
}

/**
 * Whether the window leaves a flight out: it is not held for review, and
 * neither started nor was submitted within {@link FLIGHT_RETENTION_DAYS}. A
 * held flight is open until an administrator reviews it, and a flight synced
 * late (an old leg logged offline) is recent history even if it flew earlier.
 *
 * @param f - The flight.
 * @param now - The current time, in milliseconds.
 */
export function isOlderFlight(f: Flight, now: number): boolean {
  const cutoff = retentionCutoff(now, FLIGHT_RETENTION_DAYS);
  return (
    f.status !== "review" &&
    Date.parse(f.startTime) < cutoff &&
    f.submittedAt < cutoff
  );
}

/**
 * Whether the window leaves a problem report out: it is resolved, and was
 * neither created, resolved nor deferred within {@link RETENTION_DAYS}.
 *
 * @param d - The report.
 * @param now - The current time, in milliseconds.
 */
export function isOlderReport(d: Discrepancy, now: number): boolean {
  if (d.status === "open") return false;
  const changed = [d.createdAt, d.resolvedAt ?? 0, d.deferral?.deferredAt ?? 0];
  return Math.max(...changed) < retentionCutoff(now, RETENTION_DAYS);
}

/**
 * Whether the window leaves a work order out: it is closed, holds no open
 * job card, is not among its aircraft's latest completed, and neither it nor
 * a job card or cost entry of it changed within {@link RETENTION_DAYS}.
 *
 * With an empty context it can only say true more often: job cards and costs
 * only add reasons to keep an order, so false then is final.
 *
 * @param w - The order.
 * @param context - Its job cards, archived job cards and costs, and its
 *   aircraft's recent-completion floor.
 * @param now - The current time, in milliseconds.
 */
export function isOlderWorkOrder(
  w: WorkOrder,
  context: WorkOrderContext,
  now: number,
): boolean {
  const { recentFloor } = context;
  if (isOpenWorkOrder(w)) return false;
  if (context.taskCards.some((c) => !isTaskClosed(c))) return false;
  if (
    w.status === "completed" &&
    recentFloor !== undefined &&
    w.completionDate >= recentFloor
  )
    return false;
  const changed = Math.max(
    workOrderActivity(w),
    latestDependentChange(context),
  );
  return changed < retentionCutoff(now, RETENTION_DAYS);
}

/**
 * The latest of a work order's own dated events: opening, close-out,
 * completion date (from its UTC midnight, for an order closed without a
 * recorded close-out), revisions, removed items and component corrections.
 * The workspace finds a closed order changed within the window by this
 * time's column.
 *
 * @param w - The order.
 * @returns Milliseconds.
 */
export function workOrderActivity(w: WorkOrder): number {
  return Math.max(
    w.recordedAt,
    w.closeout?.recordedAt ?? 0,
    w.completionDate ? Date.parse(w.completionDate) : 0,
    ...(w.revisions ?? []).map((r) => r.recordedAt),
    ...(w.archivedTasks ?? []).map((t) => t.removedAt),
    ...(w.componentCorrections ?? []).map((c) => c.recordedAt),
  );
}

/**
 * When a work order's cost record last gained a labor or other entry, the
 * entries the window dates a cost change by.
 *
 * @param c - The cost record.
 * @returns The latest entry's `createdAt`; 0 without entries.
 */
export function costEntryActivity(
  c: Pick<WorkOrderCost, "labor" | "other">,
): number {
  return Math.max(0, ...[...c.labor, ...c.other].map((e) => e.createdAt));
}

/**
 * The completion date from which an aircraft's completed work orders are
 * among its {@link RECENT_COMPLETED_WORK_ORDERS} latest, as the owner portal
 * sorts them; every order tied with the last place counts, so the portal's
 * pick is always among them.
 *
 * @param completionDates - Completion dates of the aircraft's completed
 *   orders: all of them, or at least its latest five.
 * @returns The fifth latest date, or the earliest when there are fewer;
 *   undefined for none.
 */
export function recentCompletionFloor(
  completionDates: string[],
): string | undefined {
  const latest = [...completionDates].sort().reverse();
  return latest[Math.min(latest.length, RECENT_COMPLETED_WORK_ORDERS) - 1];
}

/**
 * The members a page's rows name, for the names its screen shows.
 *
 * @param members - The members the caller may see.
 * @param records - The page's rows.
 * @returns Those of {@link namedMemberIds} that `members` holds, in that
 *   order, so it does not depend on how `members` is sorted.
 */
export function namedMembers(
  members: Member[],
  records: Pick<HistoryRecords, "flights" | "discrepancies">,
): Member[] {
  const byId = new Map(members.map((m) => [m.id, m]));
  return namedMemberIds(records).flatMap((id) => byId.get(id) ?? []);
}

/**
 * The ids of the members rows name: flights' pilots and copilots, and
 * reports' authors and resolvers.
 *
 * @param records - The rows.
 * @returns Each id once, in row order.
 */
export function namedMemberIds(
  records: Pick<HistoryRecords, "flights" | "discrepancies">,
): string[] {
  const ids = [
    ...records.flights.flatMap((f) => [f.pilotId, f.copilotId]),
    ...records.discrepancies.flatMap((d) => [d.authorId, d.resolvedBy]),
  ];
  return [...new Set(ids.filter((id) => id !== undefined))];
}

/**
 * History records with every collection empty, for a page to fill.
 *
 * @returns A new object each call.
 */
export function emptyHistoryRecords(): HistoryRecords {
  return {
    flights: [],
    discrepancies: [],
    workOrders: [],
    taskCards: [],
    archivedTaskCards: [],
    costs: [],
    flightPlans: [],
    partsRequests: [],
    purchaseOrders: [],
    partsRequestPurchases: [],
  };
}

/**
 * Each job card's work order, archived cards included: what a request on a
 * card counts toward (countsToward).
 *
 * @param records - The job cards and archived job cards.
 * @returns Card uuid to work order uuid.
 */
export function cardWorkOrders(
  records: Pick<HistoryRecords, "taskCards" | "archivedTaskCards">,
): Map<string, string> {
  return new Map(
    [...records.taskCards, ...records.archivedTaskCards].map((c) => [
      c.uuid,
      c.workOrderUuid,
    ]),
  );
}

const POSITION_KEYS: {
  [K in HistoryKind]: (row: HistoryRows[K]) => HistoryKeys[K];
} = {
  flights: (f) => Date.parse(f.startTime),
  discrepancies: (d) => d.createdAt,
  workOrders: (w) => w.completionDate,
  partsRequests: (r) => r.createdAt,
  purchaseOrders: (p) => p.createdAt,
  flightPlans: planDepartedAt,
};

type Sides = {
  [K in keyof HistoryRecords]: [HistoryRecords[K], HistoryRecords[K]];
};

// Every windowed record lands on exactly one side.
function partition(s: Snapshot, now: number) {
  const all = windowedRecords(s);
  const contextOf = workOrderContexts(all);
  const older = new Set(
    all.workOrders
      .filter((w) => isOlderWorkOrder(w, contextOf(w), now))
      .map((w) => w.uuid),
  );
  const loaded = new Set(all.workOrders.map((w) => w.uuid));
  const follows = (workOrderUuid: string) =>
    !loaded.has(workOrderUuid) || !older.has(workOrderUuid);
  const flights = split(all.flights, (f) => !isOlderFlight(f, now));
  const keptOrders = new Set([...loaded].filter((w) => !older.has(w)));
  const sides: Sides = {
    flights,
    discrepancies: split(all.discrepancies, (d) => !isOlderReport(d, now)),
    workOrders: split(all.workOrders, (w) => !older.has(w.uuid)),
    taskCards: split(all.taskCards, (c) => follows(c.workOrderUuid)),
    archivedTaskCards: split(all.archivedTaskCards, (c) =>
      follows(c.workOrderUuid),
    ),
    costs: split(
      all.costs,
      (c) => c.kind !== "workOrder" || follows(c.workOrderUuid),
    ),
    ...purchasingSides(s, all, keptOrders, now),
    flightPlans: split(all.flightPlans, (p) =>
      isKeptPlan(p, flownPlans(flights[0]), windowCutoffs(now)),
    ),
  };
  return { retained: pick(sides, 0), older: pick(sides, 1) };
}

// Requests first: the orders kept for them, and their allocations, follow.
function purchasingSides(
  s: Snapshot,
  all: HistoryRecords,
  keptOrders: ReadonlySet<string>,
  now: number,
): Pick<Sides, "partsRequests" | "purchaseOrders" | "partsRequestPurchases"> {
  const { closed } = windowCutoffs(now);
  const purchases = purchasesByRequest(all.partsRequestPurchases);
  const cards = cardWorkOrders(all);
  const requests = split(all.partsRequests, (r) =>
    isKeptRequest(
      s,
      r,
      {
        purchases: purchases.get(r.uuid) ?? [],
        countsTowardKeptWork: countsToward(r, keptOrders, cards),
      },
      closed,
    ),
  );
  const kept = new Set(requests[0].map((r) => r.uuid));
  return {
    partsRequests: requests,
    partsRequestPurchases: split(all.partsRequestPurchases, (a) =>
      kept.has(a.requestUuid),
    ),
    purchaseOrders: split(all.purchaseOrders, (p) =>
      isKeptPurchaseOrder(p, kept, closed),
    ),
  };
}

// A scoped snapshot carries its requests' allocations; a whole load derives
// them from its orders, as scopedSnapshot would.
function windowedRecords(s: Snapshot): HistoryRecords {
  return {
    flights: s.flights,
    discrepancies: s.discrepancies,
    workOrders: s.workOrders ?? [],
    taskCards: s.taskCards ?? [],
    archivedTaskCards: s.archivedTaskCards ?? [],
    costs: s.costs ?? [],
    flightPlans: s.flightPlans ?? [],
    partsRequests: s.partsRequests ?? [],
    purchaseOrders: s.purchaseOrders ?? [],
    partsRequestPurchases:
      s.partsRequestPurchases ?? requestPurchases(s.purchaseOrders ?? []),
  };
}

function split<T>(rows: T[], keep: (row: T) => boolean): [T[], T[]] {
  return [rows.filter(keep), rows.filter((row) => !keep(row))];
}

function pick(sides: Sides, side: 0 | 1): HistoryRecords {
  const picked = emptyHistoryRecords();
  for (const name of Object.keys(picked) as (keyof HistoryRecords)[])
    Object.assign(picked, { [name]: sides[name][side] });
  return picked;
}

// Each order's job cards, archived job cards and cost records, grouped once,
// and its aircraft's floor among every completed order loaded.
function workOrderContexts(all: HistoryRecords) {
  const cards = groupByOrder(all.taskCards);
  const archived = groupByOrder(all.archivedTaskCards);
  const costs = groupByOrder(
    all.costs.flatMap((c) => (c.kind === "workOrder" ? [c] : [])),
  );
  const dates = new Map<string, string[]>();
  for (const w of all.workOrders.filter((o) => o.status === "completed"))
    dates.set(w.aircraftUuid, [
      ...(dates.get(w.aircraftUuid) ?? []),
      w.completionDate,
    ]);
  return (w: WorkOrder): WorkOrderContext => ({
    taskCards: cards.get(w.uuid) ?? [],
    archivedTaskCards: archived.get(w.uuid) ?? [],
    costs: costs.get(w.uuid) ?? [],
    recentFloor: recentCompletionFloor(dates.get(w.aircraftUuid) ?? []),
  });
}

function groupByOrder<T extends { workOrderUuid: string }>(rows: T[]) {
  const byOrder = new Map<string, T[]>();
  for (const row of rows)
    byOrder.set(row.workOrderUuid, [
      ...(byOrder.get(row.workOrderUuid) ?? []),
      row,
    ]);
  return byOrder;
}

// The latest change to an order's job cards and cost entries.
function latestDependentChange(context: WorkOrderContext): number {
  const cards = [...context.taskCards, ...context.archivedTaskCards];
  return Math.max(
    0,
    ...cards.map((c) => c.updatedAt),
    ...context.costs.map((c) =>
      c.kind === "workOrder" ? costEntryActivity(c) : 0,
    ),
  );
}

// The full snapshot's windowed collections, cut to the records `kept` holds;
// a collection the full snapshot lacks stays absent.
function onlyKept(full: Snapshot, kept: Snapshot): Snapshot {
  const ofKept = <T extends { uuid: string }>(
    rows: T[] | undefined,
    held: { uuid: string }[] | undefined,
  ) => {
    const uuids = new Set((held ?? []).map((r) => r.uuid));
    return rows?.filter((r) => uuids.has(r.uuid));
  };
  return {
    ...full,
    flights: ofKept(full.flights, kept.flights) ?? [],
    discrepancies: ofKept(full.discrepancies, kept.discrepancies) ?? [],
    workOrders: ofKept(full.workOrders, kept.workOrders),
    taskCards: ofKept(full.taskCards, kept.taskCards),
    archivedTaskCards: ofKept(full.archivedTaskCards, kept.archivedTaskCards),
    costs: ofKept(full.costs, kept.costs),
    flightPlans: ofKept(full.flightPlans, kept.flightPlans),
    partsRequests: ofKept(full.partsRequests, kept.partsRequests),
    purchaseOrders: ofKept(full.purchaseOrders, kept.purchaseOrders),
  };
}

function pageRecords(
  s: Snapshot,
  older: HistoryRecords,
  request: HistoryPageRequest,
) {
  const { kind } = request;
  if (kind === "flights") {
    const { status } = request;
    const flights = older.flights.filter((f) => !status || f.status === status);
    return listPage(kind, onAircraft(flights, request), request, (flights) => ({
      flights,
    }));
  }
  if (kind === "partsRequests") return requestPage(s, older, request);
  if (kind === "purchaseOrders") return orderPage(older, request);
  if (kind === "flightPlans")
    return listPage(
      kind,
      onAircraft(older.flightPlans, request),
      request,
      (p) => withFlights(older, p),
    );
  if (kind === "discrepancies")
    return listPage(
      kind,
      onAircraft(older.discrepancies, request),
      request,
      (d) => ({
        discrepancies: d,
      }),
    );
  return listPage(kind, onAircraft(older.workOrders, request), request, (w) =>
    withDependents(older, w),
  );
}

function orderPage(
  older: HistoryRecords,
  request: Extract<HistoryPageRequest, { kind: "purchaseOrders" }>,
) {
  const { vendor } = request;
  const orders = older.purchaseOrders.filter(
    (p) => vendor === undefined || vendorKey(p.vendor) === vendorKey(vendor),
  );
  return listPage("purchaseOrders", orders, request, (purchaseOrders) => ({
    purchaseOrders,
  }));
}

// One list's page of rows, with what follows the rows.
function listPage<K extends HistoryKind>(
  kind: K,
  rows: HistoryRows[K][],
  request: PageBase,
  follow: (rows: HistoryRows[K][]) => Partial<HistoryRecords>,
) {
  const { rows: page, ...rest } = pageOf(kind, rows, request);
  return { ...rest, records: { ...emptyHistoryRecords(), ...follow(page) } };
}

function onAircraft<T extends { aircraftUuid: string }>(
  rows: T[],
  { aircraftUuid }: AircraftPage,
): T[] {
  return rows.filter((r) => !aircraftUuid || r.aircraftUuid === aircraftUuid);
}

// A record's requests are those requestMatchesSource finds in the whole
// snapshot, through recurring lists and work items as on the record's list.
function requestPage(
  s: Snapshot,
  older: HistoryRecords,
  request: Extract<HistoryPageRequest, { kind: "partsRequests" }>,
) {
  const { source } = request;
  const requests = onAircraft(older.partsRequests, request).filter(
    (r) => !source || requestMatchesSource(s, r, source),
  );
  return listPage("partsRequests", requests, request, (partsRequests) => {
    const uuids = new Set(partsRequests.map((r) => r.uuid));
    const partsRequestPurchases = older.partsRequestPurchases.filter((a) =>
      uuids.has(a.requestUuid),
    );
    return { partsRequests, partsRequestPurchases };
  });
}

// Each plan's flights, in the snapshot's order: a plan the window leaves out
// was flown by no flight it keeps, so its flights are older too.
function withFlights(
  older: HistoryRecords,
  flightPlans: FlightPlan[],
): Partial<HistoryRecords> {
  const uuids = new Set(flightPlans.map((p) => p.uuid));
  const flights = older.flights.filter(
    (f) => !!f.flightPlanUuid && uuids.has(f.flightPlanUuid),
  );
  return { flightPlans, flights };
}

function pageOf<K extends HistoryKind>(
  kind: K,
  rows: HistoryRows[K][],
  request: PageBase,
) {
  const from = readHistoryCursor(kind, request.cursor);
  const listed = rows
    .map((row): [HistoryRows[K], HistoryPosition] => [
      row,
      historyPosition(kind, row),
    ])
    .filter(([, at]) => !from || compareHistoryPositions(from, at) < 0)
    .sort(([, a], [, b]) => compareHistoryPositions(a, b));
  const size = historyPageSize(request.numItems);
  const page = listed.slice(0, size);
  const last = page.at(-1);
  return {
    rows: page.map(([row]) => row),
    isDone: listed.length <= size,
    continueCursor: last ? historyCursor(last[1]) : request.cursor,
  };
}

function readJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Text that is not JSON is no cursor; the caller refuses it as invalid.
    return undefined;
  }
}

// Each order's job cards, archived job cards and cost records follow it, in
// page order, as the server reads them order by order.
function withDependents(
  older: HistoryRecords,
  orders: WorkOrder[],
): Pick<
  HistoryRecords,
  "workOrders" | "taskCards" | "archivedTaskCards" | "costs"
> {
  const cards = groupByOrder(older.taskCards);
  const archived = groupByOrder(older.archivedTaskCards);
  const costs = groupByOrder(
    older.costs.flatMap((c) => (c.kind === "workOrder" ? [c] : [])),
  );
  return {
    workOrders: orders,
    taskCards: orders.flatMap((w) => cards.get(w.uuid) ?? []),
    archivedTaskCards: orders.flatMap((w) => archived.get(w.uuid) ?? []),
    costs: orders.flatMap((w) => costs.get(w.uuid) ?? []),
  };
}
