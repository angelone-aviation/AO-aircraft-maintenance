/**
 * Responsibility: Which parts requests, purchase orders and flight plans the
 *   workspace's retention window keeps, and the dated events it reads them by.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ./partsRequests, ./purchaseOrders; types from ./model,
 *   ./flightPlans.
 *
 * H5 option A (Aaron, 20 Nov 2026): closed requests, orders and plans leave
 * the workspace like other history (ADR-0013). retention.ts applies these
 * rules beside its own, so the cutoffs arrive as arguments.
 */
import {
  requestStatus,
  type PartsRequest,
  type RequestPurchase,
} from "./partsRequests";
import { received, shipped, type PurchaseOrder } from "./purchaseOrders";
import type { Flight, Snapshot } from "./model";
import type { FlightPlan } from "./flightPlans";

// An order in these phases still holds units on order for its requests.
const OPEN_PHASES: readonly string[] = ["draft", "issued"];

/** What else decides whether the window keeps a parts request. */
export interface RequestContext {
  /** The request's purchase-order allocations (requestPurchases). */
  purchases: readonly RequestPurchase[];
  /** Whether a work order the window keeps counts the request: its source
   * work order, or the work order of its source job card. */
  countsTowardKeptWork: boolean;
}

/** The window's two cutoffs, in milliseconds (retentionCutoff). */
export interface WindowCutoffs {
  /** Closed history: changed before it is older. */
  closed: number;
  /** Flights, which plans follow: departing before it is older. */
  flights: number;
}

/**
 * Whether a purchase order is still open: a draft or issued, or closed with
 * a component still out for repair or an exchange core not yet credited.
 * A closed or cancelled order never has receipts outstanding: closing needs
 * every unit received or cancelled.
 *
 * @param p - The order.
 */
export function isOpenPurchaseOrder(p: PurchaseOrder): boolean {
  if (OPEN_PHASES.includes(p.phase)) return true;
  if (p.lines.some((l) => shipped(p, l) > received(p, l))) return true;
  return (p.coreReturns ?? []).some((c) => c.status !== "credited");
}

/**
 * The latest of a purchase order's dated events: creation, any save, issue
 * and every command in its history. An order allocating a request was saved
 * after the request existed, so it is never earlier than that request's
 * creation; the window's loader relies on this.
 *
 * @param p - The order.
 * @returns Milliseconds.
 */
export function purchaseOrderActivity(p: PurchaseOrder): number {
  return Math.max(
    p.createdAt,
    p.updatedAt,
    p.issuedAt ?? 0,
    ...p.history.map((h) => h.at),
  );
}

/**
 * The latest of a parts request's dated events: creation, any save,
 * receipt or command, and every issue.
 *
 * @param r - The request.
 * @returns Milliseconds.
 */
export function requestActivity(r: PartsRequest): number {
  return Math.max(
    r.createdAt,
    r.updatedAt,
    ...r.issues.map((i) => i.at),
    ...r.history.map((h) => h.at),
  );
}

/**
 * When a request settled as far as its own record shows: cancelled, or
 * every line issued in full, which fulfils a request for parts whatever its
 * orders say. A repair, or a restock received rather than issued, is
 * fulfilled by its orders' receipts, which the record does not hold; such a
 * request, like an open one or a recurring list, has no time.
 *
 * @param r - The request.
 * @returns Its activity once settled; undefined while it may be open.
 */
export function requestSettledAt(r: PartsRequest): number | undefined {
  if (r.recurring) return undefined;
  if (r.cancelled || isIssuedInFull(r)) return requestActivity(r);
  return undefined;
}

/**
 * When a purchase order settled: its activity once it is no longer open.
 *
 * @param p - The order.
 * @returns Undefined while {@link isOpenPurchaseOrder}.
 */
export function purchaseOrderSettledAt(p: PurchaseOrder): number | undefined {
  return isOpenPurchaseOrder(p) ? undefined : purchaseOrderActivity(p);
}

/**
 * Whether the window keeps a parts request: a recurring list, cancelled or
 * not; open (not cancelled, not fulfilled); changed since the cutoff;
 * counted by a work order the window keeps; or allocated to a draft or
 * issued purchase order.
 *
 * @param s - The snapshot the request is judged in; its status is read from
 *   the purchases `context` holds, not the snapshot's.
 * @param r - The request.
 * @param context - Its purchases and work-order link.
 * @param cutoff - The closed-history cutoff, in milliseconds.
 */
export function isKeptRequest(
  s: Snapshot,
  r: PartsRequest,
  context: RequestContext,
  cutoff: number,
): boolean {
  if (r.recurring || requestActivity(r) >= cutoff) return true;
  if (context.countsTowardKeptWork) return true;
  const { purchases } = context;
  if (purchases.some((a) => OPEN_PHASES.includes(a.phase))) return true;
  if (r.cancelled) return false;
  const status = requestStatus(
    { ...s, partsRequestPurchases: [...purchases] },
    r,
  );
  return status !== "Fulfilled";
}

/**
 * Whether the window keeps a purchase order: open, changed since the
 * cutoff, or allocating a request the window keeps, whose progress it
 * counts.
 *
 * @param p - The order.
 * @param keptRequests - The uuids of the requests the window keeps.
 * @param cutoff - The closed-history cutoff, in milliseconds.
 */
export function isKeptPurchaseOrder(
  p: PurchaseOrder,
  keptRequests: ReadonlySet<string>,
  cutoff: number,
): boolean {
  if (isOpenPurchaseOrder(p) || purchaseOrderActivity(p) >= cutoff) return true;
  return allocatedRequests(p).some((uuid) => keptRequests.has(uuid));
}

/**
 * Whether the window keeps a flight plan: departing from the flight cutoff
 * on (every plan still to fly among them), created since the closed cutoff,
 * or flown by a flight the window keeps. A plan records no other change.
 *
 * @param p - The plan.
 * @param flown - The plans the window's flights were logged against.
 * @param cutoffs - The window's cutoffs.
 */
export function isKeptPlan(
  p: FlightPlan,
  flown: ReadonlySet<string>,
  cutoffs: WindowCutoffs,
): boolean {
  return (
    planDepartedAt(p) >= cutoffs.flights ||
    p.createdAt >= cutoffs.closed ||
    flown.has(p.uuid)
  );
}

/**
 * A plan's departure as an instant: the stored text keeps the filer's
 * offset, so it does not sort by instant.
 *
 * @param p - The plan.
 * @returns Milliseconds.
 */
export function planDepartedAt(p: Pick<FlightPlan, "departureAt">): number {
  return Date.parse(p.departureAt);
}

/**
 * The plans flights were logged against.
 *
 * @param flights - The flights.
 * @returns Each plan uuid once.
 */
export function flownPlans(flights: readonly Flight[]): Set<string> {
  return new Set(flights.flatMap((f) => f.flightPlanUuid ?? []));
}

/**
 * The requests a purchase order's lines allocate.
 *
 * @param p - The order.
 * @returns Each request uuid once, in line order.
 */
export function allocatedRequests(p: Pick<PurchaseOrder, "lines">): string[] {
  const uuids = p.lines.flatMap((l) =>
    (l.requestAllocations ?? []).map((a) => a.requestUuid),
  );
  return [...new Set(uuids)];
}

/**
 * Whether a request counts toward one of the given work orders, as a work
 * order's parts costs count it: raised on the order, or on a job card the
 * order owns.
 *
 * @param r - The request.
 * @param orders - The work orders.
 * @param cardOrders - Each job card's work order, archived cards included.
 */
export function countsToward(
  r: Pick<PartsRequest, "source">,
  orders: ReadonlySet<string>,
  cardOrders: ReadonlyMap<string, string>,
): boolean {
  if (orders.has(r.source.workOrderUuid)) return true;
  return (
    r.source.kind === "jobCard" &&
    orders.has(cardOrders.get(r.source.uuid) ?? "")
  );
}

/**
 * Purchases grouped by request, so each request is judged on its own.
 *
 * @param purchases - Allocations, as requestPurchases returns them.
 * @returns Each request's allocations, in the order given.
 */
export function purchasesByRequest(
  purchases: readonly RequestPurchase[],
): Map<string, RequestPurchase[]> {
  const byRequest = new Map<string, RequestPurchase[]>();
  for (const a of purchases) {
    const listed = byRequest.get(a.requestUuid);
    if (listed) listed.push(a);
    else byRequest.set(a.requestUuid, [a]);
  }
  return byRequest;
}

function isIssuedInFull(r: PartsRequest): boolean {
  if (r.mode !== "parts") return false;
  return r.lines.every(
    (l) =>
      r.issues
        .filter((i) => i.lineUuid === l.uuid)
        .reduce((n, i) => n + i.quantity, 0) >= l.quantity,
  );
}
