/**
 * Responsibility: Pins that sign-in refusals stay plain Errors, which
 *   production hides alike, so their class reveals nothing about an account;
 *   that a disabled account's password is checked as a wrong one; that every
 *   password flow but sign-in is closed; that sign-out ends the session on
 *   the server; and that a forged refresh token signs no one out.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: @convex-dev/auth, jose, convex (auth, admin, identities,
 *   schema).
 */
import { convexTest } from "convex-test";
import { afterAll, beforeAll, it, vi, expect } from "vitest";
import { exportPKCS8, generateKeyPair } from "jose";
import { ConvexError } from "convex/values";
import { createAccount } from "@convex-dev/auth/server";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MAX_FAILED_SIGN_INS_PER_HOUR } from "./auth";

// Provisioning hashes real passwords (scrypt); allow for a busy machine.
vi.setConfig({ testTimeout: 30_000 });

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const PASSWORD = "correct-horse-battery-1";

// A successful password sign-in issues a signed JWT.
beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  vi.stubEnv("JWT_PRIVATE_KEY", await exportPKCS8(privateKey));
  vi.stubEnv("CONVEX_SITE_URL", "https://test.convex.site");
});
afterAll(() => vi.unstubAllEnvs());

// The error a run rejects with.
const refusal = (run: Promise<unknown>) =>
  run.then(
    () => {
      throw new Error("Expected a refusal.");
    },
    (error: unknown) => error,
  );

it("refuses sign-up, a disabled account and a wrong password, none as a ConvexError", async () => {
  const t = convexTest(schema, modules);
  const subject = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", {
      name: "System",
      active: true,
      isAdmin: true,
      groupIds: [],
    });
    const session = await ctx.db.insert("authSessions", {
      userId: user,
      expirationTime: Date.now() + 86400000,
    });
    return `${user}|${session}`;
  });
  const system = t.withIdentity({ subject });
  const provision = async (email: string) =>
    (await system.action(api.admin.createUser, {
      email,
      name: "Pilot",
      password: PASSWORD,
    })) as Id<"users">;
  const disabled = await provision("disabled@example.test");
  await provision("active@example.test");
  await system.mutation(api.admin.updateUser, {
    id: disabled,
    active: false,
    isAdmin: false,
    groupIds: [],
  });
  const signIn = (flow: string, email: string, password: string) =>
    refusal(
      t.action(api.auth.signIn, {
        provider: "password",
        params: { flow, email, password },
      }),
    );
  const signUp = await signIn("signUp", "new@example.test", PASSWORD);
  const off = await signIn("signIn", "disabled@example.test", PASSWORD);
  const wrong = await signIn("signIn", "active@example.test", `${PASSWORD}x`);
  expect(signUp).toMatchObject({
    message: "Accounts are managed by your administrator.",
  });
  // A disabled account is answered exactly as a wrong password (A8).
  expect(off).toMatchObject({ message: (wrong as Error).message });
  for (const error of [signUp, off, wrong]) {
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ConvexError);
  }
});

it("closes every password flow but sign-in, and sign-out ends the session on the server", async () => {
  const t = convexTest(schema, modules);
  const user = await t.action(
    async (ctx) =>
      (
        await createAccount(ctx, {
          provider: "password",
          account: { id: "pilot@example.test", secret: PASSWORD },
          profile: {
            email: "pilot@example.test",
            active: true,
            isAdmin: false,
            groupIds: [],
          },
        })
      ).user._id,
  );
  const params = {
    email: "pilot@example.test",
    password: PASSWORD,
    newPassword: `${PASSWORD}-taken-over`,
    code: "12345678",
  };
  for (const flow of [
    "signUp",
    "reset",
    "reset-verification",
    "email-verification",
    undefined,
  ])
    expect(
      await refusal(
        t.action(api.auth.signIn, {
          provider: "password",
          params: { ...params, flow },
        }),
      ),
    ).toMatchObject({ message: "Accounts are managed by your administrator." });
  // The password is unchanged and nobody else was signed in or created.
  await t.action(api.auth.signIn, {
    provider: "password",
    params: { ...params, flow: "signIn" },
  });
  const rows = () =>
    t.run(async (ctx) => ({
      users: (await ctx.db.query("users").collect()).length,
      sessions: await ctx.db.query("authSessions").collect(),
      tokens: (await ctx.db.query("authRefreshTokens").collect()).length,
    }));
  const before = await rows();
  expect(before.users).toBe(1);
  expect(before.sessions.map((s) => s.userId)).toEqual([user]);
  const asPilot = t.withIdentity({
    subject: `${user}|${before.sessions[0]._id}`,
  });
  expect(await asPilot.query(api.identities.mine, {})).toEqual([]);
  await asPilot.action(api.auth.signOut, {});
  expect(await rows()).toEqual({ users: 1, sessions: [], tokens: 0 });
  // The signed-out token is refused even before it expires.
  await expect(asPilot.query(api.identities.mine, {})).rejects.toThrow(
    "An active account and session are required.",
  );
});

it("stores nothing for a code exchange naming an email or phone, which no sign-in method uses", async () => {
  const t = convexTest(schema, modules);
  const noise = "x".repeat(10_000);
  for (const extra of [{ email: noise }, { phone: noise }])
    expect(
      await t.action(api.auth.signIn, {
        params: { code: "12345678", ...extra },
      }),
    ).toEqual({ tokens: null });
  expect(
    await t.run((ctx) => ctx.db.query("authRateLimits").collect()),
  ).toEqual([]);
});

// Security review A8: the library clears a correct password's failure count
// before the disabled account is refused, so the lockout, and the extra
// session step's timing, confirmed the password.
it("counts a disabled account's correct password as a failed sign-in", async () => {
  const t = convexTest(schema, modules);
  const user = await createPilot(t, "off@example.test", false);
  for (const password of [`${PASSWORD}x`, PASSWORD])
    expect(
      await refusal(passwordSignIn(t, "off@example.test", password)),
    ).toBeInstanceOf(Error);
  const limits = await t.run((ctx) => ctx.db.query("authRateLimits").collect());
  expect(limits).toHaveLength(1);
  expect(limits[0].attemptsLeft).toBeLessThan(
    MAX_FAILED_SIGN_INS_PER_HOUR - 1.5,
  );
  const sessions = await t.run((ctx) =>
    ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", user))
      .collect(),
  );
  expect(sessions).toEqual([]);
});

// Security review A9: the library deletes the session a refresh token names
// whenever the token is not a live one of that session, so pairing any
// refresh token id with someone else's session id signed them out.
it("signs no one out for a refresh token naming another session", async () => {
  const t = convexTest(schema, modules);
  for (const email of ["victim@example.test", "other@example.test"])
    await createPilot(t, email, true);
  const victim = await refreshTokenOf(t, "victim@example.test");
  const other = await refreshTokenOf(t, "other@example.test");
  const [otherToken, otherSession] = other.split("|");
  const [, victimSession] = victim.split("|");
  const gone = await t.run(async (ctx) => {
    const sessionId = ctx.db.normalizeId("authSessions", otherSession)!;
    const id = await ctx.db.insert("authRefreshTokens", {
      sessionId,
      expirationTime: Date.now() + 86_400_000,
    });
    await ctx.db.delete(id);
    return id;
  });
  for (const forged of [
    `${otherToken}|${victimSession}`,
    `${gone}|${victimSession}`,
  ])
    expect(await t.action(api.auth.signIn, { refreshToken: forged })).toEqual({
      tokens: null,
    });
  const refreshed = await t.action(api.auth.signIn, { refreshToken: victim });
  expect(refreshed.tokens?.refreshToken).toMatch(`|${victimSession}`);
});

async function createPilot(
  t: ReturnType<typeof convexTest>,
  email: string,
  active: boolean,
) {
  return t.action(
    async (ctx) =>
      (
        await createAccount(ctx, {
          provider: "password",
          account: { id: email, secret: PASSWORD },
          profile: { email, active, isAdmin: false, groupIds: [] },
        })
      ).user._id,
  );
}

function passwordSignIn(
  t: ReturnType<typeof convexTest>,
  email: string,
  password: string,
) {
  return t.action(api.auth.signIn, {
    provider: "password",
    params: { flow: "signIn", email, password },
  });
}

async function refreshTokenOf(t: ReturnType<typeof convexTest>, email: string) {
  const { tokens } = await passwordSignIn(t, email, PASSWORD);
  return tokens!.refreshToken;
}
