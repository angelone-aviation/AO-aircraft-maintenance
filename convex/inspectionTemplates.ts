import { deleteInspectionTemplates } from "../src/domain/deleteInspectionTemplates";
import { activateTemplate } from "../src/domain/activateTemplate";
import { recordSchema, inspectionSchema } from "../src/domain/management";
import { taskCardSchema } from "../src/domain/taskCards";
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import {
  checkContext,
  managementDocs,
  inspectionDocs,
  taskCardDocs,
  inspectionTemplateDocs,
} from "./programContext";
import { audit } from "./access";
import { deleteBlobIfUnused } from "./attachments";
import {
  inspectionTemplateSchema,
  saveInspectionTemplates,
} from "../src/domain/inspectionTemplates";
export const save = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, { payload, programUuid }) => {
    const state = await checkContext(ctx, programUuid);
    const documents = await inspectionTemplateDocs(ctx, programUuid);
    const s = {
      ...state,
      inspectionTemplates: documents.map((d) =>
        inspectionTemplateSchema.parse(JSON.parse(d.payload)),
      ),
    };
    const results = saveInspectionTemplates(s, JSON.parse(payload));
    for (const { before, next } of results) {
      const doc = documents.find((d) => d.uuid === next.uuid);
      const fields = {
        uuid: next.uuid,
        programUuid: next.programUuid,
        payload: JSON.stringify(next),
      };
      if (doc) await ctx.db.replace(doc._id, fields);
      else if (
        await ctx.db
          .query("inspectionTemplates")
          .withIndex("uuid", (q) => q.eq("uuid", next.uuid))
          .first()
      )
        throw new Error("Template belongs to another Flight Program.");
      else await ctx.db.insert("inspectionTemplates", fields);
      await audit(ctx, state.user.id, "inspectionTemplate.save", next.uuid, {
        programUuid: next.programUuid,
        before,
        after: next,
      });
    }
  },
});

export const activate = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, { payload, programUuid }) => {
    const state = await checkContext(ctx, programUuid);
    const management = await managementDocs(ctx, programUuid);
    const s: import("../src/domain/model").Snapshot = {
      ...state,
      inspectionTemplates: (await inspectionTemplateDocs(ctx, programUuid)).map(
        (d) => inspectionTemplateSchema.parse(JSON.parse(d.payload)),
      ),
      inspections: await inspectionDocs(ctx, state.aircraft, management),
      management: management.map((d) =>
        recordSchema.parse(JSON.parse(d.payload)),
      ),
      taskCards: (await taskCardDocs(ctx, state.aircraft)).map((d) =>
        taskCardSchema.parse(JSON.parse(d.payload)),
      ),
    };
    const result = activateTemplate(s, JSON.parse(payload));
    const r = result.record;
    if ("kind" in r)
      await ctx.db.insert("management", {
        uuid: r.uuid,
        kind: r.kind,
        programUuid: r.programUuid,
        aircraftUuid: result.aircraftUuid,
        payload: JSON.stringify(r),
      });
    else await ctx.db.insert("inspections", inspectionSchema.parse(r));
    for (const task of result.tasks)
      await ctx.db.insert("taskCards", {
        uuid: task.uuid,
        aircraftUuid: task.aircraftUuid,
        payload: JSON.stringify(task),
      });
    for (const entry of s.audit)
      await audit(ctx, state.user.id, entry.action, entry.entityUuid, {
        aircraftUuid: result.aircraftUuid,
        programUuid,
        reason: entry.reason,
        after: entry.after ? JSON.parse(entry.after) : undefined,
      });
    return r.uuid;
  },
});

export const remove = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, { payload, programUuid }) => {
    const state = await checkContext(ctx, programUuid);
    const templateDocuments = await inspectionTemplateDocs(ctx, programUuid);
    const taskDocuments = await taskCardDocs(ctx, state.aircraft);
    const management = await managementDocs(ctx, programUuid);
    const s = {
      ...state,
      inspectionTemplates: templateDocuments.map((d) =>
        inspectionTemplateSchema.parse(JSON.parse(d.payload)),
      ),
      taskCards: taskDocuments.map((d) =>
        taskCardSchema.parse(JSON.parse(d.payload)),
      ),
      inspections: await inspectionDocs(ctx, state.aircraft, management),
      management: management.map((d) =>
        recordSchema.parse(JSON.parse(d.payload)),
      ),
    };
    const result = deleteInspectionTemplates(s, JSON.parse(payload));
    for (const task of result.taskCards) {
      const evidence = await ctx.db
        .query("taskEvidence")
        .withIndex("taskCard", (q) => q.eq("taskCardUuid", task.uuid))
        .collect();
      for (const file of evidence) {
        await ctx.db.delete(file._id);
        await deleteBlobIfUnused(ctx, file.storageId);
      }
      await ctx.db.delete(taskDocuments.find((d) => d.uuid === task.uuid)!._id);
      await audit(
        ctx,
        state.user.id,
        "taskCard.deletedWithTemplate",
        task.uuid,
        {
          programUuid,
          aircraftUuid: task.aircraftUuid,
          before: task,
          reason: "Deleted with its inspection template.",
        },
      );
    }
    for (const template of result.templates) {
      await ctx.db.delete(
        templateDocuments.find((d) => d.uuid === template.uuid)!._id,
      );
      await audit(
        ctx,
        state.user.id,
        "inspectionTemplate.deleted",
        template.uuid,
        {
          programUuid,
          before: template,
          reason: `Deleted template and associated reusable job cards.`,
        },
      );
    }
    return {
      templates: result.templates.length,
      taskCards: result.taskCards.length,
    };
  },
});
