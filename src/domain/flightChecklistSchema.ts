import { z } from "zod";
const meter = z
  .number()
  .int()
  .nonnegative()
  .refine((n) => n % 360 === 0, "Use meter readings in tenths of an hour.");
export const checklistFlightSchema = z
  .object({
    sessionUuid: z.string().uuid(),
    checklistUuid: z.string().uuid(),
    checklistVersion: z.number().int().positive(),
    checklistName: z.string().max(20000),
    startedAt: z.iso.datetime(),
    metersVerifiedAt: z.iso.datetime(),
    preflight: z.object({
      hobbs: meter,
      tach: meter,
      cyclic: meter.optional(),
      flightTimeLog: meter.optional(),
    }),
    checked: z.array(z.string().max(200)).max(10000),
    skipped: z.array(z.string().max(200)).max(10000),
    totalChecks: z.number().int().nonnegative().max(10000),
  })
  .superRefine((r, ctx) => {
    const ids = [...r.checked, ...r.skipped];
    if (new Set(ids).size !== ids.length || ids.length > r.totalChecks)
      ctx.addIssue({
        code: "custom",
        message: "Invalid checklist progress totals.",
      });
  });
export type ChecklistFlightLink = z.infer<typeof checklistFlightSchema>;
