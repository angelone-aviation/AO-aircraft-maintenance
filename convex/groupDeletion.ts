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
export const preview = query({
  args,
  handler: async (ctx, args) =>
    groupDeletionPlan(await load(ctx, args.programUuid, args.id), args.id),
});
export const remove = mutation({
  args: { ...args, expected: v.string() },
  handler: async (ctx, args) => {
    const state = await load(ctx, args.programUuid, args.id),
      plan = groupDeletionPlan(state, args.id);
    if (plan.expected !== args.expected)
      throw Error(
        "This group or its members changed. Close this dialog and review deletion again.",
      );
    const group = state.groups.find((g) => g.id === args.id)!;
    for (const user of plan.users) {
      const doc = await ctx.db.get(
        user.id as import("./_generated/dataModel").Id<"users">,
      );
      await ctx.db.patch(doc!._id, {
        groupIds: doc!.groupIds!.filter((id) => id !== args.id),
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
