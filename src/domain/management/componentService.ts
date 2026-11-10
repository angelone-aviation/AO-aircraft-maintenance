/**
 * Responsibility: A component's shop service and baseline correction, with
 *   the requirements, inspections and movement entry that follow it.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ../adCompliance, ../components, ../model, ../rejection,
 *   ./schemas, ./context.
 */
import { effectiveCompliance } from "../adCompliance";
import {
  componentTotals,
  moveRequirement,
  movement,
  rebaseServicedRequirements,
  serviceComponent,
  validateComponent,
  type Component,
  type ComponentMovement,
  type ComponentRequirement,
} from "../components";
import { usageOnBasis } from "../components/usage";
import { latestLocalDate, type Inspection, type Snapshot } from "../model";
import { Rejection } from "../rejection";
import type { CommandOf, ManagedRecord } from "./schemas";
import { existingOfKind, type Change, type Context } from "./context";

type ComponentCommand = CommandOf<"component.service" | "component.baseline">;

const MIN_BASELINE_REASON_LENGTH = 10;
const SECONDS_PER_HOUR = 3600;
// Allows the 0.1 h rounding shown for current totals, as AD compliance does.
const HOURS_ROUNDING_ALLOWANCE = 0.05;

const MOVEMENT_ACTIONS: Partial<Record<string, ComponentMovement["action"]>> = {
  install: "INSTALL",
  remove: "REMOVE",
  overhaul: "OVERHAUL",
};

/**
 * Services a component in the shop or corrects its baseline, moving its
 * requirements and inspections with it and recording the movement.
 *
 * @returns The component, its moved or rebased requirements and movement
 *   entry, and its inspections moved to another aircraft.
 * @throws {Rejection} In order: "Component not found."; "Receive the
 *   component from repair before changing it."; "Provide a baseline source or
 *   reason of at least 10 characters." or "Installations and removals must be
 *   completed through a work order."; as {@link validateComponent} or
 *   {@link serviceComponent}; "Baseline would precede recorded inspection
 *   compliance."; "Baseline would precede the last compliance of requirement
 *   "<description>"." or "… of AD <number>.".
 */
export function changeComponent(
  s: Snapshot,
  c: ComponentCommand,
  ctx: Context,
): Change {
  const existing = existingOfKind(ctx.existing, "component");
  if (!existing) throw new Rejection("Component not found.");
  if (existing.outForRepair)
    throw new Rejection(
      "Receive the component from repair before changing it.",
    );
  const { next, extras } =
    c.action === "component.baseline"
      ? {
          next: rebaseline(s, c, existing, ctx.now),
          extras: [] as ManagedRecord[],
        }
      : serviceInShop(s, c, existing, ctx.now);
  if (c.action === "component.baseline")
    assertAfterRecordedCompliance(s, next, () => nextTotals(s, next, ctx.now));
  const updatedInspections = followComponent(s, next, ctx.now);
  if (next.aircraftUuid !== existing.aircraftUuid)
    extras.push(
      ...ctx.records
        .filter(
          (r): r is ComponentRequirement =>
            r.kind === "componentRequirement" && r.componentUuid === next.uuid,
        )
        .map((r) => moveRequirement(r, next.aircraftUuid)),
    );
  const action =
    c.action === "component.baseline"
      ? "BASELINE"
      : (MOVEMENT_ACTIONS[c.operation] ?? "REPAIR");
  extras.push(movement(next, action, s, c.requestUuid, c.reason, ctx.now));
  return { next, extras, updatedInspections };
}

function rebaseline(
  s: Snapshot,
  c: CommandOf<"component.baseline">,
  existing: Component,
  now: number,
): Component {
  if (c.reason.trim().length < MIN_BASELINE_REASON_LENGTH)
    throw new Rejection(
      "Provide a baseline source or reason of at least 10 characters.",
    );
  const next = {
    ...existing,
    installedSeconds: c.installedSeconds,
    installedCycles: c.installedCycles,
    timeSinceNew: c.timeSinceNew,
    timeSinceOverhaul: c.timeSinceOverhaul,
    timeSinceRepair: c.timeSinceRepair,
    cyclesSinceNew: c.cyclesSinceNew,
    serviceDaysBase: c.serviceDaysBase,
    calendarSinceNewUnknown:
      c.calendarSinceNewUnknown ?? existing.calendarSinceNewUnknown,
    calendarOverhaulDaysBase:
      c.calendarOverhaulDaysBase === undefined
        ? existing.calendarOverhaulDaysBase
        : c.calendarOverhaulDaysBase,
    calendarOverhaulDate: baselineOverhaulDate(c, existing),
    installedDate: existing.installed
      ? c.installedDate
      : existing.installedDate,
    version: existing.version + 1,
  };
  validateComponent(s, next, existing, now, true);
  return next;
}

// A new calendar overhaul base counts from the baseline date only while the
// component is installed.
function baselineOverhaulDate(
  c: CommandOf<"component.baseline">,
  existing: Component,
) {
  if (c.calendarOverhaulDaysBase === undefined)
    return existing.calendarOverhaulDate;
  return existing.installed ? c.installedDate : existing.calendarOverhaulDate;
}

// An overhaul or repair restarts the limits counted from it.
function serviceInShop(
  s: Snapshot,
  c: CommandOf<"component.service">,
  existing: Component,
  now: number,
) {
  if (c.operation === "install" || c.operation === "remove")
    throw new Rejection(
      "Installations and removals must be completed through a work order.",
    );
  const next = serviceComponent(s, existing, c, now);
  const extras: ManagedRecord[] = [];
  if (c.operation !== "overhaul" && c.operation !== "repair")
    return { next, extras };
  const aircraft = s.aircraft.find((a) => a.uuid === existing.aircraftUuid);
  const before = componentTotals(existing, aircraft, c.date);
  const work = {
    overhaul: c.operation === "overhaul",
    repair: c.operation === "repair",
    date: c.date,
  };
  extras.push(...rebaseServicedRequirements(s, next, before, work, now));
  return { next, extras };
}

// Inspections of a component follow it to its aircraft, and may not have
// recorded compliance beyond its new usage.
function followComponent(s: Snapshot, next: Component, now: number) {
  const updated: Inspection[] = [];
  for (const i of s.inspections.filter((i) => i.componentUuid === next.uuid)) {
    const counters = nextTotals(s, next, now);
    if (
      counters.timeSinceNew < (i.lastSeconds ?? 0) ||
      counters.cyclesSinceNew < (i.lastCycles ?? 0)
    )
      throw new Rejection(
        "Baseline would precede recorded inspection compliance.",
      );
    if (i.aircraftUuid !== next.aircraftUuid)
      updated.push({
        ...i,
        aircraftUuid: next.aircraftUuid,
        version: (i.version ?? 0) + 1,
      });
  }
  return updated;
}

type Totals = ReturnType<typeof componentTotals>;

function nextTotals(s: Snapshot, next: Component, now: number): Totals {
  const aircraft = s.aircraft.find((a) => a.uuid === next.aircraftUuid);
  return componentTotals(next, aircraft, latestLocalDate(now));
}

// A baseline below a requirement's or an AD's recorded compliance would leave
// more remaining than the whole interval (a 100-hour check with 280 h left),
// so it is refused as it is for inspections; the user corrects the record
// that blocks it first. Totals are read only when such a record exists. Shop
// service needs no check: it rebases the requirements it restarts, and AD
// compliance counts time since new, which service does not change.
function assertAfterRecordedCompliance(
  s: Snapshot,
  next: Component,
  totals: () => Totals,
) {
  for (const r of s.management ?? [])
    if (r.kind === "componentRequirement" && r.componentUuid === next.uuid)
      if (precedesRequirement(r, totals))
        throw new Rejection(
          `Baseline would precede the last compliance of requirement "${r.description}".`,
        );
  for (const r of s.airworthiness ?? [])
    if (r.componentUuid === next.uuid && precedesAD(r, next, totals))
      throw new Rejection(
        `Baseline would precede the last compliance of AD ${r.source.number}.`,
      );
}

function precedesRequirement(r: ComponentRequirement, totals: () => Totals) {
  if (r.lastSeconds === undefined && r.lastCycles === undefined) return false;
  const t = totals();
  const basis = usageOnBasis(r.timeBasis, t);
  return (
    (r.lastSeconds !== undefined &&
      (basis === null || r.lastSeconds > basis)) ||
    (r.lastCycles !== undefined && r.lastCycles > t.cyclesSinceNew)
  );
}

// A component AD counts only the hours and cycles its component tracks.
function precedesAD(
  r: NonNullable<Snapshot["airworthiness"]>[number],
  c: Component,
  totals: () => Totals,
) {
  return effectiveCompliance(r).some((h) => {
    const hours = c.trackTime ? h.hours : null;
    const cycles = c.trackCycles ? h.cycles : null;
    if (hours === null && cycles === null) return false;
    const t = totals();
    return (
      (hours !== null &&
        hours > t.timeSinceNew / SECONDS_PER_HOUR + HOURS_ROUNDING_ALLOWANCE) ||
      (cycles !== null && cycles > t.cyclesSinceNew)
    );
  });
}
