/**
 * Responsibility: Imports a reviewed task file into an inspection template, or
 *   as draft job cards on an inspection.
 * Layer: Server. One public mutation through runCommand; the rules are the
 *   domain's importTaskCsv.
 * Dependencies: convex/runCommand, src/domain/taskCsv.
 */
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { runCommand, hydrate } from "./runCommand";
import { importTaskCsv } from "../src/domain/taskCsv";

/**
 * Imports a reviewed task CSV, all or none: into a template as its next
 * version, or onto an inspection as draft job cards. Replays the domain's
 * change-log entries.
 *
 * @param payload - JSON, as `taskCsvImportSchema`.
 * @param programUuid - The caller's active Flight Program.
 * @returns How many tasks were imported.
 * @throws {ConvexError} As `runCommand` and `importTaskCsv`.
 */
export const save = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: (ctx, { payload, programUuid }) =>
    runCommand(ctx, {
      programUuid,
      parse: () => JSON.parse(payload),
      load: ({ ctx, state }) =>
        hydrate(ctx, state, [
          "inspectionTemplates",
          "inspections",
          "taskCards",
          "management",
        ]),
      apply: ({ snapshot }, command) => importTaskCsv(snapshot, command),
      persist: async ({ ctx }, { docs }, result) => {
        if (result.template) {
          const doc = docs.inspectionTemplates.find(
            (t) => t.uuid === result.template!.uuid,
          )!;
          await ctx.db.patch(doc._id, {
            payload: JSON.stringify(result.template),
          });
        }
        for (const task of result.tasks)
          await ctx.db.insert("taskCards", {
            uuid: task.uuid,
            aircraftUuid: task.aircraftUuid,
            payload: JSON.stringify(task),
          });
      },
      audit: (log, { snapshot }) => log.replay(snapshot.audit, { programUuid }),
      returns: (result) => result.count,
    }),
});
