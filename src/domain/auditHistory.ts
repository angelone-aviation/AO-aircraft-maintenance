import type { AuditEntry } from "./model";
export const AUDIT_PAGE_SIZE = 50;
export const MAX_AUDIT_PAGE_SIZE = 100;
export interface AuditFilter {
  entityUuid?: string;
  aircraftUuid?: string;
}
export interface AuditPageRequest extends AuditFilter {
  cursor: string | null;
  numItems: number;
}
export interface AuditPage {
  page: AuditEntry[];
  isDone: boolean;
  continueCursor: string;
}
export const matchesAuditFilter = (a: AuditEntry, f: AuditFilter) =>
  (!f.entityUuid || a.entityUuid === f.entityUuid) &&
  (!f.aircraftUuid || a.aircraftUuid === f.aircraftUuid);
// Whether the caller may page this filter at all, asked of the same rule that
// filters rows (canSeeAudit) through a probe entry: an aircraft must be one the
// caller can see, and a record must be one of the caller's records or aircraft.
// Records the scope does not list (inspections, work orders, flights...) pass
// when the caller can see the record's newest entry. Callers refuse before
// paging, with the same answer for unknown ids and for records out of view.
export const HISTORY_NOT_FOUND = "History not found.";
export function canPageAuditFilter(
  canSee: (a: AuditEntry) => boolean,
  f: AuditFilter,
  newestForEntity?: AuditEntry | null,
) {
  const probe = (entityUuid: string, aircraftUuid?: string): AuditEntry => ({
    uuid: "",
    actorId: "",
    at: 0,
    action: "",
    entityUuid,
    aircraftUuid,
  });
  return (
    (!f.aircraftUuid || canSee(probe("", f.aircraftUuid))) &&
    (!f.entityUuid ||
      canSee(probe(f.entityUuid)) ||
      canSee(probe(f.entityUuid, f.entityUuid)) ||
      (newestForEntity?.entityUuid === f.entityUuid && canSee(newestForEntity)))
  );
}
export const clampAuditPageSize = (n: number) =>
  Math.min(MAX_AUDIT_PAGE_SIZE, Math.max(1, Math.floor(n) || 1));
// Offset paging over an in-memory log (demo mode and offline fallback).
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
