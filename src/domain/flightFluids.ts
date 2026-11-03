import type { Flight } from "./model";
import { z } from "zod";
const quantity = z.number().finite().nonnegative().max(1000000);
const readings = {
  start: quantity.optional(),
  added: quantity.optional(),
  end: quantity.optional(),
};
const balance = (
  v: { start?: number; added?: number; end?: number },
  ctx: z.RefinementCtx,
) => {
  if (
    v.start !== undefined &&
    v.added !== undefined &&
    v.end !== undefined &&
    v.end > v.start + v.added + 0.000001
  )
    ctx.addIssue({
      code: "custom",
      path: ["end"],
      message:
        "Shutdown level exceeds the starting level plus additions. Check the readings or quantity added.",
    });
};
export const fuelSchema = z
  .object({ unit: z.enum(["US gal", "L", "lb", "kg"]), ...readings })
  .superRefine(balance);
export const oilRanges = [
  { value: 0, label: "Add" },
  { value: 25, label: "25% above Add" },
  { value: 50, label: "50% above Add" },
  { value: 75, label: "75% above Add" },
  { value: 100, label: "Full" },
];
export function oilLevelLabel(reading: OilReading, level?: number) {
  return level === undefined
    ? "not recorded"
    : reading.unit === "range"
      ? (oilRanges.find((r) => r.value === level)?.label ?? "Unknown")
      : `${level} ${reading.unit}`;
}
export const oilInventorySchema = z.object({
  locationUuid: z.string().min(1),
  stockUuid: z.string().min(1),
  quantity: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export const oilReadingSchema = z
  .object({
    engine: z.enum(["single", "left", "right"]),
    inventory: oilInventorySchema.optional(),
    unit: z.enum(["US qt", "L", "range"]),
    addedUnit: z.enum(["US qt", "L"]).optional(),
    ...readings,
  })
  .superRefine((reading, ctx) => {
    if (
      reading.inventory &&
      !(reading.added !== undefined && reading.added > 0)
    )
      ctx.addIssue({
        code: "custom",
        path: ["added"],
        message: "Enter a positive amount of oil added before using inventory.",
      });
    // Legacy shutdown readings remain in saved records but no longer determine oil use.
    if (reading.unit !== "range") return;
    for (const key of ["start", "end"] as const) {
      if (
        reading[key] !== undefined &&
        !oilRanges.some((r) => r.value === reading[key])
      )
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Choose an oil level from Add to Full.",
        });
    }
    if (reading.added !== undefined && !reading.addedUnit)
      ctx.addIssue({
        code: "custom",
        path: ["addedUnit"],
        message: "Select a unit for the quantity of oil added.",
      });
  });
export const oilSchema = z
  .array(oilReadingSchema)
  .max(2)
  .refine(
    (oil) =>
      new Set(oil.map((o) => o.engine)).size === oil.length &&
      !(oil.length > 1 && oil.some((o) => o.engine === "single")),
    "Use a single engine or separate left/right engines.",
  );
export type FuelReading = z.infer<typeof fuelSchema>;
export type OilReading = z.infer<typeof oilReadingSchema>;
export function fluidUsed(reading?: {
  start?: number;
  added?: number;
  end?: number;
  unit?: string;
}) {
  if (
    reading?.unit === "range" ||
    reading?.start === undefined ||
    reading.added === undefined ||
    reading.end === undefined
  )
    return undefined;
  const used = reading.start + reading.added - reading.end;
  return used < -0.000001
    ? undefined
    : Math.round(Math.max(0, used) * 1000000) / 1000000;
}
export function fluidRate(
  reading:
    { start?: number; added?: number; end?: number; unit?: string } | undefined,
  seconds: number | undefined,
) {
  const used = fluidUsed(reading);
  return used === undefined || seconds === undefined || seconds <= 0
    ? undefined
    : (used * 3600) / seconds;
}

// Compare adjacent flight starts, using only additions recorded with the earlier start.
// Do not bridge an unreviewed/missing record or mix engines and units.
export function oilUseSincePreviousStart(
  current: Flight,
  previous: Flight | undefined,
  engine: OilReading["engine"],
) {
  if (
    !previous ||
    current.status !== "accepted" ||
    previous.status !== "accepted" ||
    current.aircraftUuid !== previous.aircraftUuid ||
    Date.parse(previous.startTime) >= Date.parse(current.startTime)
  )
    return undefined;
  const before = previous.oil?.find((o) => o.engine === engine);
  const after = current.oil?.find((o) => o.engine === engine);
  if (
    !before ||
    !after ||
    before.unit !== after.unit ||
    before.unit === "range"
  )
    return undefined;
  return fluidUsed({
    start: before.start,
    added: before.added,
    end: after.start,
  });
}
