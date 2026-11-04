/**
 * Responsibility: The one command that changes inventory and inspection
 *   records: admit it, run its action, store the change and audit it.
 * Layer: Domain. Updates the working snapshot; no I/O, no React (a `now` left
 *   to its default reads the clock).
 * Dependencies: ../model, ./schemas, ./context, ./checks, ./inspections,
 *   ./records, ./componentService.
 */
import type { Inspection, Snapshot } from "../model";
import {
  managementCommandSchema,
  type ManagedRecord,
  type ManagementCommand,
} from "./schemas";
import type { Change, Context } from "./context";
import { admitCommand } from "./checks";
import { completeInspection, saveInspection } from "./inspections";
import { moveStock, saveRecord } from "./records";
import { changeComponent } from "./componentService";

/**
 * Applies one inventory or inspection command in the active Flight Program,
 * as the signed-in user, and prepends its change-log entry.
 *
 * @param s - The snapshot; its records, inspections and audit are updated.
 * @param raw - The command, parsed with {@link managementCommandSchema}.
 * @param now - The time to record; the clock by default.
 * @returns The record as saved (`next`) and as it was (`before`), its
 *   aircraft, the records stored (none for an inspection), and inspections
 *   moved with their component.
 * @throws {Rejection} As {@link admitCommand}, then the action's own
 *   refusals; as the component, required-part and shelf-life rules it applies.
 * @throws {z.ZodError} On an invalid command.
 */
export function applyManagement(
  s: Snapshot,
  raw: ManagementCommand,
  now = Date.now(),
) {
  const c = managementCommandSchema.parse(raw);
  const records = s.management ?? [];
  const { existing, scope, aircraft } = admitCommand(s, records, c);
  const ctx = { existing, aircraft, records, now };
  const { next, extras, updatedInspections } = applyCommand(s, c, ctx);
  storeChange(s, records, next, extras, updatedInspections);
  s.audit.unshift({
    uuid: c.requestUuid,
    actorId: s.user.id,
    at: now,
    action: c.action + ("operation" in c ? "." + c.operation : ""),
    entityUuid: next.uuid,
    aircraftUuid: scope || undefined,
    reason: c.reason,
    before: existing ? JSON.stringify(existing) : undefined,
    after: JSON.stringify(next),
  });
  return {
    next,
    before: existing,
    aircraftUuid: scope || undefined,
    records: "kind" in next ? [next, ...extras] : [],
    updatedInspections,
  };
}

function applyCommand(s: Snapshot, c: ManagementCommand, ctx: Context): Change {
  const only = (next: Inspection | ManagedRecord) => ({
    next,
    extras: [],
    updatedInspections: [],
  });
  if (c.action === "inspection.save")
    return only(saveInspection(s, c.record, ctx));
  if (c.action === "inspection.complete")
    return only(completeInspection(c, ctx));
  if (c.action === "record.save") return only(saveRecord(s, c, ctx));
  if (c.action === "stock.move") return only(moveStock(c, ctx));
  return changeComponent(s, c, ctx);
}

function storeChange(
  s: Snapshot,
  records: ManagedRecord[],
  next: Inspection | ManagedRecord,
  extras: ManagedRecord[],
  updatedInspections: Inspection[],
) {
  if ("kind" in next)
    s.management = [
      ...records.filter(
        (r) => r.uuid !== next.uuid && !extras.some((e) => e.uuid === r.uuid),
      ),
      next,
      ...extras,
    ];
  else
    s.inspections = [
      ...s.inspections.filter((r) => r.uuid !== next.uuid),
      next,
    ];
  if (updatedInspections.length)
    s.inspections = s.inspections.map(
      (i) => updatedInspections.find((r) => r.uuid === i.uuid) ?? i,
    );
}
