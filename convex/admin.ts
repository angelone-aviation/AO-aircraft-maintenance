/**
 * Responsibility: Administration: accounts and permission groups, and each
 *   user's own logbook wording.
 * Layer: Server. Public actions and mutations over internal steps; every
 *   change is audited.
 * Dependencies: @convex-dev/auth/server, convex (access, certifications,
 *   programContext, memberships, accountGuards, pushSubscriptions,
 *   validators, userErrors), src/domain (certifications, releaseStatements,
 *   logbookWording, programs, accountRules).
 */
import { certificationsSchema } from "../src/domain/certifications";
import { releaseStatementsSchema } from "../src/domain/releaseStatements";
import { logbookPhrasesSchema } from "../src/domain/logbookWording";
import { currentUser, group } from "./access";
import { recordCertifications } from "./certifications";
import { context } from "./programContext";
import { activeProgram, programPermission } from "../src/domain/programs";
import {
  action,
  mutation,
  internalAction,
  internalQuery,
  internalMutation,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { ConvexError, v } from "convex/values";
import {
  createAccount,
  modifyAccountCredentials,
  invalidateSessions,
} from "@convex-dev/auth/server";
import { admin, audit } from "./access";
import { syncMemberships } from "./memberships";
import { forgetDevices } from "./pushSubscriptions";
import { permission } from "./validators";
import {
  ACCOUNT_NAME_MAX_LENGTH,
  assertKnownGroups,
  EMAIL_UNAVAILABLE,
  normalizeAccount,
  normalizeGroup,
  observersGroup,
} from "../src/domain/accountRules";
import {
  assertCreatedHere,
  assertNewPassword,
  clearSignInLockout,
  endSessions,
  reserveNewAccount,
  uniformCreateError,
} from "./accountGuards";
import { exposeRejections } from "./userErrors";

const accountArgs = {
  email: v.string(),
  name: v.string(),
  password: v.string(),
};

const groupArgs = {
  id: v.optional(v.id("groups")),
  programUuid: v.optional(v.string()),
  programAdmin: v.optional(v.boolean()),
  owner: v.optional(v.boolean()),
  board: v.optional(v.boolean()),
  name: v.string(),
  aircraftIds: v.array(v.string()),
  // An empty list means every program aircraft only when this is true
  // (assertGroupAircraftChoice); clients before #34 omit it.
  allAircraft: v.optional(v.boolean()),
  permissions: v.array(permission),
};

/**
 * The calling system administrator, for actions, which cannot read the
 * database themselves.
 *
 * @returns The administrator's user id.
 * @throws As `admin`.
 */
export const checkAdmin = internalQuery({
  args: {},
  handler: async (ctx) => (await admin(ctx))._id,
});

/** Whether no account exists yet, the one state {@link bootstrap} runs in. */
export const noUsers = internalQuery({
  args: {},
  handler: async (ctx) => (await ctx.db.query("users").first()) === null,
});

/**
 * Audits a new account as "user.created".
 *
 * @param actorId - Who created it; the account itself for the first
 *   administrator.
 * @param userId - The new account.
 */
export const recordProvision = internalMutation({
  args: { actorId: v.string(), userId: v.string() },
  handler: async (ctx, { actorId, userId }) => {
    await audit(ctx, actorId, "user.created", userId);
  },
});

/**
 * Spends one of the administrator's hourly account requests and checks the
 * email, before any hashing, so an existing account is never touched and its
 * password never tested.
 *
 * @param email - The normalized email.
 * @returns The administrator's id, whether the email is free, and when that
 *   was checked.
 * @throws {ConvexError} As `admin`; the request allowance's refusal.
 */
export const reserveCreate = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const actor = await admin(ctx);
    return {
      actorId: actor._id,
      ...(await reserveNewAccount(ctx, actor._id, email)),
    };
  },
});

/**
 * Creates an active account with no groups; audits "user.created".
 *
 * @param email - The login email; stored trimmed and lower-cased, the form
 *   sign-in looks it up in.
 * @param name - The person's name; up to 150 characters after trimming, and
 *   stored trimmed.
 * @param password - 15 or more characters, not a common one (ADR-0009).
 * @returns The new user's id.
 * @throws {ConvexError} As `admin`; "A valid email and name are required.";
 *   the password's and the allowance's refusals; EMAIL_UNAVAILABLE.
 */
export const createUser = action({
  args: accountArgs,
  handler: async (ctx, args): Promise<string> => {
    await ctx.runQuery(internal.admin.checkAdmin, {});
    const { email, name } = validateAccount(
      args.email,
      args.name,
      args.password,
    );
    const { actorId, available, checkedAt } = await ctx.runMutation(
      internal.admin.reserveCreate,
      { email },
    );
    if (!available) throw new ConvexError(EMAIL_UNAVAILABLE);
    const { user } = await createAccount(ctx, {
      provider: "password",
      account: { id: email, secret: args.password },
      profile: {
        name,
        email,
        active: true,
        isAdmin: false,
        groupIds: [],
      },
    }).catch((error: unknown) => {
      throw uniformCreateError(error);
    });
    assertCreatedHere(user, checkedAt);
    await ctx.runMutation(internal.admin.recordProvision, {
      actorId,
      userId: user._id,
    });
    return user._id;
  },
});

/**
 * Creates the first system administrator, from the trusted Convex CLI only,
 * never a public sign-up route. The password comes from the short-lived
 * BOOTSTRAP_ADMIN_PASSWORD variable (set over stdin by
 * scripts/bootstrap-admin.mjs), so it never appears in process arguments.
 *
 * @returns The new administrator's user id.
 * @throws {ConvexError} "Bootstrap is only available on an empty user
 *   database."; "Set BOOTSTRAP_ADMIN_PASSWORD with npm run setup:admin.";
 *   the account and password refusals of {@link createUser}.
 */
export const bootstrap = internalAction({
  args: { email: v.string(), name: v.string() },
  handler: async (ctx, { email, name }): Promise<string> => {
    if (!(await ctx.runQuery(internal.admin.noUsers, {})))
      throw new ConvexError(
        "Bootstrap is only available on an empty user database.",
      );
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "";
    if (!password)
      throw new ConvexError(
        "Set BOOTSTRAP_ADMIN_PASSWORD with npm run setup:admin.",
      );
    const account = validateAccount(email, name, password);
    const { user } = await createAccount(ctx, {
      provider: "password",
      account: { id: account.email, secret: password },
      profile: {
        name: account.name,
        email: account.email,
        active: true,
        isAdmin: true,
        groupIds: [],
      },
    });
    await ctx.runMutation(internal.admin.recordProvision, {
      actorId: user._id,
      userId: user._id,
    });
    return user._id;
  },
});

/**
 * The account a system administrator resets the password of.
 *
 * @param id - The account.
 * @returns The user, which has an email.
 * @throws {ConvexError} As `admin`; "Account not found." for a missing
 *   account or one without an email.
 */
export const accountForReset = internalQuery({
  args: { id: v.id("users") },
  handler: async (ctx, { id }) => {
    await admin(ctx);
    const user = await ctx.db.get(id);
    if (!user?.email) throw new ConvexError("Account not found.");
    return user;
  },
});

/**
 * Sets an account's password, ends its sessions and unlocks it; audits
 * "user.password_reset".
 *
 * @param id - The account.
 * @param password - 15 or more characters, not a common one (ADR-0009).
 * @throws {ConvexError} As {@link accountForReset}; the account and password
 *   refusals of {@link createUser}.
 */
export const resetPassword = action({
  args: { id: v.id("users"), password: v.string() },
  handler: async (ctx, { id, password }) => {
    const user = await ctx.runQuery(internal.admin.accountForReset, { id });
    const actorId = await ctx.runQuery(internal.admin.checkAdmin, {});
    validateAccount(user.email!, user.name ?? "User", password);
    await modifyAccountCredentials(ctx, {
      provider: "password",
      account: { id: user.email!, secret: password },
    });
    await invalidateSessions(ctx, { userId: id });
    await ctx.runMutation(internal.admin.recordPasswordReset, {
      actorId,
      userId: id,
    });
  },
});

/**
 * Audits a password reset, which also unlocks the account: it clears the
 * failed-sign-in counter and records whether one was cleared. Like the reset
 * sessions, the account's alerted devices are forgotten.
 *
 * @param actorId - The administrator.
 * @param userId - The account reset.
 */
export const recordPasswordReset = internalMutation({
  args: { actorId: v.string(), userId: v.id("users") },
  handler: async (ctx, args) => {
    const signInLockoutCleared = await clearSignInLockout(ctx, args.userId);
    await forgetDevices(ctx, args.userId);
    await audit(ctx, args.actorId, "user.password_reset", args.userId, {
      after: { signInLockoutCleared },
    });
  },
});

/**
 * Sets an account's status, administrator flag and groups, and optionally its
 * Flight Programs, name and certifications. A selected program where no
 * chosen group grants read access adds its Observers group. Audits
 * "user.permissions_changed"; disabling ends every session and forgets the
 * account's alerted devices. Certifications are filed as the member's own
 * save files them (`recordCertifications`): a new or changed one waits for
 * approval.
 *
 * @param programUuids - The programs the groups must belong to, when given.
 * @param certificationsPayload - JSON, as `certificationsSchema`.
 * @throws {ConvexError} As `admin`; "User not found."; "Keep at least one
 *   active administrator."; "Group not found."; "Flight Program not found.";
 *   "Permission groups must belong to the selected Flight Programs."; "Select
 *   an existing permission group for this Flight Program."; "Enter a name of
 *   up to 150 characters." (counted after trimming); the issue text of
 *   certifications `certificationsSchema` refuses.
 */
export const updateUser = mutation({
  args: {
    id: v.id("users"),
    active: v.boolean(),
    isAdmin: v.boolean(),
    groupIds: v.array(v.id("groups")),
    programUuids: v.optional(v.array(v.string())),
    name: v.optional(v.string()),
    certificationsPayload: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await admin(ctx);
    const before = await ctx.db.get(args.id);
    if (!before) throw new ConvexError("User not found.");
    await assertAdministratorRemains(ctx, before, args);
    const groupIds = await chooseGroups(ctx, args.groupIds, args.programUuids);
    const name = args.name?.trim();
    if (name !== undefined && (!name || name.length > ACCOUNT_NAME_MAX_LENGTH))
      throw new ConvexError("Enter a name of up to 150 characters.");
    const payload = args.certificationsPayload;
    const certifications =
      payload === undefined
        ? undefined
        : exposeRejections(() =>
            certificationsSchema.parse(JSON.parse(payload)),
          );
    await ctx.db.patch(args.id, {
      active: args.active,
      isAdmin: args.isAdmin,
      groupIds,
      ...(name === undefined ? {} : { name }),
    });
    await syncMemberships(ctx, args.id);
    await audit(ctx, actor._id, "user.permissions_changed", args.id, {
      before: accessFields(before),
      after: accessFields({ ...args, groupIds }),
    });
    if (!args.active) await endDisabledSessions(ctx, actor._id, before);
    if (certifications !== undefined)
      await recordCertifications(ctx, actor._id, before, certifications);
  },
});

/**
 * Creates or updates a permission group. A system administrator manages any
 * group; a Flight Program administrator, those of their active program.
 * Audits "group.saved".
 *
 * @returns The group's id.
 * @throws {ConvexError} "Administrator permission required for this Flight
 *   Program."; "Flight Program changed. Reopen the form in the correct
 *   program."; "Group not found."; then `normalizeGroup`'s refusals, among
 *   them "A permission group cannot be moved to another Flight Program.",
 *   "Group name is required.", "Write permissions also require read access."
 *   and "Select a Flight Program for this group." (also for a program that
 *   does not exist); "Group aircraft must belong to its Flight Program."
 */
export const saveGroup = mutation({
  args: groupArgs,
  handler: async (ctx, args) => {
    const actor = await currentUser(ctx);
    if (!actor.isAdmin)
      await assertProgramAdministrator(ctx, actor, args.programUuid);
    const existing = args.id ? await ctx.db.get(args.id) : undefined;
    if (args.id && !existing) throw new ConvexError("Group not found.");
    const before = existing ?? undefined;
    const fields = exposeRejections(() =>
      normalizeGroup(args, before && group(before)),
    );
    await assertGroupScope(ctx, fields.programUuid, fields.aircraftIds);
    const id = args.id ?? (await ctx.db.insert("groups", fields));
    if (args.id) await ctx.db.patch(id, fields);
    await audit(ctx, actor._id, "group.saved", id, {
      programUuid: args.programUuid,
      before,
      // The administrator's aircraft-access choice is kept with the saved
      // fields: it is how groupAudit tells an intended empty list (all
      // aircraft) from one an edit before #34 left behind.
      after:
        args.allAircraft === undefined
          ? fields
          : { ...fields, allAircraft: args.allAircraft },
    });
    return id;
  },
});

/**
 * Replaces the caller's own logbook phrases; audits
 * "user.logbook_phrases_updated".
 *
 * @throws As `currentUser`.
 * @throws {ConvexError} The issue text of phrases `logbookPhrasesSchema`
 *   refuses.
 */
export const saveLogbookPhrases = mutation({
  args: { phrases: v.array(v.string()) },
  handler: async (ctx, { phrases }) => {
    const user = await currentUser(ctx);
    const logbookPhrases = exposeRejections(() =>
      logbookPhrasesSchema.parse(phrases),
    );
    await ctx.db.patch(user._id, { logbookPhrases });
    await audit(ctx, user._id, "user.logbook_phrases_updated", user._id, {
      after: { logbookPhrases },
    });
  },
});

/**
 * Replaces the caller's own return-to-service statements; audits
 * "user.release_statements_updated".
 *
 * @throws As `currentUser`.
 * @throws {ConvexError} The issue text of statements
 *   `releaseStatementsSchema` refuses.
 */
export const saveReleaseStatements = mutation({
  args: {
    statements: v.array(v.object({ label: v.string(), text: v.string() })),
  },
  handler: async (ctx, { statements }) => {
    const user = await currentUser(ctx);
    const releaseStatements = exposeRejections(() =>
      releaseStatementsSchema.parse(statements),
    );
    await ctx.db.patch(user._id, { releaseStatements });
    await audit(ctx, user._id, "user.release_statements_updated", user._id, {
      after: { releaseStatements },
    });
  },
});

function validateAccount(email: string, name: string, password: string) {
  const account = exposeRejections(() => normalizeAccount(email, name));
  assertNewPassword(password, email);
  return account;
}

// Only an active administrator counts, so changing a disabled one cannot
// leave the system without one.
async function assertAdministratorRemains(
  ctx: MutationCtx,
  before: Doc<"users">,
  next: { active: boolean; isAdmin: boolean },
) {
  if (!before.isAdmin || !before.active || (next.isAdmin && next.active))
    return;
  const admins = (await ctx.db.query("users").collect()).filter(
    (u) => u.active && u.isAdmin,
  );
  if (admins.length === 1)
    throw new ConvexError("Keep at least one active administrator.");
}

async function chooseGroups(
  ctx: MutationCtx,
  chosen: Id<"groups">[],
  programUuids: string[] | undefined,
) {
  const groups = await ctx.db.query("groups").collect();
  const groupIds = [...new Set(chosen)];
  exposeRejections(() => assertKnownGroups(groups.map(group), groupIds));
  if (programUuids === undefined) return groupIds;
  const programs = await ctx.db.query("programs").collect();
  if (programUuids.some((uuid) => !programs.some((p) => p.uuid === uuid)))
    throw new ConvexError("Flight Program not found.");
  const programOf = (id: Id<"groups">) =>
    groups.find((g) => g._id === id)!.programUuid ?? "";
  if (groupIds.some((id) => !programUuids.includes(programOf(id))))
    throw new ConvexError(
      "Permission groups must belong to the selected Flight Programs.",
    );
  for (const uuid of new Set(programUuids))
    if (!grantsRead(groups, groupIds, uuid))
      groupIds.push(requireObservers(groups, uuid));
  return groupIds;
}

function grantsRead(
  groups: Doc<"groups">[],
  ids: Id<"groups">[],
  uuid: string,
) {
  return groups.some(
    (g) =>
      ids.includes(g._id) &&
      g.programUuid === uuid &&
      g.permissions.includes("read"),
  );
}

function requireObservers(groups: Doc<"groups">[], uuid: string) {
  const observers = observersGroup(groups.map(group), uuid);
  if (!observers)
    throw new ConvexError(
      "Select an existing permission group for this Flight Program.",
    );
  return observers.id as Id<"groups">;
}

function accessFields(
  user: Pick<Doc<"users">, "active" | "isAdmin" | "groupIds">,
) {
  return {
    active: user.active,
    isAdmin: user.isAdmin,
    groupIds: user.groupIds,
  };
}

// Disabling ends every session, so re-enabling revives none on lost devices,
// and every alerted device, so none keeps showing the member's alerts.
async function endDisabledSessions(
  ctx: MutationCtx,
  actorId: string,
  before: Doc<"users">,
) {
  const sessions = await endSessions(ctx, before._id);
  await forgetDevices(ctx, before._id);
  if (before.active || sessions)
    await audit(ctx, actorId, "user.sessions_ended", before._id, {
      after: { sessions },
    });
}

async function assertProgramAdministrator(
  ctx: MutationCtx,
  actor: Doc<"users">,
  programUuid: string | undefined,
) {
  const state = await context(ctx, actor);
  if (!programPermission(state, "admin"))
    throw new ConvexError(
      "Administrator permission required for this Flight Program.",
    );
  if (activeProgram(state) !== programUuid)
    throw new ConvexError(
      "Flight Program changed. Reopen the form in the correct program.",
    );
}

async function assertGroupScope(
  ctx: MutationCtx,
  programUuid: string,
  aircraftIds: string[],
) {
  const program = await ctx.db
    .query("programs")
    .withIndex("uuid", (q) => q.eq("uuid", programUuid))
    .unique();
  if (!program)
    throw new ConvexError("Select a Flight Program for this group.");
  for (const uuid of aircraftIds) {
    const aircraft = await ctx.db
      .query("aircraft")
      .withIndex("uuid", (q) => q.eq("uuid", uuid))
      .unique();
    // A missing aircraft has no program, so it is refused here too.
    if (aircraft?.programUuid !== programUuid)
      throw new ConvexError(
        "Group aircraft must belong to its Flight Program.",
      );
  }
}
