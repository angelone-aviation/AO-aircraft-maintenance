/**
 * Responsibility: What the steps of a work-order close-out share: the order
 *   being closed, the record shapes they build, and the requirement lookup.
 * Layer: Domain. Types and one lookup; no I/O, no React.
 * Dependencies: ../model, ../workOrders (types), ../components (types),
 *   ../workOrderCloseoutSchema (types), ../workOrderComponentWork (types).
 */
import type { Aircraft, Snapshot } from "../model";
import type { WorkOrder } from "../workOrders";
import type { ComponentRequirement } from "../components";
import type { WorkOrderCloseout } from "../workOrderCloseoutSchema";
import type { applyWorkOrderComponentWork } from "../workOrderComponentWork";

/** The order being closed, its aircraft as it was at completion, and when. */
export interface Closing {
  s: Snapshot;
  order: WorkOrder;
  a: Aircraft;
  finalAircraft: Aircraft;
  now: number;
}

/** The compliance a close-out records. */
export type Compliance = WorkOrderCloseout["compliance"];
/** One serviced component as a close-out reports it. */
export type ComponentSummary = WorkOrderCloseout["components"][number];
/** The outcome of one component's chosen work. */
export type ServiceResult = ReturnType<
  typeof applyWorkOrderComponentWork
>[number];

/** The component requirement with this uuid, if there is one. */
export function findRequirement(s: Snapshot, uuid: string) {
  return s.management?.find(
    (r): r is ComponentRequirement =>
      r.uuid === uuid && r.kind === "componentRequirement",
  );
}
