import { v } from "convex/values";
import {
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
// users.groupIds stays the source of truth for authorization. This index of
// (user, group, program) rows exists only to find a program's users without
// scanning every account, so every write to groupIds or groups calls
// syncMemberships for the affected users.
export async function syncMemberships(ctx: MutationCtx, userId: Id<"users">) {
  const user = await ctx.db.get(userId);
  const groups = (
    await Promise.all(
      [...new Set(user?.groupIds ?? [])].map((id) => ctx.db.get(id)),
    )
  ).filter((g): g is Doc<"groups"> => g !== null);
  const wanted = new Map(groups.map((g) => [g._id, g.programUuid]));
  const existing = await ctx.db
    .query("memberships")
    .withIndex("user", (q) => q.eq("userId", userId))
    .collect();
  for (const row of existing) {
    if (wanted.has(row.groupId) && wanted.get(row.groupId) === row.programUuid)
      wanted.delete(row.groupId);
    else await ctx.db.delete(row._id);
  }
  for (const [groupId, programUuid] of wanted)
    await ctx.db.insert("memberships", { userId, groupId, programUuid });
}
// Removes index rows for a deleted group, including any left by stale data.
export async function removeGroupMemberships(
  ctx: MutationCtx,
  group: Pick<Doc<"groups">, "_id" | "programUuid">,
) {
  const rows = await ctx.db
    .query("memberships")
    .withIndex("program", (q) =>
      q.eq("programUuid", group.programUuid).eq("groupId", group._id),
    )
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
}
// Accounts holding any group (or the given group) of a Flight Program.
export async function programUsers(
  ctx: QueryCtx | MutationCtx,
  programUuid: string | undefined,
  groupId?: Id<"groups">,
) {
  const rows = await ctx.db
    .query("memberships")
    .withIndex("program", (q) =>
      groupId
        ? q.eq("programUuid", programUuid).eq("groupId", groupId)
        : q.eq("programUuid", programUuid),
    )
    .collect();
  return (
    await Promise.all(
      [...new Set(rows.map((r) => r.userId))].map((id) => ctx.db.get(id)),
    )
  ).filter((u): u is Doc<"users"> => u !== null);
}
const BACKFILL_BATCH = 100;
// Idempotent: run once after deploying the memberships table with
// `npx convex run memberships:backfill`. It walks every account in batches,
// scheduling itself until done, and rewrites each user's rows from groupIds.
export const backfill = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const batch = await ctx.db
      .query("users")
      .paginate({ cursor: cursor ?? null, numItems: BACKFILL_BATCH });
    for (const user of batch.page) await syncMemberships(ctx, user._id);
    if (!batch.isDone)
      await ctx.scheduler.runAfter(0, internal.memberships.backfill, {
        cursor: batch.continueCursor,
      });
    return { synced: batch.page.length, isDone: batch.isDone };
  },
});
