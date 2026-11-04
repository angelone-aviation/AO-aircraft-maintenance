/**
 * Responsibility: Creates the parts requests that recurring parts lists owe a
 *   work order's open tasks, as the work order is saved.
 * Layer: Server. Mutation helper inside the work-order transactions; the
 *   caller writes the change-log entries it returns.
 * Dependencies: src/domain/recurringParts (the rule), the partsRequests,
 *   airworthiness and management schemas, convex/programContext (loaders).
 */
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { AuditEntry, Snapshot } from "../src/domain/model";
import type { WorkOrder, WorkTask } from "../src/domain/workOrders";
import {
  partsRequestSchema,
  type PartsRequest,
} from "../src/domain/partsRequests";
import { generateRecurringRequests } from "../src/domain/recurringParts";
import { adSchema } from "../src/domain/airworthiness";
import { recordSchema, type ManagedRecord } from "../src/domain/management";
import { airworthinessDocs, partsRequestDocs } from "./programContext";

const FINISHED_STATUSES = ["completed", "cancelled"];

/**
 * Inserts a parts request for each open task of a work order that an active
 * recurring list on its aircraft covers and has not served yet. It reads only
 * the program's requests, plus the sources of the tasks still owed one.
 *
 * @param ctx - Mutation context; inserts into partsRequests.
 * @param state - The caller's program context.
 * @param order - The work order as it will be saved.
 * @returns A `partsRequest.recurring` change-log entry per new request, for
 *   the caller to write; none for a completed or cancelled work order.
 */
export async function prepareRecurringParts(
  ctx: MutationCtx,
  state: Snapshot,
  order: WorkOrder,
): Promise<AuditEntry[]> {
  const program = state.aircraft.find(
    (a) => a.uuid === order.aircraftUuid,
  )?.programUuid;
  if (!program) return [];
  const requests = (await partsRequestDocs(ctx, program)).map((d) =>
    partsRequestSchema.parse(JSON.parse(d.payload)),
  );
  const pending = order.tasks.filter((task) =>
    isOwedOccurrence(requests, order, task),
  );
  if (!pending.length || FINISHED_STATUSES.includes(order.status)) return [];
  const s: Snapshot = {
    ...state,
    partsRequests: requests,
    ...(await loadSources(ctx, state, order, pending)),
    audit: [],
  };
  for (const r of generateRecurringRequests(s, order)) {
    await ctx.db.insert("partsRequests", {
      uuid: r.uuid,
      programUuid: r.programUuid,
      payload: JSON.stringify(r),
    });
  }
  return s.audit;
}

// Owed: an open task that an active recurring list on the aircraft covers,
// with no occurrence of that list for this task and work order yet.
function isOwedOccurrence(
  requests: PartsRequest[],
  order: WorkOrder,
  task: WorkTask,
): boolean {
  if (FINISHED_STATUSES.includes(task.status)) return false;
  return requests.some(
    (r) =>
      r.recurring &&
      !r.cancelled &&
      r.aircraftUuid === order.aircraftUuid &&
      r.source.kind === task.source.kind &&
      r.source.uuid === task.source.uuid &&
      !requests.some(
        (instance) =>
          instance.templateUuid === r.uuid &&
          instance.source.uuid === task.uuid &&
          instance.source.workOrderUuid === order.uuid,
      ),
  );
}

// Only the owed tasks' inspections and component requirements are loaded,
// and ADs only when an AD task is owed.
async function loadSources(
  ctx: MutationCtx,
  state: Snapshot,
  order: WorkOrder,
  pending: WorkTask[],
): Promise<Pick<Snapshot, "inspections" | "management" | "airworthiness">> {
  const inspections = await loadInspections(ctx, pending);
  const requirements = await loadRequirementRecords(ctx, pending);
  const airworthiness = pending.some((t) => t.source.kind === "airworthiness")
    ? (state.airworthiness ??
      (await airworthinessDocs(ctx, [{ uuid: order.aircraftUuid }])).map((d) =>
        adSchema.parse(JSON.parse(d.payload)),
      ))
    : [];
  const management = [...(state.management ?? []), ...requirements];
  return { inspections, management, airworthiness };
}

async function loadInspections(
  ctx: MutationCtx,
  tasks: WorkTask[],
): Promise<Doc<"inspections">[]> {
  const inspections = [];
  for (const task of tasks) {
    if (task.source.kind !== "inspection") continue;
    const d = await ctx.db
      .query("inspections")
      .withIndex("uuid", (q) => q.eq("uuid", task.source.uuid))
      .unique();
    if (d) inspections.push(d);
  }
  return inspections;
}

async function loadRequirementRecords(
  ctx: MutationCtx,
  tasks: WorkTask[],
): Promise<ManagedRecord[]> {
  const records = [];
  for (const task of tasks) {
    if (task.source.kind !== "componentRequirement") continue;
    const d = await ctx.db
      .query("management")
      .withIndex("uuid", (q) => q.eq("uuid", task.source.uuid))
      .unique();
    if (d) records.push(recordSchema.parse(JSON.parse(d.payload)));
  }
  return records;
}
