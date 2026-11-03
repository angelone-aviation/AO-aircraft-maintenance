import { logbookSelectionFields } from "./logbookWording";
import { recordProgram } from "./programs";
import { manualReferenceSchema, validateManualReference } from "./manuals";
import { z } from "zod";
import { can, latestLocalDate, type Member, type Snapshot } from "./model";
import { memberLicense } from "./certifications";
import { ataChapterSchema } from "./ata";
import { isOpenWorkOrder } from "./workOrders";
import { expiredForUse } from "./shelfLife";
const text = z.string().trim().max(10000);
const optionalId = z.string().max(200);
const number = z.number().finite();
const date = z.union([z.iso.date(), z.literal("")]);
export const taskCardStatuses = [
  "draft",
  "ready",
  "in-progress",
  "awaiting-parts",
  "awaiting-inspection",
  "completed",
  "canceled",
] as const;
export const evidenceCategories = [
  "photo",
  "supporting-document",
  "parts-traceability",
] as const;
export const taskLinkSchema = z.object({
  kind: z.enum([
    "inspection",
    "componentRequirement",
    "discrepancy",
    "workOrder",
  ]),
  uuid: z.string().min(1).max(200),
});
export type TaskLink = z.infer<typeof taskLinkSchema>;
export const linkField = {
  inspection: "inspectionUuid",
  componentRequirement: "requirementUuid",
  discrepancy: "discrepancyUuid",
  workOrder: "workOrderUuid",
} as const;
const signatureSchema = z.object({
  userId: z.string(),
  name: z.string(),
  at: z.number(),
});
export const stepSchema = z.object({
  uuid: z.string().uuid(),
  instruction: text.min(1),
  requiredResult: text,
  result: text,
  measurementRequired: z.boolean(),
  measurement: number.nullable(),
  units: z.string().trim().max(100),
  lowerLimit: number.nullable(),
  upperLimit: number.nullable(),
  signoffRequired: z.boolean(),
});
const partSchema = z.object({
  source: z.enum(["stock", "non-stock"]).optional(),
  stockUuid: optionalId.optional(),
  locationUuid: optionalId.optional(),
  uuid: z.string().uuid(),
  partNumber: text.min(1),
  description: text,
  quantity: number.positive(),
  serialLot: text,
  removedComponent: text,
  installedComponent: text,
});
export const taskCardFieldsSchema = z.object({
  ...logbookSelectionFields,
  itemCode: z.string().max(100).optional(),
  sourceKey: z.string().max(300).optional(),
  aircraftUuid: z.string().min(1).max(200),
  cardNumber: z.string().trim().max(100),
  title: text.min(1),
  ataChapter: ataChapterSchema.optional(),
  workOrderUuid: optionalId,
  inspectionUuid: optionalId,
  componentUuid: optionalId,
  requirementUuid: optionalId,
  discrepancyUuid: optionalId,
  description: text,
  manualReference: manualReferenceSchema.nullable().optional(),
  maintenanceReference: text,
  referenceRevision: text,
  referenceDate: date,
  applicability: text,
  notesRemarks: text.optional(),
  steps: z.array(stepSchema).max(200),
  assignedTechnician: text,
  estimatedLabor: number.nonnegative().nullable(),
  requiredParts: text,
  requiredTools: text,
  prerequisiteUuids: z.array(z.string().uuid()).max(100),
  prerequisites: text,
  findings: text,
  actualWork: text,
  measurements: text,
  actualLabor: number.nonnegative().nullable(),
  completionDate: date,
  partsUsed: z.array(partSchema).max(200),
  inspectionSignoffRequired: z.boolean(),
  functionalTestRequired: z.boolean(),
  functionalTestOutcome: z.enum(["pending", "pass", "fail", "not-required"]),
  functionalTestResults: text,
  status: z.enum(taskCardStatuses),
});
export const taskCardSchema = taskCardFieldsSchema.extend({
  sourceTaskCardUuid: z.string().uuid().optional(),
  sourceTaskCardVersion: z.number().int().nonnegative().optional(),
  workTaskUuid: z.string().uuid().optional(),
  uuid: z.string().uuid(),
  version: z.number().int().nonnegative(),
  createdAt: z.number(),
  createdBy: z.string(),
  updatedAt: z.number(),
  technicianSignoff: signatureSchema.nullable(),
  inspectionSignoff: signatureSchema.nullable(),
  stepSignoffs: z.record(z.string(), signatureSchema),
});
export type TaskCard = z.infer<typeof taskCardSchema>;
export type TaskCardFields = z.infer<typeof taskCardFieldsSchema>;
export type TaskStep = TaskCardFields["steps"][number];
export type TaskPart = TaskCardFields["partsUsed"][number];
export const taskCardCommandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save"),
    uuid: z.string().uuid(),
    version: z.number().int().nonnegative(),
    fields: taskCardFieldsSchema,
  }),
  z.object({
    action: z.literal("link"),
    uuid: z.string().uuid(),
    version: z.number().int().nonnegative(),
    link: taskLinkSchema,
  }),
  z.object({
    action: z.literal("unlink"),
    uuid: z.string().uuid(),
    version: z.number().int().nonnegative(),
    link: taskLinkSchema,
  }),
  z.object({
    action: z.literal("sign"),
    uuid: z.string().uuid(),
    version: z.number().int().nonnegative(),
    kind: z.enum(["technician", "inspection", "step"]),
    stepUuid: z.string().uuid().optional(),
  }),
]);
export type TaskCardCommand = z.infer<typeof taskCardCommandSchema>;
export interface TaskEvidence {
  uuid: string;
  taskCardUuid: string;
  name: string;
  size: number;
  uploadedAt: number;
  url: string;
  category: (typeof evidenceCategories)[number];
}
export function isTaskTemplate(
  t: Pick<
    TaskCardFields,
    "workOrderUuid" | "inspectionUuid" | "requirementUuid" | "discrepancyUuid"
  >,
) {
  return (
    !t.workOrderUuid &&
    !!(t.inspectionUuid || t.requirementUuid || t.discrepancyUuid)
  );
}
export function hasTaskExecution(t: TaskCardFields) {
  return !!(
    t.findings ||
    t.actualWork ||
    t.measurements ||
    t.actualLabor !== null ||
    t.completionDate ||
    t.partsUsed.length ||
    t.functionalTestResults ||
    ["pass", "fail"].includes(t.functionalTestOutcome) ||
    t.steps.some((step) => step.result || step.measurement !== null)
  );
}
export const inspectorCertificateRequired =
  "Add your certificate type and number under My certifications to sign as inspector.";
/** The inspection signoff is the 14 CFR 43.7 person's signature, so the signer
 * needs a certificate type and number on file (ADR-0004). Technician signoffs
 * stay open: 43.3(d) lets supervised uncertificated workers perform work. */
export function hasInspectorCertificate(
  user: Pick<Member, "certifications" | "licenseNumber" | "certificateType">,
  asOf: string,
) {
  const { licenseNumber, certificateType } = memberLicense(user, asOf);
  return !!licenseNumber.trim() && !!certificateType.trim();
}
export const isTaskClosed = (t: Pick<TaskCard, "status">) =>
  t.status === "completed" || t.status === "canceled";
export function taskWritable(s: Snapshot, t: TaskCard) {
  const order = t.workOrderUuid
    ? s.workOrders?.find((w) => w.uuid === t.workOrderUuid)
    : undefined;
  return (
    can(s, t.aircraftUuid, "maintenance") &&
    !s.archivedTaskCards?.some((card) => card.uuid === t.uuid) &&
    !isTaskClosed(t) &&
    (!t.workOrderUuid || (!!order && isOpenWorkOrder(order)))
  );
}
// Evidence is part of what was signed; it can be removed only before any signoff.
export const evidenceRemovable = (s: Snapshot, t: TaskCard) =>
  taskWritable(s, t) && !t.technicianSignoff && !t.inspectionSignoff;
export function canUnlinkTaskCard(s: Snapshot, card: TaskCard, link: TaskLink) {
  return (
    taskWritable(s, card) &&
    link.kind !== "workOrder" &&
    !card.workOrderUuid &&
    !card.sourceTaskCardUuid &&
    card[linkField[link.kind]] === link.uuid &&
    !hasTaskExecution(card) &&
    !card.technicianSignoff &&
    !card.inspectionSignoff &&
    !Object.keys(card.stepSignoffs).length
  );
}
export function taskCardDefaults(aircraftUuid: string): TaskCardFields {
  return {
    aircraftUuid,
    cardNumber: "",
    title: "",
    workOrderUuid: "",
    inspectionUuid: "",
    componentUuid: "",
    requirementUuid: "",
    discrepancyUuid: "",
    description: "",
    includeInLogbook: false,
    logbookPhrase: "Performed",
    maintenanceReference: "",
    referenceRevision: "",
    referenceDate: "",
    applicability: "",
    steps: [],
    assignedTechnician: "",
    estimatedLabor: null,
    requiredParts: "",
    requiredTools: "",
    prerequisiteUuids: [],
    prerequisites: "",
    findings: "",
    actualWork: "",
    measurements: "",
    actualLabor: null,
    completionDate: "",
    partsUsed: [],
    inspectionSignoffRequired: false,
    functionalTestRequired: false,
    functionalTestOutcome: "not-required",
    functionalTestResults: "",
    status: "draft",
  };
}
export function applyTaskLink(
  s: Snapshot,
  fields: TaskCardFields,
  link: TaskLink,
): TaskCardFields {
  const next = { ...fields, [linkField[link.kind]]: link.uuid };
  if (link.kind === "inspection") {
    const i = s.inspections.find((i) => i.uuid === link.uuid);
    next.title ||= i ? `${i.reference}: ${i.description}` : "";
    next.ataChapter ??= i?.ataChapter;
    next.manualReference ??= i?.manualReference;
    next.componentUuid ||= i?.componentUuid ?? "";
  } else if (link.kind === "discrepancy")
    next.title ||=
      s.discrepancies.find((d) => d.uuid === link.uuid)?.description ?? "";
  else if (link.kind === "componentRequirement") {
    const r = s.management?.find(
      (r) => r.kind === "componentRequirement" && r.uuid === link.uuid,
    );
    if (r?.kind === "componentRequirement") {
      next.title ||= r.description;
      next.manualReference ??= r.manualReference;
      next.componentUuid ||= r.componentUuid;
    }
  }
  return next;
}
function validateLinks(s: Snapshot, f: TaskCardFields, prior?: TaskCard) {
  if (
    JSON.stringify(f.manualReference) !== JSON.stringify(prior?.manualReference)
  )
    validateManualReference(s, f.manualReference);
  if (
    prior &&
    isTaskTemplate(prior) &&
    (f.workOrderUuid ||
      (prior.inspectionUuid && f.inspectionUuid !== prior.inspectionUuid) ||
      (prior.requirementUuid && f.requirementUuid !== prior.requirementUuid) ||
      (prior.discrepancyUuid && f.discrepancyUuid !== prior.discrepancyUuid))
  )
    throw new Error(
      "Keep the reusable job card template attached to its source. Add the source to a work order to create an independent job card.",
    );
  if (
    prior?.sourceTaskCardUuid &&
    (f.inspectionUuid !== prior.inspectionUuid ||
      f.requirementUuid !== prior.requirementUuid ||
      f.discrepancyUuid !== prior.discrepancyUuid ||
      f.componentUuid !== prior.componentUuid)
  )
    throw new Error("A work-order copy must keep its source links.");
  if (prior?.workOrderUuid && f.workOrderUuid !== prior.workOrderUuid)
    throw new Error("A saved work order link cannot be changed.");
  if (f.workOrderUuid) {
    const w = s.workOrders?.find((w) => w.uuid === f.workOrderUuid);
    if (!w || w.aircraftUuid !== f.aircraftUuid || !isOpenWorkOrder(w))
      throw new Error("Select an open work order for this aircraft.");
  }
  if (f.inspectionUuid && f.inspectionUuid !== prior?.inspectionUuid) {
    const i = s.inspections.find((i) => i.uuid === f.inspectionUuid);
    if (!i || i.aircraftUuid !== f.aircraftUuid || i.archived)
      throw new Error("Inspection is unavailable for this aircraft.");
  }
  if (f.discrepancyUuid && f.discrepancyUuid !== prior?.discrepancyUuid) {
    const d = s.discrepancies.find((d) => d.uuid === f.discrepancyUuid);
    if (!d || d.aircraftUuid !== f.aircraftUuid || d.status !== "open")
      throw new Error("Discrepancy is unavailable for this aircraft.");
  }
  if (f.componentUuid && f.componentUuid !== prior?.componentUuid) {
    const c = s.management?.find(
      (c) => c.kind === "component" && c.uuid === f.componentUuid,
    );
    if (
      c?.kind !== "component" ||
      c.aircraftUuid !== f.aircraftUuid ||
      !c.installed
    )
      throw new Error("Component must be installed on this aircraft.");
  }
  if (f.requirementUuid) {
    const r = s.management?.find(
      (r) => r.kind === "componentRequirement" && r.uuid === f.requirementUuid,
    );
    if (
      f.requirementUuid !== prior?.requirementUuid ||
      f.componentUuid !== prior?.componentUuid
    ) {
      if (
        r?.kind !== "componentRequirement" ||
        r.componentUuid !== f.componentUuid
      )
        throw new Error(
          "Service requirement must belong to the linked component.",
        );
    }
  }
}
function validateStep(step: TaskStep) {
  if (!step.result.trim()) throw new Error("Record a result for every step.");
  if (
    step.measurementRequired ||
    step.lowerLimit !== null ||
    step.upperLimit !== null
  ) {
    if (step.measurement === null || !step.units)
      throw new Error("Record required step measurements and units.");
  }
  if (
    step.measurement !== null &&
    ((step.lowerLimit !== null && step.measurement < step.lowerLimit) ||
      (step.upperLimit !== null && step.measurement > step.upperLimit))
  )
    throw new Error("A step measurement is outside its limits.");
}
/** Template steps copied onto a new job card. Steps are retired: they stay
 * readable as instructions but are never signoff points. */
export const copyTemplateSteps = (steps: TaskStep[]): TaskStep[] =>
  steps.map((step) => ({
    ...step,
    uuid: crypto.randomUUID(),
    result: "",
    measurement: null,
    signoffRequired: false,
  }));
function validateExecution(f: TaskCardFields, now: number) {
  if (!f.completionDate || f.completionDate > latestLocalDate(now))
    throw new Error(
      "Enter a completion date (today or earlier) before signing or completing this job card.",
    );
}
export function saveTaskCard(
  s: Snapshot,
  raw: TaskCardCommand,
  now = Date.now(),
): TaskCard {
  const c = taskCardCommandSchema.parse(raw);
  if (s.archivedTaskCards?.some((card) => card.uuid === c.uuid))
    throw new Error("Archived job cards are read-only.");
  const prior = s.taskCards?.find((t) => t.uuid === c.uuid);
  const aircraftUuid =
    c.action === "save" ? c.fields.aircraftUuid : prior?.aircraftUuid;
  if (!aircraftUuid || !can(s, aircraftUuid, "maintenance"))
    throw new Error("Job card maintenance access denied.");
  if (prior && prior.aircraftUuid !== aircraftUuid)
    throw new Error("A job card cannot change aircraft.");
  if ((prior?.version ?? 0) !== c.version)
    throw new Error("Job card changed. Reopen it before saving.");
  if (prior && !taskWritable(s, prior))
    throw new Error("This job card or its work order is closed.");
  if (!prior && c.action !== "save") throw new Error("Job card not found.");
  let next: TaskCard;
  if (c.action === "sign") {
    if (isTaskTemplate(prior!))
      throw new Error(
        "Sign the work-order job card, not the reusable template.",
      );
    if (prior!.status === "draft")
      throw new Error("Make the task ready before signing.");
    const signature = { userId: s.user.id, name: s.user.name, at: now };
    next = { ...prior!, stepSignoffs: { ...prior!.stepSignoffs } };
    if (c.kind === "step") {
      const step = prior!.steps.find((step) => step.uuid === c.stepUuid);
      if (!step || !step.signoffRequired)
        throw new Error("Select a required step signoff point.");
      validateStep(step);
      next.stepSignoffs[step.uuid] = signature;
      next.technicianSignoff = null;
      next.inspectionSignoff = null;
    } else {
      validateExecution(prior!, now);
      // Previously recorded steps are history, not a signoff prerequisite.
      if (c.kind === "technician") {
        next.technicianSignoff = signature;
        next.inspectionSignoff = null;
      } else {
        if (!prior!.technicianSignoff)
          throw new Error(
            "Technician signoff is required before inspection signoff.",
          );
        if (prior!.technicianSignoff?.userId === s.user.id)
          throw new Error(
            "Inspection signoff must be by a different person than the technician.",
          );
        if (!hasInspectorCertificate(s.user, latestLocalDate(now)))
          throw new Error(inspectorCertificateRequired);
        next.inspectionSignoff = signature;
      }
    }
  } else if (c.action === "unlink") {
    if (!canUnlinkTaskCard(s, prior!, c.link))
      throw new Error(
        "Only unsigned job cards without recorded work or a work-order link can be removed from this item.",
      );
    next = { ...prior!, [linkField[c.link.kind]]: "" };
  } else {
    let f =
      c.action === "save"
        ? c.fields
        : applyTaskLink(s, taskCardFieldsSchema.parse(prior), c.link);
    if (
      c.action === "link" &&
      prior![linkField[c.link.kind]] &&
      prior![linkField[c.link.kind]] !== c.link.uuid
    )
      throw new Error(
        "This job card is already linked to another record of this type.",
      );
    if (
      isTaskTemplate(f) &&
      (!["draft", "canceled"].includes(f.status) || hasTaskExecution(f))
    )
      throw new Error(
        "Reusable templates contain instructions only. Record work results and completion on a work-order job card.",
      );
    validateLinks(s, f, prior);
    const owner = s.aircraft.find((a) => a.uuid === aircraftUuid)?.programUuid;
    for (const part of f.partsUsed) {
      if (part.source !== "stock") {
        if (part.stockUuid || part.locationUuid)
          throw new Error("Non-stock parts cannot link to inventory.");
        continue;
      }
      const stock = s.management?.find(
        (r) => r.kind === "stock" && r.uuid === part.stockUuid,
      );
      const location = s.management?.find(
        (r) => r.kind === "location" && r.uuid === part.locationUuid,
      );
      if (
        !stock ||
        stock.kind !== "stock" ||
        !location ||
        stock.locationUuid !== location.uuid ||
        recordProgram(s, stock) !== owner ||
        recordProgram(s, location) !== owner
      )
        throw new Error(
          "Select a stock item and its inventory location in this aircraft’s Flight Program.",
        );
      if (part.partNumber !== stock.partNumber)
        throw new Error("The part number must match the selected stock item.");
      // Expired stock cannot be issued, so it cannot be newly linked as a part
      // used. A lot linked before it expired stays, so the card can still be
      // edited, signed and completed.
      const linked = prior?.partsUsed.some(
        (p) =>
          p.uuid === part.uuid &&
          p.source === "stock" &&
          p.stockUuid === part.stockUuid,
      );
      if (!linked && expiredForUse(stock.expirationDate, now))
        throw new Error(
          `${stock.partNumber} expired on ${stock.expirationDate}. Expired stock cannot be linked as a part used; choose another lot or record a non-stock item.`,
        );
    }

    if (
      !prior &&
      f.sourceKey &&
      s.taskCards?.some(
        (t) =>
          t.sourceKey === f.sourceKey &&
          t.aircraftUuid === f.aircraftUuid &&
          t.inspectionUuid === f.inspectionUuid &&
          t.requirementUuid === f.requirementUuid &&
          t.workOrderUuid === f.workOrderUuid,
      )
    )
      throw new Error(
        "This CSV task has already been imported for this parent record.",
      );
    if (!prior && f.status !== "draft")
      throw new Error("New job cards must start as draft.");
    if (f.completionDate && f.completionDate > latestLocalDate(now))
      throw new Error("Completion date cannot be in the future.");
    if (
      new Set(f.steps.map((x) => x.uuid)).size !== f.steps.length ||
      new Set(f.partsUsed.map((x) => x.uuid)).size !== f.partsUsed.length
    )
      throw new Error("Step and parts identifiers must be unique.");
    for (const step of f.steps)
      if (
        step.lowerLimit !== null &&
        step.upperLimit !== null &&
        step.lowerLimit > step.upperLimit
      )
        throw new Error("A step lower limit cannot exceed its upper limit.");
    if (new Set(f.prerequisiteUuids).size !== f.prerequisiteUuids.length)
      throw new Error("Prerequisites must be unique.");
    for (const id of f.prerequisiteUuids) {
      const dependency = s.taskCards?.find((t) => t.uuid === id);
      if (
        dependency &&
        ((isTaskTemplate(f) && !isTaskTemplate(dependency)) ||
          (f.workOrderUuid && dependency.workOrderUuid !== f.workOrderUuid))
      )
        throw new Error(
          "Prerequisites must be templates for a template, or job cards on the same work order.",
        );
      if (
        id === c.uuid ||
        !dependency ||
        dependency.aircraftUuid !== aircraftUuid
      )
        throw new Error(
          "Prerequisites must be other job cards for this aircraft.",
        );
      const reaches = (uuid: string, seen = new Set<string>()): boolean => {
        if (uuid === c.uuid) return true;
        if (seen.has(uuid)) return false;
        seen.add(uuid);
        return (
          s.taskCards?.find((t) => t.uuid === uuid)?.prerequisiteUuids ?? []
        ).some((p) => reaches(p, seen));
      };
      if (reaches(id))
        throw new Error("Task prerequisites cannot form a cycle.");
    }
    const programUuid = s.aircraft.find(
      (a) => a.uuid === aircraftUuid,
    )!.programUuid;
    const cards = (s.taskCards ?? []).filter(
      (t) =>
        s.aircraft.find((a) => a.uuid === t.aircraftUuid)?.programUuid ===
        programUuid,
    );
    let cardNumber = f.cardNumber || prior?.cardNumber;
    if (!cardNumber) {
      let n = 1;
      do {
        cardNumber = `TC-${new Date(now).getUTCFullYear()}-${String(n++).padStart(4, "0")}`;
      } while (
        cards.some(
          (t) => t.cardNumber.toLowerCase() === cardNumber!.toLowerCase(),
        )
      );
    }
    if (
      cards.some(
        (t) =>
          t.uuid !== c.uuid &&
          t.cardNumber.toLowerCase() === cardNumber.toLowerCase(),
      )
    )
      throw new Error("Card number already exists in this program.");
    f = { ...f, cardNumber };
    const priorFields = prior ? taskCardFieldsSchema.parse(prior) : undefined;
    // Status changes do not alter signed work. Any other edit invalidates signatures.
    const changed =
      !priorFields ||
      JSON.stringify({ ...priorFields, status: f.status }) !==
        JSON.stringify(f);
    next = {
      ...f,
      sourceTaskCardUuid: prior?.sourceTaskCardUuid,
      sourceTaskCardVersion: prior?.sourceTaskCardVersion,
      workTaskUuid: prior?.workTaskUuid,
      uuid: c.uuid,
      version: c.version,
      createdAt: prior?.createdAt ?? now,
      createdBy: prior?.createdBy ?? s.user.id,
      updatedAt: now,
      technicianSignoff: changed ? null : prior!.technicianSignoff,
      inspectionSignoff: changed ? null : prior!.inspectionSignoff,
      stepSignoffs: changed ? {} : prior!.stepSignoffs,
    };
    if (f.status === "completed") {
      const missing: string[] = [];
      try {
        validateExecution(f, now);
      } catch (error) {
        missing.push(
          error instanceof Error
            ? error.message
            : "Enter a valid completion date.",
        );
      }
      if (!next.technicianSignoff)
        missing.push(
          "Save the work, then record technician signoff before completing.",
        );
      if (f.inspectionSignoffRequired && !next.inspectionSignoff)
        missing.push(
          "Record the required inspection signoff before completing.",
        );
      if (missing.length) throw new Error(missing.join("\n"));
    }
  }
  next = taskCardSchema.parse({
    ...next,
    updatedAt: now,
    version: c.version + 1,
  });
  s.taskCards = [
    ...(s.taskCards ?? []).filter((t) => t.uuid !== next.uuid),
    next,
  ];
  return next;
}
