/**
 * Responsibility: The per-record attachment cap, and deleting a shared upload
 *   once no record refers to it.
 * Layer: Server. Mutation helpers; callers check access and write the audit.
 * Dependencies: convex/values (ConvexError), convex/_generated (server,
 *   dataModel), convex/storageReferences.ts (which tables refer to a blob).
 */
import { ConvexError } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { storageReferenced } from "./storageReferences";

/**
 * Most attachments one record may hold. Callers read at most this many rows by
 * index, so the check stays cheap.
 */
export const MAX_ATTACHMENTS = 25;

/**
 * Refuses another attachment on a record that already holds the maximum.
 *
 * @param existing - The record's attachments, read with
 *   `.take(MAX_ATTACHMENTS)`.
 * @throws {ConvexError} "This record already has the maximum of 25
 *   attachments."
 */
export function assertAttachmentRoom(existing: unknown[]): void {
  if (existing.length >= MAX_ATTACHMENTS)
    throw new ConvexError(
      `This record already has the maximum of ${MAX_ATTACHMENTS} attachments.`,
    );
}

/**
 * Deletes an uploaded file once no record refers to it, by the schema-checked
 * list behind {@link storageReferenced}. Sample and receipt uploads share one
 * blob across records, so call this after deleting the referencing row.
 *
 * @param ctx - Mutation context; may delete the blob from file storage.
 * @param storageId - The blob the deleted row pointed at.
 */
export async function deleteBlobIfUnused(
  ctx: MutationCtx,
  storageId: Id<"_storage">,
): Promise<void> {
  if (!(await storageReferenced(ctx, storageId)))
    await ctx.storage.delete(storageId);
}
