import { v } from "convex/values";
import {
  mutation,
  action,
  internalQuery,
  internalMutation,
  type QueryCtx,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import {
  checkContext,
  managementDocs,
  inspectionDocs,
  taskCardDocs,
  workOrderDocs,
  discrepancyDocs,
} from "./programContext";
import { authorized, audit } from "./access";
import {
  assertAttachmentRoom,
  deleteBlobIfUnused,
  MAX_ATTACHMENTS,
} from "./attachments";
import { recordSchema } from "../src/domain/management";
import {
  workOrderSchema,
  validateWorkOrderFile,
} from "../src/domain/workOrders";
import {
  saveTaskCard,
  taskCardSchema,
  taskCardCommandSchema,
  taskWritable,
  evidenceRemovable,
} from "../src/domain/taskCards";
async function taskState(ctx: QueryCtx | MutationCtx, programUuid?: string) {
  const state = await checkContext(ctx, programUuid);
  const management = await managementDocs(ctx, programUuid);
  return {
    ...state,
    taskCards: (await taskCardDocs(ctx, state.aircraft)).map((t) =>
      taskCardSchema.parse(JSON.parse(t.payload)),
    ),
    workOrders: (await workOrderDocs(ctx, state.aircraft)).map((w) =>
      workOrderSchema.parse(JSON.parse(w.payload)),
    ),
    inspections: await inspectionDocs(ctx, state.aircraft, management),
    discrepancies: await discrepancyDocs(ctx, state.aircraft),
    management: management.map((r) =>
      recordSchema.parse(JSON.parse(r.payload)),
    ),
  };
}
export const save = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const state = await taskState(ctx, args.programUuid);
    const command = taskCardCommandSchema.parse(JSON.parse(args.payload));
    const archived = await ctx.db
      .query("archivedTaskCards")
      .withIndex("uuid", (q) => q.eq("uuid", command.uuid))
      .unique();
    if (archived) throw new Error("Archived job cards are read-only.");
    const before = state.taskCards.find((t) => t.uuid === command.uuid);
    const next = saveTaskCard(state, command);
    const existing = await ctx.db
      .query("taskCards")
      .withIndex("uuid", (q) => q.eq("uuid", next.uuid))
      .unique();
    const fields = {
      uuid: next.uuid,
      aircraftUuid: next.aircraftUuid,
      payload: JSON.stringify(next),
    };
    // A uuid outside the active program is never overwritten.
    if (existing && !before) throw new Error("Job card not found.");
    if (existing) await ctx.db.replace(existing._id, fields);
    else await ctx.db.insert("taskCards", fields);
    await audit(ctx, state.user.id, "taskCard." + command.action, next.uuid, {
      aircraftUuid: next.aircraftUuid,
      before,
      after: next,
    });
    return next.uuid;
  },
});
const fileArgs = {
  taskCardUuid: v.string(),
  programUuid: v.optional(v.string()),
};
const category = v.union(
  v.literal("photo"),
  v.literal("supporting-document"),
  v.literal("parts-traceability"),
);
export const checkUpload = internalQuery({
  args: fileArgs,
  handler: async (ctx, args) => {
    const s = await taskState(ctx, args.programUuid);
    const t = s.taskCards.find((t) => t.uuid === args.taskCardUuid);
    if (!t || !taskWritable(s, t))
      throw new Error("An open job card and maintenance access are required.");
    return (await authorized(ctx, t.aircraftUuid, "maintenance", s))._id;
  },
});
export const finishUpload = internalMutation({
  args: {
    ...fileArgs,
    storageId: v.id("_storage"),
    name: v.string(),
    size: v.number(),
    category,
  },
  handler: async (ctx, args) => {
    const s = await taskState(ctx, args.programUuid);
    const t = s.taskCards.find((t) => t.uuid === args.taskCardUuid);
    if (!t || !taskWritable(s, t))
      throw new Error("An open job card and maintenance access are required.");
    assertAttachmentRoom(
      await ctx.db
        .query("taskEvidence")
        .withIndex("taskCard", (q) => q.eq("taskCardUuid", t.uuid))
        .take(MAX_ATTACHMENTS),
    );
    const before = { ...t };
    const { programUuid: _program, ...fields } = args;
    await ctx.db.insert("taskEvidence", { ...fields, uploadedAt: Date.now() });
    t.technicianSignoff = null;
    t.inspectionSignoff = null;
    t.stepSignoffs = {};
    t.version++;
    t.updatedAt = Date.now();
    const doc = await ctx.db
      .query("taskCards")
      .withIndex("uuid", (q) => q.eq("uuid", t.uuid))
      .unique();
    await ctx.db.patch(doc!._id, { payload: JSON.stringify(t) });
    await audit(ctx, s.user.id, "taskCard.evidence", t.uuid, {
      aircraftUuid: t.aircraftUuid,
      before,
      after: { ...t, evidenceName: args.name, category: args.category },
    });
  },
});
export const upload = action({
  args: {
    ...fileArgs,
    name: v.string(),
    type: v.string(),
    bytes: v.bytes(),
    category,
  },
  handler: async (ctx, args): Promise<void> => {
    validateWorkOrderFile(args.name, args.type, args.bytes.byteLength);
    await ctx.runQuery(internal.taskCards.checkUpload, {
      taskCardUuid: args.taskCardUuid,
      programUuid: args.programUuid,
    });
    const storageId = await ctx.storage.store(
      new Blob([args.bytes], { type: args.type }),
    );
    try {
      await ctx.runMutation(internal.taskCards.finishUpload, {
        taskCardUuid: args.taskCardUuid,
        programUuid: args.programUuid,
        storageId,
        name: args.name,
        size: args.bytes.byteLength,
        category: args.category,
      });
    } catch (e) {
      await ctx.storage.delete(storageId);
      throw e;
    }
  },
});
export const removeEvidence = mutation({
  args: { id: v.id("taskEvidence"), programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const file = await ctx.db.get(args.id);
    if (!file) throw new Error("Evidence not found.");
    const s = await taskState(ctx, args.programUuid);
    const t = s.taskCards.find((t) => t.uuid === file.taskCardUuid);
    if (!t) throw new Error("Evidence not found.");
    await authorized(ctx, t.aircraftUuid, "maintenance", s);
    if (!evidenceRemovable(s, t))
      throw new Error(
        "Evidence can be deleted only from an open, unsigned job card.",
      );
    await ctx.db.delete(file._id);
    await deleteBlobIfUnused(ctx, file.storageId);
    await audit(ctx, s.user.id, "taskCard.evidence_removed", t.uuid, {
      aircraftUuid: t.aircraftUuid,
      before: { name: file.name, category: file.category },
    });
  },
});
