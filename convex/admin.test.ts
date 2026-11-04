/**
 * Responsibility: Pins administration's refusals, their messages and class,
 *   and the new-aircraft checks the aircraft schema makes first.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/admin.ts, convex/schema.ts, src/data/demo.ts (fixture).
 */
import { convexTest } from "convex-test";
import { afterEach, expect, it, vi } from "vitest";
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

afterEach(() => {
  vi.unstubAllEnvs();
});

async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    for (const uuid of ["home", "other"])
      await ctx.db.insert("programs", {
        ...demoSnapshot().programs![0],
        uuid,
        name: uuid,
      });
    await ctx.db.insert("aircraft", {
      ...demoSnapshot().aircraft[0],
      uuid: "foreign-plane",
      registration: "N999OT",
      programUuid: "other",
      program: "other",
    });
    const group = (
      name: string,
      programAdmin: boolean,
      permissions: ("read" | "flight")[],
    ) =>
      ctx.db.insert("groups", {
        programUuid: "home",
        name,
        programAdmin,
        aircraftIds: [],
        permissions,
      });
    const managers = await group("Managers", true, ["read"]);
    const crew = await group("Crew", false, ["read", "flight"]);
    const gone = await group("Removed", false, ["read"]);
    await ctx.db.delete(gone);
    const user = async (
      name: string,
      isAdmin: boolean,
      groupIds: Id<"groups">[],
    ) => {
      const id = await ctx.db.insert("users", {
        name,
        email: `${name}@example.test`,
        active: true,
        isAdmin,
        groupIds,
        activeProgramUuid: "home",
      });
      const session = await ctx.db.insert("authSessions", {
        userId: id,
        expirationTime: Date.now() + 86400000,
      });
      return { id, identity: { subject: `${id}|${session}` } };
    };
    const removedUser = await ctx.db.insert("users", {
      name: "Removed",
      active: true,
      isAdmin: false,
      groupIds: [],
    });
    await ctx.db.delete(removedUser);
    return {
      managers,
      crew,
      gone,
      removedUser,
      noEmail: await ctx.db.insert("users", {
        name: "No email",
        active: true,
        isAdmin: false,
        groupIds: [],
      }),
      system: await user("system", true, []),
      manager: await user("manager", false, [managers]),
      member: await user("member", false, [crew]),
    };
  });
  return {
    t,
    ids,
    system: t.withIdentity(ids.system.identity),
    manager: t.withIdentity(ids.manager.identity),
    member: t.withIdentity(ids.member.identity),
  };
}

const newAircraft = {
  ...demoSnapshot().aircraft[0],
  uuid: "new-aircraft",
  registration: "N123NEW",
  programUuid: "home",
  program: "home",
};

// The error a run rejects with.
const refusal = (run: Promise<unknown>) =>
  run.then(
    () => {
      throw new Error("Expected a refusal.");
    },
    (error: unknown) => error,
  );

it("shows every administration refusal to the user as a ConvexError", async () => {
  const { t, ids, system, manager, member } = await fixture();
  const user = { id: ids.member.id, active: true, isAdmin: false };
  const group = {
    programUuid: "home",
    name: "Line crew",
    aircraftIds: [],
    allAircraft: true,
    permissions: ["read" as const],
  };
  const aircraft = (changes: Partial<typeof newAircraft>) =>
    manager.mutation(api.admin.createAircraft, {
      aircraft: { ...newAircraft, ...changes },
      programUuid: "home",
    });
  const shown: [string, () => Promise<unknown>][] = [
    [
      "A valid email and name are required.",
      () =>
        system.action(api.admin.createUser, {
          email: "not-an-email",
          name: "New user",
          password: "Tarmac-sunrise gauge 4417",
        }),
    ],
    [
      "Account not found.",
      () =>
        system.action(api.admin.resetPassword, {
          id: ids.noEmail,
          password: "Tarmac-sunrise gauge 4417",
        }),
    ],
    [
      "User not found.",
      () =>
        system.mutation(api.admin.updateUser, {
          ...user,
          id: ids.removedUser,
          groupIds: [],
        }),
    ],
    [
      "Keep at least one active administrator.",
      () =>
        system.mutation(api.admin.updateUser, {
          ...user,
          id: ids.system.id,
          groupIds: [],
        }),
    ],
    [
      "Group not found.",
      () =>
        system.mutation(api.admin.updateUser, {
          ...user,
          groupIds: [ids.gone],
        }),
    ],
    [
      "Flight Program not found.",
      () =>
        system.mutation(api.admin.updateUser, {
          ...user,
          groupIds: [],
          programUuids: ["missing"],
        }),
    ],
    [
      "Permission groups must belong to the selected Flight Programs.",
      () =>
        system.mutation(api.admin.updateUser, {
          ...user,
          groupIds: [ids.crew],
          programUuids: ["other"],
        }),
    ],
    [
      "Select an existing permission group for this Flight Program.",
      () =>
        system.mutation(api.admin.updateUser, {
          ...user,
          groupIds: [],
          programUuids: ["other"],
        }),
    ],
    [
      "Enter a name of up to 150 characters.",
      () =>
        system.mutation(api.admin.updateUser, {
          ...user,
          groupIds: [ids.crew],
          name: "x".repeat(151),
        }),
    ],
    [
      "Administrator permission required for this Flight Program.",
      () => member.mutation(api.admin.saveGroup, group),
    ],
    [
      "Flight Program changed. Reopen the form in the correct program.",
      () =>
        manager.mutation(api.admin.saveGroup, {
          ...group,
          programUuid: "other",
        }),
    ],
    [
      "Group not found.",
      () => system.mutation(api.admin.saveGroup, { ...group, id: ids.gone }),
    ],
    [
      "Group name is required.",
      () => system.mutation(api.admin.saveGroup, { ...group, name: " " }),
    ],
    [
      "Write permissions also require read access.",
      () =>
        system.mutation(api.admin.saveGroup, {
          ...group,
          permissions: ["flight"],
        }),
    ],
    [
      "Select a Flight Program for this group.",
      () =>
        system.mutation(api.admin.saveGroup, {
          ...group,
          programUuid: "missing",
        }),
    ],
    [
      "Group aircraft must belong to its Flight Program.",
      () =>
        system.mutation(api.admin.saveGroup, {
          ...group,
          allAircraft: false,
          aircraftIds: ["foreign-plane"],
        }),
    ],
    [
      "Group aircraft must belong to its Flight Program.",
      () =>
        system.mutation(api.admin.saveGroup, {
          ...group,
          allAircraft: false,
          aircraftIds: ["no-such-aircraft"],
        }),
    ],
    [
      "Aircraft must belong to the active Flight Program.",
      () => aircraft({ programUuid: "other" }),
    ],
    [
      "Flight Program administrator required.",
      () =>
        member.mutation(api.admin.createAircraft, {
          aircraft: newAircraft,
          programUuid: "home",
        }),
    ],
    [
      "Registration, make and serial number are required.",
      () => aircraft({ serial: " " }),
    ],
    [
      "Cyclic Hobbs Meter requires Helicopter.",
      () => aircraft({ meter: "cyclic", baselineCyclicHobbs: 0 }),
    ],
    [
      "Enable Flight time log first.",
      () => aircraft({ meter: "flightTimeLog", baselineFlightTimeLog: 0 }),
    ],
    [
      "Adjusted total time cannot be negative.",
      () => aircraft({ baselineHobbs: 0, adjustmentSeconds: -3600 }),
    ],
    [
      "Bootstrap is only available on an empty user database.",
      () =>
        t.action(internal.admin.bootstrap, {
          email: "first@example.test",
          name: "First",
        }),
    ],
  ];
  for (const [message, run] of shown)
    expect(await refusal(run()), message).toMatchObject({
      name: "ConvexError",
      data: message,
    });
});

it("refuses the first administrator without the password variable, as a ConvexError", async () => {
  vi.stubEnv("BOOTSTRAP_ADMIN_PASSWORD", "");
  const t = convexTest(schema, modules);
  const message = "Set BOOTSTRAP_ADMIN_PASSWORD with npm run setup:admin.";
  expect(
    await refusal(
      t.action(internal.admin.bootstrap, {
        email: "first@example.test",
        name: "First",
      }),
    ),
  ).toMatchObject({ name: "ConvexError", data: message });
});

it("refuses baselines and adjustments the aircraft schema refuses, storing nothing", async () => {
  const { t, manager } = await fixture();
  for (const changes of [
    { baselineHobbs: -360 },
    { baselineTach: 100 },
    { baselineCyclicHobbs: 1.5, helicopter: true },
    { baselineFlightTimeLog: Number.MAX_SAFE_INTEGER + 1 },
    { baselineCycles: -1 },
    { baselineLandings: 0.5 },
    { adjustmentSeconds: 90 },
    { adjustmentSeconds: Number.NaN },
  ])
    await expect(
      manager.mutation(api.admin.createAircraft, {
        aircraft: { ...newAircraft, ...changes },
        programUuid: "home",
      }),
      JSON.stringify(changes),
    ).rejects.toThrow();
  const stored = await t.run((ctx) =>
    ctx.db
      .query("aircraft")
      .withIndex("uuid", (q) => q.eq("uuid", newAircraft.uuid))
      .unique(),
  );
  expect(stored).toBeNull();
});

it("creates an aircraft at its baselines, in the active program, audited", async () => {
  const { t, ids, manager } = await fixture();
  await manager.mutation(api.admin.createAircraft, {
    aircraft: {
      ...newAircraft,
      registration: " n123new ",
      make: " Cessna ",
      program: "stale",
      programUuid: undefined,
      currentHobbs: 1,
      version: 7,
    },
    programUuid: "home",
  });
  const stored = await t.run((ctx) =>
    ctx.db
      .query("aircraft")
      .withIndex("uuid", (q) => q.eq("uuid", newAircraft.uuid))
      .unique(),
  );
  expect(stored).toMatchObject({
    registration: "N123NEW",
    make: "Cessna",
    programUuid: "home",
    program: "home",
    baselineMeter: "hobbs",
    baselineAdjustmentSeconds: 0,
    currentHobbs: newAircraft.baselineHobbs,
    currentTach: newAircraft.baselineTach,
    cycles: newAircraft.baselineCycles,
    landings: newAircraft.baselineLandings,
    version: 0,
    operationalStatus: "unknown",
  });
  const audit = await t.run((ctx) => ctx.db.query("audit").collect());
  expect(audit.find((a) => a.action === "aircraft.created")).toMatchObject({
    actorId: ids.manager.id,
    entityUuid: newAircraft.uuid,
  });
});
