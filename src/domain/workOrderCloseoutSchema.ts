import { z } from "zod";
const count = z.number().int().nonnegative();
export const completionReadingsSchema = z.object({
  totalSeconds: count,
  hobbs: count,
  tach: count,
  cyclicHobbs: count.optional(),
  flightTimeLog: count.optional(),
  cycles: count,
  landings: count.optional(),
});
export type CompletionReadings = z.infer<typeof completionReadingsSchema>;
export const trackingBaselineSchema = z.object({
  before: z.string(),
  after: z.string(),
  movementUuids: z.array(z.string()),
});
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
        before: z.object({
          timeSinceNew: count,
          timeSinceOverhaul: count.nullable(),
          timeSinceRepair: count.nullable(),
          cyclesSinceNew: count,
          serviceDays: count,
          calendarOverhaulDays: count.nullable().optional(),
        }),
        after: z.object({
          timeSinceNew: count,
          timeSinceOverhaul: count.nullable(),
          timeSinceRepair: count.nullable(),
          cyclesSinceNew: count,
          serviceDays: count,
          calendarOverhaulDays: count.nullable().optional(),
        }),
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
export type WorkOrderCloseout = z.infer<typeof closeoutSchema>;
