/**
 * Responsibility: What a work order's logbook entry says it did: the
 *   work-performed text of its items and job cards, and who performed it.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ../model, ../workOrders (types), ../logbookWording,
 *   ../workOrderCards.
 */
import type { Snapshot } from "../model";
import type { WorkOrder, WorkTask } from "../workOrders";
import { logbookWorkLine } from "../logbookWording";
import { taskCardMatchesWorkItem } from "../workOrderCards";

/**
 * Each distinct technician who signed a job card included in the entry, in
 * signing order: the persons who performed the work (14 CFR 43.9(a)(3)).
 *
 * @param preview - Also counts job cards not yet completed, except cancelled.
 * @returns The user id and name of each, first signature first.
 */
export function logbookPerformers(
  s: Snapshot,
  order: WorkOrder,
  preview = false,
) {
  const performers = new Map<string, { userId: string; name: string }>();
  for (const { technicianSignoff: signed } of entryCards(s, order, preview)
    .filter((card) => card.includeInLogbook !== false)
    .sort(
      (a, b) => (a.technicianSignoff?.at ?? 0) - (b.technicianSignoff?.at ?? 0),
    ))
    if (signed && !performers.has(signed.userId))
      performers.set(signed.userId, {
        userId: signed.userId,
        name: signed.name,
      });
  return [...performers.values()];
}

/**
 * The work-performed text of a work order's logbook entry: each work item in
 * order with its job cards, then job cards linked to no item.
 *
 * @param preview - Also includes items and job cards not yet completed,
 *   except cancelled ones.
 * @returns One paragraph per item or card, separated by blank lines. An item
 *   or card left out of the logbook, or with nothing to say, adds none.
 */
export function workPerformedText(
  s: Snapshot,
  order: WorkOrder,
  preview = false,
) {
  const cards = entryCards(s, order, preview);
  const seen = new Set<string>();
  const describe = (card: Card) => {
    seen.add(card.uuid);
    return cardText(s, order, card);
  };
  const items = order.tasks.map((task, index) => {
    const linked = cards.filter(
      (card) => taskCardMatchesWorkItem(card, task) && !seen.has(card.uuid),
    );
    return itemText(task, index, linked, linked.map(describe), preview);
  });
  return [
    ...items,
    ...cards.filter((card) => !seen.has(card.uuid)).map(describe),
  ]
    .filter(Boolean)
    .join("\n\n");
}

type Card = NonNullable<Snapshot["taskCards"]>[number];

const signoffs = (card: Card) => [
  card.technicianSignoff && `Work signed by: ${card.technicianSignoff.name}`,
  card.inspectionSignoff &&
    `Inspection signed by: ${card.inspectionSignoff.name}`,
];
const executionDetails = (card: Card) => [
  card.findings && `Findings: ${card.findings}`,
  card.notesRemarks && `Notes: ${card.notesRemarks}`,
  card.measurements && `Measurements: ${card.measurements}`,
  ...card.partsUsed.map(
    (p) =>
      `Part: ${p.description || p.partNumber}; P/N ${p.partNumber}; quantity ${p.quantity}${p.serialLot ? `; S/N or lot ${p.serialLot}` : ""}${p.removedComponent ? `; removed: ${p.removedComponent}` : ""}${p.installedComponent ? `; installed: ${p.installedComponent}` : ""}`,
  ),
];
const stepResults = (card: Card) =>
  card.steps.flatMap((step, index) =>
    step.result || step.measurement !== null
      ? [
          `Step ${index + 1} — ${step.instruction}: ${[step.result, step.measurement !== null && `${step.measurement}${step.units ? ` ${step.units}` : ""}`].filter(Boolean).join("; ")}`,
        ]
      : [],
  );
const revisionText = (card: Card) =>
  card.referenceRevision ? `, revision ${card.referenceRevision}` : "";

// Job cards whose work the logbook entry describes.
const entryCards = (s: Snapshot, order: WorkOrder, preview: boolean) =>
  (s.taskCards ?? []).filter(
    (t) =>
      t.workOrderUuid === order.uuid &&
      (t.status === "completed" || (preview && t.status !== "canceled")),
  );

// A work item's selection controls its own line; each job card controls its
// procedure line.
function itemText(
  task: WorkTask,
  index: number,
  linked: Card[],
  details: string[],
  preview: boolean,
) {
  if (task.status !== "completed" && (!preview || task.status === "cancelled"))
    return details.filter(Boolean).join("\n");
  return [itemSummary(task, index, linked), ...details]
    .filter(Boolean)
    .join("\n");
}

function itemSummary(task: WorkTask, index: number, linked: Card[]) {
  if (task.includeInLogbook === true)
    return logbookWorkLine(
      index + 1,
      task.logbookPhrase,
      task.description,
      task.maintenanceReference?.trim() || "",
    );
  if (
    task.includeInLogbook === false ||
    linked.some((card) => card.includeInLogbook !== undefined)
  )
    return "";
  return [task.description, task.notes].filter(Boolean).join("\n");
}

function cardText(s: Snapshot, order: WorkOrder, card: Card) {
  if (card.includeInLogbook === false) return "";
  const libraryReference = manualReferenceText(s, card);
  if (card.includeInLogbook === true)
    return selectedCardText(order, card, libraryReference);
  return [
    `${card.cardNumber} — ${card.title}: ${card.actualWork}`,
    card.maintenanceReference &&
      `Reference: ${card.maintenanceReference}${revisionText(card)}`,
    libraryReference && libraryReference,
    ...executionDetails(card),
    ...signoffs(card),
  ]
    .filter(Boolean)
    .join("\n");
}

function manualReferenceText(s: Snapshot, card: Card) {
  const reference = card.manualReference;
  if (!reference) return "";
  const manual = s.manuals?.find((m) => m.uuid === reference.manualUuid);
  return [
    manual?.title || "Linked maintenance manual",
    manual?.documentNumber,
    manual?.revision && `revision ${manual.revision}`,
    reference.section && `section ${reference.section}`,
    reference.printedPage && `page ${reference.printedPage}`,
    `PDF page ${reference.pdfPage}`,
  ]
    .filter(Boolean)
    .join(", ");
}

function selectedCardText(
  order: WorkOrder,
  card: Card,
  libraryReference: string,
) {
  const taskIndex = order.tasks.findIndex((task) =>
    taskCardMatchesWorkItem(card, task),
  );
  const maintenance = card.maintenanceReference.trim();
  const reference =
    libraryReference ||
    (maintenance ? `${maintenance}${revisionText(card)}` : "");
  return [
    logbookWorkLine(
      taskIndex < 0 ? card.cardNumber : taskIndex + 1,
      card.logbookPhrase,
      card.title || card.description,
      reference,
    ),
    // The entry records the work actually performed, not only the procedure.
    card.actualWork && `Work performed: ${card.actualWork}`,
    ...stepResults(card),
    ...executionDetails(card),
    ...signoffs(card),
  ]
    .filter(Boolean)
    .join("\n");
}
