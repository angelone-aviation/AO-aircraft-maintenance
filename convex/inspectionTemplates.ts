import { deleteInspectionTemplates } from "../src/domain/deleteInspectionTemplates";
import { activateTemplate } from "../src/domain/activateTemplate";
import { inspectionSchema } from "../src/domain/management";
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { runCommand, hydrate } from "./runCommand";
import { deleteBlobIfUnused } from "./attachments";
import { saveInspectionTemplates } from "../src/domain/inspectionTemplates";
const args = { payload: v.string(), programUuid: v.optional(v.string()) };
export const save = mutation({
  args,
  handler: (ctx, { payload, programUuid }) =>
    runCommand(ctx, {
      programUuid,
      parse: () => JSON.parse(payload),
      load: ({ ctx, state }) => hydrate(ctx, state, ["inspectionTemplates"]),
      apply: ({ snapshot }, command) =>
        saveInspectionTemplates(snapshot, command),
      persist: async ({ ctx }, { docs }, results) => {
        for (const { next } of results) {
          const doc = docs.inspectionTemplates.find(
            (d) => d.uuid === next.uuid,
          );
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
        }
      },
      audit: (log, _, results) => {
        for (const { before, next } of results)
          log.entry("inspectionTemplate.save", next.uuid, {
            programUuid: next.programUuid,
            before,
            after: next,
          });
      },
    }),
});

export const activate = mutation({
  args,
  handler: (ctx, { payload, programUuid }) =>
    runCommand(ctx, {
      programUuid,
      parse: () => JSON.parse(payload),
      load: ({ ctx, state }) =>
        hydrate(ctx, state, [
          "inspectionTemplates",
          "inspections",
          "management",
          "taskCards",
        ]),
      apply: ({ snapshot }, command) => activateTemplate(snapshot, command),
      persist: async ({ ctx }, _, result) => {
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
      },
      audit: (log, { snapshot }, result) =>
        log.replay(snapshot.audit, {
          aircraftUuid: result.aircraftUuid,
          programUuid,
          before: undefined,
        }),
      returns: (result) => result.record.uuid,
    }),
});

export const remove = mutation({
  args,
  handler: (ctx, { payload, programUuid }) =>
    runCommand(ctx, {
      programUuid,
      parse: () => JSON.parse(payload),
      load: ({ ctx, state }) =>
        hydrate(ctx, state, [
          "inspectionTemplates",
          "taskCards",
          "inspections",
          "management",
        ]),
      apply: ({ snapshot }, command) =>
        deleteInspectionTemplates(snapshot, command),
      persist: async ({ ctx }, { docs }, result) => {
        for (const task of result.taskCards) {
          const evidence = await ctx.db
            .query("taskEvidence")
            .withIndex("taskCard", (q) => q.eq("taskCardUuid", task.uuid))
            .collect();
          for (const file of evidence) {
            await ctx.db.delete(file._id);
            await deleteBlobIfUnused(ctx, file.storageId);
          }
          await ctx.db.delete(
            docs.taskCards.find((d) => d.uuid === task.uuid)!._id,
          );
        }
        for (const template of result.templates)
          await ctx.db.delete(
            docs.inspectionTemplates.find((d) => d.uuid === template.uuid)!._id,
          );
      },
      audit: (log, _, result) => {
        for (const task of result.taskCards)
          log.entry("taskCard.deletedWithTemplate", task.uuid, {
            programUuid,
            aircraftUuid: task.aircraftUuid,
            before: task,
            reason: "Deleted with its inspection template.",
          });
        for (const template of result.templates)
          log.entry("inspectionTemplate.deleted", template.uuid, {
            programUuid,
            before: template,
            reason: `Deleted template and associated reusable job cards.`,
          });
      },
      returns: (result) => ({
        templates: result.templates.length,
        taskCards: result.taskCards.length,
      }),
    }),
});
