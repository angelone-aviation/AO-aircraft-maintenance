/**
 * Responsibility: Form 337 copies kept on the aircraft record: listing them
 *   for the snapshot, uploading and archiving them.
 * Layer: Server. A public action and mutation, internal steps, and the
 *   snapshot loader; maintenance permission writes.
 * Dependencies: convex/programContext, convex/access, src/domain/aircraftFiles,
 *   src/domain/model, convex/values.
 *
 * Form 337 copies are permanent status records (14 CFR 91.417(a)(2)(vi);
 * ADR-0004), so there is no delete path: archiving hides a copy from the
 * current list and keeps its stored file.
 */
import { v } from "convex/values";
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
import { can, type Snapshot } from "../src/domain/model";
import {
  aircraftFileArchive,
  assertAircraftFileRoom,
  assertAircraftFileWriter,
  MAX_AIRCRAFT_FILES,
  validateAircraftFile,
  type AircraftFile,
} from "../src/domain/aircraftFiles";

const category = v.literal("form-337");
const target = {
  aircraftUuid: v.string(),
  programUuid: v.optional(v.string()),
};

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
 * Refuses an upload before its file is stored, unless the caller has
 * maintenance permission on the aircraft.
 *
 * @param aircraftUuid - The aircraft.
 * @param programUuid - The caller's active Flight Program.
 * @throws {Error} As `checkContext`; "Aircraft maintenance permission
 *   required."
 */
export const checkUpload = internalQuery({
  args: target,
  handler: async (ctx, args) => {
    await authorizeFileWriter(ctx, args);
  },
});

/**
 * Records a stored upload on the aircraft and audits
 * `aircraft.file_uploaded` with its category, name, type and size.
 *
 * @param storageId - The stored file; the caller deletes it on a refusal.
 * @param size - Its size; the other arguments are {@link upload}'s.
 * @throws {Error} The {@link checkUpload} refusals; the file refusals; "This
 *   aircraft already has the maximum of 200 current documents."
 */
export const finishUpload = internalMutation({
  args: {
    ...target,
    category,
    storageId: v.id("_storage"),
    name: v.string(),
    type: v.string(),
    size: v.number(),
  },
  handler: async (ctx, args) => {
    const owner = await authorizeFileWriter(ctx, args);
    validateAircraftFile(args.name, args.type, args.size);
    assertAircraftFileRoom(await countCurrentFiles(ctx, args.aircraftUuid));
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
          name: args.name,
          type: args.type,
          size: args.size,
        },
      },
    );
  },
});

/**
 * Uploads a Form 337 copy to an aircraft's record.
 *
 * @param aircraftUuid - The aircraft.
 * @param programUuid - The caller's active Flight Program.
 * @param category - "form-337".
 * @param name - The file name; its extension must match `type`.
 * @param type - PDF, JPEG, PNG or WebP.
 * @param bytes - The file, at most 7 MB.
 * @throws {Error} "Choose a PDF, JPEG, PNG or WebP file." or "Attachments must
 *   be between 1 byte and 7 MB.", checked first; the {@link finishUpload}
 *   refusals, after which the stored file is deleted.
 */
export const upload = action({
  args: {
    ...target,
    category,
    name: v.string(),
    type: v.string(),
    bytes: v.bytes(),
  },
  handler: async (ctx, args): Promise<void> => {
    validateAircraftFile(args.name, args.type, args.bytes.byteLength);
    const scope = {
      aircraftUuid: args.aircraftUuid,
      programUuid: args.programUuid,
    };
    await ctx.runQuery(internal.aircraftFiles.checkUpload, scope);
    const storageId = await ctx.storage.store(
      new Blob([args.bytes], { type: args.type }),
    );
    try {
      await ctx.runMutation(internal.aircraftFiles.finishUpload, {
        ...scope,
        category: args.category,
        storageId,
        name: args.name,
        type: args.type,
        size: args.bytes.byteLength,
      });
    } catch (error) {
      // File storage is outside the mutation's transaction.
      await ctx.storage.delete(storageId);
      throw error;
    }
  },
});

/**
 * Archives a current copy with a reason, keeping its row and stored file, and
 * audits `aircraft.file_archived` with the copy before and after.
 *
 * @param id - The file.
 * @param reason - Why it is archived; trimmed, 1 to 500 characters.
 * @param programUuid - The caller's active Flight Program.
 * @throws {Error} "Document not found.", checked first; the
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
    if (!file) throw new Error("Document not found.");
    const owner = await authorizeFileWriter(ctx, {
      aircraftUuid: file.aircraftUuid,
      programUuid: args.programUuid,
    });
    const archived = aircraftFileArchive(
      file,
      owner.user,
      args.reason,
      Date.now(),
    );
    await ctx.db.patch(file._id, archived);
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
          category: file.category,
          name: file.name,
          type: file.type,
          size: file.size,
          uploadedAt: file.uploadedAt,
        },
        after: { category: file.category, name: file.name, ...archived },
      },
    );
  },
});

async function authorizeFileWriter(
  ctx: QueryCtx | MutationCtx,
  args: { aircraftUuid: string; programUuid?: string },
) {
  const state = await checkContext(ctx, args.programUuid);
  assertAircraftFileWriter(state, args.aircraftUuid);
  const programUuid = state.aircraft.find(
    (a) => a.uuid === args.aircraftUuid,
  )?.programUuid;
  return { user: state.user, programUuid };
}

// Reads at most the cap, so the check stays cheap on a full aircraft.
async function countCurrentFiles(
  ctx: MutationCtx,
  aircraftUuid: string,
): Promise<number> {
  const current = await ctx.db
    .query("aircraftFiles")
    .withIndex("aircraft", (q) => q.eq("aircraftUuid", aircraftUuid))
    .filter((q) => q.eq(q.field("archivedAt"), undefined))
    .take(MAX_AIRCRAFT_FILES);
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
