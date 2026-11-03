import { v } from "convex/values";
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
} from "./attachments";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { checkContext, managementDocs } from "./programContext";
import { audit } from "./access";
import { recordSchema } from "../src/domain/management";
import {
  inventoryAttachmentAccess,
  validateInventoryFile,
} from "../src/domain/inventoryAttachments";
import { recordProgram } from "../src/domain/programs";
const scope = { stockUuid: v.string(), programUuid: v.optional(v.string()) };
async function access(
  ctx: QueryCtx | MutationCtx,
  args: { stockUuid: string; programUuid?: string },
) {
  const state = await checkContext(ctx, args.programUuid);
  const management = (await managementDocs(ctx, args.programUuid)).map((d) =>
    recordSchema.parse(JSON.parse(d.payload)),
  );
  const snapshot = { ...state, management };
  const stock = inventoryAttachmentAccess(snapshot, args.stockUuid);
  return { user: state.user, programUuid: recordProgram(snapshot, stock) };
}
export const checkUpload = internalQuery({
  args: scope,
  handler: async (ctx, args) => {
    await access(ctx, args);
  },
});
export const finishUpload = internalMutation({
  args: {
    ...scope,
    storageId: v.id("_storage"),
    name: v.string(),
    type: v.string(),
    size: v.number(),
  },
  handler: async (ctx, args) => {
    const owner = await access(ctx, args);
    validateInventoryFile(args.name, args.type, args.size);
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
export const upload = action({
  args: { ...scope, name: v.string(), type: v.string(), bytes: v.bytes() },
  handler: async (ctx, args): Promise<void> => {
    validateInventoryFile(args.name, args.type, args.bytes.byteLength);
    const target = { stockUuid: args.stockUuid, programUuid: args.programUuid };
    await ctx.runQuery(internal.inventoryFiles.checkUpload, target);
    const storageId = await ctx.storage.store(
      new Blob([args.bytes], { type: args.type }),
    );
    try {
      await ctx.runMutation(internal.inventoryFiles.finishUpload, {
        ...target,
        storageId,
        name: args.name,
        type: args.type,
        size: args.bytes.byteLength,
      });
    } catch (error) {
      await ctx.storage.delete(storageId);
      throw error;
    }
  },
});
export const remove = mutation({
  args: { id: v.id("inventoryFiles"), programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const file = await ctx.db.get(args.id);
    if (!file) throw new Error("Attachment not found.");
    const owner = await access(ctx, {
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
