/**
 * Responsibility: Applies the domain's attachment cap to stored rows, stores
 *   an upload until its record is filed, and deletes a shared upload once no
 *   record refers to it.
 * Layer: Server. Action and mutation helpers; callers check access and write
 *   the audit.
 * Dependencies: convex/_generated (server, dataModel), ./storageReferences,
 *   ./userErrors, src/domain/attachments.
 */
import type { ActionCtx, MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { storageReferenced } from "./storageReferences";
import { exposeRejections } from "./userErrors";
import {
  assertAttachmentRoom as assertRoomFor,
  MAX_ATTACHMENTS,
} from "../src/domain/attachments";

// The domain's cap, for callers that read a record's rows with `.take()`.
export { MAX_ATTACHMENTS };

/**
 * Refuses another attachment on a record that already holds the maximum.
 *
 * @param existing - The record's attachments, read with
 *   `.take(MAX_ATTACHMENTS)`.
 * @throws {ConvexError} "This record already has the maximum of 25
 *   attachments."
 */
export function assertAttachmentRoom(existing: unknown[]): void {
  exposeRejections(() => assertRoomFor(existing.length));
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

/**
 * Stores an upload's bytes, then files them with `finish`. File storage is
 * outside the mutation's transaction, so a refused filing deletes the blob
 * again and rethrows the same error.
 *
 * @param ctx - Action context; writes to file storage.
 * @param file - The bytes and their MIME type, stored as the blob's type.
 * @param finish - Files the stored blob, usually a `runMutation`.
 * @returns What `finish` returns.
 * @throws Whatever `finish` throws, unchanged, after the blob is deleted.
 */
export async function storeThenFinish<T>(
  ctx: Pick<ActionCtx, "storage">,
  file: { bytes: ArrayBuffer; type: string },
  finish: (storageId: Id<"_storage">) => Promise<T>,
): Promise<T> {
  const storageId = await ctx.storage.store(
    new Blob([file.bytes], { type: file.type }),
  );
  try {
    return await finish(storageId);
  } catch (error) {
    await ctx.storage.delete(storageId);
    throw error;
  }
}
