import { v } from "convex/values";
import { mutation, type MutationCtx } from "./_generated/server";
import { admin, audit } from "./access";
import type { CommandLog } from "./runCommand";
import { missingDefaultGroups } from "../src/domain/defaultPermissionGroups";
// Inside a command, pass its log so the rows are written with the command's.
export async function ensureDefaultGroups(
  ctx: MutationCtx,
  programUuid: string,
  actorId: string,
  log?: CommandLog,
) {
  const existing = await ctx.db
    .query("groups")
    .withIndex("program", (q) => q.eq("programUuid", programUuid))
    .collect();
  const missing = missingDefaultGroups(existing);
  for (const group of missing) {
    const fields = { ...group, programUuid };
    const id = await ctx.db.insert("groups", fields);
    const entry = { programUuid, after: fields };
    if (log) log.entry("group.saved", id, entry);
    else await audit(ctx, actorId, "group.saved", id, entry);
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
