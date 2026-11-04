/**
 * Responsibility: The rules a new or edited component must meet before it is
 *   saved, including where an attached part may sit.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ../model, ../programs, ../componentInventory, ../rejection,
 *   ./records, ./usage, ./calendar, ./requirements.
 */
import { latestLocalDate, type Aircraft, type Snapshot } from "../model";
import { recordProgram } from "../programs";
import { validateComponentLocation } from "../componentInventory";
import { Rejection } from "../rejection";
import { assertPastDate } from "./calendar";
import { ComponentUsageError, type Component } from "./records";
import { componentRequirements } from "./requirements";
import { componentTotals, tracking } from "./usage";

// Installation and usage that an edit may not change: movements and
// baselines change them, and record why.
const USAGE_FIELDS = [
  "installed",
  "installedDate",
  "removedDate",
  "aircraftUuid",
  "installedSeconds",
  "usageMeter",
  "installedCycles",
  "timeSinceNew",
  "timeSinceOverhaul",
  "timeSinceRepair",
  "cyclesSinceNew",
  "serviceDaysBase",
  "calendarSinceNewUnknown",
  "calendarOverhaulDaysBase",
  "calendarOverhaulDate",
] as const;

/**
 * Checks a new or edited component against the records before it is saved.
 *
 * @param existing - The stored component, or undefined for a new one.
 * @param baseline - True for a verified-baseline edit, the only edit that may
 *   change installation and usage.
 * @throws {ComponentUsageError} For a parent attachment that changed, is
 *   missing, cyclic or placed elsewhere; or since-overhaul or since-repair
 *   time above since-new.
 * @throws {Rejection} For any other refusal, such as a component out for
 *   repair, no tracked dimension, a duplicate part and serial, or a future
 *   date; and as `validateComponentLocation` and {@link componentTotals}.
 */
export function validateComponent(
  s: Snapshot,
  r: Component,
  existing: Component | undefined,
  now: number,
  baseline = false,
) {
  if (existing?.outForRepair)
    throw new Rejection(
      "Receive this component from repair before editing it.",
    );
  validateComponentLocation(s, r);
  assertParentAttachment(s, r, existing);
  const track = tracking(r);
  const a = s.aircraft.find((a) => a.uuid === r.aircraftUuid);
  if (!track.time && !track.cycles && !track.calendar)
    throw new Rejection("Select at least one tracking dimension.");
  assertUniquePartSerial(s, r);
  for (const d of [r.installedDate, r.removedDate]) assertPastDate(d, now);
  if (
    (r.timeSinceOverhaul !== null && r.timeSinceOverhaul > r.timeSinceNew) ||
    (r.timeSinceRepair != null && r.timeSinceRepair > r.timeSinceNew)
  )
    throw new ComponentUsageError(
      "Since-overhaul and since-repair readings cannot exceed since-new usage. Enter the verified component TSN; zero means new, not unknown.",
    );
  assertPlacement(r, a, now);
  assertTrackingUnused(s, r);
  if (existing && !baseline) assertUsageUnchanged(r, existing);
}

/**
 * Every component attached below a parent, at any depth.
 *
 * @returns The descendants in parent-first (depth-first) order.
 * @throws {ComponentUsageError} "Component attachment cycle detected." for
 *   corrupt attachments.
 */
export function componentDescendants(
  s: Snapshot,
  parentUuid: string,
): Component[] {
  const result: Component[] = [],
    seen = new Set([parentUuid]);
  const visit = (uuid: string) => {
    for (const item of s.management ?? []) {
      if (item.kind !== "component" || item.parentComponentUuid !== uuid)
        continue;
      if (seen.has(item.uuid))
        throw new ComponentUsageError("Component attachment cycle detected.");
      seen.add(item.uuid);
      result.push(item);
      visit(item.uuid);
    }
  };
  visit(parentUuid);
  return result;
}

function assertParentAttachment(
  s: Snapshot,
  r: Component,
  existing: Component | undefined,
) {
  if (existing && existing.parentComponentUuid !== r.parentComponentUuid)
    throw new ComponentUsageError(
      "The attached parent cannot be changed through component details.",
    );
  if (!r.parentComponentUuid) return;
  const parent = s.management?.find(
    (item): item is Component =>
      item.kind === "component" && item.uuid === r.parentComponentUuid,
  );
  if (
    !parent ||
    parent.uuid === r.uuid ||
    recordProgram(s, parent) !== recordProgram(s, r)
  )
    throw new ComponentUsageError(
      "Select a parent component in the same Flight Program.",
    );
  if (componentDescendants(s, r.uuid).some((item) => item.uuid === parent.uuid))
    throw new ComponentUsageError(
      "A component cannot be attached to its own descendant.",
    );
  if (
    r.installed !== parent.installed ||
    r.aircraftUuid !== parent.aircraftUuid ||
    r.locationUuid !== parent.locationUuid ||
    r.partsLocation !== parent.partsLocation ||
    r.installPosition !== parent.installPosition
  )
    throw new ComponentUsageError(
      "Attached parts must stay with their parent component's aircraft or inventory location.",
    );
}

// Part and serial numbers match whatever their case.
function assertUniquePartSerial(s: Snapshot, r: Component) {
  if (!r.serial || !r.partNumber) return;
  const duplicate = (s.management ?? []).some(
    (o) =>
      o.kind === "component" &&
      o.uuid !== r.uuid &&
      o.partNumber.toLowerCase() === r.partNumber.toLowerCase() &&
      o.serial.toLowerCase() === r.serial.toLowerCase(),
  );
  if (duplicate) throw new Rejection("Part number and serial already exist.");
}

function assertPlacement(r: Component, a: Aircraft | undefined, now: number) {
  if (!r.installed && !r.partsLocation && !r.locationUuid)
    throw new Rejection("Enter the inventory shelf, bin, or room.");
  if (!r.installed) return;
  if (!a || !r.installedDate)
    throw new Rejection(
      "Installed components need an aircraft and installation date.",
    );
  if (!r.installPosition)
    throw new Rejection("Select an installation position.");
  // Validation only: accept a local installation date ahead of the server's
  // UTC date.
  componentTotals(r, a, latestLocalDate(now));
}

// A dimension cannot be switched off while a requirement or inspection of
// the component is still measured on it.
function assertTrackingUnused(s: Snapshot, r: Component) {
  const track = tracking(r);
  const requirements = componentRequirements(s, r.uuid);
  const inspections = s.inspections.filter(
    (i) => i.componentUuid === r.uuid && !i.archived,
  );
  if (
    (!track.time &&
      (requirements.some((q) => q.intervalSeconds) ||
        inspections.some((i) => i.dueSeconds !== undefined))) ||
    (!track.cycles &&
      (requirements.some((q) => q.intervalCycles) ||
        inspections.some((i) => i.dueCycles !== undefined))) ||
    (!track.calendar &&
      (requirements.some((q) => q.calendarIntervalValue) ||
        inspections.some((i) => i.dueDate)))
  )
    throw new Rejection(
      "A requirement still uses a tracking dimension being disabled.",
    );
}

function assertUsageUnchanged(r: Component, existing: Component) {
  if (USAGE_FIELDS.some((key) => r[key] !== existing[key]))
    throw new Rejection(
      "Use movement or baseline actions to change installation and usage.",
    );
  // Changing tracking is supported with explicit baselines, avoiding
  // retroactive accrual.
  const track = tracking(r);
  const tracked = tracking(existing);
  if (
    existing.installed &&
    (track.time !== tracked.time ||
      track.cycles !== tracked.cycles ||
      track.calendar !== tracked.calendar)
  )
    throw new Rejection(
      "Move the component to inventory before changing its tracking dimensions.",
    );
}
