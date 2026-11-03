import { v } from "convex/values";
import { createAccount } from "@convex-dev/auth/server";
import {
  action,
  mutation,
  internalQuery,
  internalMutation,
  type QueryCtx,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { checkContext } from "./programContext";
import { programPermission } from "../src/domain/programs";
import { audit } from "./access";
import { syncMemberships } from "./memberships";
import type { Id } from "./_generated/dataModel";
import {
  ADD_EXISTING_RESULT,
  EMAIL_UNAVAILABLE,
} from "../src/domain/accountRules";
import {
  assertCreatedHere,
  consumeAccountRequest,
  normalizeEmail,
  reserveNewAccount,
  uniformCreateError,
} from "./accountGuards";

const scopeArgs = {
  programUuid: v.string(),
  groupIds: v.array(v.id("groups")),
};
async function authorize(
  ctx: QueryCtx | MutationCtx,
  args: { programUuid: string; groupIds: Id<"groups">[] },
) {
  const state = await checkContext(ctx, args.programUuid);
  if (!args.programUuid || !programPermission(state, "admin", args.programUuid))
    throw Error("Flight Program administrator permission required.");
  if (!state.programs.some((p) => p.uuid === args.programUuid))
    throw Error("Flight Program not found.");
  for (const id of args.groupIds) {
    const group = state.groups.find((g) => g.id === id);
    if (!group || group.programUuid !== args.programUuid)
      throw Error("Users can only be assigned groups in this Flight Program.");
  }
  return state;
}
export const check = internalQuery({
  args: scopeArgs,
  handler: async (ctx, args) => {
    const state = await authorize(ctx, args);
    if (
      !args.groupIds.length &&
      !state.groups.some(
        (g) =>
          g.programUuid === args.programUuid &&
          g.name === "Observers" &&
          !g.programAdmin &&
          !g.aircraftIds.length &&
          g.permissions.length === 1 &&
          g.permissions[0] === "read",
      )
    )
      throw Error(
        "Select a permission group; Observers read-only access is unavailable.",
      );
  },
});
// Rate-limited per actor; looks the email up before any hashing so an
// existing account is never touched and its password is never tested.
export const reserve = internalMutation({
  args: { ...scopeArgs, email: v.string() },
  handler: async (ctx, { email, ...scope }) => {
    const state = await authorize(ctx, scope);
    return reserveNewAccount(ctx, state.user.id as Id<"users">, email);
  },
});
// Only an account this create() call made: same email, created after the
// reservation, never activated.
const unfinishedAccountArgs = {
  userId: v.id("users"),
  email: v.string(),
  createdAfter: v.number(),
};
export const finish = internalMutation({
  args: { ...scopeArgs, ...unfinishedAccountArgs },
  handler: async (ctx, { userId, email, createdAfter, ...scope }) => {
    const args = { ...scope, userId };
    const state = await authorize(ctx, args);
    const user = await ctx.db.get(args.userId);
    if (
      !user ||
      user.email !== email ||
      user._creationTime < createdAfter ||
      user.active ||
      user.isAdmin ||
      user.groupIds?.length ||
      user.activeProgramUuid !== args.programUuid
    )
      throw Error("Only a newly provisioned account can be activated here.");
    const groupIds = [...new Set(args.groupIds)];
    if (
      !state.groups.some(
        (g) =>
          groupIds.includes(g.id as Id<"groups">) &&
          g.permissions.includes("read"),
      )
    ) {
      const read = state.groups.find(
        (g) =>
          g.programUuid === args.programUuid &&
          g.name === "Observers" &&
          !g.programAdmin &&
          !g.aircraftIds.length &&
          g.permissions.length === 1 &&
          g.permissions[0] === "read",
      );
      if (!read)
        throw Error(
          "Select a permission group; Observers read-only access is unavailable.",
        );
      groupIds.push(read.id as Id<"groups">);
    }
    await ctx.db.patch(args.userId, { active: true, isAdmin: false, groupIds });
    await syncMemberships(ctx, args.userId);
    await audit(ctx, state.user.id, "user.created", args.userId, {
      programUuid: args.programUuid,
      after: { groupIds, isAdmin: false },
    });
  },
});
export const create = action({
  args: {
    ...scopeArgs,
    email: v.string(),
    name: v.string(),
    password: v.string(),
  },
  handler: async (ctx, args): Promise<string> => {
    const scope = { programUuid: args.programUuid, groupIds: args.groupIds };
    await ctx.runQuery(internal.programUsers.check, scope);
    const email = normalizeEmail(args.email),
      name = args.name.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name || name.length > 150)
      throw Error("A valid email and name are required.");
    if (args.password.length < 12 || args.password.length > 128)
      throw Error("Use a password between 12 and 128 characters.");
    const { available, checkedAt } = await ctx.runMutation(
      internal.programUsers.reserve,
      { ...scope, email },
    );
    if (!available) throw Error(EMAIL_UNAVAILABLE);
    const { user } = await createAccount(ctx, {
      provider: "password",
      account: { id: email, secret: args.password },
      profile: {
        email,
        name,
        active: false,
        isAdmin: false,
        groupIds: [],
        activeProgramUuid: args.programUuid,
      },
    }).catch((error: unknown) => {
      throw uniformCreateError(error);
    });
    assertCreatedHere(user, checkedAt);
    const created = { userId: user._id, email, createdAfter: checkedAt };
    // Recheck scope before granting any access, including if permissions changed during hashing.
    try {
      await ctx.runMutation(internal.programUsers.finish, {
        ...scope,
        ...created,
      });
    } catch (error) {
      // Do not leave an unusable account holding this email.
      await ctx.runMutation(internal.programUsers.discard, created);
      throw error;
    }
    return user._id;
  },
});
export const discard = internalMutation({
  args: unfinishedAccountArgs,
  handler: async (ctx, { userId, email, createdAfter }) => {
    const user = await ctx.db.get(userId);
    // Only the never-activated account this create() call made is removed.
    if (
      !user ||
      user.email !== email ||
      user._creationTime < createdAfter ||
      user.active ||
      user.isAdmin ||
      user.groupIds?.length
    )
      return;
    const accounts = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
      .collect();
    if (
      accounts.some(
        (a) => a.provider !== "password" || a.providerAccountId !== email,
      )
    )
      return;
    for (const account of accounts) await ctx.db.delete(account._id);
    await ctx.db.delete(userId);
  },
});

// Replace membership only within the authorized program; account-wide fields stay untouched.
export const updateAccess = mutation({
  args: { ...scopeArgs, userId: v.id("users"), remove: v.boolean() },
  handler: async (ctx, args) => {
    const state = await authorize(ctx, args);
    const user = await ctx.db.get(args.userId);
    const belongs = (id: Id<"groups">) =>
      state.groups.some(
        (g) => g.id === id && g.programUuid === args.programUuid,
      );
    if (!user || !(user.groupIds ?? []).some(belongs))
      throw Error("User is not a member of this Flight Program.");
    const local = args.remove ? [] : [...new Set(args.groupIds)];
    if (!args.remove && !local.length)
      throw Error(
        "Select at least one permission group or remove program access.",
      );
    if (
      !args.remove &&
      !state.groups.some(
        (g) =>
          local.includes(g.id as Id<"groups">) &&
          g.permissions.includes("read"),
      )
    )
      throw Error("Select a group with read access.");
    const groupIds = [
      ...(user.groupIds ?? []).filter((id) => !belongs(id)),
      ...local,
    ];
    await ctx.db.patch(user._id, { groupIds });
    await syncMemberships(ctx, user._id);
    await audit(ctx, state.user.id, "user.program_access_changed", user._id, {
      programUuid: args.programUuid,
      before: { groupIds: (user.groupIds ?? []).filter(belongs) },
      after: { groupIds: local },
    });
  },
});
export const addExisting = mutation({
  args: { ...scopeArgs, email: v.string() },
  handler: async (ctx, args) => {
    const state = await authorize(ctx, args);
    if (
      !args.groupIds.length ||
      !state.groups.some(
        (g) =>
          args.groupIds.includes(g.id as Id<"groups">) &&
          g.permissions.includes("read"),
      )
    )
      throw Error("Select at least one group with read access.");
    // Every lookup counts, found or not, and the answer is the same either way
    // (issue #29, S11), so the function cannot be used to list accounts quickly.
    await consumeAccountRequest(
      ctx,
      "add-existing",
      state.user.id as Id<"users">,
    );
    const email = normalizeEmail(args.email);
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .unique();
    if (!user?.active) return ADD_EXISTING_RESULT;
    const groupIds = [...new Set([...(user.groupIds ?? []), ...args.groupIds])];
    await ctx.db.patch(user._id, { groupIds });
    await syncMemberships(ctx, user._id);
    await audit(ctx, state.user.id, "user.program_access_added", user._id, {
      programUuid: args.programUuid,
      after: {
        programName: state.programs.find((p) => p.uuid === args.programUuid)
          ?.name,
        groupIds: args.groupIds,
      },
    });
    return ADD_EXISTING_RESULT;
  },
});
