/**
 * Responsibility: Files attached to a stock item or component: uploading and
 *   removing them, with their stored blobs.
 * Layer: Server. A public action and mutation over internal steps; the
 *   program's inventory administrators only, and every change is audited.
 * Dependencies: convex/programContext, convex/attachments, convex/access,
 *   convex/userErrors, src/domain (management, inventoryAttachments, programs).
 */
import { ConvexError, v } from "convex/values";
import {
  action,
  mutation,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import {
  assertAttachmentRoom,
  deleteBlobIfUnused,
  MAX_ATTACHMENTS,
  storeThenFinish,
} from "./attachments";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { checkContext, managementDocs } from "./programContext";
import { audit } from "./access";
import { exposeRejections } from "./userErrors";
import { recordSchema } from "../src/domain/management";
import {
  inventoryAttachmentAccess,
  validateInventoryFile,
  assertFileContents,
} from "../src/domain/inventoryAttachments";
import { recordProgram } from "../src/domain/programs";

const scope = { stockUuid: v.string(), programUuid: v.optional(v.string()) };

/**
 * Refuses an upload before its file is stored, unless the caller administers
 * the item's Flight Program.
 *
 * @param stockUuid - The stock item or component.
 * @param programUuid - The caller's active Flight Program.
 * @throws {ConvexError} "Inventory administrator access to this item is
 *   required.", also for a missing item.
 * @throws As `checkContext`, first.
 */
export const checkUpload = internalQuery({
  args: scope,
  handler: async (ctx, args) => {
    await authorizeItemAdmin(ctx, args);
  },
});

/**
 * Records a stored upload on the item, and audits `inventory.attachment` with
 * its name and size.
 *
 * @param storageId - The stored file; the caller deletes it on a refusal.
 * @param size - Its size; the other arguments are {@link upload}'s.
 * @throws {ConvexError} The {@link checkUpload} refusals; the file refusals;
 *   "This record already has the maximum of 25 attachments."
 */
export const finishUpload = internalMutation({
  args: {
    ...scope,
    storageId: v.id("_storage"),
    name: v.string(),
    type: v.string(),
    size: v.number(),
  },
  handler: async (ctx, args) => {
    const owner = await authorizeItemAdmin(ctx, args);
    exposeRejections(() =>
      validateInventoryFile(args.name, args.type, args.size),
    );
    assertAttachmentRoom(
      await ctx.db
        .query("inventoryFiles")
        .withIndex("stock", (q) => q.eq("stockUuid", args.stockUuid))
        .take(MAX_ATTACHMENTS),
    );
    const { programUuid: _program, ...fields } = args;
    await ctx.db.insert("inventoryFiles", {
      ...fields,
      uploadedAt: Date.now(),
    });
    await audit(ctx, owner.user.id, "inventory.attachment", args.stockUuid, {
      programUuid: owner.programUuid,
      after: { name: args.name, size: args.size },
      reason: "Inventory attachment uploaded",
    });
  },
});

/**
 * Attaches a file to a stock item or component.
 *
 * @param stockUuid - The item.
 * @param programUuid - The caller's active Flight Program.
 * @param name - The file name; its extension must match `type`.
 * @param type - PDF, JPEG, PNG or WebP.
 * @param bytes - The file, at most 7 MB.
 * @throws {ConvexError} "Choose a PDF, JPEG, PNG or WebP file." or
 *   "Attachments must be between 1 byte and 7 MB.", checked first; then
 *   "This file's contents do not match its type. Choose a PDF, JPEG, PNG or
 *   WebP file." when the first bytes are not the declared type's; the
 *   {@link finishUpload} refusals, after which the stored file is deleted.
 */
export const upload = action({
  args: { ...scope, name: v.string(), type: v.string(), bytes: v.bytes() },
  handler: async (ctx, args): Promise<void> => {
    exposeRejections(() => {
      validateInventoryFile(args.name, args.type, args.bytes.byteLength);
      assertFileContents(args.type, args.bytes);
    });
    const target = { stockUuid: args.stockUuid, programUuid: args.programUuid };
    await ctx.runQuery(internal.inventoryFiles.checkUpload, target);
    await storeThenFinish(ctx, args, (storageId) =>
      ctx.runMutation(internal.inventoryFiles.finishUpload, {
        ...target,
        storageId,
        name: args.name,
        type: args.type,
        size: args.bytes.byteLength,
      }),
    );
  },
});

/**
 * Removes an attachment, and its stored file once no other record uses it (a
 * PO receipt's file is shared with the items received); audits
 * `inventory.attachment_removed` with its name and size.
 *
 * @param id - The attachment.
 * @param programUuid - The caller's active Flight Program.
 * @throws {ConvexError} "Attachment not found.", checked first; the
 *   {@link checkUpload} refusals for the attachment's item.
 */
export const remove = mutation({
  args: { id: v.id("inventoryFiles"), programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const file = await ctx.db.get(args.id);
    if (!file) throw new ConvexError("Attachment not found.");
    const owner = await authorizeItemAdmin(ctx, {
      stockUuid: file.stockUuid,
      programUuid: args.programUuid,
    });
    await ctx.db.delete(file._id);
    await deleteBlobIfUnused(ctx, file.storageId);
    await audit(
      ctx,
      owner.user.id,
      "inventory.attachment_removed",
      file.stockUuid,
      {
        programUuid: owner.programUuid,
        before: { name: file.name, size: file.size },
        reason: "Inventory attachment removed",
      },
    );
  },
});

async function authorizeItemAdmin(
  ctx: QueryCtx | MutationCtx,
  args: { stockUuid: string; programUuid?: string },
) {
  const state = await checkContext(ctx, args.programUuid);
  const management = (await managementDocs(ctx, args.programUuid)).map((d) =>
    recordSchema.parse(JSON.parse(d.payload)),
  );
  const snapshot = { ...state, management };
  const stock = exposeRejections(() =>
    inventoryAttachmentAccess(snapshot, args.stockUuid),
  );
  return { user: state.user, programUuid: recordProgram(snapshot, stock) };
}
