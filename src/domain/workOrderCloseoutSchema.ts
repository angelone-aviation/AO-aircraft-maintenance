/**
 * Responsibility: The close-out a completed work order keeps: aircraft
 *   readings, signer, component work, and the compliance it recorded.
 * Layer: Domain. Pure zod schemas; no I/O, no React.
 * Dependencies: zod. No internal imports.
 *
 * A close-out is kept as recorded, so a field added later is optional and
 * older close-outs still parse. Times are in seconds, calendar ages in days.
 */
import { z } from "zod";

const count = z.number().int().nonnegative();

/**
 * The aircraft's meters and counters when a work order is completed.
 *
 * @throws {z.ZodError} From `parse()` on a missing, negative or fractional
 *   reading.
 */
export const completionReadingsSchema = z.object({
  totalSeconds: count,
  hobbs: count,
  tach: count,
  cyclicHobbs: count.optional(),
  flightTimeLog: count.optional(),
  cycles: count,
  landings: count.optional(),
});

/** Parsed {@link completionReadingsSchema} readings. */
export type CompletionReadings = z.infer<typeof completionReadingsSchema>;

/**
 * A component's tracked records as JSON before and after a close-out's work,
 * and the movement records the work created: where a later tracking
 * correction starts from.
 */
export const trackingBaselineSchema = z.object({
  before: z.string(),
  after: z.string(),
  movementUuids: z.array(z.string()),
});

const componentLifeSchema = z.object({
  timeSinceNew: count,
  timeSinceOverhaul: count.nullable(),
  timeSinceRepair: count.nullable(),
  cyclesSinceNew: count,
  serviceDays: count,
  calendarOverhaulDays: count.nullable().optional(),
});

/**
 * A work order's close-out, as recorded when it was completed.
 *
 * @throws {z.ZodError} From `parse()` on a missing field, a negative or
 *   fractional count, or an unknown component action or compliance kind.
 */
export const closeoutSchema = z.object({
  recordedAt: z.number(),
  aircraft: completionReadingsSchema.extend({
    registration: z.string(),
    make: z.string(),
    model: z.string(),
    serial: z.string(),
  }),
  completedBy: z.object({
    userId: z.string(),
    name: z.string(),
    licenseNumber: z.string(),
    certificateType: z.string(),
  }),
  componentWork: z
    .array(
      z.object({
        installPosition: z.string().optional(),
        locationUuid: z.string().optional(),
        partsLocation: z.string().optional(),
        trackingBaseline: trackingBaselineSchema.optional(),
        componentUuid: z.string(),
        version: count,
        // "both" is a repair and an overhaul in one.
        action: z.enum([
          "service",
          "repair",
          "overhaul",
          "both",
          "install",
          "remove",
        ]),
        description: z.string(),
        reference: z.string(),
        date: z.iso.date(),
        before: componentLifeSchema,
        after: componentLifeSchema,
      }),
    )
    .optional(),
  workPerformed: z.string(),
  // Technician signers named on the entry's "Performed by" line. Absent on
  // orders closed before it was recorded; their entries stay as they were.
  performers: z
    .array(z.object({ userId: z.string(), name: z.string() }))
    .optional(),
  components: z.array(
    z.object({
      componentUuid: z.string(),
      label: z.string(),
      manufacturer: z.string(),
      model: z.string(),
      partNumber: z.string(),
      serial: z.string(),
      timeSinceNew: count.nullable(),
      timeSinceOverhaul: count.nullable(),
      timeSinceRepair: count.nullable(),
      cyclesSinceNew: count.nullable(),
      serviceDays: count.nullable(),
    }),
  ),
  compliance: z.array(
    z.object({
      uuid: z.string(),
      kind: z.enum(["inspection", "componentRequirement"]),
      description: z.string(),
      date: z.string(),
      timeBasis: z.string().optional(),
      seconds: count.optional(),
      cycles: count.optional(),
      dueSeconds: count.optional(),
      dueCycles: count.optional(),
      landings: count.optional(),
      dueLandings: count.optional(),
      dueDate: z.string().optional(),
    }),
  ),
});

/** A parsed {@link closeoutSchema} close-out. */
export type WorkOrderCloseout = z.infer<typeof closeoutSchema>;
