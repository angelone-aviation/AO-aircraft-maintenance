/**
 * Responsibility: Paging and filtering the change log for History: page
 *   sizes, filters, the access probe, action labels and in-memory paging.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ./model (types).
 */
import type { AuditEntry } from "./model";

/** Entries History asks for per page. */
export const AUDIT_PAGE_SIZE = 50;
/** The most entries one page request may return. */
export const MAX_AUDIT_PAGE_SIZE = 100;

/** Narrows History to one record, one aircraft, or both. */
export interface AuditFilter {
  entityUuid?: string;
  aircraftUuid?: string;
}

/** One page request: a filter, where to continue from, and the page size. */
export interface AuditPageRequest extends AuditFilter {
  cursor: string | null;
  numItems: number;
}

/** One page of entries, and the cursor that continues after it. */
export interface AuditPage {
  page: AuditEntry[];
  isDone: boolean;
  continueCursor: string;
}

/**
 * Tells whether an entry passes a filter; a blank field matches every entry.
 *
 * @param a - The entry.
 * @param f - The filter.
 * @returns True when every field set matches.
 */
export const matchesAuditFilter = (a: AuditEntry, f: AuditFilter) =>
  (!f.entityUuid || a.entityUuid === f.entityUuid) &&
  (!f.aircraftUuid || a.aircraftUuid === f.aircraftUuid);

/**
 * The refusal when {@link canPageAuditFilter} says no. It is the same for an
 * unknown id and a record out of view, so it reveals neither.
 */
export const HISTORY_NOT_FOUND = "History not found.";

/**
 * Tells whether the caller may page a filter, asking the row rule about probe
 * entries: an aircraft must be visible; a record must be one of the caller's
 * records or aircraft, or (for records the scope does not list, such as work
 * orders) have a visible newest entry.
 *
 * @param canSee - The caller's rule for one entry.
 * @param f - The filter.
 * @param newestForEntity - The newest entry for `f.entityUuid`, if any.
 * @returns True when every filter field set passes.
 */
export function canPageAuditFilter(
  canSee: (a: AuditEntry) => boolean,
  f: AuditFilter,
  newestForEntity?: AuditEntry | null,
) {
  return (
    (!f.aircraftUuid || canSee(probeEntry("", f.aircraftUuid))) &&
    (!f.entityUuid ||
      canSee(probeEntry(f.entityUuid)) ||
      canSee(probeEntry(f.entityUuid, f.entityUuid)) ||
      (newestForEntity?.entityUuid === f.entityUuid && canSee(newestForEntity)))
  );
}

/**
 * Bounds a requested page size.
 *
 * @param n - The size asked for.
 * @returns The whole number from 1 to {@link MAX_AUDIT_PAGE_SIZE}; 1 for 0 or
 *   a value that is not a number.
 */
export const clampAuditPageSize = (n: number) =>
  Math.min(MAX_AUDIT_PAGE_SIZE, Math.max(1, Math.floor(n) || 1));

/**
 * Names an action for History.
 *
 * @param action - The stored action, such as "flight.reviewed".
 * @returns Dots shown as " · " and underscores as spaces, first letter upper
 *   case: "Flight · reviewed".
 */
export function auditActionLabel(action: string) {
  const text = action.replaceAll(".", " · ").replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Pages an in-memory change log by offset (demo mode, offline fallback).
 *
 * @param entries - The whole log.
 * @param request - The filter, the offset cursor (null or not a number
 *   starts at 0) and the page size, bounded by {@link clampAuditPageSize}.
 * @returns The matching entries newest first, and the next page's cursor.
 */
export function pageAuditEntries(
  entries: AuditEntry[],
  request: AuditPageRequest,
): AuditPage {
  const start = Number(request.cursor ?? 0) || 0;
  const end = start + clampAuditPageSize(request.numItems);
  const matching = entries
    .filter((a) => matchesAuditFilter(a, request))
    .sort((a, b) => b.at - a.at);
  return {
    page: matching.slice(start, end),
    isDone: end >= matching.length,
    continueCursor: String(end),
  };
}

function probeEntry(entityUuid: string, aircraftUuid?: string): AuditEntry {
  return { uuid: "", actorId: "", at: 0, action: "", entityUuid, aircraftUuid };
}
