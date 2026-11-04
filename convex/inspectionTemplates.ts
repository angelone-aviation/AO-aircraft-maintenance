/**
 * Responsibility: The Flight Program's inspection template library: saving
 *   templates, activating one on an aircraft or a component, and deleting
 *   templates with the reusable job cards made from them.
 * Layer: Server. Three public mutations through runCommand; the rules are the
 *   domain's.
 * Dependencies: convex/runCommand, convex/management, convex/attachments,
 *   src/domain (inspectionTemplates, activateTemplate,
 *   deleteInspectionTemplates).
 */
import { deleteInspectionTemplates } from "../src/domain/deleteInspectionTemplates";
import { activateTemplate } from "../src/domain/activateTemplate";
import { mutation, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import {
  runCommand,
  hydrate,
  requestOf,
  writeChanged,
  type Hydrated,
} from "./runCommand";
import { writeInspection } from "./management";
import { deleteBlobIfUnused } from "./attachments";
import { saveInspectionTemplates } from "../src/domain/inspectionTemplates";

// The payload of a template save is a bare list, so the request id travels
// beside it, for all three commands alike.
const args = {
  payload: v.string(),
  programUuid: v.optional(v.string()),
  requestUuid: v.optional(v.string()),
};

type TemplateDeletion = ReturnType<typeof deleteInspectionTemplates>;
type DeletionDocs = Hydrated<"inspectionTemplates" | "taskCards">["docs"];

/**
 * Saves templates into the caller's Flight Program library, all or none, and
 * audits `inspectionTemplate.save` for each with its stored and saved
 * versions. A replayed request id changes nothing.
 *
 * @param payload - JSON, as `saveInspectionTemplates` reads it.
 * @param programUuid - The caller's active Flight Program.
 * @param requestUuid - The request id, when the client sends one.
 * @throws {ConvexError} As `runCommand` and `saveInspectionTemplates`;
 *   "Record belongs to another Flight Program." for a new uuid another
 *   program uses.
 */
export const save = mutation({
  args,
  handler: (ctx, { payload, programUuid, requestUuid }) =>
    runCommand(ctx, {
      programUuid,
      parse: () => JSON.parse(payload),
      request: () => requestOf(requestUuid, payload),
      load: ({ ctx, state }) => hydrate(ctx, state, ["inspectionTemplates"]),
      apply: ({ snapshot }, command) =>
        saveInspectionTemplates(snapshot, command),
      persist: ({ ctx }, { docs }, results) =>
        writeChanged(
          ctx,
          "inspectionTemplates",
          docs.inspectionTemplates,
          results.map((r) => r.next),
        ),
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

/**
 * Activates a template on an aircraft (an inspection) or a component (a
 * component requirement), with a draft job card per template task, and
 * replays the domain's change-log entries. A replayed request id changes
 * nothing.
 *
 * @param payload - JSON, as `activateTemplateSchema`.
 * @param programUuid - The caller's active Flight Program.
 * @param requestUuid - The request id, when the client sends one.
 * @returns The new inspection's or requirement's uuid.
 * @throws {ConvexError} As `runCommand` and `activateTemplate`; "Record
 *   belongs to another Flight Program." when a uuid it generated is stored.
 */
export const activate = mutation({
  args,
  handler: (ctx, { payload, programUuid, requestUuid }) =>
    runCommand(ctx, {
      programUuid,
      parse: () => JSON.parse(payload),
      request: () => requestOf(requestUuid, payload),
      load: ({ ctx, state }) =>
        hydrate(ctx, state, [
          "inspectionTemplates",
          "inspections",
          "management",
          "taskCards",
        ]),
      apply: ({ snapshot }, command) => activateTemplate(snapshot, command),
      persist: async ({ ctx }, { docs }, { record, tasks }) => {
        if ("kind" in record)
          await writeChanged(ctx, "management", docs.management, [record]);
        else await writeInspection(ctx, docs.inspections, record);
        await writeChanged(ctx, "taskCards", docs.taskCards, tasks);
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

/**
 * Deletes templates with the reusable job cards made from them and those
 * cards' evidence files, all or none, and audits
 * `taskCard.deletedWithTemplate` and `inspectionTemplate.deleted` for each.
 * Inspections already activated stay. A replayed request id changes nothing.
 *
 * @param payload - JSON, as `deleteTemplatesSchema`: the templates and cards
 *   the preview showed, at the versions it showed.
 * @param programUuid - The caller's active Flight Program.
 * @param requestUuid - The request id, when the client sends one.
 * @returns How many templates and job cards were deleted.
 * @throws {ConvexError} As `runCommand` and `deleteInspectionTemplates`.
 */
export const remove = mutation({
  args,
  handler: (ctx, { payload, programUuid, requestUuid }) =>
    runCommand(ctx, {
      programUuid,
      parse: () => JSON.parse(payload),
      request: () => requestOf(requestUuid, payload),
      load: ({ ctx, state }) =>
        hydrate(ctx, state, [
          "inspectionTemplates",
          "taskCards",
          "inspections",
          "management",
        ]),
      apply: ({ snapshot }, command) =>
        deleteInspectionTemplates(snapshot, command),
      persist: ({ ctx }, { docs }, result) =>
        deleteTemplates(ctx, docs, result),
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

async function deleteTemplates(
  ctx: MutationCtx,
  docs: DeletionDocs,
  result: TemplateDeletion,
) {
  for (const task of result.taskCards) {
    const evidence = await ctx.db
      .query("taskEvidence")
      .withIndex("taskCard", (q) => q.eq("taskCardUuid", task.uuid))
      .collect();
    for (const file of evidence) {
      await ctx.db.delete(file._id);
      await deleteBlobIfUnused(ctx, file.storageId);
    }
    await ctx.db.delete(docs.taskCards.find((d) => d.uuid === task.uuid)!._id);
  }
  for (const template of result.templates)
    await ctx.db.delete(
      docs.inspectionTemplates.find((d) => d.uuid === template.uuid)!._id,
    );
}
