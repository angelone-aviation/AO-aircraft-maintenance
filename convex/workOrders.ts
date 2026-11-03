import { prepareRecurringParts } from "./recurringParts";
import { ConvexError } from "convex/values";
import { can, type Snapshot } from "../src/domain/model";
import { startCopy, queueTemplateCopies } from "./workOrderCopies";
import { v } from "convex/values";
import {
  mutation,
  action,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { checkContext } from "./programContext";
import { authorized, audit } from "./access";
import { runCommand, hydrate } from "./runCommand";
import {
  assertAttachmentRoom,
  deleteBlobIfUnused,
  MAX_ATTACHMENTS,
} from "./attachments";
import { inspectionSchema } from "../src/domain/management";
import {
  saveWorkOrder,
  workOrderSchema,
  workOrderCommandSchema,
  isOpenWorkOrder,
  validateWorkOrderFile,
} from "../src/domain/workOrders";
export const save = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: (ctx, args) =>
    runCommand(ctx, {
      programUuid: args.programUuid,
      parse: () => workOrderCommandSchema.parse(JSON.parse(args.payload)),
      // Template copies run as scheduled batches (workOrderCopies.ts).
      delegate: (state, command) =>
        command.action === "copyTemplates" ||
        (command.action === "add" && command.source.kind === "inspection")
          ? startCopy(ctx, state, command)
          : undefined,
      load: async ({ ctx, state }, command) => {
        const existing = await ctx.db
          .query("workOrders")
          .withIndex("uuid", (q) => q.eq("uuid", command.uuid))
          .unique();
        const previous = existing
          ? workOrderSchema.parse(JSON.parse(existing.payload))
          : undefined;
        if (previous) {
          if (!can(state, previous.aircraftUuid, "maintenance"))
            throw new ConvexError("Work order maintenance access denied.");
          if (
            previous.templateCopy &&
            previous.templateCopy.status !== "completed"
          )
            throw new ConvexError(
              "Job cards are still being prepared. Finish or resume preparation before editing or closing this work order.",
            );
        }
        const orders = await hydrate(ctx, state, ["workOrders"]);
        const aircraftUuid =
          command.action === "save"
            ? command.fields.aircraftUuid
            : orders.snapshot.workOrders!.find((w) => w.uuid === command.uuid)
                ?.aircraftUuid;
        if (!aircraftUuid) throw new Error("Work order not found.");
        await authorized(ctx, aircraftUuid, "maintenance", state);
        const { snapshot } = await hydrate(ctx, state, [
          "management",
          "airworthiness",
          "taskCards",
          "inspections",
          "discrepancies",
        ]);
        const working: Snapshot = {
          ...snapshot,
          workOrders: orders.snapshot.workOrders,
          archivedTaskCards: [],
          // Work order rules never read evidence; it stays out of the
          // transaction.
          taskEvidence: [],
        };
        return {
          working,
          existing,
          previous,
          previousInspections: new Map(
            working.inspections.map((i) => [i.uuid, i.version]),
          ),
          previousManagement: new Map(
            working.management?.map((r) => [r.uuid, r.version]),
          ),
          previousCards: new Set(working.taskCards?.map((t) => t.uuid)),
        };
      },
      apply: ({ working }, command) => ({
        next: saveWorkOrder(working, command, Date.now(), {
          deferTemplateCopies: true,
        }),
      }),
      persist: async ({ ctx, state, log }, loaded, result) => {
        const { working } = loaded;
        // Scheduling that must run between apply and persist.
        log.record(await prepareRecurringParts(ctx, working, result.next));
        result.next = await queueTemplateCopies(
          ctx,
          result.next,
          loaded.previous,
          state,
        );
        for (const card of working.archivedTaskCards ?? []) {
          await ctx.db.insert("archivedTaskCards", {
            uuid: card.uuid,
            aircraftUuid: card.aircraftUuid,
            payload: JSON.stringify(card),
          });
        }
        const remainingCards = new Set(
          working.taskCards?.map((card) => card.uuid),
        );
        for (const id of loaded.previousCards) {
          if (remainingCards.has(id)) continue;
          const doc = await ctx.db
            .query("taskCards")
            .withIndex("uuid", (q) => q.eq("uuid", id))
            .unique();
          if (doc) await ctx.db.delete(doc._id);
        }
        for (const card of working.taskCards ?? []) {
          if (!loaded.previousCards.has(card.uuid))
            await ctx.db.insert("taskCards", {
              uuid: card.uuid,
              aircraftUuid: card.aircraftUuid,
              payload: JSON.stringify(card),
            });
        }
        for (const inspection of working.inspections) {
          if (
            inspection.version ===
            loaded.previousInspections.get(inspection.uuid)
          )
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
          if (record.version === loaded.previousManagement.get(record.uuid))
            continue;
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
        const next = result.next;
        const fields = {
          uuid: next.uuid,
          aircraftUuid: next.aircraftUuid,
          payload: JSON.stringify(next),
        };
        if (loaded.existing) await ctx.db.replace(loaded.existing._id, fields);
        else await ctx.db.insert("workOrders", fields);
      },
      audit: (log, { working, previous }, { next }, command) => {
        log.replay(working.audit);
        log.entry("workOrder." + command.action, next.uuid, {
          aircraftUuid: next.aircraftUuid,
          before: previous,
          after: next,
          reason:
            command.action === "revise" || command.action === "correctComponent"
              ? command.reason
              : undefined,
        });
      },
      returns: ({ next }) => next.uuid,
    }),
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
