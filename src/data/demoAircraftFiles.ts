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

/** Demo mirror of convex/aircraftFiles.ts; files stay in this browser. */
export const demoAircraftFiles = {
  async upload(
    modify: Modify,
    audit: Audit,
    aircraftUuid: string,
    category: AircraftFileCategory,
    file: File,
  ) {
    validateAircraftFile(file.name, file.type, file.size);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const url = `data:${file.type};base64,${btoa(binary)}`;
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
  // Status records are never deleted (ADR-0004); the copy and its file stay.
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
