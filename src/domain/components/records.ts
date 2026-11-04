/**
 * Responsibility: The stored shapes of components, their service requirements
 *   and movement history, and the error class for their usage refusals.
 * Layer: Domain. Zod schemas and types; no I/O, no React.
 * Dependencies: zod; ../requiredParts, ../manuals, ../ata, ../rejection.
 */
import { z } from "zod";
import { requiredPartsSchema } from "../requiredParts";
import { manualReferenceSchema } from "../manuals";
import { ataChapterSchema } from "../ata";
import { Rejection } from "../rejection";

const NOTES_MAX_LENGTH = 10_000;
// About 1,000 years: a sanity bound on stored day counts, not a service rule.
const MAX_SERVICE_DAYS = 365_000;

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
 * calendar. `saveRequirement` derives its `due*` values.
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

/** The fields of a service action (`serviceComponent`), as zod shapes. */
export const serviceFields = {
  operation: z.enum(["install", "remove", "overhaul", "repair"]),
  date,
  aircraftUuid: z.string().optional(),
  installPosition: z.enum(POSITIONS).optional(),
  locationUuid: z.string().trim().min(1).optional(),
  partsLocation: z.string().trim().min(1).max(150).optional(),
};

/** A service action as `serviceComponent` takes it. */
export type ServiceAction = z.infer<z.ZodObject<typeof serviceFields>>;
