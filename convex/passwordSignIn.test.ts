/**
 * Responsibility: Pins password sign-in end to end: a disabled account gets
 *   no session, each sign-in is logged with its method, the password rules on
 *   create and reset, and that no other sign-in method exists (ADR-0015).
 * Layer: Test. convex-test suite through the real sign-in library; never
 *   shipped.
 * Dependencies: @convex-dev/auth, jose, convex (auth, admin, schema),
 *   src/domain/passwordRules.
 */
import { convexTest } from "convex-test";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { exportPKCS8, generateKeyPair } from "jose";
import { createAccount } from "@convex-dev/auth/server";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  PASSWORD_COMMON_MESSAGE,
  PASSWORD_LENGTH_MESSAGE,
} from "../src/domain/passwordRules";

vi.setConfig({ testTimeout: 30_000 });
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  vi.stubEnv("JWT_PRIVATE_KEY", await exportPKCS8(privateKey));
  vi.stubEnv("CONVEX_SITE_URL", "https://test.convex.site");
  vi.stubEnv("SITE_URL", "https://app.example.test");
});
afterAll(() => vi.unstubAllEnvs());

const PASSWORD = "correct-horse-battery-1";
const DAY_MS = 86_400_000;

/**
 * A signed-in system administrator, and a helper that provisions a password
 * account the supported way.
 */
async function fixture() {
  const t = convexTest(schema, modules);
  const admin = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", {
      name: "System administrator",
      email: "system@example.test",
      active: true,
      isAdmin: true,
      groupIds: [],
    });
    const session = await ctx.db.insert("authSessions", {
      userId: user,
      expirationTime: Date.now() + DAY_MS,
    });
    return { user, identity: { subject: `${user}|${session}` } };
  });
  const system = t.withIdentity(admin.identity);
  const provision = async (email: string) =>
    (await system.action(api.admin.createUser, {
      email,
      name: "Pat Pilot",
      password: PASSWORD,
    })) as Id<"users">;
  return { t, system, adminId: admin.user, provision };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const passwordSignIn = (f: Fixture, email: string, password = PASSWORD) =>
  f.t.action(api.auth.signIn, {
    provider: "password",
    params: { flow: "signIn", email, password },
  }) as Promise<{ tokens: { token: string } | null }>;
const rows = (f: Fixture) =>
  f.t.run(async (ctx) => ({
    users: await ctx.db.query("users").collect(),
    accounts: await ctx.db.query("authAccounts").collect(),
    sessions: await ctx.db.query("authSessions").collect(),
    audit: await ctx.db.query("audit").collect(),
  }));

it("refuses a disabled user's password and creates no session", async () => {
  const f = await fixture();
  const pilot = await f.provision("pilot@example.test");
  expect((await passwordSignIn(f, "pilot@example.test")).tokens).toBeTruthy();
  await f.system.mutation(api.admin.updateUser, {
    id: pilot,
    active: false,
    isAdmin: false,
    groupIds: [],
  });
  await expect(passwordSignIn(f, "pilot@example.test")).rejects.toThrow();
  const r = await rows(f);
  expect(r.sessions.filter((s) => s.userId === pilot)).toHaveLength(0);
});

it("logs password sign-ins with their method, but not token refreshes", async () => {
  const f = await fixture();
  const pilot = await f.provision("pilot@example.test");
  const { tokens } = (await passwordSignIn(f, "pilot@example.test")) as {
    tokens: { token: string; refreshToken: string };
  };
  await f.t.action(api.auth.signIn, { refreshToken: tokens.refreshToken });
  const signIns = (await rows(f)).audit.filter(
    (a) => a.action === "user.signed_in",
  );
  expect(signIns.map((a) => [a.actorId, JSON.parse(a.after!)])).toEqual([
    [pilot, { method: "password" }],
  ]);
});

it("refuses short and common passwords when an administrator creates or resets one", async () => {
  const f = await fixture();
  const message = (p: Promise<unknown>) =>
    p.then(
      () => "",
      (e: Error) => e.message,
    );
  const create = (password: string) =>
    message(
      f.system.action(api.admin.createUser, {
        email: "new@example.test",
        name: "New user",
        password,
      }),
    );
  expect(await create("fourteen-chars")).toBe(PASSWORD_LENGTH_MESSAGE);
  expect(await create("123456789012345")).toBe(PASSWORD_COMMON_MESSAGE);
  expect(await create("PasswordPassword")).toBe(PASSWORD_COMMON_MESSAGE);
  expect((await rows(f)).users).toHaveLength(1);
  const pilot = await f.provision("pilot@example.test");
  const reset = (password: string) =>
    message(f.system.action(api.admin.resetPassword, { id: pilot, password }));
  expect(await reset("short-pass-1")).toBe(PASSWORD_LENGTH_MESSAGE);
  expect(await reset("qwertyuiopasdfgh")).toBe(PASSWORD_COMMON_MESSAGE);
  expect(await reset("xx-pilot@example.test-xx")).toBe(PASSWORD_COMMON_MESSAGE);
  expect((await passwordSignIn(f, "pilot@example.test")).tokens).toBeTruthy();
  await f.system.action(api.admin.resetPassword, {
    id: pilot,
    password: "a long unusual phrase",
  });
  expect(
    (await passwordSignIn(f, "pilot@example.test", "a long unusual phrase"))
      .tokens,
  ).toBeTruthy();
});

it("keeps an existing shorter password working until its next reset", async () => {
  const f = await fixture();
  const { user } = await f.t.action(async (ctx) =>
    createAccount(ctx, {
      provider: "password",
      account: { id: "legacy@example.test", secret: "twelve-chars" },
      profile: {
        email: "legacy@example.test",
        name: "Legacy",
        active: true,
        isAdmin: false,
        groupIds: [],
      },
    }),
  );
  expect(user.email).toBe("legacy@example.test");
  expect(
    (await passwordSignIn(f, "legacy@example.test", "twelve-chars")).tokens,
  ).toBeTruthy();
});

it("offers no Google or Microsoft sign-in, and a login row left by one does not affect the password", async () => {
  const f = await fixture();
  const pilot = await f.provision("pilot@example.test");
  // A row such as a development deployment that tried the old Google
  // sign-in could have left behind.
  await f.t.run((ctx) =>
    ctx.db.insert("authAccounts", {
      userId: pilot,
      provider: "google",
      providerAccountId: "google-pat",
      emailVerified: "pilot@example.test",
    }),
  );
  const before = await rows(f);
  for (const provider of ["google", "microsoft-entra-id"])
    await expect(f.t.action(api.auth.signIn, { provider })).rejects.toThrow();
  expect(await rows(f)).toEqual(before);
  expect((await passwordSignIn(f, "pilot@example.test")).tokens).toBeTruthy();
  const signIns = (await rows(f)).audit.filter(
    (a) => a.action === "user.signed_in",
  );
  expect(signIns.map((a) => JSON.parse(a.after!))).toEqual([
    { method: "password" },
  ]);
});
