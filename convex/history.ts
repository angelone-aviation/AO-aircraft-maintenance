/**
 * Responsibility: The paged history queries: the flights, problem reports and
 *   work orders the workspace's window leaves out, one work order with
 *   everything on it, and one aircraft's flights over a span.
 * Layer: Server. Public Convex queries; the window, order and scoping rules
 *   come from src/domain.
 * Dependencies: convex/values, ./_generated, ./programContext, ./access,
 *   ./collections, ./historyScan, ./userErrors, src/domain (retention,
 *   historyReads, programs, model, workOrders, auditHistory).
 *
 * Each query checks the program first (checkContext refuses a stale program,
 * owners and board members), reads only aircraft the caller may read, and
 * returns rows through scopedSnapshot, so redaction matches the workspace
 * (ADR-0013). A page equals historyPage on the caller's scoped snapshot,
 * unless the read budget cuts it short (docs/history-paging.md).
 */
import { ConvexError, v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { checkContext } from "./programContext";
import { member } from "./access";
import { decode, decodeFlight } from "./collections";
import { ReadBudget, scanHistory, type ReadAfter } from "./historyScan";
import { exposeRejections } from "./userErrors";
import {
  compareHistoryPositions,
  emptyHistoryRecords,
  historyCursor,
  historyPageSize,
  historyStart,
  isOlderFlight,
  isOlderReport,
  isOlderWorkOrder,
  namedMemberIds,
  namedMembers,
  readHistoryCursor,
  recentCompletionFloor,
  RECENT_COMPLETED_WORK_ORDERS,
  type HistoryKind,
  type HistoryPage,
  type HistoryPosition,
  type HistoryRecords,
} from "../src/domain/retention";
import {
  assertFlightRange,
  flightRange,
  MAX_RANGE_FLIGHTS,
  workOrderHistory,
  type FlightRange,
  type WorkOrderHistory,
} from "../src/domain/historyReads";
import { activeProgram, scopedSnapshot } from "../src/domain/programs";
import { can, type Member, type Snapshot } from "../src/domain/model";
import type { WorkOrder } from "../src/domain/workOrders";
import { HISTORY_NOT_FOUND } from "../src/domain/auditHistory";

// The statuses that close a work order: only closed orders are ever older.
const CLOSED_STATUSES = ["completed", "cancelled"] as const;
const PAGE_ARGS = {
  programUuid: v.optional(v.string()),
  aircraftUuid: v.optional(v.string()),
  cursor: v.union(v.string(), v.null()),
  numItems: v.number(),
};

type State = Awaited<ReturnType<typeof checkContext>>;
type PageArgs = { programUuid?: string; aircraftUuid?: string } & Pick<
  PageQuery,
  "cursor" | "numItems"
>;
type PageQuery = { cursor: string | null; numItems: number };
type Dependents = Pick<
  HistoryRecords,
  "taskCards" | "archivedTaskCards" | "costs"
>;

/** One list request, checked, with where its scan starts. */
interface ListScope<K extends HistoryKind> {
  state: State;
  /** The aircraft the caller may read. */
  readable: Set<string>;
  /** The aircraft the list reads: one, or every readable one. */
  sources: string[];
  now: number;
  after: HistoryPosition<K>;
  numItems: number;
  budget: ReadBudget;
}

/**
 * The next page of flights the workspace's window leaves out, newest start
 * first (historyPage's order).
 *
 * @param aircraftUuid - One aircraft; every readable one when absent.
 * @param status - Only flights of this outcome (H2).
 * @param cursor - The previous page's `continueCursor`, or null.
 * @param numItems - Page size, bounded as historyPageSize bounds it.
 * @returns The flights and the pilots and copilots they name. A page is
 *   short and not done when the read budget runs out first.
 * @throws {ConvexError} "History not found." for an aircraft the caller may
 *   not read, the same as for one that does not exist.
 * @throws {Error} "Invalid history cursor."; a missing derived column,
 *   until migrations:backfillHistoryColumns has run.
 * @throws As `checkContext`, first.
 */
export const flights = query({
  args: {
    ...PAGE_ARGS,
    status: v.optional(
      v.union(
        v.literal("accepted"),
        v.literal("review"),
        v.literal("rejected"),
      ),
    ),
  },
  handler: async (ctx, args): Promise<HistoryPage> => {
    const list = await openList(ctx, "flights", args);
    await assertColumnsFilled(ctx, list, "flights");
    const scan = await scanHistory({
      ...list,
      ranges: list.sources.map((a) => flightRows(ctx, list.budget, a)),
      positionOf: flightPosition,
      pick: async (row) => {
        const f = decodeFlight(row);
        const listed = !args.status || f.status === args.status;
        return listed && isOlderFlight(f, list.now) ? f : null;
      },
    });
    const page = await namedPage(ctx, list.state, { flights: scan.picked });
    return {
      ...page,
      isDone: scan.isDone,
      continueCursor: cursorOf(scan, args),
    };
  },
});

/**
 * The next page of problem reports the workspace's window leaves out, newest
 * first by creation.
 *
 * @param aircraftUuid - One aircraft; every readable one when absent.
 * @param cursor - The previous page's `continueCursor`, or null.
 * @param numItems - Page size, bounded as historyPageSize bounds it.
 * @returns The reports and the authors and resolvers they name. A page is
 *   short and not done when the read budget runs out first.
 * @throws {ConvexError} "History not found." for an aircraft the caller may
 *   not read, the same as for one that does not exist.
 * @throws {Error} "Invalid history cursor."
 * @throws As `checkContext`, first.
 */
export const discrepancies = query({
  args: PAGE_ARGS,
  handler: async (ctx, args): Promise<HistoryPage> => {
    const list = await openList(ctx, "discrepancies", args);
    const scan = await scanHistory({
      ...list,
      ranges: list.sources.map((a) => reportRows(ctx, list.budget, a)),
      positionOf: (row): HistoryPosition<"discrepancies"> => [
        row.createdAt,
        row.uuid,
      ],
      pick: async (row) => (isOlderReport(row, list.now) ? row : null),
    });
    const page = await namedPage(ctx, list.state, {
      discrepancies: scan.picked,
    });
    return {
      ...page,
      isDone: scan.isDone,
      continueCursor: cursorOf(scan, args),
    };
  },
});

/**
 * The next page of work orders the workspace's window leaves out, newest
 * completion first; each brings its job cards, archived job cards (which
 * page with their order) and cost record, redacted as the workspace
 * redacts them.
 *
 * @param aircraftUuid - One aircraft; every readable one when absent.
 * @param cursor - The previous page's `continueCursor`, or null.
 * @param numItems - Page size, bounded as historyPageSize bounds it.
 * @returns The orders and their records; no members. A page is short and
 *   not done when the read budget runs out first.
 * @throws {ConvexError} "History not found." for an aircraft the caller may
 *   not read, the same as for one that does not exist.
 * @throws {Error} "Invalid history cursor."; a missing derived column,
 *   until migrations:backfillHistoryColumns has run.
 * @throws As `checkContext`, first.
 */
export const workOrders = query({
  args: PAGE_ARGS,
  handler: async (ctx, args): Promise<HistoryPage> => {
    const list = await openList(ctx, "workOrders", args);
    await assertColumnsFilled(ctx, list, "workOrders");
    const floors = await readRecentFloors(ctx, list);
    const scan = await scanHistory({
      ...list,
      ranges: list.sources.flatMap((a) =>
        CLOSED_STATUSES.map((s) => orderRows(ctx, list.budget, a, s)),
      ),
      positionOf: workOrderPosition,
      pick: (row) => pickOlderOrder(ctx, list, floors, row),
    });
    return {
      records: {
        ...emptyHistoryRecords(),
        workOrders: scan.picked.map((p) => p.workOrder),
        taskCards: scan.picked.flatMap((p) => p.taskCards),
        archivedTaskCards: scan.picked.flatMap((p) => p.archivedTaskCards),
        costs: scan.picked.flatMap((p) => p.costs),
      },
      members: [],
      isDone: scan.isDone,
      continueCursor: cursorOf(scan, args),
    };
  },
});

/**
 * One work order with everything filed on it, inside the window or not: for
 * the records package, logbook photos and links to older work.
 *
 * @param uuid - The work order.
 * @returns As workOrderHistory: its job cards, archived job cards, costs
 *   (redacted as the workspace redacts them), evidence, files and the parts
 *   requests raised from it.
 * @throws {ConvexError} "History not found." for an order on an aircraft the
 *   caller may not read, the same as for one that does not exist.
 * @throws As `checkContext`, first.
 */
export const workOrder = query({
  args: { programUuid: v.optional(v.string()), uuid: v.string() },
  handler: async (ctx, args): Promise<WorkOrderHistory> => {
    const state = await checkContext(ctx, args.programUuid);
    const row = await ctx.db
      .query("workOrders")
      .withIndex("uuid", (q) => q.eq("uuid", args.uuid))
      .first();
    const readable = readableAircraft(state);
    if (!row || !readable.has(row.aircraftUuid))
      throw new ConvexError(HISTORY_NOT_FOUND);
    const records = await readOrderRecords(ctx, state, readable, row);
    return exposeRejections(() =>
      workOrderHistory(scopedSnapshot({ ...state, ...records }), args.uuid),
    );
  },
});

/**
 * One aircraft's flights that started within a span, inside the window or
 * not: for the paper check, the records package and the flight-log import.
 *
 * @param aircraftUuid - The aircraft.
 * @param from - The span's first moment, in milliseconds; included.
 * @param to - The moment after its last; excluded.
 * @returns As flightRange: newest first, with the pilots and copilots named.
 * @throws {ConvexError} "History not found." for an aircraft the caller may
 *   not read, the same as for one that does not exist; "Choose a start time
 *   before the end time."; "Choose a shorter span: it holds more than 1,000
 *   flights."
 * @throws {Error} A missing derived column, until
 *   migrations:backfillHistoryColumns has run.
 * @throws As `checkContext`, first.
 */
export const flightsInRange = query({
  args: {
    programUuid: v.optional(v.string()),
    aircraftUuid: v.string(),
    from: v.number(),
    to: v.number(),
  },
  handler: async (ctx, args): Promise<FlightRange> => {
    const state = await checkContext(ctx, args.programUuid);
    if (!readableAircraft(state).has(args.aircraftUuid))
      throw new ConvexError(HISTORY_NOT_FOUND);
    exposeRejections(() => assertFlightRange(args));
    const scope = { sources: [args.aircraftUuid], budget: new ReadBudget() };
    await assertColumnsFilled(ctx, scope, "flights");
    const rows = await ctx.db
      .query("flights")
      .withIndex("started", (q) =>
        q
          .eq("aircraftUuid", args.aircraftUuid)
          .gte("startedAt", args.from)
          .lt("startedAt", args.to),
      )
      .order("desc")
      .take(MAX_RANGE_FLIGHTS + 1);
    const flights = rows.map(decodeFlight);
    const members = await readNamedMembers(ctx, { flights, discrepancies: [] });
    return exposeRejections(() =>
      flightRange(scopedSnapshot({ ...state, flights, members }), args),
    );
  },
});

async function openList<K extends HistoryKind>(
  ctx: QueryCtx,
  kind: K,
  args: PageArgs,
): Promise<ListScope<K>> {
  const state = await checkContext(ctx, args.programUuid);
  const readable = readableAircraft(state);
  const { aircraftUuid } = args;
  if (aircraftUuid && !readable.has(aircraftUuid))
    throw new ConvexError(HISTORY_NOT_FOUND);
  const now = Date.now();
  const start = historyStart(kind, now);
  const cursor = readHistoryCursor(kind, args.cursor);
  return {
    state,
    readable,
    sources: aircraftUuid ? [aircraftUuid] : [...readable],
    now,
    after:
      cursor && compareHistoryPositions(cursor, start) > 0 ? cursor : start,
    numItems: historyPageSize(args.numItems),
    budget: new ReadBudget(),
  };
}

function readableAircraft(state: State): Set<string> {
  return new Set(
    state.aircraft.filter((a) => can(state, a.uuid, "read")).map((a) => a.uuid),
  );
}

// Rows written before S2 lack the columns these ranges order by, so the
// ranges would skip or misplace them: refuse instead of showing a gap.
async function assertColumnsFilled(
  ctx: QueryCtx,
  scope: Pick<ListScope<HistoryKind>, "sources" | "budget">,
  table: "flights" | "workOrders",
): Promise<void> {
  const unfilled = await Promise.all(
    scope.sources.map((a) => readUnfilled(ctx, table, a)),
  );
  if (unfilled.some((rows) => scope.budget.spend(rows).length > 0))
    throw new Error(
      `History columns are missing on ${table}; run migrations:backfillHistoryColumns.`,
    );
}

function readUnfilled(
  ctx: QueryCtx,
  table: "flights" | "workOrders",
  aircraftUuid: string,
): Promise<Doc<"flights" | "workOrders">[]> {
  if (table === "flights")
    return ctx.db
      .query("flights")
      .withIndex("started", (q) =>
        q.eq("aircraftUuid", aircraftUuid).eq("startedAt", undefined),
      )
      .take(1);
  return ctx.db
    .query("workOrders")
    .withIndex("status", (q) =>
      q.eq("aircraftUuid", aircraftUuid).eq("status", undefined),
    )
    .take(1);
}

// Rows strictly after a position in one index range: the rest of its key's
// ties (lower uuids), then lower keys. Convex orders strings by UTF-8 bytes
// and the domain by UTF-16 code units; uuids and ISO dates are ASCII, where
// the two agree.
function rangeAfter<
  T extends Doc<"flights" | "discrepancies" | "workOrders">,
  K extends string | number,
>(
  budget: ReadBudget,
  ties: (key: K, uuid: string, limit: number) => Promise<T[]>,
  below: (key: K, limit: number) => Promise<T[]>,
): ReadAfter<T, [K, string]> {
  return async ([key, uuid], limit) => {
    const tied = uuid === "" ? [] : budget.spend(await ties(key, uuid, limit));
    if (tied.length === limit) return tied;
    return [...tied, ...budget.spend(await below(key, limit - tied.length))];
  };
}

function flightRows(ctx: QueryCtx, budget: ReadBudget, aircraftUuid: string) {
  const range = () => ctx.db.query("flights");
  return rangeAfter<Doc<"flights">, number>(
    budget,
    (key, uuid, limit) =>
      range()
        .withIndex("started", (q) =>
          q
            .eq("aircraftUuid", aircraftUuid)
            .eq("startedAt", key)
            .lt("uuid", uuid),
        )
        .order("desc")
        .take(limit),
    (key, limit) =>
      range()
        .withIndex("started", (q) =>
          q.eq("aircraftUuid", aircraftUuid).lt("startedAt", key),
        )
        .order("desc")
        .take(limit),
  );
}

// Only resolved reports are ever older: an open one, deferred or not, stays.
function reportRows(ctx: QueryCtx, budget: ReadBudget, aircraftUuid: string) {
  const range = () => ctx.db.query("discrepancies");
  return rangeAfter<Doc<"discrepancies">, number>(
    budget,
    (key, uuid, limit) =>
      range()
        .withIndex("status", (q) =>
          q
            .eq("aircraftUuid", aircraftUuid)
            .eq("status", "resolved")
            .eq("createdAt", key)
            .lt("uuid", uuid),
        )
        .order("desc")
        .take(limit),
    (key, limit) =>
      range()
        .withIndex("status", (q) =>
          q
            .eq("aircraftUuid", aircraftUuid)
            .eq("status", "resolved")
            .lt("createdAt", key),
        )
        .order("desc")
        .take(limit),
  );
}

function orderRows(
  ctx: QueryCtx,
  budget: ReadBudget,
  aircraftUuid: string,
  status: (typeof CLOSED_STATUSES)[number],
) {
  const range = () => ctx.db.query("workOrders");
  return rangeAfter<Doc<"workOrders">, string>(
    budget,
    (key, uuid, limit) =>
      range()
        .withIndex("status", (q) =>
          q
            .eq("aircraftUuid", aircraftUuid)
            .eq("status", status)
            .eq("completionDate", key)
            .lt("uuid", uuid),
        )
        .order("desc")
        .take(limit),
    (key, limit) =>
      range()
        .withIndex("status", (q) =>
          q
            .eq("aircraftUuid", aircraftUuid)
            .eq("status", status)
            .lt("completionDate", key),
        )
        .order("desc")
        .take(limit),
  );
}

// The column the range orders by, which encode derives from startTime.
function flightPosition(row: Doc<"flights">): HistoryPosition<"flights"> {
  if (row.startedAt === undefined)
    throw new Error(`Flight ${row.uuid} has no startedAt column.`);
  return [row.startedAt, row.uuid];
}

function workOrderPosition(
  row: Doc<"workOrders">,
): HistoryPosition<"workOrders"> {
  if (row.completionDate === undefined)
    throw new Error(`Work order ${row.uuid} has no completionDate column.`);
  return [row.completionDate, row.uuid];
}

// Each source aircraft's fifth latest completion date, from the top of its
// completed range.
async function readRecentFloors(
  ctx: QueryCtx,
  list: ListScope<"workOrders">,
): Promise<Map<string, string | undefined>> {
  const floors = await Promise.all(
    list.sources.map(async (aircraftUuid) => {
      const latest = await ctx.db
        .query("workOrders")
        .withIndex("status", (q) =>
          q.eq("aircraftUuid", aircraftUuid).eq("status", "completed"),
        )
        .order("desc")
        .take(RECENT_COMPLETED_WORK_ORDERS);
      const dates = list.budget
        .spend(latest)
        .map((r) => r.completionDate ?? "");
      return [aircraftUuid, recentCompletionFloor(dates)] as const;
    }),
  );
  return new Map(floors);
}

// The order is judged as historyPage judges it on the caller's scoped
// snapshot: on its scoped job cards and costs. Without them the rule can
// only keep an order, never page it, so a kept order costs no more reads.
async function pickOlderOrder(
  ctx: QueryCtx,
  list: ListScope<"workOrders">,
  floors: Map<string, string | undefined>,
  row: Doc<"workOrders">,
): Promise<(Dependents & { workOrder: WorkOrder }) | null> {
  const [w] = decode("workOrders", [row]);
  const recentFloor = floors.get(w.aircraftUuid);
  const bare = { taskCards: [], archivedTaskCards: [], costs: [] };
  if (!isOlderWorkOrder(w, { ...bare, recentFloor }, list.now)) return null;
  const read = await readDependents(ctx, list, w.uuid);
  const scoped = scopedSnapshot({ ...list.state, workOrders: [w], ...read });
  const dependents = {
    taskCards: scoped.taskCards ?? [],
    archivedTaskCards: scoped.archivedTaskCards ?? [],
    costs: scoped.costs ?? [],
  };
  const older = isOlderWorkOrder(w, { ...dependents, recentFloor }, list.now);
  return older ? { workOrder: w, ...dependents } : null;
}

// A work order's job cards and archived job cards on readable aircraft, and
// its cost records kept by the active program, which paid (decision D14).
async function readDependents(
  ctx: QueryCtx,
  scope: Pick<ListScope<HistoryKind>, "state" | "readable" | "budget">,
  workOrderUuid: string,
): Promise<Dependents> {
  const { budget, readable } = scope;
  const program = activeProgram(scope.state);
  const [cards, archived, costs] = await Promise.all([
    ctx.db
      .query("taskCards")
      .withIndex("workOrder", (q) => q.eq("workOrderUuid", workOrderUuid))
      .collect(),
    ctx.db
      .query("archivedTaskCards")
      .withIndex("workOrder", (q) => q.eq("workOrderUuid", workOrderUuid))
      .collect(),
    ctx.db
      .query("costs")
      .withIndex("workOrder", (q) => q.eq("workOrderUuid", workOrderUuid))
      .collect(),
  ]);
  const onReadable = (c: { aircraftUuid: string }) =>
    readable.has(c.aircraftUuid);
  return {
    taskCards: decode("taskCards", budget.spend(cards).filter(onReadable)),
    archivedTaskCards: decode(
      "archivedTaskCards",
      budget.spend(archived).filter(onReadable),
    ),
    costs: decode(
      "costs",
      budget.spend(costs).filter((c) => c.programUuid === program),
    ),
  };
}

// Everything workOrderHistory reads of one order, before scoping.
async function readOrderRecords(
  ctx: QueryCtx,
  state: State,
  readable: Set<string>,
  row: Doc<"workOrders">,
): Promise<Partial<Snapshot>> {
  const scope = { state, readable, budget: new ReadBudget() };
  const dependents = await readDependents(ctx, scope, row.uuid);
  const cards = [...dependents.taskCards, ...dependents.archivedTaskCards];
  const [evidence, files, requests] = await Promise.all([
    Promise.all(cards.map((c) => readEvidence(ctx, c.uuid))),
    ctx.db
      .query("workOrderFiles")
      .withIndex("workOrder", (q) => q.eq("workOrderUuid", row.uuid))
      .collect(),
    ctx.db
      .query("partsRequests")
      .withIndex("sourceWorkOrder", (q) =>
        q.eq("sourceWorkOrderUuid", row.uuid),
      )
      .collect(),
  ]);
  return {
    workOrders: decode("workOrders", [row]),
    ...dependents,
    taskEvidence: evidence.flat(),
    workOrderAttachments: files.map((f) => ({
      uuid: f._id,
      workOrderUuid: f.workOrderUuid,
      name: f.name,
      size: f.size,
      uploadedAt: f.uploadedAt,
    })),
    partsRequests: decode(
      "partsRequests",
      requests.filter((r) => r.programUuid === activeProgram(state)),
    ),
  };
}

// Listed as the workspace lists evidence: no storage id, oldest first.
async function readEvidence(ctx: QueryCtx, taskCardUuid: string) {
  const files = await ctx.db
    .query("taskEvidence")
    .withIndex("taskCard", (q) => q.eq("taskCardUuid", taskCardUuid))
    .collect();
  return files.map((f) => ({
    uuid: f._id,
    taskCardUuid: f.taskCardUuid,
    name: f.name,
    size: f.size,
    uploadedAt: f.uploadedAt,
    category: f.category,
  }));
}

// A flight or report page, scoped, with the members its rows name: loaded
// by id, as the workspace loads its pilots, then cut by the same rule.
async function namedPage(
  ctx: QueryCtx,
  state: State,
  rows: Partial<Pick<HistoryRecords, "flights" | "discrepancies">>,
): Promise<Pick<HistoryPage, "records" | "members">> {
  const page = { flights: [], discrepancies: [], ...rows };
  const members = await readNamedMembers(ctx, page);
  const scoped = scopedSnapshot({ ...state, ...page, members });
  const records = {
    ...emptyHistoryRecords(),
    flights: scoped.flights,
    discrepancies: scoped.discrepancies,
  };
  return { records, members: namedMembers(scoped.members, records) };
}

async function readNamedMembers(
  ctx: QueryCtx,
  records: Pick<HistoryRecords, "flights" | "discrepancies">,
): Promise<Member[]> {
  const users = await Promise.all(
    namedMemberIds(records).map((id) => {
      const userId = ctx.db.normalizeId("users", id);
      return userId ? ctx.db.get(userId) : null;
    }),
  );
  return users.filter((u) => u !== null).map(member);
}

function cursorOf<P extends HistoryPosition>(
  scan: { resume: P | undefined },
  request: PageQuery,
): string | null {
  return scan.resume ? historyCursor(scan.resume) : request.cursor;
}
