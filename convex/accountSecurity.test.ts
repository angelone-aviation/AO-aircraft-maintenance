import { convexTest } from "convex-test";
import { it, vi, expect, beforeAll } from "vitest";
// These tests hash real passwords (scrypt) several times each; under a busy
// machine the 5 s default timeout is too tight, so allow 30 s.
vi.setConfig({ testTimeout: 30_000 });
import { exportPKCS8, generateKeyPair } from "jose";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import {
  ACCOUNT_REQUESTS_PER_HOUR,
  ADD_EXISTING_RESULT,
  EMAIL_UNAVAILABLE,
} from "../src/domain/accountRules";
import { MAX_FAILED_SIGN_INS_PER_HOUR } from "./auth";
import {
  PASSWORD_COMMON_MESSAGE,
  PASSWORD_LENGTH_MESSAGE,
} from "../src/domain/passwordRules";
import type { Id } from "./_generated/dataModel";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
// Password sign-in issues a signed JWT, so the tests need a signing key.
beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(privateKey);
  process.env.CONVEX_SITE_URL = "https://test.convex.site";
});
const PASSWORD = "correct-horse-battery-1";
async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const p = demoSnapshot().programs![0];
    await ctx.db.insert("programs", { ...p, uuid: "home", name: "Home" });
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
    const make = async (
      email: string,
      fields: { isAdmin: boolean; groupIds: Id<"groups">[] },
    ) => {
      const user = await ctx.db.insert("users", {
        name: email,
        email,
        active: true,
        activeProgramUuid: "home",
        ...fields,
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
      system: await make("system@example.test", {
        isAdmin: true,
        groupIds: [],
      }),
      program: await make("program@example.test", {
        isAdmin: false,
        groupIds: [manager],
      }),
    };
  });
  return {
    t,
    ids,
    system: t.withIdentity(ids.system.identity),
    program: t.withIdentity(ids.program.identity),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
// A real account (user + hashed password), created the supported way.
async function provision(f: Fixture, email: string) {
  return (await f.system.action(api.admin.createUser, {
    email,
    name: "Existing user",
    password: PASSWORD,
  })) as Id<"users">;
}
const message = (p: Promise<unknown>) =>
  p.then(
    () => "",
    (e: Error) => e.message,
  );
const signIn = (f: Fixture, email: string, password: string) =>
  f.t.action(api.auth.signIn, {
    provider: "password",
    params: { flow: "signIn", email, password },
  });

it("program account creation fails the same way for an existing email, right or wrong password, and leaves it untouched", async () => {
  const f = await fixture();
  const existing = await provision(f, "taken@example.test");
  await f.system.mutation(api.admin.updateUser, {
    id: existing,
    active: false,
    isAdmin: false,
    groupIds: [],
  });
  const snapshot = () =>
    f.t.run(async (ctx) => ({
      user: await ctx.db.get(existing),
      accounts: await ctx.db.query("authAccounts").collect(),
      users: (await ctx.db.query("users").collect()).length,
    }));
  const before = await snapshot();
  const create = (password: string) =>
    f.program.action(api.programUsers.create, {
      email: "Taken@Example.test",
      name: "Intruder",
      password,
      programUuid: "home",
      groupIds: [f.ids.own],
    });
  const right = await message(create(PASSWORD));
  const wrong = await message(create("some-other-password-9"));
  expect(right).toBe(EMAIL_UNAVAILABLE);
  expect(wrong).toBe(right);
  expect(await snapshot()).toEqual(before);
});

it("system administrator account creation fails the same way for an existing email and leaves it untouched", async () => {
  const f = await fixture();
  const existing = await provision(f, "taken@example.test");
  const before = await f.t.run(async (ctx) => ({
    user: await ctx.db.get(existing),
    accounts: await ctx.db.query("authAccounts").collect(),
  }));
  const create = (password: string) =>
    f.system.action(api.admin.createUser, {
      email: "taken@example.test",
      name: "Intruder",
      password,
    });
  expect(await message(create(PASSWORD))).toBe(EMAIL_UNAVAILABLE);
  expect(await message(create("some-other-password-9"))).toBe(
    EMAIL_UNAVAILABLE,
  );
  // An email held by a user row without a password login is also unavailable.
  await f.t.run((ctx) =>
    ctx.db.insert("users", {
      email: "nologin@example.test",
      active: true,
      isAdmin: false,
      groupIds: [],
    }),
  );
  expect(
    await message(
      f.system.action(api.admin.createUser, {
        email: "nologin@example.test",
        name: "Intruder",
        password: PASSWORD,
      }),
    ),
  ).toBe(EMAIL_UNAVAILABLE);
  expect(
    await f.t.run(async (ctx) => ({
      user: await ctx.db.get(existing),
      accounts: await ctx.db.query("authAccounts").collect(),
    })),
  ).toEqual(before);
  const audit = await f.t.run((ctx) => ctx.db.query("audit").collect());
  expect(audit.filter((a) => a.action === "user.created")).toHaveLength(1);
});

it("discard removes only an unfinished account created in the same call", async () => {
  const f = await fixture();
  const dormant = await f.t.run(async (ctx) => {
    const dormant = await ctx.db.insert("users", {
      email: "dormant@example.test",
      active: false,
      isAdmin: false,
      groupIds: [],
    });
    await ctx.db.insert("authAccounts", {
      userId: dormant,
      provider: "password",
      providerAccountId: "dormant@example.test",
      secret: "hash",
    });
    return dormant;
  });
  const createdAfter = Date.now() + 1;
  // A dormant account that predates this call is never deleted.
  await f.t.mutation(internal.programUsers.discard, {
    userId: dormant,
    email: "dormant@example.test",
    createdAfter,
  });
  expect(await f.t.run((ctx) => ctx.db.get(dormant))).not.toBeNull();
  // Nor one whose email does not match the requested account.
  await f.t.mutation(internal.programUsers.discard, {
    userId: dormant,
    email: "other@example.test",
    createdAfter: 0,
  });
  expect(await f.t.run((ctx) => ctx.db.get(dormant))).not.toBeNull();
  await f.t.mutation(internal.programUsers.discard, {
    userId: dormant,
    email: "dormant@example.test",
    createdAfter: 0,
  });
  expect(await f.t.run((ctx) => ctx.db.get(dormant))).toBeNull();
  expect(
    await f.t.run((ctx) => ctx.db.query("authAccounts").collect()),
  ).toHaveLength(0);
});

it("rate-limits account creation per actor, counting refused attempts", async () => {
  const f = await fixture();
  await provision(f, "taken@example.test");
  for (let i = 0; i < ACCOUNT_REQUESTS_PER_HOUR; i++)
    expect(
      await message(
        f.program.action(api.programUsers.create, {
          email: "taken@example.test",
          name: "Probe",
          password: `probe-password-${i}-xx`,
          programUuid: "home",
          groupIds: [],
        }),
      ),
    ).toBe(EMAIL_UNAVAILABLE);
  expect(
    await message(
      f.program.action(api.programUsers.create, {
        email: "fresh@example.test",
        name: "Fresh",
        password: PASSWORD,
        programUuid: "home",
        groupIds: [],
      }),
    ),
  ).toMatch(/Too many/);
  // The system administrator's own budget is separate; it has used one so far.
  for (let i = 1; i < ACCOUNT_REQUESTS_PER_HOUR; i++)
    await message(
      f.system.action(api.admin.createUser, {
        email: "taken@example.test",
        name: "Probe",
        password: PASSWORD,
      }),
    );
  expect(
    await message(
      f.system.action(api.admin.createUser, {
        email: "fresh@example.test",
        name: "Fresh",
        password: PASSWORD,
      }),
    ),
  ).toMatch(/Too many/);
});

it("disabling a user ends their sessions and refresh tokens", async () => {
  const f = await fixture();
  const target = await provision(f, "pilot@example.test");
  await signIn(f, "pilot@example.test", PASSWORD);
  await signIn(f, "pilot@example.test", PASSWORD);
  const sessions = () =>
    f.t.run(async (ctx) => ({
      sessions: (
        await ctx.db
          .query("authSessions")
          .withIndex("userId", (q) => q.eq("userId", target))
          .collect()
      ).length,
      tokens: (await ctx.db.query("authRefreshTokens").collect()).length,
      others: (await ctx.db.query("authSessions").collect()).length,
    }));
  const before = await sessions();
  expect(before.sessions).toBeGreaterThan(0);
  expect(before.tokens).toBeGreaterThan(0);
  // A change that keeps the user active leaves sessions alone.
  await f.system.mutation(api.admin.updateUser, {
    id: target,
    active: true,
    isAdmin: false,
    groupIds: [f.ids.own],
  });
  expect(await sessions()).toEqual(before);
  await f.system.mutation(api.admin.updateUser, {
    id: target,
    active: false,
    isAdmin: false,
    groupIds: [f.ids.own],
  });
  const after = await sessions();
  expect(after.sessions).toBe(0);
  expect(after.tokens).toBe(0);
  // The administrators' own sessions survive.
  expect(after.others).toBe(before.others - before.sessions);
  const audit = await f.t.run((ctx) => ctx.db.query("audit").collect());
  expect(
    audit.find(
      (a) => a.action === "user.sessions_ended" && a.entityUuid === target,
    ),
  ).toMatchObject({ actorId: f.ids.system.user });
  // Re-enabling does not revive anything.
  await f.system.mutation(api.admin.updateUser, {
    id: target,
    active: true,
    isAdmin: false,
    groupIds: [f.ids.own],
  });
  expect((await sessions()).sessions).toBe(0);
});

it("refuses sign-in for an inactive user without creating a session", async () => {
  const f = await fixture();
  const target = await provision(f, "pilot@example.test");
  const ok = (await signIn(f, "pilot@example.test", PASSWORD)) as {
    tokens: unknown;
  };
  expect(ok.tokens).toBeTruthy();
  await f.system.mutation(api.admin.updateUser, {
    id: target,
    active: false,
    isAdmin: false,
    groupIds: [],
  });
  await expect(signIn(f, "pilot@example.test", PASSWORD)).rejects.toThrow();
  expect(
    await f.t.run((ctx) =>
      ctx.db
        .query("authSessions")
        .withIndex("userId", (q) => q.eq("userId", target))
        .collect(),
    ),
  ).toHaveLength(0);
});

it("locks an account after the configured failed sign-ins, and a password reset unlocks it", async () => {
  const f = await fixture();
  const target = await provision(f, "pilot@example.test");
  for (let i = 0; i < MAX_FAILED_SIGN_INS_PER_HOUR; i++)
    await expect(
      signIn(f, "pilot@example.test", "wrong-password-xxxx"),
    ).rejects.toThrow();
  // Locked: even the right password is refused.
  await expect(signIn(f, "pilot@example.test", PASSWORD)).rejects.toThrow();
  await f.system.action(api.admin.resetPassword, {
    id: target,
    password: "a-brand-new-password-1",
  });
  expect(
    await f.t.run((ctx) => ctx.db.query("authRateLimits").collect()),
  ).toHaveLength(0);
  const audit = await f.t.run((ctx) => ctx.db.query("audit").collect());
  expect(
    audit.find((a) => a.action === "user.password_reset")?.after,
  ).toContain("signInLockoutCleared");
  const ok = (await signIn(f, "pilot@example.test", "a-brand-new-password-1")) as {
    tokens: unknown;
  };
  expect(ok.tokens).toBeTruthy();
});

it("addExisting answers the same whether or not the email has an account, and names the program in the change log", async () => {
  const f = await fixture();
  const existing = await provision(f, "shared@example.test");
  await f.t.run((ctx) =>
    ctx.db.insert("users", {
      name: "Dormant",
      email: "dormant@example.test",
      active: false,
      isAdmin: false,
      groupIds: [],
    }),
  );
  const add = (email: string) =>
    f.program.mutation(api.programUsers.addExisting, {
      email,
      programUuid: "home",
      groupIds: [f.ids.own],
    });
  const results = [
    await add("nobody@example.test"),
    await add("dormant@example.test"),
    await add("Shared@Example.test"),
  ];
  expect(results).toEqual([
    ADD_EXISTING_RESULT,
    ADD_EXISTING_RESULT,
    ADD_EXISTING_RESULT,
  ]);
  expect(await f.t.run((ctx) => ctx.db.get(existing))).toMatchObject({
    groupIds: [f.ids.own],
  });
  const entry = (await f.t.run((ctx) => ctx.db.query("audit").collect())).find(
    (a) => a.action === "user.program_access_added",
  );
  expect(entry).toMatchObject({
    actorId: f.ids.program.user,
    entityUuid: existing,
    programUuid: "home",
  });
  expect(JSON.parse(entry!.after!)).toMatchObject({
    programName: "Home",
    groupIds: [f.ids.own],
  });
});

it("rate-limits addExisting per actor, counting unknown emails", async () => {
  const f = await fixture();
  for (let i = 0; i < ACCOUNT_REQUESTS_PER_HOUR; i++)
    await f.program.mutation(api.programUsers.addExisting, {
      email: `nobody${i}@example.test`,
      programUuid: "home",
      groupIds: [f.ids.own],
    });
  await expect(
    f.program.mutation(api.programUsers.addExisting, {
      email: "another@example.test",
      programUuid: "home",
      groupIds: [f.ids.own],
    }),
  ).rejects.toThrow(/Too many/);
});

it("program account creation refuses short and common passwords before reserving the email", async () => {
  const f = await fixture();
  const create = (password: string) =>
    message(
      f.program.action(api.programUsers.create, {
        email: "new@example.test",
        name: "New user",
        password,
        programUuid: "home",
        groupIds: [f.ids.own],
      }),
    );
  expect(await create("fourteen-chars")).toBe(PASSWORD_LENGTH_MESSAGE);
  expect(await create("1q2w3e4r5t6y7u8i9o0p")).toBe(PASSWORD_COMMON_MESSAGE);
  expect(
    await f.t.run(async (ctx) => ({
      users: (await ctx.db.query("users").collect()).length,
      limits: await ctx.db.query("rateLimits").collect(),
    })),
  ).toEqual({ users: 2, limits: [] });
});
