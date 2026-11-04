/**
 * Responsibility: Documents kept on the aircraft record (Form 337 copies):
 *   the file record, the upload limits, who may write, and archiving a copy.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: src/domain/model.ts, inventoryAttachments.ts, rejection.ts.
 *
 * Form 337 copies are one of the six permanent status records under 14 CFR
 * 91.417(a)(2)(vi), so they are never deleted (ADR-0004): an archived copy is
 * hidden from the current list but keeps its stored file.
 */
import { can, type Snapshot } from "./model";
import { validateInventoryFile } from "./inventoryAttachments";
import { Rejection } from "./rejection";

const ARCHIVE_REASON_MAX_LENGTH = 500;

/** Document categories kept on the aircraft record. */
export const aircraftFileCategories = ["form-337"] as const;

/** One of {@link aircraftFileCategories}. */
export type AircraftFileCategory = (typeof aircraftFileCategories)[number];

/** The heading of each category on screen. */
export const aircraftFileCategoryLabels: Record<AircraftFileCategory, string> =
  { "form-337": "Form 337 copies" };

/** Who archived a copy, when, and why. */
export interface AircraftFileArchive {
  archivedAt: number;
  archivedBy: { userId: string; name: string };
  archiveReason: string;
}

/** A document on the aircraft record; archived when the archive fields are set. */
export interface AircraftFile extends Partial<AircraftFileArchive> {
  uuid: string;
  aircraftUuid: string;
  category: AircraftFileCategory;
  name: string;
  type: string;
  size: number;
  uploadedAt: number;
  url: string;
}

/**
 * Tells whether a copy is current, not archived.
 *
 * @param f - The copy.
 * @returns True when it has no `archivedAt`.
 */
export const isCurrentAircraftFile = (f: { archivedAt?: number }) =>
  f.archivedAt === undefined;

/**
 * The most current copies an aircraft may hold. Status records accumulate
 * over an aircraft's life, so this is above the cap on other attachments.
 */
export const MAX_AIRCRAFT_FILES = 200;

/**
 * Checks an aircraft document before upload: the same types (PDF, JPEG, PNG,
 * WebP) and 7 MB limit as other record attachments.
 *
 * @throws {Rejection} As {@link validateInventoryFile}.
 */
export const validateAircraftFile = validateInventoryFile;

/**
 * Checks that an aircraft has room for one more current copy.
 *
 * @param current - How many of the aircraft's copies are not archived.
 * @throws {Rejection} "This aircraft already has the maximum of 200 current
 *   documents." at {@link MAX_AIRCRAFT_FILES}.
 */
export function assertAircraftFileRoom(current: number) {
  if (current >= MAX_AIRCRAFT_FILES)
    throw new Rejection(
      `This aircraft already has the maximum of ${MAX_AIRCRAFT_FILES} current documents.`,
    );
}

/**
 * Checks that the user may upload and archive an aircraft's documents; any
 * reader of the aircraft may see them.
 *
 * @param s - The snapshot, for the user's access.
 * @param aircraftUuid - The aircraft.
 * @throws {Rejection} "Aircraft maintenance permission required." without
 *   `maintenance` on the aircraft.
 */
export function assertAircraftFileWriter(s: Snapshot, aircraftUuid: string) {
  if (!can(s, aircraftUuid, "maintenance"))
    throw new Rejection("Aircraft maintenance permission required.");
}

/**
 * The fields that archive a current copy.
 *
 * @param file - The copy.
 * @param user - Who archives it.
 * @param reason - Why; trimmed, then 1 to 500 characters.
 * @param now - The time in epoch milliseconds.
 * @returns The archive fields to add to the copy.
 * @throws {Rejection} "This copy is already archived."; "Enter a reason for
 *   archiving this copy."; "Keep the reason for archiving to 500 characters."
 */
export function aircraftFileArchive(
  file: { archivedAt?: number },
  user: { id: string; name: string },
  reason: string,
  now: number,
): AircraftFileArchive {
  if (!isCurrentAircraftFile(file))
    throw new Rejection("This copy is already archived.");
  const archiveReason = reason.trim();
  if (!archiveReason)
    throw new Rejection("Enter a reason for archiving this copy.");
  if (archiveReason.length > ARCHIVE_REASON_MAX_LENGTH)
    throw new Rejection("Keep the reason for archiving to 500 characters.");
  return {
    archivedAt: now,
    archivedBy: { userId: user.id, name: user.name },
    archiveReason,
  };
}
