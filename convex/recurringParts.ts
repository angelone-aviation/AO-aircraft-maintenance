import type { MutationCtx } from "./_generated/server";
import type { Snapshot } from "../src/domain/model";
import type { WorkOrder } from "../src/domain/workOrders";
import { partsRequestSchema } from "../src/domain/partsRequests";
import { generateRecurringRequests } from "../src/domain/recurringParts";
import { adSchema } from "../src/domain/airworthiness";
import { recordSchema } from "../src/domain/management";
import { airworthinessDocs } from "./programContext";

// Keep request reads program-scoped and load only sources needing a new occurrence.
export async function prepareRecurringParts(
  ctx: MutationCtx,
  state: Snapshot,
  order: WorkOrder,
) {
  const program = state.aircraft.find(
    (a) => a.uuid === order.aircraftUuid,
  )?.programUuid;
  if (!program) return;
  const docs = await ctx.db
    .query("partsRequests")
    .withIndex("program", (q) => q.eq("programUuid", program))
    .collect();
  const requests = docs.map((d) =>
    partsRequestSchema.parse(JSON.parse(d.payload)),
  );
  const pending = order.tasks.filter(
    (task) =>
      !["completed", "cancelled"].includes(task.status) &&
      requests.some(
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
      ),
  );
  if (!pending.length || ["completed", "cancelled"].includes(order.status))
    return;
  const inspections = [];
  const management = [...(state.management ?? [])];
  for (const task of pending) {
    if (task.source.kind === "inspection") {
      const d = await ctx.db
        .query("inspections")
        .withIndex("uuid", (q) => q.eq("uuid", task.source.uuid))
        .unique();
      if (d) inspections.push(d);
    }
    if (task.source.kind === "componentRequirement") {
      const d = await ctx.db
        .query("management")
        .withIndex("uuid", (q) => q.eq("uuid", task.source.uuid))
        .unique();
      if (d) management.push(recordSchema.parse(JSON.parse(d.payload)));
    }
  }
  const airworthiness = pending.some((t) => t.source.kind === "airworthiness")
    ? (state.airworthiness ??
      (await airworthinessDocs(ctx, [{ uuid: order.aircraftUuid }])).map((d) =>
        adSchema.parse(JSON.parse(d.payload)),
      ))
    : [];
  const s: Snapshot = {
    ...state,
    partsRequests: requests,
    inspections,
    management,
    airworthiness,
    audit: [],
  };
  for (const r of generateRecurringRequests(s, order)) {
    await ctx.db.insert("partsRequests", {
      uuid: r.uuid,
      programUuid: r.programUuid,
      payload: JSON.stringify(r),
    });
  }
  for (const a of s.audit) await ctx.db.insert("audit", a);
}
