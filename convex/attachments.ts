import { ConvexError } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
// Per-record attachment cap; callers read at most this many rows by index.
export const MAX_ATTACHMENTS = 25;
export function assertAttachmentRoom(existing: unknown[]) {
  if (existing.length >= MAX_ATTACHMENTS)
    throw new ConvexError(
      `This record already has the maximum of ${MAX_ATTACHMENTS} attachments.`,
    );
}
// Sample and receipt uploads share one blob across records. Call after deleting
// the referencing row; the blob goes only when nothing else points at it.
export async function deleteBlobIfUnused(
  ctx: MutationCtx,
  storageId: Id<"_storage">,
) {
  const used = await Promise.all([
    ctx.db
      .query("inventoryFiles")
      .withIndex("storage", (q) => q.eq("storageId", storageId))
      .first(),
    ctx.db
      .query("poFiles")
      .withIndex("storage", (q) => q.eq("storageId", storageId))
      .first(),
    ctx.db
      .query("taskEvidence")
      .withIndex("storage", (q) => q.eq("storageId", storageId))
      .first(),
    ctx.db
      .query("workOrderFiles")
      .withIndex("storage", (q) => q.eq("storageId", storageId))
      .first(),
    ctx.db
      .query("manuals")
      .withIndex("storage", (q) => q.eq("storageId", storageId))
      .first(),
  ]);
  if (!used.some(Boolean)) await ctx.storage.delete(storageId);
}
