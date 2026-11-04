/**
 * Responsibility: Saves a checklist set, for one aircraft or the whole Flight
 *   Program, as a new version.
 * Layer: Server. One public mutation through runCommand; the rules are the
 *   domain's saveChecklist.
 * Dependencies: convex/runCommand, src/domain/checklists, src/domain/model.
 */
import { mutation, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { requestOf, runCommand } from "./runCommand";
import type { Snapshot } from "../src/domain/model";
import {
  checklistCommandSchema,
  checklistRecordSchema,
  checklistCounts,
  saveChecklist,
} from "../src/domain/checklists";

/**
 * Saves a checklist set as its next version, and audits `checklist.saved`
 * with its version, name and counts: the body is large and stays out of the
 * change log. A replayed request id changes nothing.
 *
 * @param payload - JSON, as `checklistCommandSchema`: the set, the version
 *   it was edited from, and the request id.
 * @param programUuid - The caller's active Flight Program.
 * @returns The set's uuid; nothing for a replay.
 * @throws {ConvexError} As `runCommand`; "Checklist editing permission
 *   denied."; "This checklist changed. Reopen it before saving; your draft
 *   has not been applied."
 */
export const save = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: (ctx, args) =>
    runCommand(ctx, {
      programUuid: args.programUuid,
      parse: () => checklistCommandSchema.parse(JSON.parse(args.payload)),
      request: (command) => requestOf(command.requestUuid, args.payload),
      load: ({ ctx, state }, command) =>
        loadChecklist(ctx, state, command.record.uuid),
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

// saveChecklist reads only the set it saves, so only that one is loaded.
async function loadChecklist(ctx: MutationCtx, state: Snapshot, uuid: string) {
  const existing = await ctx.db
    .query("checklists")
    .withIndex("uuid", (q) => q.eq("uuid", uuid))
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
}
