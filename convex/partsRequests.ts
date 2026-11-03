import { adSchema } from "../src/domain/airworthiness";
import { generateRecurringRequests } from "../src/domain/recurringParts";
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import {
  checkContext,
  managementDocs,
  inspectionDocs,
  taskCardDocs,
  workOrderDocs,
  discrepancyDocs,
  airworthinessDocs,
  partsRequestDocs,
  purchaseOrderDocs,
} from "./programContext";
import {
  applyRequestCommand,
  partsRequestSchema,
} from "../src/domain/partsRequests";
import { poSchema } from "../src/domain/purchaseOrders";
import { recordSchema } from "../src/domain/management";
import { workOrderSchema } from "../src/domain/workOrders";
import { taskCardSchema } from "../src/domain/taskCards";
import type { Snapshot } from "../src/domain/model";
export const execute = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const state = await checkContext(ctx, args.programUuid);
    const documents = await managementDocs(ctx, args.programUuid);
    const requests = await partsRequestDocs(ctx, args.programUuid);
    const s: Snapshot = {
      ...state,
      management: documents.map((d) =>
        recordSchema.parse(JSON.parse(d.payload)),
      ),
      partsRequests: requests.map((d) =>
        partsRequestSchema.parse(JSON.parse(d.payload)),
      ),
      purchaseOrders: (await purchaseOrderDocs(ctx, args.programUuid)).map(
        (d) => poSchema.parse(JSON.parse(d.payload)),
      ),
      workOrders: (await workOrderDocs(ctx, state.aircraft)).map((d) =>
        workOrderSchema.parse(JSON.parse(d.payload)),
      ),
      taskCards: (await taskCardDocs(ctx, state.aircraft)).map((d) =>
        taskCardSchema.parse(JSON.parse(d.payload)),
      ),
      airworthiness: (await airworthinessDocs(ctx, state.aircraft)).map((d) =>
        adSchema.parse(JSON.parse(d.payload)),
      ),
      inspections: await inspectionDocs(ctx, state.aircraft, documents),
      discrepancies: await discrepancyDocs(ctx, state.aircraft),
    };
    const r = applyRequestCommand(s, JSON.parse(args.payload));
    const previous = requests.find((d) => d.uuid === r.uuid);
    const fields = {
      uuid: r.uuid,
      programUuid: r.programUuid,
      payload: JSON.stringify(r),
    };
    if (previous) await ctx.db.replace(previous._id, fields);
    else if (
      await ctx.db
        .query("partsRequests")
        .withIndex("uuid", (q) => q.eq("uuid", r.uuid))
        .first()
    )
      throw new Error("Request identifier already used.");
    else await ctx.db.insert("partsRequests", fields);
    if (r.recurring && !r.cancelled) {
      for (const order of s.workOrders ?? []) {
        if (order.aircraftUuid !== r.aircraftUuid) continue;
        for (const created of generateRecurringRequests(s, order))
          await ctx.db.insert("partsRequests", {
            uuid: created.uuid,
            programUuid: created.programUuid,
            payload: JSON.stringify(created),
          });
      }
    }
    for (const record of s.management ?? []) {
      const prior = documents.find((d) => d.uuid === record.uuid);
      const payload = JSON.stringify(record);
      if (prior && prior.payload !== payload)
        await ctx.db.patch(prior._id, { payload });
    }
    for (const a of s.audit)
      await ctx.db.insert("audit", { ...a, programUuid: args.programUuid });
    return r.uuid;
  },
});
