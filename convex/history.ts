/**
 * Responsibility: The history queries: the flights, problem reports, work
 *   orders, parts requests, purchase orders and flight plans the
 *   workspace's window leaves out, one work order with everything on it,
 *   records named by uuid, one aircraft's flights over a span, and its cost
 *   report from the cost ledger.
 * Layer: Server. Public Convex queries; the window, order and scoping rules
 *   come from src/domain.
 * Dependencies: convex/values, ./_generated, ./programContext, ./access,
 *   ./collections, ./historyScan, ./purchasingPages, ./purchasingKeys,
 *   ./costLedger,
 *   ./workingSet, ./userErrors, ./validators, src/domain (retention,
 *   purchasingWindow, historyReads, costs, programs, model, workOrders,
 *   vendors, auditHistory).
 *
 * Each query checks the program first (checkContext refuses a stale program,
 * owners and board members) and reads only aircraft the caller may read
 * (ADR-0013). Records come back through scopedSnapshot, so redaction matches
 * the workspace, and a page equals historyPage on the caller's scoped
 * snapshot unless the read budget cuts it short; the cost report is for
 * program administrators (docs/history-paging.md).
 */
import { ConvexError, v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { checkContext } from "./programContext";
import { member } from "./access";
import { decode, decodeFlight } from "./collections";
import { rangeAfter, ReadBudget, scanHistory } from "./historyScan";
import {
  columnPosition,
  orderRange,
  planRange,
  PurchasingJudge,
  requestRange,
  type OlderRequest,
} from "./purchasingPages";
import { requestSourceValidator } from "./validators";
import { exposeRejections } from "./userErrors";
import { ledgerRowsOf } from "./costLedger";
import {
  archivedCardDocsByUuid,
  budgetAndSettingsDocs,
  discrepancyDocsByUuid,
  inLoadOrder,
  partsRequestDocsOn,
  taskCardDocsByUuid,
  workOrderDocsByUuid,
} from "./workingSet";
import { ordersAllocating } from "./purchasingKeys";
import { ledgerCostReport } from "../src/domain/costs/ledger";
import { periodFor } from "../src/domain/costs/period";
import {
  assertCostReportReader,
  COST_REPORT_ADMINS_ONLY,
  periodBudgets,
} from "../src/domain/costs/costReport";
import {
  compareHistoryPositions,
  emptyHistoryRecords,
  windowCutoffs,
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
  assertRecordLookup,
  flightRange,
  lookupRecords,
  MAX_RANGE_FLIGHTS,
  workOrderHistory,
  type FlightRange,
  type FoundRecords,
  type RecordLookup,
  type WorkOrderHistory,
} from "../src/domain/historyReads";
import {
  allocatedRequests,
  isOpenPurchaseOrder,
  purchaseOrderActivity,
} from "../src/domain/purchasingWindow";
import { vendorKey } from "../src/domain/vendors";
import {
  activeProgram,
  programPermission,
  scopedSnapshot,
} from "../src/domain/programs";
import { can, type Member, type Snapshot } from "../src/domain/model";
import type { WorkOrder } from "../src/domain/workOrders";
import type { PurchaseOrder } from "../src/domain/purchaseOrders";
import type { FlightPlan } from "../src/domain/flightPlans";
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
// The one index range a uuid lookup opens, which Convex's types cannot name
// for a table chosen at run time; both tables index "uuid" alone.
type UuidRange = { eq(field: "uuid", value: string): never };
/** The tables whose history pages read per aircraft by a derived column. */
type AircraftTable = "flights" | "workOrders" | "flightPlans";
/** What judging a work order reads within. */
type OrderScope = Pick<
  ListScope<HistoryKind>,
  "state" | "readable" | "budget" | "now"
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
 * The next page of parts requests the workspace's window leaves out, newest
 * first by creation; each brings its purchase allocations, as the
 * workspace lists them.
 *
 * @param aircraftUuid - One aircraft; when absent, every readable one and,
 *   for a program administrator, requests for stock.
 * @param source - Only the requests on this record's list
 *   (requestMatchesSource).
 * @param cursor - The previous page's `continueCursor`, or null.
 * @param numItems - Page size, bounded as historyPageSize bounds it.
 * @returns The requests and their allocations; no members. A page is short
 *   and not done when the read budget runs out first.
 * @throws {ConvexError} "History not found." for an aircraft the caller may
 *   not read, the same as for one that does not exist.
 * @throws {Error} "Invalid history cursor."; a missing derived column,
 *   until migrations:backfillHistoryColumns has run.
 * @throws As `checkContext`, first.
 */
export const partsRequests = query({
  args: { ...PAGE_ARGS, source: v.optional(requestSourceValidator) },
  handler: async (ctx, args): Promise<HistoryPage> => {
    const list = await openList(ctx, "partsRequests", args);
    const program = activeProgram(list.state);
    if (!program) return emptyPage(args);
    await assertProgramColumnsFilled(
      ctx,
      list.budget,
      program,
      "partsRequests",
    );
    const judge = purchasingJudge(ctx, list, program);
    const scan = await scanHistory({
      ...list,
      ranges: requestSources(list, args).map((a) =>
        requestRange(ctx, list.budget, program, a),
      ),
      positionOf: (row) => columnPosition(row, "createdAt", "Parts request"),
      pick: async (row) => {
        const [r] = decode("partsRequests", [row]);
        if (args.source && !(await judge.matchesSource(r, args.source)))
          return null;
        return judge.olderRequest(r);
      },
    });
    return {
      records: requestRecords(list.state, scan.picked),
      members: [],
      isDone: scan.isDone,
      continueCursor: cursorOf(scan, args),
    };
  },
});

/**
 * Inventory administrators: the next page of purchase orders the
 * workspace's window leaves out, newest first by creation. Anyone else's
 * workspace holds no orders, so their pages are empty and done.
 *
 * @param vendor - Only orders to this vendor, matched as vendorKey matches
 *   names.
 * @param cursor - The previous page's `continueCursor`, or null.
 * @param numItems - Page size, bounded as historyPageSize bounds it.
 * @returns The orders; no members. A page is short and not done when the
 *   read budget runs out first.
 * @throws {Error} "Invalid history cursor."; a missing derived column,
 *   until migrations:backfillHistoryColumns has run.
 * @throws As `checkContext`, first.
 */
export const purchaseOrders = query({
  args: {
    programUuid: v.optional(v.string()),
    vendor: v.optional(v.string()),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (ctx, args): Promise<HistoryPage> => {
    const list = await openList(ctx, "purchaseOrders", args);
    const program = activeProgram(list.state);
    if (!program || !programPermission(list.state, "admin"))
      return emptyPage(args);
    await assertProgramColumnsFilled(
      ctx,
      list.budget,
      program,
      "purchaseOrders",
    );
    const judge = purchasingJudge(ctx, list, program);
    const scan = await scanHistory({
      ...list,
      ranges: [orderRange(ctx, list.budget, program)],
      positionOf: (row) => columnPosition(row, "createdAt", "Purchase order"),
      pick: (row) => pickOlderPurchaseOrder(judge, list.now, args.vendor, row),
    });
    const scoped = scopedSnapshot({
      ...list.state,
      purchaseOrders: scan.picked,
    });
    return {
      records: {
        ...emptyHistoryRecords(),
        purchaseOrders: scoped.purchaseOrders ?? [],
      },
      members: [],
      isDone: scan.isDone,
      continueCursor: cursorOf(scan, args),
    };
  },
});

/**
 * The next page of flight plans the workspace's window leaves out, newest
 * departure first; each brings the flights logged against it.
 *
 * @param aircraftUuid - One aircraft; every readable one when absent.
 * @param cursor - The previous page's `continueCursor`, or null.
 * @param numItems - Page size, bounded as historyPageSize bounds it.
 * @returns The plans, their flights and the pilots and copilots those name.
 *   A page is short and not done when the read budget runs out first.
 * @throws {ConvexError} "History not found." for an aircraft the caller may
 *   not read, the same as for one that does not exist.
 * @throws {Error} "Invalid history cursor."; a missing derived column,
 *   until migrations:backfillHistoryColumns has run.
 * @throws As `checkContext`, first.
 */
export const flightPlans = query({
  args: PAGE_ARGS,
  handler: async (ctx, args): Promise<HistoryPage> => {
    const list = await openList(ctx, "flightPlans", args);
    await assertColumnsFilled(ctx, list, "flightPlans");
    const scan = await scanHistory({
      ...list,
      ranges: list.sources.map((a) => planRange(ctx, list.budget, a)),
      positionOf: (row) => columnPosition(row, "departedAt", "Flight plan"),
      pick: (row) => pickOlderPlan(ctx, list, row),
    });
    const flights = inLoadOrder(
      scan.picked.flatMap((p) => p.flights),
      list.state.aircraft,
    ).map(decodeFlight);
    const page = await namedPage(ctx, list.state, { flights });
    const plans = scopedSnapshot({
      ...list.state,
      flightPlans: scan.picked.map((p) => p.plan),
    }).flightPlans;
    return {
      ...page,
      records: { ...page.records, flightPlans: plans ?? [] },
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
 * Records a screen names by uuid, inside the window or not: problem reports
 * and job cards a form links to, the flights logged against plans, and the
 * parts requests and purchase orders a line or a document names, which no
 * list pages on their own.
 *
 * @param discrepancyUuids - Problem reports.
 * @param taskCardUuids - Job cards, live or archived.
 * @param flightPlanUuids - Flight plans whose flights are wanted.
 * @param partsRequestUuids - Parts requests, which come with their purchase
 *   allocations from every order.
 * @param purchaseOrderUuids - Purchase orders: an inventory administrator's
 *   only, as the workspace shows them.
 * @returns As lookupRecords: what the caller may read of them, redacted as
 *   the workspace redacts it, with the members the reports and flights name.
 *   A record on an aircraft the caller may not read is left out, as one that
 *   does not exist.
 * @throws {ConvexError} "Ask for at most 100 records at a time."
 * @throws As `checkContext`, first.
 */
export const records = query({
  args: {
    programUuid: v.optional(v.string()),
    discrepancyUuids: v.array(v.string()),
    taskCardUuids: v.array(v.string()),
    flightPlanUuids: v.array(v.string()),
    partsRequestUuids: v.optional(v.array(v.string())),
    purchaseOrderUuids: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<FoundRecords> => {
    const state = await checkContext(ctx, args.programUuid);
    exposeRejections(() => assertRecordLookup(args));
    const fleet = [...readableAircraft(state)].map((uuid) => ({ uuid }));
    const [discrepancies, cards, archived, planned] = await Promise.all([
      discrepancyDocsByUuid(ctx, args.discrepancyUuids, fleet),
      taskCardDocsByUuid(ctx, args.taskCardUuids, fleet),
      archivedCardDocsByUuid(ctx, args.taskCardUuids, fleet),
      planFlightDocs(ctx, args.flightPlanUuids, fleet),
    ]);
    const flights = planned.map(decodeFlight);
    const members = await readNamedMembers(ctx, { flights, discrepancies });
    const scoped = scopedSnapshot({
      ...state,
      discrepancies,
      flights,
      members,
      taskCards: decode("taskCards", cards),
      archivedTaskCards: decode("archivedTaskCards", archived),
      ...(await readNamedPurchasing(ctx, activeProgram(state), args)),
    });
    return exposeRejections(() => lookupRecords(scoped, args));
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

/**
 * An aircraft's work-order costs over a period, from the cost ledger: each
 * work order with costs in it and its labor time and money, the totals, and
 * the aircraft's budgets for the years the period touches. Parts count at
 * the prices the records fix (src/domain/costs/ledger.ts); the paying
 * program's rows only, so an aircraft that moved shows only its own costs.
 *
 * @param programUuid - The caller's active Flight Program.
 * @param aircraftUuid - The aircraft.
 * @param from - The first date, as an ISO date.
 * @param to - The last date, inclusive.
 * @returns As `ledgerCostReport`, with `budgets` by year.
 * @throws {ConvexError} As `checkContext`, first; "Flight Program
 *   administrator required."; "History not found." for an aircraft the
 *   caller cannot read; "Choose a start and end date."; "Choose a start date
 *   on or before the end date."
 */
export const costReport = query({
  args: {
    programUuid: v.optional(v.string()),
    aircraftUuid: v.string(),
    from: v.string(),
    to: v.string(),
  },
  handler: async (ctx, args) => {
    const state = await checkContext(ctx, args.programUuid);
    const program = activeProgram(state);
    if (!program) throw new ConvexError(COST_REPORT_ADMINS_ONLY);
    exposeRejections(() => assertCostReportReader(state, args.aircraftUuid));
    const period = exposeRejections(() =>
      periodFor("custom", args.to, { from: args.from, to: args.to }),
    );
    const rows = await ledgerRowsOf(ctx, program, args.aircraftUuid, period);
    const orders = await workOrderDocsByUuid(
      ctx,
      rows.map((r) => r.workOrderUuid),
      state.aircraft,
    );
    const costs = decode("costs", await budgetAndSettingsDocs(ctx, program));
    return {
      ...ledgerCostReport(rows, decode("workOrders", orders), period),
      budgets: periodBudgets(costs, args.aircraftUuid, period),
    };
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

function emptyPage(args: PageQuery): HistoryPage {
  return {
    records: emptyHistoryRecords(),
    members: [],
    isDone: true,
    continueCursor: args.cursor,
  };
}

// An aircraft's requests, or every readable aircraft's and, for those who
// see them, the program's requests for stock (aircraft "").
function requestSources(
  list: ListScope<"partsRequests">,
  args: { aircraftUuid?: string },
): string[] {
  if (args.aircraftUuid) return list.sources;
  const stock = programPermission(list.state, "admin") ? [""] : [];
  return [...list.sources, ...stock];
}

function purchasingJudge(
  ctx: QueryCtx,
  list: OrderScope,
  program: string,
): PurchasingJudge {
  const keepsOrder = orderKeeper(ctx, list);
  return new PurchasingJudge(ctx, { ...list, program, keepsOrder });
}

// The page's requests and their allocations, scoped: the orders, which only
// an administrator sees, become each request's purchases.
function requestRecords(state: State, picked: OlderRequest[]): HistoryRecords {
  const orders = [
    ...new Map(picked.flatMap((p) => p.orders).map((o) => [o._id, o])).values(),
  ].sort((a, b) => a._creationTime - b._creationTime);
  const scoped = scopedSnapshot({
    ...state,
    partsRequests: picked.map((p) => p.request),
    purchaseOrders: decode("purchaseOrders", orders),
  });
  return {
    ...emptyHistoryRecords(),
    partsRequests: scoped.partsRequests ?? [],
    partsRequestPurchases: scoped.partsRequestPurchases ?? [],
  };
}

// Open or recently changed orders are kept on their own fields; an older
// one is still kept for any request it allocates that the window keeps.
async function pickOlderPurchaseOrder(
  judge: PurchasingJudge,
  now: number,
  vendor: string | undefined,
  row: Doc<"purchaseOrders">,
): Promise<PurchaseOrder | null> {
  const [p] = decode("purchaseOrders", [row]);
  if (vendor !== undefined && vendorKey(p.vendor) !== vendorKey(vendor))
    return null;
  const { closed } = windowCutoffs(now);
  if (isOpenPurchaseOrder(p) || purchaseOrderActivity(p) >= closed) return null;
  for (const uuid of allocatedRequests(p))
    if (await judge.keepsRequest(uuid)) return null;
  return p;
}

// A plan departing before the flight cutoff is older unless filed since the
// closed cutoff or flown by a flight the window keeps; its flights come
// with it, from the readable aircraft.
async function pickOlderPlan(
  ctx: QueryCtx,
  list: ListScope<"flightPlans">,
  row: Doc<"flightPlans">,
): Promise<{ plan: FlightPlan; flights: Doc<"flights">[] } | null> {
  const [plan] = decode("flightPlans", [row]);
  if (plan.createdAt >= windowCutoffs(list.now).closed) return null;
  const logged = await ctx.db
    .query("flights")
    .withIndex("plan", (q) => q.eq("flightPlanUuid", plan.uuid))
    .collect();
  const flights = list.budget
    .spend(logged)
    .filter((f) => list.readable.has(f.aircraftUuid));
  if (flights.some((f) => !isOlderFlight(decodeFlight(f), list.now)))
    return null;
  return { plan, flights };
}

// Whether the window keeps a work order, judged as the work-order pages
// judge it, each order and each aircraft's floor read once per request. An
// order the caller may not read is not in their snapshot, so not kept.
function orderKeeper(
  ctx: QueryCtx,
  scope: OrderScope,
): (workOrderUuid: string) => Promise<boolean> {
  const verdicts = new Map<string, Promise<boolean>>();
  const floors = new Map<string, Promise<string | undefined>>();
  const floorOf = (aircraftUuid: string) => {
    if (!floors.has(aircraftUuid))
      floors.set(aircraftUuid, readFloor(ctx, scope.budget, aircraftUuid));
    return floors.get(aircraftUuid)!;
  };
  const judge = async (uuid: string) => {
    const [row] = scope.budget.spend(
      await ctx.db
        .query("workOrders")
        .withIndex("uuid", (q) => q.eq("uuid", uuid))
        .take(1),
    );
    if (!row || !scope.readable.has(row.aircraftUuid)) return false;
    const floor = new Map([
      [row.aircraftUuid, await floorOf(row.aircraftUuid)],
    ]);
    return (await pickOlderOrder(ctx, scope, floor, row)) === null;
  };
  return (uuid) => {
    if (!verdicts.has(uuid)) verdicts.set(uuid, judge(uuid));
    return verdicts.get(uuid)!;
  };
}

function readableAircraft(state: State): Set<string> {
  return new Set(
    state.aircraft.filter((a) => can(state, a.uuid, "read")).map((a) => a.uuid),
  );
}

// Rows written before the columns these ranges order by would be skipped or
// misplaced: refuse instead of showing a gap.
async function assertColumnsFilled(
  ctx: QueryCtx,
  scope: Pick<ListScope<HistoryKind>, "sources" | "budget">,
  table: AircraftTable,
): Promise<void> {
  const unfilled = await Promise.all(
    scope.sources.map((a) => readUnfilled(ctx, table, a)),
  );
  if (unfilled.some((rows) => scope.budget.spend(rows).length > 0))
    throw columnsMissing(table);
}

// Requests and orders are read by program; an unfilled row lacks the
// aircraft column too, so one range finds them.
async function assertProgramColumnsFilled(
  ctx: QueryCtx,
  budget: ReadBudget,
  program: string,
  table: "partsRequests" | "purchaseOrders",
): Promise<void> {
  const unfilled =
    table === "partsRequests"
      ? budget.spend(
          await ctx.db
            .query("partsRequests")
            .withIndex("created", (q) =>
              q.eq("programUuid", program).eq("aircraftUuid", undefined),
            )
            .take(1),
        )
      : budget.spend(
          await ctx.db
            .query("purchaseOrders")
            .withIndex("created", (q) =>
              q.eq("programUuid", program).eq("createdAt", undefined),
            )
            .take(1),
        );
  if (unfilled.length > 0) throw columnsMissing(table);
}

function columnsMissing(table: string): Error {
  return new Error(
    `History columns are missing on ${table}; run migrations:backfillHistoryColumns.`,
  );
}

function readUnfilled(
  ctx: QueryCtx,
  table: AircraftTable,
  aircraftUuid: string,
): Promise<Doc<AircraftTable>[]> {
  if (table === "flights")
    return ctx.db
      .query("flights")
      .withIndex("started", (q) =>
        q.eq("aircraftUuid", aircraftUuid).eq("startedAt", undefined),
      )
      .take(1);
  if (table === "flightPlans")
    return ctx.db
      .query("flightPlans")
      .withIndex("departed", (q) =>
        q.eq("aircraftUuid", aircraftUuid).eq("departedAt", undefined),
      )
      .take(1);
  return ctx.db
    .query("workOrders")
    .withIndex("status", (q) =>
      q.eq("aircraftUuid", aircraftUuid).eq("status", undefined),
    )
    .take(1);
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

// Each source aircraft's fifth latest completion date.
async function readRecentFloors(
  ctx: QueryCtx,
  list: ListScope<"workOrders">,
): Promise<Map<string, string | undefined>> {
  const floors = await Promise.all(
    list.sources.map(
      async (aircraftUuid) =>
        [
          aircraftUuid,
          await readFloor(ctx, list.budget, aircraftUuid),
        ] as const,
    ),
  );
  return new Map(floors);
}

// An aircraft's fifth latest completion date, from the top of its completed
// range (recentCompletionFloor).
async function readFloor(
  ctx: QueryCtx,
  budget: ReadBudget,
  aircraftUuid: string,
): Promise<string | undefined> {
  const latest = await ctx.db
    .query("workOrders")
    .withIndex("status", (q) =>
      q.eq("aircraftUuid", aircraftUuid).eq("status", "completed"),
    )
    .order("desc")
    .take(RECENT_COMPLETED_WORK_ORDERS);
  const dates = budget.spend(latest).map((r) => r.completionDate ?? "");
  return recentCompletionFloor(dates);
}

// The order is judged as historyPage judges it on the caller's scoped
// snapshot: on its scoped job cards and costs. Without them the rule can
// only keep an order, never page it, so a kept order costs no more reads.
async function pickOlderOrder(
  ctx: QueryCtx,
  list: OrderScope,
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
  const [evidence, files, purchasing] = await Promise.all([
    Promise.all(cards.map((c) => readEvidence(ctx, c.uuid))),
    ctx.db
      .query("workOrderFiles")
      .withIndex("workOrder", (q) => q.eq("workOrderUuid", row.uuid))
      .collect(),
    readOrderPurchasing(ctx, activeProgram(state), row.uuid, cards),
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
    ...purchasing,
  };
}

// The requests a work order counts, raised on it or on its job cards, and
// every order allocating them, whose allocations scoping makes purchases.
async function readOrderPurchasing(
  ctx: QueryCtx,
  program: string | undefined,
  workOrderUuid: string,
  cards: { uuid: string }[],
): Promise<Pick<Snapshot, "partsRequests" | "purchaseOrders">> {
  if (!program) return { partsRequests: [], purchaseOrders: [] };
  const requests = await partsRequestDocsOn(ctx, program, {
    workOrderUuids: [workOrderUuid],
    sourceUuids: cards.map((c) => c.uuid),
  });
  const orders = await ordersAllocating(
    ctx,
    program,
    requests.map((r) => r.uuid),
  );
  return {
    partsRequests: decode("partsRequests", requests),
    purchaseOrders: decode("purchaseOrders", orders),
  };
}

// The requests and orders a lookup names, in the active program, with every
// order allocating those requests, whose allocations scoping makes purchases.
async function readNamedPurchasing(
  ctx: QueryCtx,
  program: string | undefined,
  lookup: Pick<RecordLookup, "partsRequestUuids" | "purchaseOrderUuids">,
): Promise<Pick<Snapshot, "partsRequests" | "purchaseOrders">> {
  if (!program) return { partsRequests: [], purchaseOrders: [] };
  const byUuid = <T extends "partsRequests" | "purchaseOrders">(
    table: T,
    uuids: string[] | undefined,
  ) =>
    Promise.all(
      [...new Set(uuids ?? [])].map((uuid) =>
        ctx.db
          .query(table)
          .withIndex("uuid", (q) =>
            (q as unknown as UuidRange).eq("uuid", uuid),
          )
          .take(1),
      ),
    ).then((rows) => rows.flat().filter((r) => r.programUuid === program));
  const [requests, named] = await Promise.all([
    byUuid("partsRequests", lookup.partsRequestUuids),
    byUuid("purchaseOrders", lookup.purchaseOrderUuids),
  ]);
  const uuids = requests.map((r) => r.uuid);
  const allocating = await ordersAllocating(ctx, program, uuids);
  return {
    partsRequests: decode("partsRequests", byCreation(requests)),
    purchaseOrders: decode(
      "purchaseOrders",
      byCreation([...named, ...allocating]),
    ),
  };
}

function byCreation<D extends { _id: string; _creationTime: number }>(
  rows: readonly D[],
): D[] {
  return [...new Map(rows.map((r) => [r._id, r])).values()].sort(
    (a, b) => a._creationTime - b._creationTime,
  );
}

// The flights logged against plans, on the readable aircraft, in the
// workspace's order.
async function planFlightDocs(
  ctx: QueryCtx,
  planUuids: string[],
  fleet: { uuid: string }[],
): Promise<Doc<"flights">[]> {
  const readable = new Set(fleet.map((a) => a.uuid));
  const rows = await Promise.all(
    [...new Set(planUuids)].filter(Boolean).map((uuid) =>
      ctx.db
        .query("flights")
        .withIndex("plan", (q) => q.eq("flightPlanUuid", uuid))
        .collect(),
    ),
  );
  const onFleet = rows.flat().filter((f) => readable.has(f.aircraftUuid));
  return inLoadOrder(onFleet, fleet);
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
