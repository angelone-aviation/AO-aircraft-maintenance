/**
 * Responsibility: Pins the account helpers' answers: which logins hold an
 *   email, what signing out and unlocking report, and the uniform refusal.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/accountGuards, convex/schema, convex/values,
 *   src/domain/accountRules.
 */
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { expect, it } from "vitest";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  assertCreatedHere,
  clearSignInLockout,
  emailInUse,
  endSessions,
  normalizeEmail,
  uniformCreateError,
} from "./accountGuards";
import { EMAIL_UNAVAILABLE } from "../src/domain/accountRules";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);

async function signIn(ctx: MutationCtx, userId: Id<"users">) {
  const sessionId = await ctx.db.insert("authSessions", {
    userId,
    expirationTime: Date.now() + 1000,
  });
  await ctx.db.insert("authRefreshTokens", {
    sessionId,
    expirationTime: Date.now() + 1000,
  });
}

it("finds an email held by a user or a password login, not another login", async () => {
  expect(normalizeEmail("  Pilot@Example.TEST ")).toBe("pilot@example.test");
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "user@example.test" });
    for (const [provider, providerAccountId] of [
      ["password", "login@example.test"],
      ["google", "google@example.test"],
    ])
      await ctx.db.insert("authAccounts", {
        userId,
        provider,
        providerAccountId,
      });
    expect(await emailInUse(ctx, "user@example.test")).toBe(true);
    expect(await emailInUse(ctx, "login@example.test")).toBe(true);
    expect(await emailInUse(ctx, "google@example.test")).toBe(false);
  });
});

it("ends only the user's sessions and counts them", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const pilot = await ctx.db.insert("users", { email: "pilot@example.test" });
    const other = await ctx.db.insert("users", { email: "other@example.test" });
    for (const userId of [pilot, pilot, other]) await signIn(ctx, userId);
    expect(await endSessions(ctx, pilot)).toBe(2);
    expect(await endSessions(ctx, pilot)).toBe(0);
    expect(await ctx.db.query("authSessions").collect()).toHaveLength(1);
    expect(await ctx.db.query("authRefreshTokens").collect()).toHaveLength(1);
  });
});

it("reports whether a sign-in lockout was cleared", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email: "pilot@example.test",
    });
    const login = await ctx.db.insert("authAccounts", {
      userId,
      provider: "password",
      providerAccountId: "pilot@example.test",
    });
    await ctx.db.insert("authRateLimits", {
      identifier: login,
      lastAttemptTime: Date.now(),
      attemptsLeft: 0,
    });
    expect(await clearSignInLockout(ctx, userId)).toBe(true);
    expect(await ctx.db.query("authRateLimits").collect()).toEqual([]);
    expect(await clearSignInLockout(ctx, userId)).toBe(false);
  });
});

it("answers an existing account with the one uniform refusal", () => {
  const exists = new Error("Account pilot@example.test already exists");
  expect(uniformCreateError(exists)).toEqual(
    new ConvexError(EMAIL_UNAVAILABLE),
  );
  expect(uniformCreateError(exists)).toBeInstanceOf(ConvexError);
  const other = new Error("Network down");
  expect(uniformCreateError(other)).toBe(other);
  expect(() => assertCreatedHere({ _creationTime: 99 }, 100)).toThrow(
    EMAIL_UNAVAILABLE,
  );
  expect(() => assertCreatedHere({ _creationTime: 99 }, 100)).toThrow(
    ConvexError,
  );
  expect(() => assertCreatedHere({ _creationTime: 100 }, 100)).not.toThrow();
});
