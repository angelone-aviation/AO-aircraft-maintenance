import type { Snapshot } from "../domain/model";
import { readManualBlob, readQueue, readSnapshot } from "./local";

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () =>
      reject(new Error("Could not read an uploaded manual for backup."));
    reader.readAsDataURL(blob);
  });
}

export async function createDemoBackup(namespace: string, current: Snapshot) {
  // The visible snapshot is scoped to one program; export the full demo store.
  const snapshot =
    (await readSnapshot(namespace + ":all")) ??
    (await readSnapshot(namespace)) ??
    current;
  const pendingOperations = await readQueue(namespace);
  const manualFiles: { uuid: string; dataUrl: string }[] = [];
  const missingManualFiles: string[] = [];
  for (const manual of snapshot.manuals ?? []) {
    const file = await readManualBlob(namespace, manual.uuid);
    if (file)
      manualFiles.push({ uuid: manual.uuid, dataUrl: await blobDataUrl(file) });
    else missingManualFiles.push(manual.uuid);
  }
  return {
    format: "angel-one-demo-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    snapshot,
    pendingOperations,
    manualFiles,
    missingManualFiles,
  };
}
