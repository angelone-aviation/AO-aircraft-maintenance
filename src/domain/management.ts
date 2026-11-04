/**
 * Responsibility: Inventory and inspection records (locations, vendors, stock,
 *   components and their limits, inspections): their stored schemas, the one
 *   command that changes them, and the usage checks they impose on aircraft.
 * Layer: Domain. Pure functions and zod schemas; no I/O, no React (a `now` or
 *   `today` left to its default reads the clock).
 * Dependencies: zod; ./addresses, ./requiredParts, ./manuals, ./programs,
 *   ./components, ./ata, ./model, ./maintenance, ./shelfLife, ./rejection.
 */
import { addressSchema, formatAddress } from "./addresses";
import { requiredPartsSchema, validateRequiredParts } from "./requiredParts";
import { manualReferenceSchema, validateManualReference } from "./manuals";
import {
  activeProgram,
  ownsActive,
  recordProgram,
  programPermission,
} from "./programs";
import {
  componentSchema,
  requirementSchema,
  movementSchema,
  baselineFields,
  serviceFields,
  componentTotals,
  componentAircraftSeconds,
  tracking,
  validateComponent,
  saveRequirement,
  serviceComponent,
  movement,
  moveRequirement,
  rebaseServicedRequirements,
  type Component,
  type ComponentMovement,
  type ComponentRequirement,
} from "./components";
// Kept for importers that read components through this module.
export { componentTotals, componentSchema } from "./components";
export type { Component } from "./components";
import { ataChapterSchema } from "./ata";
import { z } from "zod";
import {
  can,
  latestLocalDate,
  type Snapshot,
  type Aircraft,
  type Inspection,
} from "./model";
import { endOfDueMonth } from "./maintenance";
import { assertNotExpired } from "./shelfLife";
import { Rejection } from "./rejection";

const text = z.string().trim().min(1).max(2000);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = count.positive();
const date = z.iso.date();
const base = { uuid: text, version: count, programUuid: z.string().optional() };

const MIN_BASELINE_REASON_LENGTH = 10;

const INVENTORY_KINDS = ["stock", "location", "vendor"];
const MANUAL_LINKED_KINDS = ["componentRequirement", "component"];

const MOVEMENT_ACTIONS: Partial<Record<string, ComponentMovement["action"]>> = {
  install: "INSTALL",
  remove: "REMOVE",
  overhaul: "OVERHAUL",
};

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
  vendor: z.string().trim().max(200).optional(),
  invoiceNumber: z.string().trim().max(100).optional(),
  poRef: z.string().trim().max(100).optional(),
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
  reference: z.string().trim().max(2000).default(""),
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

/**
 * The usage an inspection is measured against: the aircraft's, or for a
 * component inspection, the component's time and cycles since new.
 *
 * @param i - The inspection.
 * @param a - Its aircraft.
 * @param records - The program's records, to find the component.
 * @returns Seconds, cycles and the aircraft's landings.
 * @throws {Rejection} "Inspection component not found." when the component
 *   is not on this aircraft; as {@link componentAircraftSeconds} and
 *   {@link componentTotals}.
 */
export function inspectionCounters(
  i: Inspection,
  a: Aircraft,
  records: ManagedRecord[] = [],
) {
  if (!i.componentUuid)
    return {
      seconds: componentAircraftSeconds(i, a),
      cycles: a.cycles,
      landings: a.landings,
    };
  const c = records.find(
    (r): r is Component =>
      r.kind === "component" &&
      r.uuid === i.componentUuid &&
      r.aircraftUuid === a.uuid,
  );
  if (!c) throw new Rejection("Inspection component not found.");
  const totals = componentTotals(c, a);
  return {
    seconds: totals.timeSinceNew,
    cycles: totals.cyclesSinceNew,
    landings: a.landings,
  };
}

/**
 * Checks that corrected aircraft totals do not fall before recorded work:
 * an installed component's installation, a landing-based service, or an
 * inspection's last compliance.
 *
 * @param a - The aircraft with its corrected totals.
 * @param records - The program's records.
 * @param inspections - The inspections to check; others' aircraft are skipped.
 * @throws {Rejection} "Correction would move aircraft totals before a
 *   component installation.", "… landings before recorded service
 *   compliance." or "… usage before recorded inspection compliance.", in
 *   that order; as {@link inspectionCounters}.
 */
export function validateMaintenanceTotals(
  a: Aircraft,
  records: ManagedRecord[],
  inspections: Inspection[],
) {
  if (records.some((c) => precedesInstallation(a, c)))
    throw new Rejection(
      "Correction would move aircraft totals before a component installation.",
    );
  if (records.some((r) => precedesServiceLandings(a, r)))
    throw new Rejection(
      "Correction would move landings before recorded service compliance.",
    );
  for (const i of inspections)
    if (i.aircraftUuid === a.uuid && precedesCompliance(a, i, records))
      throw new Rejection(
        "Correction would move usage before recorded inspection compliance.",
      );
}

/**
 * Applies one inventory or inspection command in the active Flight Program,
 * as the signed-in user, and prepends its change-log entry.
 *
 * @param s - The snapshot; its records, inspections and audit are updated.
 * @param raw - The command, parsed with {@link managementCommandSchema}.
 * @param now - The time to record; the clock by default.
 * @returns The record as saved (`next`) and as it was (`before`), its
 *   aircraft, the records stored (none for an inspection), and inspections
 *   moved with their component.
 * @throws {Rejection} Every refusal of the command, checked in a fixed order;
 *   as the component, required-part, manual and shelf-life rules it applies.
 * @throws {z.ZodError} On an invalid command.
 */
export function applyManagement(
  s: Snapshot,
  raw: ManagementCommand,
  now = Date.now(),
) {
  const c = managementCommandSchema.parse(raw);
  const records = s.management ?? [];
  const existing = findExisting(s, records, c);
  if (existing) assertActiveProgram(s, existing);
  if (c.action === "record.save")
    assignRecordProgram(s, records, c.record, existing);
  checkManualReference(s, c, existing);
  const { scope, aircraft } = authorize(s, c, existing);
  assertNewSourceItem(s, records, c, existing);
  assertFresh("record" in c ? c.record.version : c.version, existing);
  const ctx = { existing, aircraft, records, now };
  const { next, extras, updatedInspections } = applyCommand(s, c, ctx);
  storeChange(s, records, next, extras, updatedInspections);
  s.audit.unshift({
    uuid: c.requestUuid,
    actorId: s.user.id,
    at: now,
    action: c.action + ("operation" in c ? "." + c.operation : ""),
    entityUuid: next.uuid,
    aircraftUuid: scope || undefined,
    reason: c.reason,
    before: existing ? JSON.stringify(existing) : undefined,
    after: JSON.stringify(next),
  });
  return {
    next,
    before: existing,
    aircraftUuid: scope || undefined,
    records: "kind" in next ? [next, ...extras] : [],
    updatedInspections,
  };
}

type Existing = Inspection | ManagedRecord | undefined;
type CommandOf<A extends ManagementCommand["action"]> = Extract<
  ManagementCommand,
  { action: A }
>;
type ComponentCommand = CommandOf<"component.service" | "component.baseline">;
type InspectionRecord = CommandOf<"inspection.save">["record"];
type RecordOfKind<K extends ManagedRecord["kind"]> = Extract<
  ManagedRecord,
  { kind: K }
>;
interface Context {
  existing: Existing;
  aircraft: Aircraft | undefined;
  records: ManagedRecord[];
  now: number;
}
interface Change {
  next: Inspection | ManagedRecord;
  extras: ManagedRecord[];
  updatedInspections: Inspection[];
}

function precedesInstallation(a: Aircraft, c: ManagedRecord) {
  return (
    c.kind === "component" &&
    c.aircraftUuid === a.uuid &&
    c.installed &&
    ((tracking(c).time &&
      componentAircraftSeconds(c, a) < c.installedSeconds) ||
      (tracking(c).cycles && a.cycles < c.installedCycles))
  );
}

function precedesServiceLandings(a: Aircraft, r: ManagedRecord) {
  return (
    r.kind === "componentRequirement" &&
    r.aircraftUuid === a.uuid &&
    !!r.intervalLandings &&
    (!r.landingReferenceAircraftUuid ||
      r.landingReferenceAircraftUuid === a.uuid) &&
    a.landings < (r.lastLandings ?? 0)
  );
}

function precedesCompliance(
  a: Aircraft,
  i: Inspection,
  records: ManagedRecord[],
) {
  const counters = inspectionCounters(i, a, records);
  return (
    counters.seconds < (i.lastSeconds ?? 0) ||
    counters.cycles < (i.lastCycles ?? 0) ||
    a.landings < (i.lastLandings ?? 0)
  );
}

function checkDate(d: string, now: number) {
  if (d > latestLocalDate(now))
    throw new Rejection("Service dates cannot be in the future.");
}

function assertFresh(version: number, existing?: { version?: number }) {
  if (version !== (existing?.version ?? 0))
    throw new Rejection("This record changed. Refresh and try again.");
}

function existingOfKind<K extends ManagedRecord["kind"]>(
  existing: Existing,
  kind: K,
) {
  if (!existing || !("kind" in existing) || existing.kind !== kind) return;
  return existing as RecordOfKind<K>;
}

function findExisting(
  s: Snapshot,
  records: ManagedRecord[],
  c: ManagementCommand,
): Existing {
  if (c.action === "inspection.save")
    return s.inspections.find((i) => i.uuid === c.record.uuid);
  if (c.action === "inspection.complete")
    return s.inspections.find((i) => i.uuid === c.uuid);
  const uuid = "record" in c ? c.record.uuid : c.uuid;
  return records.find((r) => r.uuid === uuid);
}

function assertActiveProgram(
  s: Snapshot,
  existing: Inspection | ManagedRecord,
) {
  const owner =
    "kind" in existing
      ? recordProgram(s, existing)
      : s.aircraft.find((a) => a.uuid === existing.aircraftUuid)?.programUuid;
  if (!ownsActive(s, owner))
    throw new Rejection("Record belongs to another Flight Program.");
}

// A saved record stays in its program, and so must the location or
// component it links to; moving programs is a separate, audited transfer.
function assignRecordProgram(
  s: Snapshot,
  records: ManagedRecord[],
  record: ManagedRecord,
  existing: Existing,
) {
  const owner =
    existing && "kind" in existing
      ? recordProgram(s, existing)
      : activeProgram(s);
  if (record.programUuid && record.programUuid !== owner)
    throw new Rejection("Use an explicit Flight Program transfer.");
  record.programUuid = owner;
  const findLinked = (kind: string, uuid: string) =>
    records.find((r) => r.uuid === uuid && r.kind === kind);
  if (record.kind === "stock") {
    const location = findLinked("location", record.locationUuid);
    if (!location || recordProgram(s, location) !== owner)
      throw new Rejection(
        "Storage location must belong to this Flight Program.",
      );
  }
  if (record.kind !== "componentRequirement") return;
  const component = findLinked("component", record.componentUuid);
  if (!component || recordProgram(s, component) !== owner)
    throw new Rejection("Component must belong to this Flight Program.");
}

function checkManualReference(
  s: Snapshot,
  c: ManagementCommand,
  existing: Existing,
) {
  if (c.action !== "inspection.save" && c.action !== "record.save") return;
  if (
    c.action === "record.save" &&
    !MANUAL_LINKED_KINDS.includes(c.record.kind)
  )
    return;
  const previous =
    existing && "manualReference" in existing
      ? existing.manualReference
      : undefined;
  const reference =
    "manualReference" in c.record ? c.record.manualReference : undefined;
  if (JSON.stringify(reference) !== JSON.stringify(previous))
    validateManualReference(s, reference);
}

function commandScope(c: ManagementCommand, existing: Existing) {
  if (c.action === "inspection.save") return c.record.aircraftUuid;
  if (c.action === "inspection.complete")
    return (existing as Inspection | undefined)?.aircraftUuid;
  if (c.action === "record.save" && "aircraftUuid" in c.record)
    return c.record.aircraftUuid;
  if (existing && "kind" in existing && "aircraftUuid" in existing)
    return existing.aircraftUuid;
  return undefined;
}

// Writes on an aircraft's records need maintenance permission there; others
// need it in the program, or administration for the inventory itself.
function authorize(s: Snapshot, c: ManagementCommand, existing: Existing) {
  const scope = commandScope(c, existing);
  if (!s.user.active || !mayWrite(s, c, scope))
    throw new Rejection("Permission denied.");
  return { scope, aircraft: findScopeAircraft(s, existing, scope) };
}

function mayWrite(s: Snapshot, c: ManagementCommand, scope?: string) {
  if (scope) return can(s, scope, "maintenance");
  const inventory =
    c.action === "stock.move" ||
    (c.action === "record.save" && INVENTORY_KINDS.includes(c.record.kind));
  return programPermission(s, inventory ? "admin" : "maintenance");
}

function findScopeAircraft(s: Snapshot, existing: Existing, scope?: string) {
  if (existing && "aircraftUuid" in existing && scope !== existing.aircraftUuid)
    throw new Rejection("Records cannot be moved between aircraft.");
  const aircraft = s.aircraft.find((a) => a.uuid === scope);
  if (scope && !aircraft) throw new Rejection("Aircraft not found.");
  return aircraft;
}

// A manual item may be added to each aircraft (inspection) or component
// (requirement) once.
function assertNewSourceItem(
  s: Snapshot,
  records: ManagedRecord[],
  c: ManagementCommand,
  existing: Existing,
) {
  if (existing || !("record" in c)) return;
  const r = c.record;
  if (!("sourceKey" in r) || !r.sourceKey) return;
  const duplicate =
    c.action === "inspection.save"
      ? s.inspections.some(
          (i) =>
            i.sourceKey === r.sourceKey && i.aircraftUuid === r.aircraftUuid,
        )
      : "kind" in r &&
        r.kind === "componentRequirement" &&
        records.some(
          (i) =>
            i.kind === "componentRequirement" &&
            i.sourceKey === r.sourceKey &&
            i.componentUuid === r.componentUuid,
        );
  if (duplicate)
    throw new Rejection(
      "This manual item has already been added to the selected target.",
    );
}

function applyCommand(s: Snapshot, c: ManagementCommand, ctx: Context): Change {
  const only = (next: Inspection | ManagedRecord) => ({
    next,
    extras: [],
    updatedInspections: [],
  });
  if (c.action === "inspection.save")
    return only(saveInspection(s, c.record, ctx));
  if (c.action === "inspection.complete")
    return only(completeInspection(c, ctx));
  if (c.action === "record.save") return only(saveRecord(s, c, ctx));
  if (c.action === "stock.move") return only(moveStock(c, ctx));
  return changeComponent(s, c, ctx);
}

function saveInspection(
  s: Snapshot,
  r: InspectionRecord,
  ctx: Context,
): Inspection {
  const prior = ctx.existing as Inspection | undefined;
  stampCalendarExemption(s, r, prior, ctx.now);
  r.programUuid = ctx.aircraft!.programUuid;
  if (prior) {
    r.usageMeter ??= prior.usageMeter;
    if ((r.usageMeter ?? "aircraft") !== (prior.usageMeter ?? "aircraft"))
      throw new Rejection(
        "Create a new schedule with verified baselines to change its time source.",
      );
  }
  if (r.requiredParts === undefined) r.requiredParts = prior?.requiredParts;
  validateRequiredParts(s, r.requiredParts, r.programUuid);
  if (prior && prior.componentUuid !== r.componentUuid)
    throw new Rejection(
      "Create a new schedule to change the tracked component.",
    );
  const counters = inspectionCounters(r, ctx.aircraft!, ctx.records);
  assertInspectionLimits(r, counters, ctx.now);
  return withScheduledDue(r);
}

function stampCalendarExemption(
  s: Snapshot,
  r: InspectionRecord,
  prior: Inspection | undefined,
  now: number,
) {
  // Older clients omit these fields: preserve the exemption on unrelated edits.
  r.calendarExempt ??= prior?.calendarExempt;
  r.calendarExemptReason ??= prior?.calendarExemptReason;
  if (r.calendarExempt && !r.calendarExemptReason?.trim())
    throw new Rejection("Enter a reason/reference for the calendar exemption.");
  const changed =
    (r.calendarExempt ?? false) !== (prior?.calendarExempt ?? false) ||
    (r.calendarExemptReason ?? "") !== (prior?.calendarExemptReason ?? "");
  r.calendarExemptChangedAt = changed ? now : prior?.calendarExemptChangedAt;
  r.calendarExemptChangedBy = changed
    ? s.user.id
    : prior?.calendarExemptChangedBy;
}

function assertInspectionLimits(
  r: Inspection,
  counters: ReturnType<typeof inspectionCounters>,
  now: number,
) {
  const limits = [
    r.dueSeconds,
    r.dueCycles,
    r.dueLandings,
    r.intervalLandings,
    r.dueDate,
    r.intervalSeconds,
    r.intervalCycles,
    r.intervalMonths,
  ];
  if (!r.archived && !limits.some((v) => v !== undefined))
    throw new Rejection("Enter at least one due limit or recurring interval.");
  if (r.lastDate) checkDate(r.lastDate, now);
  if (
    (r.lastSeconds !== undefined && r.lastSeconds > counters.seconds) ||
    (r.lastCycles !== undefined && r.lastCycles > counters.cycles) ||
    (r.lastLandings !== undefined && r.lastLandings > counters.landings)
  )
    throw new Rejection("Last compliance cannot exceed aircraft totals.");
  if (
    (r.intervalSeconds && r.lastSeconds === undefined) ||
    (r.intervalCycles && r.lastCycles === undefined) ||
    (r.intervalLandings && r.lastLandings === undefined) ||
    (r.intervalMonths && !r.lastDate)
  )
    throw new Rejection(
      "Each interval requires its last compliance reading or date.",
    );
}

function withScheduledDue(r: InspectionRecord): Inspection {
  return {
    ...r,
    dueSeconds: r.intervalSeconds
      ? r.lastSeconds! + r.intervalSeconds
      : r.dueSeconds,
    dueCycles: r.intervalCycles
      ? r.lastCycles! + r.intervalCycles
      : r.dueCycles,
    dueLandings: r.intervalLandings
      ? r.lastLandings! + r.intervalLandings
      : r.dueLandings,
    dueDate: r.intervalMonths
      ? endOfDueMonth(r.lastDate!, r.intervalMonths)
      : r.dueDate,
    version: r.version + 1,
  };
}

function completeInspection(
  c: CommandOf<"inspection.complete">,
  ctx: Context,
): Inspection {
  const existing = ctx.existing;
  if (!existing || "kind" in existing)
    throw new Rejection("Inspection not found.");
  if (existing.archived) throw new Rejection("Inspection is archived.");
  checkDate(c.date, ctx.now);
  const counters = inspectionCounters(existing, ctx.aircraft!, ctx.records);
  if (
    (existing.intervalLandings || existing.dueLandings !== undefined) &&
    c.landings === undefined
  )
    throw new Rejection("Enter aircraft total landings at completion.");
  if (
    c.seconds > counters.seconds ||
    c.cycles > counters.cycles ||
    (c.landings !== undefined &&
      (c.landings > counters.landings ||
        c.landings < (existing.lastLandings ?? 0))) ||
    c.seconds < (existing.lastSeconds ?? 0) ||
    c.cycles < (existing.lastCycles ?? 0) ||
    c.date < (existing.lastDate ?? "")
  )
    throw new Rejection(
      "Compliance readings must be between last compliance and current aircraft totals.",
    );
  return renewInspection(existing, c);
}

// A completion without a recurring interval closes the schedule.
function renewInspection(
  i: Inspection,
  c: CommandOf<"inspection.complete">,
): Inspection {
  return {
    ...i,
    lastDate: c.date,
    lastSeconds: c.seconds,
    lastCycles: c.cycles,
    lastLandings: c.landings,
    dueLandings: i.intervalLandings
      ? c.landings! + i.intervalLandings
      : undefined,
    dueSeconds: i.intervalSeconds ? c.seconds + i.intervalSeconds : undefined,
    dueCycles: i.intervalCycles ? c.cycles + i.intervalCycles : undefined,
    dueDate: i.intervalMonths
      ? endOfDueMonth(c.date, i.intervalMonths)
      : undefined,
    archived:
      !i.intervalSeconds &&
      !i.intervalCycles &&
      !i.intervalLandings &&
      !i.intervalMonths,
    version: c.version + 1,
  };
}

function saveRecord(
  s: Snapshot,
  c: CommandOf<"record.save">,
  ctx: Context,
): ManagedRecord {
  const r = c.record;
  assertUniqueVendor(s, ctx.records, r);
  if (r.kind === "location" && r.addressDetails) {
    r.address = formatAddress(r.addressDetails);
    r.contact = r.addressDetails.contactName;
  }
  const { existing, now } = ctx;
  if (existing && (!("kind" in existing) || existing.kind !== r.kind))
    throw new Rejection("Record type cannot change.");
  if (
    c.initialAircraftSetup &&
    (existing || r.kind !== "component" || !r.installed)
  )
    throw new Rejection(
      "Initial aircraft setup is only for a new, already-installed component.",
    );
  if (r.kind === "component")
    prepareComponent(s, r, existingOfKind(existing, r.kind), c, now);
  if (r.kind === "componentMovement")
    throw new Rejection(
      "Movement history is immutable. Use component actions.",
    );
  if (r.kind === "componentRequirement")
    prepareRequirement(s, r, existingOfKind(existing, r.kind), now);
  if (r.kind === "stock")
    prepareStock(r, existingOfKind(existing, r.kind), ctx.records);
  return { ...r, version: r.version + 1 };
}

function assertUniqueVendor(
  s: Snapshot,
  records: ManagedRecord[],
  r: ManagedRecord,
) {
  if (r.kind !== "vendor") return;
  const program = activeProgram(s);
  const name = r.name.toLowerCase();
  const taken = records.some(
    (other) =>
      other.kind === "vendor" &&
      other.uuid !== r.uuid &&
      recordProgram(s, other) === program &&
      other.name.toLowerCase() === name,
  );
  if (taken) throw new Rejection("A vendor with this name already exists.");
}

// Installation and repair state change only through work orders and
// purchase orders, which record the movement.
function prepareComponent(
  s: Snapshot,
  r: Component,
  prior: Component | undefined,
  c: CommandOf<"record.save">,
  now: number,
) {
  if (prior) {
    r.calendarSinceNewUnknown ??= prior.calendarSinceNewUnknown;
    if (r.calendarOverhaulDaysBase === undefined)
      r.calendarOverhaulDaysBase = prior.calendarOverhaulDaysBase;
    r.calendarOverhaulDate ??= prior.calendarOverhaulDate;
  }
  if (prior?.outForRepair)
    throw new Rejection("Receive the component from repair before editing it.");
  if (r.outForRepair)
    throw new Rejection(
      "Ship components for repair through their purchase order.",
    );
  if (!prior && r.installed && !c.initialAircraftSetup)
    throw new Rejection(
      "Add the component to inventory, then install it through a work order.",
    );
  validateComponent(s, r, prior, now);
  r.createdAt = prior ? prior.createdAt : now;
}

function prepareRequirement(
  s: Snapshot,
  r: ComponentRequirement,
  prior: ComponentRequirement | undefined,
  now: number,
) {
  if (prior && prior.componentUuid !== r.componentUuid)
    throw new Rejection("The linked component cannot change.");
  if (r.requiredParts === undefined && prior && "requiredParts" in prior)
    r.requiredParts = prior.requiredParts;
  validateRequiredParts(s, r.requiredParts, r.programUuid);
  const computed = saveRequirement(s, r, now);
  Object.assign(r, computed, { version: r.version });
}

// Reserved quantities belong to parts requests; a lot keeps its identity and
// location while any of it is reserved or stored.
function prepareStock(
  r: Stock,
  prior: Stock | undefined,
  records: ManagedRecord[],
) {
  const reserved = prior?.reservedQuantity ?? 0;
  if (r.reservedQuantity !== undefined && r.reservedQuantity !== reserved)
    throw new Rejection("Change reservations through Parts requests.");
  const reidentified =
    !!prior &&
    (r.partNumber !== prior.partNumber || r.condition !== prior.condition);
  if (reserved > 0 && (r.quantity < reserved || reidentified))
    throw new Rejection(
      "Release stock reservations before changing part identity, condition or reducing stock below its reserved quantity.",
    );
  r.reservedQuantity = reserved;
  if (!records.some((l) => l.kind === "location" && l.uuid === r.locationUuid))
    throw new Rejection("Select an existing stock location.");
  if (prior && r.locationUuid !== prior.locationUuid)
    throw new Rejection("Location is fixed for each stock lot.");
}

function changeComponent(
  s: Snapshot,
  c: ComponentCommand,
  ctx: Context,
): Change {
  const existing = existingOfKind(ctx.existing, "component");
  if (!existing) throw new Rejection("Component not found.");
  if (existing.outForRepair)
    throw new Rejection(
      "Receive the component from repair before changing it.",
    );
  const { next, extras } =
    c.action === "component.baseline"
      ? {
          next: rebaseline(s, c, existing, ctx.now),
          extras: [] as ManagedRecord[],
        }
      : serviceInShop(s, c, existing, ctx.now);
  const updatedInspections = followComponent(s, next, ctx.now);
  if (next.aircraftUuid !== existing.aircraftUuid)
    extras.push(
      ...ctx.records
        .filter(
          (r): r is ComponentRequirement =>
            r.kind === "componentRequirement" && r.componentUuid === next.uuid,
        )
        .map((r) => moveRequirement(r, next.aircraftUuid)),
    );
  const action =
    c.action === "component.baseline"
      ? "BASELINE"
      : (MOVEMENT_ACTIONS[c.operation] ?? "REPAIR");
  extras.push(movement(next, action, s, c.requestUuid, c.reason, ctx.now));
  return { next, extras, updatedInspections };
}

function rebaseline(
  s: Snapshot,
  c: CommandOf<"component.baseline">,
  existing: Component,
  now: number,
): Component {
  if (c.reason.trim().length < MIN_BASELINE_REASON_LENGTH)
    throw new Rejection(
      "Provide a baseline source or reason of at least 10 characters.",
    );
  const next = {
    ...existing,
    installedSeconds: c.installedSeconds,
    installedCycles: c.installedCycles,
    timeSinceNew: c.timeSinceNew,
    timeSinceOverhaul: c.timeSinceOverhaul,
    timeSinceRepair: c.timeSinceRepair,
    cyclesSinceNew: c.cyclesSinceNew,
    serviceDaysBase: c.serviceDaysBase,
    calendarSinceNewUnknown:
      c.calendarSinceNewUnknown ?? existing.calendarSinceNewUnknown,
    calendarOverhaulDaysBase:
      c.calendarOverhaulDaysBase === undefined
        ? existing.calendarOverhaulDaysBase
        : c.calendarOverhaulDaysBase,
    calendarOverhaulDate: baselineOverhaulDate(c, existing),
    installedDate: existing.installed
      ? c.installedDate
      : existing.installedDate,
    version: existing.version + 1,
  };
  validateComponent(s, next, existing, now, true);
  return next;
}

// A new calendar overhaul base counts from the baseline date only while the
// component is installed.
function baselineOverhaulDate(
  c: CommandOf<"component.baseline">,
  existing: Component,
) {
  if (c.calendarOverhaulDaysBase === undefined)
    return existing.calendarOverhaulDate;
  return existing.installed ? c.installedDate : existing.calendarOverhaulDate;
}

// An overhaul or repair restarts the limits counted from it.
function serviceInShop(
  s: Snapshot,
  c: CommandOf<"component.service">,
  existing: Component,
  now: number,
) {
  if (c.operation === "install" || c.operation === "remove")
    throw new Rejection(
      "Installations and removals must be completed through a work order.",
    );
  const next = serviceComponent(s, existing, c, now);
  const extras: ManagedRecord[] = [];
  if (c.operation !== "overhaul" && c.operation !== "repair")
    return { next, extras };
  const aircraft = s.aircraft.find((a) => a.uuid === existing.aircraftUuid);
  const before = componentTotals(existing, aircraft, c.date);
  const work = {
    overhaul: c.operation === "overhaul",
    repair: c.operation === "repair",
    date: c.date,
  };
  extras.push(...rebaseServicedRequirements(s, next, before, work, now));
  return { next, extras };
}

// Inspections of a component follow it to its aircraft, and may not have
// recorded compliance beyond its new usage.
function followComponent(s: Snapshot, next: Component, now: number) {
  const updated: Inspection[] = [];
  for (const i of s.inspections.filter((i) => i.componentUuid === next.uuid)) {
    const counters = componentTotals(
      next,
      s.aircraft.find((a) => a.uuid === next.aircraftUuid),
      latestLocalDate(now),
    );
    if (
      counters.timeSinceNew < (i.lastSeconds ?? 0) ||
      counters.cyclesSinceNew < (i.lastCycles ?? 0)
    )
      throw new Rejection(
        "Baseline would precede recorded inspection compliance.",
      );
    if (i.aircraftUuid !== next.aircraftUuid)
      updated.push({
        ...i,
        aircraftUuid: next.aircraftUuid,
        version: (i.version ?? 0) + 1,
      });
  }
  return updated;
}

function moveStock(c: CommandOf<"stock.move">, ctx: Context): Stock {
  const existing = existingOfKind(ctx.existing, "stock");
  if (!existing) throw new Rejection("Stock item not found.");
  if (c.operation !== "adjust" && c.quantity === 0)
    throw new Rejection("Movement quantity must be positive.");
  if (c.operation === "issue") assertNotExpired(existing, ctx.now);
  const quantity = movedQuantity(c, existing.quantity);
  if (
    !Number.isSafeInteger(quantity) ||
    quantity < (existing.reservedQuantity ?? 0)
  )
    throw new Rejection("Insufficient stock or invalid quantity.");
  return { ...existing, quantity, version: c.version + 1 };
}

function movedQuantity(c: CommandOf<"stock.move">, onHand: number) {
  if (c.operation === "adjust") return c.quantity;
  return onHand + (c.operation === "receive" ? c.quantity : -c.quantity);
}

function storeChange(
  s: Snapshot,
  records: ManagedRecord[],
  next: Inspection | ManagedRecord,
  extras: ManagedRecord[],
  updatedInspections: Inspection[],
) {
  if ("kind" in next)
    s.management = [
      ...records.filter(
        (r) => r.uuid !== next.uuid && !extras.some((e) => e.uuid === r.uuid),
      ),
      next,
      ...extras,
    ];
  else
    s.inspections = [
      ...s.inspections.filter((r) => r.uuid !== next.uuid),
      next,
    ];
  if (updatedInspections.length)
    s.inspections = s.inspections.map(
      (i) => updatedInspections.find((r) => r.uuid === i.uuid) ?? i,
    );
}
