/**
 * Responsibility: Records component installs and removals in unit tests the
 *   only way the domain accepts them: through a completed work order.
 * Layer: Test. Vitest fixture over the domain appliers.
 * Dependencies: src/domain (model, management, workOrders),
 *   tests/fixtures/workOrders.
 */
import type { Snapshot } from "../../src/domain/model";
import {
  applyManagement,
  type ManagementCommand,
} from "../../src/domain/management";
import { newWorkTask, saveWorkOrder } from "../../src/domain/workOrders";
import { workOrderCommand } from "./workOrders";

/**
 * Builds a completed work order whose one task performs the movement in
 * `command`, with the command's date, reason, position and location.
 * @param s - Snapshot holding the component.
 * @param command - An install or remove of a component in `s`.
 * @returns A new-order save command; nothing is applied.
 * @throws Error "Expected movement" for any other operation; a TypeError when
 *   `s` has no such component.
 */
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

/**
 * Applies a management command to `s`, sending an install or removal through
 * a work order that is opened and then closed; any other command goes to
 * `applyManagement` unchanged.
 * @param s - Working snapshot; changed in place.
 * @param command - The management command to apply.
 * @param now - Clock for the appliers, in epoch milliseconds.
 * @returns The closed work order for a movement, else what `applyManagement`
 *   returns.
 * @throws The domain appliers' errors, unchanged.
 */
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
  // "New work orders must start open.", so save it open, then close it.
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
