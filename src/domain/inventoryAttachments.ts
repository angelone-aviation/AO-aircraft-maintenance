/**
 * Responsibility: Files attached to inventory items: the attachment record,
 *   the file rules (name and size), who may manage an item's attachments,
 *   and the first-bytes check that uploads share.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: src/domain/model.ts (types), programs.ts, rejection.ts.
 */
import type { Snapshot } from "./model";
import { ownsActive, programPermission, recordProgram } from "./programs";
import { Rejection } from "./rejection";

// A Map, not an object literal: the type is user input, and "constructor"
// would find an inherited property instead of no entry.
const ATTACHMENT_NAME_PATTERNS = new Map<string, RegExp>([
  ["application/pdf", /\.pdf$/i],
  ["image/jpeg", /\.jpe?g$/i],
  ["image/png", /\.png$/i],
  ["image/webp", /\.webp$/i],
]);

/**
 * The MIME types an inventory, PO or aircraft document attachment may have,
 * in the order refusals name them.
 */
export const ATTACHMENT_FILE_TYPES: readonly string[] = [
  ...ATTACHMENT_NAME_PATTERNS.keys(),
];

const FILE_TYPE_NAMES = new Map<string, string>([
  ["application/pdf", "PDF"],
  ["image/jpeg", "JPEG"],
  ["image/png", "PNG"],
  ["image/webp", "WebP"],
  ["image/heic", "HEIC"],
  ["image/heif", "HEIF"],
]);

// A file's first bytes; null stands for any byte (a chunk or box size).
type Signature = (number | null)[];
const ascii = (text: string) => [...new TextEncoder().encode(text)];
const ANY_SIZE = [null, null, null, null];

// HEIC and HEIF are ISO media files: a box size, "ftyp", then a brand. iPhones
// write "heic"; other cameras and converters use the rest of the HEIF family.
const HEIF_SIGNATURES = [
  "heic",
  "heix",
  "heim",
  "heis",
  "hevc",
  "hevx",
  "mif1",
  "msf1",
].map((brand): Signature => [...ANY_SIZE, ...ascii(`ftyp${brand}`)]);

const PDF_HEADER = ascii("%PDF-");

// PDF readers accept the header anywhere in a file's first 1,024 bytes (PDF
// Reference 1.7, Appendix H, the note on section 3.4.1 "File Header"), and
// some scanners write bytes before it. Every other signature starts at byte 0.
const PDF_HEADER_WINDOW = 1024;
const LATEST_START = new Map<string, number>([
  ["application/pdf", PDF_HEADER_WINDOW - PDF_HEADER.length],
]);

// The accepted first bytes of each type. A caller's own type check decides
// which types it takes, so HEIC is here without photos accepting it.
const FILE_SIGNATURES = new Map<string, Signature[]>([
  ["application/pdf", [PDF_HEADER]],
  ["image/jpeg", [[0xff, 0xd8, 0xff]]],
  ["image/png", [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]]],
  ["image/webp", [[...ascii("RIFF"), ...ANY_SIZE, ...ascii("WEBP")]]],
  ["image/heic", HEIF_SIGNATURES],
  ["image/heif", HEIF_SIGNATURES],
]);

/** How many leading bytes {@link assertFileContents} needs to tell a type. */
export const FILE_SIGNATURE_LENGTH = Math.max(
  ...[...FILE_SIGNATURES].flatMap(([type, signatures]) =>
    signatures.map((s) => (LATEST_START.get(type) ?? 0) + s.length),
  ),
);

/**
 * Attachment bytes travel as a Convex action argument (`v.bytes()`), not
 * through an upload URL, so a file must fit within Convex's function-argument
 * size limit with room for encoding and the other arguments. Inventory, PO,
 * work-order and job-card attachments share this limit and the docs state it
 * as 7 MB (it is 7 MiB). Larger files need the upload-ticket flow manuals use.
 */
export const MAX_ACTION_FILE_BYTES = 7 * 1024 * 1024;

/** A file attached to a stock item or component, with its download URL. */
export interface InventoryAttachment {
  uuid: string;
  stockUuid: string;
  name: string;
  type: string;
  size: number;
  uploadedAt: number;
  url: string;
}

/**
 * Checks an attachment before upload.
 *
 * @param name - The file name: not blank, at most 255 characters, ending in
 *   the type's extension (any case).
 * @param type - A PDF, JPEG, PNG or WebP MIME type.
 * @param size - The size in bytes, 1 to {@link MAX_ACTION_FILE_BYTES}.
 * @throws {Rejection} "Choose a PDF, JPEG, PNG or WebP file." for a bad name
 *   or type; "Attachments must be between 1 byte and 7 MB." for a bad size.
 */
export function validateInventoryFile(
  name: string,
  type: string,
  size: number,
) {
  if (
    !name.trim() ||
    name.length > 255 ||
    !ATTACHMENT_NAME_PATTERNS.get(type)?.test(name)
  )
    throw new Rejection("Choose a PDF, JPEG, PNG or WebP file.");
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_ACTION_FILE_BYTES)
    throw new Rejection("Attachments must be between 1 byte and 7 MB.");
}

/**
 * Checks that a file's first bytes are those of its declared type, so a file
 * renamed past a type and name check (an SVG or web page named as an image or
 * PDF, a HEIC photo named as a JPEG) is refused. A PDF's "%PDF-" header may
 * start anywhere in its first 1,024 bytes; every other signature at byte 0.
 *
 * @param type - The declared MIME type: PDF, JPEG, PNG, WebP, HEIC or HEIF.
 * @param bytes - The file, or at least its first
 *   {@link FILE_SIGNATURE_LENGTH} bytes.
 * @param accepted - The MIME types the caller takes, named in the refusal.
 * @throws {Rejection} "This file's contents do not match its type. Choose a
 *   PDF, JPEG or PNG file." (the `accepted` types, in order) for a mismatch,
 *   a file too short to tell, or any other type.
 */
export function assertFileContents(
  type: string,
  bytes: ArrayBuffer,
  accepted: readonly string[],
) {
  if (!matchesFileType(type, bytes))
    throw new Rejection(
      `This file's contents do not match its type. Choose a ${nameTypes(accepted)} file.`,
    );
}

/**
 * The test {@link assertFileContents} applies, for a caller that refuses a
 * mismatch in its own words.
 *
 * @param type - The declared MIME type.
 * @param bytes - The file, or at least its first
 *   {@link FILE_SIGNATURE_LENGTH} bytes.
 * @returns True when the first bytes are one of the type's signatures; false
 *   for a mismatch, a file too short to tell, or any other type.
 */
export function matchesFileType(type: string, bytes: ArrayBuffer): boolean {
  const head = new Uint8Array(
    bytes,
    0,
    Math.min(bytes.byteLength, FILE_SIGNATURE_LENGTH),
  );
  const signatures = FILE_SIGNATURES.get(type) ?? [];
  const latest = LATEST_START.get(type) ?? 0;
  return signatures.some((signature) => startsBy(head, signature, latest));
}

function startsBy(head: Uint8Array, signature: Signature, latest: number) {
  for (let at = 0; at <= latest; at++)
    if (startsAt(head, signature, at)) return true;
  return false;
}

// "PDF, JPEG or PNG": the types as users know them, the last after "or".
function nameTypes(types: readonly string[]): string {
  const names = types.map((t) => FILE_TYPE_NAMES.get(t) ?? t);
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

// A file shorter than the signature fails: its missing bytes read undefined.
function startsAt(head: Uint8Array, signature: Signature, at: number) {
  return signature.every((b, i) => b === null || head[at + i] === b);
}

/**
 * Finds a stock item or component whose attachments the user may manage.
 *
 * @param s - The snapshot.
 * @param stockUuid - The item.
 * @returns The item, when it is in the active program and the user
 *   administers that program.
 * @throws {Rejection} "Inventory administrator access to this item is
 *   required." otherwise, including for a missing item.
 */
export function inventoryAttachmentAccess(s: Snapshot, stockUuid: string) {
  const stock = s.management?.find(
    (r) =>
      (r.kind === "stock" || r.kind === "component") && r.uuid === stockUuid,
  );
  if (
    !stock ||
    !ownsActive(s, recordProgram(s, stock)) ||
    !programPermission(s, "admin")
  )
    throw new Rejection(
      "Inventory administrator access to this item is required.",
    );
  return stock;
}
