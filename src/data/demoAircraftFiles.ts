/**
 * Responsibility: Uploads and archives aircraft record documents (Form 337
 *   copies and logbook page photos) in demo mode, mirroring
 *   convex/aircraftFiles.ts, and reads any demo upload into a data URL.
 * Layer: Data. Demo adapter helper; files stay in this browser.
 * Dependencies: src/domain/aircraftFiles.ts,
 *   src/domain/inventoryAttachments.ts, src/domain/model.ts (types).
 */
import type { Snapshot } from "../domain/model";
import {
  aircraftFileArchive,
  assertAircraftFileLink,
  assertAircraftFileRoom,
  assertAircraftFileTarget,
  isCurrentAircraftFile,
  assertAircraftFileWriter,
  validateAircraftUpload,
  type AircraftFileCategory,
  type AircraftFileLink,
} from "../domain/aircraftFiles";
import {
  ATTACHMENT_FILE_TYPES,
  assertFileContents,
} from "../domain/inventoryAttachments";

type Modify = (fn: (s: Snapshot) => void) => Promise<void>;
type Audit = (
  s: Snapshot,
  action: string,
  entityUuid: string,
  aircraftUuid?: string,
  reason?: string,
  before?: unknown,
  after?: unknown,
) => void;

/** The document being filed: its aircraft, category and, for a photo, link. */
export type DemoAircraftFileTarget = {
  aircraftUuid: string;
  category: AircraftFileCategory;
} & Partial<AircraftFileLink>;

/**
 * The demo adapter's aircraft file methods. Each runs inside the adapter's
 * `modify` transaction and records one change-log entry through `audit`.
 */
export const demoAircraftFiles = {
  /**
   * Keeps a file on the aircraft as a data URL in the demo snapshot.
   *
   * @param target - The aircraft, the category and, for a "logbook-page"
   *   photo, the flight or work order it shows.
   * @param file - The uploaded file.
   * @throws {Error} As validateAircraftUpload and assertFileContents for
   *   the file; the link refusals of assertAircraftFileLink; "Aircraft
   *   flight permission required." or "Aircraft maintenance permission
   *   required."; "Flight not found." or "Work order not found."; the
   *   category's cap refusal from assertAircraftFileRoom.
   */
  async upload(
    modify: Modify,
    audit: Audit,
    target: DemoAircraftFileTarget,
    file: File,
  ) {
    const { aircraftUuid, category, linkedKind, linkedUuid } = target;
    validateAircraftUpload(category, file.name, file.type, file.size);
    assertFileContents(
      file.type,
      await file.arrayBuffer(),
      ATTACHMENT_FILE_TYPES,
    );
    assertAircraftFileLink(category, target);
    const url = await readDataUrl(file);
    const { name, type, size } = file;
    const details = { category, linkedKind, linkedUuid, name, type, size };
    await modify((s) => {
      assertUploadAllowed(s, target);
      s.aircraftFiles = [
        ...(s.aircraftFiles ?? []),
        {
          uuid: crypto.randomUUID(),
          aircraftUuid,
          ...details,
          uploadedAt: Date.now(),
          url,
        },
      ];
      audit(
        s,
        "aircraft.file_uploaded",
        aircraftUuid,
        aircraftUuid,
        undefined,
        undefined,
        details,
      );
    });
  },
  /**
   * Archives a current file with a reason. Status records are never deleted
   * (ADR-0004): the copy and its file stay.
   *
   * @param id - The file's uuid.
   * @param reason - Why the copy is archived; trimmed.
   * @throws {Error} "Document not found."; the writer refusals of
   *   assertAircraftFileWriter for the file's kind; and as
   *   aircraftFileArchive (already archived, missing or over-long reason).
   */
  archive(modify: Modify, audit: Audit, id: string, reason: string) {
    return modify((s) => {
      const file = s.aircraftFiles?.find((f) => f.uuid === id);
      if (!file) throw new Error("Document not found.");
      assertAircraftFileWriter(s, file.aircraftUuid, file.linkedKind);
      const archived = aircraftFileArchive(file, s.user, reason, Date.now());
      Object.assign(file, archived);
      const { category, linkedKind, linkedUuid, name, type, size } = file;
      audit(
        s,
        "aircraft.file_archived",
        file.aircraftUuid,
        file.aircraftUuid,
        archived.archiveReason,
        {
          category,
          linkedKind,
          linkedUuid,
          name,
          type,
          size,
          uploadedAt: file.uploadedAt,
        },
        { category, linkedKind, linkedUuid, name, ...archived },
      );
    });
  },
};

// The checks convex/aircraftFiles.ts makes against the stored records.
function assertUploadAllowed(s: Snapshot, target: DemoAircraftFileTarget) {
  const { aircraftUuid, category, linkedKind, linkedUuid } = target;
  assertAircraftFileWriter(s, aircraftUuid, linkedKind);
  if (linkedKind && linkedUuid)
    assertAircraftFileTarget(s, aircraftUuid, { linkedKind, linkedUuid });
  assertAircraftFileRoom(
    category,
    (s.aircraftFiles ?? []).filter(
      (f) =>
        f.aircraftUuid === aircraftUuid &&
        f.category === category &&
        isCurrentAircraftFile(f),
    ).length,
  );
}

/**
 * Reads a file into a data URL, the form the demo keeps uploaded files in.
 *
 * @returns `data:<type>;base64,<bytes>`, with the file's declared type.
 */
export async function readDataUrl(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${file.type};base64,${btoa(binary)}`;
}
