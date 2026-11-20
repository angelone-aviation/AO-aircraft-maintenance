/**
 * Responsibility: Finds stored files no record refers to once they are a day
 *   old, and reports or deletes them as FILE_SWEEP says, a bounded batch per
 *   run, resuming where the last run stopped.
 * Layer: Server. One internal mutation, run hourly by convex/crons.ts in a
 *   transaction of its own.
 * Dependencies: convex/server, convex/_generated (server, dataModel),
 *   ./rateLimits, ./storageReferences.
 *
 * It starts safe: unset, FILE_SWEEP means report, which deletes nothing and
 * logs what it would delete for review (docs/runbooks/file-sweep.md), and it
 * never touches a file created before the day of its first run. Each file is
 * checked once, in the first run after it turns a day old. Every path that
 * deletes a row naming a file also deletes the file once nothing else refers
 * to it, so a file nothing refers to was orphaned at upload: a link upload
 * whose bytes matched no ticket (T2), or an action stopped between storing a
 * file and filing it. A day is far past the longest wait between the two
 * (the one-hour upload ticket), so a run never takes an upload in flight.
 */
import { makeFunctionReference } from "convex/server";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
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

/** What the sweep does with a file nothing refers to: FILE_SWEEP's values. */
export type SweepMode = "off" | "report" | "delete";

const MODES: readonly SweepMode[] = ["off", "report", "delete"];

/**
 * Reads FILE_SWEEP. Unset means report, so a deployment deletes nothing until
 * someone has read a report and chosen delete.
 *
 * @param value - The variable as set, if it is.
 * @returns The mode; "report" for an unset value, and for an unknown one,
 *   with a warning in the log.
 */
export function sweepMode(value: string | undefined): SweepMode {
  if (value === undefined) return "report";
  const mode = MODES.find((m) => m === value);
  if (mode) return mode;
  console.warn(
    "fileSweep: FILE_SWEEP is not off, report or delete; reporting only.",
  );
  return "report";
}

/**
 * Checks the next files that are more than {@link UNREFERENCED_FILE_AGE} old,
 * oldest first, from the day of its first run on, and for each that no table
 * in `STORAGE_REFERENCES` refers to (a record, attachment, manual, photo,
 * Form 337 copy or upload ticket) logs "fileSweep would delete" in report
 * mode, or deletes it and logs "fileSweep deleted" in delete mode, with its
 * storage id, size, content type and creation time. Off, it reads and writes
 * nothing. Runs apart from the manual-ticket clean-up, so a failure in one
 * never stops the other. Saves its place in the fileSweep row.
 */
export const sweepFiles = internalMutation({
  args: {},
  handler: async (ctx) => {
    const mode = sweepMode(process.env.FILE_SWEEP);
    if (mode === "off") return;
    const state = await loadState(ctx, mode);
    const candidates = await readCandidates(ctx, state.cursor);
    const { page, next } = pageAfter(candidates, state.cursor, FILES_PER_RUN);
    let unreferenced = 0;
    for (const file of page)
      if (await sweepFile(ctx, mode, file)) unreferenced++;
    console.log("fileSweep run", { mode, checked: page.length, unreferenced });
    await ctx.db.patch(state.id, { mode, ...next });
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

type ActiveMode = Exclude<SweepMode, "off">;

/** A stored file as the system table lists it. */
type StoredFile = {
  _id: Id<"_storage">;
  _creationTime: number;
  size: number;
  contentType?: string;
};

// The sweep's row, made on its first run. A change of mode walks again from
// the start day, so files a report run only listed are deleted once delete
// is chosen.
async function loadState(
  ctx: MutationCtx,
  mode: ActiveMode,
): Promise<{ id: Id<"fileSweep">; cursor: SweepCursor }> {
  const row = await ctx.db.query("fileSweep").first();
  if (!row) return startState(ctx, mode);
  if (row.mode !== mode)
    return {
      id: row._id,
      cursor: { checkedThrough: row.notBefore, checkedIds: [] },
    };
  const { checkedThrough, checkedIds } = row;
  return { id: row._id, cursor: { checkedThrough, checkedIds } };
}

// Files from before the first run's UTC day were in storage before the sweep
// existed, so the walk starts at that midnight and never reaches them.
async function startState(ctx: MutationCtx, mode: ActiveMode) {
  const now = Date.now();
  const notBefore = now - (now % DAY);
  const cursor = { checkedThrough: notBefore, checkedIds: [] };
  const id = await ctx.db.insert("fileSweep", { notBefore, mode, ...cursor });
  return { id, cursor };
}

// From the cursor's time on, inclusive, to a day ago; enough to leave
// FILES_PER_RUN once the files the cursor holds are skipped.
function readCandidates(
  ctx: MutationCtx,
  cursor: SweepCursor,
): Promise<StoredFile[]> {
  return ctx.db.system
    .query("_storage")
    .withIndex("by_creation_time", (q) =>
      q
        .gte("_creationTime", cursor.checkedThrough)
        .lt("_creationTime", Date.now() - UNREFERENCED_FILE_AGE),
    )
    .take(FILES_PER_RUN + cursor.checkedIds.length);
}

// Reports or deletes a file nothing refers to; true when it was one.
async function sweepFile(
  ctx: MutationCtx,
  mode: ActiveMode,
  file: StoredFile,
): Promise<boolean> {
  if (await storageReferenced(ctx, file._id)) return false;
  const details = {
    storageId: file._id,
    size: file.size,
    contentType: file.contentType,
    _creationTime: file._creationTime,
  };
  if (mode === "report") {
    console.log("fileSweep would delete", details);
    return true;
  }
  await ctx.storage.delete(file._id);
  console.log("fileSweep deleted", details);
  return true;
}
