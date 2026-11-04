/**
 * Responsibility: The stored shape of inventory and inspection records
 *   (locations, vendors, stock, components, inspections) and of the commands
 *   that change them.
 * Layer: Domain. Zod schemas and their types; no I/O, no React.
 * Dependencies: zod; ../addresses, ../requiredParts, ../manuals,
 *   ../components, ../ata.
 */
import { z } from "zod";
import { addressSchema } from "../addresses";
import { requiredPartsSchema } from "../requiredParts";
import { manualReferenceSchema } from "../manuals";
import {
  componentSchema,
  requirementSchema,
  movementSchema,
  baselineFields,
  serviceFields,
} from "../components";
import { ataChapterSchema } from "../ata";

const text = z.string().trim().min(1).max(2000);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = count.positive();
const date = z.iso.date();
const base = { uuid: text, version: count, programUuid: z.string().optional() };

/** The longest vendor name a stock lot records. */
export const STOCK_VENDOR_MAX_LENGTH = 200;

/** The longest invoice number or PO reference a stock lot records. */
export const PURCHASE_REFERENCE_MAX_LENGTH = 100;

/** The longest reference an inspection schedule records. */
export const INSPECTION_REFERENCE_MAX_LENGTH = 2000;

/**
 * A storage location of a Flight Program.
 *
 * @throws {z.ZodError} From `parse()` on a missing or invalid field.
 */
export const locationSchema = z.object({
  ...base,
  kind: z.literal("location"),
  name: text,
  addressDetails: addressSchema.optional(),
  address: z.string().max(4000),
  contact: z.string().max(2000),
});

/**
 * A supplier, named once per Flight Program.
 *
 * @throws {z.ZodError} From `parse()`, including "Use an http or https
 *   website." for any other URL.
 */
export const vendorSchema = z.object({
  ...base,
  kind: z.literal("vendor"),
  name: z.string().trim().min(1).max(200),
  addressDetails: addressSchema.optional(),
  website: z
    .union([
      z
        .url()
        .refine(
          (v) => /^https?:\/\//i.test(v),
          "Use an http or https website.",
        ),
      z.literal(""),
    ])
    .default(""),
  accountNumber: z.string().trim().max(200).default(""),
  paymentTerms: z.string().trim().max(500).default(""),
  notes: z.string().trim().max(2000).default(""),
});
/** A parsed vendor. */
export type Vendor = z.infer<typeof vendorSchema>;

/**
 * A stock lot: a quantity of one part or supply, in one condition, at one
 * location. `cost` is the unit cost, to the cent.
 *
 * @throws {z.ZodError} From `parse()` on a missing or invalid field.
 */
export const stockSchema = z.object({
  ...base,
  kind: z.literal("stock"),
  expirationDate: date.optional(),
  vendor: z.string().trim().max(STOCK_VENDOR_MAX_LENGTH).optional(),
  invoiceNumber: z
    .string()
    .trim()
    .max(PURCHASE_REFERENCE_MAX_LENGTH)
    .optional(),
  poRef: z.string().trim().max(PURCHASE_REFERENCE_MAX_LENGTH).optional(),
  cost: z
    .number()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER / 100)
    .multipleOf(0.01)
    .optional(),
  partNumber: text,
  alternates: z.string().max(2000),
  description: text,
  category: z.enum(["part", "supply"]),
  // Engine oil that flight users may draw down when logging oil added on a
  // flight. Only stock marked here can be deducted from the flight line.
  oil: z.boolean().optional(),
  condition: z.enum(["new", "overhauled", "as removed", "core"]),
  locationUuid: text,
  reservedQuantity: count.optional(),
  quantity: count,
  minimum: count,
});

/**
 * Any record kept in a program's `management` list, told apart by `kind`.
 *
 * @throws {z.ZodError} From `parse()` on an unknown kind or invalid field.
 */
export const recordSchema = z.discriminatedUnion("kind", [
  componentSchema,
  requirementSchema,
  movementSchema,
  locationSchema,
  vendorSchema,
  stockSchema,
]);
/** A parsed management record. */
export type ManagedRecord = z.infer<typeof recordSchema>;
/** A parsed stock lot. */
export type Stock = z.infer<typeof stockSchema>;
/** A parsed storage location. */
export type Location = z.infer<typeof locationSchema>;

/**
 * An aircraft or component inspection schedule. A recurring interval needs
 * its last compliance; a component inspection counts the component's usage.
 *
 * @throws {z.ZodError} From `parse()` on a missing or invalid field.
 */
export const inspectionSchema = z.object({
  calendarExempt: z.boolean().optional(),
  calendarExemptReason: z.string().trim().max(5000).optional(),
  calendarExemptChangedAt: z.number().optional(),
  calendarExemptChangedBy: z.string().optional(),
  usageMeter: z.enum(["aircraft", "collective"]).optional(),
  requiredParts: requiredPartsSchema.optional(),
  sourceKey: z.string().max(300).optional(),
  manualReference: manualReferenceSchema.nullable().optional(),
  ataChapter: ataChapterSchema.optional(),
  ...base,
  componentUuid: text.optional(),
  aircraftUuid: text,
  reference: z.string().trim().max(INSPECTION_REFERENCE_MAX_LENGTH).default(""),
  description: text,
  dueSeconds: count.optional(),
  dueCycles: count.optional(),
  dueLandings: count.optional(),
  dueDate: date.optional(),
  intervalSeconds: positive.optional(),
  intervalLandings: count.positive().optional(),
  intervalCycles: positive.optional(),
  intervalMonths: positive.optional(),
  lastSeconds: count.optional(),
  lastCycles: count.optional(),
  lastLandings: count.optional(),
  lastDate: date.optional(),
  materials: z.string().max(5000),
  archived: z.boolean(),
});

const commandBase = { requestUuid: z.string().uuid(), reason: text };

/**
 * The commands {@link applyManagement} runs, by `action`. Each carries a
 * request id and the reason recorded in the change log.
 *
 * @throws {z.ZodError} From `parse()` on an unknown action or invalid field.
 */
export const managementCommandSchema = z.discriminatedUnion("action", [
  z.object({
    ...commandBase,
    action: z.literal("inspection.save"),
    record: inspectionSchema,
  }),
  z.object({
    ...commandBase,
    action: z.literal("inspection.complete"),
    uuid: text,
    version: count,
    date,
    seconds: count,
    cycles: count,
    landings: count.optional(),
  }),
  z.object({
    ...commandBase,
    action: z.literal("record.save"),
    record: recordSchema,
    initialAircraftSetup: z.boolean().optional(),
  }),
  z.object({
    ...commandBase,
    action: z.literal("component.service"),
    uuid: text,
    version: count,
    ...serviceFields,
  }),
  z.object({
    ...commandBase,
    action: z.literal("component.baseline"),
    uuid: text,
    version: count,
    ...baselineFields,
  }),
  z.object({
    ...commandBase,
    action: z.literal("stock.move"),
    uuid: text,
    version: count,
    operation: z.enum(["receive", "issue", "adjust"]),
    quantity: count,
  }),
]);
/** A parsed management command. */
export type ManagementCommand = z.infer<typeof managementCommandSchema>;

/** One management command, narrowed to its `action`. */
export type CommandOf<A extends ManagementCommand["action"]> = Extract<
  ManagementCommand,
  { action: A }
>;
