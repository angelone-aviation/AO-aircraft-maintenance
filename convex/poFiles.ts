/**
 * Responsibility: Files attached to a purchase order or one of its receipts:
 *   uploading and removing them, with their stored blobs.
 * Layer: Server. A public action and mutation over internal steps; the
 *   program's inventory administrators only.
 * Dependencies: convex/programContext, convex/attachments, convex/access,
 *   convex/userErrors, src/domain (programs, purchaseOrders,
 *   inventoryAttachments).
 */
import { ConvexError, v } from "convex/values";
import {
  action,
  mutation,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { checkContext } from "./programContext";
import {
  assertAttachmentRoom,
  deleteBlobIfUnused,
  MAX_ATTACHMENTS,
} from "./attachments";
import { audit } from "./access";
import { exposeRejections } from "./userErrors";
import { programPermission } from "../src/domain/programs";
import { poSchema, poAttachmentRemovable } from "../src/domain/purchaseOrders";
import { validateInventoryFile } from "../src/domain/inventoryAttachments";
const scope = {
  poUuid: v.string(),
  receiptUuid: v.optional(v.string()),
  programUuid: v.optional(v.string()),
};
async function access(
  ctx: QueryCtx | MutationCtx,
  args: { poUuid: string; receiptUuid?: string; programUuid?: string },
) {
  const s = await checkContext(ctx, args.programUuid);
  if (!programPermission(s, "admin"))
    throw new ConvexError("Inventory administrator access required.");
  const doc = await ctx.db
    .query("purchaseOrders")
    .withIndex("uuid", (q) => q.eq("uuid", args.poUuid))
    .unique();
  if (!doc || doc.programUuid !== args.programUuid)
    throw new ConvexError("PO not found.");
  const po = poSchema.parse(JSON.parse(doc.payload));
  const receipt = po.receipts.find((r) => r.uuid === args.receiptUuid);
  if (args.receiptUuid && !receipt) throw new ConvexError("Receipt not found.");
  return { po, receipt, s };
}
export const check = internalQuery({
  args: scope,
  handler: async (ctx, args) => {
    await access(ctx, args);
  },
});
export const finish = internalMutation({
  args: {
    ...scope,
    storageId: v.id("_storage"),
    name: v.string(),
    type: v.string(),
    size: v.number(),
  },
  handler: async (ctx, args) => {
    const { po, receipt } = await access(ctx, args);
    exposeRejections(() =>
      validateInventoryFile(args.name, args.type, args.size),
    );
    assertAttachmentRoom(
      await ctx.db
        .query("poFiles")
        .withIndex("po", (q) => q.eq("poUuid", po.uuid))
        .take(MAX_ATTACHMENTS),
    );
    const fields = {
      storageId: args.storageId,
      name: args.name,
      type: args.type,
      size: args.size,
      uploadedAt: Date.now(),
    };
    await ctx.db.insert("poFiles", {
      ...fields,
      programUuid: po.programUuid,
      poUuid: po.uuid,
      receiptUuid: args.receiptUuid,
    });
    for (const stockUuid of new Set(
      receipt?.lines.flatMap((l) => l.itemUuids) ?? [],
    ))
      await ctx.db.insert("inventoryFiles", { ...fields, stockUuid });
  },
});
export const upload = action({
  args: { ...scope, name: v.string(), type: v.string(), bytes: v.bytes() },
  handler: async (ctx, args): Promise<void> => {
    exposeRejections(() =>
      validateInventoryFile(args.name, args.type, args.bytes.byteLength),
    );
    const target = {
      poUuid: args.poUuid,
      receiptUuid: args.receiptUuid,
      programUuid: args.programUuid,
    };
    await ctx.runQuery(internal.poFiles.check, target);
    const storageId = await ctx.storage.store(
      new Blob([args.bytes], { type: args.type }),
    );
    try {
      await ctx.runMutation(internal.poFiles.finish, {
        ...target,
        storageId,
        name: args.name,
        type: args.type,
        size: args.bytes.byteLength,
      });
    } catch (e) {
      await ctx.storage.delete(storageId);
      throw e;
    }
  },
});
export const remove = mutation({
  args: { id: v.id("poFiles"), programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const file = await ctx.db.get(args.id);
    if (!file) throw new ConvexError("Attachment not found.");
    const { po, s } = await access(ctx, {
      poUuid: file.poUuid,
      programUuid: args.programUuid,
    });
    if (!poAttachmentRemovable(po))
      throw new ConvexError(
        "Attachments can be deleted only while the PO is a draft.",
      );
    await ctx.db.delete(file._id);
    await deleteBlobIfUnused(ctx, file.storageId);
    await audit(ctx, s.user.id, "purchaseOrder.attachment_removed", po.uuid, {
      programUuid: po.programUuid,
      before: { name: file.name, size: file.size },
    });
  },
});
