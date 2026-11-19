/**
 * Responsibility: Work orders: the stored record and its commands, the work
 *   items an aircraft offers, progress, attachment rules, and the applier
 *   every work-order command runs through (saveWorkOrder).
 * Layer: Domain. Zod schemas, rules and one applier; no I/O, no React.
 * Dependencies: zod, ./model, ./programs, ./components, ./adOwnership,
 *   ./airworthiness, ./changeLog, ./componentInventory, ./inventoryAttachments,
 *   ./logbookWording, ./rejection, ./taskCards (types) and the ./workOrder*
 *   modules.
 */
import { removedTaskCards } from "./workOrderTaskRemoval";
import { adAircraftUuid } from "./adOwnership";
import { isTrackedAD } from "./airworthiness";
import {
  componentCorrectionCommandSchema,
  componentCorrectionSchema,
  previewComponentCorrection,
} from "./workOrderComponentCorrections";
import {
  componentWorkDraftSchema,
  workOrderComponentIds,
} from "./workOrderComponentWork";
import { logbookSelectionFields } from "./logbookWording";
import {
  closeoutSchema,
  completionReadingsSchema,
} from "./workOrderCloseoutSchema";
import { completeWorkOrder, workPerformedText } from "./workOrderCloseout";
import {
  copyWorkOrderTemplates,
  isPreparingJobCards,
  taskCardMatchesWorkItem,
  workItemCompletionIssue,
} from "./workOrderCards";
import { z } from "zod";
import { recordProgram } from "./programs";
import { validateComponentLocation } from "./componentInventory";
import { MAX_ACTION_FILE_BYTES } from "./inventoryAttachments";
import {
  can,
  latestLocalDate,
  localDate,
  totalSeconds,
  type Aircraft,
  type AuditEntry,
  type Inspection,
  type Snapshot,
} from "./model";
import { componentTotals, type Component } from "./components";
import type { TaskCard } from "./taskCards";
import { Rejection, StaleRecordRejection } from "./rejection";
import { auditEntry } from "./changeLog";
export { isPreparingJobCards } from "./workOrderCards";

const TEXT_MAX_LENGTH = 10_000;
const ID_MAX_LENGTH = 200;
const WORK_PERFORMED_MAX_LENGTH = 100_000;
// Bounds each order's component entries, corrections and revisions.
const ENTRY_LIST_MAX = 100;
const TASK_LIST_MAX = 500;
const FILE_NAME_MAX_LENGTH = 255;
const ATTACHMENT_TYPES = ["application/pdf", "image/jpeg", "image/png"];
const ORDER_NUMBER_DIGITS = 4;
const CLOSED_STATUSES: readonly string[] = ["completed", "cancelled"];
// Job cards spell their closed status "canceled".
const CLOSED_CARD_STATUSES: readonly string[] = ["completed", "canceled"];

const text = z.string().trim().max(TEXT_MAX_LENGTH);
const id = z.string().min(1).max(ID_MAX_LENGTH);

/** A work order's statuses; "completed" and "cancelled" close it. */
export const workOrderStatuses = [
  "open",
  "in-progress",
  "awaiting-approval",
  "parts-delay",
  "completed",
  "cancelled",
] as const;

/** A work item's statuses on its order. */
export const taskStatuses = [
  "requested",
  "in-progress",
  "parts-delay",
  "completed",
  "cancelled",
] as const;

/**
 * The record a work item comes from: an AD action, discrepancy, inspection or
 * component requirement on the order's aircraft, or "manual" work.
 */
export const sourceSchema = z.object({
  kind: z.enum([
    "discrepancy",
    "inspection",
    "componentRequirement",
    "airworthiness",
    "manual",
  ]),
  uuid: id,
});

/** Where a work item comes from; see {@link sourceSchema}. */
export type WorkSource = z.infer<typeof sourceSchema>;

const taskSchema = z.object({
  ...logbookSelectionFields,
  maintenanceReference: text.optional(),
  uuid: z.string().uuid(),
  source: sourceSchema,
  description: text.min(1),
  status: z.enum(taskStatuses),
  notes: text,
  partsDelay: text,
});

/** The longest work order number a user may enter. */
export const WORK_ORDER_NUMBER_MAX_LENGTH = 100;

/** The longest free text a work order or one of its items holds. */
export const WORK_ORDER_TEXT_MAX_LENGTH = TEXT_MAX_LENGTH;

/**
 * The fields a user edits on a work order; `completionDate` stays "" until
 * the order is completed.
 *
 * @throws {z.ZodError} From `parse()` on an invalid field.
 */
export const workOrderFieldsSchema = z.object({
  number: z.string().trim().max(WORK_ORDER_NUMBER_MAX_LENGTH),
  aircraftUuid: id,
  dateOpened: z.iso.date(),
  supervisor: text,
  scope: text,
  priority: z.enum(["routine", "high", "urgent"]),
  status: z.enum(workOrderStatuses),
  completionDate: z.union([z.iso.date(), z.literal("")]),
  releaseOutcome: text,
  finalReview: text,
});

const componentReadingSchema = z.object({
  recordedAt: z.number(),
  componentUuid: id,
  label: text,
  partNumber: text,
  serial: text,
  timeSinceNew: z.number().nullable(),
  timeSinceOverhaul: z.number().nullable(),
  timeSinceRepair: z.number().nullable(),
  cyclesSinceNew: z.number(),
});

/** The fields a revision of a closed work order may correct. */
export const workOrderRevisionFieldsSchema = z.object({
  supervisor: text,
  scope: text,
  releaseOutcome: text,
  finalReview: text,
  workPerformed: z.string().trim().max(WORK_PERFORMED_MAX_LENGTH),
});

/**
 * A work order as stored: its fields and items, the aircraft's and chosen
 * components' readings captured when it was opened, and what closing,
 * revising and correcting it append.
 *
 * @throws {z.ZodError} From `parse()` on an invalid field.
 */
export const workOrderSchema = workOrderFieldsSchema.extend({
  archivedTasks: z
    .array(
      z.object({
        task: taskSchema,
        cardUuids: z.array(z.string().uuid()),
        removedAt: z.number(),
        removedBy: id,
        removedByName: text,
        componentWork: z.array(componentWorkDraftSchema).optional(),
      }),
    )
    .optional(),
  templateCopy: z
    .object({
      jobId: z.string(),
      status: z.enum(["running", "failed", "completed"]),
      completed: z.number(),
      total: z.number(),
      error: z.string().optional(),
    })
    .optional(),
  componentCorrections: z
    .array(componentCorrectionSchema)
    .max(ENTRY_LIST_MAX)
    .optional(),
  revisedWorkPerformed: z.string().max(WORK_PERFORMED_MAX_LENGTH).optional(),
  revisions: z
    .array(
      z.object({
        number: z.number().int().positive(),
        recordedAt: z.number(),
        authorId: id,
        authorName: text,
        reason: text.min(1),
        // Preserve the previous record without recursively copying its history.
        previousRecord: z.string(),
      }),
    )
    .max(ENTRY_LIST_MAX)
    .optional(),
  closeout: closeoutSchema.optional(),
  componentWork: z
    .array(componentWorkDraftSchema)
    .max(ENTRY_LIST_MAX)
    .optional(),
  uuid: z.string().uuid(),
  version: z.number().int().nonnegative(),
  recordedAt: z.number(),
  createdBy: id,
  aircraft: z.object({
    registration: text,
    make: text,
    model: text,
    serial: text,
    totalSeconds: z.number(),
    hobbs: z.number(),
    tach: z.number(),
    cyclicHobbs: z.number().optional(),
    flightTimeLog: z.number().optional(),
    meter: z.enum(["hobbs", "tach", "cyclic", "flightTimeLog"]),
    cycles: z.number(),
    landings: z.number().int().nonnegative().optional(),
  }),
  componentReadings: z.array(componentReadingSchema).max(ENTRY_LIST_MAX),
  tasks: z.array(taskSchema).max(TASK_LIST_MAX),
});

/** A stored work order. */
export type WorkOrder = z.infer<typeof workOrderSchema>;
/** The fields a user edits on a work order. */
export type WorkOrderFields = z.infer<typeof workOrderFieldsSchema>;
/** One work item on an order. */
export type WorkTask = WorkOrder["tasks"][number];

/**
 * A work-order command, naming the order and the version it was read at:
 * correct a component's close-out, revise a closed order, copy job card
 * templates, save the order, or add one work item.
 *
 * @throws {z.ZodError} From `parse()` on an invalid command.
 */
export const workOrderCommandSchema = z.discriminatedUnion("action", [
  componentCorrectionCommandSchema,
  z.object({
    action: z.literal("revise"),
    uuid: z.string().uuid(),
    version: z.number().int().nonnegative(),
    reason: text.min(1),
    fields: workOrderRevisionFieldsSchema,
  }),
  z.object({
    action: z.literal("copyTemplates"),
    uuid: z.string().uuid(),
    version: z.number().int().nonnegative(),
  }),
  z.object({
    action: z.literal("save"),
    uuid: z.string().uuid(),
    version: z.number().int().nonnegative(),
    fields: workOrderFieldsSchema,
    completionReadings: completionReadingsSchema.optional(),
    componentWork: z
      .array(componentWorkDraftSchema)
      .max(ENTRY_LIST_MAX)
      .optional(),
    componentUuids: z.array(id).max(ENTRY_LIST_MAX),
    tasks: z.array(taskSchema).max(TASK_LIST_MAX),
  }),
  z.object({
    action: z.literal("add"),
    uuid: z.string().uuid(),
    version: z.number().int().nonnegative(),
    source: sourceSchema,
  }),
]);

/** A work-order command; see {@link workOrderCommandSchema}. */
export type WorkOrderCommand = z.infer<typeof workOrderCommandSchema>;

type SaveCommand = Extract<WorkOrderCommand, { action: "save" }>;
type OrderEdit = Extract<
  WorkOrderCommand,
  { action: "save" | "add" | "copyTemplates" }
>;
type ComponentWorkItem = NonNullable<WorkOrder["componentWork"]>[number];
type OfferedWork = { source: WorkSource; description: string };
type Draft = { next: WorkOrder; removedTasks: WorkTask[] };
type Removal = {
  existing: WorkOrder | undefined;
  removedTasks: WorkTask[];
  programUuid: string | undefined;
  now: number;
};

/**
 * Whether a work order still takes edits.
 *
 * @param w - The work order.
 * @returns False once it is completed or cancelled.
 */
export const isOpenWorkOrder = (w: WorkOrder) =>
  !CLOSED_STATUSES.includes(w.status);

/**
 * The work orders an item can be added to.
 *
 * @param s - The snapshot.
 * @param aircraftUuid - The item's aircraft.
 * @param source - The item.
 * @returns The aircraft's open orders that are not preparing job cards and
 *   do not hold the item already, in record order.
 */
export function workOrdersTaking(
  s: Snapshot,
  aircraftUuid: string,
  source: WorkSource,
): WorkOrder[] {
  return (s.workOrders ?? []).filter(
    (w) =>
      w.aircraftUuid === aircraftUuid &&
      isOpenWorkOrder(w) &&
      !isPreparingJobCards(w) &&
      !holdsWorkItem(w.tasks, source),
  );
}

/**
 * The components installed on an aircraft.
 *
 * @param s - The snapshot.
 * @param aircraftUuid - The aircraft.
 * @returns Its installed components, in record order.
 */
export function installedComponents(s: Snapshot, aircraftUuid: string) {
  return (s.management ?? []).filter(
    (r): r is Component =>
      r.kind === "component" && r.installed && r.aircraftUuid === aircraftUuid,
  );
}

/**
 * The work items an aircraft offers for a work order.
 *
 * @param s - The snapshot.
 * @param aircraftUuid - The aircraft.
 * @returns Each item's source and description: the actions of reviewed ADs
 *   that are applicable or PCW, open discrepancies, unarchived inspections,
 *   then installed components' requirements, each kind in record order.
 */
export function workSources(
  s: Snapshot,
  aircraftUuid: string,
): { source: WorkSource; description: string }[] {
  return [
    ...adSources(s, aircraftUuid),
    ...discrepancySources(s, aircraftUuid),
    ...inspectionSources(s, aircraftUuid),
    ...requirementSources(s, aircraftUuid),
  ];
}

/**
 * The work items an aircraft offers that a work order does not hold yet.
 *
 * @param s - The snapshot.
 * @param aircraftUuid - The aircraft.
 * @param tasks - The order's items.
 * @returns As {@link workSources}, without the items' sources.
 */
export function unusedWorkSources(
  s: Snapshot,
  aircraftUuid: string,
  tasks: WorkTask[],
): { source: WorkSource; description: string }[] {
  return workSources(s, aircraftUuid).filter(
    (x) => !holdsWorkItem(tasks, x.source),
  );
}

/**
 * A new requested work item, left out of the logbook entry until chosen.
 *
 * @param source - The record it comes from.
 * @param description - What the item says.
 * @returns The item, with a new uuid.
 */
export function newWorkTask(source: WorkSource, description: string): WorkTask {
  return {
    uuid: crypto.randomUUID(),
    source,
    description,
    includeInLogbook: false,
    logbookPhrase: "Performed",
    status: "requested",
    notes: "",
    partsDelay: "",
  };
}

/**
 * Adds an inspection to a work order as a new requested task, described by
 * the inspection's reference and description.
 *
 * Whether the order is open, and whether the inspection is already on it, are
 * left to saveWorkOrder, which checks the second after its component checks.
 *
 * @param order - The work order, which is not changed.
 * @param inspection - The inspection the command names, or undefined when the
 *   snapshot holds none.
 * @returns A copy of the order with the task appended.
 * @throws {Rejection} "Work item is unavailable for this aircraft." for a
 *   missing or archived inspection, or one on another aircraft.
 */
export function addInspectionTask(
  order: WorkOrder,
  inspection: Inspection | undefined,
): WorkOrder {
  if (
    !inspection ||
    inspection.archived ||
    inspection.aircraftUuid !== order.aircraftUuid
  )
    throw new Rejection("Work item is unavailable for this aircraft.");
  const task = newWorkTask(
    { kind: "inspection", uuid: inspection.uuid },
    `${inspection.reference}: ${inspection.description}`,
  );
  return { ...order, tasks: [...order.tasks, task] };
}

/**
 * Progress on a work order: its items, its job cards, the discrepancies it
 * covers that are still open, and what waits for parts.
 *
 * @param s - The snapshot.
 * @param w - The work order.
 * @returns Counts; a discrepancy that an item and a job card both name
 *   counts once.
 */
export function workOrderProgress(s: Snapshot, w: WorkOrder) {
  const cards = (s.taskCards ?? []).filter((t) => t.workOrderUuid === w.uuid);
  const discrepancyIds = new Set([
    ...w.tasks
      .filter((t) => t.source.kind === "discrepancy")
      .map((t) => t.source.uuid),
    ...cards.map((t) => t.discrepancyUuid).filter(Boolean),
  ]);
  return {
    total: w.tasks.length,
    completed: w.tasks.filter((t) => t.status === "completed").length,
    taskCardsTotal: cards.length,
    taskCardsCompleted: cards.filter((t) => t.status === "completed").length,
    outstandingDiscrepancies: s.discrepancies.filter(
      (d) => discrepancyIds.has(d.uuid) && d.status === "open",
    ).length,
    partsDelays:
      w.tasks.filter((t) => t.status === "parts-delay").length +
      cards.filter((t) => t.status === "awaiting-parts").length,
  };
}

/** The tallies {@link workOrderCounts} returns. */
export interface WorkOrderCounts {
  open: number;
  inProgress: number;
  closedThisMonth: number;
}

/**
 * Tallies work orders by state; a cancelled order never counts as closed this
 * month.
 *
 * @param orders - The orders to count.
 * @param today - The local date, as YYYY-MM-DD.
 * @returns Open orders, those in progress, and those completed in today's
 *   month.
 */
export function workOrderCounts(
  orders: WorkOrder[],
  today: string,
): WorkOrderCounts {
  const month = today.slice(0, "YYYY-MM".length);
  return {
    open: orders.filter(isOpenWorkOrder).length,
    inProgress: orders.filter((w) => w.status === "in-progress").length,
    closedThisMonth: orders.filter(
      (w) => w.status === "completed" && w.completionDate.startsWith(month),
    ).length,
  };
}

/**
 * The aircraft's readings a work order records when it is opened.
 *
 * @param a - The aircraft.
 * @returns Its identity, total time, meters, cycles and landings now.
 * @throws {Error} As {@link totalSeconds} without the reading its time
 *   comes from.
 */
export function openingReading(a: Aircraft): WorkOrder["aircraft"] {
  return {
    registration: a.registration,
    make: a.make,
    model: a.model,
    serial: a.serial,
    totalSeconds: totalSeconds(a),
    hobbs: a.currentHobbs,
    tach: a.currentTach,
    cyclicHobbs: a.currentCyclicHobbs,
    flightTimeLog: a.currentFlightTimeLog,
    meter: a.meter,
    cycles: a.cycles,
    landings: a.landings,
  };
}

/**
 * The reading a work order records for a component chosen for its header,
 * labelled with the component's install position.
 *
 * @param c - The installed component.
 * @param a - Its aircraft.
 * @param today - The local date its totals are read on.
 * @param now - When the reading is recorded.
 * @returns Its label, part and serial numbers, and times and cycles since new.
 * @throws As {@link componentTotals}.
 */
export function componentReading(
  c: Component,
  a: Aircraft,
  today: string,
  now: number,
): WorkOrder["componentReadings"][number] {
  const totals = componentTotals(c, a, today);
  return {
    recordedAt: now,
    componentUuid: c.uuid,
    label: `${c.componentType}${c.installPosition ? ` · ${c.installPosition}` : ""}`,
    partNumber: c.partNumber,
    serial: c.serial,
    timeSinceNew: totals.timeSinceNew,
    timeSinceOverhaul: totals.timeSinceOverhaul,
    timeSinceRepair: totals.timeSinceRepair,
    cyclesSinceNew: totals.cyclesSinceNew,
  };
}

/**
 * Applies one work-order command to a working snapshot; saving an order as
 * completed closes it out through completeWorkOrder. A refused command leaves
 * the snapshot unchanged.
 *
 * Writes `workOrders`, `taskCards`, `archivedTaskCards` and `audit` (one
 * "taskCard.archived_with_task" entry per job card archived with a removed
 * item); a completion also writes `inspections` and `management`, and a
 * component correction writes `management` and `workOrders` only.
 *
 * @param s - The working snapshot.
 * @param raw - The command.
 * @param now - The clock for timestamps and today's date.
 * @param options - `deferTemplateCopies` leaves copying job card templates
 *   for the order's items to the caller.
 * @returns The saved order, its version advanced.
 * @throws {Rejection} A refused command, such as "This work order is
 *   closed."; a StaleRecordRejection for a stale order or component version;
 *   and as completeWorkOrder, previewComponentCorrection and componentTotals.
 * @throws {z.ZodError} When the command or the saved order does not parse.
 */
export function saveWorkOrder(
  s: Snapshot,
  raw: WorkOrderCommand,
  now = Date.now(),
  options: { deferTemplateCopies?: boolean } = {},
): WorkOrder {
  const command = workOrderCommandSchema.parse(raw);
  const existing = s.workOrders?.find((w) => w.uuid === command.uuid);
  const aircraftUuid = assertWritable(s, command, existing);
  if (command.action === "correctComponent")
    return correctComponent(s, requireOrder(existing), command, now);
  if (command.action === "revise")
    return reviseOrder(s, existing, command, now);
  if (existing && !isOpenWorkOrder(existing))
    throw new Rejection("This work order is closed.");
  const a = s.aircraft.find((a) => a.uuid === aircraftUuid)!;
  const draft = draftOrder(s, command, existing, a, now);
  assertComponentWork(s, draft.next, a);
  const saved = finishDraft(s, draft.next, command.version);
  const isolated = structuredClone(s);
  let next = archiveRemovedTasks(isolated, saved, {
    existing,
    removedTasks: draft.removedTasks,
    programUuid: a.programUuid,
    now,
  });
  isolated.workOrders = [
    ...(s.workOrders ?? []).filter((w) => w.uuid !== next.uuid),
    next,
  ];
  const previous = command.action === "copyTemplates" ? undefined : existing;
  if (!options.deferTemplateCopies)
    copyWorkOrderTemplates(isolated, next, previous, now);
  assertItemsCompletable(isolated, existing, next);
  if (next.status === "completed")
    next = closeOrder(isolated, next, command, now);
  commitOrder(s, isolated, next.status === "completed");
  return next;
}

/** A file attached to a work order, as listed for it. */
export interface WorkOrderAttachment {
  uuid: string;
  workOrderUuid: string;
  name: string;
  size: number;
  uploadedAt: number;
  url: string;
}

/**
 * Refuses a work-order attachment or job-card evidence file unless it is a
 * PDF, JPEG or PNG of 1 byte to {@link MAX_ACTION_FILE_BYTES}, with a
 * non-blank name of at most 255 characters.
 *
 * @throws {Rejection} "Choose a PDF, JPEG or PNG file up to 7 MiB."
 */
export function validateWorkOrderFile(
  name: string,
  type: string,
  size: number,
) {
  if (
    !name.trim() ||
    name.length > FILE_NAME_MAX_LENGTH ||
    !ATTACHMENT_TYPES.includes(type) ||
    size <= 0 ||
    size > MAX_ACTION_FILE_BYTES
  )
    throw new Rejection("Choose a PDF, JPEG or PNG file up to 7 MiB.");
}

function adSources(s: Snapshot, aircraftUuid: string): OfferedWork[] {
  return (s.airworthiness ?? [])
    .filter((r) => adAircraftUuid(s, r) === aircraftUuid && isTrackedAD(r))
    .flatMap((r) =>
      r.tasks.map((t) => ({
        source: { kind: "airworthiness" as const, uuid: t.uuid },
        description: `AD ${r.source.number}: ${t.description}`,
      })),
    );
}

function discrepancySources(s: Snapshot, aircraftUuid: string): OfferedWork[] {
  return s.discrepancies
    .filter((d) => d.aircraftUuid === aircraftUuid && d.status === "open")
    .map((d) => ({
      source: { kind: "discrepancy" as const, uuid: d.uuid },
      description: d.description,
    }));
}

function inspectionSources(s: Snapshot, aircraftUuid: string): OfferedWork[] {
  return s.inspections
    .filter((i) => i.aircraftUuid === aircraftUuid && !i.archived)
    .map((i) => ({
      source: { kind: "inspection" as const, uuid: i.uuid },
      description: `${i.reference}: ${i.description}`,
    }));
}

// A component held in inventory offers none of its requirements.
function requirementSources(s: Snapshot, aircraftUuid: string): OfferedWork[] {
  const components = installedComponents(s, aircraftUuid);
  return (s.management ?? []).flatMap((r) => {
    if (r.kind !== "componentRequirement") return [];
    const c = components.find((c) => c.uuid === r.componentUuid);
    if (!c) return [];
    const source = { kind: "componentRequirement" as const, uuid: r.uuid };
    const description = `${c.componentType} (${c.serial}) / ${r.description}`;
    return [{ source, description }];
  });
}

// Items from the same record are the same work, as finishDraft's duplicate
// check holds.
function holdsWorkItem(tasks: WorkTask[], source: WorkSource): boolean {
  return tasks.some(
    (t) => t.source.kind === source.kind && t.source.uuid === source.uuid,
  );
}

// Every command passes these checks first, in this order.
function assertWritable(
  s: Snapshot,
  command: WorkOrderCommand,
  existing: WorkOrder | undefined,
): string {
  if (existing && isPreparingJobCards(existing))
    throw new Rejection(
      "Job cards are still being prepared. Finish or resume preparation before editing or closing this work order.",
    );
  const aircraftUuid =
    command.action === "save"
      ? command.fields.aircraftUuid
      : existing?.aircraftUuid;
  if (!aircraftUuid || !can(s, aircraftUuid, "maintenance"))
    throw new Rejection("Work order maintenance access denied.");
  if (existing && existing.aircraftUuid !== aircraftUuid)
    throw new Rejection("A work order cannot change aircraft.");
  if ((existing?.version ?? 0) !== command.version)
    throw new StaleRecordRejection("workOrder", existing?.version ?? 0);
  return aircraftUuid;
}

// Unreachable: a command other than a save takes its aircraft from the order,
// so assertWritable refuses one naming an order the snapshot lacks.
function requireOrder(existing: WorkOrder | undefined): WorkOrder {
  if (!existing) throw new Error("Work order not found.");
  return existing;
}

function correctComponent(
  s: Snapshot,
  existing: WorkOrder,
  command: Extract<WorkOrderCommand, { action: "correctComponent" }>,
  now: number,
): WorkOrder {
  const result = previewComponentCorrection(s, existing, command, now);
  const next = workOrderSchema.parse({
    ...existing,
    version: existing.version + 1,
    componentCorrections: [
      ...(existing.componentCorrections ?? []),
      result.correction,
    ],
  });
  s.management = result.management;
  s.workOrders = s.workOrders!.map((w) => (w.uuid === next.uuid ? next : w));
  return next;
}

// A documentary correction: it never replays close-out tracking updates.
function reviseOrder(
  s: Snapshot,
  existing: WorkOrder | undefined,
  command: Extract<WorkOrderCommand, { action: "revise" }>,
  now: number,
): WorkOrder {
  const order = assertRevisable(s, existing, command);
  const { revisions = [], ...previousRecord } = order;
  const { workPerformed, ...fields } = command.fields;
  const revision = {
    number: revisions.length + 1,
    recordedAt: now,
    authorId: s.user.id,
    authorName: s.user.name,
    reason: command.reason,
    previousRecord: JSON.stringify(previousRecord),
  };
  const next = workOrderSchema.parse({
    ...order,
    ...fields,
    revisedWorkPerformed: workPerformed,
    version: order.version + 1,
    revisions: [...revisions, revision],
  });
  s.workOrders = s.workOrders!.map((w) => (w.uuid === next.uuid ? next : w));
  return next;
}

// The fields compare as JSON, so the prior fields keep the revision schema's
// key order.
function assertRevisable(
  s: Snapshot,
  existing: WorkOrder | undefined,
  command: Extract<WorkOrderCommand, { action: "revise" }>,
): WorkOrder {
  if (!existing || isOpenWorkOrder(existing))
    throw new Rejection(
      "Only closed work orders can be revised. Edit open orders normally.",
    );
  if (existing.status === "completed" && !command.fields.releaseOutcome)
    throw new Rejection("A completed work order requires a release statement.");
  const prior = {
    supervisor: existing.supervisor,
    scope: existing.scope,
    releaseOutcome: existing.releaseOutcome,
    finalReview: existing.finalReview,
    workPerformed:
      existing.revisedWorkPerformed ??
      existing.closeout?.workPerformed ??
      workPerformedText(s, existing),
  };
  if (JSON.stringify(prior) === JSON.stringify(command.fields))
    throw new Rejection("Change at least one field before saving a revision.");
  return existing;
}

function draftOrder(
  s: Snapshot,
  command: OrderEdit,
  existing: WorkOrder | undefined,
  a: Aircraft,
  now: number,
): Draft {
  if (command.action === "save")
    return draftSavedOrder(s, command, existing, a, now);
  const order = requireOrder(existing);
  if (command.action === "copyTemplates")
    return { next: { ...order }, removedTasks: [] };
  return { next: addWorkItem(s, order, command.source), removedTasks: [] };
}

// Any item but an inspection must be one the aircraft offers now.
function addWorkItem(s: Snapshot, order: WorkOrder, source: WorkSource) {
  if (source.kind === "inspection")
    return addInspectionTask(
      order,
      s.inspections.find((i) => i.uuid === source.uuid),
    );
  const item = workSources(s, order.aircraftUuid).find(
    (x) => x.source.kind === source.kind && x.source.uuid === source.uuid,
  );
  if (!item) throw new Rejection("Work item is unavailable for this aircraft.");
  const task = newWorkTask(item.source, item.description);
  return { ...order, tasks: [...order.tasks, task] };
}

// The aircraft's readings are captured once, when the order is opened. Work
// for a component on an item the save removes goes with the item.
function draftSavedOrder(
  s: Snapshot,
  command: SaveCommand,
  existing: WorkOrder | undefined,
  a: Aircraft,
  now: number,
): Draft {
  assertSaveFields(s, command, existing, now);
  const number = orderNumber(s, a, command, existing, localDate(now));
  const componentReadings = readHeaderComponents(s, command, existing, a, now);
  const tasks = resolveTasks(s, command, existing);
  const removedTasks =
    existing?.tasks.filter((t) => !tasks.some((x) => x.uuid === t.uuid)) ?? [];
  const isRemoved = (taskUuid?: string) =>
    removedTasks.some((task) => task.uuid === taskUuid);
  const next: WorkOrder = {
    ...command.fields,
    number,
    uuid: command.uuid,
    version: command.version,
    recordedAt: existing?.recordedAt ?? now,
    createdBy: existing?.createdBy ?? s.user.id,
    aircraft: existing?.aircraft ?? openingReading(a),
    componentReadings,
    componentWork: (command.componentWork ?? existing?.componentWork)?.filter(
      (work) => !work.taskUuid || !isRemoved(work.taskUuid),
    ),
    templateCopy: existing?.templateCopy,
    archivedTasks: existing?.archivedTasks,
    tasks,
  };
  return { next, removedTasks };
}

function assertSaveFields(
  s: Snapshot,
  command: SaveCommand,
  existing: WorkOrder | undefined,
  now: number,
) {
  const { fields } = command;
  const latest = latestLocalDate(now);
  if (fields.dateOpened > latest)
    throw new Rejection("Date opened cannot be in the future.");
  if (
    fields.completionDate &&
    (fields.completionDate < fields.dateOpened ||
      fields.completionDate > latest)
  )
    throw new Rejection("Completion date must be between opening and today.");
  if (!existing && fields.status !== "open")
    throw new Rejection("New work orders must start open.");
  assertClosable(s, command);
}

function assertClosable(s: Snapshot, command: SaveCommand) {
  const { fields } = command;
  if (
    fields.status === "completed" &&
    (!fields.completionDate ||
      !fields.releaseOutcome ||
      command.tasks.some((t) => !CLOSED_STATUSES.includes(t.status)))
  )
    throw new Rejection(
      "Complete or cancel every task and enter a completion date and release outcome before closing.",
    );
  const openCard = (t: TaskCard) =>
    t.workOrderUuid === command.uuid &&
    !CLOSED_CARD_STATUSES.includes(t.status);
  if (
    CLOSED_STATUSES.includes(fields.status) &&
    (s.taskCards ?? []).some(openCard)
  )
    throw new Rejection(
      "Complete or cancel linked job cards before closing the work order.",
    );
}

// Numbers are unique within the Flight Program, ignoring case. A blank one
// takes the first free WO-<year>-<nnnn> of the year of `today`.
function orderNumber(
  s: Snapshot,
  a: Aircraft,
  command: SaveCommand,
  existing: WorkOrder | undefined,
  today: string,
): string {
  const programOrders = (s.workOrders ?? []).filter(
    (w) =>
      s.aircraft.find((x) => x.uuid === w.aircraftUuid)?.programUuid ===
      a.programUuid,
  );
  const number =
    command.fields.number ||
    existing?.number ||
    firstFreeNumber(programOrders, today);
  const taken = programOrders.some(
    (w) => w.uuid !== command.uuid && isSameNumber(w.number, number),
  );
  if (taken)
    throw new Rejection("Work order number already exists in this program.");
  return number;
}

function firstFreeNumber(orders: WorkOrder[], today: string) {
  const year = today.slice(0, 4);
  let sequence = 1;
  let number: string;
  do {
    const padded = String(sequence++).padStart(ORDER_NUMBER_DIGITS, "0");
    number = `WO-${year}-${padded}`;
  } while (orders.some((w) => isSameNumber(w.number, number)));
  return number;
}

function isSameNumber(x: string, y: string) {
  return x.toLowerCase() === y.toLowerCase();
}

// A component's readings are taken when it is first chosen, then kept.
function readHeaderComponents(
  s: Snapshot,
  command: SaveCommand,
  existing: WorkOrder | undefined,
  a: Aircraft,
  now: number,
): WorkOrder["componentReadings"] {
  const installed = installedComponents(s, command.fields.aircraftUuid);
  const today = localDate(now);
  return [...new Set(command.componentUuids)].map((uuid) => {
    const prior = existing?.componentReadings.find(
      (c) => c.componentUuid === uuid,
    );
    if (prior) return prior;
    const c = installed.find((c) => c.uuid === uuid);
    if (!c)
      throw new Rejection(
        "Header components must be installed on this aircraft.",
      );
    return componentReading(c, a, today, now);
  });
}

// An item keeps its source and the description it was added with; a new one
// takes its description from the record it names.
function resolveTasks(
  s: Snapshot,
  command: SaveCommand,
  existing: WorkOrder | undefined,
): WorkTask[] {
  const sources = workSources(s, command.fields.aircraftUuid);
  return command.tasks.map((t) => {
    const prior = existing?.tasks.find((x) => x.uuid === t.uuid);
    if (prior) return keepSource(t, prior);
    if (t.source.kind === "manual") return t;
    const source = sources.find(
      (x) => x.source.kind === t.source.kind && x.source.uuid === t.source.uuid,
    );
    if (!source)
      throw new Rejection("Work item is unavailable for this aircraft.");
    return { ...t, description: source.description };
  });
}

function keepSource(t: WorkTask, prior: WorkTask): WorkTask {
  if (
    prior.source.kind !== t.source.kind ||
    prior.source.uuid !== t.source.uuid
  )
    throw new Rejection("A task cannot change its source.");
  return { ...t, description: prior.description };
}

function assertComponentWork(s: Snapshot, next: WorkOrder, a: Aircraft) {
  const work = next.componentWork ?? [];
  if (new Set(work.map((w) => w.componentUuid)).size !== work.length)
    throw new Rejection("A component can only have one action per work order.");
  for (const movement of work)
    if (movement.action === "install" || movement.action === "remove")
      assertMovement(s, next, a, movement);
}

// A movement on a cancelled item or order records nothing, so only its task
// is checked.
function assertMovement(
  s: Snapshot,
  next: WorkOrder,
  a: Aircraft,
  movement: ComponentWorkItem,
) {
  const task = next.tasks.find((t) => t.uuid === movement.taskUuid);
  if (!task || task.source.kind !== "manual")
    throw new Rejection(
      "A component movement requires its own work order task.",
    );
  if (task.status === "cancelled" || next.status === "cancelled") return;
  const c = findMovableComponent(s, a, movement);
  if (c.parentComponentUuid)
    throw new Rejection(
      "Move the parent component; its attached parts move with it.",
    );
  if (c.version !== movement.version)
    throw new StaleRecordRejection("component", c.version);
  const available =
    movement.action === "install"
      ? !c.installed
      : c.installed && c.aircraftUuid === next.aircraftUuid;
  if (!available)
    throw new Rejection("Component is unavailable for this aircraft movement.");
  if (movement.action === "install" && !movement.installPosition)
    throw new Rejection("Select an installation position.");
  if (movement.action === "remove") assertRemovalLocation(s, c, movement);
}

function findMovableComponent(
  s: Snapshot,
  a: Aircraft,
  movement: ComponentWorkItem,
): Component {
  const c = s.management?.find(
    (r): r is Component =>
      r.kind === "component" && r.uuid === movement.componentUuid,
  );
  if (
    !c ||
    recordProgram(s, c) !== a.programUuid ||
    (c.aircraftUuid && !can(s, c.aircraftUuid, "maintenance"))
  )
    throw new Rejection("Component maintenance access denied.");
  return c;
}

function assertRemovalLocation(
  s: Snapshot,
  c: Component,
  movement: ComponentWorkItem,
) {
  if (!movement.locationUuid && !movement.partsLocation?.trim())
    throw new Rejection("Select the removal inventory location.");
  validateComponentLocation(s, {
    ...c,
    installed: false,
    locationUuid: movement.locationUuid,
    partsLocation: movement.partsLocation,
  });
}

// Component work is kept only for the components the order still covers.
function finishDraft(s: Snapshot, draft: WorkOrder, version: number) {
  const open = draft.status !== "completed";
  const componentIds = workOrderComponentIds(s, draft, open);
  if (draft.componentWork)
    draft.componentWork = draft.componentWork.filter((item) =>
      componentIds.includes(item.componentUuid),
    );
  const keys = draft.tasks.map((t) => `${t.source.kind}:${t.source.uuid}`);
  if (
    new Set(keys).size !== keys.length ||
    new Set(draft.tasks.map((t) => t.uuid)).size !== draft.tasks.length
  )
    throw new Rejection("This item is already on the work order.");
  return workOrderSchema.parse({ ...draft, version: version + 1 });
}

// A removed item's job cards are archived with it, signatures and evidence
// kept, each with an audit entry.
function archiveRemovedTasks(
  isolated: Snapshot,
  next: WorkOrder,
  removal: Removal,
): WorkOrder {
  const { removedTasks } = removal;
  if (!removedTasks.length) return next;
  const cards = removedTaskCards(isolated, next.uuid, removedTasks, next.tasks);
  isolated.archivedTaskCards = [
    ...(isolated.archivedTaskCards ?? []),
    ...structuredClone(cards),
  ];
  const archived = removedTasks.map((task) =>
    archivedTask(isolated, task, cards, removal),
  );
  const removedIds = new Set(cards.map((card) => card.uuid));
  isolated.taskCards = isolated.taskCards?.filter(
    (card) => !removedIds.has(card.uuid),
  );
  for (const card of cards)
    isolated.audit.unshift(archivedCardEntry(isolated, next, card, removal));
  return {
    ...next,
    archivedTasks: [...(next.archivedTasks ?? []), ...archived],
  };
}

function archivedTask(
  s: Snapshot,
  task: WorkTask,
  cards: TaskCard[],
  { existing, now }: Removal,
) {
  return {
    task: structuredClone(task),
    cardUuids: cards
      .filter((card) => taskCardMatchesWorkItem(card, task))
      .map((card) => card.uuid),
    removedAt: now,
    removedBy: s.user.id,
    removedByName: s.user.name,
    componentWork: existing?.componentWork?.filter(
      (work) => work.taskUuid === task.uuid,
    ),
  };
}

function archivedCardEntry(
  s: Snapshot,
  next: WorkOrder,
  card: TaskCard,
  { programUuid, now }: Removal,
): AuditEntry {
  return auditEntry(
    s,
    {
      programUuid,
      action: "taskCard.archived_with_task",
      entityUuid: card.uuid,
      aircraftUuid: next.aircraftUuid,
      reason:
        "Job card archived with its removed work-order task; signatures and evidence retained.",
      before: card,
    },
    now,
  );
}

function assertItemsCompletable(
  isolated: Snapshot,
  existing: WorkOrder | undefined,
  next: WorkOrder,
) {
  for (const task of itemsCompletedNow(existing, next)) {
    const issue = workItemCompletionIssue(isolated, next.uuid, task);
    if (issue) throw new Rejection(issue);
  }
}

// An item's job cards are checked on the save that completes it, not on every
// later save: a template added to the library afterwards must neither lock the
// order nor stop its copy being added to the completed item.
function itemsCompletedNow(existing: WorkOrder | undefined, next: WorkOrder) {
  return next.tasks.filter(
    (task) =>
      task.status === "completed" &&
      existing?.tasks.find((prior) => prior.uuid === task.uuid)?.status !==
        "completed",
  );
}

function closeOrder(
  isolated: Snapshot,
  next: WorkOrder,
  command: OrderEdit,
  now: number,
): WorkOrder {
  const readings =
    command.action === "save" ? command.completionReadings : undefined;
  const closed = {
    ...next,
    closeout: completeWorkOrder(
      isolated,
      next,
      readings,
      now,
      next.componentWork,
    ),
  };
  isolated.workOrders = isolated.workOrders!.map((w) =>
    w.uuid === closed.uuid ? closed : w,
  );
  return closed;
}

// Only a completion changes inspections and component records.
function commitOrder(s: Snapshot, isolated: Snapshot, completed: boolean) {
  if (completed) {
    s.inspections = isolated.inspections;
    s.management = isolated.management;
  }
  s.workOrders = isolated.workOrders;
  s.taskCards = isolated.taskCards;
  s.archivedTaskCards = isolated.archivedTaskCards;
  s.audit = isolated.audit;
}
