/**
 * Responsibility: Turns recurring parts lists into one parts request per
 *   open work-order task that performs the list's source, and says which
 *   sources a server must load to do so.
 * Layer: Domain. Applier on a working snapshot; no I/O, no React.
 * Dependencies: src/domain/model.ts, partsRequests.ts; workOrders.ts (types).
 */
import { localDate, type Snapshot } from "./model";
import type { WorkOrder, WorkTask } from "./workOrders";
import {
  partsRequestSchema,
  recurringRequestSource,
  type PartsRequest,
} from "./partsRequests";

const CLOSED_WORK_STATUSES: readonly string[] = ["completed", "cancelled"];
// partsRequestSchema's text limit: a longer label would fail to parse.
const SOURCE_LABEL_MAX_LENGTH = 4000;

/**
 * Creates the parts requests a work order's open tasks need from the
 * recurring lists of its aircraft: one occurrence per list and task, copied
 * from the list as it is now. An occurrence is created once, even if later
 * cancelled, so cancelling never silently reorders parts.
 *
 * @param s - The working snapshot; gains the requests, each with one
 *   "partsRequest.recurring" change-log row.
 * @param order - The saved work order; a completed or cancelled one gets none.
 * @param now - The creation time.
 * @returns The new requests, numbered on from the program's highest PR number.
 * @throws {z.ZodError} When a copied request fails partsRequestSchema.
 */
export function generateRecurringRequests(
  s: Snapshot,
  order: WorkOrder,
  now = Date.now(),
) {
  if (isClosed(order)) return [];
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
  const nextNumber = createNumberer(requests, program);
  const run: Run = { s, requests, order, program, now, nextNumber };
  const created: PartsRequest[] = [];
  for (const template of templates) {
    const source = recurringRequestSource(s, template.source);
    if (!source) continue;
    const tasks = order.tasks.filter(
      (t) =>
        !isClosed(t) &&
        t.source.kind === source.kind &&
        t.source.uuid === source.uuid,
    );
    created.push(...addOccurrences(run, template, tasks));
  }
  return created;
}

/**
 * What must be loaded before {@link generateRecurringRequests} can serve a
 * work order: the sources of its open tasks that an active recurring list on
 * its aircraft covers and has not served yet.
 *
 * @param order - The work order as it will be saved.
 * @param requests - The Flight Program's parts requests, lists included.
 * @returns The inspection and component-requirement uuids those tasks
 *   perform, each once, in task order, and whether any performs an AD task;
 *   none for a completed or cancelled work order.
 */
export function recurringPartsNeeds(
  order: WorkOrder,
  requests: PartsRequest[],
) {
  const owed = isClosed(order)
    ? []
    : order.tasks.filter((task) => isOwed(requests, order, task));
  const sources = (kind: WorkTask["source"]["kind"]) => [
    ...new Set(
      owed.filter((t) => t.source.kind === kind).map((t) => t.source.uuid),
    ),
  ];
  return {
    inspections: sources("inspection"),
    requirements: sources("componentRequirement"),
    airworthiness: owed.some((t) => t.source.kind === "airworthiness"),
  };
}

// One generation pass over a work order.
interface Run {
  s: Snapshot;
  requests: PartsRequest[];
  order: WorkOrder;
  program: string | undefined;
  now: number;
  nextNumber: () => string;
}

// Continues from the program's highest number: "PR-00012" is followed by
// "PR-00013".
function createNumberer(requests: PartsRequest[], program: string | undefined) {
  let number = Math.max(
    0,
    ...requests
      .filter((r) => r.programUuid === program)
      .map((r) => Number(r.number.slice(3)) || 0),
  );
  return () => `PR-${String(++number).padStart(5, "0")}`;
}

function addOccurrences(
  run: Run,
  template: PartsRequest,
  tasks: WorkTask[],
): PartsRequest[] {
  const { s, requests, order, program, now } = run;
  const created: PartsRequest[] = [];
  for (const task of tasks) {
    if (hasOccurrence(requests, template, order, task)) continue;
    const r = copyTemplate(run, template, task);
    requests.push(r);
    created.push(r);
    s.audit.unshift({
      uuid: r.uuid,
      at: now,
      actorId: s.user.id,
      action: "partsRequest.recurring",
      entityUuid: r.uuid,
      aircraftUuid: order.aircraftUuid,
      programUuid: program,
      after: JSON.stringify(r),
    });
  }
  return created;
}

function copyTemplate(
  { s, order, now, nextNumber }: Run,
  template: PartsRequest,
  task: WorkTask,
): PartsRequest {
  const uuid = crypto.randomUUID();
  return partsRequestSchema.parse({
    ...structuredClone(template),
    uuid,
    version: 1,
    recurring: false,
    templateUuid: template.uuid,
    source: { kind: "workTask", uuid: task.uuid, workOrderUuid: order.uuid },
    sourceLabel: `${order.number}: ${task.description}`.slice(
      0,
      SOURCE_LABEL_MAX_LENGTH,
    ),
    number: nextNumber(),
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
}

// A list's stored source is the recurring item itself (applyRequestCommand
// normalizes it on save), so it is matched here without loading that item.
function isOwed(requests: PartsRequest[], order: WorkOrder, task: WorkTask) {
  if (isClosed(task)) return false;
  return requests.some(
    (r) =>
      r.recurring &&
      !r.cancelled &&
      r.aircraftUuid === order.aircraftUuid &&
      r.source.kind === task.source.kind &&
      r.source.uuid === task.source.uuid &&
      !hasOccurrence(requests, r, order, task),
  );
}

// Cancelled occurrences count too: cancellation must never silently reorder
// parts.
function hasOccurrence(
  requests: PartsRequest[],
  template: PartsRequest,
  order: WorkOrder,
  task: WorkTask,
) {
  return requests.some(
    (r) =>
      r.templateUuid === template.uuid &&
      r.source.uuid === task.uuid &&
      r.source.workOrderUuid === order.uuid,
  );
}

function isClosed({ status }: { status: string }) {
  return CLOSED_WORK_STATUSES.includes(status);
}
