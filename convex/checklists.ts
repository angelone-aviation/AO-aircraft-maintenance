import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { checkContext } from "./programContext";
import { audit } from "./access";
import {
  checklistCommandSchema,
  checklistRecordSchema,
  checklistCounts,
  saveChecklist,
} from "../src/domain/checklists";
export const save = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const state = await checkContext(ctx, args.programUuid);
    const command = checklistCommandSchema.parse(JSON.parse(args.payload));
    const existing = await ctx.db
      .query("checklists")
      .withIndex("uuid", (q) => q.eq("uuid", command.record.uuid))
      .unique();
    const next = saveChecklist(
      {
        ...state,
        checklists: existing
          ? [checklistRecordSchema.parse(JSON.parse(existing.payload))]
          : [],
      },
      command,
    );
    const record = {
      uuid: next.uuid,
      programUuid: next.programUuid,
      aircraftUuid: next.aircraftUuid,
      payload: JSON.stringify(next),
    };
    if (existing) await ctx.db.replace(existing._id, record);
    else await ctx.db.insert("checklists", record);
    // Do not duplicate large checklist bodies into audit documents.
    await audit(
      ctx,
      state.user.id as import("./_generated/dataModel").Id<"users">,
      "checklist.saved",
      next.uuid,
      {
        programUuid: next.programUuid,
        aircraftUuid: next.aircraftUuid || undefined,
        after: {
          version: next.version,
          name: next.document.payload.metadata.name,
          ...checklistCounts(next.document),
        },
      },
    );
    return next.uuid;
  },
});
