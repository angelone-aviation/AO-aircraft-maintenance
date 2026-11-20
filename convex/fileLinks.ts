/**
 * Responsibility: Issues short-lived links to the stored files a member's own
 *   snapshot or file listings show, and to nothing else.
 * Layer: Server. One public mutation; the visibility rules are those of the
 *   snapshot query (convex/operations.ts), the purchase-order and license-copy
 *   listings, and src/domain's scoping.
 * Dependencies: convex/values, ./_generated, ./programContext, ./collections,
 *   ./fileTokens, src/domain (model, programs, ownerView, boardView,
 *   aircraftFiles, fileLinks).
 *
 * A storage URL opens its file for anyone, for good (security review S7, bug
 * hunt SE-12), so the snapshot carries none; screens ask here when they show
 * a file (docs/file-links.md).
 */
import { ConvexError, v } from "convex/values";
import { mutation, type MutationCtx } from "./_generated/server";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import { context } from "./programContext";
import { decode } from "./collections";
import { issueFileLink } from "./fileTokens";
import { can, type Snapshot } from "../src/domain/model";
import {
  activeProgram,
  programPermission,
  scopedSnapshot,
} from "../src/domain/programs";
import { isOwnerView, ownerPortalAircraft } from "../src/domain/ownerView";
import { isBoardView } from "../src/domain/boardView";
import { isCurrentAircraftFile } from "../src/domain/aircraftFiles";
import {
  FILE_KINDS,
  MAX_FILE_LINKS,
  NO_FILES_IN_BOARD_VIEW,
  type FileLink,
  type FileRef,
} from "../src/domain/fileLinks";

// Upload paths that keep no type of their own are served as a download.
const UNKNOWN_TYPE = "application/octet-stream";
const PHOTO_NAME = "aircraft-photo";
const PDF = "application/pdf";

/**
 * Issues links to the stored files the caller's snapshot lists. Workspace
 * members get what their scoped snapshot shows; owners get their aircraft's
 * photo and current Form 337 copies, as the owner portal lists them; a
 * member who is only on a board, whose view holds no file, is refused.
 * Writes nothing.
 *
 * @param programUuid - The caller's active Flight Program.
 * @param files - At most {@link MAX_FILE_LINKS} references.
 * @returns One entry per reference, in order: a link valid for five minutes,
 *   or null when the caller may not see the file or it is gone (alike, so a
 *   refusal reveals nothing).
 * @throws {Error} "An active account and session are required."
 * @throws {ConvexError} "Ask for at most 50 files at a time."; "Flight
 *   Program changed. Reopen the form in the correct program."; "Files are
 *   not available in the board view."
 */
export const links = mutation({
  args: {
    programUuid: v.optional(v.string()),
    files: v.array(
      v.object({
        kind: v.union(...FILE_KINDS.map((kind) => v.literal(kind))),
        id: v.string(),
      }),
    ),
  },
  handler: async (ctx, args): Promise<(FileLink | null)[]> => {
    if (args.files.length > MAX_FILE_LINKS)
      throw new ConvexError(
        `Ask for at most ${MAX_FILE_LINKS} files at a time.`,
      );
    const reader = await readerOf(ctx, args.programUuid);
    const issuedAt = Date.now();
    return Promise.all(
      args.files.map(async (ref) => {
        const file = await RESOLVE[ref.kind](ctx, reader, ref.id);
        return file && linkTo(ctx, file, issuedAt);
      }),
    );
  },
});

/** The caller's context, and the snapshot query's scoping of it. */
interface Reader {
  state: Snapshot;
  scoped: Snapshot;
  /** An owner portal, or one joined with a board view. */
  owner: boolean;
}

/** A stored file a reference named, once the reader may open it. */
interface Openable {
  storageId: Id<"_storage">;
  name: string;
  /** Unset for files whose upload kept no type; the stored blob's is used. */
  type?: string;
}

type Resolve = (
  ctx: MutationCtx,
  reader: Reader,
  id: string,
) => Promise<Openable | null>;

// Owners pass, unlike checkContext: they may open what their portal lists.
async function readerOf(ctx: MutationCtx, programUuid?: string) {
  const state = await context(ctx);
  if (activeProgram(state) !== programUuid)
    throw new ConvexError(
      "Flight Program changed. Reopen the form in the correct program.",
    );
  const owner = isOwnerView(state);
  if (isBoardView(state) && !owner)
    throw new ConvexError(NO_FILES_IN_BOARD_VIEW);
  return { state, scoped: scopedSnapshot(state), owner };
}

async function linkTo(
  ctx: MutationCtx,
  file: Openable,
  issuedAt: number,
): Promise<FileLink | null> {
  const stored = await ctx.db.system.get(file.storageId);
  if (!stored) return null;
  const type = file.type ?? stored.contentType ?? UNKNOWN_TYPE;
  return issueFileLink(
    { storageId: file.storageId, name: file.name, type },
    issuedAt,
  );
}

// The rules follow convex/operations.ts: a reduced view adds only its
// owners' photos and Form 337 copies; a workspace lists every file of the
// records its scoped snapshot keeps. Manuals, purchase-order files and
// license copies follow the checks that opened them before links existed.
const RESOLVE: Record<FileRef["kind"], Resolve> = {
  aircraftFile: resolveAircraftFile,
  aircraftPhoto: resolveAircraftPhoto,
  workOrderFile: resolveWorkOrderFile,
  taskEvidence: resolveTaskEvidence,
  inventoryFile: resolveInventoryFile,
  manual: resolveManual,
  poFile: resolvePoFile,
  certificationFile: resolveCertificationFile,
};

async function resolveAircraftFile(
  ctx: MutationCtx,
  { scoped, owner }: Reader,
  id: string,
) {
  const file = await rowById(ctx, "aircraftFiles", id);
  if (!file) return null;
  const aircraft = owner ? ownerPortalAircraft(scoped) : scoped.aircraft;
  if (!aircraft.some((a) => a.uuid === file.aircraftUuid)) return null;
  if (!can(scoped, file.aircraftUuid, "read")) return null;
  if (owner && (file.category !== "form-337" || !isCurrentAircraftFile(file)))
    return null;
  return file;
}

async function resolveAircraftPhoto(
  ctx: MutationCtx,
  { scoped, owner }: Reader,
  aircraftUuid: string,
) {
  const aircraft = owner ? ownerPortalAircraft(scoped) : scoped.aircraft;
  if (!aircraft.some((a) => a.uuid === aircraftUuid)) return null;
  const photo = await ctx.db
    .query("aircraftPhotos")
    .withIndex("aircraft", (q) => q.eq("aircraftUuid", aircraftUuid))
    .unique();
  return photo && { storageId: photo.storageId, name: PHOTO_NAME };
}

async function resolveWorkOrderFile(
  ctx: MutationCtx,
  { state, owner }: Reader,
  id: string,
) {
  const file = owner ? null : await rowById(ctx, "workOrderFiles", id);
  const order = file && (await byUuid.workOrders(ctx, file.workOrderUuid));
  if (!file || !order) return null;
  const [record] = decode("workOrders", [order]);
  const kept = scopedSnapshot({ ...state, workOrders: [record] }).workOrders;
  return kept?.length ? file : null;
}

async function resolveTaskEvidence(
  ctx: MutationCtx,
  { state, owner }: Reader,
  id: string,
) {
  const file = owner ? null : await rowById(ctx, "taskEvidence", id);
  if (!file) return null;
  const card = await byUuid.taskCards(ctx, file.taskCardUuid);
  const archived = card
    ? null
    : await byUuid.archivedTaskCards(ctx, file.taskCardUuid);
  const scoped = scopedSnapshot({
    ...state,
    taskCards: card ? decode("taskCards", [card]) : [],
    archivedTaskCards: archived ? decode("archivedTaskCards", [archived]) : [],
  });
  const kept = [
    ...(scoped.taskCards ?? []),
    ...(scoped.archivedTaskCards ?? []),
  ];
  return kept.length ? file : null;
}

async function resolveInventoryFile(
  ctx: MutationCtx,
  { state, scoped, owner }: Reader,
  id: string,
) {
  const file = owner ? null : await rowById(ctx, "inventoryFiles", id);
  const stock = file && (await byUuid.management(ctx, file.stockUuid));
  if (!file || !stock || !programPermission(scoped, "admin")) return null;
  const [record] = decode("management", [stock]);
  const kept = scopedSnapshot({ ...state, management: [record] }).management;
  const filed = kept?.some((r) => r.kind === "stock" || r.kind === "component");
  return filed ? file : null;
}

// A workspace reader of the manual's aircraft; owners have no library.
async function resolveManual(
  ctx: MutationCtx,
  { state, owner }: Reader,
  uuid: string,
) {
  const manual = owner ? null : await byUuid.manuals(ctx, uuid);
  if (!manual || !can(state, manual.aircraftUuid, "read")) return null;
  return { storageId: manual.storageId, name: manual.filename, type: PDF };
}

// An inventory administrator, for an order in the active program.
async function resolvePoFile(
  ctx: MutationCtx,
  { state, owner }: Reader,
  id: string,
) {
  const file = owner ? null : await rowById(ctx, "poFiles", id);
  const order = file && (await byUuid.purchaseOrders(ctx, file.poUuid));
  if (!file || order?.programUuid !== activeProgram(state)) return null;
  return programPermission(state, "admin") ? file : null;
}

// The member whose license it is, or a system administrator.
async function resolveCertificationFile(
  ctx: MutationCtx,
  { state }: Reader,
  id: string,
) {
  const file = await rowById(ctx, "certificationFiles", id);
  if (!file || !(await ctx.db.get(file.userId))) return null;
  const mine = file.userId === state.user.id;
  return mine || state.user.isAdmin ? file : null;
}

async function rowById<T extends TableNames>(
  ctx: MutationCtx,
  table: T,
  id: string,
): Promise<Doc<T> | null> {
  const docId = ctx.db.normalizeId(table, id);
  return docId && ctx.db.get(docId);
}

// One lookup per table: Convex's index types do not narrow over a union of
// tables.
const byUuid = {
  workOrders: (ctx: MutationCtx, uuid: string) =>
    ctx.db
      .query("workOrders")
      .withIndex("uuid", (q) => q.eq("uuid", uuid))
      .unique(),
  taskCards: (ctx: MutationCtx, uuid: string) =>
    ctx.db
      .query("taskCards")
      .withIndex("uuid", (q) => q.eq("uuid", uuid))
      .unique(),
  archivedTaskCards: (ctx: MutationCtx, uuid: string) =>
    ctx.db
      .query("archivedTaskCards")
      .withIndex("uuid", (q) => q.eq("uuid", uuid))
      .unique(),
  management: (ctx: MutationCtx, uuid: string) =>
    ctx.db
      .query("management")
      .withIndex("uuid", (q) => q.eq("uuid", uuid))
      .unique(),
  manuals: (ctx: MutationCtx, uuid: string) =>
    ctx.db
      .query("manuals")
      .withIndex("uuid", (q) => q.eq("uuid", uuid))
      .unique(),
  purchaseOrders: (ctx: MutationCtx, uuid: string) =>
    ctx.db
      .query("purchaseOrders")
      .withIndex("uuid", (q) => q.eq("uuid", uuid))
      .unique(),
};
