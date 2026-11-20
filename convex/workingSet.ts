/**
 * Responsibility: The bounded reads a save loads instead of whole history
 *   (ADR-0013): records by uuid, a work order's job cards, cards on no work
 *   order, open work orders and problem reports, recent close-outs, a work
 *   order's parts requests and costs, and the highest-numbered request.
 * Layer: Server. Convex reads only, each within the caller's Flight Program;
 *   the rules that use them are the domain's.
 * Dependencies: ./_generated (types).
 *
 * Each loader returns rows in the order a whole-history loader does (by
 * aircraft, then creation time), so an applier that takes the first match
 * finds the same record in a bounded load as in a full one.
 */
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

type Ctx = QueryCtx | MutationCtx;
/** The Flight Program's aircraft, as the caller's context holds them. */
type Fleet = readonly { uuid: string }[];
/** A row kept per aircraft. */
type AircraftRow = { _id: string; _creationTime: number; aircraftUuid: string };

/**
 * Work orders by uuid, on the program's aircraft only, so another program's
 * order reads as missing.
 *
 * @param uuids - Order uuids; blanks and repeats are skipped.
 * @returns In load order.
 */
export const workOrderDocsByUuid = (
  ctx: Ctx,
  uuids: Iterable<string>,
  fleet: Fleet,
) =>
  rowsByUuid(uuids, fleet, (uuid) =>
    ctx.db
      .query("workOrders")
      .withIndex("uuid", (q) => q.eq("uuid", uuid))
      .collect(),
  );

/**
 * Job cards by uuid, on the program's aircraft only.
 *
 * @param uuids - Card uuids; blanks and repeats are skipped.
 * @returns In load order.
 */
export const taskCardDocsByUuid = (
  ctx: Ctx,
  uuids: Iterable<string>,
  fleet: Fleet,
) =>
  rowsByUuid(uuids, fleet, (uuid) =>
    ctx.db
      .query("taskCards")
      .withIndex("uuid", (q) => q.eq("uuid", uuid))
      .collect(),
  );

/**
 * Problem reports by uuid, on the program's aircraft only.
 *
 * @param uuids - Report uuids; blanks and repeats are skipped.
 * @returns In load order.
 */
export const discrepancyDocsByUuid = (
  ctx: Ctx,
  uuids: Iterable<string>,
  fleet: Fleet,
) =>
  rowsByUuid(uuids, fleet, (uuid) =>
    ctx.db
      .query("discrepancies")
      .withIndex("uuid", (q) => q.eq("uuid", uuid))
      .collect(),
  );

/**
 * The job cards of the given work orders, on the program's aircraft.
 *
 * @param orderUuids - Work order uuids; blanks and repeats are skipped.
 * @returns In load order.
 */
export async function workOrderCardDocs(
  ctx: Ctx,
  orderUuids: Iterable<string>,
  fleet: Fleet,
): Promise<Doc<"taskCards">[]> {
  const wanted = [...new Set(orderUuids)].filter(Boolean);
  const rows = await Promise.all(
    wanted.map((uuid) =>
      ctx.db
        .query("taskCards")
        .withIndex("workOrder", (q) => q.eq("workOrderUuid", uuid))
        .collect(),
    ),
  );
  return inLoadOrder(onFleet(rows.flat(), fleet), fleet);
}

/**
 * The archived job cards of the given work orders, on the program's
 * aircraft.
 *
 * @param orderUuids - Work order uuids; blanks and repeats are skipped.
 * @returns In load order.
 */
export async function archivedCardDocs(
  ctx: Ctx,
  orderUuids: Iterable<string>,
  fleet: Fleet,
): Promise<Doc<"archivedTaskCards">[]> {
  const wanted = [...new Set(orderUuids)].filter(Boolean);
  const rows = await Promise.all(
    wanted.map((uuid) =>
      ctx.db
        .query("archivedTaskCards")
        .withIndex("workOrder", (q) => q.eq("workOrderUuid", uuid))
        .collect(),
    ),
  );
  return inLoadOrder(onFleet(rows.flat(), fleet), fleet);
}

/**
 * Archived job cards by uuid, on the program's aircraft only.
 *
 * @param uuids - Card uuids; blanks and repeats are skipped.
 * @returns In load order.
 */
export const archivedCardDocsByUuid = (
  ctx: Ctx,
  uuids: Iterable<string>,
  fleet: Fleet,
) =>
  rowsByUuid(uuids, fleet, (uuid) =>
    ctx.db
      .query("archivedTaskCards")
      .withIndex("uuid", (q) => q.eq("uuid", uuid))
      .collect(),
  );

/**
 * The aircraft's cards on no work order: templates and loose cards, kept
 * whatever their age.
 *
 * @returns In load order.
 */
export async function looseCardDocs(
  ctx: Ctx,
  fleet: Fleet,
): Promise<Doc<"taskCards">[]> {
  const rows = await Promise.all(
    fleet.map(({ uuid }) =>
      ctx.db
        .query("taskCards")
        .withIndex("aircraftWorkOrder", (q) =>
          q.eq("aircraftUuid", uuid).eq("workOrderUuid", ""),
        )
        .collect(),
    ),
  );
  return rows.flat();
}

/**
 * The aircraft's work orders with no closing time: every open order, and an
 * order cancelled with neither a close-out nor a completion date.
 *
 * @returns In load order.
 */
export async function openWorkOrderDocs(
  ctx: Ctx,
  fleet: Fleet,
): Promise<Doc<"workOrders">[]> {
  const rows = await Promise.all(
    fleet.map(({ uuid }) =>
      ctx.db
        .query("workOrders")
        .withIndex("closed", (q) =>
          q.eq("aircraftUuid", uuid).eq("closedAt", undefined),
        )
        .collect(),
    ),
  );
  return rows.flat();
}

/**
 * The aircraft's work orders closed at or after `since`, at most `limit` on
 * each aircraft.
 *
 * @param since - Milliseconds; a row's `closedAt` is never before its
 *   close-out, so every order closed out since then is among them.
 * @param limit - The most rows to read per aircraft.
 * @returns In load order.
 */
export async function workOrdersClosedSince(
  ctx: Ctx,
  fleet: Fleet,
  since: number,
  limit: number,
): Promise<Doc<"workOrders">[]> {
  const rows = await Promise.all(
    fleet.map(({ uuid }) =>
      ctx.db
        .query("workOrders")
        .withIndex("closed", (q) =>
          q.eq("aircraftUuid", uuid).gte("closedAt", since),
        )
        .take(limit),
    ),
  );
  return inLoadOrder(rows.flat(), fleet);
}

/**
 * The aircraft's open problem reports, deferred ones included.
 *
 * @returns In load order.
 */
export async function openDiscrepancyDocs(
  ctx: Ctx,
  fleet: Fleet,
): Promise<Doc<"discrepancies">[]> {
  const rows = await Promise.all(
    fleet.map(({ uuid }) =>
      ctx.db
        .query("discrepancies")
        .withIndex("status", (q) =>
          q.eq("aircraftUuid", uuid).eq("status", "open"),
        )
        .collect(),
    ),
  );
  return rows.flat();
}

/**
 * A Flight Program's parts requests raised on the given work orders or with
 * the given sources.
 *
 * @param on - `workOrderUuids` match a request's source work order;
 *   `sourceUuids` its source record. Blanks are skipped.
 * @returns Each once, in the program loader's order (creation time).
 */
export async function partsRequestDocsOn(
  ctx: Ctx,
  programUuid: string,
  on: { workOrderUuids: Iterable<string>; sourceUuids: Iterable<string> },
): Promise<Doc<"partsRequests">[]> {
  const byOrder = [...new Set(on.workOrderUuids)].filter(Boolean);
  const bySource = [...new Set(on.sourceUuids)].filter(Boolean);
  const rows = await Promise.all([
    ...byOrder.map((uuid) =>
      ctx.db
        .query("partsRequests")
        .withIndex("sourceWorkOrder", (q) => q.eq("sourceWorkOrderUuid", uuid))
        .collect(),
    ),
    ...bySource.map((uuid) =>
      ctx.db
        .query("partsRequests")
        .withIndex("source", (q) => q.eq("sourceUuid", uuid))
        .collect(),
    ),
  ]);
  const inProgram = rows.flat().filter((r) => r.programUuid === programUuid);
  return byCreation(unique(inProgram));
}

/**
 * A Flight Program's cost records of the given work orders, then its
 * budgets and labor-rate settings, in the program loader's order: records on
 * an aircraft first, the settings row (aircraft "") last.
 *
 * @param workOrderUuids - Work order uuids; blanks and repeats are skipped.
 */
export async function workOrderCostDocs(
  ctx: Ctx,
  programUuid: string,
  workOrderUuids: Iterable<string>,
): Promise<Doc<"costs">[]> {
  const ofKind = (kind: "budget" | "settings") =>
    ctx.db
      .query("costs")
      .withIndex("kind", (q) =>
        q.eq("programUuid", programUuid).eq("kind", kind),
      )
      .collect();
  const ofOrder = (uuid: string) =>
    ctx.db
      .query("costs")
      .withIndex("workOrder", (q) => q.eq("workOrderUuid", uuid))
      .collect();
  const orders = [...new Set(workOrderUuids)].filter(Boolean);
  const [budgets, settings, ...ofOrders] = await Promise.all([
    ofKind("budget"),
    ofKind("settings"),
    ...orders.map(ofOrder),
  ]);
  const rows = unique([
    ...ofOrders.flat().filter((r) => r.programUuid === programUuid),
    ...budgets,
    ...settings,
  ]);
  return [
    ...byProgramOrder(rows.filter((r) => r.aircraftUuid)),
    ...byProgramOrder(rows.filter((r) => !r.aircraftUuid)),
  ];
}

/**
 * The Flight Program's parts request holding the highest number, which the
 * next number continues from.
 *
 * @returns None or one.
 */
export function highestRequestDocs(ctx: Ctx, programUuid: string) {
  return ctx.db
    .query("partsRequests")
    .withIndex("number", (q) => q.eq("programUuid", programUuid))
    .order("desc")
    .take(1);
}

/**
 * Rows from several bounded reads as one whole-history load holds them:
 * each once, by aircraft in the program's order, then by creation time.
 */
export function inLoadOrder<D extends AircraftRow>(
  rows: readonly D[],
  fleet: Fleet,
): D[] {
  const position = new Map(fleet.map((a, i) => [a.uuid, i]));
  return unique(rows).sort(
    (a, b) =>
      position.get(a.aircraftUuid)! - position.get(b.aircraftUuid)! ||
      a._creationTime - b._creationTime,
  );
}

async function rowsByUuid<D extends AircraftRow>(
  uuids: Iterable<string>,
  fleet: Fleet,
  read: (uuid: string) => Promise<D[]>,
): Promise<D[]> {
  const wanted = [...new Set(uuids)].filter(Boolean);
  const rows = await Promise.all(wanted.map(read));
  return inLoadOrder(onFleet(rows.flat(), fleet), fleet);
}

function onFleet<D extends { aircraftUuid: string }>(
  rows: readonly D[],
  fleet: Fleet,
): D[] {
  const ids = new Set(fleet.map((a) => a.uuid));
  return rows.filter((r) => ids.has(r.aircraftUuid));
}

function unique<D extends { _id: string }>(rows: readonly D[]): D[] {
  return [...new Map(rows.map((r) => [r._id, r])).values()];
}

function byCreation<D extends { _creationTime: number }>(rows: D[]): D[] {
  return rows.sort((a, b) => a._creationTime - b._creationTime);
}

// The program index orders cost records by aircraft uuid (as code units,
// like the index's ASCII uuids), then creation.
function byProgramOrder(rows: Doc<"costs">[]): Doc<"costs">[] {
  return rows.sort(
    (a, b) =>
      Number(a.aircraftUuid > b.aircraftUuid) -
        Number(a.aircraftUuid < b.aircraftUuid) ||
      a._creationTime - b._creationTime,
  );
}
