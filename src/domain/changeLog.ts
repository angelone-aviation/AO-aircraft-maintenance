/**
 * Responsibility: Builds the change-log row (GLOSSARY "Audit entry") an
 *   applier records for one change, stamped once in one place.
 * Layer: Domain. A pure constructor; no I/O, no React (a `now` left to its
 *   default reads the clock).
 * Dependencies: ./model (types), ./programs (activeProgram).
 *
 * Rows are append-only (CONTEXT.md invariant 3), so callers add the entry to
 * the snapshot's change log; nothing here edits an existing row.
 */
import type { AuditEntry, Snapshot } from "./model";
import { activeProgram } from "./programs";

/**
 * What changed, as an applier describes it; {@link auditEntry} stamps the
 * rest. A key passed as undefined is kept as undefined.
 */
export interface AuditChange {
  action: string;
  entityUuid: string;
  /** A fixed id, such as the command's request id; random by default. */
  uuid?: string;
  aircraftUuid?: string;
  /** Overrides the derived program; an explicit undefined leaves none. */
  programUuid?: string;
  reason?: string;
  /** The record before the change; pass a copy if it is about to change. */
  before?: unknown;
  after?: unknown;
}

/**
 * The change-log row for one change by the signed-in user.
 *
 * @returns The change, stamped with `uuid` (random unless given), `at` =
 *   `now`, `actorId`, and `programUuid`: the Flight Program owning
 *   `aircraftUuid`, else the active one, unless `change` names one. `before`
 *   and `after` are stored as JSON; keys `change` omits stay absent. Keys run
 *   `uuid`, `programUuid`, `actorId`, `at`, then the change's other keys in
 *   its order, then `before` and `after`.
 */
export function auditEntry(
  s: Snapshot,
  change: AuditChange,
  now = Date.now(),
): AuditEntry {
  const { uuid, before, after, ...fields } = change;
  return {
    uuid: uuid ?? crypto.randomUUID(),
    programUuid: owningProgram(s, change.aircraftUuid),
    actorId: s.user.id,
    at: now,
    ...fields,
    ...("before" in change ? { before: toJson(before) } : {}),
    ...("after" in change ? { after: toJson(after) } : {}),
  };
}

function owningProgram(s: Snapshot, aircraftUuid: string | undefined) {
  const aircraft = s.aircraft.find((a) => a.uuid === aircraftUuid);
  return aircraft?.programUuid ?? activeProgram(s);
}

function toJson(value: unknown) {
  return value === undefined ? undefined : JSON.stringify(value);
}
