import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { runCommand, hydrate } from "./runCommand";
import { importTaskCsv } from "../src/domain/taskCsv";
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
