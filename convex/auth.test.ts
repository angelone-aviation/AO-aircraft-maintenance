/**
 * Responsibility: Pins that sign-in refusals stay plain Errors, which
 *   production hides alike, so their class reveals nothing about an account;
 *   that every password flow but sign-in is closed; and that sign-out ends
 *   the session on the server.
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
  expect(off).toMatchObject({ message: "Invalid credentials" });
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
