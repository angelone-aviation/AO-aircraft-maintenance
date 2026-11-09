/**
 * Responsibility: The checks every management command passes before its
 *   action runs: program ownership, links, manual reference, permission,
 *   duplicate manual items and the record's version.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ../model, ../programs, ../manuals, ../rejection, ./schemas,
 *   ./context.
 */
import { can, type Inspection, type Snapshot } from "../model";
import {
  activeProgram,
  ownsActive,
  recordProgram,
  programPermission,
} from "../programs";
import { validateManualReference } from "../manuals";
import { Rejection, StaleRecordRejection } from "../rejection";
import type { ManagedRecord, ManagementCommand } from "./schemas";
import type { Existing } from "./context";

const INVENTORY_KINDS = ["stock", "location", "vendor"];
const MANUAL_LINKED_KINDS = ["componentRequirement", "component"];

/**
 * Whether the user may change maintenance records on an aircraft, or records
 * on no aircraft.
 *
 * @param s - The snapshot.
 * @param aircraftUuid - The records' aircraft, if any.
 * @returns Maintenance permission on that aircraft; with none, in the active
 *   Flight Program.
 */
export function mayMaintain(s: Snapshot, aircraftUuid: string | undefined) {
  return aircraftUuid
    ? can(s, aircraftUuid, "maintenance")
    : programPermission(s, "maintenance");
}

/**
 * Admits a parsed command through every check its action does not own, in a
 * fixed order. A saved record is stamped with its Flight Program.
 *
 * @param records - The program's records.
 * @returns The record the command names, unless new; the aircraft it is on
 *   and that aircraft's uuid (`scope`), if any.
 * @throws {Rejection} In order: "Record belongs to another Flight Program.";
 *   "Use an explicit Flight Program transfer.", "Storage location must belong
 *   to this Flight Program." or "Component must belong to this Flight
 *   Program."; as {@link validateManualReference} for a changed reference;
 *   "Permission denied."; "Records cannot be moved between aircraft.";
 *   "Aircraft not found."; "This manual item has already been added to the
 *   selected target."; a StaleRecordRejection for a stale version.
 */
export function admitCommand(
  s: Snapshot,
  records: ManagedRecord[],
  c: ManagementCommand,
) {
  const existing = findExisting(s, records, c);
  if (existing) assertActiveProgram(s, existing);
  if (c.action === "record.save")
    assignRecordProgram(s, records, c.record, existing);
  checkManualReference(s, c, existing);
  const { scope, aircraft } = authorize(s, c, existing);
  assertNewSourceItem(s, records, c, existing);
  assertFresh(c.action, "record" in c ? c.record.version : c.version, existing);
  return { existing, scope, aircraft };
}

function assertFresh(
  action: string,
  version: number,
  existing?: { version?: number },
) {
  const current = existing?.version ?? 0;
  if (version !== current)
    throw new StaleRecordRejection(action.split(".")[0], current);
}

function findExisting(
  s: Snapshot,
  records: ManagedRecord[],
  c: ManagementCommand,
): Existing {
  if (c.action === "inspection.save")
    return s.inspections.find((i) => i.uuid === c.record.uuid);
  if (c.action === "inspection.complete")
    return s.inspections.find((i) => i.uuid === c.uuid);
  const uuid = "record" in c ? c.record.uuid : c.uuid;
  return records.find((r) => r.uuid === uuid);
}

function assertActiveProgram(
  s: Snapshot,
  existing: Inspection | ManagedRecord,
) {
  const owner =
    "kind" in existing
      ? recordProgram(s, existing)
      : s.aircraft.find((a) => a.uuid === existing.aircraftUuid)?.programUuid;
  if (!ownsActive(s, owner))
    throw new Rejection("Record belongs to another Flight Program.");
}

// A saved record stays in its program, and so must the location or
// component it links to; moving programs is a separate, audited transfer.
function assignRecordProgram(
  s: Snapshot,
  records: ManagedRecord[],
  record: ManagedRecord,
  existing: Existing,
) {
  const owner =
    existing && "kind" in existing
      ? recordProgram(s, existing)
      : activeProgram(s);
  if (record.programUuid && record.programUuid !== owner)
    throw new Rejection("Use an explicit Flight Program transfer.");
  record.programUuid = owner;
  const findLinked = (kind: string, uuid: string) =>
    records.find((r) => r.uuid === uuid && r.kind === kind);
  if (record.kind === "stock") {
    const location = findLinked("location", record.locationUuid);
    if (!location || recordProgram(s, location) !== owner)
      throw new Rejection(
        "Storage location must belong to this Flight Program.",
      );
  }
  if (record.kind !== "componentRequirement") return;
  const component = findLinked("component", record.componentUuid);
  if (!component || recordProgram(s, component) !== owner)
    throw new Rejection("Component must belong to this Flight Program.");
}

function checkManualReference(
  s: Snapshot,
  c: ManagementCommand,
  existing: Existing,
) {
  if (c.action !== "inspection.save" && c.action !== "record.save") return;
  if (
    c.action === "record.save" &&
    !MANUAL_LINKED_KINDS.includes(c.record.kind)
  )
    return;
  const previous =
    existing && "manualReference" in existing
      ? existing.manualReference
      : undefined;
  const reference =
    "manualReference" in c.record ? c.record.manualReference : undefined;
  if (JSON.stringify(reference) !== JSON.stringify(previous))
    validateManualReference(s, reference);
}

function commandScope(c: ManagementCommand, existing: Existing) {
  if (c.action === "inspection.save") return c.record.aircraftUuid;
  if (c.action === "inspection.complete")
    return (existing as Inspection | undefined)?.aircraftUuid;
  if (c.action === "record.save" && "aircraftUuid" in c.record)
    return c.record.aircraftUuid;
  if (existing && "kind" in existing && "aircraftUuid" in existing)
    return existing.aircraftUuid;
  return undefined;
}

// Writes on an aircraft's records need maintenance permission there; others
// need it in the program, or administration for the inventory itself.
function authorize(s: Snapshot, c: ManagementCommand, existing: Existing) {
  const scope = commandScope(c, existing);
  if (!s.user.active || !mayWrite(s, c, scope))
    throw new Rejection("Permission denied.");
  return { scope, aircraft: findScopeAircraft(s, existing, scope) };
}

function mayWrite(s: Snapshot, c: ManagementCommand, scope?: string) {
  const inventory =
    c.action === "stock.move" ||
    (c.action === "record.save" && INVENTORY_KINDS.includes(c.record.kind));
  if (inventory && !scope) return programPermission(s, "admin");
  return mayMaintain(s, scope);
}

function findScopeAircraft(s: Snapshot, existing: Existing, scope?: string) {
  if (existing && "aircraftUuid" in existing && scope !== existing.aircraftUuid)
    throw new Rejection("Records cannot be moved between aircraft.");
  const aircraft = s.aircraft.find((a) => a.uuid === scope);
  if (scope && !aircraft) throw new Rejection("Aircraft not found.");
  return aircraft;
}

// A manual item may be added to each aircraft (inspection) or component
// (requirement) once.
function assertNewSourceItem(
  s: Snapshot,
  records: ManagedRecord[],
  c: ManagementCommand,
  existing: Existing,
) {
  if (existing || !("record" in c)) return;
  const r = c.record;
  if (!("sourceKey" in r) || !r.sourceKey) return;
  const duplicate =
    c.action === "inspection.save"
      ? s.inspections.some(
          (i) =>
            i.sourceKey === r.sourceKey && i.aircraftUuid === r.aircraftUuid,
        )
      : "kind" in r &&
        r.kind === "componentRequirement" &&
        records.some(
          (i) =>
            i.kind === "componentRequirement" &&
            i.sourceKey === r.sourceKey &&
            i.componentUuid === r.componentUuid,
        );
  if (duplicate)
    throw new Rejection(
      "This manual item has already been added to the selected target.",
    );
}
