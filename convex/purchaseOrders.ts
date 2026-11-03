import { partsRequestSchema } from "../src/domain/partsRequests";
import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import {
  checkContext,
  managementDocs,
  inspectionDocs,
  workOrderDocs,
  partsRequestDocs,
  purchaseOrderDocs,
} from "./programContext";
import { assertNewManagementUuid } from "./management";
import { applyPOCommand, poSchema } from "../src/domain/purchaseOrders";
import { recordSchema } from "../src/domain/management";
import { workOrderSchema } from "../src/domain/workOrders";
import { programPermission } from "../src/domain/programs";
import type { Snapshot } from "../src/domain/model";
export const execute = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const state = await checkContext(ctx, args.programUuid);
    const documents = await managementDocs(ctx, args.programUuid);
    const requestDocs = await partsRequestDocs(ctx, args.programUuid);
    const pos = await purchaseOrderDocs(ctx, args.programUuid);
    const s: Snapshot = {
      ...state,
      partsRequests: requestDocs.map((d) =>
        partsRequestSchema.parse(JSON.parse(d.payload)),
      ),
      purchaseOrders: pos.map((p) => poSchema.parse(JSON.parse(p.payload))),
      management: documents.map((d) =>
        recordSchema.parse(JSON.parse(d.payload)),
      ),
      inspections: await inspectionDocs(ctx, state.aircraft, documents),
      workOrders: (await workOrderDocs(ctx, state.aircraft)).map((w) =>
        workOrderSchema.parse(JSON.parse(w.payload)),
      ),
    };
    const command = JSON.parse(args.payload);
    let changes;
    try {
      changes = applyPOCommand(s, command);
    } catch (error) {
      // Explicit domain validation messages are safe, actionable user feedback.
      // Unexpected parser/schema/runtime errors retain server-side details only.
      if (error instanceof Error && error.constructor === Error)
        throw new ConvexError(error.message);
      throw error;
    }
    for (const p of changes) {
      const prior = pos.find((d) => d.uuid === p.uuid);
      const fields = {
        uuid: p.uuid,
        programUuid: p.programUuid,
        payload: JSON.stringify(p),
      };
      if (prior) await ctx.db.replace(prior._id, fields);
      else if (
        await ctx.db
          .query("purchaseOrders")
          .withIndex("uuid", (q) => q.eq("uuid", p.uuid))
          .first()
      )
        throw new ConvexError("PO not found.");
      else await ctx.db.insert("purchaseOrders", fields);
    }
    for (const r of s.management ?? []) {
      const prior = documents.find((d) => d.uuid === r.uuid);
      const payload = JSON.stringify(r);
      if (prior?.payload === payload) continue;
      const fields = {
        uuid: r.uuid,
        programUuid: r.programUuid,
        kind: r.kind,
        aircraftUuid: "aircraftUuid" in r ? r.aircraftUuid : undefined,
        payload,
      };
      if (prior) await ctx.db.replace(prior._id, fields);
      else {
        await assertNewManagementUuid(ctx, r.uuid);
        await ctx.db.insert("management", fields);
      }
    }
    for (const r of s.partsRequests ?? []) {
      const prior = requestDocs.find((d) => d.uuid === r.uuid);
      if (prior && prior.payload !== JSON.stringify(r))
        await ctx.db.patch(prior._id, { payload: JSON.stringify(r) });
    }
    for (const a of s.audit)
      await ctx.db.insert("audit", { ...a, programUuid: args.programUuid });
    return changes.map((p) => p.uuid);
  },
});
export const files = query({
  args: { poUuid: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const s = await checkContext(ctx, args.programUuid);
    if (!programPermission(s, "admin"))
      throw Error("Inventory administrator access required.");
    const po = await ctx.db
      .query("purchaseOrders")
      .withIndex("uuid", (q) => q.eq("uuid", args.poUuid))
      .unique();
    if (!po || po.programUuid !== args.programUuid)
      throw Error("PO not found.");
    const files = await ctx.db
      .query("poFiles")
      .withIndex("po", (q) => q.eq("poUuid", args.poUuid))
      .collect();
    return Promise.all(
      files.map(async (f) => ({
        uuid: f._id,
        name: f.name,
        receiptUuid: f.receiptUuid,
        url: await ctx.storage.getUrl(f.storageId),
      })),
    );
  },
});
