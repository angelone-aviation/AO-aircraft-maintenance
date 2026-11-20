/**
 * Responsibility: Counts uses of a limited action per key in fixed time
 *   windows, refuses a use once a window's allowance is spent (one key, or
 *   several together), and gives back a use that did not happen.
 * Layer: Server. Mutation helper over the rateLimits table.
 * Dependencies: convex/values (ConvexError), convex/_generated/server.
 */
import { ConvexError } from "convex/values";
import type { MutationCtx } from "./_generated/server";

/** One minute in milliseconds, for rate-limit windows. */
export const MINUTE = 60000;
/** One hour in milliseconds, for rate-limit windows. */
export const HOUR = 3600000;
/** One day in milliseconds, for rate-limit windows. */
export const DAY = 86400000;

/** One allowance of a limited action: uses allowed per fixed window. */
export interface Allowance {
  /** What is limited: a user, a program, or a provider-wide quota. */
  key: string;
  /** Uses allowed per window. */
  limit: number;
  /** Window length, such as {@link HOUR}. */
  windowMs: number;
  /** The refusal once the window's allowance is spent. */
  message: string;
}

/**
 * Records `cost` uses of a limited action, unless that would pass the limit.
 * Windows are fixed and aligned to the Unix epoch, so a DAY window resets at
 * 00:00 UTC.
 *
 * @param ctx - Mutation context; patches or inserts the key's rateLimits row.
 * @param key - What is limited: a user, a program, or a provider-wide quota.
 * @param limit - Uses allowed per window.
 * @param windowMs - Window length, such as {@link HOUR}.
 * @param message - User-facing refusal.
 * @param cost - Uses this call counts for.
 * @throws {ConvexError} `message`, before recording anything, when the window's
 *   count plus `cost` would exceed `limit`.
 */
export async function consume(
  ctx: MutationCtx,
  key: string,
  limit: number,
  windowMs: number,
  message: string,
  cost = 1,
): Promise<void> {
  await consumeAll(ctx, [{ key, limit, windowMs, message }], cost);
}

/**
 * Records `cost` uses against every allowance, or against none: all are
 * checked before any is spent, so one that refuses leaves the others as
 * they were (as {@link consume} for each, windows included).
 *
 * @param ctx - Mutation context; patches or inserts each key's rateLimits row.
 * @param allowances - The allowances, checked in order.
 * @param cost - Uses this call counts for, against each.
 * @throws {ConvexError} The first allowance's `message` whose window's count
 *   plus `cost` would exceed its limit, before recording anything.
 */
export async function consumeAll(
  ctx: MutationCtx,
  allowances: readonly Allowance[],
  cost = 1,
): Promise<void> {
  const now = Date.now();
  const windows = await Promise.all(
    allowances.map((a) => readWindow(ctx, a, now)),
  );
  const spent = windows.find((w) => w.count + cost > w.allowance.limit);
  // ConvexError keeps the message visible to users in production.
  if (spent) throw new ConvexError(spent.allowance.message);
  for (const { allowance, row, windowStart, count } of windows) {
    if (row) await ctx.db.patch(row._id, { windowStart, count: count + cost });
    else
      await ctx.db.insert("rateLimits", {
        key: allowance.key,
        windowStart,
        count: cost,
      });
  }
}

/**
 * Gives back `cost` uses recorded by {@link consume} for an action that did
 * not happen (an email the provider refused), while their window lasts.
 *
 * @param ctx - Mutation context; patches the key's rateLimits row.
 * @param key - The key `consume` counted under.
 * @param windowMs - The same window length.
 * @param cost - Uses to give back; the count never drops below zero.
 */
export async function refund(
  ctx: MutationCtx,
  key: string,
  windowMs: number,
  cost = 1,
): Promise<void> {
  const now = Date.now();
  const row = await ctx.db
    .query("rateLimits")
    .withIndex("key", (q) => q.eq("key", key))
    .unique();
  // A use from an earlier window was already forgotten when it rolled over.
  if (!row || row.windowStart !== now - (now % windowMs)) return;
  await ctx.db.patch(row._id, { count: Math.max(0, row.count - cost) });
}

// The key's row and its count in the window that holds `now`; a row from an
// earlier window counts as empty.
async function readWindow(ctx: MutationCtx, allowance: Allowance, now: number) {
  const windowStart = now - (now % allowance.windowMs);
  const row = await ctx.db
    .query("rateLimits")
    .withIndex("key", (q) => q.eq("key", allowance.key))
    .unique();
  const count = row?.windowStart === windowStart ? row.count : 0;
  return { allowance, row, windowStart, count };
}
