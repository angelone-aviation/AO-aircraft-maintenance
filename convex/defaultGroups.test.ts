import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import { defaultPermissionGroups } from "../src/domain/defaultPermissionGroups";
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
    const user = await ctx.db.insert("users", {
      active: true,
      isAdmin: true,
      groupIds: [],
      activeProgramUuid: "demo-program",
    });
    const session = await ctx.db.insert("authSessions", {
      userId: user,
      expirationTime: Date.now() + 86400000,
    });
    return { user, session };
  });
  return {
    t,
    ids,
    admin: t.withIdentity({ subject: `${ids.user}|${ids.session}` }),
  };
}
it("creates the default groups with a new program and keeps edits and retries duplicate-free", async () => {
  const { t, ids, admin } = await fixture();
  const command = {
    action: "program.save",
    requestUuid: crypto.randomUUID(),
    reason: "Create",
    program: {
      ...demoSnapshot().programs![0],
      uuid: "new",
      name: "New",
      version: 0,
    },
  };
  const args = {
    payload: JSON.stringify(command),
    programUuid: "demo-program",
  };
  await admin.mutation(api.fleet.save, args);
  await admin.mutation(api.fleet.save, args);
  await admin.mutation(api.fleet.save, {
    ...args,
    payload: JSON.stringify({
      ...command,
      requestUuid: crypto.randomUUID(),
      program: { ...command.program, version: 1, name: "Renamed" },
    }),
  });
  const groups = await t.run((ctx) => ctx.db.query("groups").collect());
  expect(groups).toHaveLength(5);
  for (const expected of defaultPermissionGroups)
    expect(groups.find((g) => g.name === expected.name)).toMatchObject({
      ...expected,
      programUuid: "new",
    });
  expect((await t.run((ctx) => ctx.db.get(ids.user)))!.groupIds).toEqual([]);
});
it("backfills only missing names and preserves custom groups and user assignments", async () => {
  const { t, ids, admin } = await fixture();
  const custom = await t.run(async (ctx) => {
    const id = await ctx.db.insert("groups", {
      programUuid: "demo-program",
      name: "Observers",
      aircraftIds: ["limited"],
      permissions: ["read"],
      programAdmin: false,
    });
    await ctx.db.patch(ids.user, { groupIds: [id] });
    return id;
  });
  const first = await admin.mutation(api.defaultGroups.initialize, {
    programUuid: "demo-program",
  });
  expect(first.created).toHaveLength(4);
  expect(
    (
      await admin.mutation(api.defaultGroups.initialize, {
        programUuid: "demo-program",
      })
    ).created,
  ).toEqual([]);
  expect(await t.run((ctx) => ctx.db.get(custom))).toMatchObject({
    aircraftIds: ["limited"],
  });
  expect(await t.run((ctx) => ctx.db.get(ids.user))).toMatchObject({
    groupIds: [custom],
  });
  await expect(
    t.mutation(api.defaultGroups.initialize, { programUuid: "demo-program" }),
  ).rejects.toThrow(/active account/);
  await t.run((ctx) => ctx.db.patch(ids.user, { isAdmin: false }));
  await expect(
    admin.mutation(api.defaultGroups.initialize, {
      programUuid: "demo-program",
    }),
  ).rejects.toThrow(/Administrator/);
});
