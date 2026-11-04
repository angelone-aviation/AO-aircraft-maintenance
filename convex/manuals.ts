/**
 * Responsibility: Reference manuals stored as PDFs per aircraft: the upload
 *   handshake, opening them, editing their details, sweeping abandoned uploads.
 * Layer: Server. Public mutations, an action and a query, internal upload
 *   steps and an hourly sweep; maintenance permission writes, read opens.
 * Dependencies: convex/programContext, convex/access, convex/rateLimits,
 *   convex/storageReferences, src/domain/manuals, src/domain/model.
 *
 * The browser uploads the PDF straight to storage between beginUpload and
 * finishUpload, so a blob is bound to a ticket only when its bytes, size, type
 * and upload time match what the ticket declared.
 */
import { v } from "convex/values";
import {
  action,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { checkContext } from "./programContext";
import { audit } from "./access";
import { consume, DAY, HOUR } from "./rateLimits";
import { storageReferenced } from "./storageReferences";
import { can, type Snapshot } from "../src/domain/model";
import {
  manualInputSchema,
  manualEditSchema,
  manualApplicabilitySchema,
  validateManualFile,
  type ManualInput,
} from "../src/domain/manuals";

/** Upload tickets one user may take per hour. */
export const MANUAL_UPLOADS_PER_HOUR = 20;

/** How long an upload URL and its ticket stay valid. */
export const UPLOAD_TTL = HOUR;

/**
 * Age at which the sweep removes a ticket and the blobs uploaded for it but
 * never saved.
 */
export const UPLOAD_SWEEP_AGE = DAY;

// Base64 SHA-256, the format Convex records in `_storage.sha256`.
const SHA256 = /^[A-Za-z0-9+/]{43}=$/;
const PDF_MAGIC = "%PDF-";

// Bounds one sweep's work; the sweep runs hourly.
const SWEEP_TICKETS_PER_RUN = 50;
const SWEEP_BLOBS_PER_TICKET = 500;

const uploadArgs = {
  ticket: v.id("manualUploads"),
  storageId: v.id("_storage"),
  programUuid: v.optional(v.string()),
};

type BlobMetadata = {
  _creationTime: number;
  sha256: string;
  size: number;
  contentType?: string;
};

/**
 * Issues an upload ticket and a one-hour upload URL for a manual's PDF.
 *
 * @param payload - JSON of the manual's details, as `manualInputSchema`.
 * @param sha256 - The PDF's base64 SHA-256, which the stored blob must match.
 * @param programUuid - The caller's active Flight Program.
 * @returns The ticket and the URL to upload the PDF to.
 * @throws {Error} As `checkContext`; a ZodError for invalid details; "Choose a
 *   PDF up to 200 MB."; "Invalid file checksum."; "Maintenance access is
 *   required to upload a manual."
 * @throws {ConvexError} "Too many manual uploads. Wait an hour and try
 *   again." past {@link MANUAL_UPLOADS_PER_HOUR}.
 */
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

/**
 * Binds an uploaded blob to the caller's ticket: only one uploaded during the
 * ticket's lifetime, with exactly the declared bytes, size and type, that no
 * other record refers to. A blob that fails is never deleted here, since it
 * may belong to someone else; the sweep removes the ticket's own.
 *
 * @param ticket - The caller's unexpired ticket.
 * @param storageId - The uploaded blob.
 * @param programUuid - The caller's active Flight Program.
 * @throws {Error} "Upload expired. Please upload again."; "Maintenance access
 *   is required."; "Uploaded file does not match the PDF details."
 */
export const claimUpload = internalMutation({
  args: uploadArgs,
  handler: async (ctx, args) => {
    const { ticket, input } = await loadUploadTicket(ctx, args);
    if (ticket.storageId === args.storageId) return;
    const metadata = await ctx.db.system.get(args.storageId);
    if (
      ticket.storageId ||
      !metadata ||
      !matchesDeclaredUpload(metadata, ticket, input) ||
      (await storageReferenced(ctx, args.storageId, ticket._id))
    )
      throw new Error("Uploaded file does not match the PDF details.");
    await ctx.db.patch(ticket._id, { storageId: args.storageId });
  },
});

/**
 * Saves the manual whose blob {@link claimUpload} bound, ending the ticket,
 * and audits `manual.upload` with its details.
 *
 * @returns The new manual's uuid.
 * @throws {Error} The {@link claimUpload} ticket refusals, and "Upload
 *   expired. Please upload again." when this blob is not the claimed one.
 */
export const saveUpload = internalMutation({
  args: uploadArgs,
  handler: async (ctx, args) => {
    const { s, ticket, input } = await loadUploadTicket(ctx, args);
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

/**
 * Completes an upload: claims the blob, checks it starts as a PDF, and saves
 * the manual.
 *
 * @param ticket - From {@link beginUpload}.
 * @param storageId - What the upload URL returned.
 * @param programUuid - The caller's active Flight Program.
 * @returns The new manual's uuid.
 * @throws {Error} The {@link claimUpload} and {@link saveUpload} refusals;
 *   "Uploaded file is not a PDF.", leaving the claimed blob for the sweep.
 */
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
    if (head !== PDF_MAGIC) throw new Error("Uploaded file is not a PDF.");
    return await ctx.runMutation(internal.manuals.saveUpload, args);
  },
});

/**
 * Removes up to 50 tickets older than {@link UPLOAD_SWEEP_AGE}, with the
 * blobs uploaded for them that no record refers to: the one bound at claim,
 * and any with the declared bytes uploaded while the ticket was valid (the
 * browser stopped before finishUpload).
 */
export const cleanupUploads = internalMutation({
  args: {},
  handler: async (ctx) => {
    const stale = await ctx.db
      .query("manualUploads")
      .withIndex("createdAt", (q) =>
        q.lt("createdAt", Date.now() - UPLOAD_SWEEP_AGE),
      )
      .take(SWEEP_TICKETS_PER_RUN);
    for (const ticket of stale) {
      for (const id of await findTicketBlobs(ctx, ticket))
        await deleteBlobIfUnreferenced(ctx, id, ticket._id);
      await ctx.db.delete(ticket._id);
    }
  },
});

/**
 * Opens a manual the caller can read.
 *
 * @param uuid - The manual.
 * @param programUuid - The caller's active Flight Program.
 * @returns A URL to the stored PDF.
 * @throws {Error} As `checkContext`; "Manual is not available in this
 *   workspace."; "Manual file is unavailable."
 */
export const open = query({
  args: { uuid: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const s = await checkContext(ctx, args.programUuid);
    const manual = await findManual(ctx, args.uuid);
    if (!manual || !can(s, manual.aircraftUuid, "read"))
      throw new Error("Manual is not available in this workspace.");
    const url = await ctx.storage.getUrl(manual.storageId);
    if (!url) throw new Error("Manual file is unavailable.");
    return url;
  },
});

/**
 * Sets the aircraft or component model a manual applies to, and audits
 * `manual.applicability` before and after.
 *
 * @param uuid - The manual.
 * @param payload - JSON of the applicability, as `manualApplicabilitySchema`.
 * @param programUuid - The caller's active Flight Program.
 * @throws {Error} As `checkContext`; "Maintenance access is required."; a
 *   ZodError for an invalid applicability.
 */
export const setApplicability = mutation({
  args: {
    uuid: v.string(),
    payload: v.string(),
    programUuid: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const s = await checkContext(ctx, args.programUuid);
    const manual = await loadMaintainedManual(ctx, s, args.uuid);
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

/**
 * Renames a manual, keeping its PDF and references, and audits
 * `manual.rename` before and after.
 *
 * @param uuid - The manual.
 * @param title - The new title; trimmed, 1 to 300 characters.
 * @param programUuid - The caller's active Flight Program.
 * @throws {Error} As `checkContext`; "Maintenance access is required."; a
 *   ZodError for an invalid title.
 */
export const rename = mutation({
  args: {
    uuid: v.string(),
    title: v.string(),
    programUuid: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const s = await checkContext(ctx, args.programUuid);
    const manual = await loadMaintainedManual(ctx, s, args.uuid);
    const title = manualInputSchema.shape.title.parse(args.title);
    await ctx.db.patch(manual._id, { title });
    await audit(ctx, s.user.id, "manual.rename", manual.uuid, {
      aircraftUuid: manual.aircraftUuid,
      before: { title: manual.title },
      after: { title },
    });
  },
});

/**
 * Edits a manual's details, keeping its PDF; it may move to another aircraft
 * of the same Flight Program. Audits `manual.edit` before and after.
 *
 * @param uuid - The manual.
 * @param payload - JSON of the details, as `manualEditSchema`; leaving out
 *   applicability clears it.
 * @param programUuid - The caller's active Flight Program.
 * @throws {Error} As `checkContext`; "Maintenance access is required."; a
 *   ZodError for invalid details; "Choose an aircraft in the same Flight
 *   Program with maintenance access."
 */
export const edit = mutation({
  args: {
    uuid: v.string(),
    payload: v.string(),
    programUuid: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const s = await checkContext(ctx, args.programUuid);
    const manual = await loadMaintainedManual(ctx, s, args.uuid);
    const input = manualEditSchema.parse(JSON.parse(args.payload));
    assertSameProgramAircraft(s, manual.aircraftUuid, input.aircraftUuid);
    // Naming applicability even when absent clears it: patch removes a field
    // set to undefined.
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

async function loadUploadTicket(
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

function matchesDeclaredUpload(
  metadata: BlobMetadata,
  ticket: Doc<"manualUploads">,
  input: ManualInput,
): boolean {
  return (
    !!ticket.sha256 &&
    metadata._creationTime >= ticket.createdAt &&
    metadata._creationTime <= ticket.createdAt + UPLOAD_TTL &&
    metadata.sha256 === ticket.sha256 &&
    metadata.size === input.size &&
    metadata.contentType === "application/pdf"
  );
}

async function findTicketBlobs(
  ctx: MutationCtx,
  ticket: Doc<"manualUploads">,
): Promise<Set<Id<"_storage">>> {
  const blobs = new Set<Id<"_storage">>();
  if (ticket.storageId) blobs.add(ticket.storageId);
  if (!ticket.sha256) return blobs;
  const uploaded = await ctx.db.system
    .query("_storage")
    .withIndex("by_creation_time", (q) =>
      q
        .gte("_creationTime", ticket.createdAt)
        .lte("_creationTime", ticket.createdAt + UPLOAD_TTL),
    )
    .take(SWEEP_BLOBS_PER_TICKET);
  for (const blob of uploaded)
    if (blob.sha256 === ticket.sha256) blobs.add(blob._id);
  return blobs;
}

async function deleteBlobIfUnreferenced(
  ctx: MutationCtx,
  id: Id<"_storage">,
  ticketId: Id<"manualUploads">,
): Promise<void> {
  if (!(await ctx.db.system.get(id))) return;
  if (await storageReferenced(ctx, id, ticketId)) return;
  await ctx.storage.delete(id);
}

function findManual(ctx: QueryCtx, uuid: string) {
  return ctx.db
    .query("manuals")
    .withIndex("uuid", (q) => q.eq("uuid", uuid))
    .unique();
}

async function loadMaintainedManual(
  ctx: MutationCtx,
  s: Snapshot,
  uuid: string,
): Promise<Doc<"manuals">> {
  const manual = await findManual(ctx, uuid);
  if (!manual || !can(s, manual.aircraftUuid, "maintenance"))
    throw new Error("Maintenance access is required.");
  return manual;
}

function assertSameProgramAircraft(
  s: Snapshot,
  fromUuid: string,
  toUuid: string,
): void {
  const source = s.aircraft.find((a) => a.uuid === fromUuid);
  const target = s.aircraft.find((a) => a.uuid === toUuid);
  if (
    !target ||
    !source ||
    target.programUuid !== source.programUuid ||
    !can(s, target.uuid, "maintenance")
  )
    throw new Error(
      "Choose an aircraft in the same Flight Program with maintenance access.",
    );
}
