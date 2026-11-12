/**
 * Responsibility: Shapes discrepancy reports for the Discrepancies screen:
 *   which reports a view lists, how each one stands and the summary counts.
 * Layer: Domain. Pure functions over the snapshot; no I/O, no React.
 * Dependencies: src/domain/model.ts, deferrals.ts, listSearch.ts,
 *   workOrders.ts (type).
 */
import { deferralExpired, isGroundingReport } from "./deferrals";
import { discrepancyMatches } from "./listSearch";
import { localDate, type Discrepancy, type Snapshot } from "./model";
import type { WorkOrder } from "./workOrders";

/**
 * Where a report stands: open, grounding its aircraft, deferred, deferred
 * past its expiry (which grounds the aircraft again), or resolved.
 */
export type ReportStanding =
  "open" | "grounding" | "deferred" | "expired" | "resolved";

/** The Discrepancies screen's figures. */
export interface DiscrepancyCounts {
  /** Every open report, deferred and grounding ones included. */
  open: number;
  /** Open, undeferred reports marked not airworthy. */
  grounding: number;
  /** Open reports carrying a deferral, expired or not. */
  deferred: number;
  /** Reports resolved in today's local calendar month. */
  resolvedThisMonth: number;
  /** Every report, open or resolved. */
  total: number;
}

/** What the list shows: the open reports, or every report, and a search. */
export interface ReportFilters {
  search: string;
  showResolved: boolean;
}

/**
 * Tells where a report stands.
 *
 * @param d - The report.
 * @param today - The day to judge a deferral's expiry on (YYYY-MM-DD).
 * @returns "resolved" for a resolved report whatever it carries; for an open
 *   one, "deferred" or "expired" when it carries a deferral, else
 *   "grounding" or "open".
 */
export function reportStanding(d: Discrepancy, today: string): ReportStanding {
  if (d.status === "resolved") return "resolved";
  if (d.deferral)
    return deferralExpired(d.deferral, today) ? "expired" : "deferred";
  return isGroundingReport(d) ? "grounding" : "open";
}

/**
 * Counts the program's reports for the summary. The counts ignore the list's
 * search and filter.
 *
 * @param reports - Every report in the program.
 * @param today - Today's local date (YYYY-MM-DD).
 */
export function discrepancyCounts(
  reports: Discrepancy[],
  today: string,
): DiscrepancyCounts {
  const open = reports.filter((d) => d.status === "open");
  const month = today.slice(0, "YYYY-MM".length);
  return {
    open: open.length,
    grounding: open.filter(isGroundingReport).length,
    deferred: open.filter((d) => d.deferral).length,
    resolvedThisMonth: reports.filter(
      (d) =>
        d.status === "resolved" &&
        d.resolvedAt !== undefined &&
        localDate(d.resolvedAt).startsWith(month),
    ).length,
    total: reports.length,
  };
}

/**
 * The reports a view lists.
 *
 * @param s - The snapshot; its names feed the search.
 * @param filters - Open reports only unless `showResolved`, narrowed by the
 *   search of registration, description, resolution and reporter.
 * @returns The matching reports newest first, and whether the view lists any
 *   report before the search (so an empty list can say "No matching reports").
 */
export function listedReports(
  s: Snapshot,
  { search, showResolved }: ReportFilters,
): { reports: Discrepancy[]; anyListed: boolean } {
  const listed = s.discrepancies.filter(
    (d) => showResolved || d.status === "open",
  );
  const reports = listed
    .filter((d) => discrepancyMatches(s, d, search))
    .sort((a, b) => b.createdAt - a.createdAt);
  return { reports, anyListed: listed.length > 0 };
}

/**
 * The work orders that cover a report, as an item or through one of their
 * job cards (the rule workOrderProgress counts by).
 *
 * @param s - The snapshot.
 * @param uuid - The report.
 * @returns The orders, in snapshot order, each once.
 */
export function reportWorkOrders(s: Snapshot, uuid: string): WorkOrder[] {
  const viaCards = new Set(
    (s.taskCards ?? [])
      .filter((t) => t.discrepancyUuid === uuid && t.workOrderUuid)
      .map((t) => t.workOrderUuid),
  );
  return (s.workOrders ?? []).filter(
    (w) =>
      viaCards.has(w.uuid) ||
      w.tasks.some(
        (t) => t.source.kind === "discrepancy" && t.source.uuid === uuid,
      ),
  );
}
