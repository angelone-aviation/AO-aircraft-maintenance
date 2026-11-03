import {
  adAircraftUuid,
  adStatus,
  adTaskStatus,
  type AD,
} from "../domain/airworthiness";
import type { Snapshot } from "../domain/model";
import { AddToWorkOrder } from "./WorkOrders";

export function ADWorkOrderButton({
  state,
  record,
  taskUuid,
}: {
  state: Snapshot;
  record: AD;
  taskUuid?: string;
}) {
  if (
    record.reviewRequired ||
    !["Applicable", "Previously Complied With (PCW)"].includes(
      record.applicability,
    ) ||
    adStatus(state, record) === "Removed component"
  )
    return null;
  const sources = record.tasks
    .filter(
      (task) =>
        (!taskUuid || task.uuid === taskUuid) &&
        ["Scheduled", "Due soon", "Overdue"].includes(
          adTaskStatus(state, record, task),
        ),
    )
    .map((task) => ({
      source: { kind: "airworthiness" as const, uuid: task.uuid },
      description: `AD ${record.source.number}: ${task.description}`,
    }));
  if (!sources.length) return null;
  return taskUuid ? (
    <AddToWorkOrder
      aircraftUuid={adAircraftUuid(state, record)}
      source={sources[0].source}
    />
  ) : (
    <AddToWorkOrder
      aircraftUuid={adAircraftUuid(state, record)}
      sources={sources}
    />
  );
}
