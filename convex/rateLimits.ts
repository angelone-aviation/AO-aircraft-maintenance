/**
 * Responsibility: Counts uses of a limited action per key in fixed time
 *   windows, and refuses a use once the window's allowance is spent.
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
  const now = Date.now();
  const windowStart = now - (now % windowMs);
  const row = await ctx.db
    .query("rateLimits")
    .withIndex("key", (q) => q.eq("key", key))
    .unique();
  const count = row?.windowStart === windowStart ? row.count : 0;
  // ConvexError keeps the message visible to users in production.
  if (count + cost > limit) throw new ConvexError(message);
  if (row) await ctx.db.patch(row._id, { windowStart, count: count + cost });
  else await ctx.db.insert("rateLimits", { key, windowStart, count: cost });
}
