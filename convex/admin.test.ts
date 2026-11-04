/**
 * Responsibility: Pins administration's refusals, their messages and class,
 *   and account emails, account names and group names trimmed as stored.
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

it("counts an account name after trimming, as it is stored", async () => {
  const { t, ids, system } = await fixture();
  const password = "Tarmac-sunrise gauge 4417";
  const padded = (length: number) => ` ${"x".repeat(length)} `;
  const created = await system.action(api.admin.createUser, {
    email: "new@example.test",
    name: padded(150),
    password,
  });
  const member = { id: ids.member.id, active: true, isAdmin: false };
  await system.mutation(api.admin.updateUser, {
    ...member,
    groupIds: [ids.crew],
    name: padded(150),
  });
  const names = await t.run(async (ctx) => [
    (await ctx.db.get(created as Id<"users">))?.name,
    (await ctx.db.get(ids.member.id))?.name,
  ]);
  expect(names).toEqual(["x".repeat(150), "x".repeat(150)]);
  const tooLong = [
    system.action(api.admin.createUser, {
      email: "long@example.test",
      name: padded(151),
      password,
    }),
    system.mutation(api.admin.updateUser, {
      ...member,
      groupIds: [ids.crew],
      name: padded(151),
    }),
  ];
  expect(await Promise.all(tooLong.map(refusal))).toMatchObject([
    { data: "A valid email and name are required." },
    { data: "Enter a name of up to 150 characters." },
  ]);
});

it("trims an account email typed with spaces around it, as sign-in does", async () => {
  const password = "Tarmac-sunrise gauge 4417";
  vi.stubEnv("BOOTSTRAP_ADMIN_PASSWORD", password);
  const first = convexTest(schema, modules);
  await first.action(internal.admin.bootstrap, {
    email: " First@Example.test ",
    name: "First",
  });
  const { t, system } = await fixture();
  await system.action(api.admin.createUser, {
    email: "  Spaced@Example.test ",
    name: "Spaced",
    password,
  });
  const logins = async (run: typeof t) =>
    (await run.run((ctx) => ctx.db.query("authAccounts").collect())).map(
      (a) => a.providerAccountId,
    );
  expect(await logins(first)).toEqual(["first@example.test"]);
  expect(await logins(t)).toEqual(["spaced@example.test"]);
});

it("resets the password of a login stored with spaces around its email", async () => {
  const { t, system } = await fixture();
  const email = " legacy@example.test ";
  const id = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Legacy",
      email,
      active: true,
      isAdmin: false,
      groupIds: [],
    });
    await ctx.db.insert("authAccounts", {
      userId,
      provider: "password",
      providerAccountId: email,
      secret: "old hash",
    });
    return userId;
  });
  await system.action(api.admin.resetPassword, {
    id,
    password: "Tarmac-sunrise gauge 4417",
  });
  const login = await t.run((ctx) => ctx.db.query("authAccounts").unique());
  expect(login).toMatchObject({ providerAccountId: email });
  expect(login?.secret).not.toBe("old hash");
});

it("counts a group name after trimming, as it is stored", async () => {
  const { t, system } = await fixture();
  const save = (name: string) =>
    system.mutation(api.admin.saveGroup, {
      programUuid: "home",
      name,
      aircraftIds: [],
      allAircraft: true,
      permissions: ["read"],
    });
  const padded = (length: number) => ` ${"x".repeat(length)} `;
  const id = await save(padded(100));
  expect((await t.run((ctx) => ctx.db.get(id)))?.name).toBe("x".repeat(100));
  expect(await refusal(save(padded(101)))).toMatchObject({
    name: "ConvexError",
    data: "Group name is required.",
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
