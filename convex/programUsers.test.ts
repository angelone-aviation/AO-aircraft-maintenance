/**
 * Responsibility: Pins a Flight Program administrator's account management:
 *   creating, adding and changing access within the program only, its
 *   refusals and their classes, and the provisioning cleanup.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/programUsers.ts, convex/admin.ts, convex/schema.ts,
 *   src/domain/accountRules, src/data/demo.ts (fixture).
 */
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { it, vi, expect } from "vitest";
// These tests hash real passwords (scrypt) several times each; under a busy
// machine the 5 s default timeout is too tight, so allow 30 s.
vi.setConfig({ testTimeout: 30_000 });
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import {
  ADD_EXISTING_RESULT,
  EMAIL_UNAVAILABLE,
} from "../src/domain/accountRules";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const p = demoSnapshot().programs![0];
    await ctx.db.insert("programs", { ...p, uuid: "home" });
    await ctx.db.insert("programs", {
      ...p,
      uuid: "other",
      name: "Other program",
    });
    await ctx.db.insert("groups", {
      programUuid: "home",
      name: "Observers",
      programAdmin: false,
      aircraftIds: [],
      permissions: ["read"],
    });
    const manager = await ctx.db.insert("groups", {
      programUuid: "home",
      name: "Program administrators",
      programAdmin: true,
      aircraftIds: [],
      permissions: ["read"],
    });
    const own = await ctx.db.insert("groups", {
      programUuid: "home",
      name: "Maintenance",
      programAdmin: false,
      aircraftIds: [],
      permissions: ["read", "maintenance"],
    });
    const foreign = await ctx.db.insert("groups", {
      programUuid: "other",
      name: "Other administrators",
      programAdmin: true,
      aircraftIds: [],
      permissions: ["read"],
    });
    const make = async (groupIds: (typeof manager)[]) => {
      const user = await ctx.db.insert("users", {
        name: "Tester",
        email: `${groupIds[0]}@example.test`,
        active: true,
        isAdmin: false,
        groupIds,
        activeProgramUuid: "home",
      });
      const session = await ctx.db.insert("authSessions", {
        userId: user,
        expirationTime: Date.now() + 86400000,
      });
      return { user, identity: { subject: `${user}|${session}` } };
    };
    return {
      manager,
      own,
      foreign,
      admin: await make([manager]),
      member: await make([own]),
    };
  });
  return {
    t,
    ids,
    admin: t.withIdentity(ids.admin.identity),
    member: t.withIdentity(ids.member.identity),
  };
}
const details = {
  email: "new@example.test",
  name: "New user",
  password: "test-password-12345",
  programUuid: "home",
};
it("creates an account with only its program's groups and scoped member visibility", async () => {
  const { t, ids, admin } = await fixture();
  const id = await admin.action(api.programUsers.create, {
    ...details,
    groupIds: [ids.own],
  });
  const user = await t.run((ctx) => ctx.db.get(id as typeof ids.admin.user));
  expect(user).toMatchObject({
    active: true,
    isAdmin: false,
    activeProgramUuid: "home",
    groupIds: [ids.own],
  });
  const snapshot = await admin.query(api.operations.snapshot, {});
  expect(snapshot!.groups.some((g) => g.id === ids.own)).toBe(true);
  expect(snapshot!.groups.some((g) => g.id === ids.foreign)).toBe(false);
  expect(snapshot!.members.find((m) => m.id === id)).toMatchObject({
    email: details.email,
    groupIds: [ids.own],
  });
  await expect(
    admin.mutation(api.admin.updateUser, {
      id: user!._id,
      active: true,
      isAdmin: true,
      groupIds: [ids.foreign],
    }),
  ).rejects.toThrow(/Administrator/);
});
it("adds read access when no groups are selected", async () => {
  const { t, admin } = await fixture();
  const id = await admin.action(api.programUsers.create, {
    ...details,
    groupIds: [],
  });
  const user = await t.run((ctx) =>
    ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("_id"), id))
      .unique(),
  );
  expect(user!.groupIds).toHaveLength(1);
  const group = await t.run((ctx) => ctx.db.get(user!.groupIds![0]));
  expect(group).toMatchObject({
    programUuid: "home",
    programAdmin: false,
    permissions: ["read"],
  });
});
it("rejects other programs, foreign groups, ordinary users and unauthenticated callers before creating accounts", async () => {
  const { t, ids, admin, member } = await fixture();
  const before = await t.run((ctx) => ctx.db.query("users").collect());
  await expect(
    admin.action(api.programUsers.create, {
      ...details,
      groupIds: [ids.foreign],
    }),
  ).rejects.toThrow(/only.*this Flight Program/);
  await expect(
    admin.action(api.programUsers.create, {
      ...details,
      programUuid: "other",
      groupIds: [],
    }),
  ).rejects.toThrow(/Flight Program/);
  await expect(
    member.action(api.programUsers.create, { ...details, groupIds: [] }),
  ).rejects.toThrow(/[Aa]dministrator/);
  await expect(
    t.action(api.programUsers.create, { ...details, groupIds: [] }),
  ).rejects.toThrow(/active account/);
  expect(await t.run((ctx) => ctx.db.query("users").collect())).toHaveLength(
    before.length,
  );
});
it("rechecks program administrator permission before activating a provisioned account", async () => {
  const { t, ids, admin } = await fixture();
  await admin.query(internal.programUsers.check, {
    programUuid: "home",
    groupIds: [],
  });
  const target = await t.run(async (ctx) => {
    await ctx.db.patch(ids.admin.user, { groupIds: [ids.own] });
    return ctx.db.insert("users", {
      name: "Pending",
      email: "pending@example.test",
      active: false,
      isAdmin: false,
      groupIds: [],
      activeProgramUuid: "home",
    });
  });
  await expect(
    admin.mutation(internal.programUsers.finish, {
      programUuid: "home",
      groupIds: [],
      userId: target,
      email: "pending@example.test",
      createdAfter: 0,
    }),
  ).rejects.toThrow(/[Aa]dministrator/);
  expect(await t.run((ctx) => ctx.db.get(target))).toMatchObject({
    active: false,
    groupIds: [],
  });
});
it("does not take over an existing account with the same email", async () => {
  const { t, ids, admin } = await fixture();
  const id = await admin.action(api.programUsers.create, {
    ...details,
    groupIds: [ids.own],
  });
  await expect(
    admin.action(api.programUsers.create, {
      ...details,
      name: "Replacement",
      password: "different-password-12345",
      groupIds: [ids.manager],
    }),
  ).rejects.toThrow();
  const user = await t.run((ctx) => ctx.db.get(id as typeof ids.admin.user));
  expect(user).toMatchObject({
    name: details.name,
    groupIds: [ids.own],
    isAdmin: false,
  });
});
it("program administrators create aircraft only in their active program", async () => {
  const { t, admin, member } = await fixture();
  const aircraft = {
    ...demoSnapshot().aircraft[0],
    uuid: "new-aircraft",
    registration: "N123NEW",
    programUuid: "home",
  };
  await admin.mutation(api.admin.createAircraft, {
    aircraft,
    programUuid: "home",
  });
  expect(
    await t.run((ctx) =>
      ctx.db
        .query("aircraft")
        .withIndex("uuid", (q) => q.eq("uuid", aircraft.uuid))
        .unique(),
    ),
  ).toMatchObject({ programUuid: "home" });
  await expect(
    admin.mutation(api.admin.createAircraft, {
      aircraft: { ...aircraft, uuid: "foreign-aircraft", programUuid: "other" },
      programUuid: "home",
    }),
  ).rejects.toThrow(/active Flight Program/);
  await expect(
    member.mutation(api.admin.createAircraft, {
      aircraft: { ...aircraft, uuid: "member-aircraft" },
      programUuid: "home",
    }),
  ).rejects.toThrow(/[Aa]dministrator/);
});
it("program administrators create and edit groups without moving or changing foreign groups", async () => {
  const { t, ids, admin, member } = await fixture();
  const fields = {
    programUuid: "home",
    name: "New program managers",
    programAdmin: true,
    aircraftIds: [],
    permissions: ["read" as const],
  };
  const id = await admin.mutation(api.admin.saveGroup, fields);
  await admin.mutation(api.admin.saveGroup, {
    ...fields,
    id,
    name: "Updated managers",
  });
  expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
    programUuid: "home",
    programAdmin: true,
    name: "Updated managers",
  });
  await expect(
    admin.mutation(api.admin.saveGroup, { ...fields, id: ids.foreign }),
  ).rejects.toThrow(/cannot be moved/);
  await expect(
    admin.mutation(api.admin.saveGroup, { ...fields, programUuid: "other" }),
  ).rejects.toThrow(/Flight Program/);
  await expect(member.mutation(api.admin.saveGroup, fields)).rejects.toThrow(
    /[Aa]dministrator/,
  );
});
it("program access changes preserve other memberships, credentials and account-wide status", async () => {
  const { t, ids, admin, member } = await fixture();
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      name: "Shared user",
      email: "shared@example.test",
      active: true,
      isAdmin: false,
      groupIds: [ids.own, ids.foreign],
    }),
  );
  await admin.mutation(api.programUsers.updateAccess, {
    userId,
    programUuid: "home",
    groupIds: [ids.manager],
    remove: false,
  });
  expect(await t.run((ctx) => ctx.db.get(userId))).toMatchObject({
    active: true,
    isAdmin: false,
    name: "Shared user",
    email: "shared@example.test",
    groupIds: [ids.foreign, ids.manager],
  });
  await expect(
    admin.mutation(api.programUsers.updateAccess, {
      userId,
      programUuid: "home",
      groupIds: [ids.foreign],
      remove: false,
    }),
  ).rejects.toThrow(/only.*this Flight Program/);
  await expect(
    member.mutation(api.programUsers.updateAccess, {
      userId,
      programUuid: "home",
      groupIds: [],
      remove: true,
    }),
  ).rejects.toThrow(/[Aa]dministrator/);
  await admin.mutation(api.programUsers.updateAccess, {
    userId,
    programUuid: "home",
    groupIds: [],
    remove: true,
  });
  expect(await t.run((ctx) => ctx.db.get(userId))).toMatchObject({
    active: true,
    isAdmin: false,
    groupIds: [ids.foreign],
  });
  await expect(
    admin.mutation(api.programUsers.updateAccess, {
      userId,
      programUuid: "home",
      groupIds: [ids.own],
      remove: false,
    }),
  ).rejects.toThrow(/not a member/);
  await admin.mutation(api.programUsers.addExisting, {
    email: "shared@example.test",
    programUuid: "home",
    groupIds: [ids.own],
  });
  expect(await t.run((ctx) => ctx.db.get(userId))).toMatchObject({
    active: true,
    isAdmin: false,
    groupIds: [ids.foreign, ids.own],
  });
});
it("gives the same addExisting answer for unknown and inactive emails without adding them", async () => {
  const { t, ids, admin } = await fixture();
  await t.run((ctx) =>
    ctx.db.insert("users", {
      name: "Dormant",
      email: "dormant@example.test",
      active: false,
      isAdmin: false,
      groupIds: [],
    }),
  );
  const add = (email: string) =>
    admin.mutation(api.programUsers.addExisting, {
      email,
      programUuid: "home",
      groupIds: [ids.own],
    });
  expect(await add("dormant@example.test")).toBe(ADD_EXISTING_RESULT);
  expect(await add("nobody@example.test")).toBe(ADD_EXISTING_RESULT);
  const dormant = await t.run((ctx) =>
    ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", "dormant@example.test"))
      .unique(),
  );
  expect(dormant!.groupIds).toEqual([]);
});
it("removes a never-activated account and its login when activation fails", async () => {
  const { t, ids } = await fixture();
  const { pending, activeUser } = await t.run(async (ctx) => {
    const pending = await ctx.db.insert("users", {
      email: "pending@example.test",
      active: false,
      isAdmin: false,
      groupIds: [],
    });
    await ctx.db.insert("authAccounts", {
      userId: pending,
      provider: "password",
      providerAccountId: "pending@example.test",
      secret: "hash",
    });
    return { pending, activeUser: ids.admin.user };
  });
  await t.mutation(internal.programUsers.discard, {
    userId: pending,
    email: "pending@example.test",
    createdAfter: 0,
  });
  const activeEmail = (await t.run((ctx) => ctx.db.get(activeUser)))!.email!;
  await t.mutation(internal.programUsers.discard, {
    userId: activeUser,
    email: activeEmail,
    createdAfter: 0,
  });
  expect(await t.run((ctx) => ctx.db.get(pending))).toBeNull();
  expect(
    await t.run((ctx) => ctx.db.query("authAccounts").collect()),
  ).toHaveLength(0);
  expect(await t.run((ctx) => ctx.db.get(activeUser))).not.toBeNull();
});
it("validates new aircraft fields and hides which program holds a registration", async () => {
  const { t, admin } = await fixture();
  await t.run((ctx) =>
    ctx.db.insert("aircraft", {
      ...demoSnapshot().aircraft[0],
      uuid: "foreign-plane",
      registration: "N999OT",
      programUuid: "other",
    }),
  );
  const aircraft = {
    ...demoSnapshot().aircraft[0],
    uuid: "new-aircraft",
    registration: "n999ot",
    programUuid: "home",
  };
  await expect(
    admin.mutation(api.admin.createAircraft, { aircraft, programUuid: "home" }),
  ).rejects.toThrow("This registration cannot be used.");
  await expect(
    admin.mutation(api.admin.createAircraft, {
      aircraft: { ...aircraft, registration: "N1NEW", make: "x".repeat(151) },
      programUuid: "home",
    }),
  ).rejects.toThrow();
});

// The error a run rejects with.
const refusal = (run: Promise<unknown>) =>
  run.then(
    () => {
      throw new Error("Expected a refusal.");
    },
    (error: unknown) => error,
  );

it("shows the administrator's refusals as ConvexErrors, the uniform email refusal too, but keeps a misdirected activation plain", async () => {
  const { t, ids, admin } = await fixture();
  const { stranger, noRead } = await t.run(async (ctx) => ({
    stranger: await ctx.db.insert("users", {
      name: "Stranger",
      active: true,
      isAdmin: false,
      groupIds: [ids.foreign],
    }),
    noRead: await ctx.db.insert("groups", {
      programUuid: "home",
      name: "Flight only",
      programAdmin: false,
      aircraftIds: [],
      permissions: ["flight"],
    }),
  }));
  const access = { programUuid: "home", remove: false };
  const shown: [string, () => Promise<unknown>][] = [
    [
      "User is not a member of this Flight Program.",
      () =>
        admin.mutation(api.programUsers.updateAccess, {
          ...access,
          userId: stranger,
          groupIds: [ids.own],
        }),
    ],
    [
      "Select at least one permission group or remove program access.",
      () =>
        admin.mutation(api.programUsers.updateAccess, {
          ...access,
          userId: ids.member.user,
          groupIds: [],
        }),
    ],
    [
      "Select a group with read access.",
      () =>
        admin.mutation(api.programUsers.updateAccess, {
          ...access,
          userId: ids.member.user,
          groupIds: [noRead],
        }),
    ],
    [
      "Select a group with read access.",
      () =>
        admin.mutation(api.programUsers.addExisting, {
          programUuid: "home",
          groupIds: [],
          email: "someone@example.test",
        }),
    ],
    [
      "Select a group with read access.",
      () =>
        admin.mutation(api.programUsers.addExisting, {
          programUuid: "home",
          groupIds: [noRead],
          email: "someone@example.test",
        }),
    ],
    [
      "A valid email and name are required.",
      () =>
        admin.action(api.programUsers.create, {
          ...details,
          email: "not-an-email",
          groupIds: [ids.own],
        }),
    ],
  ];
  for (const [message, run] of shown)
    expect(await refusal(run()), message).toMatchObject({
      name: "ConvexError",
      data: message,
    });
  const taken = await refusal(
    admin.action(api.programUsers.create, {
      ...details,
      email: `${ids.manager}@example.test`,
      groupIds: [ids.own],
    }),
  );
  const misdirected = await refusal(
    admin.mutation(internal.programUsers.finish, {
      programUuid: "home",
      groupIds: [ids.own],
      userId: ids.member.user,
      email: `${ids.own}@example.test`,
      createdAfter: 0,
    }),
  );
  expect(taken).toMatchObject({
    name: "ConvexError",
    data: EMAIL_UNAVAILABLE,
    message: EMAIL_UNAVAILABLE,
  });
  expect(misdirected).toMatchObject({
    message: "Only a newly provisioned account can be activated here.",
  });
  expect(misdirected).not.toBeInstanceOf(ConvexError);
});

it("adds the Observers group when no chosen group grants read access, and refuses without one", async () => {
  const { t, admin } = await fixture();
  const { pending, noRead, observers } = await t.run(async (ctx) => ({
    pending: await ctx.db.insert("users", {
      name: "Pending",
      email: "pending@example.test",
      active: false,
      isAdmin: false,
      groupIds: [],
      activeProgramUuid: "home",
    }),
    noRead: await ctx.db.insert("groups", {
      programUuid: "home",
      name: "Flight only",
      programAdmin: false,
      aircraftIds: [],
      permissions: ["flight"],
    }),
    observers: (await ctx.db
      .query("groups")
      .filter((q) => q.eq(q.field("name"), "Observers"))
      .unique())!._id,
  }));
  const activation = {
    programUuid: "home",
    userId: pending,
    email: "pending@example.test",
    createdAfter: 0,
  };
  await admin.mutation(internal.programUsers.finish, {
    ...activation,
    groupIds: [noRead, noRead],
  });
  expect(await t.run((ctx) => ctx.db.get(pending))).toMatchObject({
    active: true,
    groupIds: [noRead, observers],
  });
  await t.run(async (ctx) => {
    await ctx.db.delete(observers);
    await ctx.db.patch(pending, { active: false, groupIds: [] });
  });
  const unavailable = {
    name: "ConvexError",
    data: "Select a permission group; Observers read-only access is unavailable.",
  };
  expect(
    await refusal(
      admin.query(internal.programUsers.check, {
        programUuid: "home",
        groupIds: [],
      }),
    ),
  ).toMatchObject(unavailable);
  expect(
    await refusal(
      admin.mutation(internal.programUsers.finish, {
        ...activation,
        groupIds: [noRead],
      }),
    ),
  ).toMatchObject(unavailable);
});
