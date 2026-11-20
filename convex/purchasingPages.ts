/**
 * Responsibility: What the purchasing history pages read: the index ranges of
 *   older parts requests, purchase orders and flight plans, and the judge
 *   that decides, row by row, whether the window keeps a request or order.
 * Layer: Server. Convex reads for convex/history.ts; the rules are the
 *   domain's (src/domain/purchasingWindow, retention).
 * Dependencies: ./_generated (types), ./collections, ./historyScan,
 *   ./purchaseAllocations, src/domain (retention, purchasingWindow,
 *   partsRequests, programs, model).
 *
 * A row is judged as historyPage judges it on the caller's scoped snapshot
 * (ADR-0013): a request on its own fields, its orders' allocations and the
 * work order it counts toward; an order on its own fields and the requests
 * it allocates. Each read spends the page's budget.
 */
import type { QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { decode } from "./collections";
import { rangeAfter, type ReadBudget } from "./historyScan";
import { ordersAllocating } from "./purchasingKeys";
import { windowCutoffs } from "../src/domain/retention";
import { isKeptRequest, requestActivity } from "../src/domain/purchasingWindow";
import {
  requestMatchesSource,
  requestPurchases,
  type PartsRequest,
  type RequestSource,
} from "../src/domain/partsRequests";
import { programPermission, scopedSnapshot } from "../src/domain/programs";
import type { Snapshot } from "../src/domain/model";

type UuidTable =
  "partsRequests" | "workOrders" | "taskCards" | "archivedTaskCards";
// The one index range #readByUuid opens, which Convex's types cannot name
// for a table chosen at run time.
type UuidRange = { eq(field: "uuid", value: string): never };

/** What a judge reads within: the caller's checked context. */
export interface JudgeScope {
  /** The caller's program context, as checkContext returned it. */
  state: Snapshot;
  /** The active Flight Program. */
  program: string;
  /** The aircraft the caller may read. */
  readable: ReadonlySet<string>;
  now: number;
  budget: ReadBudget;
  /** Whether the window keeps a work order, judged as the work-order pages
   * judge it; false for one the caller may not read. */
  keepsOrder: (workOrderUuid: string) => Promise<boolean>;
}

/** A request the window leaves out, with the orders allocating it. */
export interface OlderRequest {
  request: PartsRequest;
  /** In creation order. */
  orders: Doc<"purchaseOrders">[];
}

/**
 * An aircraft's parts requests ("" for stock) newest first by creation, as
 * the `created` index orders them.
 */
export function requestRange(
  ctx: QueryCtx,
  budget: ReadBudget,
  program: string,
  aircraftUuid: string,
) {
  const range = () => ctx.db.query("partsRequests");
  return rangeAfter<Doc<"partsRequests">, number>(
    budget,
    (key, uuid, limit) =>
      range()
        .withIndex("created", (q) =>
          q
            .eq("programUuid", program)
            .eq("aircraftUuid", aircraftUuid)
            .eq("createdAt", key)
            .lt("uuid", uuid),
        )
        .order("desc")
        .take(limit),
    (key, limit) =>
      range()
        .withIndex("created", (q) =>
          q
            .eq("programUuid", program)
            .eq("aircraftUuid", aircraftUuid)
            .lt("createdAt", key),
        )
        .order("desc")
        .take(limit),
  );
}

/** A program's purchase orders newest first by creation. */
export function orderRange(ctx: QueryCtx, budget: ReadBudget, program: string) {
  const range = () => ctx.db.query("purchaseOrders");
  return rangeAfter<Doc<"purchaseOrders">, number>(
    budget,
    (key, uuid, limit) =>
      range()
        .withIndex("created", (q) =>
          q.eq("programUuid", program).eq("createdAt", key).lt("uuid", uuid),
        )
        .order("desc")
        .take(limit),
    (key, limit) =>
      range()
        .withIndex("created", (q) =>
          q.eq("programUuid", program).lt("createdAt", key),
        )
        .order("desc")
        .take(limit),
  );
}

/** An aircraft's flight plans newest first by departure. */
export function planRange(
  ctx: QueryCtx,
  budget: ReadBudget,
  aircraftUuid: string,
) {
  const range = () => ctx.db.query("flightPlans");
  return rangeAfter<Doc<"flightPlans">, number>(
    budget,
    (key, uuid, limit) =>
      range()
        .withIndex("departed", (q) =>
          q
            .eq("aircraftUuid", aircraftUuid)
            .eq("departedAt", key)
            .lt("uuid", uuid),
        )
        .order("desc")
        .take(limit),
    (key, limit) =>
      range()
        .withIndex("departed", (q) =>
          q.eq("aircraftUuid", aircraftUuid).lt("departedAt", key),
        )
        .order("desc")
        .take(limit),
  );
}

/**
 * The column a list's index orders by, which encode derives from the
 * record: a row without it was written before the backfill.
 *
 * @throws {Error} "<table> <uuid> has no <column> column." for such a row.
 */
export function columnPosition<
  R extends { uuid: string } & Partial<Record<C, number>>,
  C extends string,
>(row: R, column: C, table: string): [number, string] {
  const key = row[column];
  if (key === undefined)
    throw new Error(`${table} ${row.uuid} has no ${column} column.`);
  return [key as number, row.uuid];
}

/**
 * Judges the requests and orders of one page, reading each record once.
 */
export class PurchasingJudge {
  readonly #ctx: QueryCtx;
  readonly #scope: JudgeScope;
  readonly #requests = new Map<string, Promise<boolean>>();
  readonly #cards = new Map<string, Promise<string>>();

  /**
   * @param scope - The caller's context and the page's budget.
   */
  constructor(ctx: QueryCtx, scope: JudgeScope) {
    this.#ctx = ctx;
    this.#scope = scope;
  }

  /**
   * A request the window leaves out, with its orders; null when it keeps
   * it. The request must be one the caller may read.
   *
   * @param r - The request.
   */
  async olderRequest(r: PartsRequest): Promise<OlderRequest | null> {
    const { closed } = windowCutoffs(this.#scope.now);
    if (r.recurring || requestActivity(r) >= closed) return null;
    if (await this.#countsTowardKeptWork(r)) return null;
    const orders = await this.#ordersOf(r.uuid);
    const purchases = requestPurchases(decode("purchaseOrders", orders)).filter(
      (a) => a.requestUuid === r.uuid,
    );
    const context = { purchases, countsTowardKeptWork: false };
    if (isKeptRequest(this.#scope.state, r, context, closed)) return null;
    return { request: r, orders };
  }

  /**
   * Whether the window keeps the request with this uuid, for an order that
   * allocates it. A request of another program, or one the caller may not
   * read, is not in their snapshot, so not kept.
   *
   * @param uuid - The request.
   */
  keepsRequest(uuid: string): Promise<boolean> {
    const known = this.#requests.get(uuid);
    if (known) return known;
    const judged = this.#judgeRequest(uuid);
    this.#requests.set(uuid, judged);
    return judged;
  }

  /**
   * Whether a request belongs to a record's list, as requestMatchesSource
   * finds it in the caller's snapshot: through its recurring list and the
   * work-order task it was raised on, read here when it names them.
   *
   * @param r - The request.
   * @param source - The record.
   */
  async matchesSource(r: PartsRequest, source: RequestSource) {
    const [lists, orders] = await Promise.all([
      this.#readByUuid("partsRequests", r.templateUuid),
      this.#readByUuid("workOrders", r.source.workOrderUuid),
    ]);
    const s = scopedSnapshot({
      ...this.#scope.state,
      partsRequests: decode("partsRequests", lists),
      workOrders: decode("workOrders", orders),
    });
    return requestMatchesSource(s, r, source);
  }

  async #judgeRequest(uuid: string): Promise<boolean> {
    const [row] = await this.#readByUuid("partsRequests", uuid);
    if (!row || !this.#mayRead(row)) return false;
    return (
      (await this.olderRequest(decode("partsRequests", [row])[0])) === null
    );
  }

  #mayRead(row: Doc<"partsRequests">): boolean {
    const { program, readable, state } = this.#scope;
    if (row.programUuid !== program) return false;
    const [r] = decode("partsRequests", [row]);
    return r.aircraftUuid
      ? readable.has(r.aircraftUuid)
      : programPermission(state, "admin");
  }

  // As countsToward: its own work order, or its job card's.
  async #countsTowardKeptWork(r: PartsRequest): Promise<boolean> {
    const { keepsOrder } = this.#scope;
    if (r.source.workOrderUuid && (await keepsOrder(r.source.workOrderUuid)))
      return true;
    if (r.source.kind !== "jobCard") return false;
    const order = await this.#cardOrder(r.source.uuid);
    return !!order && keepsOrder(order);
  }

  #cardOrder(cardUuid: string): Promise<string> {
    const known = this.#cards.get(cardUuid);
    if (known) return known;
    const found = this.#readCardOrder(cardUuid);
    this.#cards.set(cardUuid, found);
    return found;
  }

  // A card the caller may not read is not in their snapshot.
  async #readCardOrder(cardUuid: string): Promise<string> {
    const readable = (c: { aircraftUuid: string }) =>
      this.#scope.readable.has(c.aircraftUuid);
    const [live, archived] = await Promise.all([
      this.#readByUuid("taskCards", cardUuid),
      this.#readByUuid("archivedTaskCards", cardUuid),
    ]);
    const card = decode("taskCards", live.filter(readable))[0];
    const removed = decode("archivedTaskCards", archived.filter(readable))[0];
    return (card ?? removed)?.workOrderUuid ?? "";
  }

  #ordersOf(requestUuid: string) {
    const { program, budget } = this.#scope;
    return ordersAllocating(this.#ctx, program, [requestUuid], budget);
  }

  // Each of these tables has a "uuid" index on its uuid alone.
  async #readByUuid<T extends UuidTable>(
    table: T,
    uuid: string | undefined,
  ): Promise<Doc<T>[]> {
    if (!uuid) return [];
    const rows: Doc<T>[] = await this.#ctx.db
      .query(table)
      .withIndex("uuid", (q) => (q as unknown as UuidRange).eq("uuid", uuid))
      .take(1);
    return this.#scope.budget.spend(rows);
  }
}
