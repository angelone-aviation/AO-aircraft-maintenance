/**
 * Responsibility: The components a work-order close-out reports: which ones,
 *   their usage at completion, and their times after the chosen work.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ../model, ../workOrders (types), ../workOrderComponentWork,
 *   ../components, ../rejection, ./closing.
 */
import type { Snapshot } from "../model";
import type { WorkOrder, WorkTask } from "../workOrders";
import {
  workOrderComponentIds,
  type ComponentWork,
} from "../workOrderComponentWork";
import { componentTotals, type Component } from "../components";
import { Rejection } from "../rejection";
import {
  findRequirement,
  type Closing,
  type ComponentSummary,
  type ServiceResult,
} from "./closing";

/**
 * The uuids of the components a close-out reports: those on the order, its
 * completed job cards, and its completed inspections and requirements.
 *
 * @throws {Rejection} "The work-order completion date cannot precede its
 *   completed job cards.".
 */
export function servicedComponentIds(
  s: Snapshot,
  order: WorkOrder,
  completed: WorkTask[],
) {
  const ids = new Set(workOrderComponentIds(s, order));
  const cards = (s.taskCards ?? []).filter(
    (t) => t.workOrderUuid === order.uuid && t.status === "completed",
  );
  if (cards.some((card) => card.completionDate > order.completionDate))
    throw new Rejection(
      "The work-order completion date cannot precede its completed job cards.",
    );
  for (const card of cards) if (card.componentUuid) ids.add(card.componentUuid);
  for (const task of completed) {
    const uuid = taskComponentUuid(s, task);
    if (uuid !== undefined) ids.add(uuid);
  }
  return ids;
}

/**
 * One serviced component's identity and usage at the completion date, on
 * the dimensions it tracks.
 *
 * @throws {Rejection} "A serviced component has moved or has tracking
 *   changes after the completion date. …" when it is missing, on another
 *   aircraft without an installation, or removed or moved after completion;
 *   as {@link componentTotals}.
 */
export function componentSummary(
  { s, order, a, finalAircraft }: Closing,
  uuid: string,
  componentWork: ComponentWork[],
): ComponentSummary {
  const c = s.management?.find(
    (r): r is Component => r.kind === "component" && r.uuid === uuid,
  );
  const installing = componentWork.some(
    (w) => w.componentUuid === uuid && w.action === "install",
  );
  if (
    !c ||
    (c.aircraftUuid !== a.uuid && !installing) ||
    movedAfter(s, c, order)
  )
    throw new Rejection(
      "A serviced component has moved or has tracking changes after the completion date. Review its tracking before closing this order.",
    );
  const totals = componentTotals(c, finalAircraft, order.completionDate);
  return {
    componentUuid: c.uuid,
    label: `${c.componentType}${c.installPosition ? ` · ${c.installPosition}` : ""}`,
    manufacturer: c.manufacturer,
    model: c.model ?? "",
    partNumber: c.partNumber,
    serial: c.serial,
    timeSinceNew: c.trackTime ? totals.timeSinceNew : null,
    timeSinceOverhaul: c.trackTime ? totals.timeSinceOverhaul : null,
    timeSinceRepair: c.trackTime ? totals.timeSinceRepair : null,
    cyclesSinceNew: c.trackCycles ? totals.cyclesSinceNew : null,
    serviceDays:
      c.trackCalendar && !c.calendarSinceNewUnknown ? totals.serviceDays : null,
  };
}

/**
 * Reports each serviced component's time since overhaul and repair as its
 * work left them, when that work set them or the counter is tracked.
 *
 * @param components - Updated in place.
 */
export function updateServicedTotals(
  components: ComponentSummary[],
  serviceResults: ServiceResult[],
) {
  for (const result of serviceResults) {
    const component = components.find(
      (c) => c.componentUuid === result.componentUuid,
    )!;
    const { action, after } = result;
    if (
      component.timeSinceOverhaul !== null ||
      action === "overhaul" ||
      action === "both"
    )
      component.timeSinceOverhaul = after.timeSinceOverhaul;
    if (
      component.timeSinceRepair !== null ||
      action === "repair" ||
      action === "both"
    )
      component.timeSinceRepair = after.timeSinceRepair;
  }
}

function taskComponentUuid(s: Snapshot, task: WorkTask) {
  if (task.source.kind === "inspection")
    return (
      s.inspections.find((i) => i.uuid === task.source.uuid)?.componentUuid ||
      undefined
    );
  if (task.source.kind !== "componentRequirement") return undefined;
  return findRequirement(s, task.source.uuid)?.componentUuid;
}

function movedAfter(s: Snapshot, c: Component, order: WorkOrder) {
  return (
    (!!c.removedDate && c.removedDate > order.completionDate) ||
    !!s.management?.some(
      (r) =>
        r.kind === "componentMovement" &&
        r.componentUuid === c.uuid &&
        r.date > order.completionDate,
    )
  );
}
