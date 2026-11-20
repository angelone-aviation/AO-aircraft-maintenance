/**
 * Responsibility: Writing one cost record into a working snapshot with its
 *   change-log row, and the empty record a work order's costs start from.
 * Layer: Domain. Mutates a working snapshot; no I/O, no React.
 * Dependencies: ../model, ../workOrders (types), ../changeLog, ./records.
 */
import type { Snapshot } from "../model";
import type { WorkOrder } from "../workOrders";
import { auditEntry } from "../changeLog";
import type { CostCommand, CostRecord, WorkOrderCost } from "./records";

/** One change to a cost record, as its change-log row names it. */
export interface CostChange {
  /** The row's action after `cost.`: a cost command's. */
  action: CostCommand["action"];
  program: string;
  now: number;
  /** The aircraft costed; its registration becomes the row's reason. */
  aircraftUuid?: string;
}

/**
 * A work order's cost record before anything is costed.
 *
 * @returns Version 0, under a new uuid, held by `program`.
 */
export function emptyWorkOrderCost(
  w: WorkOrder,
  program: string,
): WorkOrderCost {
  return {
    uuid: crypto.randomUUID(),
    version: 0,
    programUuid: program,
    kind: "workOrder",
    aircraftUuid: w.aircraftUuid,
    workOrderUuid: w.uuid,
    labor: [],
    other: [],
    partUnitCosts: [],
  };
}

/**
 * Puts a cost record in place of the stored one and logs the change.
 *
 * @returns `next`.
 *
 * Side effects: replaces the record in `s.costs` and prepends a
 * `cost.<action>` entry to `s.audit` with the record before and after.
 */
export function saveCostRecord(
  s: Snapshot,
  { action, program, now, aircraftUuid }: CostChange,
  next: CostRecord,
) {
  const before = s.costs?.find((r) => r.uuid === next.uuid);
  s.costs = [...(s.costs ?? []).filter((r) => r.uuid !== next.uuid), next];
  // Cost audit entries carry no aircraft so only administrators see them.
  const entry = auditEntry(
    s,
    {
      programUuid: program,
      action: `cost.${action}`,
      entityUuid: next.uuid,
      reason: aircraftUuid
        ? s.aircraft.find((a) => a.uuid === aircraftUuid)?.registration
        : undefined,
      before,
      after: next,
    },
    now,
  );
  s.audit = [entry, ...s.audit];
  return next;
}
