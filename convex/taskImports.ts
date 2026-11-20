/**
 * Responsibility: Imports a reviewed task file into an inspection template, or
 *   as draft job cards on an inspection.
 * Layer: Server. One public mutation through runCommand; the rules are the
 *   domain's importTaskCsv.
 * Dependencies: convex/runCommand, convex/collections, convex/recordNumbers,
 *   src/domain/taskCsv.
 */
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { runCommand, hydrate, requestOf } from "./runCommand";
import { encode } from "./collections";
import { syncRecordNumber } from "./recordNumbers";
import { importTaskCsv } from "../src/domain/taskCsv";

/**
 * Imports a reviewed task CSV, all or none: into a template as its next
 * version, or onto an inspection as draft job cards. Replays the domain's
 * change-log entries. A replayed request id changes nothing.
 *
 * @param payload - JSON, as `taskCsvImportSchema`.
 * @param programUuid - The caller's active Flight Program.
 * @param requestUuid - The request id, when the client sends one; it travels
 *   beside the payload, which the domain parses strictly.
 * @returns How many tasks were imported.
 * @throws {ConvexError} As `runCommand` and `importTaskCsv`.
 */
export const save = mutation({
  args: {
    payload: v.string(),
    programUuid: v.optional(v.string()),
    requestUuid: v.optional(v.string()),
  },
  handler: (ctx, { payload, programUuid, requestUuid }) =>
    runCommand(ctx, {
      programUuid,
      parse: () => JSON.parse(payload),
      request: () => requestOf(requestUuid, payload),
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
        for (const task of result.tasks) {
          const row = encode("taskCards", task);
          await ctx.db.insert("taskCards", row);
          await syncRecordNumber(ctx, "taskCards", row);
        }
      },
      audit: (log, { snapshot }) => log.replay(snapshot.audit),
      returns: (result) => result.count,
    }),
});
