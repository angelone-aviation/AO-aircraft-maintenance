/**
 * Responsibility: The checklist run a flight records: the checklist version
 *   used, the meters verified before flight, and which items were done.
 * Layer: Domain. Pure zod schema; no I/O, no React.
 * Dependencies: zod. No internal imports.
 */
import { z } from "zod";

// Meters are stored in seconds and read in tenths of an hour.
const SECONDS_PER_TENTH_HOUR = 360;
const MAX_CHECKLIST_ITEMS = 10000;

const meter = z
  .number()
  .int()
  .nonnegative()
  .refine(
    (n) => n % SECONDS_PER_TENTH_HOUR === 0,
    "Use meter readings in tenths of an hour.",
  );

/**
 * A checklist run as stored on a flight. The name and item-id limits match
 * the checklist document's (checklists.ts).
 *
 * @throws {z.ZodError} From `parse()` on a malformed run; on a meter that is
 *   not whole tenths of an hour ("Use meter readings in tenths of an hour.");
 *   or when an item is listed twice, across checked and skipped too, or more
 *   items are listed than `totalChecks` ("Invalid checklist progress totals.").
 */
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
    checked: z.array(z.string().max(200)).max(MAX_CHECKLIST_ITEMS),
    skipped: z.array(z.string().max(200)).max(MAX_CHECKLIST_ITEMS),
    totalChecks: z.number().int().nonnegative().max(MAX_CHECKLIST_ITEMS),
  })
  .superRefine((run, ctx) => {
    const ids = [...run.checked, ...run.skipped];
    if (new Set(ids).size !== ids.length || ids.length > run.totalChecks)
      ctx.addIssue({
        code: "custom",
        message: "Invalid checklist progress totals.",
      });
  });

/** A parsed checklist run. */
export type ChecklistFlightLink = z.infer<typeof checklistFlightSchema>;
