/**
 * Responsibility: Shared checks and clean-ups for creating, disabling and
 *   resetting accounts (issue #29).
 * Layer: Server. Query and mutation helpers; no Convex functions.
 * Dependencies: convex/values, convex/_generated (server, dataModel),
 *   convex/rateLimits, src/domain/passwordRules, src/domain/accountRules.
 */
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { ConvexError } from "convex/values";
import { consume, HOUR } from "./rateLimits";
import { passwordProblem } from "../src/domain/passwordRules";
import {
  ACCOUNT_REQUESTS_LIMITED,
  ACCOUNT_REQUESTS_PER_HOUR,
  EMAIL_UNAVAILABLE,
} from "../src/domain/accountRules";

/**
 * Puts an email in the form accounts are stored and looked up by.
 *
 * @param email - As typed, or as a sign-in provider reported it.
 * @returns The email trimmed and lower-cased.
 */
export const normalizeEmail = (email: string): string =>
  email.trim().toLowerCase();

/**
 * Refuses a password an administrator sets on create or reset that breaks the
 * password rules (ADR-0009).
 *
 * @param password - The new password.
 * @param email - The account's email, which the password must not contain.
 * @throws {ConvexError} passwordProblem's message, shown to the administrator.
 */
export function assertNewPassword(password: string, email: string): void {
  const problem = passwordProblem(password, email);
  if (problem) throw new ConvexError(problem);
}

/**
 * Tells whether a user or a password login already holds an email.
 *
 * @param ctx - Query or mutation context.
 * @param email - A normalized email.
 * @returns True when either holds it.
 */
export async function emailInUse(
  ctx: QueryCtx,
  email: string,
): Promise<boolean> {
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

/**
 * Spends one of the actor's hourly account requests. A later throw in the same
 * mutation rolls the count back, so callers report an outcome that must still
 * count by returning it, not by throwing.
 *
 * @param ctx - Mutation context; writes the actor's rateLimits row.
 * @param kind - Which allowance: creating accounts or adding existing ones.
 * @param actorId - The administrator making the request.
 * @throws {ConvexError} {@link ACCOUNT_REQUESTS_LIMITED} once the actor has
 *   spent {@link ACCOUNT_REQUESTS_PER_HOUR} of this kind this clock hour.
 */
export async function consumeAccountRequest(
  ctx: MutationCtx,
  kind: "create" | "add-existing",
  actorId: Id<"users">,
): Promise<void> {
  await consume(
    ctx,
    `account-${kind}:${actorId}`,
    ACCOUNT_REQUESTS_PER_HOUR,
    HOUR,
    ACCOUNT_REQUESTS_LIMITED,
  );
}

/**
 * Spends a create request and checks the email is free. Run it before any
 * password is hashed, so an existing account is never touched.
 *
 * @param ctx - Mutation context.
 * @param actorId - The administrator creating the account.
 * @param email - A normalized email.
 * @returns Whether the email is free, and when that was checked.
 * @throws {ConvexError} As {@link consumeAccountRequest}.
 */
export async function reserveNewAccount(
  ctx: MutationCtx,
  actorId: Id<"users">,
  email: string,
): Promise<{ available: boolean; checkedAt: number }> {
  await consumeAccountRequest(ctx, "create", actorId);
  return { available: !(await emailInUse(ctx, email)), checkedAt: Date.now() };
}

/**
 * Refuses a user that createAccount() returned but did not create: it returns
 * an existing login when the password matches.
 *
 * @param user - The user createAccount() returned.
 * @param checkedAt - When {@link reserveNewAccount} found the email free.
 * @throws {ConvexError} {@link EMAIL_UNAVAILABLE} when the user predates the
 *   check.
 */
export function assertCreatedHere(
  user: { _creationTime: number },
  checkedAt: number,
): void {
  if (user._creationTime < checkedAt) throw new ConvexError(EMAIL_UNAVAILABLE);
}

/**
 * Replaces createAccount()'s "already exists" error with the uniform refusal,
 * so the answer never tells whether the account exists.
 *
 * @param error - What createAccount() threw.
 * @returns A ConvexError with {@link EMAIL_UNAVAILABLE} for an Error whose
 *   message contains "already exists"; anything else unchanged.
 */
export function uniformCreateError(error: unknown): unknown {
  return error instanceof Error && /already exists/.test(error.message)
    ? new ConvexError(EMAIL_UNAVAILABLE)
    : error;
}

/**
 * Deletes every session and refresh token of a user, so a disabled account
 * cannot continue on any device and re-enabling it revives nothing.
 *
 * @param ctx - Mutation context.
 * @param userId - The account to sign out everywhere.
 * @returns How many sessions were deleted.
 */
export async function endSessions(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<number> {
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

/**
 * Removes the failed-sign-in counter of a user's password login, which
 * unlocks an account the sign-in rate limit has locked.
 *
 * @param ctx - Mutation context.
 * @param userId - The account to unlock.
 * @returns Whether a counter was removed.
 */
export async function clearSignInLockout(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<boolean> {
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
    if (!limit) continue;
    await ctx.db.delete(limit._id);
    cleared = true;
  }
  return cleared;
}
