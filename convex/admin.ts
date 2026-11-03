import { validateOwnerGroup } from "../src/domain/ownerView";
import {
  certificationsSchema,
  memberLicense,
} from "../src/domain/certifications";
import { totalSeconds } from "../src/domain/model";
import { releaseStatementsSchema } from "../src/domain/releaseStatements";
import { logbookPhrasesSchema } from "../src/domain/logbookWording";
import { licenseSchema } from "../src/domain/logbook";
import { currentUser } from "./access";
import { checkContext, context } from "./programContext";
import { activeProgram, programPermission } from "../src/domain/programs";
import {
  action,
  mutation,
  internalAction,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import {
  createAccount,
  modifyAccountCredentials,
  invalidateSessions,
} from "@convex-dev/auth/server";
import { admin, audit } from "./access";
import { programUsers, syncMemberships } from "./memberships";
import {
  assertGroupAircraftChoice,
  assertGroupProgramChange,
} from "../src/domain/groupAircraft";
import { aircraftFields, permission } from "./validators";
import { assertAvailableAircraft } from "./fleet";
import { aircraftInputSchema } from "../src/domain/fleet";
import { EMAIL_UNAVAILABLE } from "../src/domain/accountRules";
import {
  assertCreatedHere,
  assertNewPassword,
  clearSignInLockout,
  endSessions,
  normalizeEmail,
  reserveNewAccount,
  uniformCreateError,
} from "./accountGuards";
const accountArgs = {
  email: v.string(),
  name: v.string(),
  password: v.string(),
};
function validateAccount(email: string, name: string, password: string) {
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    !name.trim() ||
    name.length > 150
  )
    throw new Error("A valid email and name are required.");
  // 15 or more characters, not a common one (ADR-0009).
  assertNewPassword(password, email);
}
export const checkAdmin = internalQuery({
  args: {},
  handler: async (ctx) => (await admin(ctx))._id,
});
export const noUsers = internalQuery({
  args: {},
  handler: async (ctx) => (await ctx.db.query("users").first()) === null,
});
export const recordProvision = internalMutation({
  args: { actorId: v.string(), userId: v.string() },
  handler: async (ctx, { actorId, userId }) => {
    await audit(ctx, actorId, "user.created", userId);
  },
});
// Rate-limited per administrator; looks the email up before any hashing so an
// existing account is never touched and its password is never tested.
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
export const createUser = action({
  args: accountArgs,
  handler: async (ctx, { email, name, password }): Promise<string> => {
    await ctx.runQuery(internal.admin.checkAdmin, {});
    validateAccount(email, name, password);
    email = normalizeEmail(email);
    const { actorId, available, checkedAt } = await ctx.runMutation(
      internal.admin.reserveCreate,
      { email },
    );
    if (!available) throw new Error(EMAIL_UNAVAILABLE);
    const { user } = await createAccount(ctx, {
      provider: "password",
      account: { id: email, secret: password },
      profile: {
        name: name.trim(),
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
// Internal only: available from the trusted Convex CLI, never a public signup route.
// The password comes from a short-lived env var (set over stdin by
// scripts/bootstrap-admin.mjs) so it never appears in process arguments.
export const bootstrap = internalAction({
  args: { email: v.string(), name: v.string() },
  handler: async (ctx, { email, name }): Promise<string> => {
    if (!(await ctx.runQuery(internal.admin.noUsers, {})))
      throw new Error("Bootstrap is only available on an empty user database.");
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "";
    if (!password)
      throw new Error("Set BOOTSTRAP_ADMIN_PASSWORD with npm run setup:admin.");
    validateAccount(email, name, password);
    const { user } = await createAccount(ctx, {
      provider: "password",
      account: { id: email.trim().toLowerCase(), secret: password },
      profile: {
        name: name.trim(),
        email: email.trim().toLowerCase(),
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
export const accountForReset = internalQuery({
  args: { id: v.id("users") },
  handler: async (ctx, { id }) => {
    await admin(ctx);
    const user = await ctx.db.get(id);
    if (!user?.email) throw new Error("Account not found.");
    return user;
  },
});
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
// A reset also unlocks the account: it clears the failed-sign-in counter.
export const recordPasswordReset = internalMutation({
  args: { actorId: v.string(), userId: v.id("users") },
  handler: async (ctx, args) => {
    const signInLockoutCleared = await clearSignInLockout(ctx, args.userId);
    await audit(ctx, args.actorId, "user.password_reset", args.userId, {
      after: { signInLockoutCleared },
    });
  },
});
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
    if (!before) throw new Error("User not found.");
    // Only an active administrator counts; changing a disabled one cannot
    // leave the system without one.
    if (before.isAdmin && before.active && (!args.isAdmin || !args.active)) {
      const admins = (await ctx.db.query("users").collect()).filter(
        (u) => u.active && u.isAdmin,
      );
      if (admins.length === 1)
        throw new Error("Keep at least one active administrator.");
    }
    const groups = await ctx.db.query("groups").collect();
    const groupIds = [...new Set(args.groupIds)];
    for (const id of groupIds)
      if (!groups.some((g) => g._id === id)) throw Error("Group not found.");
    if (args.programUuids !== undefined) {
      const programs = await ctx.db.query("programs").collect();
      for (const uuid of args.programUuids)
        if (!programs.some((p) => p.uuid === uuid))
          throw Error("Flight Program not found.");
      if (
        groupIds.some(
          (id) =>
            !args.programUuids!.includes(
              groups.find((g) => g._id === id)!.programUuid ?? "",
            ),
        )
      )
        throw Error(
          "Permission groups must belong to the selected Flight Programs.",
        );
      for (const uuid of new Set(args.programUuids)) {
        if (
          groupIds.some((id) =>
            groups.some(
              (g) =>
                g._id === id &&
                g.programUuid === uuid &&
                g.permissions.includes("read"),
            ),
          )
        )
          continue;
        const readGroup = groups.find(
          (g) =>
            g.programUuid === uuid &&
            g.name === "Observers" &&
            !g.programAdmin &&
            !g.aircraftIds.length &&
            g.permissions.length === 1 &&
            g.permissions[0] === "read",
        );
        if (!readGroup)
          throw Error(
            "Select an existing permission group for this Flight Program.",
          );
        groupIds.push(readGroup._id);
      }
    }
    if (
      args.name !== undefined &&
      (!args.name.trim() || args.name.length > 150)
    )
      throw Error("Enter a name of up to 150 characters.");
    const certifications =
      args.certificationsPayload === undefined
        ? undefined
        : certificationsSchema.parse(JSON.parse(args.certificationsPayload));
    const fields = {
      active: args.active,
      isAdmin: args.isAdmin,
      groupIds,
      ...(args.name === undefined ? {} : { name: args.name.trim() }),
      ...(certifications === undefined
        ? {}
        : { certifications, ...memberLicense({ certifications }) }),
    };
    await ctx.db.patch(args.id, fields);
    await syncMemberships(ctx, args.id);
    await audit(ctx, actor._id, "user.permissions_changed", args.id, {
      before: {
        active: before.active,
        isAdmin: before.isAdmin,
        groupIds: before.groupIds,
      },
      after: { active: args.active, isAdmin: args.isAdmin, groupIds },
    });
    // Disabling ends every session, so re-enabling revives none on lost devices.
    if (!args.active) {
      const sessions = await endSessions(ctx, args.id);
      if (before.active || sessions)
        await audit(ctx, actor._id, "user.sessions_ended", args.id, {
          after: { sessions },
        });
    }
    if (certifications !== undefined)
      await audit(ctx, actor._id, "user.certifications_updated", args.id);
  },
});
export const saveGroup = mutation({
  args: {
    id: v.optional(v.id("groups")),
    programUuid: v.optional(v.string()),
    programAdmin: v.optional(v.boolean()),
    owner: v.optional(v.boolean()),
    name: v.string(),
    aircraftIds: v.array(v.string()),
    // An empty list means every program aircraft only when this is true
    // (assertGroupAircraftChoice); clients before #34 omit it.
    allAircraft: v.optional(v.boolean()),
    permissions: v.array(permission),
  },
  handler: async (ctx, args) => {
    const actor = await currentUser(ctx);
    if (!actor.isAdmin) {
      const state = await context(ctx, actor);
      if (!programPermission(state, "admin"))
        throw Error(
          "Administrator permission required for this Flight Program.",
        );
      if (activeProgram(state) !== args.programUuid)
        throw Error(
          "Flight Program changed. Reopen the form in the correct program.",
        );
    }
    const existing = args.id ? await ctx.db.get(args.id) : undefined;
    if (args.id && !existing) throw Error("Group not found.");
    const assigned = assertGroupProgramChange(
      existing ?? undefined,
      args,
      actor.isAdmin === true,
    );
    if (!args.name.trim() || args.name.length > 100)
      throw new Error("Group name is required.");
    if (!args.permissions.includes("read") && args.permissions.length)
      throw new Error("Write permissions also require read access.");
    validateOwnerGroup(args);
    assertGroupAircraftChoice(existing ?? undefined, args);
    if (
      !args.programUuid ||
      !(await ctx.db
        .query("programs")
        .withIndex("uuid", (q) => q.eq("uuid", args.programUuid!))
        .unique())
    )
      throw new Error("Select a Flight Program for this group.");
    for (const uuid of args.aircraftIds) {
      const aircraft = await ctx.db
        .query("aircraft")
        .withIndex("uuid", (q) => q.eq("uuid", uuid))
        .unique();
      if (aircraft?.programUuid !== args.programUuid)
        throw new Error("Group aircraft must belong to its Flight Program.");
    }
    for (const uuid of args.aircraftIds)
      if (
        !(await ctx.db
          .query("aircraft")
          .withIndex("uuid", (q) => q.eq("uuid", uuid))
          .unique())
      )
        throw new Error("Aircraft not found.");
    const before = args.id ? await ctx.db.get(args.id) : undefined;
    const fields = {
      programUuid: args.programUuid,
      programAdmin: args.programAdmin ?? false,
      owner: args.owner ?? false,
      name: args.name.trim(),
      aircraftIds: [...new Set(args.aircraftIds)],
      permissions: [...new Set(args.permissions)],
    };
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
    if (assigned) {
      // The membership index carries each group's program.
      for (const user of await programUsers(ctx, undefined, id))
        await syncMemberships(ctx, user._id);
      await audit(ctx, actor._id, "group.program_assigned", id, {
        programUuid: args.programUuid,
        before: { programUuid: null },
        after: { programUuid: args.programUuid },
      });
    }
    return id;
  },
});
export const createAircraft = mutation({
  args: {
    aircraft: v.object(aircraftFields),
    programUuid: v.optional(v.string()),
  },
  handler: async (ctx, { aircraft: a, programUuid }) => {
    const state = await checkContext(ctx, programUuid);
    if (a.programUuid && a.programUuid !== activeProgram(state))
      throw new Error("Aircraft must belong to the active Flight Program.");
    a.programUuid = activeProgram(state);
    if (!programPermission(state, "admin"))
      throw Error("Flight Program administrator required.");
    const actor = await currentUser(ctx);
    if (!a.registration.trim() || !a.make.trim() || !a.serial.trim())
      throw new Error("Registration, make and serial number are required.");
    // Same field rules (trimmed, 150-character limits) as fleet.save.
    const input = aircraftInputSchema.parse({
      twin: a.twin,
      turbine: a.turbine,
      amphibious: a.amphibious,
      helicopter: a.helicopter,
      flightTimeLog: a.flightTimeLog,
      uuid: a.uuid,
      version: 0,
      registration: a.registration,
      make: a.make,
      model: a.model,
      faaSearchModel: a.faaSearchModel,
      serial: a.serial,
      programUuid: a.programUuid,
      meter: a.meter,
      adjustmentSeconds: a.adjustmentSeconds,
      currentHobbs: a.baselineHobbs,
      currentTach: a.baselineTach,
      currentCyclicHobbs: a.baselineCyclicHobbs,
      currentFlightTimeLog: a.baselineFlightTimeLog,
      cycles: a.baselineCycles,
      landings: a.baselineLandings,
      operationalStatus: "unknown",
    });
    for (const n of [
      a.baselineHobbs,
      a.baselineTach,
      ...(a.baselineCyclicHobbs === undefined ? [] : [a.baselineCyclicHobbs]),
      ...(a.baselineFlightTimeLog === undefined
        ? []
        : [a.baselineFlightTimeLog]),
      a.baselineCycles,
      a.baselineLandings,
    ])
      if (!Number.isSafeInteger(n) || n < 0)
        throw new Error("Baselines must be nonnegative integers.");
    if (!Number.isSafeInteger(a.adjustmentSeconds))
      throw new Error("Invalid meter adjustment.");
    if (
      a.baselineHobbs % 360 !== 0 ||
      a.baselineTach % 360 !== 0 ||
      (a.baselineCyclicHobbs !== undefined &&
        a.baselineCyclicHobbs % 360 !== 0) ||
      (a.baselineFlightTimeLog !== undefined &&
        a.baselineFlightTimeLog % 360 !== 0)
    )
      throw new Error("Use tenths of an hour.");
    const registration = input.registration.toUpperCase();
    await assertAvailableAircraft(ctx, { uuid: input.uuid, registration });
    const normalized = {
      ...a,
      uuid: input.uuid,
      make: input.make,
      model: input.model,
      faaSearchModel: input.faaSearchModel,
      serial: input.serial,
      program: state.programs.find((p) => p.uuid === a.programUuid)?.name ?? "",
      counterEvents: undefined,
      baselineMeter: a.meter,
      baselineAdjustmentSeconds: a.adjustmentSeconds,
      registration,
      currentHobbs: a.baselineHobbs,
      currentTach: a.baselineTach,
      currentCyclicHobbs: a.baselineCyclicHobbs,
      currentFlightTimeLog: a.baselineFlightTimeLog,
      cycles: a.baselineCycles,
      landings: a.baselineLandings,
      version: 0,
      latestFlightAt: undefined,
      operationalStatus: "unknown" as const,
    };
    if (a.meter === "cyclic" && !a.helicopter)
      throw new Error("Cyclic Hobbs Meter requires Helicopter.");
    if (a.meter === "flightTimeLog" && !a.flightTimeLog)
      throw new Error("Enable Flight time log first.");
    const total = totalSeconds(normalized);
    if (total < 0) throw new Error("Adjusted total time cannot be negative.");
    await ctx.db.insert("aircraft", normalized);
    await audit(ctx, actor._id, "aircraft.created", a.uuid, {
      aircraftUuid: a.uuid,
      after: normalized,
    });
  },
});

export const saveLicense = mutation({
  args: { licenseNumber: v.string(), certificateType: v.string() },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    const fields = licenseSchema.parse(args);
    await ctx.db.patch(user._id, fields);
    await audit(ctx, user._id, "user.license_updated", user._id, {
      after: fields,
    });
  },
});

export const saveLogbookPhrases = mutation({
  args: { phrases: v.array(v.string()) },
  handler: async (ctx, { phrases }) => {
    const user = await currentUser(ctx);
    const logbookPhrases = logbookPhrasesSchema.parse(phrases);
    await ctx.db.patch(user._id, { logbookPhrases });
    await audit(ctx, user._id, "user.logbook_phrases_updated", user._id, {
      after: { logbookPhrases },
    });
  },
});

export const saveReleaseStatements = mutation({
  args: {
    statements: v.array(v.object({ label: v.string(), text: v.string() })),
  },
  handler: async (ctx, { statements }) => {
    const user = await currentUser(ctx);
    const releaseStatements = releaseStatementsSchema.parse(statements);
    await ctx.db.patch(user._id, { releaseStatements });
    await audit(ctx, user._id, "user.release_statements_updated", user._id, {
      after: { releaseStatements },
    });
  },
});
