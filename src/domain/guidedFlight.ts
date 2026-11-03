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
  dispatchOverrideReason: z.string().max(1000).optional(),
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
export type GuidedDraft = z.infer<typeof guidedDraftSchema>;
export function guidedFlightLink(draft: GuidedDraft, twin: boolean) {
  if (!draft.metersVerifiedAt)
    throw new Error(
      "Verify the preflight meter readings against the aircraft first.",
    );
  const fuel = fuelSchema.parse(draft.fuel);
  const oil = oilSchema.parse(draft.oil);
  const engines = twin ? ["left", "right"] : ["single"];
  if (
    fluidUsed(fuel) === undefined ||
    engines.some(
      (e) =>
        !oil.some(
          (o) =>
            o.engine === e && o.start !== undefined && o.added !== undefined,
        ),
    ) ||
    oil.length !== engines.length
  )
    throw new Error(
      "Enter starting level and quantity added (0 if none) for fuel and each engine’s oil, plus the shutdown fuel level.",
    );
  const ids = new Set(
    draft.checklist.document.payload.groups.flatMap((c) =>
      c.items.flatMap((g) =>
        g.items.flatMap((l) =>
          l.items.filter((i) => i.type !== "comment").map((i) => i.objectId),
        ),
      ),
    ),
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
    checked: Object.keys(draft.progress).filter(
      (id) => ids.has(id) && draft.progress[id] === "checked",
    ),
    skipped: Object.keys(draft.progress).filter(
      (id) => ids.has(id) && draft.progress[id] === "skipped",
    ),
    totalChecks: ids.size,
  });
}

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
