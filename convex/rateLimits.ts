import { ConvexError } from "convex/values";
import type { MutationCtx } from "./_generated/server";
export const MINUTE = 60000;
export const HOUR = 3600000;
export const DAY = 86400000;
// Fixed-window counter per key (user, program, or global provider quota).
export async function consume(
  ctx: MutationCtx,
  key: string,
  limit: number,
  windowMs: number,
  message: string,
  cost = 1,
) {
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
