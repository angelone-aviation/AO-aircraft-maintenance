/**
 * Responsibility: A member's certifications and the license copies filed for
 *   them: saving, approving, listing, opening, uploading and deleting.
 * Layer: Server. Public functions for the member themself or a system
 *   administrator, and approval for the administrators who may give it;
 *   every change is audited against the member.
 * Dependencies: convex/access, convex/attachments, convex/memberships,
 *   convex/programContext, convex/userErrors, src/domain (certifications,
 *   certificateApproval, inventoryAttachments).
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
import { currentUser, audit, member } from "./access";
import { storeThenFinish } from "./attachments";
import { programUsers } from "./memberships";
import { checkContext } from "./programContext";
import { exposeRejections } from "./userErrors";
import {
  certificationSchema,
  certificationsSchema,
  certificationKindSchema,
  memberLicense,
  validateCertificationFile,
  LICENSE_COPY_TYPES,
  type Certification,
} from "../src/domain/certifications";
import {
  approveCertification,
  CERTIFICATE_APPROVERS_ONLY,
  certificatesAwaitingApproval,
  certificationChanges,
  fileCertifications,
  mayApproveCertificates,
} from "../src/domain/certificateApproval";
import { assertFileContents } from "../src/domain/inventoryAttachments";

const target = { userId: v.id("users"), kind: v.string() };

/**
 * Replaces a member's certifications and the license fields derived from
 * them, as {@link recordCertifications} files them: a new or changed
 * certificate waits for approval.
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
    const { actor, user } = await authorize(ctx, args.userId);
    const submitted = exposeRejections(() =>
      certificationsSchema.parse(JSON.parse(args.payload)),
    );
    await recordCertifications(ctx, actor._id, user, submitted);
  },
});

/**
 * Approves one of a member's pending certificates, exactly as the approver
 * reviewed it, so it prints on entries and counts for the inspection
 * signoff; audits "user.certification_approved" with the certificate before
 * and after.
 *
 * @param userId - The holder.
 * @param programUuid - The approver's active Flight Program; none for a
 *   system administrator working in no program.
 * @param certificate - JSON, the certificate as the approver reviewed it.
 * @throws {ConvexError} As `checkContext`; "User not found.";
 *   `CERTIFICATE_APPROVERS_ONLY` for anyone else, the holder included;
 *   "This certificate is not waiting for approval."; "This certificate
 *   changed since you opened it. Review it again."
 */
export const approve = mutation({
  args: {
    userId: v.id("users"),
    programUuid: v.optional(v.string()),
    certificate: v.string(),
  },
  handler: async (ctx, args) => {
    const state = await checkContext(ctx, args.programUuid);
    const holder = await ctx.db.get(args.userId);
    if (!holder) throw new ConvexError("User not found.");
    const owner = member(holder);
    if (!mayApproveCertificates(state, owner))
      throw new ConvexError(CERTIFICATE_APPROVERS_ONLY);
    const reviewed = exposeRejections(() =>
      certificationSchema.parse(JSON.parse(args.certificate)),
    );
    const before = owner.certifications ?? [];
    const certifications = exposeRejections(() =>
      approveCertification(before, reviewed),
    );
    await ctx.db.patch(holder._id, {
      certifications,
      ...memberLicense({ certifications }),
    });
    const ofKind = (list: Certification[]) =>
      list.find((c) => c.kind === reviewed.kind);
    await audit(ctx, state.user.id, "user.certification_approved", holder._id, {
      before: ofKind(before),
      after: ofKind(certifications),
    });
  },
});

/**
 * The certificates waiting for the caller to approve them: any member's for
 * a system administrator, the active program's members' for its Flight
 * Program administrators, never the caller's own.
 *
 * @param programUuid - The caller's active Flight Program.
 * @returns Each pending certificate with its holder's id and name, in no
 *   particular order of members; none for anyone who may approve nothing.
 * @throws As `checkContext`.
 */
export const awaitingApproval = query({
  args: { programUuid: v.optional(v.string()) },
  handler: async (ctx, { programUuid }) => {
    const state = await checkContext(ctx, programUuid);
    const users = state.user.isAdmin
      ? await ctx.db.query("users").collect()
      : await programUsers(ctx, programUuid);
    return certificatesAwaitingApproval(
      state,
      users.filter((u) => u.certifications?.some((c) => c.pending)).map(member),
    );
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
 * @throws {Error} The session refusal of `currentUser`, first.
 * @throws {ConvexError} "License copy not found.", also for another
 *   member's copy unless the caller is a system administrator.
 */
export const fileUrl = query({
  args: { id: v.id("certificationFiles") },
  handler: async (ctx, { id }) => {
    const { file } = await readableCopy(ctx, id);
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
 * @throws {ConvexError} The refusals of `validateCertificationFile`, then
 *   "This file's contents do not match its type. Choose a PDF, JPEG, PNG,
 *   WebP, HEIC or HEIF file." when the first bytes are not the declared
 *   type's, both before any access check and storing nothing; as
 *   {@link checkUpload} and {@link finishUpload}.
 */
export const upload = action({
  args: { ...target, name: v.string(), type: v.string(), bytes: v.bytes() },
  handler: async (ctx, args): Promise<string> => {
    exposeRejections(() => {
      validateCertificationFile(args.name, args.type, args.bytes.byteLength);
      assertFileContents(args.type, args.bytes, LICENSE_COPY_TYPES);
    });
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
 * @throws {Error} The session refusal of `currentUser`, first.
 * @throws {ConvexError} "License copy not found.", also for another
 *   member's copy unless the caller is a system administrator.
 */
export const remove = mutation({
  args: { id: v.id("certificationFiles") },
  handler: async (ctx, { id }) => {
    const { actor, file } = await readableCopy(ctx, id);
    await ctx.storage.delete(file.storageId);
    await ctx.db.delete(id);
    await audit(ctx, actor._id, "user.license_copy_deleted", file.userId);
  },
});

/**
 * Stores a member's certifications as filed (`fileCertifications`: a new or
 * changed certificate waits for approval) with the license fields derived
 * from them, and writes one change-log entry per certificate filed, edited
 * or removed, with the certificate before and after.
 *
 * @param actorId - Who saved them.
 * @param user - The member, as stored before the save.
 * @param submitted - The certifications as saved.
 */
export async function recordCertifications(
  ctx: MutationCtx,
  actorId: string,
  user: Doc<"users">,
  submitted: Certification[],
): Promise<void> {
  const before = member(user).certifications;
  const certifications = fileCertifications(before, submitted);
  await ctx.db.patch(user._id, {
    certifications,
    ...memberLicense({ certifications }),
  });
  for (const change of certificationChanges(before, certifications))
    await audit(ctx, actorId, change.action, user._id, {
      before: change.before,
      after: change.after,
    });
}

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

// The session comes first, and another member's copy is refused as a missing
// one, so an id never tells that the copy exists (security review T4).
async function readableCopy(
  ctx: QueryCtx | MutationCtx,
  id: Id<"certificationFiles">,
) {
  const actor = await currentUser(ctx);
  const file = await ctx.db.get(id);
  if (!file || (file.userId !== actor._id && !actor.isAdmin))
    throw new ConvexError("License copy not found.");
  return { actor, file };
}

function holdsCertification(user: Doc<"users">, kind: string): boolean {
  return user.certifications?.some((c) => c.kind === kind) ?? false;
}
