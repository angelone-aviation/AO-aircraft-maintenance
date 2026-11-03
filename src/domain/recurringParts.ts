import { localDate, type Snapshot } from "./model";
import type { WorkOrder } from "./workOrders";
import { partsRequestSchema, recurringRequestSource } from "./partsRequests";

/** One immutable occurrence identity per recurring list and saved work task. */
export function generateRecurringRequests(
  s: Snapshot,
  order: WorkOrder,
  now = Date.now(),
) {
  if (["completed", "cancelled"].includes(order.status)) return [];
  const requests = (s.partsRequests ??= []);
  const program = s.aircraft.find(
    (a) => a.uuid === order.aircraftUuid,
  )?.programUuid;
  const templates = requests.filter(
    (r) =>
      r.recurring &&
      !r.cancelled &&
      r.programUuid === program &&
      r.aircraftUuid === order.aircraftUuid,
  );
  let number = Math.max(
    0,
    ...requests
      .filter((r) => r.programUuid === program)
      .map((r) => Number(r.number.slice(3)) || 0),
  );
  const created = [];
  for (const template of templates) {
    const source = recurringRequestSource(s, template.source);
    if (!source) continue;
    for (const task of order.tasks) {
      if (
        ["completed", "cancelled"].includes(task.status) ||
        task.source.kind !== source.kind ||
        task.source.uuid !== source.uuid
      )
        continue;
      const uuid = crypto.randomUUID();
      // Include cancelled instances: cancellation must never silently reorder parts.
      if (
        requests.some(
          (r) =>
            r.templateUuid === template.uuid &&
            r.source.uuid === task.uuid &&
            r.source.workOrderUuid === order.uuid,
        )
      )
        continue;
      const r = partsRequestSchema.parse({
        ...structuredClone(template),
        uuid,
        version: 1,
        recurring: false,
        templateUuid: template.uuid,
        source: {
          kind: "workTask",
          uuid: task.uuid,
          workOrderUuid: order.uuid,
        },
        sourceLabel: `${order.number}: ${task.description}`.slice(0, 4000),
        number: `PR-${String(++number).padStart(5, "0")}`,
        date: localDate(now),
        requiredBy: "",
        requesterId: s.user.id,
        createdAt: now,
        updatedAt: now,
        reservations: [],
        issues: [],
        cancelled: false,
        history: [
          {
            requestUuid: uuid,
            at: now,
            actorId: s.user.id,
            action: "recurring occurrence",
            detail: `Created from ${template.number} for ${order.number}`,
          },
        ],
      });
      requests.push(r);
      created.push(r);
      s.audit.unshift({
        uuid,
        at: now,
        actorId: s.user.id,
        action: "partsRequest.recurring",
        entityUuid: uuid,
        aircraftUuid: order.aircraftUuid,
        programUuid: program,
        after: JSON.stringify(r),
      });
    }
  }
  return created;
}
