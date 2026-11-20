/**
 * Responsibility: Records each nightly off-site backup copy and reports the
 *   newest one (ADR-0008, "Freshness alarm").
 * Layer: Server. An internal mutation for the backup job's deploy key and a
 *   query for system administrators.
 * Dependencies: convex/access, src/domain/offsiteBackups (types).
 *
 * Writes no change-log rows: a copy changes no maintenance record, and a row
 * every night would flood the "Unassigned records" history. The backupRuns
 * table itself is the record of backups.
 */
import { internalMutation, query, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import { admin } from "./access";
import type { OffsiteCopy } from "../src/domain/offsiteBackups";

// R2's and S3's object key limit.
const MAX_KEY_LENGTH = 1024;

// An encrypted copy, or one stored unencrypted with no backup key (ADR-0014).
const DAILY_KEY_ENDINGS = [".zip.age", ".unencrypted.zip"];

// The backup job's clock may run a little ahead of the server's.
const FUTURE_LIMIT_MS = 10 * 60_000;

type Copy = Omit<Doc<"backupRuns">, "_id" | "_creationTime" | "recordedAt">;

/**
 * Records one successful off-site copy, as the GitHub Actions job does after
 * each upload to R2: `npx convex run backups:recordOffsiteCopy '{...}'`.
 *
 * @param completedAt - When the upload finished, in epoch milliseconds.
 * @param objectKey - The copy's key, starting "daily/" and ending ".zip.age",
 *   or ".unencrypted.zip" for a copy stored without encryption (ADR-0014).
 * @param bytes - The stored object's size.
 * @param sha256 - Its SHA-256, in lowercase hexadecimal.
 * @param monthlyKey - "monthly/…", on the night the copy also made the
 *   monthly archive.
 * @param envUploaded - Whether the environment variables were uploaded too.
 * @returns The copy's id; the same id when the same copy is recorded again.
 * @throws {Error} "objectKey must start with …", "monthlyKey must start
 *   with …", "sha256 must be …", "bytes must be …" or "completedAt …" for input
 *   off the job's contract; "This copy is already recorded with different
 *   details."
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
    assertCopyContract(args, recordedAt);
    const same = (
      await ctx.db
        .query("backupRuns")
        .withIndex("completedAt", (q) => q.eq("completedAt", args.completedAt))
        .collect()
    ).find((run) => run.objectKey === args.objectKey);
    if (!same)
      return await ctx.db.insert("backupRuns", { ...args, recordedAt });
    if (
      same.bytes !== args.bytes ||
      same.sha256 !== args.sha256 ||
      same.monthlyKey !== args.monthlyKey ||
      same.envUploaded !== args.envUploaded
    )
      throw new Error("This copy is already recorded with different details.");
    return same._id;
  },
});

/**
 * Reads the newest copy by completion time, and when the newest monthly
 * archive was made. Checks no access.
 *
 * @param ctx - Query context.
 * @returns Null before any copy; no `monthlyCompletedAt` before any monthly
 *   archive.
 */
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

/**
 * Shows system administrators the newest off-site copy in Settings → System.
 *
 * @returns As {@link latestCopy}.
 * @throws {Error} "Administrator permission required."
 */
export const latestOffsiteCopy = query({
  args: {},
  handler: async (ctx) => {
    await admin(ctx);
    return latestCopy(ctx);
  },
});

function assertCopyContract(copy: Copy, recordedAt: number): void {
  checkKey(copy.objectKey, "objectKey", "daily/", DAILY_KEY_ENDINGS);
  if (copy.monthlyKey !== undefined)
    checkKey(copy.monthlyKey, "monthlyKey", "monthly/", [""]);
  if (!/^[0-9a-f]{64}$/.test(copy.sha256))
    throw new Error("sha256 must be 64 lowercase hexadecimal characters.");
  if (!Number.isSafeInteger(copy.bytes) || copy.bytes <= 0)
    throw new Error("bytes must be a positive whole number.");
  if (!Number.isFinite(copy.completedAt) || copy.completedAt <= 0)
    throw new Error("completedAt must be a time in epoch milliseconds.");
  if (copy.completedAt > recordedAt + FUTURE_LIMIT_MS)
    throw new Error(
      "completedAt is more than 10 minutes in the future. Check the clock and the units (milliseconds).",
    );
}

function checkKey(
  key: string,
  name: string,
  prefix: string,
  endings: string[],
) {
  const fits = endings.some(
    (ending) =>
      key.endsWith(ending) && key.length > prefix.length + ending.length,
  );
  if (key.length <= MAX_KEY_LENGTH && key.startsWith(prefix) && fits) return;
  const end = endings.filter(Boolean).map((ending) => `"${ending}"`);
  throw new Error(
    `${name} must start with "${prefix}"${end.length ? ` and end with ${end.join(" or ")}` : ""}.`,
  );
}
