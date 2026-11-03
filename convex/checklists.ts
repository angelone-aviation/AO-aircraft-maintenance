import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { runCommand } from "./runCommand";
import {
  checklistCommandSchema,
  checklistRecordSchema,
  checklistCounts,
  saveChecklist,
} from "../src/domain/checklists";
export const save = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: (ctx, args) =>
    runCommand(ctx, {
      programUuid: args.programUuid,
      parse: () => checklistCommandSchema.parse(JSON.parse(args.payload)),
      load: async ({ ctx, state }, command) => {
        const existing = await ctx.db
          .query("checklists")
          .withIndex("uuid", (q) => q.eq("uuid", command.record.uuid))
          .unique();
        return {
          existing,
          s: {
            ...state,
            checklists: existing
              ? [checklistRecordSchema.parse(JSON.parse(existing.payload))]
              : [],
          },
        };
      },
      apply: ({ s }, command) => saveChecklist(s, command),
      persist: async ({ ctx }, { existing }, next) => {
        const record = {
          uuid: next.uuid,
          programUuid: next.programUuid,
          aircraftUuid: next.aircraftUuid,
          payload: JSON.stringify(next),
        };
        if (existing) await ctx.db.replace(existing._id, record);
        else await ctx.db.insert("checklists", record);
      },
      // Do not duplicate large checklist bodies into audit documents.
      audit: (log, _, next) =>
        log.entry("checklist.saved", next.uuid, {
          programUuid: next.programUuid,
          aircraftUuid: next.aircraftUuid || undefined,
          after: {
            version: next.version,
            name: next.document.payload.metadata.name,
            ...checklistCounts(next.document),
          },
        }),
      returns: (next) => next.uuid,
    }),
});
