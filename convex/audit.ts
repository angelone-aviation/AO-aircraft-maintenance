import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { audit } from "./access";
import { normalizeEmail } from "./accountGuards";

// Appends the hand-written change-log entry that must follow any sanctioned
// direct edit of production data (ADR-0005, docs/runbooks/database-access.md).
// Internal, so only a holder of the deployment's admin key can run it:
//   npx convex run --prod audit:recordManualEntry '{"actorEmail": ..., ...}'
// The actor must be an active system administrator account. It only appends;
// it never edits or deletes an existing entry.
const MAX_VALUES = 100_000;
export const recordManualEntry = internalMutation({
  args: {
    actorEmail: v.string(),
    reason: v.string(),
    description: v.string(),
    // The record the edit changed; makes the entry visible wherever that
    // record's history is. Omit for a whole-deployment event such as a restore.
    entityUuid: v.optional(v.string()),
    aircraftUuid: v.optional(v.string()),
    programUuid: v.optional(v.string()),
    // The values before and after the edit, as far as they are known.
    before: v.optional(v.any()),
    after: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const reason = args.reason.trim();
    const description = args.description.trim();
    if (!reason || reason.length > 1500)
      throw new Error(
        "Record the reason for the edit (up to 1,500 characters).",
      );
    if (!description || description.length > 10000)
      throw new Error(
        "Record a description of what was changed (up to 10,000 characters).",
      );
    const after = {
      description,
      ...(args.after === undefined ? {} : { values: args.after }),
    };
    if (
      JSON.stringify(args.before ?? null).length > MAX_VALUES ||
      JSON.stringify(after).length > MAX_VALUES
    )
      throw new Error("Recorded values are too large; summarize them.");
    const actor = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", normalizeEmail(args.actorEmail)))
      .first();
    if (!actor?.active || actor.isAdmin !== true)
      throw new Error(
        "Name your own active system administrator account as the actor.",
      );
    const entityUuid = args.entityUuid?.trim() || crypto.randomUUID();
    await audit(ctx, actor._id, "audit.manual_entry", entityUuid, {
      programUuid: args.programUuid,
      aircraftUuid: args.aircraftUuid,
      reason,
      before: args.before,
      after,
    });
    return { entityUuid, actorId: actor._id };
  },
});
