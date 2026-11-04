/**
 * Responsibility: What a management action runs with once its command is
 *   admitted, and the change it hands back to be stored.
 * Layer: Domain. Types and one lookup; no I/O, no React.
 * Dependencies: ../model, ./schemas.
 */
import type { Aircraft, Inspection } from "../model";
import type { ManagedRecord } from "./schemas";

/** The inspection or record a command names, unless it is new. */
export type Existing = Inspection | ManagedRecord | undefined;

/**
 * An admitted command's context: the record it names, its aircraft, the
 * program's records and the time it runs at.
 */
export interface Context {
  existing: Existing;
  aircraft: Aircraft | undefined;
  records: ManagedRecord[];
  now: number;
}

/**
 * What an action stores: the record or inspection it saves, other records
 * it adds or replaces, and inspections moved with a component.
 */
export interface Change {
  next: Inspection | ManagedRecord;
  extras: ManagedRecord[];
  updatedInspections: Inspection[];
}

/**
 * The existing record, if it is of `kind`.
 *
 * @returns The record, narrowed; undefined for an inspection, another kind
 *   or a new record.
 */
export function existingOfKind<K extends ManagedRecord["kind"]>(
  existing: Existing,
  kind: K,
) {
  if (!existing || !("kind" in existing) || existing.kind !== kind) return;
  return existing as RecordOfKind<K>;
}

type RecordOfKind<K extends ManagedRecord["kind"]> = Extract<
  ManagedRecord,
  { kind: K }
>;
