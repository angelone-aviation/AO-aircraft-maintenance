/**
 * Responsibility: Creates the parts requests that recurring parts lists owe a
 *   work order's open tasks, as the work order is saved.
 * Layer: Server. Mutation helper inside the work-order transactions; the
 *   caller writes the change-log entries it returns.
 * Dependencies: src/domain/partsRequests (the rule and what it needs loaded),
 *   convex/collections (codec), convex/programContext and convex/workingSet
 *   (loaders), src/domain types.
 */
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { AuditEntry, Snapshot } from "../src/domain/model";
import type { WorkOrder } from "../src/domain/workOrders";
import {
  generateRecurringRequests,
  recurringPartsNeeds,
} from "../src/domain/partsRequests";
import type { ManagedRecord } from "../src/domain/management";
import { airworthinessDocs } from "./programContext";
import { partsRequestDocsOn } from "./workingSet";
import { decode, encode } from "./collections";

type Needs = ReturnType<typeof recurringPartsNeeds>;

/**
 * Inserts a parts request for each open task of a work order that an active
 * recurring list on its aircraft covers and has not served yet. It reads only
 * the requests raised on the order or on its items' records (the lists among
 * them), the program's highest-numbered request, and the sources of the tasks
 * still owed one.
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
  const requests = decode(
    "partsRequests",
    await partsRequestDocsOn(ctx, program, {
      workOrderUuids: [order.uuid],
      sourceUuids: order.tasks.map((t) => t.source.uuid),
    }),
  );
  const needs = recurringPartsNeeds(order, requests);
  if (!owesAny(needs)) return [];
  const s: Snapshot = {
    ...state,
    partsRequests: requests,
    ...(await loadSources(ctx, state, order, needs)),
    audit: [],
  };
  for (const r of generateRecurringRequests(s, order))
    await ctx.db.insert("partsRequests", encode("partsRequests", r));
  return s.audit;
}

// A recurring list is saved only for an inspection, component requirement or
// AD task (normalizeDraft), so a task it owes always needs one loaded.
function owesAny(needs: Needs): boolean {
  return (
    needs.inspections.length > 0 ||
    needs.requirements.length > 0 ||
    needs.airworthiness
  );
}

// Only the owed tasks' inspections and component requirements are loaded,
// and ADs only when an AD task is owed.
async function loadSources(
  ctx: MutationCtx,
  state: Snapshot,
  order: WorkOrder,
  needs: Needs,
): Promise<Pick<Snapshot, "inspections" | "management" | "airworthiness">> {
  const inspections = await loadInspections(ctx, needs.inspections);
  const requirements = await loadRequirementRecords(ctx, needs.requirements);
  const airworthiness = needs.airworthiness
    ? (state.airworthiness ??
      decode(
        "airworthiness",
        await airworthinessDocs(ctx, [{ uuid: order.aircraftUuid }]),
      ))
    : [];
  const management = [...(state.management ?? []), ...requirements];
  return { inspections, management, airworthiness };
}

async function loadInspections(
  ctx: MutationCtx,
  uuids: string[],
): Promise<Doc<"inspections">[]> {
  const inspections = [];
  for (const uuid of uuids) {
    const d = await ctx.db
      .query("inspections")
      .withIndex("uuid", (q) => q.eq("uuid", uuid))
      .unique();
    if (d) inspections.push(d);
  }
  return inspections;
}

async function loadRequirementRecords(
  ctx: MutationCtx,
  uuids: string[],
): Promise<ManagedRecord[]> {
  const records = [];
  for (const uuid of uuids) {
    const d = await ctx.db
      .query("management")
      .withIndex("uuid", (q) => q.eq("uuid", uuid))
      .unique();
    if (d) records.push(...decode("management", [d]));
  }
  return records;
}
