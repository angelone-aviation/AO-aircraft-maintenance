/**
 * Responsibility: Files attached to inventory items: the attachment record,
 *   the file rules (name, size and first bytes), and who may manage an
 *   item's attachments.
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

// The first bytes of each accepted type; null stands for any byte (a WebP
// file's RIFF chunk size).
const FILE_SIGNATURES = new Map<string, (number | null)[]>([
  ["application/pdf", [...new TextEncoder().encode("%PDF-")]],
  ["image/jpeg", [0xff, 0xd8, 0xff]],
  ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  [
    "image/webp",
    [
      ...new TextEncoder().encode("RIFF"),
      ...[null, null, null, null],
      ...new TextEncoder().encode("WEBP"),
    ],
  ],
]);

/**
 * Attachment bytes travel as a Convex action argument (`v.bytes()`), not
 * through an upload URL, so a file must fit within Convex's function-argument
 * size limit with room for encoding and the other arguments. Inventory, PO,
 * work-order and job-card attachments share this limit, 7 MiB. Larger files
 * need the upload-ticket flow manuals use.
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
 *   or type; "Attachments must be between 1 byte and 7 MiB." for a bad size.
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
    throw new Rejection("Attachments must be between 1 byte and 7 MiB.");
}

/**
 * Checks that a file's first bytes are those of its declared type, so a file
 * renamed past {@link validateInventoryFile} (an SVG or web page named as an
 * image or PDF, a HEIC photo named as a JPEG) is refused.
 *
 * @param type - The declared MIME type.
 * @param bytes - The file, or at least its first 12 bytes.
 * @throws {Rejection} "This file's contents do not match its type. Choose a
 *   PDF, JPEG, PNG or WebP file." for a mismatch, a file too short to tell,
 *   or a type {@link validateInventoryFile} refuses.
 */
export function assertFileContents(type: string, bytes: ArrayBuffer) {
  const signature = FILE_SIGNATURES.get(type) ?? [];
  const head = new Uint8Array(
    bytes,
    0,
    Math.min(bytes.byteLength, signature.length),
  );
  if (
    !signature.length ||
    signature.some((b, i) => b !== null && head[i] !== b)
  )
    throw new Rejection(
      "This file's contents do not match its type. Choose a PDF, JPEG, PNG or WebP file.",
    );
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
