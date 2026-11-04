/**
 * Responsibility: Who uses a Flight Program, as its administrator manages it:
 *   new accounts, existing accounts added, and access changed or removed.
 * Layer: Server. Public mutations and an action over internal steps; every
 *   change is audited, and a user's access to other programs stays untouched.
 * Dependencies: @convex-dev/auth/server, convex/programContext, convex/access,
 *   convex/memberships, convex/accountGuards, src/domain (programs, model,
 *   accountRules).
 */
import { ConvexError, v } from "convex/values";
import { createAccount } from "@convex-dev/auth/server";
import {
  action,
  mutation,
  internalQuery,
  internalMutation,
  type ActionCtx,
  type QueryCtx,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { checkContext } from "./programContext";
import { programPermission } from "../src/domain/programs";
import type { Group } from "../src/domain/model";
import { audit } from "./access";
import { syncMemberships } from "./memberships";
import type { Doc, Id } from "./_generated/dataModel";
import {
  ADD_EXISTING_RESULT,
  EMAIL_UNAVAILABLE,
} from "../src/domain/accountRules";
import {
  assertCreatedHere,
  assertNewPassword,
  consumeAccountRequest,
  normalizeEmail,
  reserveNewAccount,
  uniformCreateError,
} from "./accountGuards";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_MAX_LENGTH = 150;

// The default read-only group (src/domain/defaultPermissionGroups.ts), matched
// by name and exact shape, so a renamed or widened group is never granted to
// a user nobody chose it for.
const OBSERVERS_GROUP_NAME = "Observers";

const scopeArgs = {
  programUuid: v.string(),
  groupIds: v.array(v.id("groups")),
};

const unfinishedAccountArgs = {
  userId: v.id("users"),
  email: v.string(),
  createdAfter: v.number(),
};

/**
 * Refuses an account creation before anything is hashed or stored.
 *
 * @param programUuid - The caller's active Flight Program.
 * @param groupIds - The groups to grant; none means the Observers group.
 * @throws {ConvexError} The {@link updateAccess} scope refusals; "Select a
 *   permission group; Observers read-only access is unavailable." for no
 *   groups when the program has no Observers group.
 */
export const check = internalQuery({
  args: scopeArgs,
  handler: async (ctx, args) => {
    const state = await authorizeProgramAdmin(ctx, args);
    if (!args.groupIds.length)
      requireObserversGroup(state.groups, args.programUuid);
  },
});

/**
 * Spends one of the administrator's hourly creations and checks the email is
 * free, before any password is hashed, so an existing account is never
 * touched and its password never tested.
 *
 * @param email - The normalized email.
 * @returns Whether the email is free, and when that was checked.
 * @throws {ConvexError} The {@link updateAccess} scope refusals; the
 *   allowance's refusal.
 */
export const reserve = internalMutation({
  args: { ...scopeArgs, email: v.string() },
  handler: async (ctx, { email, ...scope }) => {
    const state = await authorizeProgramAdmin(ctx, scope);
    return reserveNewAccount(ctx, state.user.id as Id<"users">, email);
  },
});

/**
 * Activates the account {@link create} just made, with the chosen groups or
 * else the Observers group, and audits `user.created`.
 *
 * @param userId - The new account; `email` and `createdAfter` must match it.
 * @throws {ConvexError} The {@link check} refusals, checked again; the
 *   Observers refusal also when no chosen group grants read access.
 * @throws {Error} "Only a newly provisioned account can be activated here."
 *   for any account but an inactive, groupless, non-administrator one with
 *   that email, created since `createdAfter` with this program active.
 */
export const finish = internalMutation({
  args: { ...scopeArgs, ...unfinishedAccountArgs },
  handler: async (ctx, { userId, email, createdAfter, ...scope }) => {
    const state = await authorizeProgramAdmin(ctx, scope);
    const user = await ctx.db.get(userId);
    if (
      !isUnfinishedAccount(user, { email, createdAfter }) ||
      user.activeProgramUuid !== scope.programUuid
    )
      throw new Error(
        "Only a newly provisioned account can be activated here.",
      );
    const groupIds = withReadAccess(state.groups, scope);
    await ctx.db.patch(userId, { active: true, isAdmin: false, groupIds });
    await syncMemberships(ctx, userId);
    await audit(ctx, state.user.id, "user.created", userId, {
      programUuid: scope.programUuid,
      after: { groupIds, isAdmin: false },
    });
  },
});

/**
 * Creates an account with a password and grants it the program's groups.
 *
 * @param programUuid - The caller's active Flight Program.
 * @param groupIds - Groups of that program; none means Observers.
 * @param email - The login email, normalized before use.
 * @param name - The person's name; trimmed, 1 to 150 characters.
 * @param password - At least 15 characters and not a common one (ADR-0009).
 * @returns The new user's id.
 * @throws {ConvexError} The {@link check} refusals; "A valid email and name
 *   are required."; the password's and the allowance's refusals; the
 *   {@link finish} refusals, after which the new account is discarded;
 *   {@link EMAIL_UNAVAILABLE} for any email that cannot be used, whichever
 *   check refused it (issue #29).
 */
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
    const { email, name } = parseNewAccount(args.email, args.name);
    assertNewPassword(args.password, email);
    const { available, checkedAt } = await ctx.runMutation(
      internal.programUsers.reserve,
      { ...scope, email },
    );
    // The same class as accountGuards throws, so neither the class nor the
    // message tells which check refused the email.
    if (!available) throw new ConvexError(EMAIL_UNAVAILABLE);
    const user = await createInactiveAccount(ctx, args, { email, name });
    assertCreatedHere(user, checkedAt);
    await activateOrDiscard(ctx, {
      ...scope,
      userId: user._id,
      email,
      createdAfter: checkedAt,
    });
    return user._id;
  },
});

/**
 * Deletes the account and password login {@link create} made when activating
 * it failed, so the email is not left held by an unusable account. Anything
 * else is left alone: an active, administrator or grouped account, another
 * email, one created before `createdAfter`, or one with another login.
 *
 * @param userId - The account; `email` and `createdAfter` must match it.
 */
export const discard = internalMutation({
  args: unfinishedAccountArgs,
  handler: async (ctx, { userId, email, createdAfter }) => {
    const user = await ctx.db.get(userId);
    if (!isUnfinishedAccount(user, { email, createdAfter })) return;
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

/**
 * Replaces a member's groups in this program, or removes them all; groups in
 * other programs and account-wide fields stay as they are. Audits
 * `user.program_access_changed` with this program's groups before and after.
 *
 * @param programUuid - The caller's active Flight Program.
 * @param groupIds - The member's new groups in it; ignored when `remove`.
 * @param userId - The member.
 * @param remove - Whether to remove the member's access to the program.
 * @throws {ConvexError} In order: "Flight Program administrator permission
 *   required."; "Flight Program not found."; "Users can only be assigned
 *   groups in this Flight Program."; "User is not a member of this Flight
 *   Program."; "Select at least one permission group or remove program
 *   access."; "Select a group with read access."
 * @throws As `checkContext`, first.
 */
export const updateAccess = mutation({
  args: { ...scopeArgs, userId: v.id("users"), remove: v.boolean() },
  handler: async (ctx, args) => {
    const state = await authorizeProgramAdmin(ctx, args);
    const user = await ctx.db.get(args.userId);
    const belongs = (id: Id<"groups">) =>
      state.groups.some(
        (g) => g.id === id && g.programUuid === args.programUuid,
      );
    if (!user || !(user.groupIds ?? []).some(belongs))
      throw new ConvexError("User is not a member of this Flight Program.");
    const local = args.remove ? [] : [...new Set(args.groupIds)];
    if (!args.remove) assertGrantsRead(state.groups, local);
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

/**
 * Gives an active account with this email the selected groups, and audits
 * `user.program_access_added` with the program's name and the groups.
 *
 * @param programUuid - The caller's active Flight Program.
 * @param groupIds - Groups of that program, at least one with read access.
 * @param email - The account's email, normalized before the lookup.
 * @returns {@link ADD_EXISTING_RESULT}, whether or not an account was found.
 * @throws {ConvexError} The {@link updateAccess} scope refusals; "Select at
 *   least one group with read access."; the allowance's refusal.
 */
export const addExisting = mutation({
  args: { ...scopeArgs, email: v.string() },
  handler: async (ctx, args) => {
    const state = await authorizeProgramAdmin(ctx, args);
    if (!args.groupIds.length || !grantsRead(state.groups, args.groupIds))
      throw new ConvexError("Select at least one group with read access.");
    // Every lookup counts, found or not, and the answer is the same either
    // way (issue #29, S11), so the function cannot list accounts quickly.
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

async function authorizeProgramAdmin(
  ctx: QueryCtx | MutationCtx,
  args: { programUuid: string; groupIds: Id<"groups">[] },
) {
  const state = await checkContext(ctx, args.programUuid);
  if (!args.programUuid || !programPermission(state, "admin", args.programUuid))
    throw new ConvexError("Flight Program administrator permission required.");
  if (!state.programs.some((p) => p.uuid === args.programUuid))
    throw new ConvexError("Flight Program not found.");
  for (const id of args.groupIds) {
    const group = state.groups.find((g) => g.id === id);
    if (!group || group.programUuid !== args.programUuid)
      throw new ConvexError(
        "Users can only be assigned groups in this Flight Program.",
      );
  }
  return state;
}

function parseNewAccount(rawEmail: string, rawName: string) {
  const email = normalizeEmail(rawEmail);
  const name = rawName.trim();
  if (!EMAIL_PATTERN.test(email) || !name || name.length > NAME_MAX_LENGTH)
    throw new ConvexError("A valid email and name are required.");
  return { email, name };
}

async function createInactiveAccount(
  ctx: ActionCtx,
  args: { programUuid: string; password: string },
  person: { email: string; name: string },
) {
  const { user } = await createAccount(ctx, {
    provider: "password",
    account: { id: person.email, secret: args.password },
    profile: {
      ...person,
      active: false,
      isAdmin: false,
      groupIds: [],
      activeProgramUuid: args.programUuid,
    },
  }).catch((error: unknown) => {
    throw uniformCreateError(error);
  });
  return user;
}

// Rechecks the scope before granting any access, since permissions may have
// changed while the password was hashed.
async function activateOrDiscard(
  ctx: ActionCtx,
  args: {
    programUuid: string;
    groupIds: Id<"groups">[];
    userId: Id<"users">;
    email: string;
    createdAfter: number;
  },
) {
  try {
    await ctx.runMutation(internal.programUsers.finish, args);
  } catch (error) {
    const { userId, email, createdAfter } = args;
    await ctx.runMutation(internal.programUsers.discard, {
      userId,
      email,
      createdAfter,
    });
    throw error;
  }
}

function isUnfinishedAccount(
  user: Doc<"users"> | null,
  expected: { email: string; createdAfter: number },
): user is Doc<"users"> {
  return (
    !!user &&
    user.email === expected.email &&
    user._creationTime >= expected.createdAfter &&
    !user.active &&
    !user.isAdmin &&
    !user.groupIds?.length
  );
}

// The selected groups, plus the Observers group when none of them grants read
// access.
function withReadAccess(
  groups: Group[],
  scope: { programUuid: string; groupIds: Id<"groups">[] },
): Id<"groups">[] {
  const groupIds = [...new Set(scope.groupIds)];
  if (grantsRead(groups, groupIds)) return groupIds;
  const observers = requireObserversGroup(groups, scope.programUuid);
  return [...groupIds, observers.id as Id<"groups">];
}

function requireObserversGroup(groups: Group[], programUuid: string): Group {
  const observers = groups.find(
    (g) =>
      g.programUuid === programUuid &&
      g.name === OBSERVERS_GROUP_NAME &&
      !g.programAdmin &&
      !g.aircraftIds.length &&
      g.permissions.length === 1 &&
      g.permissions[0] === "read",
  );
  if (!observers)
    throw new ConvexError(
      "Select a permission group; Observers read-only access is unavailable.",
    );
  return observers;
}

function assertGrantsRead(groups: Group[], groupIds: string[]): void {
  if (!groupIds.length)
    throw new ConvexError(
      "Select at least one permission group or remove program access.",
    );
  if (!grantsRead(groups, groupIds))
    throw new ConvexError("Select a group with read access.");
}

function grantsRead(groups: Group[], groupIds: string[]): boolean {
  return groups.some(
    (g) => groupIds.includes(g.id) && g.permissions.includes("read"),
  );
}
