/**
 * Responsibility: Appends the hand-written change-log entry that must follow
 *   any sanctioned direct edit of production data (ADR-0005,
 *   docs/runbooks/database-access.md).
 * Layer: Server. One internal mutation, so only a holder of the deployment's
 *   admin key can run it; it never edits or deletes an existing entry.
 * Dependencies: convex/access, convex/accountGuards.
 */
import { internalMutation, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { audit } from "./access";
import { normalizeEmail } from "./accountGuards";

const REASON_MAX_LENGTH = 1500;
const DESCRIPTION_MAX_LENGTH = 10000;

// Measured as JSON, for `before` and for `after` with its description.
const VALUES_MAX_LENGTH = 100_000;

/**
 * Records a direct edit of production data as an "audit.manual_entry" by the
 * named administrator. Run it as
 * `npx convex run --prod audit:recordManualEntry '{"actorEmail": ..., ...}'`.
 *
 * @param actorEmail - Your own active system administrator account.
 * @param reason - Why the edit was made; trimmed, up to 1,500 characters.
 * @param description - What was changed; trimmed, up to 10,000 characters.
 * @param entityUuid - The record the edit changed, so the entry shows in its
 *   history; omit it for a whole-deployment event such as a restore.
 * @param aircraftUuid - The edited record's aircraft, if any.
 * @param programUuid - The edited record's Flight Program, if any.
 * @param before - The values before the edit, as far as they are known.
 * @param after - The values after it; stored with the description.
 * @returns The entry's record uuid (a new one when none is named) and actor.
 * @throws {Error} "Record the reason for the edit (up to 1,500 characters).";
 *   "Record a description of what was changed (up to 10,000 characters).";
 *   "Recorded values are too large; summarize them."; "Name your own active
 *   system administrator account as the actor."
 */
export const recordManualEntry = internalMutation({
  args: {
    actorEmail: v.string(),
    reason: v.string(),
    description: v.string(),
    entityUuid: v.optional(v.string()),
    aircraftUuid: v.optional(v.string()),
    programUuid: v.optional(v.string()),
    before: v.optional(v.any()),
    after: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const reason = args.reason.trim();
    const description = args.description.trim();
    assertEntryFits(reason, description);
    const after = {
      description,
      ...(args.after === undefined ? {} : { values: args.after }),
    };
    assertValuesFit(args.before, after);
    const actor = await findActiveAdministrator(ctx, args.actorEmail);
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

function assertEntryFits(reason: string, description: string): void {
  if (!reason || reason.length > REASON_MAX_LENGTH)
    throw new Error("Record the reason for the edit (up to 1,500 characters).");
  if (!description || description.length > DESCRIPTION_MAX_LENGTH)
    throw new Error(
      "Record a description of what was changed (up to 10,000 characters).",
    );
}

function assertValuesFit(before: unknown, after: unknown): void {
  if (
    JSON.stringify(before ?? null).length > VALUES_MAX_LENGTH ||
    JSON.stringify(after).length > VALUES_MAX_LENGTH
  )
    throw new Error("Recorded values are too large; summarize them.");
}

async function findActiveAdministrator(ctx: MutationCtx, email: string) {
  const actor = await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", normalizeEmail(email)))
    .first();
  if (!actor?.active || actor.isAdmin !== true)
    throw new Error(
      "Name your own active system administrator account as the actor.",
    );
  return actor;
}
