/**
 * Responsibility: Installing, removing, overhauling and repairing a
 *   component, and recording each move in its movement history.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ../model, ../componentInventory, ../rejection, ./records,
 *   ./usage.
 */
import { can, isLocalToday, localDate, type Snapshot } from "../model";
import { validateComponentLocation } from "../componentInventory";
import { Rejection } from "../rejection";
import {
  ComponentUsageError,
  type Component,
  type ComponentMovement,
  type ServiceAction,
} from "./records";
import { componentAircraftSeconds, componentTotals } from "./usage";

/**
 * Records a component's current place and usage in its movement history.
 *
 * @param requestUuid - The command's request id; the entry is
 *   `<requestUuid>-movement`.
 * @param reason - The entry's note.
 * @returns A version-1 entry by the caller, dated the local date of `now`.
 * @throws As {@link componentTotals}.
 */
export function movement(
  c: Component,
  action: ComponentMovement["action"],
  s: Snapshot,
  requestUuid: string,
  reason: string,
  now: number,
): ComponentMovement {
  const t = componentTotals(
    c,
    s.aircraft.find((a) => a.uuid === c.aircraftUuid),
    localDate(now),
  );
  return {
    programUuid: c.programUuid,
    uuid: requestUuid + "-movement",
    version: 1,
    kind: "componentMovement",
    componentUuid: c.uuid,
    aircraftUuid: c.aircraftUuid,
    action,
    date: localDate(now),
    installPosition: c.installPosition,
    partsLocation: c.partsLocation,
    locationUuid: c.locationUuid,
    timeSinceNew: t.timeSinceNew,
    timeSinceOverhaul: t.timeSinceOverhaul,
    timeSinceRepair: t.timeSinceRepair,
    cycles: t.cyclesSinceNew,
    serviceDays: t.serviceDays,
    calendarSinceNewUnknown: c.calendarSinceNewUnknown,
    calendarOverhaulDays: t.calendarOverhaulDays,
    note: reason,
    actorId: s.user.id,
    at: now,
  };
}

/**
 * Installs, removes, overhauls or repairs a component today, freezing the
 * usage it accrued into its new baseline.
 *
 * @param c - The service action; its date must be today in some time zone.
 * @returns The component at the next version. Overhaul zeroes since-overhaul
 *   time and calendar overhaul age; repair zeroes since-repair time.
 * @throws {ComponentUsageError} "Move the parent component; its attached parts
 *   move with it." for installing or removing an attached part.
 * @throws {Rejection} For any other refusal, such as a component out for
 *   repair, a date other than today, an installation state that changed, or
 *   an aircraft the caller may not maintain.
 */
export function serviceComponent(
  s: Snapshot,
  existing: Component,
  c: ServiceAction,
  now: number,
) {
  assertServiceable(existing, c, now);
  const a = s.aircraft.find((a) => a.uuid === existing.aircraftUuid),
    t = componentTotals(existing, a, c.date);
  const next: Component = {
    ...existing,
    timeSinceNew: t.timeSinceNew,
    timeSinceOverhaul: t.timeSinceOverhaul,
    timeSinceRepair: t.timeSinceRepair,
    cyclesSinceNew: t.cyclesSinceNew,
    serviceDaysBase: t.serviceDays,
    calendarOverhaulDaysBase: t.calendarOverhaulDays,
    calendarOverhaulDate: c.date,
    version: existing.version + 1,
  };
  if (c.operation === "install") installComponent(s, existing, next, c);
  else if (c.operation === "remove") removeComponent(next, c);
  else if (c.operation === "overhaul")
    Object.assign(next, {
      timeSinceOverhaul: 0,
      calendarOverhaulDaysBase: 0,
      calendarOverhaulDate: c.date,
    });
  else Object.assign(next, { timeSinceRepair: 0 });
  validateComponentLocation(s, next);
  return next;
}

function assertServiceable(existing: Component, c: ServiceAction, now: number) {
  if (existing.outForRepair)
    throw new Rejection(
      "Receive this component from repair before servicing or installing it.",
    );
  if (
    existing.parentComponentUuid &&
    (c.operation === "install" || c.operation === "remove")
  )
    throw new ComponentUsageError(
      "Move the parent component; its attached parts move with it.",
    );
  if (!isLocalToday(c.date, now))
    throw new Rejection(
      "Use today’s date for current reading snapshots. Set verified historical values through the baseline form.",
    );
  if (
    (c.operation === "install" && existing.installed) ||
    (c.operation === "remove" && !existing.installed)
  )
    throw new Rejection("Component installation state has changed.");
  if (["overhaul", "repair"].includes(c.operation) && existing.installed)
    throw new Rejection(
      "Move the component to inventory before recording overhaul or repair.",
    );
}

function installComponent(
  s: Snapshot,
  existing: Component,
  next: Component,
  c: ServiceAction,
) {
  const target = s.aircraft.find(
    (a) => a.uuid === (c.aircraftUuid ?? existing.aircraftUuid),
  );
  if (!target) throw new Rejection("Select a valid aircraft.");
  if (!can(s, target.uuid, "maintenance"))
    throw new Rejection("Permission denied for destination aircraft.");
  if (!c.installPosition)
    throw new Rejection("Select an installation position.");
  Object.assign(next, {
    aircraftUuid: target.uuid,
    installed: true,
    installedDate: c.date,
    removedDate: undefined,
    installedSeconds: componentAircraftSeconds(existing, target),
    installedCycles: target.cycles,
    installPosition: c.installPosition,
    partsLocation: undefined,
    locationUuid: undefined,
  });
}

function removeComponent(next: Component, c: ServiceAction) {
  if (!c.partsLocation && !c.locationUuid)
    throw new Rejection("Enter the inventory shelf, bin, or room.");
  // Retain the aircraft access scope in storage so its maintenance team can
  // continue work.
  Object.assign(next, {
    installed: false,
    removedDate: c.date,
    partsLocation: c.partsLocation,
    locationUuid: c.locationUuid,
    installPosition: undefined,
  });
}
