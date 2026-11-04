/**
 * Responsibility: Job cards on a work order: copying task-card templates for
 *   new work items, whether the order is still preparing them, and whether an
 *   item's job cards let it be completed.
 * Layer: Domain. Mutates a working snapshot; no I/O, no React.
 * Dependencies: src/domain/model.ts and workOrders.ts (types), taskCards.ts.
 *
 * A job card is an independent copy: later template edits never reach it.
 */
import type { Snapshot } from "./model";
import type { WorkOrder } from "./workOrders";
import {
  copyTemplateSteps,
  isTaskTemplate,
  linkField,
  saveTaskCard,
  taskCardFieldsSchema,
  taskCardSchema,
  type TaskCard,
  type TaskCardFields,
} from "./taskCards";

type WorkItem = WorkOrder["tasks"][number];

const TEMPLATE_SOURCE_KINDS = [
  "inspection",
  "componentRequirement",
  "discrepancy",
] as const;

/**
 * Copies the aircraft's task-card templates into draft job cards for the work
 * items a save adds, at most once per template per order.
 *
 * @param s - The working snapshot. It gains each copy and a
 *   "taskCard.created_from_template" audit entry; a throw leaves it
 *   half-written, so the caller discards the whole save.
 * @param order - The order as saved, after validation.
 * @param previous - The stored order; only uncancelled items it lacks count.
 * @param now - The save time.
 * @returns How many job cards were created.
 * @throws As saveTaskCard, for a template that no longer saves.
 */
export function copyWorkOrderTemplates(
  s: Snapshot,
  order: WorkOrder,
  previous: WorkOrder | undefined,
  now: number,
) {
  const added = order.tasks.filter(
    (t) =>
      t.status !== "cancelled" &&
      !previous?.tasks.some((p) => p.uuid === t.uuid),
  );
  const sourceItem = (t: TaskCard) =>
    added.find((item) => matchesItemSource(t, item));
  const copyUuids = mapCopiedTemplates(s, order);
  const selected = (s.taskCards ?? []).filter(
    (t) =>
      t.aircraftUuid === order.aircraftUuid &&
      isTaskTemplate(t) &&
      t.status !== "canceled" &&
      sourceItem(t) &&
      !copyUuids.has(t.uuid),
  );
  selected.forEach((t) => copyUuids.set(t.uuid, crypto.randomUUID()));
  const created = selected.map((original) => {
    const copy = createJobCard(s, order, original, now, {
      uuid: copyUuids.get(original.uuid)!,
      workTaskUuid: sourceItem(original)!.uuid,
    });
    return { original, copy };
  });
  for (const { original, copy } of created)
    auditTemplateCopy(s, order, original, copy.uuid, now);
  return created.length;
}

/**
 * Whether a work order's job cards are still being copied from templates;
 * until they finish, the order takes no edits.
 *
 * @param w - The work order.
 * @returns True while a template copy is running or has failed.
 */
export function isPreparingJobCards(w: WorkOrder): boolean {
  return !!w.templateCopy && w.templateCopy.status !== "completed";
}

/**
 * Explains why a work item cannot be marked completed yet, or "" when it can.
 *
 * @param s - The snapshot.
 * @param orderUuid - The item's work order.
 * @param item - The work item.
 * @returns The first that applies: "Finish preparing the job cards before
 *   completing this item."; "Add the associated job card templates to this
 *   work order before completing this item."; "Complete and sign off every
 *   job card for this item on this work order before marking it completed."
 */
export function workItemCompletionIssue(
  s: Snapshot,
  orderUuid: string,
  item: WorkItem,
) {
  const order = s.workOrders?.find((w) => w.uuid === orderUuid);
  if (order && isPreparingJobCards(order))
    return "Finish preparing the job cards before completing this item.";
  const cards = (s.taskCards ?? []).filter(
    (t) => t.workOrderUuid === orderUuid && taskCardMatchesWorkItem(t, item),
  );
  // Only an item with no job cards at all waits for templates: copies stay
  // fixed when the template library later gains tasks.
  if (!cards.length && hasActiveTemplate(s, item))
    return "Add the associated job card templates to this work order before completing this item.";
  if (cards.some((t) => !isSignedOff(t)))
    return "Complete and sign off every job card for this item on this work order before marking it completed.";
  return "";
}

/**
 * Whether a kind of work item gets job cards copied from task-card templates.
 *
 * @param kind - The item's source kind.
 * @returns True for inspections, component requirements and discrepancies;
 *   false for AD actions and manual work, which have no templates.
 */
export function copiesJobCardTemplates(
  kind: WorkItem["source"]["kind"],
): kind is (typeof TEMPLATE_SOURCE_KINDS)[number] {
  return (TEMPLATE_SOURCE_KINDS as readonly string[]).includes(kind);
}

/**
 * Tells whether a task card belongs to a work item.
 *
 * @param t - The task card.
 * @param item - The work item.
 * @returns True when the card was copied for the item, or names the same
 *   inspection, component requirement or discrepancy.
 */
export function taskCardMatchesWorkItem(t: TaskCard, item: WorkItem): boolean {
  return t.workTaskUuid === item.uuid || matchesItemSource(t, item);
}

function matchesItemSource(t: TaskCard, item: WorkItem) {
  const { kind, uuid } = item.source;
  return copiesJobCardTemplates(kind) && t[linkField[kind]] === uuid;
}

// Template uuid to job card uuid, for the copies this order already holds.
function mapCopiedTemplates(s: Snapshot, order: WorkOrder) {
  return new Map(
    (s.taskCards ?? [])
      .filter((t) => t.workOrderUuid === order.uuid && t.sourceTaskCardUuid)
      .map((t) => [t.sourceTaskCardUuid!, t.uuid]),
  );
}

function createJobCard(
  s: Snapshot,
  order: WorkOrder,
  original: TaskCard,
  now: number,
  link: { uuid: string; workTaskUuid: string },
) {
  const task = saveTaskCard(
    s,
    {
      action: "save",
      uuid: link.uuid,
      version: 0,
      fields: draftJobCardFields(original, order),
    },
    now,
  );
  const copy = taskCardSchema.parse({
    ...task,
    sourceTaskCardUuid: original.uuid,
    sourceTaskCardVersion: original.version,
    workTaskUuid: link.workTaskUuid,
  });
  s.taskCards = s.taskCards!.map((t) => (t.uuid === copy.uuid ? copy : t));
  return copy;
}

// The template's instructions with none of its recorded work, so a legacy
// template that holds results never passes them on.
function draftJobCardFields(
  original: TaskCard,
  order: WorkOrder,
): TaskCardFields {
  const fields = taskCardFieldsSchema.parse(original);
  return {
    ...fields,
    workOrderUuid: order.uuid,
    cardNumber: "",
    status: "draft",
    assignedTechnician: "",
    findings: "",
    actualWork: "",
    measurements: "",
    actualLabor: null,
    completionDate: "",
    partsUsed: [],
    functionalTestOutcome: fields.functionalTestRequired
      ? "pending"
      : "not-required",
    functionalTestResults: "",
    prerequisiteUuids: [],
    steps: copyTemplateSteps(fields.steps),
  };
}

function auditTemplateCopy(
  s: Snapshot,
  order: WorkOrder,
  original: TaskCard,
  copyUuid: string,
  now: number,
) {
  const after = s.taskCards!.find((t) => t.uuid === copyUuid)!;
  s.audit.unshift({
    uuid: crypto.randomUUID(),
    programUuid: s.aircraft.find((a) => a.uuid === order.aircraftUuid)
      ?.programUuid,
    actorId: s.user.id,
    at: now,
    action: "taskCard.created_from_template",
    entityUuid: copyUuid,
    aircraftUuid: order.aircraftUuid,
    reason: `Copied ${original.cardNumber} version ${original.version} to ${order.number}.`,
    after: JSON.stringify(after),
  });
}

function hasActiveTemplate(s: Snapshot, item: WorkItem) {
  return (s.taskCards ?? []).some(
    (t) =>
      isTaskTemplate(t) &&
      t.status !== "canceled" &&
      taskCardMatchesWorkItem(t, item),
  );
}

function isSignedOff(t: TaskCard) {
  return (
    t.status === "completed" &&
    !!t.technicianSignoff &&
    !(t.inspectionSignoffRequired && !t.inspectionSignoff)
  );
}
