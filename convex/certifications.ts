/**
 * Responsibility: A member's certifications and the license copies filed for
 *   them: saving, listing, opening, uploading and deleting.
 * Layer: Server. Public functions for the member themself or a system
 *   administrator; every change is audited against the member.
 * Dependencies: convex/access, convex/attachments, convex/userErrors,
 *   src/domain/certifications.
 */
import { ConvexError, v } from "convex/values";
import {
  query,
  mutation,
  action,
  internalQuery,
  internalMutation,
  type QueryCtx,
  type MutationCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { currentUser, audit } from "./access";
import { storeThenFinish } from "./attachments";
import { exposeRejections } from "./userErrors";
import {
  certificationsSchema,
  certificationKindSchema,
  memberLicense,
  validateCertificationFile,
} from "../src/domain/certifications";

const target = { userId: v.id("users"), kind: v.string() };

/**
 * Replaces a member's certifications and the license fields derived from
 * them; audits "user.certifications_updated".
 *
 * @param userId - The member.
 * @param payload - JSON, as `certificationsSchema`.
 * @throws As {@link list}.
 * @throws {ConvexError} The issue text of certifications
 *   `certificationsSchema` refuses.
 */
export const save = mutation({
  args: { userId: v.id("users"), payload: v.string() },
  handler: async (ctx, args) => {
    const { actor } = await authorize(ctx, args.userId);
    const certifications = exposeRejections(() =>
      certificationsSchema.parse(JSON.parse(args.payload)),
    );
    await ctx.db.patch(args.userId, {
      certifications,
      ...memberLicense({ certifications }),
    });
    await audit(ctx, actor._id, "user.certifications_updated", args.userId);
  },
});

/**
 * Lists the license copies filed for a member.
 *
 * @param userId - The member.
 * @returns The member's copies, described without their stored files.
 * @throws {Error} The session refusal of `currentUser`.
 * @throws {ConvexError} "Only the account owner or an administrator may access
 *   license records."; "User not found."
 */
export const list = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    await authorize(ctx, userId);
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

/**
 * Opens a license copy.
 *
 * @param id - The copy.
 * @returns A URL to download it, or null when its stored file is gone.
 * @throws {ConvexError} "License copy not found."; as {@link list}.
 */
export const fileUrl = query({
  args: { id: v.id("certificationFiles") },
  handler: async (ctx, { id }) => {
    const file = await ctx.db.get(id);
    if (!file) throw new ConvexError("License copy not found.");
    await authorize(ctx, file.userId);
    return ctx.storage.getUrl(file.storageId);
  },
});

/**
 * Refuses an upload for {@link upload} before anything is stored.
 *
 * @param userId - The member.
 * @param kind - The certification the copy is for.
 * @throws {ConvexError} "Save this certification before attaching its
 *   license copy."
 * @throws As {@link list}; a ZodError for an unknown kind.
 */
export const checkUpload = internalQuery({
  args: target,
  handler: async (ctx, args) => {
    const { user } = await authorize(ctx, args.userId);
    const kind = certificationKindSchema.parse(args.kind);
    if (!holdsCertification(user, kind))
      throw new ConvexError(
        "Save this certification before attaching its license copy.",
      );
  },
});

/**
 * Files a stored copy, described by `name`, `type` and `size`, against the
 * member's certification; audits "user.license_copy_uploaded".
 *
 * @param storageId - The stored copy.
 * @returns The new copy's id.
 * @throws {ConvexError} As {@link checkUpload}, but "Certification is no
 *   longer selected."; the refusals of `validateCertificationFile`.
 */
export const finishUpload = internalMutation({
  args: {
    ...target,
    storageId: v.id("_storage"),
    name: v.string(),
    type: v.string(),
    size: v.number(),
  },
  handler: async (ctx, args) => {
    const { actor, user } = await authorize(ctx, args.userId);
    const kind = certificationKindSchema.parse(args.kind);
    if (!holdsCertification(user, kind))
      throw new ConvexError("Certification is no longer selected.");
    exposeRejections(() =>
      validateCertificationFile(args.name, args.type, args.size),
    );
    const id = await ctx.db.insert("certificationFiles", {
      ...args,
      kind,
      uploadedAt: Date.now(),
    });
    await audit(ctx, actor._id, "user.license_copy_uploaded", args.userId);
    return id;
  },
});

/**
 * Uploads a license copy for one of the member's saved certifications.
 *
 * @param userId - The member.
 * @param kind - The certification the copy is for.
 * @param name - The file name.
 * @param type - The file's MIME type.
 * @param bytes - The file.
 * @returns The new copy's id.
 * @throws {ConvexError} The refusals of `validateCertificationFile`, before
 *   any access check; as {@link checkUpload} and {@link finishUpload}.
 */
export const upload = action({
  args: { ...target, name: v.string(), type: v.string(), bytes: v.bytes() },
  handler: async (ctx, args): Promise<string> => {
    exposeRejections(() =>
      validateCertificationFile(args.name, args.type, args.bytes.byteLength),
    );
    await ctx.runQuery(internal.certifications.checkUpload, {
      userId: args.userId,
      kind: args.kind,
    });
    // The certification can be unselected between the check and filing; the
    // stored copy would then belong to nothing.
    return storeThenFinish(ctx, args, (storageId) =>
      ctx.runMutation(internal.certifications.finishUpload, {
        userId: args.userId,
        kind: args.kind,
        storageId,
        name: args.name,
        type: args.type,
        size: args.bytes.byteLength,
      }),
    );
  },
});

/**
 * Deletes a license copy and its stored file; audits
 * "user.license_copy_deleted".
 *
 * @param id - The copy.
 * @throws {ConvexError} "License copy not found."; as {@link list}.
 */
export const remove = mutation({
  args: { id: v.id("certificationFiles") },
  handler: async (ctx, { id }) => {
    const file = await ctx.db.get(id);
    if (!file) throw new ConvexError("License copy not found.");
    const { actor } = await authorize(ctx, file.userId);
    await ctx.storage.delete(file.storageId);
    await ctx.db.delete(id);
    await audit(ctx, actor._id, "user.license_copy_deleted", file.userId);
  },
});

async function authorize(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  const actor = await currentUser(ctx);
  if (actor._id !== userId && !actor.isAdmin)
    throw new ConvexError(
      "Only the account owner or an administrator may access license records.",
    );
  const user = await ctx.db.get(userId);
  if (!user) throw new ConvexError("User not found.");
  return { actor, user };
}

function holdsCertification(user: Doc<"users">, kind: string): boolean {
  return user.certifications?.some((c) => c.kind === kind) ?? false;
}
