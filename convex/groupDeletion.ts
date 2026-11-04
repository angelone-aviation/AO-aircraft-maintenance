/**
 * Responsibility: Deleting a permission group after a Flight Program
 *   administrator reviews whose access it removes.
 * Layer: Server. A public query and mutation; the rules are the domain's
 *   groupDeletionPlan, and the deletion is audited.
 * Dependencies: convex/programContext, convex/access, convex/memberships,
 *   src/domain/groupDeletion.
 */
import { v } from "convex/values";
import {
  query,
  mutation,
  type QueryCtx,
  type MutationCtx,
} from "./_generated/server";
import { checkContext } from "./programContext";
import { member, audit } from "./access";
import { programUsers, removeGroupMemberships } from "./memberships";
import type { Id } from "./_generated/dataModel";
import { groupDeletionPlan } from "../src/domain/groupDeletion";

const args = { id: v.id("groups"), programUuid: v.optional(v.string()) };

/**
 * Shows an administrator what deleting a group would do, for them to confirm.
 *
 * @param id - The group.
 * @param programUuid - The caller's active Flight Program.
 * @returns The group's name, its members and whether each loses access to
 *   the program, and `expected`, which {@link remove} must be given back.
 * @throws {Error} As `checkContext`; "Permission group not found."; "Flight
 *   Program administrator permission required."
 */
export const preview = query({
  args,
  handler: async (ctx, args) =>
    groupDeletionPlan(await load(ctx, args.programUuid, args.id), args.id),
});

/**
 * Deletes a group as reviewed, taking it out of its members' accounts and
 * memberships only; audits "group.deleted" with the group and those members.
 *
 * @param expected - The reviewed plan's `expected`.
 * @throws {Error} As {@link preview}; "This group or its members changed.
 *   Close this dialog and review deletion again." when the plan differs.
 */
export const remove = mutation({
  args: { ...args, expected: v.string() },
  handler: async (ctx, args) => {
    const state = await load(ctx, args.programUuid, args.id);
    const plan = groupDeletionPlan(state, args.id);
    if (plan.expected !== args.expected)
      throw new Error(
        "This group or its members changed. Close this dialog and review deletion again.",
      );
    const group = state.groups.find((g) => g.id === args.id)!;
    for (const user of plan.users) {
      const doc = (await ctx.db.get(user.id as Id<"users">))!;
      await ctx.db.patch(doc._id, {
        groupIds: doc.groupIds!.filter((id) => id !== args.id),
      });
    }
    await ctx.db.delete(args.id);
    await removeGroupMemberships(ctx, {
      _id: args.id,
      programUuid: group.programUuid,
    });
    await audit(ctx, state.user.id, "group.deleted", args.id, {
      programUuid: group.programUuid,
      before: group,
      after: { removedMemberships: plan.users.map((u) => u.id) },
    });
  },
});

// The caller's program context, with the group's holders as its members.
async function load(
  ctx: QueryCtx | MutationCtx,
  programUuid: string | undefined,
  id: Id<"groups">,
) {
  const state = await checkContext(ctx, programUuid);
  const group = await ctx.db.get(id);
  return {
    ...state,
    members: group
      ? (await programUsers(ctx, group.programUuid, id)).map(member)
      : [],
  };
}
