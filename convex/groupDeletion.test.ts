import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { syncMemberships } from "./memberships";
import { demoSnapshot } from "../src/data/demo";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("programs", demoSnapshot().programs![0]);
    const manager = await ctx.db.insert("groups", {
      name: "Managers",
      programUuid: "demo-program",
      programAdmin: true,
      permissions: ["read"],
      aircraftIds: [],
    });
    const group = await ctx.db.insert("groups", {
      name: "Pilots",
      programUuid: "demo-program",
      programAdmin: false,
      permissions: ["read", "flight"],
      aircraftIds: [],
    });
    const foreign = await ctx.db.insert("groups", {
      name: "Foreign",
      programUuid: "foreign",
      programAdmin: false,
      permissions: ["read"],
      aircraftIds: [],
    });
    const owner = await ctx.db.insert("users", {
      name: "Manager",
      active: true,
      isAdmin: false,
      groupIds: [manager],
      activeProgramUuid: "demo-program",
    });
    const session = await ctx.db.insert("authSessions", {
      userId: owner,
      expirationTime: Date.now() + 86400000,
    });
    const user = await ctx.db.insert("users", {
      name: "Pilot",
      active: true,
      isAdmin: false,
      groupIds: [group, foreign],
    });
    return { manager, group, foreign, owner, session, user };
  });
  await t.mutation(internal.memberships.backfill, {});
  return {
    t,
    ids,
    client: t.withIdentity({ subject: `${ids.owner}|${ids.session}` }),
  };
}
it("reviews and deletes group memberships atomically while preserving accounts and other programs", async () => {
  const { t, ids, client } = await fixture();
  const scope = { id: ids.group, programUuid: "demo-program" };
  const preview = await client.query(api.groupDeletion.preview, scope);
  expect(preview.users).toEqual([
    { id: ids.user, name: "Pilot", losesProgramAccess: true },
  ]);
  await client.mutation(api.groupDeletion.remove, {
    ...scope,
    expected: preview.expected,
  });
  expect(await t.run((ctx) => ctx.db.get(ids.group))).toBeNull();
  expect(await t.run((ctx) => ctx.db.get(ids.user))).toMatchObject({
    active: true,
    isAdmin: false,
    groupIds: [ids.foreign],
  });
  expect(
    (await t.run((ctx) => ctx.db.query("memberships").collect()))
      .filter((m) => m.userId === ids.user)
      .map((m) => [m.groupId, m.programUuid]),
  ).toEqual([[ids.foreign, "foreign"]]);
  expect(
    (await t.run((ctx) => ctx.db.query("audit").collect())).some(
      (a) => a.action === "group.deleted",
    ),
  ).toBe(true);
});
it("rejects foreign groups and non-administrators", async () => {
  const { t, ids, client } = await fixture();
  await expect(
    client.query(api.groupDeletion.preview, {
      id: ids.foreign,
      programUuid: "demo-program",
    }),
  ).rejects.toThrow(/permission|not found/);
  await expect(
    client.mutation(api.groupDeletion.remove, {
      id: ids.foreign,
      programUuid: "demo-program",
      expected: "",
    }),
  ).rejects.toThrow(/permission|not found/);
  await t.run((ctx) => ctx.db.patch(ids.manager, { programAdmin: false }));
  await expect(
    client.query(api.groupDeletion.preview, {
      id: ids.group,
      programUuid: "demo-program",
    }),
  ).rejects.toThrow(/permission/);
});
it("requires a new review when membership or permissions change", async () => {
  const { t, ids, client } = await fixture();
  const scope = { id: ids.group, programUuid: "demo-program" };
  const preview = await client.query(api.groupDeletion.preview, scope);
  await t.run(async (ctx) => {
    await ctx.db.patch(ids.user, {
      groupIds: [ids.group, ids.manager, ids.foreign],
    });
    await syncMemberships(ctx, ids.user);
  });
  await expect(
    client.mutation(api.groupDeletion.remove, {
      ...scope,
      expected: preview.expected,
    }),
  ).rejects.toThrow(/changed/);
  expect(await t.run((ctx) => ctx.db.get(ids.group))).not.toBeNull();
});
