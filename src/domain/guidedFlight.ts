/**
 * Responsibility: The guided flight draft a pilot fills in step by step, and
 *   the checklist-run record it attaches to the logged flight.
 * Layer: Domain. Zod schema and pure functions; no I/O, no React.
 * Dependencies: zod, ./model, ./checklists, ./flightPlans, ./flightFluids,
 *   ./flightChecklistSchema, ./rejection.
 */
import { flightInputSchema } from "./model";
import { z } from "zod";
import { checklistRecordSchema } from "./checklists";
import { flightPlanSchema } from "./flightPlans";
import {
  fuelSchema,
  oilSchema,
  fluidUsed,
  oilInventorySchema,
} from "./flightFluids";
import { checklistFlightSchema } from "./flightChecklistSchema";
import { Rejection } from "./rejection";

const OVERRIDE_REASON_MAX_LENGTH = 1000;

/**
 * A guided flight in progress, saved on the device between steps: the opening
 * meter readings, checklist and plan, progress, and fluid and meter readings.
 *
 * @throws {z.ZodError} From `parse()` on a missing or mistyped field.
 */
export const guidedDraftSchema = z.object({
  uuid: z.string().uuid(),
  aircraftUuid: z.string(),
  startedAt: z.iso.datetime(),
  opening: z.object({
    version: z.number(),
    hobbs: z.number(),
    tach: z.number(),
    cyclic: z.number().optional(),
    flightTimeLog: z.number().optional(),
  }),
  checklist: checklistRecordSchema,
  plan: flightPlanSchema,
  preflightList: z.string(),
  shutdownList: z.string(),
  startList: z.string().optional(),
  dispatchOverrideReason: z.string().max(OVERRIDE_REASON_MAX_LENGTH).optional(),
  engineStarts: flightInputSchema.shape.engineStarts,
  metersVerifiedAt: z.iso.datetime().optional(),
  progress: z.record(z.string(), z.enum(["checked", "skipped"])),
  // Drafts allow unfinished or inconsistent readings; final review validates balances.
  fuel: z
    .object({
      unit: z.enum(["US gal", "L", "lb", "kg"]),
      start: z.number().optional(),
      added: z.number().optional(),
      end: z.number().optional(),
    })
    .optional(),
  oil: z
    .array(
      z.object({
        engine: z.enum(["single", "left", "right"]),
        inventory: oilInventorySchema
          .extend({
            stockUuid: z.string(),
            locationUuid: z.string(),
            quantity: z.number(),
          })
          .optional(),
        unit: z.enum(["US qt", "L", "range"]),
        addedUnit: z.enum(["US qt", "L"]).optional(),
        start: z.number().optional(),
        added: z.number().optional(),
        end: z.number().optional(),
      }),
    )
    .optional(),
  hobbsOn: z.number().optional(),
  tachOn: z.number().optional(),
  cyclicHobbsOn: z.number().optional(),
  flightTimeLogOn: z.number().optional(),
});
/** A guided flight in progress. */
export type GuidedDraft = z.infer<typeof guidedDraftSchema>;

/**
 * Builds the checklist-run record a finished guided flight attaches to its
 * entry: which checks were done or skipped, out of the checklist's total.
 * Comments are not checks.
 *
 * @param draft - The finished draft.
 * @param twin - Whether the aircraft has left and right engines.
 * @returns The parsed checklist-run record.
 * @throws {Rejection} "Verify the preflight meter readings against the aircraft
 *   first." or "Enter starting level and quantity added (0 if none) for fuel
 *   and each engine’s oil, plus the shutdown fuel level."
 * @throws {z.ZodError} When a fluid reading or the record is invalid.
 */
export function guidedFlightLink(draft: GuidedDraft, twin: boolean) {
  if (!draft.metersVerifiedAt)
    throw new Rejection(
      "Verify the preflight meter readings against the aircraft first.",
    );
  assertFluidsRecorded(draft, twin);
  const ids = checkIds(draft);
  const marked = (state: "checked" | "skipped") =>
    Object.keys(draft.progress).filter(
      (id) => ids.has(id) && draft.progress[id] === state,
    );
  return checklistFlightSchema.parse({
    sessionUuid: draft.uuid,
    checklistUuid: draft.checklist.uuid,
    checklistVersion: draft.checklist.version,
    checklistName:
      draft.checklist.document.payload.metadata.name ||
      draft.checklist.sourceName,
    startedAt: draft.startedAt,
    metersVerifiedAt: draft.metersVerifiedAt,
    preflight: draft.opening,
    checked: marked("checked"),
    skipped: marked("skipped"),
    totalChecks: ids.size,
  });
}

/**
 * Picks the checklist section to start the engines from: the first whose
 * title says "start" but not "before", "after" or "pre-start".
 *
 * @param lists - The checklist's sections, in order.
 * @returns That section's objectId, or "" when none matches.
 */
export function suggestedStartSection(
  lists: { objectId: string; title?: string }[],
) {
  return (
    lists.find(
      (l) =>
        /start/i.test(l.title ?? "") &&
        !/before|after|pre.?start/i.test(l.title ?? ""),
    )?.objectId ?? ""
  );
}

// Fuel and each engine's oil need a starting level and the quantity added
// (0 if none), and fuel a shutdown level, so usage can be worked out.
function assertFluidsRecorded(draft: GuidedDraft, twin: boolean) {
  const fuel = fuelSchema.parse(draft.fuel);
  const oil = oilSchema.parse(draft.oil);
  const engines = twin ? ["left", "right"] : ["single"];
  const oilRecorded = engines.every((e) =>
    oil.some(
      (o) => o.engine === e && o.start !== undefined && o.added !== undefined,
    ),
  );
  if (
    fluidUsed(fuel) === undefined ||
    !oilRecorded ||
    oil.length !== engines.length
  )
    throw new Rejection(
      "Enter starting level and quantity added (0 if none) for fuel and each engine’s oil, plus the shutdown fuel level.",
    );
}

function checkIds(draft: GuidedDraft) {
  return new Set(
    draft.checklist.document.payload.groups.flatMap((c) =>
      c.items.flatMap((g) =>
        g.items.flatMap((l) =>
          l.items.filter((i) => i.type !== "comment").map((i) => i.objectId),
        ),
      ),
    ),
  );
}
