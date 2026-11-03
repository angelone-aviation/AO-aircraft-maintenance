import type { Snapshot } from "./model";
import type { WorkOrder } from "./workOrders";
import {
  copyTemplateSteps,
  isTaskTemplate,
  saveTaskCard,
  taskCardFieldsSchema,
  taskCardSchema,
  type TaskCard,
} from "./taskCards";

// Called on isolated state after the order is validated; failures roll back the entire order save.
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
  const originals = (s.taskCards ?? []).filter(
    (t) =>
      t.aircraftUuid === order.aircraftUuid &&
      isTaskTemplate(t) &&
      t.status !== "canceled",
  );
  const sourceTask = (t: TaskCard) =>
    added.find(
      (item) =>
        (item.source.kind === "inspection" &&
          t.inspectionUuid === item.source.uuid) ||
        (item.source.kind === "componentRequirement" &&
          t.requirementUuid === item.source.uuid) ||
        (item.source.kind === "discrepancy" &&
          t.discrepancyUuid === item.source.uuid),
    );
  const map = new Map(
    (s.taskCards ?? [])
      .filter((t) => t.workOrderUuid === order.uuid && t.sourceTaskCardUuid)
      .map((t) => [t.sourceTaskCardUuid!, t.uuid]),
  );
  const selected = originals.filter((t) => sourceTask(t) && !map.has(t.uuid));
  selected.forEach((t) => map.set(t.uuid, crypto.randomUUID()));
  const created = selected.map((original) => {
    const fields = taskCardFieldsSchema.parse(original);
    const task = saveTaskCard(
      s,
      {
        action: "save",
        uuid: map.get(original.uuid)!,
        version: 0,
        fields: {
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
        },
      },
      now,
    );
    const copy = taskCardSchema.parse({
      ...task,
      sourceTaskCardUuid: original.uuid,
      sourceTaskCardVersion: original.version,
      workTaskUuid: sourceTask(original)!.uuid,
    });
    s.taskCards = s.taskCards!.map((t) => (t.uuid === copy.uuid ? copy : t));
    return { original, copy };
  });
  // Record the template origin for each independent copy.
  for (const { original, copy } of created) {
    const after = s.taskCards!.find((t) => t.uuid === copy.uuid)!;
    s.audit.unshift({
      uuid: crypto.randomUUID(),
      programUuid: s.aircraft.find((a) => a.uuid === order.aircraftUuid)
        ?.programUuid,
      actorId: s.user.id,
      at: now,
      action: "taskCard.created_from_template",
      entityUuid: copy.uuid,
      aircraftUuid: order.aircraftUuid,
      reason: `Copied ${original.cardNumber} version ${original.version} to ${order.number}.`,
      after: JSON.stringify(after),
    });
  }
  return created.length;
}

export function workItemCompletionIssue(
  s: Snapshot,
  orderUuid: string,
  item: WorkOrder["tasks"][number],
) {
  const preparation = s.workOrders?.find(
    (w) => w.uuid === orderUuid,
  )?.templateCopy;
  if (preparation && preparation.status !== "completed")
    return "Finish preparing the job cards before completing this item.";
  const matches = (t: TaskCard) => taskCardMatchesWorkItem(t, item);
  const cards = (s.taskCards ?? []).filter(
    (t) => t.workOrderUuid === orderUuid && matches(t),
  );
  const missing = (s.taskCards ?? []).some(
    (t) =>
      isTaskTemplate(t) &&
      t.status !== "canceled" &&
      matches(t) &&
      !cards.some((c) => c.sourceTaskCardUuid === t.uuid),
  );
  // Existing copies remain fixed even when the template library gains tasks later.
  if (!cards.length && missing)
    return "Add the associated job card templates to this work order before completing this item.";
  if (
    cards.some(
      (t) =>
        t.status !== "completed" ||
        !t.technicianSignoff ||
        (t.inspectionSignoffRequired && !t.inspectionSignoff),
    )
  )
    return "Complete and sign off every job card for this item on this work order before marking it completed.";
  return "";
}

export function taskCardMatchesWorkItem(
  t: TaskCard,
  item: WorkOrder["tasks"][number],
): boolean {
  return (
    t.workTaskUuid === item.uuid ||
    (item.source.kind === "inspection" &&
      t.inspectionUuid === item.source.uuid) ||
    (item.source.kind === "componentRequirement" &&
      t.requirementUuid === item.source.uuid) ||
    (item.source.kind === "discrepancy" &&
      t.discrepancyUuid === item.source.uuid)
  );
}
