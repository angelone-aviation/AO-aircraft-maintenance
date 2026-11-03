import type { Snapshot } from "../domain/model";
import {
  assertAircraftFileRoom,
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
        (s.aircraftFiles ?? []).filter((f) => f.aircraftUuid === aircraftUuid)
          .length,
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
  remove(modify: Modify, audit: Audit, id: string) {
    return modify((s) => {
      const file = s.aircraftFiles?.find((f) => f.uuid === id);
      if (!file) throw new Error("Document not found.");
      assertAircraftFileWriter(s, file.aircraftUuid);
      s.aircraftFiles = s.aircraftFiles!.filter((f) => f.uuid !== id);
      const { url: _url, uuid: _uuid, aircraftUuid, ...before } = file;
      audit(
        s,
        "aircraft.file_removed",
        aircraftUuid,
        aircraftUuid,
        undefined,
        before,
      );
    });
  },
};
