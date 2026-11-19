/**
 * Responsibility: Documents on the aircraft record (Form 337 copies and
 *   logbook page photos): listing them for the snapshot, uploading and
 *   archiving them.
 * Layer: Server. A public action and mutation, internal steps, and the
 *   snapshot loader; maintenance permission writes, or flight permission for
 *   a flight's logbook line photo.
 * Dependencies: convex/programContext, convex/access, convex/attachments,
 *   convex/userErrors, src/domain/aircraftFiles, src/domain/model,
 *   src/domain/inventoryAttachments, convex/values.
 *
 * Form 337 copies are permanent status records (14 CFR 91.417(a)(2)(vi);
 * ADR-0004) and a logbook page photo points at the signed paper record, so
 * there is no delete path: archiving hides a copy from the current list and
 * keeps its stored file.
 */
import { ConvexError, v } from "convex/values";
import {
  action,
  mutation,
  internalQuery,
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { checkContext } from "./programContext";
import { audit } from "./access";
import { storeThenFinish } from "./attachments";
import { exposeRejections } from "./userErrors";
import { can, type Snapshot } from "../src/domain/model";
import { assertFileContents } from "../src/domain/inventoryAttachments";
import {
  aircraftFileArchive,
  assertAircraftFileLink,
  assertAircraftFileRoom,
  assertAircraftFileWriter,
  MAX_CURRENT_AIRCRAFT_FILES,
  validateAircraftUpload,
  type AircraftFile,
  type AircraftFileCategory,
  type AircraftFileLink,
} from "../src/domain/aircraftFiles";

const category = v.union(v.literal("form-337"), v.literal("logbook-page"));
const linkedKind = v.union(v.literal("flight"), v.literal("work-order"));
const target = {
  aircraftUuid: v.string(),
  programUuid: v.optional(v.string()),
  category,
  linkedKind: v.optional(linkedKind),
  linkedUuid: v.optional(v.string()),
};

/** The document being written: its aircraft, category and link. */
type Target = {
  aircraftUuid: string;
  programUuid?: string;
  category: AircraftFileCategory;
} & Partial<AircraftFileLink>;

/**
 * Lists the files of every aircraft the snapshot's reader can read, archived
 * ones included; screens and owner views show current copies by default.
 *
 * @param ctx - Query context.
 * @param s - The reader's scoped snapshot.
 * @returns Each file with a storage URL, or "" when the blob is missing.
 */
export async function aircraftFileList(
  ctx: QueryCtx,
  s: Snapshot,
): Promise<AircraftFile[]> {
  const readable = s.aircraft.filter((a) => can(s, a.uuid, "read"));
  const lists = await Promise.all(
    readable.map(async (a) => {
      const files = await ctx.db
        .query("aircraftFiles")
        .withIndex("aircraft", (q) => q.eq("aircraftUuid", a.uuid))
        .collect();
      return Promise.all(files.map((f) => toAircraftFile(ctx, f)));
    }),
  );
  return lists.flat();
}

/**
 * Refuses an upload before its file is stored, unless the caller may write
 * the document and its linked record is on the aircraft.
 *
 * @param aircraftUuid - The aircraft.
 * @param programUuid - The caller's active Flight Program.
 * @param category - "form-337" or "logbook-page".
 * @param linkedKind - For a photo, "flight" or "work-order".
 * @param linkedUuid - For a photo, the linked record's uuid.
 * @throws {ConvexError} "Link the photo to a flight or work order."; "A Form
 *   337 copy is not linked to a record."; "Aircraft flight permission
 *   required." or "Aircraft maintenance permission required."; "Flight not
 *   found." or "Work order not found." when the linked record is not on the
 *   aircraft.
 * @throws As `checkContext`, first.
 */
export const checkUpload = internalQuery({
  args: target,
  handler: async (ctx, args) => {
    await authorizeFileWriter(ctx, args);
  },
});

/**
 * Records a stored upload on the aircraft and audits
 * `aircraft.file_uploaded` with its category, link, name, type and size.
 *
 * @param storageId - The stored file; the caller deletes it on a refusal.
 * @param size - Its size; the other arguments are {@link upload}'s.
 * @throws {ConvexError} The {@link checkUpload} refusals; the file refusals;
 *   "This aircraft already has the maximum of 200 current Form 337 copies."
 *   or "... of 500 current logbook page photos." for the upload's category.
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
    const owner = await authorizeFileWriter(ctx, args);
    await exposeRejections(async () => {
      validateAircraftUpload(args.category, args.name, args.type, args.size);
      assertAircraftFileRoom(
        args.category,
        await countCurrentFiles(ctx, args.aircraftUuid, args.category),
      );
    });
    const { programUuid: _program, ...fields } = args;
    await ctx.db.insert("aircraftFiles", { ...fields, uploadedAt: Date.now() });
    await audit(
      ctx,
      owner.user.id,
      "aircraft.file_uploaded",
      args.aircraftUuid,
      {
        programUuid: owner.programUuid,
        aircraftUuid: args.aircraftUuid,
        after: {
          category: args.category,
          linkedKind: args.linkedKind,
          linkedUuid: args.linkedUuid,
          name: args.name,
          type: args.type,
          size: args.size,
        },
      },
    );
  },
});

/**
 * Uploads a Form 337 copy, or a logbook page photo of a flight's line or a
 * work order's signed page, to an aircraft's record.
 *
 * @param aircraftUuid - The aircraft.
 * @param programUuid - The caller's active Flight Program.
 * @param category - "form-337" or "logbook-page".
 * @param linkedKind - For a photo, "flight" or "work-order".
 * @param linkedUuid - For a photo, the linked record's uuid.
 * @param name - The file name; its extension must match `type`.
 * @param type - PDF, JPEG, PNG or WebP.
 * @param bytes - The file, at most 7 MB.
 * @throws {ConvexError} "Choose a PDF, JPEG, PNG or WebP file.",
 *   "Attachments must be between 1 byte and 7 MB." or, for a photo, the HEIC
 *   refusal, checked first; then "This file's contents do not match its
 *   type. Choose a PDF, JPEG, PNG or WebP file." when the first bytes are
 *   not the declared type's; the {@link finishUpload} refusals, after which
 *   the stored file is deleted.
 */
export const upload = action({
  args: {
    ...target,
    name: v.string(),
    type: v.string(),
    bytes: v.bytes(),
  },
  handler: async (ctx, args): Promise<void> => {
    exposeRejections(() => {
      validateAircraftUpload(
        args.category,
        args.name,
        args.type,
        args.bytes.byteLength,
      );
      assertFileContents(args.type, args.bytes);
    });
    const { name, type, bytes, ...scope } = args;
    await ctx.runQuery(internal.aircraftFiles.checkUpload, scope);
    await storeThenFinish(ctx, args, (storageId) =>
      ctx.runMutation(internal.aircraftFiles.finishUpload, {
        ...scope,
        storageId,
        name,
        type,
        size: bytes.byteLength,
      }),
    );
  },
});

/**
 * Archives a current copy with a reason, keeping its row and stored file, and
 * audits `aircraft.file_archived` with the copy before and after.
 *
 * @param id - The file.
 * @param reason - Why it is archived; trimmed, 1 to 500 characters.
 * @param programUuid - The caller's active Flight Program.
 * @throws {ConvexError} "Document not found.", checked first; the
 *   {@link checkUpload} refusals; "This copy is already archived."; "Enter a
 *   reason for archiving this copy."; "Keep the reason for archiving to 500
 *   characters."
 */
export const archive = mutation({
  args: {
    id: v.id("aircraftFiles"),
    reason: v.string(),
    programUuid: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const file = await ctx.db.get(args.id);
    if (!file) throw new ConvexError("Document not found.");
    const owner = await authorizeFileWriter(ctx, {
      aircraftUuid: file.aircraftUuid,
      programUuid: args.programUuid,
      category: file.category,
      linkedKind: file.linkedKind,
      linkedUuid: file.linkedUuid,
    });
    const archived = exposeRejections(() =>
      aircraftFileArchive(file, owner.user, args.reason, Date.now()),
    );
    await ctx.db.patch(file._id, archived);
    const { category, linkedKind, linkedUuid, name, type, size } = file;
    await audit(
      ctx,
      owner.user.id,
      "aircraft.file_archived",
      file.aircraftUuid,
      {
        programUuid: owner.programUuid,
        aircraftUuid: file.aircraftUuid,
        reason: archived.archiveReason,
        before: {
          category,
          linkedKind,
          linkedUuid,
          name,
          type,
          size,
          uploadedAt: file.uploadedAt,
        },
        after: { category, linkedKind, linkedUuid, name, ...archived },
      },
    );
  },
});

async function authorizeFileWriter(ctx: QueryCtx | MutationCtx, args: Target) {
  const state = await checkContext(ctx, args.programUuid);
  exposeRejections(() => {
    assertAircraftFileLink(args.category, args);
    assertAircraftFileWriter(state, args.aircraftUuid, args.linkedKind);
  });
  if (args.linkedKind && args.linkedUuid)
    await assertLinkedRecord(ctx, args.aircraftUuid, {
      linkedKind: args.linkedKind,
      linkedUuid: args.linkedUuid,
    });
  const programUuid = state.aircraft.find(
    (a) => a.uuid === args.aircraftUuid,
  )?.programUuid;
  return { user: state.user, programUuid };
}

// The linked record must be on the same aircraft, already checked to be in
// the caller's program: a photo cannot be filed against another program's
// flight, and a queued flight is unknown here until it has synced.
async function assertLinkedRecord(
  ctx: QueryCtx | MutationCtx,
  aircraftUuid: string,
  link: AircraftFileLink,
) {
  const table = link.linkedKind === "flight" ? "flights" : "workOrders";
  const record = await ctx.db
    .query(table)
    .withIndex("uuid", (q) => q.eq("uuid", link.linkedUuid))
    .first();
  if (record?.aircraftUuid !== aircraftUuid)
    throw new ConvexError(
      link.linkedKind === "flight"
        ? "Flight not found."
        : "Work order not found.",
    );
}

// Reads at most the category's cap, so the check stays cheap on a full
// aircraft.
async function countCurrentFiles(
  ctx: MutationCtx,
  aircraftUuid: string,
  category: AircraftFileCategory,
): Promise<number> {
  const current = await ctx.db
    .query("aircraftFiles")
    .withIndex("aircraft", (q) => q.eq("aircraftUuid", aircraftUuid))
    .filter((q) =>
      q.and(
        q.eq(q.field("category"), category),
        q.eq(q.field("archivedAt"), undefined),
      ),
    )
    .take(MAX_CURRENT_AIRCRAFT_FILES[category]);
  return current.length;
}

async function toAircraftFile(
  ctx: QueryCtx,
  f: Doc<"aircraftFiles">,
): Promise<AircraftFile> {
  return {
    uuid: f._id,
    aircraftUuid: f.aircraftUuid,
    category: f.category,
    linkedKind: f.linkedKind,
    linkedUuid: f.linkedUuid,
    name: f.name,
    type: f.type,
    size: f.size,
    uploadedAt: f.uploadedAt,
    archivedAt: f.archivedAt,
    archivedBy: f.archivedBy,
    archiveReason: f.archiveReason,
    url: (await ctx.storage.getUrl(f.storageId)) ?? "",
  };
}
