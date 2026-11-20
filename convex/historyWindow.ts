/**
 * Responsibility: Reads what the workspace's retention window can keep of a
 *   Flight Program's history, and everything that decides it, instead of
 *   the whole history.
 * Layer: Server. Convex reads by the window's indexes; the rule that picks
 *   from them is the domain's (workspaceWindow, retainedSnapshot).
 * Dependencies: ./_generated (types), ./collections, ./programContext,
 *   ./workingSet, src/domain/retention.
 *
 * Each read is a superset of what the window keeps, holding every record the
 * keep-or-page decision reads, so the domain rule over it picks exactly what
 * it picks over whole history (ADR-0013). Rows a derived column is missing
 * on are read too: before migrations:backfillHistoryColumns the load is
 * larger, never short.
 */
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { decode, decodeFlight } from "./collections";
import { perAircraft } from "./programContext";
import {
  archivedCardDocs,
  inCostLoadOrder,
  inLoadOrder,
  looseCardDocs,
  openDiscrepancyDocs,
  openWorkOrderDocs,
  workOrderCardDocs,
  workOrderCostDocs,
  workOrderDocsByUuid,
} from "./workingSet";
import {
  FLIGHT_RETENTION_DAYS,
  RECENT_COMPLETED_WORK_ORDERS,
  RETENTION_DAYS,
  recentCompletionFloor,
  retentionCutoff,
  type HistoryRecords,
} from "../src/domain/retention";

type Ctx = QueryCtx | MutationCtx;
/** The Flight Program's aircraft, as the caller's context holds them. */
type Fleet = readonly { uuid: string }[];

/** What a windowed load reads within. */
export interface WindowScope {
  /** The active Flight Program; none reads no cost records. */
  program: string | undefined;
  /** Every aircraft of the program. */
  fleet: Fleet;
  /** Those of them the caller may read, whose history is read. */
  readable: Fleet;
}

/**
 * The flights, problem reports, work orders, job cards, archived job cards
 * and cost records of the caller's aircraft that the window can keep, with
 * each work order's job cards, archived job cards and costs, the program's
 * budgets and labor rate, and the cost records of aircraft that have left
 * the program, which the window always keeps.
 *
 * Judged on the caller's scoped records, the window reads nothing of an
 * aircraft they may not read, so neither does this load.
 *
 * @param scope - The program, its aircraft and those the caller may read.
 * @param now - The current time, in milliseconds.
 * @returns Each collection in the order the whole-history loaders return it
 *   (by aircraft, then creation; cost records as costDocs orders them),
 *   flights without their derived columns.
 * @throws {z.ZodError} When a stored payload no longer parses.
 */
export async function windowedHistory(
  ctx: Ctx,
  scope: WindowScope,
  now: number,
): Promise<HistoryRecords> {
  const { program, readable } = scope;
  const cutoff = retentionCutoff(now, RETENTION_DAYS);
  const [flights, reduced, cards, costs] = await Promise.all([
    windowedFlights(ctx, readable, now),
    windowedReducedHistory(ctx, readable, now),
    changedCardDocs(ctx, readable, cutoff),
    program ? changedCostDocs(ctx, program, cutoff) : [],
  ]);
  const held = new Set(reduced.workOrders.map((w) => w.uuid));
  const named = await workOrderDocsByUuid(
    ctx,
    namedOrders(cards, costs).filter((uuid) => !held.has(uuid)),
    readable,
  );
  const orders = inLoadOrder([...reduced.workOrders, ...named], readable);
  const dependents = await orderDependents(ctx, scope, orders);
  return {
    flights,
    discrepancies: reduced.discrepancies,
    workOrders: decode("workOrders", orders),
    taskCards: decode(
      "taskCards",
      inLoadOrder([...cards, ...dependents.taskCards], readable),
    ),
    archivedTaskCards: decode("archivedTaskCards", dependents.archived),
    costs: decode("costs", inCostLoadOrder([...dependents.costs, ...costs])),
  };
}

/**
 * The problem reports and work orders the window can keep on their own
 * fields, as a reduced view, which holds no job cards or costs, judges them.
 *
 * @param fleet - The program's aircraft.
 * @param now - The current time, in milliseconds.
 * @returns Both in the whole-history loaders' order; work orders as rows.
 */
export async function windowedReducedHistory(
  ctx: Ctx,
  fleet: Fleet,
  now: number,
): Promise<{
  discrepancies: Doc<"discrepancies">[];
  workOrders: Doc<"workOrders">[];
}> {
  const cutoff = retentionCutoff(now, RETENTION_DAYS);
  const [reports, orders] = await Promise.all([
    windowedReportDocs(ctx, fleet, cutoff),
    windowedOrderDocs(ctx, fleet, cutoff),
  ]);
  return { discrepancies: reports, workOrders: orders };
}

// The work orders changed job cards and cost records belong to, from their
// records: a row written before its columns has no workOrderUuid column.
function namedOrders(cards: Doc<"taskCards">[], costs: Doc<"costs">[]) {
  return [
    ...decode("taskCards", cards).map((c) => c.workOrderUuid),
    ...decode("costs", costs).flatMap((c) =>
      c.kind === "workOrder" ? [c.workOrderUuid] : [],
    ),
  ];
}

// Every job card, archived job card and cost record of the orders, the
// program's budgets and labor rate, and the cost records of aircraft that
// left the program.
async function orderDependents(
  ctx: Ctx,
  { program, fleet, readable }: WindowScope,
  orders: Doc<"workOrders">[],
) {
  const uuids = orders.map((w) => w.uuid);
  const [taskCards, archived, unfilled, costs, departed] = await Promise.all([
    workOrderCardDocs(ctx, uuids, readable),
    archivedCardDocs(ctx, uuids, readable),
    unfilledArchivedDocs(ctx, readable),
    program ? workOrderCostDocs(ctx, program, uuids) : [],
    program ? departedCostDocs(ctx, program, fleet) : [],
  ]);
  return {
    taskCards,
    archived: inLoadOrder([...archived, ...unfilled], readable),
    costs: [...costs, ...departed],
  };
}

// Held flights, and those started or submitted from the flight cutoff on
// (latestAt is the later of the two); a row without the column is read until
// the backfill fills it.
async function windowedFlights(ctx: Ctx, fleet: Fleet, now: number) {
  const cutoff = retentionCutoff(now, FLIGHT_RETENTION_DAYS);
  const flights = () => ctx.db.query("flights");
  const rows = await perAircraft(fleet, async (id) =>
    (
      await Promise.all([
        flights()
          .withIndex("status", (q) =>
            q.eq("aircraftUuid", id).eq("status", "review"),
          )
          .collect(),
        flights()
          .withIndex("latest", (q) =>
            q.eq("aircraftUuid", id).gte("latestAt", cutoff),
          )
          .collect(),
        flights()
          .withIndex("latest", (q) =>
            q.eq("aircraftUuid", id).eq("latestAt", undefined),
          )
          .collect(),
      ])
    ).flat(),
  );
  return inLoadOrder(rows, fleet).map(decodeFlight);
}

// Open reports, deferred ones included, and resolved ones created or resolved
// from the cutoff on. A deferral needs an open report and resolving stamps
// resolvedAt (src/domain/deferrals.ts), so a resolved report deferred in the
// window was resolved in it too.
async function windowedReportDocs(ctx: Ctx, fleet: Fleet, cutoff: number) {
  const reports = () => ctx.db.query("discrepancies");
  const changed = await perAircraft(fleet, async (id) =>
    (
      await Promise.all([
        reports()
          .withIndex("status", (q) =>
            q
              .eq("aircraftUuid", id)
              .eq("status", "resolved")
              .gte("createdAt", cutoff),
          )
          .collect(),
        reports()
          .withIndex("resolved", (q) =>
            q.eq("aircraftUuid", id).gte("resolvedAt", cutoff),
          )
          .collect(),
      ])
    ).flat(),
  );
  return inLoadOrder(
    [...(await openDiscrepancyDocs(ctx, fleet)), ...changed],
    fleet,
  );
}

// Orders without a closing time (every open one), those whose own events
// reach the cutoff, and the latest completed with every tie: the window keeps
// all of them on their fields alone. A row without its changedAt column is
// read until the backfill fills it.
async function windowedOrderDocs(ctx: Ctx, fleet: Fleet, cutoff: number) {
  const orders = () => ctx.db.query("workOrders");
  const changed = await perAircraft(fleet, async (id) =>
    (
      await Promise.all([
        orders()
          .withIndex("changed", (q) =>
            q.eq("aircraftUuid", id).gte("changedAt", cutoff),
          )
          .collect(),
        orders()
          .withIndex("changed", (q) =>
            q.eq("aircraftUuid", id).eq("changedAt", undefined),
          )
          .collect(),
        latestCompletedDocs(ctx, id),
      ])
    ).flat(),
  );
  return inLoadOrder(
    [...(await openWorkOrderDocs(ctx, fleet)), ...changed],
    fleet,
  );
}

// Every completed order from the fifth latest completion date on, so orders
// tied with the fifth are all read (recentCompletionFloor).
async function latestCompletedDocs(ctx: Ctx, aircraftUuid: string) {
  const completed = () =>
    ctx.db
      .query("workOrders")
      .withIndex("status", (q) =>
        q.eq("aircraftUuid", aircraftUuid).eq("status", "completed"),
      );
  const latest = await completed()
    .order("desc")
    .take(RECENT_COMPLETED_WORK_ORDERS);
  const floor = recentCompletionFloor(
    latest.map((w) => w.completionDate ?? ""),
  );
  if (floor === undefined) return [];
  return ctx.db
    .query("workOrders")
    .withIndex("status", (q) =>
      q
        .eq("aircraftUuid", aircraftUuid)
        .eq("status", "completed")
        .gte("completionDate", floor),
    )
    .collect();
}

// Open job cards, those closed from the cutoff on (a closed card takes no
// more edits, so its closedAt is its last change) and every card on no work
// order. A card written before its columns has no closedAt, so it is read
// with the open ones.
async function changedCardDocs(ctx: Ctx, fleet: Fleet, cutoff: number) {
  const cards = () => ctx.db.query("taskCards");
  const rows = await perAircraft(fleet, async (id) =>
    (
      await Promise.all([
        cards()
          .withIndex("closed", (q) =>
            q.eq("aircraftUuid", id).eq("closedAt", undefined),
          )
          .collect(),
        cards()
          .withIndex("closed", (q) =>
            q.eq("aircraftUuid", id).gte("closedAt", cutoff),
          )
          .collect(),
      ])
    ).flat(),
  );
  return inLoadOrder([...rows, ...(await looseCardDocs(ctx, fleet))], fleet);
}

// Archived cards written before their columns, which the by-order read
// cannot find; none once the backfill has run.
function unfilledArchivedDocs(ctx: Ctx, fleet: Fleet) {
  return perAircraft(fleet, (id) =>
    ctx.db
      .query("archivedTaskCards")
      .withIndex("number", (q) =>
        q.eq("aircraftUuid", id).eq("numberKey", undefined),
      )
      .collect(),
  );
}

// The program's work-order cost records with an entry from the cutoff on,
// and those written before their columns.
async function changedCostDocs(ctx: Ctx, program: string, cutoff: number) {
  const costs = () => ctx.db.query("costs");
  const [changed, unstamped, unfilled] = await Promise.all([
    costs()
      .withIndex("kind", (q) =>
        q
          .eq("programUuid", program)
          .eq("kind", "workOrder")
          .gte("changedAt", cutoff),
      )
      .collect(),
    costs()
      .withIndex("kind", (q) =>
        q
          .eq("programUuid", program)
          .eq("kind", "workOrder")
          .eq("changedAt", undefined),
      )
      .collect(),
    costs()
      .withIndex("kind", (q) =>
        q.eq("programUuid", program).eq("kind", undefined),
      )
      .collect(),
  ]);
  return [...changed, ...unstamped, ...unfilled];
}

// The program's cost records on aircraft no longer in it. They stay with the
// program that paid (decision D14) while their work orders leave with the
// aircraft, so the window, which keeps a cost of an order it does not hold,
// keeps them all. One row per aircraft that ever had costs finds them.
async function departedCostDocs(ctx: Ctx, program: string, fleet: Fleet) {
  const current = new Set(fleet.map((a) => a.uuid));
  const departed: Doc<"costs">[] = [];
  let after = "";
  for (;;) {
    const next = await ctx.db
      .query("costs")
      .withIndex("program", (q) =>
        q.eq("programUuid", program).gt("aircraftUuid", after),
      )
      .first();
    if (!next) return departed;
    after = next.aircraftUuid;
    if (current.has(after)) continue;
    departed.push(
      ...(await ctx.db
        .query("costs")
        .withIndex("program", (q) =>
          q.eq("programUuid", program).eq("aircraftUuid", after),
        )
        .collect()),
    );
  }
}
