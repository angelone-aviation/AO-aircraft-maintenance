/**
 * Responsibility: Deletes Convex Auth records nobody can use any more:
 *   expired sessions, the refresh tokens of sessions that are gone or
 *   expired, and sign-in verifiers left unredeemed past a safe age.
 * Layer: Server. Internal mutations the weekly cron starts; each handles one
 *   page and schedules the next.
 * Dependencies: convex/values, ./_generated (server, api, dataModel),
 *   ./rateLimits (DAY).
 *
 * The library deletes these rows only when a client presents them again, so
 * those from devices that never come back pile up (security review A6). A
 * live session, and every refresh token it holds, is left alone.
 */
import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { DAY } from "./rateLimits";

/** Rows one cleanup pass reads, so no pass nears a mutation's limits. */
export const CLEANUP_PAGE_SIZE = 200;

/**
 * How old an unredeemed sign-in verifier must be to go. The library's OAuth
 * state cookies last 15 minutes (`@convex-dev/auth` server/oauth/checks.js
 * and cookies.js), so a verifier a day old can no longer complete a sign-in.
 */
export const VERIFIER_MAX_AGE_MS = DAY;

const cursorArgs = { cursor: v.optional(v.union(v.string(), v.null())) };

/**
 * Deletes the expired sessions on one page of `authSessions`, then schedules
 * the next page, and after the last, {@link sweepRefreshTokens}. Their
 * refresh tokens go in that pass, since their session is then gone.
 *
 * @param cursor - The page to resume from; omitted starts at the first.
 * @returns How many sessions this page deleted, and whether it was the last.
 */
export const sweepSessions = internalMutation({
  args: cursorArgs,
  handler: async (ctx, { cursor }) => {
    const now = Date.now();
    const page = await ctx.db
      .query("authSessions")
      .paginate({ cursor: cursor ?? null, numItems: CLEANUP_PAGE_SIZE });
    const expired = page.page.filter((s) => s.expirationTime <= now);
    for (const session of expired) await ctx.db.delete(session._id);
    if (page.isDone)
      await ctx.scheduler.runAfter(
        0,
        internal.authCleanup.sweepRefreshTokens,
        {},
      );
    else
      await ctx.scheduler.runAfter(0, internal.authCleanup.sweepSessions, {
        cursor: page.continueCursor,
      });
    return { deleted: expired.length, done: page.isDone };
  },
});

/**
 * Deletes the refresh tokens on one page of `authRefreshTokens` whose
 * session is gone or expired, which no client can exchange any more, then
 * schedules the next page, and after the last, {@link sweepVerifiers}. A
 * token of a live session stays, even a used or lapsed one: the library
 * reads them to detect a token used twice.
 *
 * @param cursor - The page to resume from; omitted starts at the first.
 * @returns How many tokens this page deleted, and whether it was the last.
 */
export const sweepRefreshTokens = internalMutation({
  args: cursorArgs,
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query("authRefreshTokens")
      .paginate({ cursor: cursor ?? null, numItems: CLEANUP_PAGE_SIZE });
    const dead = await tokensWithoutLiveSession(ctx, page.page);
    for (const token of dead) await ctx.db.delete(token._id);
    if (page.isDone)
      await ctx.scheduler.runAfter(0, internal.authCleanup.sweepVerifiers, {});
    else
      await ctx.scheduler.runAfter(0, internal.authCleanup.sweepRefreshTokens, {
        cursor: page.continueCursor,
      });
    return { deleted: dead.length, done: page.isDone };
  },
});

/**
 * Deletes up to a page of sign-in verifiers older than
 * {@link VERIFIER_MAX_AGE_MS}, oldest first, and runs again while a full
 * page went. A redeemed verifier is already deleted by the library.
 *
 * @returns How many verifiers this pass deleted, and whether none are left.
 */
export const sweepVerifiers = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - VERIFIER_MAX_AGE_MS;
    const stale = await ctx.db
      .query("authVerifiers")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", cutoff))
      .take(CLEANUP_PAGE_SIZE);
    for (const verifier of stale) await ctx.db.delete(verifier._id);
    const done = stale.length < CLEANUP_PAGE_SIZE;
    if (!done)
      await ctx.scheduler.runAfter(0, internal.authCleanup.sweepVerifiers, {});
    return { deleted: stale.length, done };
  },
});

// Each session is read once per page, however many of its tokens are on it.
async function tokensWithoutLiveSession(
  ctx: MutationCtx,
  tokens: Doc<"authRefreshTokens">[],
) {
  const now = Date.now();
  const live = new Map<Id<"authSessions">, boolean>();
  const dead: Doc<"authRefreshTokens">[] = [];
  for (const token of tokens) {
    if (!live.has(token.sessionId)) {
      const session = await ctx.db.get(token.sessionId);
      live.set(token.sessionId, !!session && session.expirationTime > now);
    }
    if (!live.get(token.sessionId)) dead.push(token);
  }
  return dead;
}
