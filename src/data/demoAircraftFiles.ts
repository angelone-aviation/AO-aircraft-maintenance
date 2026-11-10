/**
 * Responsibility: Uploads and archives aircraft record documents (Form 337
 *   copies and logbook page photos) in demo mode, mirroring
 *   convex/aircraftFiles.ts.
 * Layer: Data. Demo adapter helper; files stay in this browser.
 * Dependencies: src/domain/aircraftFiles.ts, src/domain/inventoryAttachments.ts,
 *   src/domain/model.ts (types).
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
import { assertFileContents } from "../domain/inventoryAttachments";

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
   *   the file; the link
   *   refusals of assertAircraftFileLink; "Aircraft flight permission
   *   required." or "Aircraft maintenance permission required."; "Flight
   *   not found." or "Work order not found."; "This aircraft already has
   *   the maximum of 200 current documents."
   */
  async upload(
    modify: Modify,
    audit: Audit,
    target: DemoAircraftFileTarget,
    file: File,
  ) {
    const { aircraftUuid, category, linkedKind, linkedUuid } = target;
    validateAircraftUpload(category, file.name, file.type, file.size);
    assertFileContents(file.type, await file.arrayBuffer());
    assertAircraftFileLink(category, target);
    const url = await readDataUrl(file);
    await modify((s) => {
      assertAircraftFileWriter(s, aircraftUuid, linkedKind);
      if (linkedKind && linkedUuid)
        assertAircraftFileTarget(s, aircraftUuid, { linkedKind, linkedUuid });
      assertAircraftFileRoom(
        (s.aircraftFiles ?? []).filter(
          (f) => f.aircraftUuid === aircraftUuid && isCurrentAircraftFile(f),
        ).length,
      );
      s.aircraftFiles = [
        ...(s.aircraftFiles ?? []),
        {
          uuid: crypto.randomUUID(),
          aircraftUuid,
          category,
          linkedKind,
          linkedUuid,
          name: file.name,
          type: file.type,
          size: file.size,
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
        {
          category,
          linkedKind,
          linkedUuid,
          name: file.name,
          type: file.type,
          size: file.size,
        },
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

async function readDataUrl(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${file.type};base64,${btoa(binary)}`;
}
