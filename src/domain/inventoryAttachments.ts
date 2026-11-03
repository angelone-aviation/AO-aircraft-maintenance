import type { Snapshot } from "./model";
import { ownsActive, programPermission, recordProgram } from "./programs";

/**
 * Attachment bytes travel as a Convex action argument (`v.bytes()`), not
 * through an upload URL, so a file must fit within Convex's function-argument
 * size limit with room for encoding and the other arguments. Inventory, PO,
 * work-order and job-card attachments share this limit and the docs state it
 * as 7 MB. Larger files need the upload-ticket flow manuals use.
 */
export const MAX_ACTION_FILE_BYTES = 7 * 1024 * 1024;
export interface InventoryAttachment {
  uuid: string;
  stockUuid: string;
  name: string;
  type: string;
  size: number;
  uploadedAt: number;
  url: string;
}
export function validateInventoryFile(
  name: string,
  type: string,
  size: number,
) {
  const extensions: Record<string, RegExp> = {
    "application/pdf": /\.pdf$/i,
    "image/jpeg": /\.jpe?g$/i,
    "image/png": /\.png$/i,
    "image/webp": /\.webp$/i,
  };
  if (!name.trim() || name.length > 255 || !extensions[type]?.test(name))
    throw new Error("Choose a PDF, JPEG, PNG or WebP file.");
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_ACTION_FILE_BYTES)
    throw new Error("Attachments must be between 1 byte and 7 MB.");
}
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
    throw new Error("Inventory administrator access to this item is required.");
  return stock;
}
