import { v } from "convex/values";
import {
  action,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { checkContext } from "./programContext";
import { audit } from "./access";
import { consume, DAY, HOUR } from "./rateLimits";
import { storageReferenced } from "./storageReferences";
import { can } from "../src/domain/model";
import {
  manualInputSchema,
  manualEditSchema,
  manualApplicabilitySchema,
  validateManualFile,
} from "../src/domain/manuals";
export const MANUAL_UPLOADS_PER_HOUR = 20;
// Base64 SHA-256, the format Convex records in `_storage.sha256`.
const SHA256 = /^[A-Za-z0-9+/]{43}=$/;
export const beginUpload = mutation({
  args: {
    payload: v.string(),
    sha256: v.string(),
    programUuid: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const s = await checkContext(ctx, args.programUuid);
    const input = manualInputSchema.parse(JSON.parse(args.payload));
    validateManualFile({
      name: input.filename,
      type: "application/pdf",
      size: input.size,
    });
    if (!SHA256.test(args.sha256)) throw new Error("Invalid file checksum.");
    if (!can(s, input.aircraftUuid, "maintenance"))
      throw new Error("Maintenance access is required to upload a manual.");
    await consume(
      ctx,
      `manual:upload:user:${s.user.id}`,
      MANUAL_UPLOADS_PER_HOUR,
      HOUR,
      "Too many manual uploads. Wait an hour and try again.",
    );
    const ticket = await ctx.db.insert("manualUploads", {
      payload: JSON.stringify(input),
      userId: s.user.id,
      createdAt: Date.now(),
      sha256: args.sha256,
    });
    return { ticket, url: await ctx.storage.generateUploadUrl() };
  },
});
// Upload URLs and tickets live for one hour. Tickets, and the blobs uploaded
// for them but never saved, are swept a day after issue (see cleanupUploads).
export const UPLOAD_TTL = 3600000;
export const UPLOAD_SWEEP_AGE = DAY;
const uploadArgs = {
  ticket: v.id("manualUploads"),
  storageId: v.id("_storage"),
  programUuid: v.optional(v.string()),
};
async function uploadTicket(
  ctx: MutationCtx,
  args: { ticket: Id<"manualUploads">; programUuid?: string },
) {
  const s = await checkContext(ctx, args.programUuid);
  const ticket = await ctx.db.get(args.ticket);
  if (
    !ticket ||
    ticket.userId !== s.user.id ||
    Date.now() - ticket.createdAt > UPLOAD_TTL
  )
    throw new Error("Upload expired. Please upload again.");
  const input = manualInputSchema.parse(JSON.parse(ticket.payload));
  if (!can(s, input.aircraftUuid, "maintenance"))
    throw new Error("Maintenance access is required.");
  return { s, ticket, input };
}
// Binds the blob to the ticket only when it is the upload this ticket asked
// for: uploaded during the ticket's lifetime, with exactly the declared bytes
// (SHA-256), size and type, and not referenced by any other record. A blob
// that fails is never deleted here; it may belong to someone else. Blobs that
// were uploaded for a ticket but never saved are removed by cleanupUploads.
export const claimUpload = internalMutation({
  args: uploadArgs,
  handler: async (ctx, args) => {
    const { ticket, input } = await uploadTicket(ctx, args);
    if (ticket.storageId === args.storageId) return;
    const metadata = await ctx.db.system.get(args.storageId);
    if (
      ticket.storageId ||
      !ticket.sha256 ||
      !metadata ||
      metadata._creationTime < ticket.createdAt ||
      metadata._creationTime > ticket.createdAt + UPLOAD_TTL ||
      metadata.sha256 !== ticket.sha256 ||
      metadata.size !== input.size ||
      metadata.contentType !== "application/pdf" ||
      (await storageReferenced(ctx, args.storageId, ticket._id))
    )
      throw new Error("Uploaded file does not match the PDF details.");
    await ctx.db.patch(ticket._id, { storageId: args.storageId });
  },
});
export const saveUpload = internalMutation({
  args: uploadArgs,
  handler: async (ctx, args) => {
    const { s, ticket, input } = await uploadTicket(ctx, args);
    if (ticket.storageId !== args.storageId)
      throw new Error("Upload expired. Please upload again.");
    const uuid = crypto.randomUUID();
    await ctx.db.insert("manuals", {
      ...input,
      uuid,
      storageId: args.storageId,
      uploadedAt: Date.now(),
      uploadedBy: s.user.id,
    });
    await ctx.db.delete(args.ticket);
    await audit(ctx, s.user.id, "manual.upload", uuid, {
      aircraftUuid: input.aircraftUuid,
      after: input,
    });
    return uuid;
  },
});
const PDF_MAGIC = "%PDF-";
export const finishUpload = action({
  args: uploadArgs,
  handler: async (ctx, args): Promise<string> => {
    await ctx.runMutation(internal.manuals.claimUpload, args);
    const blob = await ctx.storage.get(args.storageId);
    const head = blob
      ? new TextDecoder().decode(
          await blob.slice(0, PDF_MAGIC.length).arrayBuffer(),
        )
      : "";
    // The claimed blob stays bound to the ticket; the sweep removes it.
    if (head !== PDF_MAGIC) throw new Error("Uploaded file is not a PDF.");
    return await ctx.runMutation(internal.manuals.saveUpload, args);
  },
});
// Removes tickets a day after issue, with the blobs uploaded for them that no
// record refers to: the blob bound at claim, and any blob with the declared
// bytes uploaded while the ticket was valid (the browser stopped before
// finishUpload). Blobs referenced anywhere in the schema are kept.
export const cleanupUploads = internalMutation({
  args: {},
  handler: async (ctx) => {
    const stale = await ctx.db
      .query("manualUploads")
      .withIndex("createdAt", (q) =>
        q.lt("createdAt", Date.now() - UPLOAD_SWEEP_AGE),
      )
      .take(50);
    for (const ticket of stale) {
      const candidates = new Set<Id<"_storage">>();
      if (ticket.storageId) candidates.add(ticket.storageId);
      if (ticket.sha256) {
        const uploaded = await ctx.db.system
          .query("_storage")
          .withIndex("by_creation_time", (q) =>
            q
              .gte("_creationTime", ticket.createdAt)
              .lte("_creationTime", ticket.createdAt + UPLOAD_TTL),
          )
          .take(500);
        for (const blob of uploaded)
          if (blob.sha256 === ticket.sha256) candidates.add(blob._id);
      }
      for (const id of candidates)
        if (
          (await ctx.db.system.get(id)) &&
          !(await storageReferenced(ctx, id, ticket._id))
        )
          await ctx.storage.delete(id);
      await ctx.db.delete(ticket._id);
    }
  },
});
export const open = query({
  args: { uuid: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const s = await checkContext(ctx, args.programUuid);
    const manual = await ctx.db
      .query("manuals")
      .withIndex("uuid", (q) => q.eq("uuid", args.uuid))
      .unique();
    if (!manual || !can(s, manual.aircraftUuid, "read"))
      throw new Error("Manual is not available in this workspace.");
    const url = await ctx.storage.getUrl(manual.storageId);
    if (!url) throw new Error("Manual file is unavailable.");
    return url;
  },
});

export const setApplicability = mutation({
  args: {
    uuid: v.string(),
    payload: v.string(),
    programUuid: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const s = await checkContext(ctx, args.programUuid);
    const manual = await ctx.db
      .query("manuals")
      .withIndex("uuid", (q) => q.eq("uuid", args.uuid))
      .unique();
    if (!manual || !can(s, manual.aircraftUuid, "maintenance"))
      throw new Error("Maintenance access is required.");
    const applicability = manualApplicabilitySchema.parse(
      JSON.parse(args.payload),
    );
    await ctx.db.patch(manual._id, { applicability });
    await audit(ctx, s.user.id, "manual.applicability", manual.uuid, {
      aircraftUuid: manual.aircraftUuid,
      before: manual.applicability,
      after: applicability,
    });
  },
});

export const rename = mutation({
  args: {
    uuid: v.string(),
    title: v.string(),
    programUuid: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const s = await checkContext(ctx, args.programUuid);
    const manual = await ctx.db
      .query("manuals")
      .withIndex("uuid", (q) => q.eq("uuid", args.uuid))
      .unique();
    if (!manual || !can(s, manual.aircraftUuid, "maintenance"))
      throw new Error("Maintenance access is required.");
    const title = manualInputSchema.shape.title.parse(args.title);
    await ctx.db.patch(manual._id, { title });
    await audit(ctx, s.user.id, "manual.rename", manual.uuid, {
      aircraftUuid: manual.aircraftUuid,
      before: { title: manual.title },
      after: { title },
    });
  },
});

export const edit = mutation({
  args: {
    uuid: v.string(),
    payload: v.string(),
    programUuid: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const s = await checkContext(ctx, args.programUuid);
    const manual = await ctx.db
      .query("manuals")
      .withIndex("uuid", (q) => q.eq("uuid", args.uuid))
      .unique();
    if (!manual || !can(s, manual.aircraftUuid, "maintenance"))
      throw new Error("Maintenance access is required.");
    const input = manualEditSchema.parse(JSON.parse(args.payload));
    const source = s.aircraft.find((a) => a.uuid === manual.aircraftUuid);
    const target = s.aircraft.find((a) => a.uuid === input.aircraftUuid);
    if (
      !target ||
      !source ||
      target.programUuid !== source.programUuid ||
      !can(s, target.uuid, "maintenance")
    )
      throw new Error(
        "Choose an aircraft in the same Flight Program with maintenance access.",
      );
    await ctx.db.patch(manual._id, {
      ...input,
      applicability: input.applicability,
    });
    await audit(ctx, s.user.id, "manual.edit", manual.uuid, {
      aircraftUuid: manual.aircraftUuid,
      before: {
        title: manual.title,
        documentNumber: manual.documentNumber,
        revision: manual.revision,
        revisionDate: manual.revisionDate,
        aircraftUuid: manual.aircraftUuid,
        applicability: manual.applicability,
      },
      after: input,
    });
  },
});
