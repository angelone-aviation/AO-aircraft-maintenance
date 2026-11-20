/**
 * Responsibility: Job cards: their stored shape, who may write, sign, link or
 *   unlink them and which cards, links and signoffs the screens offer, and
 *   the one command that saves, signs, links or unlinks one, with its
 *   change-log entry.
 * Layer: Domain. Pure functions and zod schemas; no I/O, no React (a `now`
 *   left to its default reads the clock).
 * Dependencies: zod; ./logbookWording, ./programs, ./manuals, ./model,
 *   ./certifications, ./ata, ./workOrders, ./shelfLife, ./management (types),
 *   ./commandRequest, ./rejection, ./changeLog.
 */
import { logbookSelectionFields } from "./logbookWording";
import { recordProgram } from "./programs";
import { manualReferenceSchema, validateManualReference } from "./manuals";
import { z } from "zod";
import { can, latestLocalDate, type Member, type Snapshot } from "./model";
import { certificateOptions, memberLicense } from "./certifications";
import { ataChapterSchema } from "./ata";
import { isOpenWorkOrder } from "./workOrders";
import { expiredForUse } from "./shelfLife";
import type { Stock } from "./management";
import { requestUuidField } from "./commandRequest";
import { Rejection } from "./rejection";
import { auditEntry } from "./changeLog";

/**
 * The most characters a job card's text fields hold, such as its title,
 * description and applicability.
 */
export const TASK_TEXT_MAX_LENGTH = 10000;
/** The longest card number. */
export const CARD_NUMBER_MAX_LENGTH = 100;
// The text fields that record work results, which a template never holds.
const RESULT_TEXT_FIELDS = [
  "findings",
  "actualWork",
  "measurements",
  "functionalTestResults",
] as const;

const text = z.string().trim().max(TASK_TEXT_MAX_LENGTH);
const optionalId = z.string().max(200);
const number = z.number().finite();
const date = z.union([z.iso.date(), z.literal("")]);

/** A job card's statuses, in the order work moves through them. */
export const taskCardStatuses = [
  "draft",
  "ready",
  "in-progress",
  "awaiting-parts",
  "awaiting-inspection",
  "completed",
  "canceled",
] as const;
type TaskStatus = (typeof taskCardStatuses)[number];
// A template is never worked, so it is only ever a draft or canceled.
const TEMPLATE_STATUSES: readonly TaskStatus[] = ["draft", "canceled"];

/** The kinds of evidence a job card's attachments are filed under. */
export const evidenceCategories = [
  "photo",
  "supporting-document",
  "parts-traceability",
] as const;

/**
 * A link from a job card to the record it does the work for.
 *
 * @throws {z.ZodError} From `parse()` on an unknown kind or an empty uuid.
 */
export const taskLinkSchema = z.object({
  kind: z.enum([
    "inspection",
    "componentRequirement",
    "discrepancy",
    "workOrder",
  ]),
  uuid: z.string().min(1).max(200),
});
/** A parsed job card link. */
export type TaskLink = z.infer<typeof taskLinkSchema>;

/** The job card field that holds each kind of link. */
export const linkField = {
  inspection: "inspectionUuid",
  componentRequirement: "requirementUuid",
  discrepancy: "discrepancyUuid",
  workOrder: "workOrderUuid",
} as const;
/** A job card field that links it to another record. */
export type TaskLinkField =
  (typeof linkField)[TaskLink["kind"]] | "componentUuid";

const signatureSchema = z.object({
  userId: z.string(),
  name: z.string(),
  at: z.number(),
});

/**
 * One step of a job card: an instruction, its result and measurement, and
 * the limits the measurement must fall within.
 *
 * @throws {z.ZodError} From `parse()` on a missing or invalid field.
 */
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

/**
 * The fields of a job card a user edits: its links, instructions, steps,
 * recorded work, parts used, prerequisites and status.
 *
 * @throws {z.ZodError} From `parse()` on a missing or invalid field.
 */
export const taskCardFieldsSchema = z.object({
  ...logbookSelectionFields,
  itemCode: z.string().max(100).optional(),
  sourceKey: z.string().max(300).optional(),
  aircraftUuid: z.string().min(1).max(200),
  cardNumber: z.string().trim().max(CARD_NUMBER_MAX_LENGTH),
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
type CardLinks = Pick<
  TaskCardFields,
  "workOrderUuid" | "inspectionUuid" | "requirementUuid" | "discrepancyUuid"
>;

/**
 * A stored job card: its fields, identity, the template it was copied from,
 * and its technician, inspection and step signoffs.
 *
 * @throws {z.ZodError} From `parse()` on a missing or invalid field.
 */
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
/** A parsed job card. */
export type TaskCard = z.infer<typeof taskCardSchema>;
/** A parsed job card's editable fields. */
export type TaskCardFields = z.infer<typeof taskCardFieldsSchema>;
/** One step of a job card. */
export type TaskStep = TaskCardFields["steps"][number];
/** One part used on a job card. */
export type TaskPart = TaskCardFields["partsUsed"][number];

/**
 * The commands {@link saveTaskCard} runs, by `action`: save the fields, link
 * or unlink a record, or sign as technician, inspector or for a step; each
 * may carry its request id.
 *
 * @throws {z.ZodError} From `parse()` on an unknown action or invalid field.
 */
export const taskCardCommandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save"),
    uuid: z.string().uuid(),
    version: z.number().int().nonnegative(),
    ...requestUuidField,
    fields: taskCardFieldsSchema,
  }),
  z.object({
    action: z.literal("link"),
    uuid: z.string().uuid(),
    version: z.number().int().nonnegative(),
    ...requestUuidField,
    link: taskLinkSchema,
  }),
  z.object({
    action: z.literal("unlink"),
    uuid: z.string().uuid(),
    version: z.number().int().nonnegative(),
    ...requestUuidField,
    link: taskLinkSchema,
  }),
  z.object({
    action: z.literal("sign"),
    uuid: z.string().uuid(),
    version: z.number().int().nonnegative(),
    ...requestUuidField,
    kind: z.enum(["technician", "inspection", "step"]),
    stepUuid: z.string().uuid().optional(),
  }),
]);
/** A parsed job card command. */
export type TaskCardCommand = z.infer<typeof taskCardCommandSchema>;

/** A file attached to a job card as evidence of the work. */
export interface TaskEvidence {
  uuid: string;
  taskCardUuid: string;
  name: string;
  size: number;
  uploadedAt: number;
  /**
   * The demo's stored copy, as a data URL. The server sends no link: screens
   * open the file through Backend.fileLinks (docs/file-links.md).
   */
  url?: string;
  category: (typeof evidenceCategories)[number];
}

/**
 * Whether a card is a reusable template: linked to an inspection,
 * requirement or discrepancy but not to a work order.
 */
export function isTaskTemplate(t: CardLinks) {
  return (
    !t.workOrderUuid &&
    !!(t.inspectionUuid || t.requirementUuid || t.discrepancyUuid)
  );
}

/**
 * The statuses a card may be set to: a template only draft or canceled, a
 * job card any.
 *
 * @returns In the order work moves through them.
 */
export function taskStatusChoices(t: CardLinks): readonly TaskStatus[] {
  return isTaskTemplate(t) ? TEMPLATE_STATUSES : taskCardStatuses;
}

/**
 * Whether a field is one of the text results of the work (findings, actual
 * work, measurements, functional test results), which a template never holds.
 */
export function isResultTextField(field: keyof TaskCardFields) {
  return RESULT_TEXT_FIELDS.some((result) => result === field);
}

/** Whether any work has been recorded on a card: results, parts or a date. */
export function hasTaskExecution(t: TaskCardFields) {
  return (
    RESULT_TEXT_FIELDS.some((field) => t[field]) ||
    t.actualLabor !== null ||
    !!t.completionDate ||
    t.partsUsed.length > 0 ||
    ["pass", "fail"].includes(t.functionalTestOutcome) ||
    t.steps.some((step) => step.result || step.measurement !== null)
  );
}

/** The refusal shown to an inspector with no certificate on file. */
export const inspectorCertificateRequired =
  "Add your certificate type and number under My certifications to sign as inspector.";
/**
 * The refusal shown to an inspector whose certificate on file is not a
 * maintenance one.
 */
export const inspectorMaintenanceCertificateRequired =
  "Add a mechanic, repairman or inspection authorization certificate under My certifications to sign as inspector.";
/**
 * What a member's certificates change in the app, in the words Settings and
 * the My certifications form use; {@link inspectorCertificateProblem} is the
 * rule it states.
 */
export const certificationsEffect =
  "Recording a job card's inspection signoff needs a numbered mechanic certificate on file, issued on or before the day of the signoff; a pilot certificate is not enough. Certifications grant no other permission.";
// Free-text certificate types on the older single-license profile fields that
// name a mechanic (A&P, airframe, powerplant), inspection authorization or
// repairman certificate. Pilot and unrecognized types (e.g. AME, CRS) do not.
const maintenanceCertificateType =
  /\b(a\s*(&|\/|and)\s*p|airframe|power\s*plant|mechanic|ia|inspection\s+authori[sz]ation|repairman)\b/i;
type CertificateHolder = Pick<
  Member,
  "certifications" | "licenseNumber" | "certificateType"
>;
type Signer = CertificateHolder & Pick<Member, "id">;
type SignoffState = Pick<
  TaskCard,
  "status" | "technicianSignoff" | "inspectionSignoff"
>;
/**
 * Why `user` cannot record an inspection signoff, or undefined if they can.
 * The inspection signoff is the 14 CFR 43.7 person's signature, so it needs
 * a numbered maintenance certificate on file (ADR-0004); a pilot certificate
 * is not enough. Technician signoffs stay open: 43.3(d) lets supervised
 * uncertificated workers perform work.
 *
 * @param asOf - The local date the certificate must be held on.
 * @returns {@link inspectorMaintenanceCertificateRequired} when a certificate
 *   on file is not a maintenance one, else
 *   {@link inspectorCertificateRequired}.
 */
export function inspectorCertificateProblem(
  user: CertificateHolder,
  asOf: string,
) {
  const eligible =
    user.certifications === undefined
      ? !!user.licenseNumber?.trim() &&
        maintenanceCertificateType.test(user.certificateType ?? "")
      : // Airframe, powerplant and IA records are folded into "mechanic".
        certificateOptions(user, asOf).some((c) => c.key === "mechanic");
  if (eligible) return undefined;
  const { licenseNumber, certificateType } = memberLicense(user, asOf);
  return licenseNumber.trim() && certificateType.trim()
    ? inspectorMaintenanceCertificateRequired
    : inspectorCertificateRequired;
}

/** Whether `user` may record an inspection signoff on `asOf`. */
export const hasInspectorCertificate = (
  user: CertificateHolder,
  asOf: string,
) => !inspectorCertificateProblem(user, asOf);

/** Whether a card is completed or cancelled. */
export const isTaskClosed = (t: Pick<TaskCard, "status">) =>
  t.status === "completed" || t.status === "canceled";

/**
 * Whether the signed-in user may change a card: maintenance access to its
 * aircraft, and the card neither archived, closed, nor on a work order that
 * is no longer open.
 */
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

/**
 * Whether a card's evidence may be removed: evidence is part of what was
 * signed, so only on a writable card before any signoff.
 */
export const evidenceRemovable = (s: Snapshot, t: TaskCard) =>
  taskWritable(s, t) && !t.technicianSignoff && !t.inspectionSignoff;

/**
 * Whether a card may be unlinked from a record: a writable card not on a
 * work order nor copied from a template, linked to that record, with no
 * recorded work and no signoff.
 */
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

/**
 * The cards a record lists: a work order's job cards, or the templates
 * linked to an inspection, service requirement or discrepancy.
 *
 * @param aircraftUuid - The record's aircraft; only its cards are listed.
 * @returns In snapshot order.
 */
export function linkedTaskCards(
  s: Snapshot,
  aircraftUuid: string,
  link: TaskLink,
): TaskCard[] {
  return (s.taskCards ?? []).filter(
    (t) =>
      t.aircraftUuid === aircraftUuid &&
      t[linkField[link.kind]] === link.uuid &&
      (link.kind === "workOrder" || !t.workOrderUuid),
  );
}

/**
 * The cards a record offers to link: the aircraft's writable cards with no
 * record of that kind yet. A work order takes job cards, never templates;
 * any other record takes cards that are not on a work order.
 *
 * @returns In snapshot order.
 */
export function linkableTaskCards(
  s: Snapshot,
  aircraftUuid: string,
  link: TaskLink,
): TaskCard[] {
  return (s.taskCards ?? []).filter(
    (t) =>
      t.aircraftUuid === aircraftUuid &&
      !t[linkField[link.kind]] &&
      (link.kind === "workOrder" ? !isTaskTemplate(t) : !t.workOrderUuid) &&
      taskWritable(s, t),
  );
}

/**
 * Whether the user may change which cards a record links: maintenance access
 * to its aircraft and, for a work order, the order still open.
 */
export function taskLinksWritable(
  s: Snapshot,
  aircraftUuid: string,
  link: TaskLink,
) {
  return (
    can(s, aircraftUuid, "maintenance") &&
    (link.kind !== "workOrder" ||
      !!s.workOrders?.some((w) => w.uuid === link.uuid && isOpenWorkOrder(w)))
  );
}

/**
 * Whether the editor keeps a saved card's link as it is: a work-order copy
 * keeps every link, and a template its empty work order and each record it
 * was saved with. A new card keeps none.
 */
export function taskLinkLocked(
  card: TaskCard | undefined,
  field: TaskLinkField,
) {
  if (!card) return false;
  if (card.sourceTaskCardUuid) return true;
  return isTaskTemplate(card) && (field === "workOrderUuid" || !!card[field]);
}

/**
 * The signoffs the job card lists offer on a card, each only once the card is
 * past draft and until it is signed: inspection after the technician's, to a
 * different person with a maintenance certificate.
 *
 * @param card - A job card; a template takes no signoffs, unchecked here.
 * @param asOf - The local date the inspector's certificate must be held on.
 * @returns Whether each signoff is offered, before connection and access.
 */
export function signoffsOfferedInList(
  card: SignoffState,
  user: Signer,
  asOf: string,
) {
  const ready = card.status !== "draft";
  return {
    technician: ready && !card.technicianSignoff,
    inspection:
      ready && !card.inspectionSignoff && inspectorMaySign(card, user, asOf),
  };
}

/**
 * The signoffs the card editor offers, each again after it is signed:
 * technician once the card is past draft; inspection, in any status, after
 * the technician's, to a different person with a maintenance certificate.
 * So on a draft card that kept its technician signoff, the editor offers an
 * inspection signoff that {@link saveTaskCard} refuses and the lists do not.
 *
 * @param card - A job card; a template takes no signoffs, unchecked here.
 * @param asOf - The local date the inspector's certificate must be held on.
 * @returns Whether each signoff is offered, before connection and access.
 */
export function signoffsOfferedInEditor(
  card: SignoffState,
  user: Signer,
  asOf: string,
) {
  return {
    technician: card.status !== "draft",
    inspection: inspectorMaySign(card, user, asOf),
  };
}

/** The fields of a new, empty draft job card for an aircraft. */
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

/**
 * The fields with a record linked, filling a blank title, ATA chapter,
 * manual reference and component from an inspection or requirement, and a
 * blank title from a discrepancy.
 */
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

/**
 * Template steps copied onto a new job card. Steps are retired: they stay
 * readable as instructions but are never signoff points.
 */
export const copyTemplateSteps = (steps: TaskStep[]): TaskStep[] =>
  steps.map((step) => ({
    ...step,
    uuid: crypto.randomUUID(),
    result: "",
    measurement: null,
    signoffRequired: false,
  }));

/**
 * Saves, signs, links or unlinks one job card, as the signed-in user.
 *
 * Editing anything but the status clears every signoff, because signed work
 * may not change under a signature. A step signoff clears the card's
 * technician and inspection signoffs. New cards are numbered
 * `TC-<year>-<nnnn>`, the first number free in the Flight Program.
 *
 * @param s - The snapshot; its job cards are replaced on success and
 *   untouched on a refusal.
 * @param now - The time to record; the clock by default.
 * @returns The card as saved, one version on.
 * @throws {Rejection} Every refusal of the command, checked in a fixed order;
 *   as {@link validateManualReference}.
 * @throws {Error} "Job card not found." for a sign, link or unlink of a card
 *   that does not exist, which the access check refuses first.
 * @throws {z.ZodError} On an invalid command or card.
 */
export function saveTaskCard(
  s: Snapshot,
  raw: TaskCardCommand,
  now = Date.now(),
): TaskCard {
  const c = taskCardCommandSchema.parse(raw);
  const prior = admittedPrior(s, c);
  const aircraftUuid =
    c.action === "save" ? c.fields.aircraftUuid : prior!.aircraftUuid;
  const draft =
    c.action === "sign"
      ? signTaskCard(s, c, prior!, now)
      : c.action === "unlink"
        ? unlinkTaskCard(s, c, prior!)
        : editTaskCard(s, c, prior, aircraftUuid, now);
  const next = taskCardSchema.parse({
    ...draft,
    updatedAt: now,
    version: c.version + 1,
  });
  s.taskCards = [
    ...(s.taskCards ?? []).filter((t) => t.uuid !== next.uuid),
    next,
  ];
  return next;
}

/**
 * Runs a job-card command the user sent, as {@link saveTaskCard}, and adds
 * its "taskCard.<action>" change-log entry with the card before and after.
 * Work orders, template activation and CSV imports save cards through
 * saveTaskCard and log for themselves.
 *
 * @returns The card as saved.
 * @throws As {@link saveTaskCard}.
 */
export function applyTaskCardCommand(
  s: Snapshot,
  raw: TaskCardCommand,
  now = Date.now(),
): TaskCard {
  const before = s.taskCards?.find((t) => t.uuid === raw.uuid);
  const next = saveTaskCard(s, raw, now);
  s.audit.unshift(
    auditEntry(
      s,
      {
        action: "taskCard." + raw.action,
        entityUuid: next.uuid,
        aircraftUuid: next.aircraftUuid,
        before,
        after: next,
      },
      now,
    ),
  );
  return next;
}

type SignCommand = Extract<TaskCardCommand, { action: "sign" }>;
type UnlinkCommand = Extract<TaskCardCommand, { action: "unlink" }>;
type EditCommand = Extract<TaskCardCommand, { action: "save" | "link" }>;
type Signature = NonNullable<TaskCard["technicianSignoff"]>;

// The checks every job card command passes before its action runs.
function admittedPrior(s: Snapshot, c: TaskCardCommand) {
  if (s.archivedTaskCards?.some((card) => card.uuid === c.uuid))
    throw new Rejection("Archived job cards are read-only.");
  const prior = s.taskCards?.find((t) => t.uuid === c.uuid);
  const aircraftUuid =
    c.action === "save" ? c.fields.aircraftUuid : prior?.aircraftUuid;
  if (!aircraftUuid || !can(s, aircraftUuid, "maintenance"))
    throw new Rejection("Job card maintenance access denied.");
  if (prior && prior.aircraftUuid !== aircraftUuid)
    throw new Rejection("A job card cannot change aircraft.");
  if ((prior?.version ?? 0) !== c.version)
    throw new Rejection("Job card changed. Reopen it before saving.");
  if (prior && !taskWritable(s, prior))
    throw new Rejection("This job card or its work order is closed.");
  if (!prior && c.action !== "save") throw new Error("Job card not found.");
  return prior;
}

function signTaskCard(
  s: Snapshot,
  c: SignCommand,
  prior: TaskCard,
  now: number,
): TaskCard {
  if (isTaskTemplate(prior))
    throw new Rejection(
      "Sign the work-order job card, not the reusable template.",
    );
  if (prior.status === "draft")
    throw new Rejection("Make the task ready before signing.");
  const signature = { userId: s.user.id, name: s.user.name, at: now };
  const next = { ...prior, stepSignoffs: { ...prior.stepSignoffs } };
  if (c.kind === "step") return signStep(next, c.stepUuid, signature);
  validateExecution(prior, now);
  // Previously recorded steps are history, not a signoff prerequisite.
  if (c.kind === "technician")
    return { ...next, technicianSignoff: signature, inspectionSignoff: null };
  assertInspector(s, prior, now);
  return { ...next, inspectionSignoff: signature };
}

function signStep(
  next: TaskCard,
  stepUuid: string | undefined,
  signature: Signature,
): TaskCard {
  const step = next.steps.find((step) => step.uuid === stepUuid);
  if (!step || !step.signoffRequired)
    throw new Rejection("Select a required step signoff point.");
  validateStep(step);
  next.stepSignoffs[step.uuid] = signature;
  return { ...next, technicianSignoff: null, inspectionSignoff: null };
}

// The inspection signoff is the 14 CFR 43.7 approval: a second, certificated
// person after the technician.
function assertInspector(s: Snapshot, prior: TaskCard, now: number) {
  if (!prior.technicianSignoff)
    throw new Rejection(
      "Technician signoff is required before inspection signoff.",
    );
  if (prior.technicianSignoff.userId === s.user.id)
    throw new Rejection(
      "Inspection signoff must be by a different person than the technician.",
    );
  const certificate = inspectorCertificateProblem(s.user, latestLocalDate(now));
  if (certificate) throw new Rejection(certificate);
}

// What assertInspector checks, offered as a button rather than refused.
function inspectorMaySign(card: SignoffState, user: Signer, asOf: string) {
  return (
    !!card.technicianSignoff &&
    card.technicianSignoff.userId !== user.id &&
    !inspectorCertificateProblem(user, asOf)
  );
}

function unlinkTaskCard(
  s: Snapshot,
  c: UnlinkCommand,
  prior: TaskCard,
): TaskCard {
  if (!canUnlinkTaskCard(s, prior, c.link))
    throw new Rejection(
      "Only unsigned job cards without recorded work or a work-order link can be removed from this item.",
    );
  return { ...prior, [linkField[c.link.kind]]: "" };
}

function editTaskCard(
  s: Snapshot,
  c: EditCommand,
  prior: TaskCard | undefined,
  aircraftUuid: string,
  now: number,
): TaskCard {
  const fields =
    c.action === "save"
      ? c.fields
      : applyTaskLink(s, taskCardFieldsSchema.parse(prior), c.link);
  if (c.action === "link") assertLinkFree(prior!, c.link);
  if (
    isTaskTemplate(fields) &&
    (!taskStatusChoices(fields).includes(fields.status) ||
      hasTaskExecution(fields))
  )
    throw new Rejection(
      "Reusable templates contain instructions only. Record work results and completion on a work-order job card.",
    );
  validateLinks(s, fields, prior);
  const owner = s.aircraft.find((a) => a.uuid === aircraftUuid)?.programUuid;
  for (const part of fields.partsUsed)
    validatePartUsed(s, part, prior, owner, now);
  validateContent(s, fields, prior, now);
  validatePrerequisites(s, c.uuid, fields, aircraftUuid);
  const cardNumber = assignCardNumber(s, c.uuid, fields, prior, now);
  const f = { ...fields, cardNumber };
  const next = withSignoffs(s, c, f, prior, now);
  if (f.status === "completed") assertCompletable(f, next, now);
  return next;
}

function assertLinkFree(prior: TaskCard, link: TaskLink) {
  const linked = prior[linkField[link.kind]];
  if (linked && linked !== link.uuid)
    throw new Rejection(
      "This job card is already linked to another record of this type.",
    );
}

function validateLinks(s: Snapshot, f: TaskCardFields, prior?: TaskCard) {
  if (
    JSON.stringify(f.manualReference) !== JSON.stringify(prior?.manualReference)
  )
    validateManualReference(s, f.manualReference);
  assertSourceLinksKept(f, prior);
  if (f.workOrderUuid) {
    const w = s.workOrders?.find((w) => w.uuid === f.workOrderUuid);
    if (!w || w.aircraftUuid !== f.aircraftUuid || !isOpenWorkOrder(w))
      throw new Rejection("Select an open work order for this aircraft.");
  }
  if (f.inspectionUuid && f.inspectionUuid !== prior?.inspectionUuid) {
    const i = s.inspections.find((i) => i.uuid === f.inspectionUuid);
    if (!i || i.aircraftUuid !== f.aircraftUuid || i.archived)
      throw new Rejection("Inspection is unavailable for this aircraft.");
  }
  if (f.discrepancyUuid && f.discrepancyUuid !== prior?.discrepancyUuid) {
    const d = s.discrepancies.find((d) => d.uuid === f.discrepancyUuid);
    if (!d || d.aircraftUuid !== f.aircraftUuid || d.status !== "open")
      throw new Rejection("Discrepancy is unavailable for this aircraft.");
  }
  assertComponentLinks(s, f, prior);
}

// A template stays on its source until a work order copies it; a copy keeps
// its source's links; a saved work-order link is permanent.
function assertSourceLinksKept(f: TaskCardFields, prior?: TaskCard) {
  if (
    prior &&
    isTaskTemplate(prior) &&
    (f.workOrderUuid ||
      (prior.inspectionUuid && f.inspectionUuid !== prior.inspectionUuid) ||
      (prior.requirementUuid && f.requirementUuid !== prior.requirementUuid) ||
      (prior.discrepancyUuid && f.discrepancyUuid !== prior.discrepancyUuid))
  )
    throw new Rejection(
      "Keep the reusable job card template attached to its source. Add the source to a work order to create an independent job card.",
    );
  if (
    prior?.sourceTaskCardUuid &&
    (f.inspectionUuid !== prior.inspectionUuid ||
      f.requirementUuid !== prior.requirementUuid ||
      f.discrepancyUuid !== prior.discrepancyUuid ||
      f.componentUuid !== prior.componentUuid)
  )
    throw new Rejection("A work-order copy must keep its source links.");
  if (prior?.workOrderUuid && f.workOrderUuid !== prior.workOrderUuid)
    throw new Rejection("A saved work order link cannot be changed.");
}

function assertComponentLinks(
  s: Snapshot,
  f: TaskCardFields,
  prior?: TaskCard,
) {
  if (f.componentUuid && f.componentUuid !== prior?.componentUuid) {
    const c = s.management?.find(
      (c) => c.kind === "component" && c.uuid === f.componentUuid,
    );
    if (
      c?.kind !== "component" ||
      c.aircraftUuid !== f.aircraftUuid ||
      !c.installed
    )
      throw new Rejection("Component must be installed on this aircraft.");
  }
  const relinked =
    f.requirementUuid !== prior?.requirementUuid ||
    f.componentUuid !== prior?.componentUuid;
  if (!f.requirementUuid || !relinked) return;
  const r = s.management?.find(
    (r) => r.kind === "componentRequirement" && r.uuid === f.requirementUuid,
  );
  if (r?.kind !== "componentRequirement" || r.componentUuid !== f.componentUuid)
    throw new Rejection(
      "Service requirement must belong to the linked component.",
    );
}

function validatePartUsed(
  s: Snapshot,
  part: TaskPart,
  prior: TaskCard | undefined,
  owner: string | undefined,
  now: number,
) {
  if (part.source !== "stock") {
    if (part.stockUuid || part.locationUuid)
      throw new Rejection("Non-stock parts cannot link to inventory.");
    return;
  }
  const stock = findStoredLot(s, part, owner);
  const recorded = prior?.partsUsed.find(
    (p) =>
      p.uuid === part.uuid &&
      p.source === "stock" &&
      p.stockUuid === part.stockUuid,
  );
  // A part keeps the number it was recorded with when its stock item's part
  // number is corrected later; only a number entered now must match the item.
  if (
    part.partNumber !== stock.partNumber &&
    part.partNumber !== recorded?.partNumber
  )
    throw new Rejection("The part number must match the selected stock item.");
  assertLinkableLot(stock, !!recorded, now);
}

function findStoredLot(
  s: Snapshot,
  part: TaskPart,
  owner: string | undefined,
): Stock {
  const stock = s.management?.find(
    (r): r is Stock => r.kind === "stock" && r.uuid === part.stockUuid,
  );
  const location = s.management?.find(
    (r) => r.kind === "location" && r.uuid === part.locationUuid,
  );
  if (
    !stock ||
    !location ||
    stock.locationUuid !== location.uuid ||
    recordProgram(s, stock) !== owner ||
    recordProgram(s, location) !== owner
  )
    throw new Rejection(
      "Select a stock item and its inventory location in this aircraft’s Flight Program.",
    );
  return stock;
}

// Expired stock cannot be issued, so it cannot be newly linked as a part used.
// A lot linked before it expired stays, so the card can still be edited,
// signed and completed.
function assertLinkableLot(stock: Stock, linked: boolean, now: number) {
  if (!linked && expiredForUse(stock.expirationDate, now))
    throw new Rejection(
      `${stock.partNumber} expired on ${stock.expirationDate}. Expired stock cannot be linked as a part used; choose another lot or record a non-stock item.`,
    );
}

function validateContent(
  s: Snapshot,
  f: TaskCardFields,
  prior: TaskCard | undefined,
  now: number,
) {
  if (!prior && f.sourceKey && isImported(s, f))
    throw new Rejection(
      "This CSV task has already been imported for this parent record.",
    );
  if (!prior && f.status !== "draft")
    throw new Rejection("New job cards must start as draft.");
  if (f.completionDate && f.completionDate > latestLocalDate(now))
    throw new Rejection("Completion date cannot be in the future.");
  if (
    new Set(f.steps.map((x) => x.uuid)).size !== f.steps.length ||
    new Set(f.partsUsed.map((x) => x.uuid)).size !== f.partsUsed.length
  )
    throw new Rejection("Step and parts identifiers must be unique.");
  const inverted = f.steps.some(
    (step) =>
      step.lowerLimit !== null &&
      step.upperLimit !== null &&
      step.lowerLimit > step.upperLimit,
  );
  if (inverted)
    throw new Rejection("A step lower limit cannot exceed its upper limit.");
}

// A CSV row is imported once per parent record.
function isImported(s: Snapshot, f: TaskCardFields) {
  return !!s.taskCards?.some(
    (t) =>
      t.sourceKey === f.sourceKey &&
      t.aircraftUuid === f.aircraftUuid &&
      t.inspectionUuid === f.inspectionUuid &&
      t.requirementUuid === f.requirementUuid &&
      t.workOrderUuid === f.workOrderUuid,
  );
}

function validatePrerequisites(
  s: Snapshot,
  uuid: string,
  f: TaskCardFields,
  aircraftUuid: string,
) {
  if (new Set(f.prerequisiteUuids).size !== f.prerequisiteUuids.length)
    throw new Rejection("Prerequisites must be unique.");
  for (const id of f.prerequisiteUuids)
    validatePrerequisite(s, uuid, f, aircraftUuid, id);
}

// A template's prerequisites are templates; a work-order card's are cards on
// the same order; none may lead back to the card.
function validatePrerequisite(
  s: Snapshot,
  uuid: string,
  f: TaskCardFields,
  aircraftUuid: string,
  id: string,
) {
  const dependency = s.taskCards?.find((t) => t.uuid === id);
  if (
    dependency &&
    ((isTaskTemplate(f) && !isTaskTemplate(dependency)) ||
      (f.workOrderUuid && dependency.workOrderUuid !== f.workOrderUuid))
  )
    throw new Rejection(
      "Prerequisites must be templates for a template, or job cards on the same work order.",
    );
  if (id === uuid || !dependency || dependency.aircraftUuid !== aircraftUuid)
    throw new Rejection(
      "Prerequisites must be other job cards for this aircraft.",
    );
  if (reaches(s, id, uuid))
    throw new Rejection("Task prerequisites cannot form a cycle.");
}

function reaches(
  s: Snapshot,
  from: string,
  target: string,
  seen = new Set<string>(),
): boolean {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return (
    s.taskCards?.find((t) => t.uuid === from)?.prerequisiteUuids ?? []
  ).some((p) => reaches(s, p, target, seen));
}

function assignCardNumber(
  s: Snapshot,
  uuid: string,
  f: TaskCardFields,
  prior: TaskCard | undefined,
  now: number,
) {
  const programUuid = s.aircraft.find(
    (a) => a.uuid === f.aircraftUuid,
  )!.programUuid;
  const cards = (s.taskCards ?? []).filter(
    (t) =>
      s.aircraft.find((a) => a.uuid === t.aircraftUuid)?.programUuid ===
      programUuid,
  );
  const cardNumber =
    f.cardNumber || prior?.cardNumber || firstFreeNumber(cards, now);
  if (cards.some((t) => t.uuid !== uuid && sameNumber(t, cardNumber)))
    throw new Rejection("Card number already exists in this program.");
  return cardNumber;
}

const sameNumber = (t: TaskCard, cardNumber: string) =>
  t.cardNumber.toLowerCase() === cardNumber.toLowerCase();

function firstFreeNumber(cards: TaskCard[], now: number) {
  const numbered = (n: number) =>
    `TC-${new Date(now).getUTCFullYear()}-${String(n).padStart(4, "0")}`;
  let n = 1;
  while (cards.some((t) => sameNumber(t, numbered(n)))) n++;
  return numbered(n);
}

// Status changes do not alter signed work; any other edit clears the
// signatures.
function withSignoffs(
  s: Snapshot,
  c: EditCommand,
  f: TaskCardFields,
  prior: TaskCard | undefined,
  now: number,
): TaskCard {
  const priorFields = prior ? taskCardFieldsSchema.parse(prior) : undefined;
  const changed =
    !priorFields ||
    JSON.stringify({ ...priorFields, status: f.status }) !== JSON.stringify(f);
  return {
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
}

function assertCompletable(f: TaskCardFields, next: TaskCard, now: number) {
  const missing = [
    completionDateProblem(f, now),
    !next.technicianSignoff &&
      "Save the work, then record technician signoff before completing.",
    f.inspectionSignoffRequired &&
      !next.inspectionSignoff &&
      "Record the required inspection signoff before completing.",
  ].filter(Boolean);
  if (missing.length) throw new Rejection(missing.join("\n"));
}

function validateExecution(f: TaskCardFields, now: number) {
  const problem = completionDateProblem(f, now);
  if (problem) throw new Rejection(problem);
}

function completionDateProblem(f: TaskCardFields, now: number) {
  if (!f.completionDate || f.completionDate > latestLocalDate(now))
    return "Enter a completion date (today or earlier) before signing or completing this job card.";
  return undefined;
}

function validateStep(step: TaskStep) {
  if (!step.result.trim())
    throw new Rejection("Record a result for every step.");
  const measured =
    step.measurementRequired ||
    step.lowerLimit !== null ||
    step.upperLimit !== null;
  if (measured && (step.measurement === null || !step.units))
    throw new Rejection("Record required step measurements and units.");
  if (
    step.measurement !== null &&
    ((step.lowerLimit !== null && step.measurement < step.lowerLimit) ||
      (step.upperLimit !== null && step.measurement > step.upperLimit))
  )
    throw new Rejection("A step measurement is outside its limits.");
}
