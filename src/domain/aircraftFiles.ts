/**
 * Responsibility: Documents kept on the aircraft record (Form 337 copies and
 *   logbook page photos): the file record, the upload limits, what a photo
 *   links to, who may write, and archiving a copy.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: src/domain/model.ts, inventoryAttachments.ts, rejection.ts.
 *
 * Form 337 copies are one of the six permanent status records under 14 CFR
 * 91.417(a)(2)(vi), so they are never deleted (ADR-0004): an archived copy is
 * hidden from the current list but keeps its stored file. Logbook page photos
 * tie an app row to the paper logbook line or signed page that is the actual
 * maintenance record, so they follow the same archive-only rule.
 */
import { can, type Snapshot } from "./model";
import { validateInventoryFile } from "./inventoryAttachments";
import { Rejection } from "./rejection";

const ARCHIVE_REASON_MAX_LENGTH = 500;
// iPhones shoot HEIC by default; browsers and jsPDF cannot show it, so the
// refusal names the fix instead of the generic type list.
const HEIC_TYPES = new Set(["image/heic", "image/heif"]);
const HEIC_NAME = /\.hei[cf]$/i;

/** Document categories kept on the aircraft record. */
export const aircraftFileCategories = ["form-337", "logbook-page"] as const;

/** One of {@link aircraftFileCategories}. */
export type AircraftFileCategory = (typeof aircraftFileCategories)[number];

/** The heading of each category on screen. */
export const aircraftFileCategoryLabels: Record<AircraftFileCategory, string> =
  { "form-337": "Form 337 copies", "logbook-page": "Logbook page photos" };

/** The records a logbook page photo can be attached to. */
export const aircraftFileLinkKinds = ["flight", "work-order"] as const;

/** One of {@link aircraftFileLinkKinds}. */
export type AircraftFileLinkKind = (typeof aircraftFileLinkKinds)[number];

/** The flight or work order a logbook page photo belongs to. */
export interface AircraftFileLink {
  linkedKind: AircraftFileLinkKind;
  linkedUuid: string;
}

/** Who archived a copy, when, and why. */
export interface AircraftFileArchive {
  archivedAt: number;
  archivedBy: { userId: string; name: string };
  archiveReason: string;
}

/**
 * A document on the aircraft record; archived when the archive fields are
 * set. A logbook page photo carries the link fields; a Form 337 copy has none.
 */
export interface AircraftFile
  extends Partial<AircraftFileArchive>, Partial<AircraftFileLink> {
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
 * The most current copies of each category an aircraft may hold; archived
 * copies do not count. Form 337 copies keep the 200 the one shared cap was
 * sized for: status records accumulate over an aircraft's life, well above
 * the cap on other attachments. Photos get room of their own, so a pilot's
 * line photos can never block filing a Form 337 copy (NA-7, decision D12):
 * 500 covers a photo of every flight and signed work-order page for more
 * than a year at a flight a day, the paper logbooks' first year beside the
 * app. Both stay capped because every reader's snapshot lists each
 * aircraft's documents.
 */
export const MAX_CURRENT_AIRCRAFT_FILES: Record<AircraftFileCategory, number> =
  { "form-337": 200, "logbook-page": 500 };

// The category as a refusal names it mid-sentence.
const ROOM_NOUNS: Record<AircraftFileCategory, string> = {
  "form-337": "Form 337 copies",
  "logbook-page": "logbook page photos",
};

/**
 * Checks an aircraft document before upload: the same types (PDF, JPEG, PNG,
 * WebP) and 7 MiB limit as other record attachments.
 *
 * @throws {Rejection} As {@link validateInventoryFile}.
 */
export const validateAircraftFile = validateInventoryFile;

/**
 * Checks a logbook page photo before upload: the Form 337 types and limit,
 * refusing HEIC by name.
 *
 * @param name - The file name.
 * @param type - The MIME type.
 * @param size - The size in bytes.
 * @throws {Rejection} "HEIC photos are not accepted. Choose JPEG, PNG or
 *   WebP; on an iPhone set Camera > Formats to Most Compatible." for a HEIC
 *   or HEIF type or name; otherwise as {@link validateAircraftFile}.
 */
export function validateLogbookPhoto(name: string, type: string, size: number) {
  if (HEIC_TYPES.has(type.toLowerCase()) || HEIC_NAME.test(name))
    throw new Rejection(
      "HEIC photos are not accepted. Choose JPEG, PNG or WebP; on an iPhone set Camera > Formats to Most Compatible.",
    );
  validateAircraftFile(name, type, size);
}

/**
 * Checks an upload of either category.
 *
 * @throws {Rejection} As {@link validateLogbookPhoto} for "logbook-page",
 *   else as {@link validateAircraftFile}.
 */
export function validateAircraftUpload(
  category: AircraftFileCategory,
  name: string,
  type: string,
  size: number,
) {
  if (category === "logbook-page") validateLogbookPhoto(name, type, size);
  else validateAircraftFile(name, type, size);
}

/**
 * Checks that an aircraft has room for one more current copy of a category.
 *
 * @param category - The category of the copy being added.
 * @param current - How many of the aircraft's copies of that category are not
 *   archived.
 * @throws {Rejection} "This aircraft already has the maximum of 200 current
 *   Form 337 copies." or "... of 500 current logbook page photos." at the
 *   category's {@link MAX_CURRENT_AIRCRAFT_FILES}.
 */
export function assertAircraftFileRoom(
  category: AircraftFileCategory,
  current: number,
) {
  const max = MAX_CURRENT_AIRCRAFT_FILES[category];
  if (current >= max)
    throw new Rejection(
      `This aircraft already has the maximum of ${max} current ${ROOM_NOUNS[category]}.`,
    );
}

/**
 * Checks that a document's link matches its category: a logbook page photo
 * names the flight or work order it shows, a Form 337 copy names nothing.
 *
 * @param category - The document category.
 * @param link - The link fields sent with it, if any.
 * @throws {Rejection} "Link the photo to a flight or work order." for a
 *   photo without both link fields; "A Form 337 copy is not linked to a
 *   record." for a copy with either.
 */
export function assertAircraftFileLink(
  category: AircraftFileCategory,
  link: Partial<AircraftFileLink> | undefined,
) {
  const linked = !!link?.linkedKind && !!link.linkedUuid;
  if (category === "logbook-page" && !linked)
    throw new Rejection("Link the photo to a flight or work order.");
  if (category === "form-337" && (link?.linkedKind || link?.linkedUuid))
    throw new Rejection("A Form 337 copy is not linked to a record.");
}

/**
 * Checks that the user may upload and archive one of an aircraft's documents;
 * any reader of the aircraft may see them. A Form 337 copy and a work order's
 * signed page need maintenance permission; a flight's logbook line needs
 * flight permission, since the pilot attaches it.
 *
 * @param s - The snapshot, for the user's access.
 * @param aircraftUuid - The aircraft.
 * @param linkedKind - What a logbook page photo links to; omitted for a
 *   Form 337 copy.
 * @throws {Rejection} "Aircraft flight permission required." for a flight's
 *   photo without `flight`; otherwise "Aircraft maintenance permission
 *   required." without `maintenance` on the aircraft.
 */
export function assertAircraftFileWriter(
  s: Snapshot,
  aircraftUuid: string,
  linkedKind?: AircraftFileLinkKind,
) {
  if (canWriteAircraftFile(s, aircraftUuid, linkedKind)) return;
  throw new Rejection(
    linkedKind === "flight"
      ? "Aircraft flight permission required."
      : "Aircraft maintenance permission required.",
  );
}

/**
 * Whether the user may upload and archive one of an aircraft's documents:
 * the permission {@link assertAircraftFileWriter} checks, for screens to
 * show or hide the controls.
 *
 * @param s - The snapshot, for the user's access.
 * @param aircraftUuid - The aircraft.
 * @param linkedKind - What a logbook page photo links to; omitted for a
 *   Form 337 copy.
 * @returns True with `flight` for a flight's photo, else with `maintenance`.
 */
export function canWriteAircraftFile(
  s: Snapshot,
  aircraftUuid: string,
  linkedKind?: AircraftFileLinkKind,
): boolean {
  return can(
    s,
    aircraftUuid,
    linkedKind === "flight" ? "flight" : "maintenance",
  );
}

/**
 * Checks that the record a photo links to is on the aircraft in the snapshot.
 * The server checks the same against its tables; a device checks it before
 * uploading a photo it kept while the flight was still in the outbox.
 *
 * @param s - The snapshot holding the aircraft's flights and work orders.
 * @param aircraftUuid - The aircraft the photo is filed on.
 * @param link - The flight or work order.
 * @throws {Rejection} "Flight not found." or "Work order not found." when no
 *   such record is on that aircraft.
 */
export function assertAircraftFileTarget(
  s: Snapshot,
  aircraftUuid: string,
  link: AircraftFileLink,
) {
  if (!hasAircraftFileTarget(s, aircraftUuid, link))
    throw new Rejection(
      link.linkedKind === "flight"
        ? "Flight not found."
        : "Work order not found.",
    );
}

/**
 * Tells whether the record a photo links to is on the aircraft in the
 * snapshot: the server knows a queued flight only once it has synced.
 *
 * @param s - The snapshot holding the aircraft's flights and work orders.
 * @param aircraftUuid - The aircraft the photo is filed on.
 * @param link - The flight or work order.
 * @returns True when the snapshot holds it on that aircraft.
 */
export function hasAircraftFileTarget(
  s: Snapshot,
  aircraftUuid: string,
  link: AircraftFileLink,
): boolean {
  const records =
    link.linkedKind === "flight" ? s.flights : (s.workOrders ?? []);
  return records.some(
    (r) => r.uuid === link.linkedUuid && r.aircraftUuid === aircraftUuid,
  );
}

/**
 * The current logbook page photos of one flight or work order.
 *
 * @param files - The snapshot's aircraft files.
 * @param link - The flight or work order.
 * @returns Its unarchived photos, oldest upload first.
 */
export function linkedLogbookPhotos(
  files: AircraftFile[] | undefined,
  link: AircraftFileLink,
): AircraftFile[] {
  return (files ?? [])
    .filter(
      (f) =>
        f.category === "logbook-page" &&
        f.linkedKind === link.linkedKind &&
        f.linkedUuid === link.linkedUuid &&
        isCurrentAircraftFile(f),
    )
    .sort((x, z) => x.uploadedAt - z.uploadedAt);
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
