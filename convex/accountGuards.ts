// Helpers for account administration (issue #29). No Convex functions here.
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { ConvexError } from "convex/values";
import { consume, MINUTE } from "./rateLimits";
import { passwordProblem } from "../src/domain/passwordRules";
import {
  ACCOUNT_REQUESTS_LIMITED,
  ACCOUNT_REQUESTS_PER_HOUR,
  EMAIL_UNAVAILABLE,
} from "../src/domain/accountRules";

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

// A password an administrator sets on create or reset: 15 or more characters
// and not a common one (ADR-0009). The message reaches the administrator.
export function assertNewPassword(password: string, email: string) {
  const problem = passwordProblem(password, email);
  if (problem) throw new ConvexError(problem);
}

// True when any user or password login already holds this email.
export async function emailInUse(ctx: QueryCtx, email: string) {
  const user = await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", email))
    .first();
  if (user) return true;
  const login = await ctx.db
    .query("authAccounts")
    .withIndex("providerAndAccountId", (q) =>
      q.eq("provider", "password").eq("providerAccountId", email),
    )
    .first();
  return login !== null;
}

// Spend one of the actor's hourly account requests. Callers must not throw
// afterwards in the same mutation for an outcome that should still count
// (a throw rolls the counter back), so they return results instead.
export async function consumeAccountRequest(
  ctx: MutationCtx,
  kind: "create" | "add-existing",
  actorId: Id<"users">,
) {
  await consume(
    ctx,
    `account-${kind}:${actorId}`,
    ACCOUNT_REQUESTS_PER_HOUR,
    60 * MINUTE,
    ACCOUNT_REQUESTS_LIMITED,
  );
}

// Run inside the rate-limited mutation before any password is hashed.
export async function reserveNewAccount(
  ctx: MutationCtx,
  actorId: Id<"users">,
  email: string,
) {
  await consumeAccountRequest(ctx, "create", actorId);
  return { available: !(await emailInUse(ctx, email)), checkedAt: Date.now() };
}

// createAccount() returns an existing login when the password matches, and
// throws "already exists" when it does not. Either way, report the one
// uniform message, never the library's.
export function assertCreatedHere(
  user: { _creationTime: number },
  checkedAt: number,
) {
  if (user._creationTime < checkedAt) throw new Error(EMAIL_UNAVAILABLE);
}
export function uniformCreateError(error: unknown) {
  return error instanceof Error && /already exists/.test(error.message)
    ? new Error(EMAIL_UNAVAILABLE)
    : error;
}

// Delete every session and refresh token of a user, so a disabled account
// cannot continue on any device, and re-enabling it revives nothing.
export async function endSessions(ctx: MutationCtx, userId: Id<"users">) {
  const sessions = await ctx.db
    .query("authSessions")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .collect();
  for (const session of sessions) {
    const tokens = await ctx.db
      .query("authRefreshTokens")
      .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
      .collect();
    for (const token of tokens) await ctx.db.delete(token._id);
    await ctx.db.delete(session._id);
  }
  return sessions.length;
}

// Remove the failed-sign-in counter of the user's password login. Returns
// whether a counter was cleared.
export async function clearSignInLockout(
  ctx: MutationCtx,
  userId: Id<"users">,
) {
  const logins = await ctx.db
    .query("authAccounts")
    .withIndex("userIdAndProvider", (q) =>
      q.eq("userId", userId).eq("provider", "password"),
    )
    .collect();
  let cleared = false;
  for (const login of logins) {
    const limit = await ctx.db
      .query("authRateLimits")
      .withIndex("identifier", (q) => q.eq("identifier", login._id))
      .unique();
    if (limit) {
      await ctx.db.delete(limit._id);
      cleared = true;
    }
  }
  return cleared;
}
