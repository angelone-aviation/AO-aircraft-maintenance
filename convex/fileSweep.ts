/**
 * Responsibility: Deletes stored files no record refers to once they are a
 *   day old, a bounded batch per run, resuming where the last run stopped.
 * Layer: Server. One internal mutation, run hourly by convex/crons.ts in a
 *   transaction of its own.
 * Dependencies: convex/server, convex/_generated/server, ./rateLimits,
 *   ./storageReferences.
 *
 * Each file is checked once, in the first run after it turns a day old. Every
 * path that deletes a row naming a file also deletes the file once nothing
 * else refers to it, so a file nothing refers to was orphaned at upload: a
 * link upload whose bytes matched no ticket (T2), or an action stopped
 * between storing a file and filing it. A day is far past the longest wait
 * between the two (the one-hour upload ticket), so a run never takes an
 * upload still in flight.
 */
import { makeFunctionReference } from "convex/server";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { DAY } from "./rateLimits";
import { storageReferenced } from "./storageReferences";

/** Age at which a stored file nothing refers to is deleted. */
export const UNREFERENCED_FILE_AGE = DAY;

/**
 * Files checked per run. Each costs one lookup per storage table, about 1,000
 * a run, which keeps one mutation's reads small; run hourly, it checks 2,400
 * files a day.
 */
export const FILES_PER_RUN = 100;

/**
 * {@link sweepFiles} by name, for the cron table and tests: the committed
 * generated API does not list this module until the next codegen.
 */
export const SWEEP_FILES = makeFunctionReference<"mutation">(
  "fileSweep:sweepFiles",
);

/**
 * How far the sweep has checked: the newest creation time, and every file
 * checked at exactly that time.
 */
export interface SweepCursor {
  checkedThrough: number;
  checkedIds: Id<"_storage">[];
}

const START: SweepCursor = { checkedThrough: 0, checkedIds: [] };

/**
 * Checks the next files that are more than {@link UNREFERENCED_FILE_AGE} old,
 * oldest first, and deletes each that no table in `STORAGE_REFERENCES` refers
 * to: a record, attachment, manual, photo, Form 337 copy or upload ticket.
 * Runs apart from the manual-ticket clean-up, so a failure in one never stops
 * the other. Saves its cursor in the fileSweep row, so the next run starts
 * after the last file checked.
 */
export const sweepFiles = internalMutation({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db.query("fileSweep").first();
    const cursor = row ?? START;
    const candidates = await ctx.db.system
      .query("_storage")
      .withIndex("by_creation_time", (q) =>
        q
          .gte("_creationTime", cursor.checkedThrough)
          .lt("_creationTime", Date.now() - UNREFERENCED_FILE_AGE),
      )
      .take(FILES_PER_RUN + cursor.checkedIds.length);
    const { page, next } = pageAfter(candidates, cursor, FILES_PER_RUN);
    for (const file of page)
      if (!(await storageReferenced(ctx, file._id)))
        await ctx.storage.delete(file._id);
    if (page.length) await saveCursor(ctx, row, next);
  },
});

/**
 * The next files to check and the cursor to save after them. Files the cursor
 * already holds are skipped, so a page edge inside a group of files that
 * share a creation time loses none of them.
 *
 * @param candidates - Files from the cursor's time on, inclusive, oldest
 *   first: read `limit` plus the cursor's ids, so `limit` remain to check.
 * @param cursor - Where the last run stopped.
 * @param limit - The most files to return.
 * @returns At most `limit` files in order, and the cursor after the last of
 *   them; with none, the same cursor.
 */
export function pageAfter<
  T extends { _id: Id<"_storage">; _creationTime: number },
>(
  candidates: T[],
  cursor: SweepCursor,
  limit: number,
): { page: T[]; next: SweepCursor } {
  const checked = new Set(cursor.checkedIds);
  const page = candidates.filter((f) => !checked.has(f._id)).slice(0, limit);
  const last = page.at(-1);
  if (!last) return { page, next: cursor };
  const atLast = page
    .filter((f) => f._creationTime === last._creationTime)
    .map((f) => f._id);
  const carried =
    last._creationTime === cursor.checkedThrough ? cursor.checkedIds : [];
  return {
    page,
    next: {
      checkedThrough: last._creationTime,
      checkedIds: [...carried, ...atLast],
    },
  };
}

async function saveCursor(
  ctx: MutationCtx,
  row: Doc<"fileSweep"> | null,
  next: SweepCursor,
): Promise<void> {
  if (row) await ctx.db.patch(row._id, next);
  else await ctx.db.insert("fileSweep", next);
}
