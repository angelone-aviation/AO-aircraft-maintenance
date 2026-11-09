/**
 * Responsibility: What one work order cost: its labor, other costs and issued
 *   parts, priced; the program's labor rate; and an aircraft's spend and
 *   budget for a period.
 * Layer: Domain. Pure functions over a snapshot; no I/O, no React.
 * Dependencies: ../model, ../programs, ../workOrders (types), ./records,
 *   ./units, ./period.
 */
import { localDate, type Snapshot } from "../model";
import { activeProgram } from "../programs";
import type { WorkOrder } from "../workOrders";
import type { CostRecord, WorkOrderCost } from "./records";
import { CENTS_PER_DOLLAR, laborCents, laborSeconds } from "./units";
import { inPeriod, type Period } from "./period";

/**
 * A work order's cost record.
 *
 * @returns The record, or undefined while nothing has been costed.
 */
export const findWorkOrderCost = (s: Snapshot, workOrderUuid: string) =>
  s.costs?.find(
    (r): r is WorkOrderCost =>
      r.kind === "workOrder" && r.workOrderUuid === workOrderUuid,
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
 * @returns One entry per issue, dated the local date it was issued.
 */
export function partIssues(s: Snapshot, w: Pick<WorkOrder, "uuid">) {
  const cards = new Map(
    [...(s.taskCards ?? []), ...(s.archivedTaskCards ?? [])].map((c) => [
      c.uuid,
      c.workOrderUuid,
    ]),
  );
  return (s.partsRequests ?? [])
    .filter(
      (r) =>
        r.source.workOrderUuid === w.uuid ||
        (r.source.kind === "jobCard" && cards.get(r.source.uuid) === w.uuid),
    )
    .flatMap((r) =>
      r.issues.map((i) => {
        const line = r.lines.find((l) => l.uuid === i.lineUuid);
        return {
          stockUuid: i.stockUuid,
          quantity: i.quantity,
          date: localDate(i.at),
          partNumber: line?.partNumber ?? "",
          description: line?.description ?? "",
        };
      }),
    );
}

/** One stock item's issued parts on a work order, priced. */
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
 *   item (a manual unit cost, else the stock unit cost, else unpriced), and
 *   the totals; `missingPartCosts` counts the unpriced part lines.
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
 * @returns The budget record, or undefined when none is set.
 */
export const findBudget = (s: Snapshot, aircraftUuid: string, year: number) =>
  s.costs?.find(
    (r): r is Extract<CostRecord, { kind: "budget" }> =>
      r.kind === "budget" && r.aircraftUuid === aircraftUuid && r.year === year,
  );

// Issued parts grouped by stock item: a manual unit cost wins over the stock
// item's unit cost (dollars, rounded to the cent).
function priceIssuedParts(
  s: Snapshot,
  w: WorkOrder,
  record: WorkOrderCost | undefined,
  period: Period | undefined,
): PartCostLine[] {
  const grouped = new Map<string, PartCostLine>();
  for (const issue of partIssues(s, w)) {
    if (!inPeriod(issue.date, period)) continue;
    const prior = grouped.get(issue.stockUuid);
    if (prior) prior.quantity += issue.quantity;
    else grouped.set(issue.stockUuid, priceIssue(s, record, issue));
  }
  return [...grouped.values()].map((p) => ({
    ...p,
    totalCents: p.quantity * (p.unitCents ?? 0),
  }));
}

function priceIssue(
  s: Snapshot,
  record: WorkOrderCost | undefined,
  issue: ReturnType<typeof partIssues>[number],
): PartCostLine {
  const manual = record?.partUnitCosts.find(
    (p) => p.stockUuid === issue.stockUuid,
  );
  const stock = s.management?.find(
    (r) => r.kind === "stock" && r.uuid === issue.stockUuid,
  );
  const stockCost =
    stock?.kind === "stock" && stock.cost !== undefined
      ? Math.round(stock.cost * CENTS_PER_DOLLAR)
      : undefined;
  return {
    stockUuid: issue.stockUuid,
    partNumber:
      issue.partNumber || (stock?.kind === "stock" ? stock.partNumber : ""),
    description:
      issue.description || (stock?.kind === "stock" ? stock.description : ""),
    quantity: issue.quantity,
    unitCents: manual?.unitCents ?? stockCost,
    manual: !!manual,
    totalCents: 0,
  };
}
