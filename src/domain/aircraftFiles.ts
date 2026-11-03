import { can, type Snapshot } from "./model";
import { validateInventoryFile } from "./inventoryAttachments";

/** Document categories kept on the aircraft record. Form 337 copies are one of
 * the six permanent status records under 14 CFR 91.417(a)(2)(vi). */
export const aircraftFileCategories = ["form-337"] as const;
export type AircraftFileCategory = (typeof aircraftFileCategories)[number];
export const aircraftFileCategoryLabels: Record<AircraftFileCategory, string> =
  { "form-337": "Form 337 copies" };
export interface AircraftFileArchive {
  archivedAt: number;
  archivedBy: { userId: string; name: string };
  archiveReason: string;
}
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
/** Status records are never deleted (ADR-0004): an archived copy is hidden from
 * the current list but keeps its stored file. */
export const isCurrentAircraftFile = (f: { archivedAt?: number }) =>
  f.archivedAt === undefined;
/** Status records accumulate over an aircraft's life, so an aircraft holds
 * more current files than the per-record cap on other attachments. */
export const MAX_AIRCRAFT_FILES = 200;
/** Same types (PDF, JPEG, PNG, WebP) and 7 MB limit as other record attachments. */
export const validateAircraftFile = validateInventoryFile;
/** `current` counts the aircraft's copies that are not archived. */
export function assertAircraftFileRoom(current: number) {
  if (current >= MAX_AIRCRAFT_FILES)
    throw new Error(
      `This aircraft already has the maximum of ${MAX_AIRCRAFT_FILES} current documents.`,
    );
}
/** Readers of the aircraft see its files; maintenance permission uploads and archives. */
export function assertAircraftFileWriter(s: Snapshot, aircraftUuid: string) {
  if (!can(s, aircraftUuid, "maintenance"))
    throw new Error("Aircraft maintenance permission required.");
}
/** The fields that archive a current copy, with the required reason. */
export function aircraftFileArchive(
  file: { archivedAt?: number },
  user: { id: string; name: string },
  reason: string,
  now: number,
): AircraftFileArchive {
  if (!isCurrentAircraftFile(file))
    throw new Error("This copy is already archived.");
  const archiveReason = reason.trim();
  if (!archiveReason)
    throw new Error("Enter a reason for archiving this copy.");
  if (archiveReason.length > 500)
    throw new Error("Keep the reason for archiving to 500 characters.");
  return {
    archivedAt: now,
    archivedBy: { userId: user.id, name: user.name },
    archiveReason,
  };
}
