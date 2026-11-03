/**
 * Responsibility: Serialized, life-tracked components and their service
 *   requirements: stored schemas, accrued usage, due status, and the rules
 *   for editing, servicing and moving them.
 * Layer: Domain. Pure functions and zod schemas; no I/O, no React (a `today`
 *   left to its default reads the clock).
 * Dependencies: zod; ./model, ./programs, ./componentInventory,
 *   ./requiredParts, ./manuals, ./ata, ./rejection.
 *
 * Usage is stored as a baseline and accrues from the aircraft's meters while
 * installed; movements and service actions re-base it rather than edit it.
 */
import { recordProgram } from "./programs";
import { validateComponentLocation } from "./componentInventory";
import { requiredPartsSchema } from "./requiredParts";
import { manualReferenceSchema } from "./manuals";
import { z } from "zod";
import { ataChapterSchema } from "./ata";
import { Rejection } from "./rejection";
import {
  can,
  isLocalToday,
  latestLocalDate,
  localDate,
  totalSeconds,
  type Aircraft,
  type Snapshot,
} from "./model";

const DAY_MS = 86_400_000;
const NOTES_MAX_LENGTH = 10_000;
// About 1,000 years: a sanity bound on stored day counts, not a service rule.
const MAX_SERVICE_DAYS = 365_000;
const DEFAULT_WARNING_LANDINGS = 10;

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

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().trim().min(1).max(2000);
const date = z.iso.date();

/**
 * A component change refused by an attachment or usage rule, with a message
 * the user can act on.
 */
export class ComponentUsageError extends Rejection {}

/** Where an installed component sits on its aircraft. */
export const POSITIONS = [
  "LEFT",
  "RIGHT",
  "NUMBER 1",
  "NUMBER 2",
  "MAIN",
  "AUX",
] as const;

/**
 * A serialized, life-tracked component as stored. Times are in seconds;
 * `installedSeconds` and `installedCycles` are the aircraft's meters when it
 * was installed, the point its usage accrues from.
 *
 * @throws {z.ZodError} From `parse()` on an unknown key or an invalid field.
 */
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
  notes: z.string().max(NOTES_MAX_LENGTH),
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
  serviceDaysBase: count.max(MAX_SERVICE_DAYS),
  calendarSinceNewUnknown: z.boolean().optional(),
  calendarOverhaulDaysBase: count.max(MAX_SERVICE_DAYS).nullable().optional(),
  calendarOverhaulDate: date.optional(),
});
/** A parsed component. */
export type Component = z.infer<typeof componentSchema>;

/**
 * A service or life limit on a component, by time, cycles, landings or
 * calendar. {@link saveRequirement} derives its `due*` values.
 *
 * @throws {z.ZodError} From `parse()` on an invalid field.
 */
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
  notes: z.string().max(NOTES_MAX_LENGTH),
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
/** A parsed component requirement. */
export type ComponentRequirement = z.infer<typeof requirementSchema>;

/**
 * One entry in a component's movement history: the action, where the
 * component was, and its usage at that moment. A correction supersedes an
 * entry instead of editing it.
 *
 * @throws {z.ZodError} From `parse()` on an invalid field.
 */
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
/** A parsed movement-history entry. */
export type ComponentMovement = z.infer<typeof movementSchema>;

/** The fields of a verified usage baseline, as zod shapes. */
export const baselineFields = {
  installedSeconds: count,
  installedCycles: count,
  timeSinceNew: count,
  timeSinceOverhaul: count.nullable(),
  timeSinceRepair: count.nullable(),
  cyclesSinceNew: count,
  serviceDaysBase: count.max(MAX_SERVICE_DAYS),
  calendarSinceNewUnknown: z.boolean().optional(),
  calendarOverhaulDaysBase: count.max(MAX_SERVICE_DAYS).nullable().optional(),
  calendarOverhaulDate: date.optional(),
  installedDate: date.optional(),
};

/** The fields of a service action ({@link serviceComponent}), as zod shapes. */
export const serviceFields = {
  operation: z.enum(["install", "remove", "overhaul", "repair"]),
  date,
  aircraftUuid: z.string().optional(),
  installPosition: z.enum(POSITIONS).optional(),
  locationUuid: z.string().trim().min(1).optional(),
  partsLocation: z.string().trim().min(1).max(150).optional(),
};

/**
 * The usage dimensions a component tracks.
 *
 * @returns Whether it tracks time, cycles and calendar age.
 */
export const tracking = (c: Component) => ({
  time: c.trackTime,
  cycles: c.trackCycles,
  calendar: c.trackCalendar,
});

/**
 * The aircraft meter a component's time accrues from: airframe total time,
 * or the collective hourmeter, which can run independently of it.
 *
 * @returns The meter's reading in seconds.
 * @throws {Error} "Collective component tracking requires a helicopter
 *   collective hourmeter reading." for a collective component without one.
 */
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

/**
 * A component's usage on a date: its baseline plus what accrued while
 * installed, on each dimension it tracks. Nothing accrues in inventory.
 *
 * @param a - The aircraft it is installed on; ignored in inventory.
 * @param today - A local date. A stored date one day later counts as today.
 * @returns Since-new, since-overhaul and since-repair seconds, cycles since
 *   new, service days and calendar overhaul days; unknown values stay null.
 * @throws {Error} "Installed aircraft not found." without `a` when installed;
 *   "Aircraft readings or date precede the installation baseline." when any
 *   accrual is negative; and as {@link componentAircraftSeconds}.
 */
export function componentTotals(
  c: Component,
  a?: Aircraft,
  today = localDate(),
) {
  if (c.installed && !a) throw new Error("Installed aircraft not found.");
  const { seconds, cycles, days, overhaulDays } =
    c.installed && a
      ? accrueUsage(c, a, today)
      : { seconds: 0, cycles: 0, days: 0, overhaulDays: 0 };
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

/**
 * The due date of a calendar interval. Month and year intervals run to the
 * last day of the month they end in (calendar months).
 *
 * @param start - An ISO date.
 * @returns The due date, as an ISO date.
 * @throws {z.ZodError} When `start` is not an ISO date.
 * @throws {Error} "Calendar interval exceeds supported dates." outside years
 *   1–9999.
 */
export function calendarDue(
  start: string,
  value: number,
  unit: "DAYS" | "MONTHS" | "YEARS",
): string {
  return shiftCalendarDate(start, value, unit, true);
}

/**
 * When a requirement falls due by calendar: its interval counted from the
 * last compliance, or else the stored due date (older records).
 *
 * @returns An ISO date, or undefined when it has no calendar limit.
 * @throws As {@link calendarDue}.
 */
export function requirementDueDate(
  r: ComponentRequirement,
): string | undefined {
  return r.lastDate && r.calendarIntervalValue
    ? calendarDue(r.lastDate, r.calendarIntervalValue, r.calendarIntervalUnit)
    : r.dueDate;
}

/**
 * What is left on each of a requirement's limits, and its status.
 *
 * @returns Seconds, cycles, landings and days left (undefined where not
 *   limited or not computable), and the first status that applies: "Past
 *   due", "Due now" (a usage limit at 0), "Set landing baseline", "Set time
 *   baseline", "Due soon" (within a warning; 10 landings by default), or
 *   "Tracked".
 * @throws As {@link componentTotals} and {@link calendarDue}.
 */
export function requirementStatus(
  r: ComponentRequirement,
  c: Component,
  a?: Aircraft,
  today = localDate(),
) {
  const t = componentTotals(c, a, today);
  const basis = usageOnBasis(r.timeBasis, t);
  const landingBaselineMissing = isLandingBaselineMissing(r, c, a);
  const dueDate = requirementDueDate(r);
  const left: LimitsLeft = {
    seconds:
      r.dueSeconds === undefined || basis === null
        ? undefined
        : r.dueSeconds - basis,
    cycles:
      r.dueCycles === undefined ? undefined : r.dueCycles - t.cyclesSinceNew,
    landings:
      r.dueLandings === undefined || !a || landingBaselineMissing
        ? undefined
        : r.dueLandings - a.landings,
    days: dueDate
      ? Math.round((Date.parse(dueDate) - Date.parse(today)) / DAY_MS)
      : undefined,
  };
  const calendarSoon =
    !!dueDate &&
    today >=
      shiftCalendarDate(dueDate, -r.warningCalendarMonths, "MONTHS", false);
  const missing = {
    landings: landingBaselineMissing,
    time: r.dueSeconds !== undefined && basis === null,
  };
  return { ...left, status: classifyLimits(r, left, missing, calendarSoon) };
}

/**
 * Checks a new or edited component against the records before it is saved.
 *
 * @param existing - The stored component, or undefined for a new one.
 * @param baseline - True for a verified-baseline edit, the only edit that may
 *   change installation and usage.
 * @throws {ComponentUsageError} For a parent attachment that changed, is
 *   missing, cyclic or placed elsewhere; or since-overhaul or since-repair
 *   time above since-new.
 * @throws {Error} For any other refusal, such as a component out for repair,
 *   no tracked dimension, a duplicate part and serial, or a future date.
 */
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
  assertParentAttachment(s, r, existing);
  const track = tracking(r);
  const a = s.aircraft.find((a) => a.uuid === r.aircraftUuid);
  if (!track.time && !track.cycles && !track.calendar)
    throw new Error("Select at least one tracking dimension.");
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
 * Checks a requirement against its component and derives its due values.
 *
 * @returns The requirement at the next version: each due value from its
 *   interval (absolute, or from the last compliance), and landing limits
 *   referenced to the component's aircraft.
 * @throws {Error} "Component not found."; "Component location changed.
 *   Refresh and try again."; or a refused limit, baseline or last compliance.
 *   Also as {@link componentTotals} and {@link calendarDue}.
 * @throws {z.ZodError} When the derived requirement is invalid.
 */
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
  const aircraft = s.aircraft.find((a) => a.uuid === c.aircraftUuid);
  const t = componentTotals(c, aircraft, latestLocalDate(now));
  const basis = usageOnBasis(r.timeBasis, t);
  assertServiceLimits(r, c, basis, aircraft);
  assertPastDate(r.lastDate, now);
  assertLastWithinUsage(r, basis, t.cyclesSinceNew, aircraft);
  assertLastForRelativeLimits(r);
  return requirementSchema.parse({
    ...r,
    version: r.version + 1,
    ...computeDueLimits(r, c),
  });
}

/**
 * A requirement following its component to another aircraft. Landing counts
 * belong to the aircraft they were recorded on, so the reference stays there
 * (also stamped on older records without one) and status asks for a new
 * landing baseline.
 *
 * @returns The requirement at the next version, on `aircraftUuid`.
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
 * Requirements updated by a repair or overhaul of `next` (the component after
 * its reset). Overhaul requirements renew only for an actual overhaul;
 * lifetime limits never renew. Other TSO/TSR intervals keep their remaining
 * time on the reset counter.
 *
 * @param before - The component's usage just before the work.
 * @returns Only the changed requirements, each at its next version.
 * @throws {Error} "A component requirement has later compliance. Review its
 *   tracking before backdating this repair or overhaul."; as
 *   {@link saveRequirement} for a renewal.
 */
export function rebaseServicedRequirements(
  s: Snapshot,
  next: Component,
  before: UsageBefore,
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
    if (renew)
      return [saveRequirement(view, renewal(r, next, before, work), now)];
    const prior =
      r.timeBasis === "TSO" ? before.timeSinceOverhaul : before.timeSinceRepair;
    if (!reset || !r.intervalSeconds || prior === null) return [];
    return [carryReset(r, prior, r.intervalSeconds)];
  });
}

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
 * @throws {Error} For any other refusal, such as a component out for repair,
 *   a date other than today, an installation state that changed, or an
 *   aircraft the caller may not maintain.
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

type ServiceAction = z.infer<z.ZodObject<typeof serviceFields>>;
type UsageBefore = Pick<
  ReturnType<typeof componentTotals>,
  "timeSinceNew" | "timeSinceOverhaul" | "timeSinceRepair" | "cyclesSinceNew"
>;
interface LimitsLeft {
  seconds: number | undefined;
  cycles: number | undefined;
  landings: number | undefined;
  days: number | undefined;
}

// Usage since installation on each tracked dimension. A date one day ahead
// is time-zone skew (device-local dates checked on a UTC server, or the
// reverse), not a reading before the baseline, so it counts as zero days.
function accrueUsage(c: Component, a: Aircraft, today: string) {
  const track = tracking(c);
  const elapsedDays = (from: string) => {
    const days = Math.round((Date.parse(today) - Date.parse(from)) / DAY_MS);
    return days === -1 ? 0 : days;
  };
  const overhaulDate = c.calendarOverhaulDate ?? c.installedDate;
  return {
    seconds: track.time
      ? componentAircraftSeconds(c, a) - c.installedSeconds
      : 0,
    cycles: track.cycles ? a.cycles - c.installedCycles : 0,
    days: track.calendar && c.installedDate ? elapsedDays(c.installedDate) : 0,
    overhaulDays:
      track.calendar && c.calendarOverhaulDaysBase != null && overhaulDate
        ? elapsedDays(overhaulDate)
        : 0,
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

function usageOnBasis(
  basis: ComponentRequirement["timeBasis"],
  usage: Pick<
    UsageBefore,
    "timeSinceNew" | "timeSinceOverhaul" | "timeSinceRepair"
  >,
): number | null {
  if (basis === "TSN") return usage.timeSinceNew;
  if (basis === "TSO") return usage.timeSinceOverhaul;
  return usage.timeSinceRepair;
}

// Landing counts belong to the aircraft they were counted on, so a landing
// limit needs the component installed on that aircraft.
function isLandingBaselineMissing(
  r: ComponentRequirement,
  c: Component,
  a: Aircraft | undefined,
): boolean {
  return (
    r.dueLandings !== undefined &&
    (!a ||
      !c.installed ||
      (r.landingReferenceAircraftUuid !== undefined &&
        r.landingReferenceAircraftUuid !== a.uuid))
  );
}

// A computable overdue limit outranks a missing baseline on another
// dimension. A usage limit with nothing left is reached, because the next
// flight would exceed it; a calendar limit stays valid through its due date,
// so on that day it is only due soon (calendarSoon).
function classifyLimits(
  r: ComponentRequirement,
  left: LimitsLeft,
  missing: { landings: boolean; time: boolean },
  calendarSoon: boolean,
): string {
  const usage = [left.seconds, left.cycles, left.landings];
  if ([...usage, left.days].some((n) => n !== undefined && n < 0))
    return "Past due";
  if (usage.some((n) => n === 0)) return "Due now";
  if (missing.landings) return "Set landing baseline";
  if (missing.time) return "Set time baseline";
  if (calendarSoon || isWithinWarning(r, left)) return "Due soon";
  return "Tracked";
}

function isWithinWarning(r: ComponentRequirement, left: LimitsLeft): boolean {
  return (
    (left.seconds !== undefined && left.seconds <= r.warningSeconds) ||
    (left.cycles !== undefined && left.cycles <= r.warningCycles) ||
    (left.landings !== undefined &&
      left.landings <= (r.warningLandings ?? DEFAULT_WARNING_LANDINGS))
  );
}

function assertPastDate(d: string | undefined, now: number) {
  if (d && d > latestLocalDate(now))
    throw new Error("Dates cannot be in the future.");
}

function componentRequirements(s: Snapshot, id: string) {
  return (s.management ?? []).filter(
    (r): r is ComponentRequirement =>
      r.kind === "componentRequirement" && r.componentUuid === id,
  );
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
  if (duplicate) throw new Error("Part number and serial already exist.");
}

function assertPlacement(r: Component, a: Aircraft | undefined, now: number) {
  if (!r.installed && !r.partsLocation && !r.locationUuid)
    throw new Error("Enter the inventory shelf, bin, or room.");
  if (!r.installed) return;
  if (!a || !r.installedDate)
    throw new Error(
      "Installed components need an aircraft and installation date.",
    );
  if (!r.installPosition) throw new Error("Select an installation position.");
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
    throw new Error(
      "A requirement still uses a tracking dimension being disabled.",
    );
}

function assertUsageUnchanged(r: Component, existing: Component) {
  if (USAGE_FIELDS.some((key) => r[key] !== existing[key]))
    throw new Error(
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
    throw new Error(
      "Move the component to inventory before changing its tracking dimensions.",
    );
}

function assertServiceLimits(
  r: ComponentRequirement,
  c: Component,
  basis: number | null,
  aircraft: Aircraft | undefined,
) {
  if (
    !r.intervalSeconds &&
    !r.intervalCycles &&
    !r.intervalLandings &&
    !r.calendarIntervalValue
  )
    throw new Error("Set at least one service limit.");
  const track = tracking(c);
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
}

function assertLastWithinUsage(
  r: ComponentRequirement,
  basis: number | null,
  cyclesSinceNew: number,
  aircraft: Aircraft | undefined,
) {
  if (
    (r.lastSeconds !== undefined &&
      (basis === null || r.lastSeconds > basis)) ||
    (r.lastCycles !== undefined && r.lastCycles > cyclesSinceNew) ||
    (r.lastLandings !== undefined &&
      (!aircraft || r.lastLandings > aircraft.landings))
  )
    throw new Error("Last compliance exceeds current component usage.");
}

function assertLastForRelativeLimits(r: ComponentRequirement) {
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
}

// An absolute time limit is a reading on the basis counter, less what earlier
// resets of that counter carried (timeResetSeconds); a relative limit counts
// from the last compliance. Landing limits stay with the current aircraft.
function computeDueLimits(r: ComponentRequirement, c: Component) {
  return {
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
  };
}

// An overhaul renews its requirement as complied with on the work date, at
// the usage the work left: since-new from before it, TSO/TSR after it.
function renewal(
  r: ComponentRequirement,
  next: Component,
  before: UsageBefore,
  work: { date: string; landings?: number },
): ComponentRequirement {
  const basis = usageOnBasis(r.timeBasis, {
    timeSinceNew: before.timeSinceNew,
    timeSinceOverhaul: next.timeSinceOverhaul,
    timeSinceRepair: next.timeSinceRepair,
  });
  return {
    ...r,
    timeResetSeconds: 0,
    lastDate: work.date,
    lastSeconds: basis ?? undefined,
    lastCycles: before.cyclesSinceNew,
    lastLandings: r.intervalLandings ? work.landings : undefined,
  };
}

// The counter restarts at zero, so the interval keeps its remaining time by
// moving its compliance and due values down by the usage `prior` removed.
function carryReset(
  r: ComponentRequirement,
  prior: number,
  intervalSeconds: number,
): ComponentRequirement {
  return {
    ...r,
    version: r.version + 1,
    timeResetSeconds: (r.timeResetSeconds ?? 0) + prior,
    lastSeconds:
      r.lastSeconds === undefined ? undefined : r.lastSeconds - prior,
    // ponytail: dueSeconds is a non-negative count, so an overdue interval
    // resets to "Due now" and the overdue amount is not carried.
    dueSeconds: Math.max(0, (r.dueSeconds ?? intervalSeconds) - prior),
  };
}

function assertServiceable(existing: Component, c: ServiceAction, now: number) {
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
}

function removeComponent(next: Component, c: ServiceAction) {
  if (!c.partsLocation && !c.locationUuid)
    throw new Error("Enter the inventory shelf, bin, or room.");
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
