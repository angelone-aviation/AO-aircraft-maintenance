import { cleanWorkOrderSnapshot } from "../domain/workOrderCleanup";
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Snapshot, QueuedOperation } from "../domain/model";
interface CacheSchema extends DBSchema {
  snapshots: { key: string; value: Snapshot };
  outbox: { key: string; value: QueuedOperation & { namespace: string } };
  settings: { key: string; value: string[] };
}
// One shared connection per database. A newer tab's upgrade (blocking) or a
// browser-side shutdown (terminated) drops the memo so the next call reopens.
let cacheDb: Promise<IDBPDatabase<CacheSchema>> | undefined;
const db = () =>
  (cacheDb ??= openDB<CacheSchema>("angel-one-v1", 2, {
    blocking(_current, _blocked, event) {
      (event.target as IDBDatabase).close();
      cacheDb = undefined;
    },
    terminated() {
      cacheDb = undefined;
    },
    async upgrade(db, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        db.createObjectStore("snapshots");
        db.createObjectStore("outbox");
        db.createObjectStore("settings");
      }
      if (oldVersion < 2) {
        let cursor = await tx.objectStore("snapshots").openCursor();
        while (cursor) {
          await cursor.update(cleanWorkOrderSnapshot(cursor.value));
          cursor = await cursor.continue();
        }
      }
    },
  }).catch((error: unknown) => {
    cacheDb = undefined;
    throw error;
  }));
export async function readSnapshot(namespace: string) {
  const connection = await db();
  const snapshot = await connection.get("snapshots", namespace);
  if (!snapshot) return undefined;
  const cleaned = cleanWorkOrderSnapshot(snapshot);
  if (JSON.stringify(cleaned) !== JSON.stringify(snapshot))
    await connection.put("snapshots", cleaned, namespace);
  return cleaned;
}
export async function saveSnapshot(namespace: string, snapshot: Snapshot) {
  await (
    await db()
  ).put("snapshots", cleanWorkOrderSnapshot(snapshot), namespace);
}
export async function clearSnapshot(namespace: string) {
  await (await db()).delete("snapshots", namespace);
}
export async function readQueue(namespace: string) {
  return (await (await db()).getAll("outbox"))
    .filter((q) => q.namespace === namespace)
    .sort((a, b) => a.queuedAt - b.queuedAt);
}
export async function persistOperation(
  namespace: string,
  entry: QueuedOperation,
) {
  await (
    await db()
  ).put(
    "outbox",
    { ...entry, namespace },
    namespace + ":" + entry.operation.uuid,
  );
}
export async function removeOperation(namespace: string, uuid: string) {
  await (await db()).delete("outbox", namespace + ":" + uuid);
}
export async function readFavorites(key: string) {
  return (await db()).get("settings", key);
}
export async function saveFavorites(key: string, values: string[]) {
  await (await db()).put("settings", values, key);
}

// Keep large PDFs outside cached snapshots and synchronization payloads.
let manualConnection: Promise<IDBPDatabase> | undefined;
const manualDb = () =>
  (manualConnection ??= openDB("angel-one-manuals-v1", 1, {
    blocking(_current, _blocked, event) {
      (event.target as IDBDatabase).close();
      manualConnection = undefined;
    },
    terminated() {
      manualConnection = undefined;
    },
    upgrade(db) {
      db.createObjectStore("files");
    },
  }).catch((error: unknown) => {
    manualConnection = undefined;
    throw error;
  }));
export async function saveManualBlob(
  namespace: string,
  uuid: string,
  file: Blob,
) {
  await (await manualDb()).put("files", file, namespace + ":" + uuid);
}
export async function readManualBlob(
  namespace: string,
  uuid: string,
): Promise<Blob | undefined> {
  return (await manualDb()).get("files", namespace + ":" + uuid);
}
