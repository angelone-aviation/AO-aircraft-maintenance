import { v } from "convex/values";
import { mutation, type MutationCtx } from "./_generated/server";
import { admin, audit } from "./access";
import { missingDefaultGroups } from "../src/domain/defaultPermissionGroups";
export async function ensureDefaultGroups(
  ctx: MutationCtx,
  programUuid: string,
  actorId: string,
) {
  const existing = await ctx.db
    .query("groups")
    .withIndex("program", (q) => q.eq("programUuid", programUuid))
    .collect();
  const missing = missingDefaultGroups(existing);
  for (const group of missing) {
    const fields = { ...group, programUuid };
    const id = await ctx.db.insert("groups", fields);
    await audit(ctx, actorId, "group.saved", id, {
      programUuid,
      after: fields,
    });
  }
  return {
    created: missing.map((g) => g.name),
    preserved: existing.map((g) => g.name),
  };
}
// Idempotent backfill for programs created before automatic default groups.
export const initialize = mutation({
  args: { programUuid: v.string() },
  handler: async (ctx, { programUuid }) => {
    const actor = await admin(ctx);
    const program = await ctx.db
      .query("programs")
      .withIndex("uuid", (q) => q.eq("uuid", programUuid))
      .unique();
    if (!program) throw Error("Flight Program not found.");
    return ensureDefaultGroups(ctx, programUuid, actor._id);
  },
});
