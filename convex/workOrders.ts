import { prepareRecurringParts } from "./recurringParts";
import { ConvexError } from "convex/values";
import { can } from "../src/domain/model";
import { startCopy, queueTemplateCopies } from "./workOrderCopies";
import { adSchema } from "../src/domain/airworthiness";
import { taskCardSchema } from "../src/domain/taskCards";
import { v } from "convex/values";
import {
  mutation,
  action,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import { internal } from "./_generated/api";
import {
  checkContext,
  managementDocs,
  inspectionDocs,
  taskCardDocs,
  workOrderDocs,
  discrepancyDocs,
  airworthinessDocs,
} from "./programContext";
import { authorized, audit } from "./access";
import {
  assertAttachmentRoom,
  deleteBlobIfUnused,
  MAX_ATTACHMENTS,
} from "./attachments";
import { inspectionSchema, recordSchema } from "../src/domain/management";
import {
  saveWorkOrder,
  workOrderSchema,
  workOrderCommandSchema,
  isOpenWorkOrder,
  validateWorkOrderFile,
} from "../src/domain/workOrders";
export const save = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const state = await checkContext(ctx, args.programUuid);
    const command = workOrderCommandSchema.parse(JSON.parse(args.payload));
    if (
      command.action === "copyTemplates" ||
      (command.action === "add" && command.source.kind === "inspection")
    )
      return startCopy(ctx, state, command);
    const existing = await ctx.db
      .query("workOrders")
      .withIndex("uuid", (q) => q.eq("uuid", command.uuid))
      .unique();
    if (existing) {
      const order = workOrderSchema.parse(JSON.parse(existing.payload));
      if (!can(state, order.aircraftUuid, "maintenance"))
        throw new ConvexError("Work order maintenance access denied.");
      if (order.templateCopy && order.templateCopy.status !== "completed")
        throw new ConvexError(
          "Job cards are still being prepared. Finish or resume preparation before editing or closing this work order.",
        );
    }
    const documents = await workOrderDocs(ctx, state.aircraft);
    const orders = documents.map((w) =>
      workOrderSchema.parse(JSON.parse(w.payload)),
    );
    const aircraftUuid =
      command.action === "save"
        ? command.fields.aircraftUuid
        : orders.find((w) => w.uuid === command.uuid)?.aircraftUuid;
    if (!aircraftUuid) throw new Error("Work order not found.");
    const user = await authorized(ctx, aircraftUuid, "maintenance", state);
    const management = await managementDocs(ctx, args.programUuid);
    const working: import("../src/domain/model").Snapshot = {
      ...state,
      workOrders: orders,
      archivedTaskCards: [],
      airworthiness: (await airworthinessDocs(ctx, state.aircraft)).map((d) =>
        adSchema.parse(JSON.parse(d.payload)),
      ),
      taskCards: (await taskCardDocs(ctx, state.aircraft)).map((t) =>
        taskCardSchema.parse(JSON.parse(t.payload)),
      ),
      // Work order rules never read evidence; it stays out of the transaction.
      taskEvidence: [],
      inspections: await inspectionDocs(ctx, state.aircraft, management),
      discrepancies: await discrepancyDocs(ctx, state.aircraft),
      management: management.map((r) =>
        recordSchema.parse(JSON.parse(r.payload)),
      ),
    };
    const previousInspections = new Map(
      working.inspections.map((i) => [i.uuid, i.version]),
    );
    const previousManagement = new Map(
      working.management?.map((r) => [r.uuid, r.version]),
    );
    const previousCards = new Set(working.taskCards?.map((t) => t.uuid));
    let next = saveWorkOrder(working, command, Date.now(), {
      deferTemplateCopies: true,
    });
    await prepareRecurringParts(ctx, working, next);
    next = await queueTemplateCopies(
      ctx,
      next,
      existing
        ? workOrderSchema.parse(JSON.parse(existing.payload))
        : undefined,
      state,
    );
    for (const card of working.archivedTaskCards ?? []) {
      await ctx.db.insert("archivedTaskCards", {
        uuid: card.uuid,
        aircraftUuid: card.aircraftUuid,
        payload: JSON.stringify(card),
      });
    }
    const remainingCards = new Set(working.taskCards?.map((card) => card.uuid));
    for (const id of previousCards) {
      if (remainingCards.has(id)) continue;
      const doc = await ctx.db
        .query("taskCards")
        .withIndex("uuid", (q) => q.eq("uuid", id))
        .unique();
      if (doc) await ctx.db.delete(doc._id);
    }
    for (const card of working.taskCards ?? []) {
      if (!previousCards.has(card.uuid))
        await ctx.db.insert("taskCards", {
          uuid: card.uuid,
          aircraftUuid: card.aircraftUuid,
          payload: JSON.stringify(card),
        });
    }
    for (const inspection of working.inspections) {
      if (inspection.version === previousInspections.get(inspection.uuid))
        continue;
      const doc = await ctx.db
        .query("inspections")
        .withIndex("uuid", (q) => q.eq("uuid", inspection.uuid))
        .unique();
      if (!doc) throw new Error("Inspection not found during closeout.");
      await ctx.db.replace(
        doc._id,
        inspectionSchema.parse({
          ...inspection,
          materials: inspection.materials ?? "",
          archived: inspection.archived ?? false,
        }),
      );
    }
    for (const record of working.management ?? []) {
      if (record.version === previousManagement.get(record.uuid)) continue;
      const doc = await ctx.db
        .query("management")
        .withIndex("uuid", (q) => q.eq("uuid", record.uuid))
        .unique();
      if (!doc) {
        if (record.kind !== "componentMovement")
          throw new Error("Service requirement not found during closeout.");
        await ctx.db.insert("management", {
          uuid: record.uuid,
          programUuid: record.programUuid,
          aircraftUuid: record.aircraftUuid,
          kind: record.kind,
          payload: JSON.stringify(record),
        });
      } else
        await ctx.db.patch(doc._id, {
          aircraftUuid:
            "aircraftUuid" in record ? record.aircraftUuid : undefined,
          payload: JSON.stringify(record),
        });
    }
    for (const entry of working.audit)
      await audit(ctx, user._id, entry.action, entry.entityUuid, {
        programUuid: entry.programUuid,
        aircraftUuid: entry.aircraftUuid,
        reason: entry.reason,
        before: entry.before ? JSON.parse(entry.before) : undefined,
        after: entry.after ? JSON.parse(entry.after) : undefined,
      });

    const fields = {
      uuid: next.uuid,
      aircraftUuid: next.aircraftUuid,
      payload: JSON.stringify(next),
    };
    if (existing) await ctx.db.replace(existing._id, fields);
    else await ctx.db.insert("workOrders", fields);
    await audit(ctx, user._id, "workOrder." + command.action, next.uuid, {
      aircraftUuid: next.aircraftUuid,
      before: existing
        ? workOrderSchema.parse(JSON.parse(existing.payload))
        : undefined,
      after: next,
      reason:
        command.action === "revise" || command.action === "correctComponent"
          ? command.reason
          : undefined,
    });
    return next.uuid;
  },
});
const fileArgs = {
  workOrderUuid: v.string(),
  programUuid: v.optional(v.string()),
};
export const checkUpload = internalQuery({
  args: fileArgs,
  handler: async (ctx, args) => {
    const state = await checkContext(ctx, args.programUuid);
    const doc = await ctx.db
      .query("workOrders")
      .withIndex("uuid", (q) => q.eq("uuid", args.workOrderUuid))
      .unique();
    if (!doc) throw new Error("Work order not found.");
    const user = await authorized(ctx, doc.aircraftUuid, "maintenance", state);
    if (!isOpenWorkOrder(workOrderSchema.parse(JSON.parse(doc.payload))))
      throw new Error("This work order is closed.");
    return user._id;
  },
});
export const finishUpload = internalMutation({
  args: {
    ...fileArgs,
    storageId: v.id("_storage"),
    name: v.string(),
    size: v.number(),
  },
  handler: async (ctx, args) => {
    const state = await checkContext(ctx, args.programUuid);
    const doc = await ctx.db
      .query("workOrders")
      .withIndex("uuid", (q) => q.eq("uuid", args.workOrderUuid))
      .unique();
    if (!doc) throw new Error("Work order not found.");
    const user = await authorized(ctx, doc.aircraftUuid, "maintenance", state);
    if (!isOpenWorkOrder(workOrderSchema.parse(JSON.parse(doc.payload))))
      throw new Error("This work order is closed.");
    assertAttachmentRoom(
      await ctx.db
        .query("workOrderFiles")
        .withIndex("workOrder", (q) => q.eq("workOrderUuid", doc.uuid))
        .take(MAX_ATTACHMENTS),
    );
    const { programUuid: _program, ...fields } = args;
    await ctx.db.insert("workOrderFiles", {
      ...fields,
      uploadedAt: Date.now(),
    });
    await audit(ctx, user._id, "workOrder.attachment", doc.uuid, {
      aircraftUuid: doc.aircraftUuid,
      after: { name: args.name },
    });
  },
});
export const upload = action({
  args: { ...fileArgs, name: v.string(), type: v.string(), bytes: v.bytes() },
  handler: async (ctx, args): Promise<void> => {
    validateWorkOrderFile(args.name, args.type, args.bytes.byteLength);
    await ctx.runQuery(internal.workOrders.checkUpload, {
      workOrderUuid: args.workOrderUuid,
      programUuid: args.programUuid,
    });
    const storageId = await ctx.storage.store(
      new Blob([args.bytes], { type: args.type }),
    );
    try {
      await ctx.runMutation(internal.workOrders.finishUpload, {
        workOrderUuid: args.workOrderUuid,
        programUuid: args.programUuid,
        storageId,
        name: args.name,
        size: args.bytes.byteLength,
      });
    } catch (e) {
      await ctx.storage.delete(storageId);
      throw e;
    }
  },
});
export const removeFile = mutation({
  args: { id: v.id("workOrderFiles"), programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const state = await checkContext(ctx, args.programUuid);
    const file = await ctx.db.get(args.id);
    const doc =
      file &&
      (await ctx.db
        .query("workOrders")
        .withIndex("uuid", (q) => q.eq("uuid", file.workOrderUuid))
        .unique());
    if (!file || !doc) throw new Error("Attachment not found.");
    const user = await authorized(ctx, doc.aircraftUuid, "maintenance", state);
    if (!isOpenWorkOrder(workOrderSchema.parse(JSON.parse(doc.payload))))
      throw new Error("This work order is closed.");
    await ctx.db.delete(file._id);
    await deleteBlobIfUnused(ctx, file.storageId);
    await audit(ctx, user._id, "workOrder.attachment_removed", doc.uuid, {
      aircraftUuid: doc.aircraftUuid,
      before: { name: file.name },
    });
  },
});
