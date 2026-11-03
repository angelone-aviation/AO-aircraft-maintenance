import { can, type Snapshot } from "./model";
import { validateInventoryFile } from "./inventoryAttachments";

/** Document categories kept on the aircraft record. Form 337 copies are one of
 * the six permanent status records under 14 CFR 91.417(a)(2)(vi). */
export const aircraftFileCategories = ["form-337"] as const;
export type AircraftFileCategory = (typeof aircraftFileCategories)[number];
export const aircraftFileCategoryLabels: Record<AircraftFileCategory, string> =
  { "form-337": "Form 337 copies" };
export interface AircraftFile {
  uuid: string;
  aircraftUuid: string;
  category: AircraftFileCategory;
  name: string;
  type: string;
  size: number;
  uploadedAt: number;
  url: string;
}
/** Status records accumulate over an aircraft's life, so an aircraft holds
 * more files than the per-record cap on other attachments. */
export const MAX_AIRCRAFT_FILES = 200;
/** Same types (PDF, JPEG, PNG, WebP) and 7 MB limit as other record attachments. */
export const validateAircraftFile = validateInventoryFile;
export function assertAircraftFileRoom(existing: number) {
  if (existing >= MAX_AIRCRAFT_FILES)
    throw new Error(
      `This aircraft already has the maximum of ${MAX_AIRCRAFT_FILES} stored documents.`,
    );
}
/** Readers of the aircraft see its files; maintenance permission uploads and deletes. */
export function assertAircraftFileWriter(s: Snapshot, aircraftUuid: string) {
  if (!can(s, aircraftUuid, "maintenance"))
    throw new Error("Aircraft maintenance permission required.");
}
