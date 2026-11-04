/**
 * Responsibility: The component work a work order records at close-out:
 *   which components it covers, the work chosen for each, and applying it
 *   (moves, repairs, overhauls) to component tracking.
 * Layer: Domain. Zod schemas and an applier on a working snapshot; no I/O, no
 *   React.
 * Dependencies: zod, src/domain/components.ts, componentInventory.ts,
 *   programs.ts, model.ts, workOrders.ts (types), rejection.ts.
 *
 * Usage is frozen at the order's completion date, so a backdated close-out
 * keeps the flights logged since; attached parts move with their parent.
 */
import { z } from "zod";
import {
  componentSchema,
  componentDescendants,
  POSITIONS,
  componentTotals,
  componentAircraftSeconds,
  movementSchema,
  moveRequirement,
  rebaseServicedRequirements,
  type Component,
} from "./components";
import { validateComponentLocation } from "./componentInventory";
import { recordProgram } from "./programs";
import { can, totalSeconds, type Aircraft, type Snapshot } from "./model";
import type { WorkOrder, WorkTask } from "./workOrders";
import { Rejection } from "./rejection";

type Totals = ReturnType<typeof componentTotals>;

// One choice being applied, with what every step of it reads.
interface Work {
  s: Snapshot;
  order: WorkOrder;
  aircraft: Aircraft;
  choice: ComponentWork;
  now: number;
}

/**
 * The work chosen for one component, as saved while the order is open: a
 * description may still be blank.
 *
 * @throws {z.ZodError} From `parse()` on an invalid field.
 */
export const componentWorkDraftSchema = z.object({
  taskUuid: z.string().uuid().optional(),
  installPosition: z.enum(POSITIONS).optional(),
  locationUuid: z.string().optional(),
  partsLocation: z.string().max(150).optional(),
  componentUuid: z.string().min(1),
  version: z.number().int().nonnegative(),
  action: z.enum([
    "service",
    "repair",
    "overhaul",
    "both",
    "install",
    "remove",
  ]),
  description: z.string().trim().max(10000),
  reference: z.string().trim().max(2000),
});

/**
 * The work chosen for one component at close-out: anything but a service
 * needs a description.
 *
 * @throws {z.ZodError} From `parse()` on an invalid field, or on the
 *   description: "Describe the component work performed." for a move,
 *   "Describe the component repair or overhaul." otherwise.
 */
export const componentWorkSchema = componentWorkDraftSchema.superRefine(
  (item, ctx) => {
    if (item.action !== "service" && !item.description)
      ctx.addIssue({
        code: "custom",
        path: ["description"],
        message: isMovement(item)
          ? "Describe the component work performed."
          : "Describe the component repair or overhaul.",
      });
  },
);

/** A parsed {@link componentWorkSchema} choice. */
export type ComponentWork = z.infer<typeof componentWorkSchema>;

/** How each kind of component work reads on screen and in the close-out. */
export const componentWorkLabels = {
  install: "Installed on aircraft",
  remove: "Removed from aircraft",
  service: "Inspected / serviced only",
  repair: "Repaired",
  overhaul: "Overhauled",
  both: "Repaired and overhauled",
};

/**
 * Whether a component's work repairs it, overhauls it, or both. At close-out
 * a repair resets time since repair; an overhaul resets time since overhaul
 * and its calendar days.
 *
 * @param choice - The work chosen for the component.
 * @returns `repair` and `overhaul` flags; "both" sets each.
 */
export function serviceDone(choice: Pick<ComponentWork, "action">) {
  return {
    repair: choice.action === "repair" || choice.action === "both",
    overhaul: choice.action === "overhaul" || choice.action === "both",
  };
}

/**
 * The components a work order covers: those with readings, those it moves
 * by a task, those on its task cards, and those its inspection and component
 * requirement tasks are for.
 *
 * @param s - The snapshot, for task cards, inspections and requirements.
 * @param order - The order, with its readings and component work.
 * @param includePlanned - Count tasks and cards not yet completed (but not
 *   cancelled) too; by default only completed ones count.
 * @returns Component uuids, each once, in that order of discovery.
 */
export function workOrderComponentIds(
  s: Snapshot,
  order: Pick<WorkOrder, "uuid" | "tasks"> & {
    componentReadings: { componentUuid: string }[];
    componentWork?: ComponentWork[];
  },
  includePlanned = false,
) {
  const counts = (status: string, cancelled: string) =>
    status === "completed" || (includePlanned && status !== cancelled);
  const tasks = order.tasks.filter((t) => counts(t.status, "cancelled"));
  const ids = new Set(order.componentReadings.map((c) => c.componentUuid));
  for (const work of order.componentWork ?? [])
    if (isMovement(work) && tasks.some((t) => t.uuid === work.taskUuid))
      ids.add(work.componentUuid);
  for (const card of s.taskCards ?? [])
    if (
      card.workOrderUuid === order.uuid &&
      counts(card.status, "canceled") &&
      card.componentUuid
    )
      ids.add(card.componentUuid);
  for (const task of tasks) {
    const componentUuid = sourceComponentUuid(s, task.source);
    if (componentUuid !== undefined) ids.add(componentUuid);
  }
  return [...ids];
}

/**
 * Applies the chosen work to every component a closing order covers:
 * services and repairs first, then moves, each recorded as component
 * movements tagged with the order.
 *
 * @param s - The working snapshot; `management` and `inspections` change.
 * @param order - The closing order; its completion date dates the work.
 * @param aircraft - The aircraft with its readings at completion.
 * @param choices - One choice per covered component, untrusted.
 * @param now - The time in epoch milliseconds, for the movements.
 * @returns Per choice, in application order: the choice (a removal keeps the
 *   old position), the date, usage before and after, and the tracked records
 *   as JSON before and after with the uuids of the movements added.
 * @throws {z.ZodError} When a choice does not parse.
 * @throws {Rejection} "Select the work performed for every included
 *   component."; "Component tracking changed. Reopen the work order and
 *   review its components."; "Move the parent component; its attached parts
 *   move with it."; "Receive the component from repair before performing
 *   component work."; for a move, "Complete the component movement task
 *   before closing the order.", "Component is unavailable for this aircraft
 *   movement.", "Select an installation position." or "Select the removal
 *   inventory location."
 */
export function applyWorkOrderComponentWork(
  s: Snapshot,
  order: WorkOrder,
  aircraft: Aircraft,
  choices: ComponentWork[],
  now: number,
) {
  const parsed = z.array(componentWorkSchema).parse(choices);
  assertEveryComponentChosen(parsed, workOrderComponentIds(s, order));
  // Finish explicitly selected part service before freezing the assembly's
  // movement readings.
  const ordered = [...parsed].sort(
    (a, b) => Number(isMovement(a)) - Number(isMovement(b)),
  );
  return ordered.map((choice) =>
    applyChoice({ s, order, aircraft, choice, now }),
  );
}

function applyChoice(work: Work) {
  const { s, order, aircraft, choice } = work;
  const c = findChosenComponent(s, order, choice);
  const moving = isMovement(choice);
  const descendants = componentDescendants(s, c.uuid);
  const tracked = () =>
    JSON.stringify(listTrackedRecords(s, c, moving ? descendants : []));
  const baselineBefore = tracked();
  const priorMovements = new Set(listMovementUuids(s));
  if (c.outForRepair)
    throw new Rejection(
      "Receive the component from repair before performing component work.",
    );
  const before = componentTotals(c, aircraft, order.completionDate);
  const { repair, overhaul } = serviceDone(choice);
  if (moving) {
    moveComponent(work, c, before);
    moveAttachedParts(work, c, descendants, priorMovements);
  }
  if (repair || overhaul) serviceComponent(work, c, before);
  return {
    ...choice,
    installPosition:
      choice.action === "remove" ? c.installPosition : choice.installPosition,
    date: order.completionDate,
    before,
    after: usageAfter(before, choice),
    trackingBaseline: {
      before: baselineBefore,
      after: tracked(),
      movementUuids: listMovementUuids(s).filter(
        (uuid) => !priorMovements.has(uuid),
      ),
    },
  };
}

function isMovement(work: Pick<ComponentWork, "action">) {
  return work.action === "install" || work.action === "remove";
}

// A repair or overhaul restarts its own counters; lifetime usage carries on.
function usageAfter(before: Totals, choice: ComponentWork) {
  const { repair, overhaul } = serviceDone(choice);
  return {
    ...before,
    calendarOverhaulDays: overhaul ? 0 : before.calendarOverhaulDays,
    timeSinceRepair: repair ? 0 : before.timeSinceRepair,
    timeSinceOverhaul: overhaul ? 0 : before.timeSinceOverhaul,
  };
}

function sourceComponentUuid(s: Snapshot, source: WorkTask["source"]) {
  if (source.kind === "inspection")
    return (
      s.inspections.find((i) => i.uuid === source.uuid)?.componentUuid ||
      undefined
    );
  if (source.kind !== "componentRequirement") return undefined;
  const r = s.management?.find(
    (r) => r.kind === "componentRequirement" && r.uuid === source.uuid,
  );
  return r?.kind === "componentRequirement" ? r.componentUuid : undefined;
}

function assertEveryComponentChosen(choices: ComponentWork[], ids: string[]) {
  if (
    choices.length !== ids.length ||
    new Set(choices.map((c) => c.componentUuid)).size !== ids.length ||
    choices.some((c) => !ids.includes(c.componentUuid))
  )
    throw new Rejection(
      "Select the work performed for every included component.",
    );
}

function findChosenComponent(
  s: Snapshot,
  order: WorkOrder,
  choice: ComponentWork,
): Component {
  const c = s.management?.find(
    (r): r is Component =>
      r.kind === "component" && r.uuid === choice.componentUuid,
  );
  if (
    !c ||
    (choice.action !== "install" && c.aircraftUuid !== order.aircraftUuid) ||
    c.version !== choice.version
  )
    throw new Rejection(
      "Component tracking changed. Reopen the work order and review its components.",
    );
  if (c.parentComponentUuid && isMovement(choice))
    throw new Rejection(
      "Move the parent component; its attached parts move with it.",
    );
  return c;
}

// The component and its requirements, and for a move also its attached parts
// and theirs: the records a correction must restore.
function listTrackedRecords(
  s: Snapshot,
  c: Component,
  descendants: Component[],
) {
  const covered = (uuid: string) =>
    uuid === c.uuid || descendants.some((child) => child.uuid === uuid);
  return (s.management ?? []).filter(
    (r) =>
      (r.kind === "component" && covered(r.uuid)) ||
      (r.kind === "componentRequirement" && covered(r.componentUuid)),
  );
}

function listMovementUuids(s: Snapshot) {
  return (s.management ?? [])
    .filter((r) => r.kind === "componentMovement")
    .map((r) => r.uuid);
}

function moveComponent(work: Work, c: Component, before: Totals) {
  const { s, order, aircraft, choice, now } = work;
  assertMovementAllowed(work, c);
  const install = choice.action === "install";
  const next = relocate(work, c, before);
  placeComponent(s, next, aircraft);
  s.management!.push(
    movementSchema.parse({
      programUuid: c.programUuid,
      uuid: crypto.randomUUID(),
      version: 1,
      kind: "componentMovement",
      componentUuid: c.uuid,
      aircraftUuid: aircraft.uuid,
      workOrderUuid: order.uuid,
      action: install ? "INSTALL" : "REMOVE",
      date: order.completionDate,
      installPosition: install ? choice.installPosition : c.installPosition,
      locationUuid: next.locationUuid,
      partsLocation: next.partsLocation,
      ...movementUsage(before, c),
      aircraftSnapshot: {
        registration: aircraft.registration,
        make: aircraft.make,
        model: aircraft.model,
        serial: aircraft.serial,
        totalSeconds: totalSeconds(aircraft),
        cycles: aircraft.cycles,
        removedBy: s.user.name,
        mechanic: s.user.licenseNumber ?? "",
      },
      note: workNote(order, choice),
      actorId: s.user.id,
      at: now,
    }),
  );
}

function assertMovementAllowed(
  { s, order, aircraft, choice }: Work,
  c: Component,
) {
  const install = choice.action === "install";
  if (
    !order.tasks.some(
      (t) => t.uuid === choice.taskUuid && t.status === "completed",
    )
  )
    throw new Rejection(
      "Complete the component movement task before closing the order.",
    );
  if (
    c.installed === install ||
    recordProgram(s, c) !== aircraft.programUuid ||
    (c.aircraftUuid && !can(s, c.aircraftUuid, "maintenance"))
  )
    throw new Rejection("Component is unavailable for this aircraft movement.");
  if (install && !choice.installPosition)
    throw new Rejection("Select an installation position.");
  if (!install && !choice.locationUuid && !choice.partsLocation?.trim())
    throw new Rejection("Select the removal inventory location.");
}

function moveAttachedParts(
  work: Work,
  c: Component,
  descendants: Component[],
  priorMovements: Set<string>,
) {
  const { s, order, aircraft } = work;
  for (const child of descendants) {
    if (
      child.installed !== c.installed ||
      child.aircraftUuid !== c.aircraftUuid
    )
      throw new Error(
        "Attached part location is inconsistent with its parent.",
      );
    // Same completion readings as the parent, not the live aircraft totals.
    const usage = componentTotals(child, aircraft, order.completionDate);
    placeComponent(s, relocate(work, child, usage), aircraft);
    const parentMovement = s.management!.find(
      (r) =>
        r.kind === "componentMovement" &&
        r.componentUuid === c.uuid &&
        r.workOrderUuid === order.uuid &&
        !priorMovements.has(r.uuid),
    );
    if (!parentMovement || parentMovement.kind !== "componentMovement")
      throw new Error("Parent movement is missing.");
    s.management!.push(
      movementSchema.parse({
        ...parentMovement,
        uuid: crypto.randomUUID(),
        componentUuid: child.uuid,
        ...movementUsage(usage, child),
        note: `Attached to ${c.model || c.partNumber || c.componentType}: ${parentMovement.note}`,
      }),
    );
  }
}

// The component after a move, its usage frozen at the completion readings.
function relocate(
  { order, aircraft, choice }: Work,
  component: Component,
  usage: Totals,
): Component {
  const install = choice.action === "install";
  return componentSchema.parse({
    ...component,
    version: component.version + 1,
    installed: install,
    aircraftUuid: aircraft.uuid,
    installedDate: install ? order.completionDate : component.installedDate,
    removedDate: install ? undefined : order.completionDate,
    installPosition: install ? choice.installPosition : undefined,
    locationUuid: install ? undefined : choice.locationUuid,
    partsLocation: install ? undefined : choice.partsLocation,
    installedSeconds: install
      ? componentAircraftSeconds(component, aircraft)
      : component.installedSeconds,
    installedCycles: install ? aircraft.cycles : component.installedCycles,
    timeSinceNew: usage.timeSinceNew,
    timeSinceOverhaul: usage.timeSinceOverhaul,
    timeSinceRepair: usage.timeSinceRepair,
    cyclesSinceNew: usage.cyclesSinceNew,
    serviceDaysBase: usage.serviceDays,
    calendarOverhaulDaysBase: usage.calendarOverhaulDays,
    calendarOverhaulDate: order.completionDate,
  });
}

// Stores a moved component; its requirements and inspections follow it to
// the aircraft.
function placeComponent(s: Snapshot, next: Component, aircraft: Aircraft) {
  validateComponentLocation(s, next);
  s.management = s.management!.map((r) => {
    if (r.uuid === next.uuid) return next;
    return r.kind === "componentRequirement" &&
      r.componentUuid === next.uuid &&
      r.aircraftUuid !== aircraft.uuid
      ? moveRequirement(r, aircraft.uuid)
      : r;
  });
  s.inspections = s.inspections.map((i) =>
    i.componentUuid === next.uuid && i.aircraftUuid !== aircraft.uuid
      ? { ...i, aircraftUuid: aircraft.uuid, version: (i.version ?? 0) + 1 }
      : i,
  );
}

function serviceComponent(work: Work, c: Component, before: Totals) {
  const { s, order, aircraft, choice, now } = work;
  const { repair, overhaul } = serviceDone(choice);
  const next = componentSchema.parse({
    ...c,
    version: c.version + 1,
    timeSinceNew: before.timeSinceNew,
    timeSinceOverhaul: overhaul ? 0 : before.timeSinceOverhaul,
    calendarOverhaulDaysBase: overhaul ? 0 : before.calendarOverhaulDays,
    calendarOverhaulDate: order.completionDate,
    timeSinceRepair: repair ? 0 : before.timeSinceRepair,
    cyclesSinceNew: before.cyclesSinceNew,
    installedSeconds: c.installed
      ? componentAircraftSeconds(c, aircraft)
      : c.installedSeconds,
    installedCycles: c.installed ? aircraft.cycles : c.installedCycles,
  });
  s.management = s.management!.map((r) => (r.uuid === c.uuid ? next : r));
  for (const action of [overhaul && "OVERHAUL", repair && "REPAIR"] as const)
    if (action)
      s.management.push(serviceMovement(work, c, next, before, action));
  const updated = rebaseServicedRequirements(
    s,
    next,
    before,
    {
      overhaul,
      repair,
      date: order.completionDate,
      landings: aircraft.landings,
    },
    now,
  );
  s.management = s.management.map(
    (item) => updated.find((r) => r.uuid === item.uuid) ?? item,
  );
}

function serviceMovement(
  { s, order, choice, now }: Work,
  c: Component,
  next: Component,
  before: Totals,
  action: "OVERHAUL" | "REPAIR",
) {
  return movementSchema.parse({
    programUuid: c.programUuid,
    uuid: crypto.randomUUID(),
    version: 1,
    kind: "componentMovement",
    componentUuid: c.uuid,
    aircraftUuid: c.aircraftUuid,
    action,
    workOrderUuid: order.uuid,
    date: order.completionDate,
    installPosition: c.installPosition,
    partsLocation: c.partsLocation,
    timeSinceNew: before.timeSinceNew,
    timeSinceOverhaul: next.timeSinceOverhaul,
    timeSinceRepair: next.timeSinceRepair,
    cycles: before.cyclesSinceNew,
    serviceDays: before.serviceDays,
    calendarSinceNewUnknown: c.calendarSinceNewUnknown,
    calendarOverhaulDays: next.calendarOverhaulDaysBase,
    note: workNote(order, choice),
    actorId: s.user.id,
    at: now,
  });
}

function movementUsage(usage: Totals, component: Component) {
  return {
    timeSinceNew: usage.timeSinceNew,
    timeSinceOverhaul: usage.timeSinceOverhaul,
    timeSinceRepair: usage.timeSinceRepair,
    cycles: usage.cyclesSinceNew,
    serviceDays: usage.serviceDays,
    calendarSinceNewUnknown: component.calendarSinceNewUnknown,
    calendarOverhaulDays: usage.calendarOverhaulDays,
  };
}

function workNote(order: WorkOrder, choice: ComponentWork) {
  const reference = choice.reference ? `; ${choice.reference}` : "";
  return `Work order ${order.number}: ${choice.description}${reference}`;
}
