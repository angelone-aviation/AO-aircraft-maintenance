/**
 * Responsibility: Signs short-lived links to stored files and serves a file
 *   while its link is unexpired and unaltered.
 * Layer: Server. The HTTP action behind /files/v1/<token> and the signer it
 *   trusts; who may receive a link is decided in convex/fileLinks.ts.
 * Dependencies: ./_generated, ./secrets, src/domain/fileLinks.
 *
 * A link names its file, expiry and signing key, so serving it reads no
 * table; it cannot be revoked early, which its five-minute lifetime bounds
 * (docs/file-links.md).
 */
import { httpAction } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { activeKeyId, fileLinkKey } from "./secrets";
import { FILE_LINK_TTL_MS, type FileLink } from "../src/domain/fileLinks";

/** Where links are served, on the deployment's `.convex.site` origin. */
export const FILE_LINK_PATH = "/files/v1/";
const TOKEN_VERSION = "v1";
const EXPIRED = "This link has expired. Open the file again from Angel One.";
const GONE = "This file is no longer available.";
// Types a browser shows without running anything; others are downloads, so
// nothing uploaded can run as a page on the deployment's origin.
const INLINE_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/** What a link names: the stored file, its type and the name to save it as. */
export interface LinkedFile {
  storageId: Id<"_storage">;
  type: string;
  name: string;
}

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
