/**
 * Responsibility: What one work order cost: its labor, other costs and issued
 *   parts, priced; the program's labor rate; and an aircraft's spend and
 *   budget for a period.
 * Layer: Domain. Pure functions over a snapshot; no I/O, no React.
 * Dependencies: ../model, ../programs, ../workOrders, ../partsRequests,
 *   ../management (types), ./records, ./units, ./period.
 */
import type { Snapshot } from "../model";
import { activeProgram } from "../programs";
import type { WorkOrder } from "../workOrders";
import type { PartsRequest } from "../partsRequests";
import type { Stock } from "../management";
import type { CostRecord, IssuedPart, WorkOrderCost } from "./records";
import { CENTS_PER_DOLLAR, laborCents, laborSeconds } from "./units";
import { inPeriod, type Period } from "./period";

/**
 * A work order's cost record.
 *
 * @param programUuid - Only that program's record: a work order that moved
 *   with its aircraft can hold one from each program that costed it.
 * @returns The record, or undefined while nothing has been costed.
 */
export const findWorkOrderCost = (
  s: Snapshot,
  workOrderUuid: string,
  programUuid?: string,
) =>
  s.costs?.find(
    (r): r is WorkOrderCost =>
      r.kind === "workOrder" &&
      r.workOrderUuid === workOrderUuid &&
      (programUuid === undefined || r.programUuid === programUuid),
  );

/**
 * The active Flight Program's labor rate.
 *
 * @returns Cents an hour, or undefined when none is set.
 */
export const laborRate = (s: Snapshot) =>
  s.costs?.find(
    (r): r is Extract<CostRecord, { kind: "settings" }> =>
      r.kind === "settings" && r.programUuid === activeProgram(s),
  )?.laborRateCents;

/**
 * Stock issued against the work order through parts requests: requests on
 * its tasks, and requests on job cards it owns, archived ones included.
 *
 * @returns One entry per issue, named by its request and `issuedAt` (the
 *   issue's `at`), and dated the calendar date the issue carries, so the
 *   server and every browser put it in the same period; an issue stored
 *   without one takes the UTC date it was issued.
 */
export function partIssues(s: Snapshot, w: Pick<WorkOrder, "uuid">) {
  const cards = cardOrders(s);
  return (s.partsRequests ?? [])
    .filter((r) => countsToward(cards, r, w.uuid))
    .flatMap((r) =>
      r.issues.map((i) => {
        const line = r.lines.find((l) => l.uuid === i.lineUuid);
        return {
          requestUuid: r.uuid,
          issuedAt: i.at,
          stockUuid: i.stockUuid,
          quantity: i.quantity,
          date: issueDate(i),
          partNumber: line?.partNumber ?? "",
          description: line?.description ?? "",
        };
      }),
    );
}

/**
 * The work orders whose costs count a parts request's issues, by the rule
 * {@link partIssues} applies.
 *
 * @returns Its task's work order or the one owning its job card; none for a
 *   request on no work order.
 */
export function issueWorkOrders(s: Snapshot, r: PartsRequest): WorkOrder[] {
  const cards = cardOrders(s);
  return (s.workOrders ?? []).filter((w) => countsToward(cards, r, w.uuid));
}

/**
 * A new issue priced at its stock item's unit cost now, as the work orders
 * that count it record it (decision D13).
 *
 * @param r - The request the issue was made on.
 * @param issue - The issue as the request stores it.
 * @returns The issued part; `unitCents` is undefined when the stock item has
 *   no unit cost.
 */
export function pricedIssue(
  s: Snapshot,
  r: PartsRequest,
  issue: PartsRequest["issues"][number],
): IssuedPart {
  return {
    requestUuid: r.uuid,
    issuedAt: issue.at,
    stockUuid: issue.stockUuid,
    quantity: issue.quantity,
    date: issueDate(issue),
    unitCents: unitCentsOf(findStock(s, issue.stockUuid)),
  };
}

/** One stock item's issued parts on a work order at one unit cost. */
export interface PartCostLine {
  stockUuid: string;
  partNumber: string;
  description: string;
  quantity: number;
  unitCents?: number;
  manual: boolean;
  totalCents: number;
}

/**
 * A work order's costs, optionally within a period.
 *
 * @returns Its labor and other entries, its issued parts grouped by stock
 *   item and unit cost (a manual unit cost, else the stock unit cost recorded
 *   at issue, or the current one for an issue made before D13, else
 *   unpriced), and the totals; `missingPartCosts` counts the unpriced lines.
 */
export function workOrderCosts(s: Snapshot, w: WorkOrder, period?: Period) {
  const record = findWorkOrderCost(s, w.uuid);
  const labor = (record?.labor ?? []).filter((e) => inPeriod(e.date, period));
  const other = (record?.other ?? []).filter((e) => inPeriod(e.date, period));
  const parts = priceIssuedParts(s, w, record, period);
  const sum = <T>(xs: T[], f: (x: T) => number) =>
    xs.reduce((n, x) => n + f(x), 0);
  const totals = {
    laborSeconds: sum(labor, laborSeconds),
    laborCents: sum(labor, laborCents),
    partsCents: sum(parts, (p) => p.totalCents),
    otherCents: sum(other, (e) => e.amountCents),
    missingPartCosts: parts.filter((p) => p.unitCents === undefined).length,
  };
  return {
    labor,
    other,
    parts,
    ...totals,
    totalCents: totals.laborCents + totals.partsCents + totals.otherCents,
  };
}
/** A work order's costs, as {@link workOrderCosts} returns them. */
export type WorkOrderCostSummary = ReturnType<typeof workOrderCosts>;

/**
 * What an aircraft's work orders cost within a period.
 *
 * @returns The work orders' totals added up, in cents.
 */
export function aircraftSpendCents(
  s: Snapshot,
  aircraftUuid: string,
  period: Period,
): number {
  return (s.workOrders ?? [])
    .filter((w) => w.aircraftUuid === aircraftUuid)
    .reduce((n, w) => n + workOrderCosts(s, w, period).totalCents, 0);
}

/**
 * An aircraft's maintenance budget for a calendar year.
 *
 * @param programUuid - Only that program's budget: an aircraft that moved
 *   can hold one from each program that budgeted it.
 * @returns The budget record, or undefined when none is set.
 */
export const findBudget = (
  s: Snapshot,
  aircraftUuid: string,
  year: number,
  programUuid?: string,
) =>
  s.costs?.find(
    (r): r is Extract<CostRecord, { kind: "budget" }> =>
      r.kind === "budget" &&
      r.aircraftUuid === aircraftUuid &&
      r.year === year &&
      (programUuid === undefined || r.programUuid === programUuid),
  );

// Parts issued at two prices are two lines; a manual unit cost prices every
// issue of its stock item the same, so they merge into one.
function priceIssuedParts(
  s: Snapshot,
  w: WorkOrder,
  record: WorkOrderCost | undefined,
  period: Period | undefined,
): PartCostLine[] {
  const recorded = groupByIssue(record?.issuedParts ?? []);
  const grouped = new Map<string, PartCostLine>();
  for (const issue of partIssues(s, w)) {
    const price = recorded.get(issueKey(issue))?.shift();
    if (!inPeriod(issue.date, period)) continue;
    const line = priceIssue(s, record, price, issue);
    const key = `${line.stockUuid} ${line.unitCents ?? ""}`;
    const prior = grouped.get(key);
    if (prior) prior.quantity += issue.quantity;
    else grouped.set(key, line);
  }
  return [...grouped.values()].map((p) => ({
    ...p,
    totalCents: p.quantity * (p.unitCents ?? 0),
  }));
}

function priceIssue(
  s: Snapshot,
  record: WorkOrderCost | undefined,
  recorded: IssuedPart | undefined,
  issue: ReturnType<typeof partIssues>[number],
): PartCostLine {
  const manual = record?.partUnitCosts.find(
    (p) => p.stockUuid === issue.stockUuid,
  );
  const stock = findStock(s, issue.stockUuid);
  // An issue made before prices were recorded at issue (D13) keeps the stock
  // item's current cost, as every total priced it then.
  const issuedCents = recorded ? recorded.unitCents : unitCentsOf(stock);
  return {
    stockUuid: issue.stockUuid,
    partNumber: issue.partNumber || (stock?.partNumber ?? ""),
    description: issue.description || (stock?.description ?? ""),
    quantity: issue.quantity,
    unitCents: manual?.unitCents ?? issuedCents,
    manual: !!manual,
    totalCents: 0,
  };
}

function cardOrders(s: Snapshot) {
  return new Map(
    [...(s.taskCards ?? []), ...(s.archivedTaskCards ?? [])].map((c) => [
      c.uuid,
      c.workOrderUuid,
    ]),
  );
}

function countsToward(
  cards: Map<string, string | undefined>,
  r: PartsRequest,
  workOrderUuid: string,
) {
  return (
    r.source.workOrderUuid === workOrderUuid ||
    (r.source.kind === "jobCard" && cards.get(r.source.uuid) === workOrderUuid)
  );
}

function issueDate(issue: PartsRequest["issues"][number]) {
  return issue.date ?? new Date(issue.at).toISOString().slice(0, 10);
}

// An issue is named by its request and the time it was made. Two issues on
// one request share a time only if made in the same millisecond; the request
// and the cost record append them in the same order, so they pair in order.
function groupByIssue(parts: IssuedPart[]) {
  const byIssue = new Map<string, IssuedPart[]>();
  for (const p of parts)
    byIssue.set(issueKey(p), [...(byIssue.get(issueKey(p)) ?? []), p]);
  return byIssue;
}

function issueKey(p: { requestUuid: string; issuedAt: number }) {
  return `${p.requestUuid} ${p.issuedAt}`;
}

function findStock(s: Snapshot, stockUuid: string) {
  return s.management?.find(
    (r): r is Stock => r.kind === "stock" && r.uuid === stockUuid,
  );
}

function unitCentsOf(stock: Stock | undefined) {
  return stock?.cost === undefined
    ? undefined
    : Math.round(stock.cost * CENTS_PER_DOLLAR);
}
