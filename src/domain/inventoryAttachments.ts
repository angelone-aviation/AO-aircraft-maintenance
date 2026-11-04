/**
 * Responsibility: Files attached to inventory items: the attachment record,
 *   the file rule, and who may manage an item's attachments.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: src/domain/model.ts (types), programs.ts, rejection.ts.
 */
import type { Snapshot } from "./model";
import { ownsActive, programPermission, recordProgram } from "./programs";
import { Rejection } from "./rejection";

const ATTACHMENT_NAME_PATTERNS: Record<string, RegExp> = {
  "application/pdf": /\.pdf$/i,
  "image/jpeg": /\.jpe?g$/i,
  "image/png": /\.png$/i,
  "image/webp": /\.webp$/i,
};

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
    !ATTACHMENT_NAME_PATTERNS[type]?.test(name)
  )
    throw new Rejection("Choose a PDF, JPEG, PNG or WebP file.");
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_ACTION_FILE_BYTES)
    throw new Rejection("Attachments must be between 1 byte and 7 MB.");
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
