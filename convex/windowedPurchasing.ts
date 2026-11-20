/**
 * Responsibility: Reads what the workspace's retention window can keep of a
 *   Flight Program's parts requests, purchase orders and flight plans, and
 *   all that decides it, instead of every one (H5).
 * Layer: Server. Convex reads by the window's indexes; the rule that picks
 *   from them is the domain's (workspaceWindow, src/domain/purchasingWindow).
 * Dependencies: ./_generated (types), ./collections, ./programContext,
 *   ./workingSet, ./purchaseAllocations, ./historyWindow (types),
 *   src/domain (retention, purchasingWindow).
 *
 * As in historyWindow.ts, each read is a superset of what the window keeps,
 * holding every record its rule reads, and rows a derived column is missing
 * on are read too, so before migrations:backfillHistoryColumns the load is
 * larger, never short. One limit stays: a repair, or a restock received
 * rather than issued, is settled by its orders' receipts, which its row
 * cannot show, so each such request and its orders are read for good
 * (docs/history-paging.md).
 */
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { decode } from "./collections";
import { perAircraft } from "./programContext";
import { inLoadOrder } from "./workingSet";
import { ordersAllocating } from "./purchasingKeys";
import type { WindowScope } from "./historyWindow";
import { windowCutoffs, type HistoryRecords } from "../src/domain/retention";
import {
  allocatedRequests,
  isOpenPurchaseOrder,
} from "../src/domain/purchasingWindow";

type Ctx = QueryCtx | MutationCtx;
type Fleet = WindowScope["fleet"];
type RequestRow = Doc<"partsRequests">;
type OrderRow = Doc<"purchaseOrders">;

/** What the window's other reads found that purchasing follows. */
export type WindowedWork = Pick<
  HistoryRecords,
  "flights" | "workOrders" | "taskCards" | "archivedTaskCards"
>;

/** The purchasing collections a windowed load reads. */
export type WindowedPurchasing = Pick<
  HistoryRecords,
  "flightPlans" | "partsRequests" | "purchaseOrders"
>;

/**
 * The parts requests, purchase orders and flight plans the window can keep,
 * with every order allocating a request it may keep, so each request's
 * progress is whole.
 *
 * - Requests, per readable aircraft and for stock: those that may be open,
 *   those settled since the cutoff or since a loaded work order (or one of
 *   its job cards) began, which covers every request it counts, and those
 *   an open order allocates.
 * - Orders: open or settled since the cutoff, and those allocating a loaded
 *   request created before the cutoff. One created after it was allocated
 *   by an order saved after it, so changed since the cutoff.
 * - Plans, per readable aircraft: departing from the flight cutoff on,
 *   created since the cutoff, and those the loaded flights were logged
 *   against.
 *
 * @param scope - The program, its aircraft and those the caller may read;
 *   without a program, nothing.
 * @param work - The flights, work orders and job cards the window's other
 *   reads loaded.
 * @param now - The current time, in milliseconds.
 * @returns Requests and orders in the program loader's order (creation),
 *   plans by aircraft, then creation.
 * @throws {z.ZodError} When a stored payload no longer parses.
 */
export async function windowedPurchasing(
  ctx: Ctx,
  scope: WindowScope,
  work: WindowedWork,
  now: number,
): Promise<WindowedPurchasing> {
  const { program, fleet, readable } = scope;
  const plans = await windowedPlanDocs(ctx, readable, work.flights, now);
  const flightPlans = decode("flightPlans", inLoadOrder(plans, fleet));
  if (!program) return { flightPlans, partsRequests: [], purchaseOrders: [] };
  const { closed } = windowCutoffs(now);
  const [found, settled] = await Promise.all([
    candidateRequestDocs(ctx, program, readable, work, closed),
    settledOrderDocs(ctx, program, closed),
  ]);
  const named = await requestsOfOpenOrders(ctx, program, settled, found);
  const partsRequests = decode(
    "partsRequests",
    byCreation([...found, ...named]),
  );
  const allocating = await ordersAllocating(
    ctx,
    program,
    partsRequests
      .filter((r) => r.createdAt < closed && !r.recurring)
      .map((r) => r.uuid),
  );
  return {
    flightPlans,
    partsRequests,
    purchaseOrders: decode(
      "purchaseOrders",
      byCreation([...settled, ...allocating]),
    ),
  };
}

// Per aircraft: the requests that may be open (and the lists, which always
// may), and those settled since the cutoff or since the earliest loaded work
// order or job card on it, whichever is earlier: a request settles no
// earlier than it was raised. And every row the backfill has not filled,
// whose aircraft column is absent.
async function candidateRequestDocs(
  ctx: Ctx,
  program: string,
  readable: Fleet,
  work: WindowedWork,
  cutoff: number,
): Promise<RequestRow[]> {
  const since = workStarts(work);
  const sources = [...readable.map((a) => a.uuid), ""];
  const rows = await Promise.all([
    ...sources.map((aircraftUuid) =>
      settledSince(
        ctx,
        program,
        aircraftUuid,
        Math.min(cutoff, since.get(aircraftUuid) ?? cutoff),
      ),
    ),
    unfilledRequests(ctx, program),
  ]);
  return rows.flat();
}

function settledSince(
  ctx: Ctx,
  program: string,
  aircraftUuid: string,
  from: number,
): Promise<RequestRow[]> {
  const range = () => ctx.db.query("partsRequests");
  return Promise.all([
    range()
      .withIndex("settled", (q) =>
        q
          .eq("programUuid", program)
          .eq("aircraftUuid", aircraftUuid)
          .eq("settledAt", undefined),
      )
      .collect(),
    range()
      .withIndex("settled", (q) =>
        q
          .eq("programUuid", program)
          .eq("aircraftUuid", aircraftUuid)
          .gte("settledAt", from),
      )
      .collect(),
  ]).then((found) => found.flat());
}

function unfilledRequests(ctx: Ctx, program: string): Promise<RequestRow[]> {
  return ctx.db
    .query("partsRequests")
    .withIndex("settled", (q) =>
      q.eq("programUuid", program).eq("aircraftUuid", undefined),
    )
    .collect();
}

// A request a work order counts was raised on one of its tasks or job cards,
// so no earlier than the order, or than the card, which may predate it.
function workStarts(work: WindowedWork): Map<string, number> {
  const starts = new Map<string, number>();
  const note = (aircraftUuid: string, at: number) =>
    starts.set(aircraftUuid, Math.min(at, starts.get(aircraftUuid) ?? at));
  for (const w of work.workOrders) note(w.aircraftUuid, w.recordedAt);
  for (const c of [...work.taskCards, ...work.archivedTaskCards])
    note(c.aircraftUuid, c.createdAt);
  return starts;
}

// Orders that may be open, those settled since the cutoff, and every order
// the backfill has not filled.
async function settledOrderDocs(
  ctx: Ctx,
  program: string,
  cutoff: number,
): Promise<OrderRow[]> {
  const range = () => ctx.db.query("purchaseOrders");
  const [open, recent] = await Promise.all([
    range()
      .withIndex("settled", (q) =>
        q.eq("programUuid", program).eq("settledAt", undefined),
      )
      .collect(),
    range()
      .withIndex("settled", (q) =>
        q.eq("programUuid", program).gte("settledAt", cutoff),
      )
      .collect(),
  ]);
  return [...open, ...recent];
}

// The requests open orders allocate that no other read found.
async function requestsOfOpenOrders(
  ctx: Ctx,
  program: string,
  orders: OrderRow[],
  found: RequestRow[],
): Promise<RequestRow[]> {
  const loaded = new Set(found.map((r) => r.uuid));
  const wanted = decode("purchaseOrders", orders)
    .filter(isOpenPurchaseOrder)
    .flatMap(allocatedRequests)
    .filter((uuid) => !loaded.has(uuid));
  const rows = await Promise.all(
    [...new Set(wanted)].map((uuid) =>
      ctx.db
        .query("partsRequests")
        .withIndex("uuid", (q) => q.eq("uuid", uuid))
        .first(),
    ),
  );
  return rows.filter((r): r is RequestRow => r?.programUuid === program);
}

// Plans still to fly or departed within the flight window, those created
// since the cutoff, the rows the backfill has not filled, and the plans the
// loaded flights were logged against.
async function windowedPlanDocs(
  ctx: Ctx,
  readable: Fleet,
  flights: WindowedWork["flights"],
  now: number,
): Promise<Doc<"flightPlans">[]> {
  const { closed, flights: flown } = windowCutoffs(now);
  const plans = () => ctx.db.query("flightPlans");
  const ranged = await perAircraft(readable, async (id) =>
    (
      await Promise.all([
        plans()
          .withIndex("departed", (q) =>
            q.eq("aircraftUuid", id).gte("departedAt", flown),
          )
          .collect(),
        plans()
          .withIndex("departed", (q) =>
            q.eq("aircraftUuid", id).eq("departedAt", undefined),
          )
          .collect(),
        plans()
          .withIndex("created", (q) =>
            q.eq("aircraftUuid", id).gte("createdAt", closed),
          )
          .collect(),
      ])
    ).flat(),
  );
  return [...ranged, ...(await flownPlanDocs(ctx, readable, flights))];
}

function flownPlanDocs(
  ctx: Ctx,
  readable: Fleet,
  flights: WindowedWork["flights"],
): Promise<Doc<"flightPlans">[]> {
  const ids = new Set(readable.map((a) => a.uuid));
  const uuids = new Set(flights.flatMap((f) => f.flightPlanUuid ?? []));
  return Promise.all(
    [...uuids].map((uuid) =>
      ctx.db
        .query("flightPlans")
        .withIndex("uuid", (q) => q.eq("uuid", uuid))
        .first(),
    ),
  ).then((rows) =>
    rows.filter((p): p is Doc<"flightPlans"> => !!p && ids.has(p.aircraftUuid)),
  );
}

function byCreation<D extends { _id: string; _creationTime: number }>(
  rows: readonly D[],
): D[] {
  return [...new Map(rows.map((r) => [r._id, r])).values()].sort(
    (a, b) => a._creationTime - b._creationTime,
  );
}
