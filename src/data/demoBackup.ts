/**
 * Responsibility: Exports the demo's whole device store as one JSON backup:
 *   the full snapshot, pending outbox entries and uploaded manual files.
 * Layer: Data. Browser-only (FileReader, IndexedDB); no React.
 * Dependencies: src/data/local.ts, src/domain/model.ts (types).
 */
import type { Snapshot } from "../domain/model";
import { readManualBlob, readQueue, readSnapshot } from "./local";

const BACKUP_FORMAT = "angel-one-demo-backup";
const BACKUP_VERSION = 1;
// The demo's full snapshot; the visible one is scoped to one program.
const DEMO_FULL_SUFFIX = ":all";

/**
 * Collects the demo backup for a namespace.
 *
 * @param namespace - The demo's device-cache namespace.
 * @param current - The visible snapshot, used when nothing is cached.
 * @returns The backup: format, version and export time, the full demo
 *   snapshot (else the cached scoped one, else `current`), the outbox, each
 *   stored manual as a data URL, and the uuids of manuals with no stored file.
 * @throws {Error} "Could not read an uploaded manual for backup." when a
 *   stored manual cannot be read.
 */
export async function createDemoBackup(namespace: string, current: Snapshot) {
  const snapshot =
    (await readSnapshot(namespace + DEMO_FULL_SUFFIX)) ??
    (await readSnapshot(namespace)) ??
    current;
  const pendingOperations = await readQueue(namespace);
  const manualFiles: { uuid: string; dataUrl: string }[] = [];
  const missingManualFiles: string[] = [];
  for (const manual of snapshot.manuals ?? []) {
    const file = await readManualBlob(namespace, manual.uuid);
    if (file)
      manualFiles.push({ uuid: manual.uuid, dataUrl: await readDataUrl(file) });
    else missingManualFiles.push(manual.uuid);
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    snapshot,
    pendingOperations,
    manualFiles,
    missingManualFiles,
  };
}

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () =>
      reject(new Error("Could not read an uploaded manual for backup."));
    reader.readAsDataURL(blob);
  });
}
