import { recordProgram } from "./programs";
import { validateComponentLocation } from "./componentInventory";
import { requiredPartsSchema } from "./requiredParts";
import { manualReferenceSchema } from "./manuals";
import { z } from "zod";
import { ataChapterSchema } from "./ata";
import {
  can,
  isLocalToday,
  latestLocalDate,
  localDate,
  totalSeconds,
  type Aircraft,
  type Snapshot,
} from "./model";
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().trim().min(1).max(2000);
const date = z.iso.date();
export class ComponentUsageError extends Error {}

export const POSITIONS = [
  "LEFT",
  "RIGHT",
  "NUMBER 1",
  "NUMBER 2",
  "MAIN",
  "AUX",
] as const;
export const componentSchema = z.strictObject({
  outForRepair: z.object({ poUuid: z.string(), date: z.iso.date() }).optional(),
  parentComponentUuid: z.string().trim().min(1).optional(),
  incomingTag: z.record(z.string(), z.string().max(2000)).optional(),
  model: z.string().trim().max(150).optional(),
  faaSearchModel: z.string().trim().max(150).optional(),
  manualReference: manualReferenceSchema.nullable().optional(),
  programUuid: z.string().optional(),
  uuid: text,
  version: count,
  kind: z.literal("component"),
  ataChapter: ataChapterSchema.optional(),
  aircraftUuid: z.string(),
  createdAt: count.optional(),
  componentType: z.string().trim().min(1).max(100),
  partNumber: z.string().trim().max(100),
  serial: z.string().trim().max(100),
  expirationDate: date.optional(),
  manufacturer: z.string().trim().max(150),
  notes: z.string().max(10000),
  usageMeter: z.enum(["aircraft", "collective"]).optional(),
  trackTime: z.boolean(),
  trackCycles: z.boolean(),
  trackCalendar: z.boolean(),
  installed: z.boolean(),
  installedDate: date.optional(),
  removedDate: date.optional(),
  installPosition: z.enum(POSITIONS).optional(),
  locationUuid: z.string().trim().min(1).optional(),
  partsLocation: z.string().trim().max(150).optional(),
  installedSeconds: count,
  installedCycles: count,
  timeSinceNew: count,
  timeSinceOverhaul: count.nullable(),
  timeSinceRepair: count.nullable(),
  cyclesSinceNew: count,
  serviceDaysBase: count.max(365000),
  calendarSinceNewUnknown: z.boolean().optional(),
  calendarOverhaulDaysBase: count.max(365000).nullable().optional(),
  calendarOverhaulDate: date.optional(),
});
export type Component = z.infer<typeof componentSchema>;
export const requirementSchema = z.object({
  requiredParts: requiredPartsSchema.optional(),
  sourceKey: z.string().max(300).optional(),
  manualReference: manualReferenceSchema.nullable().optional(),
  programUuid: z.string().optional(),
  uuid: text,
  version: count,
  kind: z.literal("componentRequirement"),
  componentUuid: text,
  aircraftUuid: z.string(),
  requirementType: z.enum([
    "Life Limits",
    "Overhaul Requirement",
    "Inspection Requirement",
  ]),
  description: z.string().trim().min(1).max(255),
  notes: z.string().max(10000),
  lastDate: date.optional(),
  // A reset can place the previous compliance before zero on the new counter.
  lastSeconds: z.number().int().safe().optional(),
  lastCycles: count.optional(),
  lastLandings: count.optional(),
  calendarIntervalValue: count.positive().max(1000000).optional(),
  calendarIntervalUnit: z.enum(["DAYS", "MONTHS", "YEARS"]),
  intervalSeconds: count.positive().optional(),
  timeBasis: z.enum(["TSN", "TSO", "TSR"]),
  timeLimitMode: z.enum(["ABSOLUTE", "FROM_LAST_COMPLIED"]),
  timeResetSeconds: count.optional(),
  intervalLandings: count.positive().optional(),
  intervalCycles: count.positive().optional(),
  cycleLimitMode: z.enum(["ABSOLUTE", "FROM_LAST_COMPLIED"]),
  landingLimitMode: z.enum(["ABSOLUTE", "FROM_LAST_COMPLIED"]).optional(),
  landingReferenceAircraftUuid: z.string().optional(),
  warningLandings: count.optional(),
  dueDate: date.optional(),
  dueSeconds: count.optional(),
  dueCycles: count.optional(),
  dueLandings: count.optional(),
  warningCalendarMonths: count.max(1200),
  warningSeconds: count,
  warningCycles: count.max(1000000),
});
export type ComponentRequirement = z.infer<typeof requirementSchema>;
export const movementSchema = z.object({
  programUuid: z.string().optional(),
  uuid: text,
  version: count,
  kind: z.literal("componentMovement"),
  componentUuid: text,
  aircraftUuid: z.string(),
  action: z.enum([
    "INSTALL",
    "REMOVE",
    "OVERHAUL",
    "REPAIR",
    "BASELINE",
    "CORRECTION",
    "REPAIR_SHIP",
    "REPAIR_RETURN",
  ]),
  aircraftSnapshot: z
    .object({
      registration: z.string(),
      make: z.string(),
      model: z.string(),
      serial: z.string(),
      totalSeconds: count,
      cycles: count,
      removedBy: z.string(),
      mechanic: z.string(),
    })
    .optional(),
  workOrderUuid: z.string().optional(),
  correctionUuid: z.string().optional(),
  supersededByCorrection: z.string().optional(),
  date,
  installPosition: z.enum(POSITIONS).optional(),
  locationUuid: z.string().trim().min(1).optional(),
  partsLocation: z.string().optional(),
  timeSinceNew: count,
  timeSinceOverhaul: count.nullable(),
  timeSinceRepair: count.nullable(),
  cycles: count,
  serviceDays: count,
  calendarSinceNewUnknown: z.boolean().optional(),
  calendarOverhaulDays: count.nullable().optional(),
  note: z.string().trim().min(1).max(14000),
  actorId: text,
  at: count,
});
export type ComponentMovement = z.infer<typeof movementSchema>;
export const baselineFields = {
  installedSeconds: count,
  installedCycles: count,
  timeSinceNew: count,
  timeSinceOverhaul: count.nullable(),
  timeSinceRepair: count.nullable(),
  cyclesSinceNew: count,
  serviceDaysBase: count.max(365000),
  calendarSinceNewUnknown: z.boolean().optional(),
  calendarOverhaulDaysBase: count.max(365000).nullable().optional(),
  calendarOverhaulDate: date.optional(),
  installedDate: date.optional(),
};
export const serviceFields = {
  operation: z.enum(["install", "remove", "overhaul", "repair"]),
  date,
  aircraftUuid: z.string().optional(),
  installPosition: z.enum(POSITIONS).optional(),
  locationUuid: z.string().trim().min(1).optional(),
  partsLocation: z.string().trim().min(1).max(150).optional(),
};
export const tracking = (c: Component) => ({
  time: c.trackTime,
  cycles: c.trackCycles,
  calendar: c.trackCalendar,
});
const dayMs = 86400000;
/** Component usage can follow collective time independently of airframe time. */
export function componentAircraftSeconds(
  c: Pick<Component, "usageMeter">,
  a: Aircraft,
) {
  if (c.usageMeter !== "collective") return totalSeconds(a);
  if (!a.helicopter || a.currentCyclicHobbs === undefined)
    throw new Error(
      "Collective component tracking requires a helicopter collective hourmeter reading.",
    );
  return a.currentCyclicHobbs;
}
// Days from a stored date to today. A date one day ahead is time-zone skew
// (device-local dates checked on a UTC server, or the reverse), not a reading
// that precedes the baseline, so it counts as zero elapsed days.
function elapsedDays(from: string, today: string) {
  const days = Math.round((Date.parse(today) - Date.parse(from)) / dayMs);
  return days === -1 ? 0 : days;
}
export function componentTotals(
  c: Component,
  a?: Aircraft,
  today = localDate(),
) {
  const track = tracking(c);
  if (c.installed && !a) throw new Error("Installed aircraft not found.");
  const seconds =
    c.installed && track.time
      ? componentAircraftSeconds(c, a!) - c.installedSeconds
      : 0;
  const cycles =
    c.installed && track.cycles ? a!.cycles - c.installedCycles : 0;
  const days =
    c.installed && track.calendar && c.installedDate
      ? elapsedDays(c.installedDate, today)
      : 0;
  const overhaulDate = c.calendarOverhaulDate ?? c.installedDate;
  const overhaulDays =
    c.installed &&
    track.calendar &&
    c.calendarOverhaulDaysBase != null &&
    overhaulDate
      ? elapsedDays(overhaulDate, today)
      : 0;
  if (seconds < 0 || cycles < 0 || days < 0 || overhaulDays < 0)
    throw new Error(
      "Aircraft readings or date precede the installation baseline.",
    );
  return {
    timeSinceNew: c.timeSinceNew + seconds,
    timeSinceOverhaul:
      c.timeSinceOverhaul === null ? null : c.timeSinceOverhaul + seconds,
    timeSinceRepair:
      c.timeSinceRepair === null ? null : c.timeSinceRepair + seconds,
    cyclesSinceNew: c.cyclesSinceNew + cycles,
    serviceDays: c.serviceDaysBase + days,
    calendarOverhaulDays:
      c.calendarOverhaulDaysBase == null
        ? null
        : c.calendarOverhaulDaysBase + overhaulDays,
  };
}
function shiftCalendarDate(
  start: string,
  value: number,
  unit: "DAYS" | "MONTHS" | "YEARS",
  monthEnd: boolean,
): string {
  date.parse(start);
  const d = new Date(start + "T00:00:00Z");
  if (unit === "DAYS") d.setUTCDate(d.getUTCDate() + value);
  else {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + value * (unit === "YEARS" ? 12 : 1));
    const end = new Date(d);
    end.setUTCMonth(end.getUTCMonth() + 1);
    end.setUTCDate(0);
    d.setUTCDate(monthEnd ? end.getUTCDate() : Math.min(day, end.getUTCDate()));
  }
  if (
    !Number.isFinite(d.getTime()) ||
    d.getUTCFullYear() > 9999 ||
    d.getUTCFullYear() < 1
  )
    throw new Error("Calendar interval exceeds supported dates.");
  return d.toISOString().slice(0, 10);
}
export function calendarDue(
  start: string,
  value: number,
  unit: "DAYS" | "MONTHS" | "YEARS",
): string {
  return shiftCalendarDate(start, value, unit, true);
}
// Use compliance and interval for recurring requirements, including older records.
export function requirementDueDate(
  r: ComponentRequirement,
): string | undefined {
  return r.lastDate && r.calendarIntervalValue
    ? calendarDue(r.lastDate, r.calendarIntervalValue, r.calendarIntervalUnit)
    : r.dueDate;
}
export function requirementStatus(
  r: ComponentRequirement,
  c: Component,
  a?: Aircraft,
  today = localDate(),
) {
  const t = componentTotals(c, a, today),
    basis =
      r.timeBasis === "TSN"
        ? t.timeSinceNew
        : r.timeBasis === "TSO"
          ? t.timeSinceOverhaul
          : t.timeSinceRepair;
  const seconds =
    r.dueSeconds === undefined || basis === null
      ? undefined
      : r.dueSeconds - basis;
  const cycles =
    r.dueCycles === undefined ? undefined : r.dueCycles - t.cyclesSinceNew;
  const landingBaselineMissing =
    r.dueLandings !== undefined &&
    (!a ||
      !c.installed ||
      (r.landingReferenceAircraftUuid !== undefined &&
        r.landingReferenceAircraftUuid !== a.uuid));
  const landings =
    r.dueLandings === undefined || landingBaselineMissing
      ? undefined
      : r.dueLandings - a!.landings;
  const dueDate = requirementDueDate(r);
  const days = dueDate
    ? Math.round((Date.parse(dueDate) - Date.parse(today)) / dayMs)
    : undefined;
  const calendarSoon =
    dueDate &&
    today >=
      shiftCalendarDate(dueDate, -r.warningCalendarMonths, "MONTHS", false);
  return {
    seconds,
    cycles,
    landings,
    days,
    // A computable overdue limit outranks a missing baseline on another
    // dimension. A usage limit with nothing left is reached, because the next
    // flight would exceed it; a calendar limit stays valid through its due
    // date, so on that day it is only due soon (calendarSoon).
    status: [seconds, cycles, landings, days].some(
      (n) => n !== undefined && n < 0,
    )
      ? "Past due"
      : [seconds, cycles, landings].some((n) => n === 0)
        ? "Due now"
        : landingBaselineMissing
          ? "Set landing baseline"
          : r.dueSeconds !== undefined && basis === null
            ? "Set time baseline"
            : calendarSoon ||
                (seconds !== undefined && seconds <= r.warningSeconds) ||
                (cycles !== undefined && cycles <= r.warningCycles) ||
                (landings !== undefined &&
                  landings <= (r.warningLandings ?? 10))
              ? "Due soon"
              : "Tracked",
  };
}
const todayAt = (now: number) => localDate(now);
function validPastDate(d: string | undefined, now: number) {
  if (d && d > latestLocalDate(now))
    throw new Error("Dates cannot be in the future.");
}
function componentRequirements(s: Snapshot, id: string) {
  return (s.management ?? []).filter(
    (r): r is ComponentRequirement =>
      r.kind === "componentRequirement" && r.componentUuid === id,
  );
}
export function validateComponent(
  s: Snapshot,
  r: Component,
  existing: Component | undefined,
  now: number,
  baseline = false,
) {
  if (existing?.outForRepair)
    throw Error("Receive this component from repair before editing it.");
  validateComponentLocation(s, r);
  if (existing && existing.parentComponentUuid !== r.parentComponentUuid)
    throw new ComponentUsageError(
      "The attached parent cannot be changed through component details.",
    );
  if (r.parentComponentUuid) {
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
    if (
      componentDescendants(s, r.uuid).some((item) => item.uuid === parent.uuid)
    )
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
  const track = tracking(r),
    a = s.aircraft.find((a) => a.uuid === r.aircraftUuid);
  if (!track.time && !track.cycles && !track.calendar)
    throw new Error("Select at least one tracking dimension.");
  if (
    r.serial &&
    r.partNumber &&
    (s.management ?? []).some(
      (o) =>
        o.kind === "component" &&
        o.uuid !== r.uuid &&
        o.partNumber.toLowerCase() === r.partNumber.toLowerCase() &&
        o.serial.toLowerCase() === r.serial.toLowerCase(),
    )
  )
    throw new Error("Part number and serial already exist.");
  for (const d of [r.installedDate, r.removedDate]) validPastDate(d, now);
  if (
    (r.timeSinceOverhaul !== null && r.timeSinceOverhaul > r.timeSinceNew) ||
    (r.timeSinceRepair != null && r.timeSinceRepair > r.timeSinceNew)
  )
    throw new ComponentUsageError(
      "Since-overhaul and since-repair readings cannot exceed since-new usage. Enter the verified component TSN; zero means new, not unknown.",
    );
  if (r.installed) {
    if (!a || !r.installedDate)
      throw new Error(
        "Installed components need an aircraft and installation date.",
      );
    if (!r.installPosition) throw new Error("Select an installation position.");
    // Validation only: accept a local installation date ahead of the server's UTC date.
    componentTotals(r, a, latestLocalDate(now));
  } else if (!r.partsLocation && !r.locationUuid)
    throw new Error("Enter the inventory shelf, bin, or room.");
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
    throw new Error(
      "A requirement still uses a tracking dimension being disabled.",
    );
  if (existing && !baseline) {
    for (const key of [
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
    ] as const)
      if (r[key] !== existing[key])
        throw new Error(
          "Use movement or baseline actions to change installation and usage.",
        );
    // Changing tracking is supported with explicit baselines, avoiding retroactive accrual.
    if (
      existing.installed &&
      (track.time !== tracking(existing).time ||
        track.cycles !== tracking(existing).cycles ||
        track.calendar !== tracking(existing).calendar)
    )
      throw new Error(
        "Move the component to inventory before changing its tracking dimensions.",
      );
  }
}
export function saveRequirement(
  s: Snapshot,
  r: ComponentRequirement,
  now: number,
) {
  const c = (s.management ?? []).find(
    (c): c is Component => c.kind === "component" && c.uuid === r.componentUuid,
  );
  if (!c) throw new Error("Component not found.");
  if (r.aircraftUuid !== c.aircraftUuid)
    throw new Error("Component location changed. Refresh and try again.");
  const t = componentTotals(
      c,
      s.aircraft.find((a) => a.uuid === c.aircraftUuid),
      latestLocalDate(now),
    ),
    track = tracking(c);
  const basis =
    r.timeBasis === "TSN"
      ? t.timeSinceNew
      : r.timeBasis === "TSO"
        ? t.timeSinceOverhaul
        : t.timeSinceRepair;
  if (
    !r.intervalSeconds &&
    !r.intervalCycles &&
    !r.intervalLandings &&
    !r.calendarIntervalValue
  )
    throw new Error("Set at least one service limit.");
  if (
    (r.intervalSeconds && !track.time) ||
    (r.intervalCycles && !track.cycles) ||
    (r.calendarIntervalValue && !track.calendar)
  )
    throw new Error(
      "Enable the corresponding tracking dimension on the component first.",
    );
  if (r.intervalSeconds && basis === null)
    throw new Error(
      "Set a verified " + r.timeBasis + " baseline before adding a time limit.",
    );
  const aircraft = s.aircraft.find((a) => a.uuid === c.aircraftUuid);
  if (r.intervalLandings && (!aircraft || !c.installed))
    throw new Error("Aircraft landing limits require an installed component.");
  if (
    r.intervalLandings &&
    r.landingReferenceAircraftUuid &&
    r.landingReferenceAircraftUuid !== c.aircraftUuid
  )
    throw new Error(
      "Review the landing baseline for the new aircraft before saving this service requirement.",
    );
  validPastDate(r.lastDate, now);
  if (
    (r.lastSeconds !== undefined &&
      (basis === null || r.lastSeconds > basis)) ||
    (r.lastCycles !== undefined && r.lastCycles > t.cyclesSinceNew) ||
    (r.lastLandings !== undefined &&
      (!aircraft || r.lastLandings > aircraft.landings))
  )
    throw new Error("Last compliance exceeds current component usage.");
  if (
    (r.intervalSeconds &&
      r.timeLimitMode === "FROM_LAST_COMPLIED" &&
      r.lastSeconds === undefined) ||
    (r.intervalCycles &&
      r.cycleLimitMode === "FROM_LAST_COMPLIED" &&
      r.lastCycles === undefined) ||
    (r.intervalLandings &&
      r.landingLimitMode !== "ABSOLUTE" &&
      r.lastLandings === undefined) ||
    (r.calendarIntervalValue && !r.lastDate)
  )
    throw new Error("Enter last compliance for each relative interval.");
  return requirementSchema.parse({
    ...r,
    version: r.version + 1,
    dueSeconds:
      r.intervalSeconds === undefined
        ? undefined
        : Math.max(
            0,
            r.intervalSeconds +
              (r.timeLimitMode === "ABSOLUTE"
                ? -(r.timeResetSeconds ?? 0)
                : r.lastSeconds!),
          ),
    dueLandings:
      r.intervalLandings === undefined
        ? undefined
        : r.intervalLandings +
          (r.landingLimitMode === "ABSOLUTE" ? 0 : r.lastLandings!),
    landingReferenceAircraftUuid: r.intervalLandings
      ? c.aircraftUuid
      : undefined,
    dueCycles:
      r.intervalCycles === undefined
        ? undefined
        : r.intervalCycles +
          (r.cycleLimitMode === "ABSOLUTE" ? 0 : r.lastCycles!),
    dueDate: r.calendarIntervalValue
      ? calendarDue(
          r.lastDate!,
          r.calendarIntervalValue,
          r.calendarIntervalUnit,
        )
      : undefined,
  });
}
/**
 * A requirement following its component to another aircraft. Landing counts belong to
 * the aircraft they were recorded on, so the reference stays there (also stamped on older
 * records without one) and status asks for a new landing baseline.
 */
export function moveRequirement(
  r: ComponentRequirement,
  aircraftUuid: string,
): ComponentRequirement {
  return {
    ...r,
    aircraftUuid,
    version: r.version + 1,
    landingReferenceAircraftUuid:
      r.dueLandings === undefined
        ? r.landingReferenceAircraftUuid
        : (r.landingReferenceAircraftUuid ?? r.aircraftUuid),
  };
}
/**
 * Requirements updated by a repair or overhaul of `next` (the component after its reset).
 * Overhaul requirements renew only for an actual overhaul; lifetime limits never renew.
 * Other TSO/TSR intervals keep their remaining time on the reset counter.
 */
export function rebaseServicedRequirements(
  s: Snapshot,
  next: Component,
  before: Pick<
    ReturnType<typeof componentTotals>,
    "timeSinceNew" | "timeSinceOverhaul" | "timeSinceRepair" | "cyclesSinceNew"
  >,
  work: { overhaul: boolean; repair: boolean; date: string; landings?: number },
  now: number,
): ComponentRequirement[] {
  const view = {
    ...s,
    management: (s.management ?? []).map((r) =>
      r.uuid === next.uuid ? next : r,
    ),
  };
  return componentRequirements(view, next.uuid).flatMap((r) => {
    const reset =
      (r.timeBasis === "TSO" && work.overhaul) ||
      (r.timeBasis === "TSR" && work.repair);
    const renew = work.overhaul && r.requirementType === "Overhaul Requirement";
    if ((reset || renew) && r.lastDate && r.lastDate > work.date)
      throw new Error(
        "A component requirement has later compliance. Review its tracking before backdating this repair or overhaul.",
      );
    if (renew) {
      const basis =
        r.timeBasis === "TSN"
          ? before.timeSinceNew
          : r.timeBasis === "TSO"
            ? next.timeSinceOverhaul
            : next.timeSinceRepair;
      return [
        saveRequirement(
          view,
          {
            ...r,
            timeResetSeconds: 0,
            lastDate: work.date,
            lastSeconds: basis ?? undefined,
            lastCycles: before.cyclesSinceNew,
            lastLandings: r.intervalLandings ? work.landings : undefined,
          },
          now,
        ),
      ];
    }
    const prior =
      r.timeBasis === "TSO" ? before.timeSinceOverhaul : before.timeSinceRepair;
    if (!reset || !r.intervalSeconds || prior === null) return [];
    return [
      {
        ...r,
        version: r.version + 1,
        timeResetSeconds: (r.timeResetSeconds ?? 0) + prior,
        lastSeconds:
          r.lastSeconds === undefined ? undefined : r.lastSeconds - prior,
        // ponytail: dueSeconds is a non-negative count, so an overdue interval
        // resets to "Due now" and the overdue amount is not carried.
        dueSeconds: Math.max(0, (r.dueSeconds ?? r.intervalSeconds) - prior),
      },
    ];
  });
}
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
    todayAt(now),
  );
  return {
    programUuid: c.programUuid,
    uuid: requestUuid + "-movement",
    version: 1,
    kind: "componentMovement",
    componentUuid: c.uuid,
    aircraftUuid: c.aircraftUuid,
    action,
    date: todayAt(now),
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
export function serviceComponent(
  s: Snapshot,
  existing: Component,
  c: z.infer<z.ZodObject<typeof serviceFields>>,
  now: number,
) {
  if (existing.outForRepair)
    throw Error(
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
    throw new Error(
      "Use today’s date for current reading snapshots. Set verified historical values through the baseline form.",
    );
  if (
    (c.operation === "install" && existing.installed) ||
    (c.operation === "remove" && !existing.installed)
  )
    throw new Error("Component installation state has changed.");
  if (["overhaul", "repair"].includes(c.operation) && existing.installed)
    throw new Error(
      "Move the component to inventory before recording overhaul or repair.",
    );
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
  if (c.operation === "install") {
    const target = s.aircraft.find(
      (a) => a.uuid === (c.aircraftUuid ?? existing.aircraftUuid),
    );
    if (!target) throw new Error("Select a valid aircraft.");
    if (!can(s, target.uuid, "maintenance"))
      throw new Error("Permission denied for destination aircraft.");
    if (!c.installPosition) throw new Error("Select an installation position.");
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
  } else if (c.operation === "remove") {
    if (!c.partsLocation && !c.locationUuid)
      throw new Error("Enter the inventory shelf, bin, or room.");
    // Retain the aircraft access scope in storage so its maintenance team can continue work.
    Object.assign(next, {
      installed: false,
      removedDate: c.date,
      partsLocation: c.partsLocation,
      locationUuid: c.locationUuid,
      installPosition: undefined,
    });
  } else if (c.operation === "overhaul")
    Object.assign(next, {
      timeSinceOverhaul: 0,
      calendarOverhaulDaysBase: 0,
      calendarOverhaulDate: c.date,
    });
  else Object.assign(next, { timeSinceRepair: 0 });
  validateComponentLocation(s, next);
  return next;
}

/** All attached descendants, in parent-first order. Reject corrupt cycles. */
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
