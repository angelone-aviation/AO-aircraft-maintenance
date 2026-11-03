/**
 * Responsibility: Keeps the memberships index of (user, group, program) rows in
 *   step with users.groupIds, and reads a program's accounts from it.
 * Layer: Server. Convex helpers and one internal mutation; no public function.
 * Dependencies: convex/values, convex/_generated (server, api, dataModel).
 *
 * users.groupIds stays the source of truth for authorization. The index exists
 * only to find a program's users without scanning every account, so every
 * write to groupIds or groups calls syncMemberships for the affected users.
 */
import { v } from "convex/values";
import {
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";

const BACKFILL_BATCH = 100;

/**
 * Rewrites one account's membership rows to match its groupIds: inserts the
 * missing rows and deletes stale and duplicate ones. Writes no audit entry.
 *
 * @param ctx - Mutation context.
 * @param userId - Account to resync. Deleted groups get no row, and a deleted
 *   account loses all its rows.
 */
export async function syncMemberships(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<void> {
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
  // A matching row leaves `wanted`, so a duplicate of it is deleted.
  for (const row of existing) {
    if (wanted.has(row.groupId) && wanted.get(row.groupId) === row.programUuid)
      wanted.delete(row.groupId);
    else await ctx.db.delete(row._id);
  }
  for (const [groupId, programUuid] of wanted)
    await ctx.db.insert("memberships", { userId, groupId, programUuid });
}

/**
 * Deletes a deleted group's membership rows, including rows whose account no
 * longer lists the group. Writes no audit entry.
 *
 * @param ctx - Mutation context.
 * @param group - The group's id and the program its rows are indexed under.
 */
export async function removeGroupMemberships(
  ctx: MutationCtx,
  group: Pick<Doc<"groups">, "_id" | "programUuid">,
): Promise<void> {
  const rows = await ctx.db
    .query("memberships")
    .withIndex("program", (q) =>
      q.eq("programUuid", group.programUuid).eq("groupId", group._id),
    )
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
}

/**
 * Lists the accounts holding any group of a Flight Program, or one group.
 *
 * @param ctx - Query or mutation context.
 * @param programUuid - The program; undefined matches groups not yet assigned
 *   to one.
 * @param groupId - Narrows the list to this group's holders.
 * @returns Each existing account once.
 */
export async function programUsers(
  ctx: QueryCtx | MutationCtx,
  programUuid: string | undefined,
  groupId?: Id<"groups">,
): Promise<Doc<"users">[]> {
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

/**
 * Rebuilds every account's membership rows from groupIds, one page of accounts
 * per transaction, scheduling the next page until done. Idempotent; run once
 * after deploying the memberships table with
 * `npx convex run memberships:backfill`.
 *
 * @param cursor - Page to resume from; omitted or null starts at the first.
 * @returns How many accounts this page synced, and whether it was the last.
 */
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
