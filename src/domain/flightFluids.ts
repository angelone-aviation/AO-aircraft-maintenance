/**
 * Responsibility: Fuel and oil readings recorded with a flight, their checks,
 *   and the use and rate they imply.
 * Layer: Domain. Zod schemas and pure functions; no I/O, no React.
 * Dependencies: zod, ./model (types).
 *
 * A reading is a start (preflight), an amount added and an end (shutdown)
 * level. Oil use now comes from successive preflight readings; shutdown oil
 * levels stay valid in saved records but no longer decide it.
 */
import { z } from "zod";
import type { Flight } from "./model";

const READING_MAX = 1000000;
const HOUR_SECONDS = 3600;
// Floating-point slack, so readings that balance in decimal are neither
// refused nor reported as negative use.
const BALANCE_TOLERANCE = 0.000001;
// Both oil checks say this: a third reading always repeats an engine or
// joins "single" to another, and zod checks the cap first.
const ENGINE_LAYOUT = "Use a single engine or separate left/right engines.";

const quantity = z.number().finite().nonnegative().max(READING_MAX);
const readings = {
  start: quantity.optional(),
  added: quantity.optional(),
  end: quantity.optional(),
};

/**
 * A fuel reading in one unit, each level from 0 to 1,000,000.
 *
 * @throws {z.ZodError} From `parse()`, including "Shutdown level exceeds the
 *   starting level plus additions. …" on `end` when the levels do not balance.
 */
export const fuelSchema = z
  .object({ unit: z.enum(["US gal", "L", "lb", "kg"]), ...readings })
  .superRefine(checkBalance);

/** The oil bands a range reading records, from Add to Full, in form order. */
export const oilRanges = [
  { value: 0, label: "Add" },
  { value: 25, label: "25% above Add" },
  { value: 50, label: "50% above Add" },
  { value: 75, label: "75% above Add" },
  { value: 100, label: "Full" },
];

/**
 * Describes an oil level for display.
 *
 * @param reading - The reading the level belongs to; its unit sets the form.
 * @param level - The level, if recorded.
 * @returns "not recorded"; for a range reading the band's label from
 *   {@link oilRanges}, or "Unknown"; otherwise "<level> <unit>".
 */
export function oilLevelLabel(reading: OilReading, level?: number) {
  if (level === undefined) return "not recorded";
  if (reading.unit !== "range") return `${level} ${reading.unit}`;
  return oilRanges.find((r) => r.value === level)?.label ?? "Unknown";
}

/** Oil drawn from a stock lot at a location, in whole units. */
export const oilInventorySchema = z.object({
  locationUuid: z.string().min(1),
  stockUuid: z.string().min(1),
  quantity: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

const oilReadingFields = z.object({
  engine: z.enum(["single", "left", "right"]),
  inventory: oilInventorySchema.optional(),
  unit: z.enum(["US qt", "L", "range"]),
  addedUnit: z.enum(["US qt", "L"]).optional(),
  ...readings,
});

/**
 * One engine's oil reading, as a volume or a band from {@link oilRanges}. It
 * is not balance-checked like fuel (see the module note).
 *
 * @throws {z.ZodError} From `parse()`: "Enter a positive amount of oil added
 *   before using inventory."; for a range reading, "Choose an oil level from
 *   Add to Full." or "Select a unit for the quantity of oil added."
 */
export const oilReadingSchema = oilReadingFields.superRefine((reading, ctx) => {
  if (reading.inventory && !(reading.added !== undefined && reading.added > 0))
    ctx.addIssue({
      code: "custom",
      path: ["added"],
      message: "Enter a positive amount of oil added before using inventory.",
    });
  if (reading.unit === "range") checkRangeReading(reading, ctx);
});

/**
 * The oil readings of a flight: none, one for a single engine, or one each
 * for the left and right engines.
 *
 * @throws {z.ZodError} From `parse()`: "Use a single engine or separate
 *   left/right engines." for more than two readings or a repeated engine.
 */
export const oilSchema = z
  .array(oilReadingSchema)
  .max(2, ENGINE_LAYOUT)
  .refine(
    (oil) =>
      new Set(oil.map((o) => o.engine)).size === oil.length &&
      !(oil.length > 1 && oil.some((o) => o.engine === "single")),
    ENGINE_LAYOUT,
  );

/** A fuel reading as stored on a flight. */
export type FuelReading = z.infer<typeof fuelSchema>;
/** One engine's oil reading as stored on a flight. */
export type OilReading = z.infer<typeof oilReadingSchema>;

/**
 * Works out how much fluid a reading used: start plus added, less end.
 *
 * @param reading - The reading, if any.
 * @returns The amount used, rounded to millionths and never below 0; undefined
 *   for a range reading, a missing level, or an end level above start plus
 *   added.
 */
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
  return used < -BALANCE_TOLERANCE
    ? undefined
    : Math.round(Math.max(0, used) * 1000000) / 1000000;
}

/**
 * Works out the rate of use per hour of meter time.
 *
 * @param reading - The reading, if any.
 * @param seconds - The meter time the reading covers.
 * @returns {@link fluidUsed} per hour, or undefined when the use is unknown or
 *   the time is missing or not positive.
 */
export function fluidRate(
  reading:
    { start?: number; added?: number; end?: number; unit?: string } | undefined,
  seconds: number | undefined,
) {
  const used = fluidUsed(reading);
  return used === undefined || seconds === undefined || seconds <= 0
    ? undefined
    : (used * HOUR_SECONDS) / seconds;
}

/**
 * Finds the flight each one's oil use is measured from: the latest accepted
 * or held flight on its aircraft that starts before it. A held flight stays
 * in the chain, so {@link oilUseSincePreviousStart} does not bridge it.
 *
 * @param flights - The flights, in any order.
 * @returns The previous flight by flight uuid; none for an aircraft's first
 *   flight or a rejected one. Equal start times keep the given order.
 */
export function previousFlights(flights: Flight[]): Map<string, Flight> {
  const byStart = flights
    .filter((f) => f.status !== "rejected")
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  const previous = new Map<string, Flight>();
  const latestByAircraft = new Map<string, Flight>();
  for (const flight of byStart) {
    const before = latestByAircraft.get(flight.aircraftUuid);
    if (before) previous.set(flight.uuid, before);
    latestByAircraft.set(flight.aircraftUuid, flight);
  }
  return previous;
}

/**
 * Works out one engine's oil use between two flights: the earlier flight's
 * start plus what was added with it, less the later flight's start.
 *
 * @param current - The later flight.
 * @param previous - The flight before it, if any.
 * @param engine - The engine to compare.
 * @returns The use, as {@link fluidUsed}; undefined unless both flights are
 *   accepted, on one aircraft, in start order, with readings in one volume unit.
 */
export function oilUseSincePreviousStart(
  current: Flight,
  previous: Flight | undefined,
  engine: OilReading["engine"],
) {
  // Do not bridge a held or missing flight.
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

function checkBalance(
  v: { start?: number; added?: number; end?: number },
  ctx: z.RefinementCtx,
) {
  if (v.start === undefined || v.added === undefined || v.end === undefined)
    return;
  if (v.end > v.start + v.added + BALANCE_TOLERANCE)
    ctx.addIssue({
      code: "custom",
      path: ["end"],
      message:
        "Shutdown level exceeds the starting level plus additions. Check the readings or quantity added.",
    });
}

// A band is not a volume, so oil added with it needs its own unit.
function checkRangeReading(
  reading: z.infer<typeof oilReadingFields>,
  ctx: z.RefinementCtx,
) {
  for (const key of ["start", "end"] as const) {
    const level = reading[key];
    if (level !== undefined && !oilRanges.some((r) => r.value === level))
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
}
