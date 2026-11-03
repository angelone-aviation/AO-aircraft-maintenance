import { mutation, type QueryCtx } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import {
  checkContext,
  managementDocs,
  partsRequestDocs,
  perAircraft,
  taskCardDocs,
  archivedTaskCardDocs,
} from "./programContext";
import {
  applyCostCommand,
  costCommandSchema,
  costRecordSchema,
} from "../src/domain/costs";
import { workOrderSchema } from "../src/domain/workOrders";
import { recordSchema } from "../src/domain/management";
import { partsRequestSchema } from "../src/domain/partsRequests";
import { taskCardSchema } from "../src/domain/taskCards";
import type { Snapshot } from "../src/domain/model";
// Cost rows for the program's aircraft plus the program's settings row.
export async function costDocs(
  ctx: QueryCtx,
  programUuid: string | undefined,
  aircraft: { uuid: string }[],
) {
  const rows = await perAircraft(aircraft, (id) =>
    ctx.db
      .query("costs")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", id))
      .collect(),
  );
  const settings = programUuid
    ? await ctx.db
        .query("costs")
        .withIndex("program", (q) =>
          q.eq("programUuid", programUuid).eq("aircraftUuid", ""),
        )
        .collect()
    : [];
  return [...rows, ...settings];
}
export const execute = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const state = await checkContext(ctx, args.programUuid);
    const command = costCommandSchema.parse(JSON.parse(args.payload));
    const docs = await costDocs(ctx, args.programUuid, state.aircraft);
    const s: Snapshot = {
      ...state,
      costs: docs.map((d) => costRecordSchema.parse(JSON.parse(d.payload))),
    };
    if ("workOrderUuid" in command) {
      const order = await ctx.db
        .query("workOrders")
        .withIndex("uuid", (q) => q.eq("uuid", command.workOrderUuid))
        .unique();
      // The domain rejects orders whose aircraft is outside this program.
      s.workOrders = order
        ? [workOrderSchema.parse(JSON.parse(order.payload))]
        : [];
      if (command.action === "part.unitCost" && order) {
        const aircraft = [{ uuid: order.aircraftUuid }];
        s.management = (await managementDocs(ctx, args.programUuid)).map((d) =>
          recordSchema.parse(JSON.parse(d.payload)),
        );
        s.partsRequests = (await partsRequestDocs(ctx, args.programUuid)).map(
          (d) => partsRequestSchema.parse(JSON.parse(d.payload)),
        );
        s.taskCards = (await taskCardDocs(ctx, aircraft)).map((d) =>
          taskCardSchema.parse(JSON.parse(d.payload)),
        );
        s.archivedTaskCards = (await archivedTaskCardDocs(ctx, aircraft)).map(
          (d) => taskCardSchema.parse(JSON.parse(d.payload)),
        );
      }
    }
    let next;
    try {
      next = applyCostCommand(s, command);
    } catch (error) {
      // Explicit domain validation messages are safe, actionable feedback.
      if (error instanceof Error && error.constructor === Error)
        throw new ConvexError(error.message);
      throw error;
    }
    const fields = {
      uuid: next.uuid,
      programUuid: next.programUuid,
      aircraftUuid: next.kind === "settings" ? "" : next.aircraftUuid,
      payload: JSON.stringify(next),
    };
    const prior = docs.find((d) => d.uuid === next.uuid);
    if (prior) {
      if (prior.payload !== fields.payload)
        await ctx.db.replace(prior._id, fields);
    } else if (
      await ctx.db
        .query("costs")
        .withIndex("uuid", (q) => q.eq("uuid", next.uuid))
        .first()
    )
      // A uuid outside the active program is never overwritten.
      throw new ConvexError("Cost record belongs to another Flight Program.");
    else await ctx.db.insert("costs", fields);
    if (prior?.payload !== fields.payload)
      for (const a of s.audit) await ctx.db.insert("audit", a);
    return next.uuid;
  },
});
