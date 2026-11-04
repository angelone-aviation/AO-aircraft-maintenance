/**
 * Responsibility: Pins permission-group access on the server: all aircraft
 *   only by explicit choice (#34), a group's Flight Program fixed even when
 *   it has none, and the last active administrator kept (#52).
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/admin.ts, convex/programs.ts, convex/schema.ts,
 *   src/data/demo.ts (fixture).
 */
import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import type { Id } from "./_generated/dataModel";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const DAY_MS = 86_400_000;

/**
 * Seeds programs A and B with aircraft A1, A2 and B, an A managers group, an
 * A1 crew group and a legacy unscoped group, and signs in a system
 * administrator, a disabled former one, A's program administrator and crew.
 */
async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    for (const uuid of ["A", "B"])
      await ctx.db.insert("programs", {
        ...demoSnapshot().programs![0],
        uuid,
        name: uuid,
        email: `${uuid}@example.test`,
      });
    for (const [uuid, program] of [
      ["plane-A1", "A"],
      ["plane-A2", "A"],
      ["plane-B", "B"],
    ])
      await ctx.db.insert("aircraft", {
        ...demoSnapshot().aircraft[0],
        uuid,
        registration: uuid.toUpperCase(),
        programUuid: program,
        program,
      });
    const managersA = await ctx.db.insert("groups", {
      name: "A managers",
      programUuid: "A",
      programAdmin: true,
      aircraftIds: [],
      permissions: ["read"],
    });
    const crewA1 = await ctx.db.insert("groups", {
      name: "A1 crew",
      programUuid: "A",
      programAdmin: false,
      aircraftIds: ["plane-A1"],
      permissions: ["read", "flight"],
    });
    const legacy = await ctx.db.insert("groups", {
      name: "Legacy maintenance",
      programAdmin: false,
      aircraftIds: [],
      permissions: ["read", "maintenance"],
    });
    const users: Record<string, Id<"users">> = {};
    const sessions: Record<string, Id<"authSessions">> = {};
    for (const [name, groupIds, isAdmin, active] of [
      ["system", [], true, true],
      ["formerAdmin", [], true, false],
      ["programAdmin", [managersA], false, true],
      ["crew", [crewA1, legacy], false, true],
    ] as const) {
      const id = await ctx.db.insert("users", {
        name,
        email: `${name}@example.test`,
        active,
        isAdmin,
        groupIds: [...groupIds],
        activeProgramUuid: "A",
      });
      users[name] = id;
      sessions[name] = await ctx.db.insert("authSessions", {
        userId: id,
        expirationTime: Date.now() + DAY_MS,
      });
      for (const groupId of groupIds)
        await ctx.db.insert("memberships", {
          userId: id,
          groupId,
          programUuid: (await ctx.db.get(groupId))!.programUuid,
        });
    }
    return { users, sessions, managersA, crewA1, legacy };
  });
  const as = (name: string) =>
    t.withIdentity({ subject: `${ids.users[name]}|${ids.sessions[name]}` });
  return { t, ids, as };
}

const crewFields = (id: Id<"groups">) => ({
  id,
  programUuid: "A",
  programAdmin: false,
  owner: false,
  name: "A1 crew (renamed)",
  permissions: ["read" as const, "flight" as const],
});

it("refuses to widen a group whose restricted aircraft left the program, unless all aircraft is chosen explicitly (#34)", async () => {
  const { t, ids, as } = await setup();
  await as("system").mutation(api.programs.transfer, {
    programUuid: "A",
    kind: "aircraft",
    uuid: "plane-A1",
    destination: "B",
    reason: "Aircraft moved to program B.",
  });
  const crewAircraft = async () =>
    (await as("crew").query(api.operations.snapshot, {}))!.aircraft.map(
      (a) => a.uuid,
    );
  // The stale id grants nothing: the crew sees no aircraft in program A.
  expect(await crewAircraft()).toEqual([]);
  // What the group form sends after the transferred aircraft disappears from
  // its checklist: an empty list, which would mean every program aircraft.
  for (const actor of ["system", "programAdmin"])
    await expect(
      as(actor).mutation(api.admin.saveGroup, {
        ...crewFields(ids.crewA1),
        aircraftIds: [],
      }),
    ).rejects.toThrow(/all aircraft in this program/);
  await expect(
    as("system").mutation(api.admin.saveGroup, {
      ...crewFields(ids.crewA1),
      aircraftIds: [],
      allAircraft: false,
    }),
  ).rejects.toThrow(/all aircraft in this program/);
  await expect(
    as("system").mutation(api.admin.saveGroup, {
      ...crewFields(ids.crewA1),
      aircraftIds: ["plane-A1"],
    }),
  ).rejects.toThrow(/must belong/);
  expect(await t.run((ctx) => ctx.db.get(ids.crewA1))).toMatchObject({
    name: "A1 crew",
    aircraftIds: ["plane-A1"],
  });
  expect(await crewAircraft()).toEqual([]);
  // Narrowing to an aircraft still in the program needs no extra choice.
  await as("programAdmin").mutation(api.admin.saveGroup, {
    ...crewFields(ids.crewA1),
    aircraftIds: ["plane-A2"],
  });
  expect(await crewAircraft()).toEqual(["plane-A2"]);
  await expect(
    as("programAdmin").mutation(api.admin.saveGroup, {
      ...crewFields(ids.crewA1),
      aircraftIds: ["plane-A2"],
      allAircraft: true,
    }),
  ).rejects.toThrow(/not both/);
  // Every program aircraft only when chosen.
  await as("programAdmin").mutation(api.admin.saveGroup, {
    ...crewFields(ids.crewA1),
    aircraftIds: [],
    allAircraft: true,
  });
  expect(await crewAircraft()).toEqual(["plane-A2"]);
  expect(await t.run((ctx) => ctx.db.get(ids.crewA1))).toMatchObject({
    aircraftIds: [],
  });
  // A new group is never all aircraft by omission either.
  const fresh = {
    programUuid: "A",
    name: "Observers 2",
    aircraftIds: [],
    permissions: ["read" as const],
  };
  await expect(
    as("system").mutation(api.admin.saveGroup, fresh),
  ).rejects.toThrow(/all aircraft in this program/);
  await as("system").mutation(api.admin.saveGroup, {
    ...fresh,
    allAircraft: true,
  });
});

// No group is stored without a program (T21), so the #45 first assignment
// was retired: such a group is refused like a move, and nothing is written.
it("refuses to give a group stored without a Flight Program one", async () => {
  const { t, ids, as } = await setup();
  const legacy = {
    id: ids.legacy,
    programUuid: "A",
    programAdmin: false,
    owner: false,
    name: "Legacy maintenance",
    aircraftIds: [] as string[],
    permissions: ["read" as const, "maintenance" as const],
  };
  for (const name of ["programAdmin", "system"])
    await expect(
      as(name).mutation(api.admin.saveGroup, legacy),
    ).rejects.toThrow(
      "A permission group cannot be moved to another Flight Program.",
    );
  expect((await t.run((ctx) => ctx.db.get(ids.legacy)))?.programUuid).toBe(
    undefined,
  );
  const entries = await t.run((ctx) =>
    ctx.db
      .query("audit")
      .withIndex("entity", (q) => q.eq("entityUuid", ids.legacy))
      .collect(),
  );
  expect(entries).toEqual([]);
});

it("lets the only active administrator edit or demote a disabled administrator (#52)", async () => {
  const { t, ids, as } = await setup();
  await as("system").mutation(api.admin.updateUser, {
    id: ids.users.formerAdmin,
    active: false,
    isAdmin: false,
    groupIds: [],
    name: "Former administrator",
  });
  expect(await t.run((ctx) => ctx.db.get(ids.users.formerAdmin))).toMatchObject(
    { active: false, isAdmin: false, name: "Former administrator" },
  );
  // The last active administrator still cannot be disabled or demoted.
  for (const change of [
    { active: false, isAdmin: true },
    { active: true, isAdmin: false },
  ])
    await expect(
      as("system").mutation(api.admin.updateUser, {
        id: ids.users.system,
        groupIds: [],
        ...change,
      }),
    ).rejects.toThrow("Keep at least one active administrator.");
});
