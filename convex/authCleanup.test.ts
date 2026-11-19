/**
 * Responsibility: Pins the weekly sign-in records cleanup (security review
 *   A6): expired sessions, the refresh tokens of sessions that are gone or
 *   expired, and verifiers older than a day are deleted, page by page, and a
 *   live session and its tokens are never touched.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/authCleanup.ts, convex/schema.ts (Convex Auth tables),
 *   convex/rateLimits.ts (DAY), tests/fixtures/alertProgram.ts (modules).
 */
import { convexTest } from "convex-test";
import { afterEach, expect, it, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import { DAY, HOUR } from "./rateLimits";
import { CLEANUP_PAGE_SIZE, VERIFIER_MAX_AGE_MS } from "./authCleanup";
import { modules } from "../tests/fixtures/alertProgram";

afterEach(() => {
  vi.useRealTimers();
});

async function seedUser(ctx: MutationCtx) {
  return ctx.db.insert("users", { active: true, groupIds: [] });
}

const counts = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ({
    sessions: (await ctx.db.query("authSessions").collect()).length,
    tokens: (await ctx.db.query("authRefreshTokens").collect()).length,
    verifiers: (await ctx.db.query("authVerifiers").collect()).length,
  }));

const sweep = async (t: ReturnType<typeof convexTest>) => {
  await t.mutation(internal.authCleanup.sweepSessions, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
};

it("deletes expired sessions and their tokens, and never touches a live session", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const now = Date.now();
  const live = await t.run(async (ctx) => {
    const userId = await seedUser(ctx);
    const session = (expirationTime: number) =>
      ctx.db.insert("authSessions", { userId, expirationTime });
    const token = (
      sessionId: Awaited<ReturnType<typeof session>>,
      at: number,
    ) => ctx.db.insert("authRefreshTokens", { sessionId, expirationTime: at });
    const current = await session(now + DAY);
    // A used token of a live session has lapsed; the session still holds it.
    await token(current, now - HOUR);
    await token(current, now + DAY);
    const expired = await session(now - HOUR);
    await token(expired, now - HOUR);
    await token(expired, now + DAY);
    const gone = await session(now + DAY);
    await token(gone, now + DAY);
    await ctx.db.delete(gone);
    return current;
  });
  await sweep(t);
  expect(await counts(t)).toMatchObject({ sessions: 1, tokens: 2 });
  const kept = await t.run(async (ctx) => ({
    session: await ctx.db.get(live),
    tokens: await ctx.db
      .query("authRefreshTokens")
      .withIndex("sessionId", (q) => q.eq("sessionId", live))
      .collect(),
  }));
  expect(kept.session).not.toBeNull();
  expect(kept.tokens).toHaveLength(2);
});

it("deletes sign-in verifiers left unredeemed for more than a day, and keeps newer ones", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  await t.run((ctx) => ctx.db.insert("authVerifiers", {}));
  vi.advanceTimersByTime(VERIFIER_MAX_AGE_MS + HOUR);
  await t.run((ctx) =>
    ctx.db.insert("authVerifiers", { signature: "recent sign-in" }),
  );
  await sweep(t);
  const left = await t.run((ctx) => ctx.db.query("authVerifiers").collect());
  expect(left.map((v) => v.signature)).toEqual(["recent sign-in"]);
});

it("works through more rows than one page holds", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const rows = CLEANUP_PAGE_SIZE + 1;
  await t.run(async (ctx) => {
    const userId = await seedUser(ctx);
    for (let i = 0; i < rows; i++) {
      const sessionId = await ctx.db.insert("authSessions", {
        userId,
        expirationTime: Date.now() - HOUR,
      });
      await ctx.db.insert("authRefreshTokens", {
        sessionId,
        expirationTime: Date.now() - HOUR,
      });
      await ctx.db.insert("authVerifiers", {});
    }
  });
  vi.advanceTimersByTime(VERIFIER_MAX_AGE_MS + HOUR);
  await sweep(t);
  expect(await counts(t)).toEqual({ sessions: 0, tokens: 0, verifiers: 0 });
});
