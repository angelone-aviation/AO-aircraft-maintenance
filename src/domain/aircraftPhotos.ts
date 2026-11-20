/**
 * Responsibility: The file rules for an aircraft's photo.
 * Layer: Domain. Pure function and constants; no I/O, no React.
 * Dependencies: ./rejection.
 */
import { Rejection } from "./rejection";

/** The MIME types an aircraft photo may have, in the order refusals name them. */
export const AIRCRAFT_PHOTO_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
];

// 5 MiB, although the message says "5 MB".
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Checks an aircraft photo before it is stored.
 *
 * @param type - The file's MIME type.
 * @param size - The file's size in bytes.
 * @throws {Rejection} "Choose a JPEG, PNG or WebP aircraft photo." for any
 *   other type; "Aircraft photos must be no larger than 5 MB." for a size that
 *   is not a positive whole number up to 5 MiB.
 */
export function validateAircraftPhoto(type: string, size: number): void {
  if (!AIRCRAFT_PHOTO_TYPES.includes(type))
    throw new Rejection("Choose a JPEG, PNG or WebP aircraft photo.");
  if (!Number.isSafeInteger(size) || size <= 0 || size > PHOTO_MAX_BYTES)
    throw new Rejection("Aircraft photos must be no larger than 5 MB.");
}
