/**
 * Responsibility: Uploads and archives aircraft status-record files (Form
 *   337 copies) in demo mode, mirroring convex/aircraftFiles.ts.
 * Layer: Data. Demo adapter helper; files stay in this browser.
 * Dependencies: src/domain/aircraftFiles.ts, src/domain/model.ts (types).
 */
import type { Snapshot } from "../domain/model";
import {
  aircraftFileArchive,
  assertAircraftFileRoom,
  isCurrentAircraftFile,
  assertAircraftFileWriter,
  validateAircraftFile,
  type AircraftFileCategory,
} from "../domain/aircraftFiles";

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

/**
 * The demo adapter's aircraft file methods. Each runs inside the adapter's
 * `modify` transaction and records one change-log entry through `audit`.
 */
export const demoAircraftFiles = {
  /**
   * Keeps a file on the aircraft as a data URL in the demo snapshot.
   *
   * @param aircraftUuid - The aircraft the file belongs to.
   * @param category - The kind of status record, such as "form-337".
   * @param file - The uploaded file.
   * @throws {Error} As validateAircraftFile for the file; "Aircraft
   *   maintenance permission required."; "This aircraft already has the
   *   maximum of 200 current documents."
   */
  async upload(
    modify: Modify,
    audit: Audit,
    aircraftUuid: string,
    category: AircraftFileCategory,
    file: File,
  ) {
    validateAircraftFile(file.name, file.type, file.size);
    const url = await readDataUrl(file);
    await modify((s) => {
      assertAircraftFileWriter(s, aircraftUuid);
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
        { category, name: file.name, type: file.type, size: file.size },
      );
    });
  },
  /**
   * Archives a current file with a reason. Status records are never deleted
   * (ADR-0004): the copy and its file stay.
   *
   * @param id - The file's uuid.
   * @param reason - Why the copy is archived; trimmed.
   * @throws {Error} "Document not found."; "Aircraft maintenance permission
   *   required."; and as aircraftFileArchive (already archived, missing or
   *   over-long reason).
   */
  archive(modify: Modify, audit: Audit, id: string, reason: string) {
    return modify((s) => {
      const file = s.aircraftFiles?.find((f) => f.uuid === id);
      if (!file) throw new Error("Document not found.");
      assertAircraftFileWriter(s, file.aircraftUuid);
      const archived = aircraftFileArchive(file, s.user, reason, Date.now());
      Object.assign(file, archived);
      const { category, name, type, size, uploadedAt } = file;
      audit(
        s,
        "aircraft.file_archived",
        file.aircraftUuid,
        file.aircraftUuid,
        archived.archiveReason,
        { category, name, type, size, uploadedAt },
        { category, name, ...archived },
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
