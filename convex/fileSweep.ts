/**
 * Responsibility: Deletes stored files no record refers to once they are a
 *   day old, a bounded batch per run, resuming where the last run stopped.
 * Layer: Server. A mutation helper for the hourly upload clean-up.
 * Dependencies: convex/_generated/server, ./rateLimits, ./storageReferences.
 *
 * Each file is checked once, in the first run after it turns a day old. Every
 * path that removes a record deletes its file once nothing else refers to it,
 * so a file nothing refers to was orphaned at upload: a link upload whose
 * bytes matched no ticket (T2), or an action stopped between storing a file
 * and filing it. A day is far past the longest wait between the two (the
 * one-hour upload ticket), so a run never takes an upload still in flight.
 */
import type { MutationCtx } from "./_generated/server";
import { DAY } from "./rateLimits";
import { storageReferenced } from "./storageReferences";

/** Age at which a stored file nothing refers to is deleted. */
export const UNREFERENCED_FILE_AGE = DAY;

/**
 * Files checked per run. Each costs one lookup per storage table, so a run
 * stays far inside a mutation's read limits; run hourly, 2,400 a day.
 */
export const FILES_PER_RUN = 100;

/**
 * Checks the next files that are more than {@link UNREFERENCED_FILE_AGE} old,
 * oldest first, and deletes each that no table in `STORAGE_REFERENCES` refers
 * to: a record, attachment, manual, photo, Form 337 copy or upload ticket.
 *
 * @param ctx - Mutation context; deletes from file storage and saves how far
 *   it got in the fileSweep row, so the next run starts after that file.
 */
export async function sweepUnreferencedFiles(ctx: MutationCtx): Promise<void> {
  const place = await ctx.db.query("fileSweep").first();
  const files = await ctx.db.system
    .query("_storage")
    .withIndex("by_creation_time", (q) =>
      q
        .gt("_creationTime", place?.checkedThrough ?? 0)
        .lt("_creationTime", Date.now() - UNREFERENCED_FILE_AGE),
    )
    .take(FILES_PER_RUN);
  for (const file of files)
    if (!(await storageReferenced(ctx, file._id)))
      await ctx.storage.delete(file._id);
  const last = files.at(-1);
  if (!last) return;
  if (place)
    await ctx.db.patch(place._id, { checkedThrough: last._creationTime });
  else await ctx.db.insert("fileSweep", { checkedThrough: last._creationTime });
}
