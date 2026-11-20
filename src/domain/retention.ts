/**
 * Responsibility: The history retention window: which flights, problem
 *   reports, work orders, job cards and cost records the workspace keeps, and
 *   the order, cursors and pages of the older history it leaves out.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ./model, ./workOrders, ./taskCards, ./costs (types),
 *   ./auditHistory (the not-found message), ./rejection.
 *
 * ADR-0013: the workspace keeps open items, recent history and the records
 * the owner portal shows; everything else stays on the server and loads page
 * by page. One rule here serves the server, the demo and the tests' oracle.
 */
import type { Discrepancy, Flight, Member, Snapshot } from "./model";
import { isOpenWorkOrder, type WorkOrder } from "./workOrders";
import { isTaskClosed, type TaskCard } from "./taskCards";
import type { CostRecord } from "./costs";
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
const INVALID_CURSOR = "Invalid history cursor.";

/** The snapshot collections the window applies to. */
export interface HistoryRecords {
  flights: Flight[];
  discrepancies: Discrepancy[];
  workOrders: WorkOrder[];
  taskCards: TaskCard[];
  archivedTaskCards: TaskCard[];
  costs: CostRecord[];
}

/** The lists that page older history. */
export type HistoryKind = "flights" | "discrepancies" | "workOrders";

/** The row each list pages. */
export interface HistoryRows {
  flights: Flight;
  discrepancies: Discrepancy;
  workOrders: WorkOrder;
}

/** Each list's sort key: see {@link historyPosition}. */
interface HistoryKeys {
  flights: number;
  discrepancies: number;
  workOrders: string;
}

/** Where a row sits in its list: its sort key, then its uuid. */
export type HistoryPosition<K extends HistoryKind = HistoryKind> = [
  key: HistoryKeys[K],
  uuid: string,
];

interface PageBase {
  /** One aircraft, or every aircraft in the snapshot when absent. */
  aircraftUuid?: string;
  /** The previous page's `continueCursor`; null for the first page. */
  cursor: string | null;
  /** Rows of `kind` wanted, bounded by {@link historyPageSize}. */
  numItems: number;
}

/** One request for the next page of a list's older history. */
export type HistoryPageRequest =
  | (PageBase & { kind: "flights"; status?: Flight["status"] })
  | (PageBase & { kind: "discrepancies" | "workOrders" });

/** One page of older history, and where the next one starts. */
export interface HistoryPage {
  /** The page's rows of the requested kind; a work order brings its job
   * cards, archived job cards and cost record. Other collections are empty. */
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
 *
 * @param s - The full (scoped) snapshot.
 * @param now - The current time, in milliseconds.
 * @returns The snapshot with only kept records in those collections, each in
 *   its original order; every other field, and any collection the snapshot
 *   lacks, as it was.
 */
export function retainedSnapshot(s: Snapshot, now: number): Snapshot {
  const { retained } = partition(s, now);
  return {
    ...s,
    flights: retained.flights,
    discrepancies: retained.discrepancies,
    ...(s.workOrders && { workOrders: retained.workOrders }),
    ...(s.taskCards && { taskCards: retained.taskCards }),
    ...(s.archivedTaskCards && {
      archivedTaskCards: retained.archivedTaskCards,
    }),
    ...(s.costs && { costs: retained.costs }),
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
  const { aircraftUuid } = request;
  if (aircraftUuid && !s.aircraft.some((a) => a.uuid === aircraftUuid))
    throw new Rejection(HISTORY_NOT_FOUND);
  const page = pageRecords(partition(s, now).older, request);
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
 * and does not sort by instant), reports by creation, work orders by
 * completion date ("" for a cancelled order without one, last); equal keys by
 * uuid, highest first. Each order is an index range per aircraft on the
 * server ([aircraftUuid, startedAt, uuid]; [aircraftUuid, status, createdAt,
 * uuid]; [aircraftUuid, status, completionDate, uuid]).
 *
 * @param kind - The list.
 * @param row - One of its rows.
 * @returns The row's key and uuid.
 */
export function historyPosition<K extends HistoryKind>(
  kind: K,
  row: HistoryRows[K],
): HistoryPosition<K>;
export function historyPosition(
  kind: HistoryKind,
  row: HistoryRows[HistoryKind],
): HistoryPosition {
  if (kind === "flights")
    return [Date.parse((row as Flight).startTime), row.uuid];
  if (kind === "discrepancies")
    return [(row as Discrepancy).createdAt, row.uuid];
  return [(row as WorkOrder).completionDate, row.uuid];
}

/**
 * The position every row the window leaves out comes after: no flight
 * started, report created or work order completed on or after the cutoff's
 * day is older history.
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
  if (kind === "flights")
    return [retentionCutoff(now, FLIGHT_RETENTION_DAYS), ""];
  const cutoff = retentionCutoff(now, RETENTION_DAYS);
  if (kind === "discrepancies") return [cutoff, ""];
  return [new Date(cutoff).toISOString().slice(0, 10), ""];
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
  const changed = Math.max(orderActivity(w), latestDependentChange(context));
  return changed < retentionCutoff(now, RETENTION_DAYS);
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
 * The members a page's rows name, for the names its screen shows: flights'
 * pilots and copilots, and reports' authors and resolvers.
 *
 * @param members - The members the caller may see.
 * @param records - The page's rows.
 * @returns Those named, in `members` order.
 */
export function namedMembers(
  members: Member[],
  records: Pick<HistoryRecords, "flights" | "discrepancies">,
): Member[] {
  const named = new Set([
    ...records.flights.flatMap((f) => [f.pilotId, f.copilotId]),
    ...records.discrepancies.flatMap((d) => [d.authorId, d.resolvedBy]),
  ]);
  return members.filter((m) => named.has(m.id));
}

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
  const sides = {
    flights: split(all.flights, (f) => !isOlderFlight(f, now)),
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
  };
  return { retained: pick(sides, 0), older: pick(sides, 1) };
}

function windowedRecords(s: Snapshot): HistoryRecords {
  return {
    flights: s.flights,
    discrepancies: s.discrepancies,
    workOrders: s.workOrders ?? [],
    taskCards: s.taskCards ?? [],
    archivedTaskCards: s.archivedTaskCards ?? [],
    costs: s.costs ?? [],
  };
}

function split<T>(rows: T[], keep: (row: T) => boolean): [T[], T[]] {
  return [rows.filter(keep), rows.filter((row) => !keep(row))];
}

function pick(
  sides: {
    [K in keyof HistoryRecords]: [HistoryRecords[K], HistoryRecords[K]];
  },
  side: 0 | 1,
): HistoryRecords {
  return {
    flights: sides.flights[side],
    discrepancies: sides.discrepancies[side],
    workOrders: sides.workOrders[side],
    taskCards: sides.taskCards[side],
    archivedTaskCards: sides.archivedTaskCards[side],
    costs: sides.costs[side],
  };
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

// The order's own dated events. A completion date counts from its UTC
// midnight, for orders closed without a recorded close-out.
function orderActivity(w: WorkOrder): number {
  return Math.max(
    w.recordedAt,
    w.closeout?.recordedAt ?? 0,
    w.completionDate ? Date.parse(w.completionDate) : 0,
    ...(w.revisions ?? []).map((r) => r.recordedAt),
    ...(w.archivedTasks ?? []).map((t) => t.removedAt),
    ...(w.componentCorrections ?? []).map((c) => c.recordedAt),
  );
}

// The latest change to an order's job cards and cost entries.
function latestDependentChange(context: WorkOrderContext): number {
  const cards = [...context.taskCards, ...context.archivedTaskCards];
  const entries = context.costs.flatMap((c) =>
    c.kind === "workOrder" ? [...c.labor, ...c.other] : [],
  );
  return Math.max(
    0,
    ...cards.map((c) => c.updatedAt),
    ...entries.map((e) => e.createdAt),
  );
}

function pageRecords(older: HistoryRecords, request: HistoryPageRequest) {
  if (request.kind === "flights") {
    const { status } = request;
    const flights = older.flights.filter((f) => !status || f.status === status);
    const { rows, ...page } = pageOf("flights", flights, request);
    return { ...page, records: { ...emptyRecords(), flights: rows } };
  }
  if (request.kind === "discrepancies") {
    const { rows, ...page } = pageOf(
      "discrepancies",
      older.discrepancies,
      request,
    );
    return { ...page, records: { ...emptyRecords(), discrepancies: rows } };
  }
  const { rows, ...page } = pageOf("workOrders", older.workOrders, request);
  return {
    ...page,
    records: { ...emptyRecords(), ...withDependents(older, rows) },
  };
}

function pageOf<K extends HistoryKind>(
  kind: K,
  rows: HistoryRows[K][],
  request: PageBase,
) {
  const from = readHistoryCursor(kind, request.cursor);
  const listed = rows
    .filter(
      (r) => !request.aircraftUuid || r.aircraftUuid === request.aircraftUuid,
    )
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

function withDependents(
  older: HistoryRecords,
  orders: WorkOrder[],
): Pick<
  HistoryRecords,
  "workOrders" | "taskCards" | "archivedTaskCards" | "costs"
> {
  const uuids = new Set(orders.map((w) => w.uuid));
  const onPage = (c: TaskCard) => uuids.has(c.workOrderUuid);
  return {
    workOrders: orders,
    taskCards: older.taskCards.filter(onPage),
    archivedTaskCards: older.archivedTaskCards.filter(onPage),
    costs: older.costs.filter(
      (c) => c.kind === "workOrder" && uuids.has(c.workOrderUuid),
    ),
  };
}

function emptyRecords(): HistoryRecords {
  return {
    flights: [],
    discrepancies: [],
    workOrders: [],
    taskCards: [],
    archivedTaskCards: [],
    costs: [],
  };
}
