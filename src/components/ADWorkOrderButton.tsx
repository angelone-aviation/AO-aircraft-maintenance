/**
 * Responsibility: The button that adds an AD's open actions to a work order.
 * Layer: UI. React component; AD status rules live in src/domain.
 * Dependencies: src/domain/airworthiness.ts, src/domain/model.ts (types),
 *   ./WorkOrders.
 */
import {
  adAircraftUuid,
  adStatus,
  adTaskStatus,
  type AD,
} from "../domain/airworthiness";
import type { Snapshot } from "../domain/model";
import { AddToWorkOrder } from "./WorkOrders";

// Only an AD found to apply, or complied with before, has actions to do.
const WORKABLE_APPLICABILITY: readonly string[] = [
  "Applicable",
  "Previously Complied With (PCW)",
];
const OPEN_TASK_STATUSES: readonly string[] = [
  "Scheduled",
  "Due soon",
  "Overdue",
];

/**
 * Adds an AD's scheduled, due-soon and overdue actions to a work order, or
 * just `taskUuid` when it is one of them. Renders nothing for an AD under
 * review, not applicable or on a removed component, or with no open action.
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
  if (!workable(state, record)) return null;
  const sources = record.tasks
    .filter(
      (task) =>
        (!taskUuid || task.uuid === taskUuid) &&
        OPEN_TASK_STATUSES.includes(adTaskStatus(state, record, task)),
    )
    .map((task) => ({
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

function workable(state: Snapshot, record: AD) {
  return (
    !record.reviewRequired &&
    WORKABLE_APPLICABILITY.includes(record.applicability) &&
    adStatus(state, record) !== "Removed component"
  );
}
