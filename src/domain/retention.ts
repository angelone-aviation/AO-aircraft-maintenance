/**
 * Responsibility: The history retention window: which flights, problem
 *   reports, work orders, job cards and cost records the workspace keeps, and
 *   the pages of older history in each list's order.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ./model (types), ./workOrders, ./taskCards, ./costs (types).
 *
 * ADR-0013: the workspace keeps open items, recent history and the records
 * the owner portal shows; everything else stays on the server and loads page
 * by page. One rule here serves the server, the demo and the tests' oracle.
 */
import type { Discrepancy, Flight, Snapshot } from "./model";
import { isOpenWorkOrder, type WorkOrder } from "./workOrders";
import { isTaskClosed, type TaskCard } from "./taskCards";
import type { CostRecord } from "./costs";

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

interface PageBase {
  /** One aircraft, or every aircraft in the snapshot when absent. */
  aircraftUuid?: string;
  /** The previous page's `continueCursor`; null for the first page. */
  cursor: string | null;
  /** Rows of `kind` wanted, bounded to 1–{@link MAX_HISTORY_PAGE_SIZE}. */
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
  /** True when no older row of the kind is left after this page. */
  isDone: boolean;
  /** Where the next page starts; the request's cursor on an empty page. */
  continueCursor: string | null;
}

type Position = [key: string | number, uuid: string];

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
 * out. Lists run newest first, as their screens sort: flights by start time
 * (as recorded), reports by creation, work orders by opening; equal times by
 * uuid, highest first. Paging from the first page to `isDone` returns every
 * left-out row of the kind once, and with work orders every left-out job
 * card and cost record.
 *
 * @param s - The full (scoped) snapshot.
 * @param request - The list, its filters, cursor and page size.
 * @param now - The current time, in milliseconds.
 * @returns The page; its cursor stays valid when newer records arrive.
 * @throws {Error} "Invalid history cursor." for a cursor this list did not
 *   return.
 */
export function historyPage(
  s: Snapshot,
  request: HistoryPageRequest,
  now: number,
): HistoryPage {
  const { older } = partition(s, now);
  if (request.kind === "flights") {
    const flights = older.flights.filter(
      (f) => !request.status || f.status === request.status,
    );
    const { rows, ...page } = pageOf(flights, (f) => f.startTime, request);
    return { ...page, records: { ...emptyRecords(), flights: rows } };
  }
  if (request.kind === "discrepancies") {
    const { rows, ...page } = pageOf(
      older.discrepancies,
      (d) => d.createdAt,
      request,
    );
    return { ...page, records: { ...emptyRecords(), discrepancies: rows } };
  }
  const { rows, ...page } = pageOf(
    older.workOrders,
    (w) => w.recordedAt,
    request,
  );
  return { ...page, records: withDependents(older, rows) };
}

// Every windowed record lands on exactly one side.
function partition(s: Snapshot, now: number) {
  const all = windowedRecords(s);
  const cutoff = retentionCutoff(now, RETENTION_DAYS);
  const flightCutoff = retentionCutoff(now, FLIGHT_RETENTION_DAYS);
  const kept = keptWorkOrders(all, cutoff);
  const loaded = new Set(all.workOrders.map((w) => w.uuid));
  const follows = (workOrderUuid: string) =>
    !loaded.has(workOrderUuid) || kept.has(workOrderUuid);
  const sides = {
    flights: split(all.flights, (f) => isKeptFlight(f, flightCutoff)),
    discrepancies: split(all.discrepancies, (d) => isKeptReport(d, cutoff)),
    workOrders: split(all.workOrders, (w) => kept.has(w.uuid)),
    taskCards: split(all.taskCards, (c) => follows(c.workOrderUuid)),
    archivedTaskCards: split(all.archivedTaskCards, (c) =>
      follows(c.workOrderUuid),
    ),
    costs: split(
      all.costs,
      (c) => c.kind !== "workOrder" || follows(c.workOrderUuid),
    ),
  };
  return {
    retained: pick(sides, 0),
    older: pick(sides, 1),
  };
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

// A held flight is open until an administrator reviews it. A flight synced
// late (an old leg logged offline) is recent history even if it flew earlier.
function isKeptFlight(f: Flight, cutoff: number) {
  return (
    f.status === "review" ||
    Date.parse(f.startTime) >= cutoff ||
    f.submittedAt >= cutoff
  );
}

function isKeptReport(d: Discrepancy, cutoff: number) {
  if (d.status === "open") return true;
  const changed = [d.createdAt, d.resolvedAt ?? 0, d.deferral?.deferredAt ?? 0];
  return Math.max(...changed) >= cutoff;
}

function keptWorkOrders(all: HistoryRecords, cutoff: number): Set<string> {
  const dependents = dependentActivity(all);
  const openCards = new Set(
    all.taskCards.filter((c) => !isTaskClosed(c)).map((c) => c.workOrderUuid),
  );
  const recent = recentlyCompleted(all.workOrders);
  const kept = all.workOrders.filter(
    (w) =>
      isOpenWorkOrder(w) ||
      openCards.has(w.uuid) ||
      recent.has(w.uuid) ||
      Math.max(orderActivity(w), dependents.get(w.uuid) ?? 0) >= cutoff,
  );
  return new Set(kept.map((w) => w.uuid));
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

// The latest change to each order's job cards and cost entries.
function dependentActivity(all: HistoryRecords): Map<string, number> {
  const latest = new Map<string, number>();
  const note = (uuid: string, at: number) =>
    latest.set(uuid, Math.max(latest.get(uuid) ?? 0, at));
  for (const c of [...all.taskCards, ...all.archivedTaskCards])
    note(c.workOrderUuid, c.updatedAt);
  for (const c of all.costs) {
    if (c.kind !== "workOrder") continue;
    for (const entry of [...c.labor, ...c.other])
      note(c.workOrderUuid, entry.createdAt);
  }
  return latest;
}

// Sorted as the owner portal sorts them; every order tied with the last
// place is kept, so the portal's pick is always among them.
function recentlyCompleted(orders: WorkOrder[]): Set<string> {
  const byAircraft = new Map<string, WorkOrder[]>();
  for (const w of orders.filter((o) => o.status === "completed"))
    byAircraft.set(w.aircraftUuid, [
      ...(byAircraft.get(w.aircraftUuid) ?? []),
      w,
    ]);
  const kept = [...byAircraft.values()].flatMap((list) => {
    const dates = list
      .map((w) => w.completionDate)
      .sort()
      .reverse();
    const last =
      dates[Math.min(dates.length, RECENT_COMPLETED_WORK_ORDERS) - 1];
    return list.filter((w) => w.completionDate >= last);
  });
  return new Set(kept.map((w) => w.uuid));
}

function pageOf<T extends { uuid: string; aircraftUuid: string }>(
  rows: T[],
  keyOf: (row: T) => string | number,
  request: PageBase & { kind: HistoryKind },
) {
  const keyType = request.kind === "flights" ? "string" : "number";
  const from = parseCursor(request.cursor, keyType);
  const listed = rows
    .filter(
      (r) => !request.aircraftUuid || r.aircraftUuid === request.aircraftUuid,
    )
    .map((row): [T, Position] => [row, [keyOf(row), row.uuid]])
    .filter(([, at]) => !from || comparePositions(from, at) < 0)
    .sort(([, a], [, b]) => comparePositions(a, b));
  const size = Math.min(
    MAX_HISTORY_PAGE_SIZE,
    Math.max(1, Math.floor(request.numItems) || 1),
  );
  const page = listed.slice(0, size);
  const last = page.at(-1);
  return {
    rows: page.map(([row]) => row),
    isDone: listed.length <= size,
    continueCursor: last ? JSON.stringify(last[1]) : request.cursor,
  };
}

// Newest first; equal keys by uuid, highest first, so a server index ending
// in the uuid reads the same order.
function comparePositions([ak, au]: Position, [bk, bu]: Position) {
  if (ak !== bk) return ak > bk ? -1 : 1;
  if (au !== bu) return au > bu ? -1 : 1;
  return 0;
}

function parseCursor(
  cursor: string | null,
  keyType: "string" | "number",
): Position | undefined {
  if (cursor === null) return undefined;
  const position = readJson(cursor);
  if (
    !Array.isArray(position) ||
    position.length !== 2 ||
    typeof position[0] !== keyType ||
    typeof position[1] !== "string"
  )
    throw new Error(INVALID_CURSOR);
  return [position[0], position[1]];
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
): HistoryRecords {
  const uuids = new Set(orders.map((w) => w.uuid));
  const onPage = (c: TaskCard) => uuids.has(c.workOrderUuid);
  return {
    ...emptyRecords(),
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
