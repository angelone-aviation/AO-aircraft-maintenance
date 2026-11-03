import { v } from "convex/values";
import {
  query,
  mutation,
  action,
  internalQuery,
  internalMutation,
  type QueryCtx,
  type MutationCtx,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { currentUser, audit } from "./access";
import {
  certificationsSchema,
  certificationKindSchema,
  memberLicense,
  validateCertificationFile,
} from "../src/domain/certifications";
async function access(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  const actor = await currentUser(ctx);
  if (actor._id !== userId && !actor.isAdmin)
    throw Error(
      "Only the account owner or an administrator may access license records.",
    );
  const user = await ctx.db.get(userId);
  if (!user) throw Error("User not found.");
  return { actor, user };
}
export const save = mutation({
  args: { userId: v.id("users"), payload: v.string() },
  handler: async (ctx, args) => {
    const { actor } = await access(ctx, args.userId);
    const certifications = certificationsSchema.parse(JSON.parse(args.payload));
    await ctx.db.patch(args.userId, {
      certifications,
      ...memberLicense({ certifications }),
    });
    await audit(ctx, actor._id, "user.certifications_updated", args.userId);
  },
});
export const list = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    await access(ctx, userId);
    return (
      await ctx.db
        .query("certificationFiles")
        .withIndex("user", (q) => q.eq("userId", userId))
        .collect()
    ).map((d) => ({
      id: d._id,
      userId,
      kind: certificationKindSchema.parse(d.kind),
      name: d.name,
      type: d.type,
      size: d.size,
      uploadedAt: d.uploadedAt,
    }));
  },
});
export const fileUrl = query({
  args: { id: v.id("certificationFiles") },
  handler: async (ctx, { id }) => {
    const file = await ctx.db.get(id);
    if (!file) throw Error("License copy not found.");
    await access(ctx, file.userId);
    return ctx.storage.getUrl(file.storageId);
  },
});
const target = { userId: v.id("users"), kind: v.string() };
export const checkUpload = internalQuery({
  args: target,
  handler: async (ctx, args) => {
    const { user } = await access(ctx, args.userId);
    const kind = certificationKindSchema.parse(args.kind);
    if (!user.certifications?.some((c) => c.kind === kind))
      throw Error("Save this certification before attaching its license copy.");
  },
});
export const finishUpload = internalMutation({
  args: {
    ...target,
    storageId: v.id("_storage"),
    name: v.string(),
    type: v.string(),
    size: v.number(),
  },
  handler: async (ctx, args) => {
    const { actor, user } = await access(ctx, args.userId);
    const kind = certificationKindSchema.parse(args.kind);
    if (!user.certifications?.some((c) => c.kind === kind))
      throw Error("Certification is no longer selected.");
    validateCertificationFile(args.name, args.type, args.size);
    const id = await ctx.db.insert("certificationFiles", {
      ...args,
      kind,
      uploadedAt: Date.now(),
    });
    await audit(ctx, actor._id, "user.license_copy_uploaded", args.userId);
    return id;
  },
});
export const upload = action({
  args: { ...target, name: v.string(), type: v.string(), bytes: v.bytes() },
  handler: async (ctx, args): Promise<string> => {
    validateCertificationFile(args.name, args.type, args.bytes.byteLength);
    await ctx.runQuery(internal.certifications.checkUpload, {
      userId: args.userId,
      kind: args.kind,
    });
    const storageId = await ctx.storage.store(
      new Blob([args.bytes], { type: args.type }),
    );
    try {
      return await ctx.runMutation(internal.certifications.finishUpload, {
        userId: args.userId,
        kind: args.kind,
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
  args: { id: v.id("certificationFiles") },
  handler: async (ctx, { id }) => {
    const file = await ctx.db.get(id);
    if (!file) throw Error("License copy not found.");
    const { actor } = await access(ctx, file.userId);
    await ctx.storage.delete(file.storageId);
    await ctx.db.delete(id);
    await audit(ctx, actor._id, "user.license_copy_deleted", file.userId);
  },
});
