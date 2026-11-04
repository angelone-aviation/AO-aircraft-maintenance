/**
 * Responsibility: The stored shapes of cost records (work-order costs,
 *   budgets, the labor rate) and of the cost command.
 * Layer: Domain. Zod schemas and types; no I/O, no React.
 * Dependencies: zod; ./units (limits), ../commandRequest.
 */
import { z } from "zod";
import { requestUuidField } from "../commandRequest";
import {
  MAX_CENTS,
  MAX_ENTRY_MINUTES,
  MAX_ENTRY_SECONDS,
  MAX_RATE_CENTS,
} from "./units";

const cents = z.number().int().nonnegative().max(MAX_CENTS);
const rate = z.number().int().nonnegative().max(MAX_RATE_CENTS);
const id = z.string().min(1).max(200);
const text = z.string().trim().min(1).max(500);
const date = z.iso.date();
const minutes = z.number().int().positive().max(MAX_ENTRY_MINUTES);
const seconds = z.number().int().positive().max(MAX_ENTRY_SECONDS);
const budgetYear = z.number().int().min(2000).max(2200);

/**
 * Labor recorded on a work order: a technician's time on a date, priced at
 * the rate in force when it was added.
 *
 * @throws {z.ZodError} From `parse()` on an invalid field.
 */
export const laborEntrySchema = z.object({
  uuid: id,
  date,
  technician: text.max(200),
  // Rounded to whole minutes; exact only when `seconds` is absent. Still
  // written so app versions that read only minutes keep working.
  minutes,
  // Exact labor time; absent on entries saved before it existed.
  seconds: seconds.optional(),
  // Absent only in the scoped snapshot of a non-administrator.
  rateCents: rate.optional(),
  createdBy: id,
  createdAt: z.number(),
});

/**
 * A cost on a work order other than labor or issued parts.
 *
 * @throws {z.ZodError} From `parse()` on an invalid field.
 */
export const otherCostSchema = z.object({
  uuid: id,
  date,
  description: text,
  amountCents: cents.positive(),
  createdBy: id,
  createdAt: z.number(),
});

const base = {
  uuid: id,
  version: z.number().int().nonnegative(),
  programUuid: id,
};

/**
 * The costs of one work order: labor, other costs, and manual unit costs for
 * issued parts that override the stock unit cost.
 *
 * @throws {z.ZodError} From `parse()` on an invalid field or too many entries.
 */
export const workOrderCostSchema = z.object({
  ...base,
  kind: z.literal("workOrder"),
  aircraftUuid: id,
  workOrderUuid: id,
  labor: z.array(laborEntrySchema).max(500),
  other: z.array(otherCostSchema).max(200),
  partUnitCosts: z
    .array(z.object({ stockUuid: id, unitCents: cents }))
    .max(200),
});

/**
 * An aircraft's maintenance budget for one calendar year.
 *
 * @throws {z.ZodError} From `parse()` on an invalid field.
 */
export const budgetSchema = z.object({
  ...base,
  kind: z.literal("budget"),
  aircraftUuid: id,
  year: budgetYear,
  amountCents: cents,
});

/**
 * A Flight Program's labor rate, applied to labor added without one.
 *
 * @throws {z.ZodError} From `parse()` on an invalid field.
 */
export const costSettingsSchema = z.object({
  ...base,
  kind: z.literal("settings"),
  laborRateCents: rate,
});

/**
 * Any stored cost record, by `kind`.
 *
 * @throws {z.ZodError} From `parse()` on an unknown kind or invalid field.
 */
export const costRecordSchema = z.discriminatedUnion("kind", [
  workOrderCostSchema,
  budgetSchema,
  costSettingsSchema,
]);
/** A parsed cost record. */
export type CostRecord = z.infer<typeof costRecordSchema>;
/** A parsed work-order cost record. */
export type WorkOrderCost = z.infer<typeof workOrderCostSchema>;
/** A parsed labor entry. */
export type LaborEntry = z.infer<typeof laborEntrySchema>;
/** A parsed other cost. */
export type OtherCost = z.infer<typeof otherCostSchema>;

/**
 * A cost command: add or remove labor or another cost, set or clear a part's
 * manual unit cost, set a budget, or set the labor rate; each may carry its
 * request id.
 *
 * @throws {z.ZodError} From `parse()` on an invalid command; "Enter labor
 *   hours." for labor with both or neither of minutes and seconds.
 */
export const costCommandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("labor.add"),
    ...requestUuidField,
    workOrderUuid: id,
    // Current apps send exact seconds; older apps send whole minutes.
    entry: z
      .object({
        uuid: z.string().uuid(),
        date,
        technician: text.max(200),
        minutes: minutes.optional(),
        seconds: seconds.optional(),
        rateCents: rate.optional(),
      })
      .refine((e) => (e.minutes === undefined) !== (e.seconds === undefined), {
        message: "Enter labor hours.",
      }),
  }),
  z.object({
    action: z.enum(["labor.remove", "other.remove"]),
    ...requestUuidField,
    workOrderUuid: id,
    uuid: id,
  }),
  z.object({
    action: z.literal("other.add"),
    ...requestUuidField,
    workOrderUuid: id,
    entry: z.object({
      uuid: z.string().uuid(),
      date,
      description: text,
      amountCents: cents.positive(),
    }),
  }),
  z.object({
    action: z.literal("part.unitCost"),
    ...requestUuidField,
    workOrderUuid: id,
    stockUuid: id,
    // null clears the manual cost and falls back to the stock unit cost.
    unitCents: cents.nullable(),
  }),
  z.object({
    action: z.literal("budget.set"),
    ...requestUuidField,
    aircraftUuid: id,
    year: budgetYear,
    amountCents: cents,
  }),
  z.object({
    action: z.literal("settings.laborRate"),
    ...requestUuidField,
    laborRateCents: rate,
  }),
]);
/** A parsed cost command. */
export type CostCommand = z.infer<typeof costCommandSchema>;
