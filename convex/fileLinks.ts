/**
 * Responsibility: Short-lived signed links to stored files: issued to members
 *   whose snapshot lists the file, and served while unexpired and unaltered.
 * Layer: Server. A public mutation and the HTTP action behind
 *   /files/v1/<token>; who sees a file follows the snapshot's listing rules.
 * Dependencies: convex/values, ./_generated, ./programContext, ./secrets,
 *   src/domain (model, programs, ownerView, boardView, aircraftFiles).
 *
 * A storage URL opens its file for anyone, for good (security review S7, bug
 * hunt SE-12). A link here names its file, expiry and signing key, so serving
 * it reads no table; it cannot be revoked early, which its five-minute
 * lifetime bounds (docs/file-links.md).
 */
import { ConvexError, v } from "convex/values";
import { httpAction, mutation, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { context } from "./programContext";
import { activeKeyId, fileLinkKey } from "./secrets";
import { can, type Snapshot } from "../src/domain/model";
import { activeProgram, scopedSnapshot } from "../src/domain/programs";
import { isOwnerView, ownerPortalAircraft } from "../src/domain/ownerView";
import { isBoardView } from "../src/domain/boardView";
import { isCurrentAircraftFile } from "../src/domain/aircraftFiles";

/** How long a file link works after it is issued. */
export const FILE_LINK_TTL_MS = 5 * 60 * 1000;
/** The most links one call issues: a screen of thumbnails. */
export const MAX_FILE_LINKS = 50;
/** Where links are served, on the deployment's `.convex.site` origin. */
export const FILE_LINK_PATH = "/files/v1/";
const TOKEN_VERSION = "v1";
const EXPIRED = "This link has expired. Open the file again from Angel One.";
const GONE = "This file is no longer available.";
const BOARD = "Files are not available in the board view.";
// Types a browser shows without running anything; others are downloads, so
// nothing uploaded can run as a page on the deployment's origin.
const INLINE_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/** A link to one stored file, and when it stops working (epoch ms). */
export interface FileLink {
  url: string;
  expiresAt: number;
}

/** What a link names: the stored file, its type and the name to save it as. */
export interface LinkedFile {
  storageId: Id<"_storage">;
  type: string;
  name: string;
}

/**
 * Issues links to the aircraft documents (Form 337 copies, logbook page
 * photos) the caller's snapshot lists: every copy for workspace readers of
 * the aircraft, current Form 337 copies for its owners. Board members, whose
 * view holds no files, are refused. Writes nothing.
 *
 * @param programUuid - The caller's active Flight Program.
 * @param files - At most {@link MAX_FILE_LINKS} aircraft file ids.
 * @returns One entry per reference, in order: a link valid for
 *   {@link FILE_LINK_TTL_MS}, or null when the caller may not see the file or
 *   it is gone (alike, so a refusal reveals nothing).
 * @throws {Error} "An active account and session are required."
 * @throws {ConvexError} "Ask for at most 50 files at a time."; "Flight
 *   Program changed. Reopen the form in the correct program."; "Files are
 *   not available in the board view."
 */
export const links = mutation({
  args: {
    programUuid: v.optional(v.string()),
    files: v.array(
      v.object({ kind: v.literal("aircraftFile"), id: v.string() }),
    ),
  },
  handler: async (ctx, args): Promise<(FileLink | null)[]> => {
    if (args.files.length > MAX_FILE_LINKS)
      throw new ConvexError(
        `Ask for at most ${MAX_FILE_LINKS} files at a time.`,
      );
    const reader = await readerSnapshot(ctx, args.programUuid);
    const issuedAt = Date.now();
    return Promise.all(
      args.files.map(async ({ id }) => {
        const file = await listedAircraftFile(ctx, reader, id);
        return file ? issueFileLink(file, issuedAt) : null;
      }),
    );
  },
});

/**
 * Signs a link to a stored file. The caller must already have checked that
 * the reader may see it.
 *
 * @param file - The stored file, its type and the name to save it as.
 * @param issuedAt - When the link's {@link FILE_LINK_TTL_MS} starts (epoch ms).
 * @returns `<CONVEX_SITE_URL>/files/v1/v1.<keyId>.<payload>.<signature>`
 *   under the active credential key, and its expiry.
 * @throws {ConvexError} As fileLinkKey and activeKeyId, when the credential
 *   key is unset or malformed.
 * @throws {Error} "CONVEX_SITE_URL is not set." outside a deployment.
 */
export async function issueFileLink(
  file: LinkedFile,
  issuedAt: number,
): Promise<FileLink> {
  const expiresAt = issuedAt + FILE_LINK_TTL_MS;
  const keyId = activeKeyId();
  const payload: TokenPayload = {
    s: file.storageId,
    e: expiresAt,
    t: file.type,
    n: file.name,
  };
  const signed = `${TOKEN_VERSION}.${keyId}.${encodeJson(payload)}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await fileLinkKey(keyId),
    new TextEncoder().encode(signed),
  );
  const token = `${signed}.${toBase64Url(new Uint8Array(signature))}`;
  return { url: siteUrl() + FILE_LINK_PATH + token, expiresAt };
}

/**
 * Serves the file a link names while its signature holds and it has not
 * expired. Registered in convex/http.ts.
 *
 * @returns 200 with the file, never cached and readable from any origin:
 *   inline under its name for PDF, JPEG, PNG and WebP, otherwise as a
 *   download. 403 "This link has expired. Open the file again from Angel
 *   One." for an expired, altered or foreign link; 404 "This file is no
 *   longer available." when its file was deleted.
 */
export const serve = httpAction(async (ctx, request) => {
  const token = new URL(request.url).pathname.slice(FILE_LINK_PATH.length);
  const file = await verifyToken(token, Date.now());
  if (!file) return refusal(403, EXPIRED);
  const blob = await ctx.storage.get(file.storageId);
  if (!blob) return refusal(404, GONE);
  return new Response(blob, { headers: fileHeaders(file) });
});

/** Signed into a link: storage id, expiry, content type and file name. */
interface TokenPayload {
  s: string;
  e: number;
  t: string;
  n: string;
}

// The snapshot query's scoping of the caller. Owners pass, unlike
// checkContext: they may open the copies their portal lists.
async function readerSnapshot(ctx: MutationCtx, programUuid?: string) {
  const state = await context(ctx);
  if (activeProgram(state) !== programUuid)
    throw new ConvexError(
      "Flight Program changed. Reopen the form in the correct program.",
    );
  if (isBoardView(state)) throw new ConvexError(BOARD);
  return scopedSnapshot(state);
}

async function listedAircraftFile(
  ctx: MutationCtx,
  reader: Snapshot,
  id: string,
): Promise<LinkedFile | null> {
  const fileId = ctx.db.normalizeId("aircraftFiles", id);
  const file = fileId && (await ctx.db.get(fileId));
  if (!file || !listsAircraftFile(reader, file)) return null;
  if (!(await ctx.db.system.get(file.storageId))) return null;
  return { storageId: file.storageId, type: file.type, name: file.name };
}

// The snapshot's rule for one file (aircraftFileList, then ownerPortalFiles
// for owners), without listing them all.
function listsAircraftFile(s: Snapshot, file: Doc<"aircraftFiles">) {
  const owner = isOwnerView(s);
  const aircraft = owner ? ownerPortalAircraft(s) : s.aircraft;
  if (!aircraft.some((a) => a.uuid === file.aircraftUuid)) return false;
  if (!can(s, file.aircraftUuid, "read")) return false;
  return (
    !owner || (file.category === "form-337" && isCurrentAircraftFile(file))
  );
}

// Null for any token this deployment did not sign, or whose lifetime has
// passed; the caller is never told which.
async function verifyToken(
  token: string,
  now: number,
): Promise<LinkedFile | null> {
  const [version, keyId, payload, signature, ...rest] = token.split(".");
  if (version !== TOKEN_VERSION || !signature || rest.length) return null;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await fileLinkKey(keyId),
      fromBase64Url(signature),
      new TextEncoder().encode(`${version}.${keyId}.${payload}`),
    );
    return valid ? readPayload(payload, now) : null;
  } catch {
    // An unknown key id or a damaged token: not a link this deployment issued.
    return null;
  }
}

function readPayload(payload: string, now: number): LinkedFile | null {
  const value: unknown = JSON.parse(
    new TextDecoder().decode(fromBase64Url(payload)),
  );
  if (!isTokenPayload(value) || value.e <= now) return null;
  return {
    storageId: value.s as Id<"_storage">,
    type: value.t,
    name: value.n,
  };
}

function isTokenPayload(value: unknown): value is TokenPayload {
  const p = value as Partial<TokenPayload> | null;
  return (
    typeof p?.s === "string" &&
    typeof p.e === "number" &&
    typeof p.t === "string" &&
    typeof p.n === "string"
  );
}

function fileHeaders(file: LinkedFile): HeadersInit {
  const disposition = INLINE_TYPES.has(file.type) ? "inline" : "attachment";
  return {
    "Content-Type": file.type,
    "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeFileName(file.name)}`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": "*",
  };
}

function refusal(status: number, message: string) {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// RFC 8187 leaves ' ( ) * out of a filename* value; encodeURIComponent keeps
// them.
function encodeFileName(name: string) {
  return encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function siteUrl(): string {
  const site = process.env.CONVEX_SITE_URL;
  if (!site) throw new Error("CONVEX_SITE_URL is not set.");
  return site;
}

function encodeJson(value: TokenPayload) {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function toBase64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(text: string) {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
