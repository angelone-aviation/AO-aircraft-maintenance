import { convexTest } from "convex-test";
import { it, expect, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import type { Id } from "./_generated/dataModel";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    for (const uuid of ["A", "B"]) {
      await ctx.db.insert("programs", {
        ...demoSnapshot().programs![0],
        uuid,
        name: uuid,
      });
      await ctx.db.insert("aircraft", {
        ...demoSnapshot().aircraft[0],
        uuid: `plane-${uuid}`,
        registration: uuid,
        programUuid: uuid,
        program: uuid,
      });
    }
    const group = (programUuid: string, name: string, programAdmin = false) =>
      ctx.db.insert("groups", {
        name,
        programUuid,
        programAdmin,
        aircraftIds: [],
        permissions: ["read"],
      });
    const groups = {
      managers: await group("A", "A managers", true),
      readers: await group("A", "A readers"),
      pilots: await group("A", "A pilots"),
      b: await group("B", "B readers"),
    };
    const users: Record<string, Id<"users">> = {};
    const subjects: Record<string, string> = {};
    for (const [name, groupIds, isAdmin, activeProgramUuid] of [
      ["system", [], true, "A"],
      ["manager", [groups.managers], false, "A"],
      ["alice", [], false, "A"],
      ["bob", [groups.b], false, "B"],
    ] as const) {
      users[name] = await ctx.db.insert("users", {
        name,
        email: `${name}@example.test`,
        active: true,
        isAdmin,
        groupIds: [...groupIds],
        activeProgramUuid,
      });
      subjects[name] = `${users[name]}|${await ctx.db.insert("authSessions", {
        userId: users[name],
        expirationTime: Date.now() + 86400000,
      })}`;
    }
    return { groups, users, subjects };
  });
  // Existing accounts predate the index; the backfill populates it.
  await t.mutation(internal.memberships.backfill, {});
  const as = (name: string) => t.withIdentity({ subject: ids.subjects[name] });
  // The index must always equal what users.groupIds implies.
  const assertInSync = () =>
    t.run(async (ctx) => {
      const expected = [];
      for (const user of await ctx.db.query("users").collect())
        for (const groupId of user.groupIds ?? []) {
          const g = await ctx.db.get(groupId);
          if (g) expected.push(`${user._id}|${groupId}|${g.programUuid}`);
        }
      const actual = (await ctx.db.query("memberships").collect()).map(
        (m) => `${m.userId}|${m.groupId}|${m.programUuid}`,
      );
      expect(actual.sort()).toEqual(expected.sort());
      return actual;
    });
  const memberNames = async (name: string) =>
    (await as(name).query(api.operations.snapshot, {}))!.members
      .map((m) => m.name)
      .sort();
  return { t, ids, as, assertInSync, memberNames };
}
it("keeps memberships in sync when users are added, regrouped, removed and groups deleted", async () => {
  const { ids, as, assertInSync } = await setup();
  const { groups, users } = ids;
  await assertInSync();
  const manager = as("manager");
  await manager.mutation(api.programUsers.addExisting, {
    email: "alice@example.test",
    programUuid: "A",
    groupIds: [groups.readers],
  });
  await assertInSync();
  await manager.mutation(api.programUsers.updateAccess, {
    userId: users.alice,
    programUuid: "A",
    groupIds: [groups.pilots],
    remove: false,
  });
  expect(
    (await assertInSync()).filter((m) => m.startsWith(users.alice)),
  ).toEqual([`${users.alice}|${groups.pilots}|A`]);
  await as("system").mutation(api.admin.updateUser, {
    id: users.alice,
    active: true,
    isAdmin: false,
    groupIds: [groups.pilots, groups.b],
  });
  await assertInSync();
  await manager.mutation(api.programUsers.updateAccess, {
    userId: users.alice,
    programUuid: "A",
    groupIds: [],
    remove: true,
  });
  expect(
    (await assertInSync()).filter((m) => m.startsWith(users.alice)),
  ).toEqual([`${users.alice}|${groups.b}|B`]);
  const system = as("system");
  const scope = { id: groups.b, programUuid: "A" };
  const preview = await system.query(api.groupDeletion.preview, scope);
  expect(preview.users.map((u) => u.id).sort()).toEqual(
    [users.alice, users.bob].sort(),
  );
  await system.mutation(api.groupDeletion.remove, {
    ...scope,
    expected: preview.expected,
  });
  expect((await assertInSync()).some((m) => m.endsWith(`|${groups.b}|B`))).toBe(
    false,
  );
});
it("builds snapshot members from the active program only, unchanged by aircraft transfers", async () => {
  const { ids, as, assertInSync, memberNames } = await setup();
  expect(await memberNames("manager")).toEqual(["manager"]);
  await as("manager").mutation(api.programUsers.addExisting, {
    email: "alice@example.test",
    programUuid: "A",
    groupIds: [ids.groups.readers],
  });
  expect(await memberNames("manager")).toEqual(["alice", "manager"]);
  expect(await memberNames("bob")).toEqual(["bob"]);
  // System administrators manage every account.
  expect(await memberNames("system")).toEqual([
    "alice",
    "bob",
    "manager",
    "system",
  ]);
  const before = await assertInSync();
  await as("system").mutation(api.programs.transfer, {
    programUuid: "A",
    kind: "aircraft",
    uuid: "plane-A",
    destination: "B",
    reason: "Move base",
  });
  expect(await assertInSync()).toEqual(before);
  expect(await memberNames("manager")).toEqual(["alice", "manager"]);
  expect(await memberNames("bob")).toEqual(["bob"]);
});
it("backfills idempotently in scheduled batches and repairs stale rows", async () => {
  vi.useFakeTimers();
  try {
    const { t, ids, assertInSync } = await setup();
    const before = await assertInSync();
    await t.run(async (ctx) => {
      for (let i = 0; i < 230; i++)
        await ctx.db.insert("users", {
          name: `bulk ${i}`,
          active: true,
          groupIds: [i % 2 ? ids.groups.readers : ids.groups.b],
        });
      // A stale row and a duplicate the backfill must remove.
      await ctx.db.insert("memberships", {
        userId: ids.users.alice,
        groupId: ids.groups.pilots,
        programUuid: "A",
      });
      const bobRow = {
        userId: ids.users.bob,
        groupId: ids.groups.b,
        programUuid: "B",
      };
      await ctx.db.insert("memberships", bobRow);
    });
    await t.mutation(internal.memberships.backfill, {});
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    const once = await assertInSync();
    expect(once).toHaveLength(before.length + 230);
    const rowIds = () =>
      t.run(async (ctx) =>
        (await ctx.db.query("memberships").collect()).map((m) => m._id),
      );
    const stable = await rowIds();
    await t.mutation(internal.memberships.backfill, {});
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await rowIds()).toEqual(stable);
  } finally {
    vi.useRealTimers();
  }
});
