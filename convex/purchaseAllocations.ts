/**
 * Responsibility: The purchaseAllocations rows: which parts requests each
 *   purchase order allocates, kept in step with the order, and the orders
 *   that allocate given requests.
 * Layer: Server. Convex reads and writes of a derived table; never a record,
 *   so never the change log.
 * Dependencies: convex/values (types), ./_generated (types), src/domain
 *   (purchasingWindow, purchaseOrders types).
 *
 * An order's lines hold its allocations, which no index can reach, so a
 * request's orders (its progress, and the orders the window keeps for it,
 * ADR-0013 H5) are found here instead of by reading every order.
 */
import type { Value } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { allocatedRequests } from "../src/domain/purchasingWindow";
import type { PurchaseOrder } from "../src/domain/purchaseOrders";

type Ctx = QueryCtx | MutationCtx;
type Row = { [field: string]: Value | undefined };

/**
 * Brings an order's allocation rows in step with its record: one row per
 * request its lines allocate, in the order's program. Writes nothing when
 * they already are.
 *
 * @param p - The order as stored.
 * @returns Whether any row was written or deleted.
 */
export async function syncPurchaseAllocations(
  ctx: MutationCtx,
  p: Pick<PurchaseOrder, "uuid" | "programUuid" | "lines">,
): Promise<boolean> {
  const wanted = new Set(allocatedRequests(p));
  const stored = await ctx.db
    .query("purchaseAllocations")
    .withIndex("order", (q) => q.eq("poUuid", p.uuid))
    .collect();
  const kept = new Set<string>();
  let changed = false;
  for (const row of stored) {
    const holds = wanted.has(row.requestUuid) && !kept.has(row.requestUuid);
    if (holds && row.programUuid === p.programUuid) {
      kept.add(row.requestUuid);
      continue;
    }
    await ctx.db.delete(row._id);
    changed = true;
  }
  for (const requestUuid of wanted) {
    if (kept.has(requestUuid)) continue;
    await ctx.db.insert("purchaseAllocations", {
      programUuid: p.programUuid,
      poUuid: p.uuid,
      requestUuid,
    });
    changed = true;
  }
  return changed;
}

/** Counts each read against a request's budget (historyScan's ReadBudget). */
export interface ReadSpender {
  spend<T extends Row>(rows: T[]): T[];
}

/**
 * The program's purchase orders whose lines allocate any of the requests.
 *
 * @param programUuid - The active Flight Program; orders of another are
 *   left out.
 * @param requestUuids - The requests; repeats are read once.
 * @param budget - Counts the reads, when a paged query bounds them.
 * @returns Each order once, in the program loader's order (creation time).
 */
export async function ordersAllocating(
  ctx: Ctx,
  programUuid: string,
  requestUuids: Iterable<string>,
  budget?: ReadSpender,
): Promise<Doc<"purchaseOrders">[]> {
  const spend = <T extends Row>(rows: T[]) => budget?.spend(rows) ?? rows;
  const rows = await Promise.all(
    [...new Set(requestUuids)].map(async (requestUuid) =>
      spend(
        await ctx.db
          .query("purchaseAllocations")
          .withIndex("request", (q) => q.eq("requestUuid", requestUuid))
          .collect(),
      ),
    ),
  );
  const orders = new Set(
    rows.flat().flatMap((r) => (r.programUuid === programUuid ? r.poUuid : [])),
  );
  const found = await Promise.all(
    [...orders].map(async (uuid) =>
      spend(
        await ctx.db
          .query("purchaseOrders")
          .withIndex("uuid", (q) => q.eq("uuid", uuid))
          .take(1),
      ),
    ),
  );
  return found
    .flat()
    .filter((p) => p.programUuid === programUuid)
    .sort((a, b) => a._creationTime - b._creationTime);
}
