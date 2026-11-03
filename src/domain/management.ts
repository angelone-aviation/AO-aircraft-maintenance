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
} from "./components";
export { componentTotals, componentSchema } from "./components";
export type { Component } from "./components";
import { ataChapterSchema } from "./ata";
import { z } from "zod";
import {
  can,
  latestLocalDate,
  totalSeconds,
  type Snapshot,
  type Aircraft,
  type Inspection,
} from "./model";
import { endOfDueMonth } from "./maintenance";
import { assertNotExpired } from "./shelfLife";
const text = z.string().trim().min(1).max(2000);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = count.positive();
const date = z.iso.date();
const base = { uuid: text, version: count, programUuid: z.string().optional() };
export const locationSchema = z.object({
  ...base,
  kind: z.literal("location"),
  name: text,
  addressDetails: addressSchema.optional(),
  address: z.string().max(4000),
  contact: z.string().max(2000),
});
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
export type Vendor = z.infer<typeof vendorSchema>;
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
export const recordSchema = z.discriminatedUnion("kind", [
  componentSchema,
  requirementSchema,
  movementSchema,
  locationSchema,
  vendorSchema,
  stockSchema,
]);
export type ManagedRecord = z.infer<typeof recordSchema>;
export type Stock = z.infer<typeof stockSchema>;
export type Location = z.infer<typeof locationSchema>;
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
export type ManagementCommand = z.infer<typeof managementCommandSchema>;
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
  if (!c) throw new Error("Inspection component not found.");
  const totals = componentTotals(c, a);
  return {
    seconds: totals.timeSinceNew,
    cycles: totals.cyclesSinceNew,
    landings: a.landings,
  };
}
export function validateMaintenanceTotals(
  a: Aircraft,
  records: ManagedRecord[],
  inspections: Inspection[],
) {
  for (const c of records)
    if (
      c.kind === "component" &&
      c.aircraftUuid === a.uuid &&
      c.installed &&
      ((tracking(c).time &&
        componentAircraftSeconds(c, a) < c.installedSeconds) ||
        (tracking(c).cycles && a.cycles < c.installedCycles))
    )
      throw new Error(
        "Correction would move aircraft totals before a component installation.",
      );
  for (const r of records)
    if (
      r.kind === "componentRequirement" &&
      r.aircraftUuid === a.uuid &&
      r.intervalLandings &&
      (!r.landingReferenceAircraftUuid ||
        r.landingReferenceAircraftUuid === a.uuid) &&
      a.landings < (r.lastLandings ?? 0)
    )
      throw new Error(
        "Correction would move landings before recorded service compliance.",
      );
  for (const i of inspections)
    if (i.aircraftUuid === a.uuid) {
      const counters = inspectionCounters(i, a, records);
      if (
        counters.seconds < (i.lastSeconds ?? 0) ||
        counters.cycles < (i.lastCycles ?? 0) ||
        a.landings < (i.lastLandings ?? 0)
      )
        throw new Error(
          "Correction would move usage before recorded inspection compliance.",
        );
    }
}
function checkDate(d: string, now: number) {
  if (d > latestLocalDate(now))
    throw new Error("Service dates cannot be in the future.");
}
function fresh(version: number, existing?: { version?: number }) {
  if (version !== (existing?.version ?? 0))
    throw new Error("This record changed. Refresh and try again.");
}
export function applyManagement(
  s: Snapshot,
  raw: ManagementCommand,
  now = Date.now(),
) {
  const c = managementCommandSchema.parse(raw);
  const records = s.management ?? [];
  const existing =
    c.action === "inspection.save"
      ? s.inspections.find((i) => i.uuid === c.record.uuid)
      : c.action === "inspection.complete"
        ? s.inspections.find((i) => i.uuid === c.uuid)
        : records.find(
            (r) => r.uuid === ("record" in c ? c.record.uuid : c.uuid),
          );
  if (existing) {
    const owner =
      "kind" in existing
        ? recordProgram(s, existing)
        : s.aircraft.find((a) => a.uuid === existing.aircraftUuid)?.programUuid;
    if (!ownsActive(s, owner))
      throw new Error("Record belongs to another Flight Program.");
  }
  if (c.action === "record.save") {
    const owner =
      existing && "kind" in existing
        ? recordProgram(s, existing)
        : activeProgram(s);
    if (c.record.programUuid && c.record.programUuid !== owner)
      throw new Error("Use an explicit Flight Program transfer.");
    c.record.programUuid = owner;
    if (c.record.kind === "stock") {
      const locationUuid = c.record.locationUuid;
      const location = records.find(
        (r) => r.uuid === locationUuid && r.kind === "location",
      );
      if (!location || recordProgram(s, location) !== owner)
        throw new Error("Storage location must belong to this Flight Program.");
    }
    if (c.record.kind === "componentRequirement") {
      const componentId = c.record.componentUuid;
      const component = records.find(
        (r) => r.kind === "component" && r.uuid === componentId,
      );
      if (!component || recordProgram(s, component) !== owner)
        throw new Error("Component must belong to this Flight Program.");
    }
  }
  if (
    c.action === "inspection.save" ||
    (c.action === "record.save" &&
      ["componentRequirement", "component"].includes(c.record.kind))
  ) {
    const previousReference =
      existing && "manualReference" in existing
        ? existing.manualReference
        : undefined;
    if (
      JSON.stringify(
        "manualReference" in c.record ? c.record.manualReference : undefined,
      ) !== JSON.stringify(previousReference)
    )
      validateManualReference(
        s,
        "manualReference" in c.record ? c.record.manualReference : undefined,
      );
  }
  let next: Inspection | ManagedRecord;
  const extras: ManagedRecord[] = [];
  const updatedInspections: Inspection[] = [];
  let scope: string | undefined;
  if (c.action.startsWith("inspection.")) {
    scope =
      c.action === "inspection.save"
        ? c.record.aircraftUuid
        : (existing as Inspection | undefined)?.aircraftUuid;
  } else if (c.action === "record.save" && "aircraftUuid" in c.record)
    scope = c.record.aircraftUuid;
  else if (existing && "kind" in existing && "aircraftUuid" in existing)
    scope = existing.aircraftUuid;
  if (
    !s.user.active ||
    (scope
      ? !can(s, scope, "maintenance")
      : !programPermission(
          s,
          c.action === "stock.move" ||
            (c.action === "record.save" &&
              ["stock", "location", "vendor"].includes(c.record.kind))
            ? "admin"
            : "maintenance",
        ))
  )
    throw new Error("Permission denied.");
  if (existing && "aircraftUuid" in existing && scope !== existing.aircraftUuid)
    throw new Error("Records cannot be moved between aircraft.");
  const aircraft = s.aircraft.find((a) => a.uuid === scope);
  if (scope && !aircraft) throw new Error("Aircraft not found.");
  if (
    !existing &&
    "record" in c &&
    "sourceKey" in c.record &&
    c.record.sourceKey
  ) {
    const r = c.record;

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
      throw new Error(
        "This manual item has already been added to the selected target.",
      );
  }
  fresh("record" in c ? c.record.version : c.version, existing);
  if (c.action === "inspection.save") {
    const r = c.record;
    const prior = existing && !("kind" in existing) ? existing : undefined;
    // Older clients omit these fields: preserve the exemption on unrelated edits.
    r.calendarExempt ??= prior?.calendarExempt;
    r.calendarExemptReason ??= prior?.calendarExemptReason;
    if (r.calendarExempt && !r.calendarExemptReason?.trim())
      throw new Error("Enter a reason/reference for the calendar exemption.");
    const exemptionChanged =
      (r.calendarExempt ?? false) !== (prior?.calendarExempt ?? false) ||
      (r.calendarExemptReason ?? "") !== (prior?.calendarExemptReason ?? "");
    r.calendarExemptChangedAt = exemptionChanged
      ? now
      : prior?.calendarExemptChangedAt;
    r.calendarExemptChangedBy = exemptionChanged
      ? s.user.id
      : prior?.calendarExemptChangedBy;
    r.programUuid = aircraft!.programUuid;
    if (existing && !("kind" in existing)) {
      r.usageMeter ??= existing.usageMeter;
      if ((r.usageMeter ?? "aircraft") !== (existing.usageMeter ?? "aircraft"))
        throw new Error(
          "Create a new schedule with verified baselines to change its time source.",
        );
    }
    if (r.requiredParts === undefined)
      r.requiredParts = (existing as Inspection | undefined)?.requiredParts;
    validateRequiredParts(s, r.requiredParts, r.programUuid);
    if (
      existing &&
      !("kind" in existing) &&
      existing.componentUuid !== r.componentUuid
    )
      throw new Error("Create a new schedule to change the tracked component.");
    const counters = inspectionCounters(r, aircraft!, records);
    if (
      !r.archived &&
      ![
        r.dueSeconds,
        r.dueCycles,
        r.dueLandings,
        r.intervalLandings,
        r.dueDate,
        r.intervalSeconds,
        r.intervalCycles,
        r.intervalMonths,
      ].some((v) => v !== undefined)
    )
      throw new Error("Enter at least one due limit or recurring interval.");
    if (r.lastDate) checkDate(r.lastDate, now);
    if (
      (r.lastSeconds !== undefined && r.lastSeconds > counters.seconds) ||
      (r.lastCycles !== undefined && r.lastCycles > counters.cycles) ||
      (r.lastLandings !== undefined && r.lastLandings > counters.landings)
    )
      throw new Error("Last compliance cannot exceed aircraft totals.");
    if (
      (r.intervalSeconds && r.lastSeconds === undefined) ||
      (r.intervalCycles && r.lastCycles === undefined) ||
      (r.intervalLandings && r.lastLandings === undefined) ||
      (r.intervalMonths && !r.lastDate)
    )
      throw new Error(
        "Each interval requires its last compliance reading or date.",
      );
    next = {
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
  } else if (c.action === "inspection.complete") {
    if (!existing || "kind" in existing)
      throw new Error("Inspection not found.");
    if (existing.archived) throw new Error("Inspection is archived.");
    checkDate(c.date, now);
    const counters = inspectionCounters(existing, aircraft!, records);
    if (
      (existing.intervalLandings || existing.dueLandings !== undefined) &&
      c.landings === undefined
    )
      throw new Error("Enter aircraft total landings at completion.");
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
      throw new Error(
        "Compliance readings must be between last compliance and current aircraft totals.",
      );
    next = {
      ...existing,
      lastDate: c.date,
      lastSeconds: c.seconds,
      lastCycles: c.cycles,
      lastLandings: c.landings,
      dueLandings: existing.intervalLandings
        ? c.landings! + existing.intervalLandings
        : undefined,
      dueSeconds: existing.intervalSeconds
        ? c.seconds + existing.intervalSeconds
        : undefined,
      dueCycles: existing.intervalCycles
        ? c.cycles + existing.intervalCycles
        : undefined,
      dueDate: existing.intervalMonths
        ? endOfDueMonth(c.date, existing.intervalMonths)
        : undefined,
      archived:
        !existing.intervalSeconds &&
        !existing.intervalCycles &&
        !existing.intervalLandings &&
        !existing.intervalMonths,
      version: c.version + 1,
    };
  } else if (c.action === "record.save") {
    const r = c.record;
    if (
      r.kind === "vendor" &&
      records.some(
        (other) =>
          other.kind === "vendor" &&
          other.uuid !== r.uuid &&
          recordProgram(s, other) === activeProgram(s) &&
          other.name.toLowerCase() === r.name.toLowerCase(),
      )
    )
      throw new Error("A vendor with this name already exists.");
    if (r.kind === "location" && r.addressDetails) {
      r.address = formatAddress(r.addressDetails);
      r.contact = r.addressDetails.contactName;
    }
    if (existing && (!("kind" in existing) || existing.kind !== r.kind))
      throw new Error("Record type cannot change.");
    if (
      c.initialAircraftSetup &&
      (existing || r.kind !== "component" || !r.installed)
    )
      throw new Error(
        "Initial aircraft setup is only for a new, already-installed component.",
      );
    if (r.kind === "component") {
      if (existing && "kind" in existing && existing.kind === "component") {
        r.calendarSinceNewUnknown ??= existing.calendarSinceNewUnknown;
        if (r.calendarOverhaulDaysBase === undefined)
          r.calendarOverhaulDaysBase = existing.calendarOverhaulDaysBase;
        r.calendarOverhaulDate ??= existing.calendarOverhaulDate;
      }
      if (
        existing &&
        "kind" in existing &&
        existing.kind === "component" &&
        existing.outForRepair
      )
        throw Error("Receive the component from repair before editing it.");
      if (r.outForRepair)
        throw Error("Ship components for repair through their purchase order.");
      if (!existing && r.installed && !c.initialAircraftSetup)
        throw new Error(
          "Add the component to inventory, then install it through a work order.",
        );
      validateComponent(
        s,
        r,
        existing && "kind" in existing && existing.kind === "component"
          ? existing
          : undefined,
        now,
      );
      r.createdAt =
        existing && "kind" in existing && existing.kind === "component"
          ? existing.createdAt
          : now;
    } else if (r.kind === "componentMovement") {
      throw new Error("Movement history is immutable. Use component actions.");
    } else if (r.kind === "componentRequirement") {
      if (
        existing &&
        "kind" in existing &&
        existing.kind === "componentRequirement" &&
        existing.componentUuid !== r.componentUuid
      )
        throw new Error("The linked component cannot change.");
      if (
        r.requiredParts === undefined &&
        existing &&
        "requiredParts" in existing
      )
        r.requiredParts = existing.requiredParts;
      validateRequiredParts(s, r.requiredParts, r.programUuid);
      const computed = saveRequirement(s, r, now);
      Object.assign(r, computed, { version: c.record.version });
    } else if (r.kind === "stock") {
      const reserved =
        existing && "kind" in existing && existing.kind === "stock"
          ? (existing.reservedQuantity ?? 0)
          : 0;
      if (r.reservedQuantity !== undefined && r.reservedQuantity !== reserved)
        throw Error("Change reservations through Parts requests.");
      if (reserved > 0) {
        if (
          r.quantity < reserved ||
          (existing &&
            "partNumber" in existing &&
            r.partNumber !== existing.partNumber) ||
          (existing &&
            "condition" in existing &&
            r.condition !== existing.condition)
        )
          throw Error(
            "Release stock reservations before changing part identity, condition or reducing stock below its reserved quantity.",
          );
      }
      r.reservedQuantity = reserved;
      if (
        !records.some((l) => l.kind === "location" && l.uuid === r.locationUuid)
      )
        throw new Error("Select an existing stock location.");
      if (
        existing &&
        "kind" in existing &&
        existing.kind === "stock" &&
        r.locationUuid !== existing.locationUuid
      )
        throw new Error("Location is fixed for each stock lot.");
    }
    next = { ...r, version: r.version + 1 };
  } else if (
    c.action === "component.service" ||
    c.action === "component.baseline"
  ) {
    if (!existing || !("kind" in existing) || existing.kind !== "component")
      throw new Error("Component not found.");
    if (existing.outForRepair)
      throw Error("Receive the component from repair before changing it.");
    if (c.action === "component.baseline") {
      if (c.reason.trim().length < 10)
        throw new Error(
          "Provide a baseline source or reason of at least 10 characters.",
        );
      next = {
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
        calendarOverhaulDate:
          c.calendarOverhaulDaysBase === undefined
            ? existing.calendarOverhaulDate
            : existing.installed
              ? c.installedDate
              : existing.calendarOverhaulDate,
        installedDate: existing.installed
          ? c.installedDate
          : existing.installedDate,
        version: existing.version + 1,
      };
      validateComponent(s, next, existing, now, true);
    } else {
      if (c.operation === "install" || c.operation === "remove")
        throw new Error(
          "Installations and removals must be completed through a work order.",
        );
      next = serviceComponent(s, existing, c, now);
      if (c.operation === "overhaul" || c.operation === "repair")
        extras.push(
          ...rebaseServicedRequirements(
            s,
            next,
            componentTotals(
              existing,
              s.aircraft.find((a) => a.uuid === existing.aircraftUuid),
              c.date,
            ),
            {
              overhaul: c.operation === "overhaul",
              repair: c.operation === "repair",
              date: c.date,
            },
            now,
          ),
        );
    }
    const componentNext = next;
    for (const i of s.inspections.filter(
      (i) => i.componentUuid === next.uuid,
    )) {
      const counters = componentTotals(
        next,
        s.aircraft.find((a) => a.uuid === componentNext.aircraftUuid),
        latestLocalDate(now),
      );
      if (
        counters.timeSinceNew < (i.lastSeconds ?? 0) ||
        counters.cyclesSinceNew < (i.lastCycles ?? 0)
      )
        throw new Error(
          "Baseline would precede recorded inspection compliance.",
        );
      if (i.aircraftUuid !== next.aircraftUuid)
        updatedInspections.push({
          ...i,
          aircraftUuid: next.aircraftUuid,
          version: (i.version ?? 0) + 1,
        });
    }
    if (next.aircraftUuid !== existing.aircraftUuid) {
      for (const r of records)
        if (r.kind === "componentRequirement" && r.componentUuid === next.uuid)
          extras.push(moveRequirement(r, next.aircraftUuid));
    }
    const action =
      c.action === "component.baseline"
        ? "BASELINE"
        : c.operation === "install"
          ? "INSTALL"
          : c.operation === "remove"
            ? "REMOVE"
            : c.operation === "overhaul"
              ? "OVERHAUL"
              : "REPAIR";
    extras.push(movement(next, action, s, c.requestUuid, c.reason, now));
  } else {
    if (!existing || !("kind" in existing) || existing.kind !== "stock")
      throw new Error("Stock item not found.");
    if (c.operation !== "adjust" && c.quantity === 0)
      throw new Error("Movement quantity must be positive.");
    if (c.operation === "issue") assertNotExpired(existing, now);
    const quantity =
      c.operation === "adjust"
        ? c.quantity
        : existing.quantity +
          (c.operation === "receive" ? c.quantity : -c.quantity);
    if (
      !Number.isSafeInteger(quantity) ||
      quantity < (existing.reservedQuantity ?? 0)
    )
      throw new Error("Insufficient stock or invalid quantity.");
    next = { ...existing, quantity, version: c.version + 1 };
  }
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
