/**
 * Responsibility: The button that adds an AD's open actions to a work order.
 * Layer: UI. React component; AD status rules live in src/domain.
 * Dependencies: src/domain/airworthiness.ts, src/domain/adWorkOrders.ts,
 *   src/domain/model.ts (types), ./WorkOrders.
 */
import { adAircraftUuid, type AD } from "../domain/airworthiness";
import { adWorkOrderTasks } from "../domain/adWorkOrders";
import type { Snapshot } from "../domain/model";
import { AddToWorkOrder } from "./WorkOrders";

/**
 * Adds the AD's actions that {@link adWorkOrderTasks} offers to a work order,
 * or just `taskUuid` when it is one of them; renders nothing when none is.
 */
export function ADWorkOrderButton({
  state,
  record,
  taskUuid,
}: {
  state: Snapshot;
  record: AD;
  taskUuid?: string;
}) {
  const sources = adWorkOrderTasks(state, record, taskUuid).map((task) => ({
    source: { kind: "airworthiness" as const, uuid: task.uuid },
    description: `AD ${record.source.number}: ${task.description}`,
  }));
  if (!sources.length) return null;
  const aircraftUuid = adAircraftUuid(state, record);
  return taskUuid ? (
    <AddToWorkOrder aircraftUuid={aircraftUuid} source={sources[0].source} />
  ) : (
    <AddToWorkOrder aircraftUuid={aircraftUuid} sources={sources} />
  );
}
