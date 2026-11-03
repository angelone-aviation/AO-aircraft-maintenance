// Nightly off-site backup records (ADR-0008, "Freshness alarm"). The backup
// job in GitHub Actions calls recordOffsiteCopy with its deploy key after
// each successful upload to R2; system administrators see the newest copy in
// Settings → System, and the daily alert digest warns them when it is stale
// (src/domain/offsiteBackups.ts).
import { internalMutation, query, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { admin } from "./access";
import type { OffsiteCopy } from "../src/domain/offsiteBackups";

const MAX_KEY_LENGTH = 1024; // R2 and S3 object key limit
const FUTURE_LIMIT_MS = 10 * 60_000;

function checkKey(key: string, name: string, prefix: string, suffix = "") {
  if (
    key.length > MAX_KEY_LENGTH ||
    !key.startsWith(prefix) ||
    !key.endsWith(suffix) ||
    key.length <= prefix.length + suffix.length
  )
    throw new Error(
      `${name} must start with "${prefix}"${suffix ? ` and end with "${suffix}"` : ""}.`,
    );
}

/**
 * Records one successful off-site copy. Internal: only the backup job (or
 * anyone else holding a deploy key) can call it, as
 * `npx convex run backups:recordOffsiteCopy '{...}'`. Running it again with
 * the same copy records nothing new.
 *
 * No change-log (audit) row is written: this changes no maintenance record,
 * and a row every night would flood the "Unassigned records" history. The
 * table itself is the record of backups.
 */
export const recordOffsiteCopy = internalMutation({
  args: {
    completedAt: v.number(),
    objectKey: v.string(),
    bytes: v.number(),
    sha256: v.string(),
    monthlyKey: v.optional(v.string()),
    envUploaded: v.boolean(),
  },
  handler: async (ctx, args) => {
    const recordedAt = Date.now();
    checkKey(args.objectKey, "objectKey", "daily/", ".zip.age");
    if (args.monthlyKey !== undefined)
      checkKey(args.monthlyKey, "monthlyKey", "monthly/");
    if (!/^[0-9a-f]{64}$/.test(args.sha256))
      throw new Error("sha256 must be 64 lowercase hexadecimal characters.");
    if (!Number.isSafeInteger(args.bytes) || args.bytes <= 0)
      throw new Error("bytes must be a positive whole number.");
    if (!Number.isFinite(args.completedAt) || args.completedAt <= 0)
      throw new Error("completedAt must be a time in epoch milliseconds.");
    if (args.completedAt > recordedAt + FUTURE_LIMIT_MS)
      throw new Error(
        "completedAt is more than 10 minutes in the future. Check the clock and the units (milliseconds).",
      );
    const same = (
      await ctx.db
        .query("backupRuns")
        .withIndex("completedAt", (q) => q.eq("completedAt", args.completedAt))
        .collect()
    ).find((run) => run.objectKey === args.objectKey);
    if (same) {
      if (
        same.bytes !== args.bytes ||
        same.sha256 !== args.sha256 ||
        same.monthlyKey !== args.monthlyKey ||
        same.envUploaded !== args.envUploaded
      )
        throw new Error(
          "This copy is already recorded with different details.",
        );
      return same._id;
    }
    return await ctx.db.insert("backupRuns", { ...args, recordedAt });
  },
});

/** The newest copy, and when the newest monthly archive was made. */
export async function latestCopy(ctx: QueryCtx): Promise<OffsiteCopy | null> {
  let latest: OffsiteCopy | null = null;
  // Newest first; a monthly archive is made each month, so this normally
  // stops within about a month of rows.
  for await (const run of ctx.db
    .query("backupRuns")
    .withIndex("completedAt")
    .order("desc")) {
    latest ??= {
      completedAt: run.completedAt,
      bytes: run.bytes,
      objectKey: run.objectKey,
      monthlyKey: run.monthlyKey,
      envUploaded: run.envUploaded,
    };
    if (run.monthlyKey) {
      latest.monthlyCompletedAt = run.completedAt;
      break;
    }
  }
  return latest;
}

/** Settings → System: the newest off-site copy, for system administrators. */
export const latestOffsiteCopy = query({
  args: {},
  handler: async (ctx) => {
    await admin(ctx);
    return latestCopy(ctx);
  },
});
