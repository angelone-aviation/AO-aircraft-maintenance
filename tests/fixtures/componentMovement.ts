import type { Snapshot } from "../../src/domain/model";
import {
  applyManagement,
  type ManagementCommand,
} from "../../src/domain/management";
import { newWorkTask, saveWorkOrder } from "../../src/domain/workOrders";
import { workOrderCommand } from "./workOrders";
export function movementOrderCommand(
  s: Snapshot,
  command: Extract<ManagementCommand, { action: "component.service" }>,
) {
  const c = s.management!.find(
    (r) => r.kind === "component" && r.uuid === command.uuid,
  )!;
  if (c.kind !== "component") throw new Error("Component missing");
  if (command.operation !== "install" && command.operation !== "remove")
    throw new Error("Expected movement");
  const task = newWorkTask(
    { kind: "manual", uuid: crypto.randomUUID() },
    command.reason,
  );
  const order = workOrderCommand();
  order.fields = {
    ...order.fields,
    aircraftUuid: command.aircraftUuid ?? c.aircraftUuid,
    dateOpened: command.date,
    status: "completed",
    completionDate: command.date,
    releaseOutcome: "Reviewed component movement",
    finalReview: "Reviewed component identity and tracking",
  };
  order.tasks = [{ ...task, status: "completed", notes: command.reason }];
  order.componentWork = [
    {
      componentUuid: command.uuid,
      version: command.version,
      action: command.operation,
      taskUuid: task.uuid,
      description: command.reason,
      reference: "",
      installPosition: command.installPosition,
      locationUuid: command.locationUuid,
      partsLocation: command.partsLocation,
    },
  ];
  return order;
}
export function applyThroughWorkOrder(
  s: Snapshot,
  command: ManagementCommand,
  now = Date.now(),
) {
  if (
    command.action !== "component.service" ||
    !["install", "remove"].includes(command.operation)
  )
    return applyManagement(s, command, now);
  const close = movementOrderCommand(s, command);
  const open = saveWorkOrder(
    s,
    {
      ...close,
      fields: { ...close.fields, status: "open", completionDate: "" },
    },
    now,
  );
  return saveWorkOrder(s, { ...close, version: open.version }, now);
}
