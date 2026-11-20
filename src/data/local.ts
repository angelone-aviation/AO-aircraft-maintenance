/**
 * Responsibility: Keeps the device's copy of the workspace in IndexedDB:
 *   snapshots, the offline outbox, queued logbook page photos, small
 *   settings and the demo's manual files, and clears a user's share of it.
 * Layer: Data. Browser storage only; no React, no network.
 * Dependencies: idb, src/domain/model.ts (types),
 *   src/domain/workOrderCleanup.ts, src/data/logbookPhotos.ts (types).
 *
 * Records are filed under a workspace namespace ("demo", or "live:" and the
 * deployment URL). Devices already hold data under these database, store and
 * key names, so they never change; a schema change bumps the version.
 */
import {
  openDB,
  type DBSchema,
  type IDBPDatabase,
  type OpenDBCallbacks,
} from "idb";
import { cleanWorkOrderSnapshot } from "../domain/workOrderCleanup";
import type { Snapshot, QueuedOperation } from "../domain/model";
import type { PendingLogbookPhoto } from "./logbookPhotos";

interface PhotoSchema extends DBSchema {
  photos: { key: string; value: PendingLogbookPhoto & { namespace: string } };
}

interface CacheSchema extends DBSchema {
  snapshots: { key: string; value: Snapshot };
  outbox: { key: string; value: QueuedOperation & { namespace: string } };
  settings: { key: string; value: string[] };
}

const cacheDb = shareConnection<CacheSchema>(
  "angel-one-v1",
  2,
  async (db, oldVersion, _newVersion, tx) => {
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
);

// Manual PDFs live in their own database, outside cached snapshots and the
// outbox, so large files never ride along with them.
const manualDb = shareConnection<unknown>("angel-one-manuals-v1", 1, (db) => {
  db.createObjectStore("files");
});

// Queued photos are blobs too, so they stay out of the outbox database and
// never ride along with cached snapshots.
const photoDb = shareConnection<PhotoSchema>(
  "angel-one-logbook-photos-v1",
  1,
  (db) => {
    db.createObjectStore("photos");
  },
);

/**
 * Reads a namespace's cached snapshot, without the retired work-order fields
 * (see cleanWorkOrderSnapshot); a copy that held them is rewritten clean.
 *
 * @param namespace - The workspace namespace.
 * @returns The snapshot, or undefined when none is cached.
 */
export async function readSnapshot(namespace: string) {
  const connection = await cacheDb();
  const snapshot = await connection.get("snapshots", namespace);
  if (!snapshot) return undefined;
  const cleaned = cleanWorkOrderSnapshot(snapshot);
  if (JSON.stringify(cleaned) !== JSON.stringify(snapshot))
    await connection.put("snapshots", cleaned, namespace);
  return cleaned;
}

/**
 * Caches a namespace's snapshot, replacing the previous copy, without the
 * retired work-order fields.
 *
 * @param namespace - The workspace namespace.
 * @param snapshot - The snapshot to keep.
 */
export async function saveSnapshot(namespace: string, snapshot: Snapshot) {
  await (
    await cacheDb()
  ).put("snapshots", cleanWorkOrderSnapshot(snapshot), namespace);
}

/**
 * Deletes a namespace's cached snapshot; its outbox entries stay.
 *
 * @param namespace - The workspace namespace.
 */
export async function clearSnapshot(namespace: string) {
  await (await cacheDb()).delete("snapshots", namespace);
}

/**
 * Lists a namespace's pending outbox entries.
 *
 * @param namespace - The workspace namespace.
 * @returns The entries, each with its namespace, oldest `queuedAt` first.
 */
export async function readQueue(namespace: string) {
  return (await (await cacheDb()).getAll("outbox"))
    .filter((q) => q.namespace === namespace)
    .sort((a, b) => a.queuedAt - b.queuedAt);
}

/**
 * Stores an outbox entry under its operation uuid, so saving it again
 * replaces it rather than queuing a duplicate.
 *
 * @param namespace - The workspace namespace.
 * @param entry - The queued operation.
 */
export async function persistOperation(
  namespace: string,
  entry: QueuedOperation,
) {
  await (
    await cacheDb()
  ).put(
    "outbox",
    { ...entry, namespace },
    entryKey(namespace, entry.operation.uuid),
  );
}

/**
 * Deletes an outbox entry; deleting one that is gone does nothing.
 *
 * @param namespace - The workspace namespace.
 * @param uuid - The operation's uuid.
 */
export async function removeOperation(namespace: string, uuid: string) {
  await (await cacheDb()).delete("outbox", entryKey(namespace, uuid));
}

/**
 * The settings key of a user's favorite aircraft.
 *
 * @param namespace - The workspace namespace.
 * @param userId - The user.
 * @returns `<namespace>:<userId>`.
 */
export function favoritesKey(namespace: string, userId: string) {
  return `${namespace}:${userId}`;
}

/**
 * The settings key of the device copy of the alerts a user has read in one
 * Flight Program.
 *
 * @param namespace - The workspace namespace.
 * @param userId - The user.
 * @param programUuid - The active program; undefined for unassigned records.
 * @returns `<namespace>:alert-reads:<userId>:<programUuid or "">`.
 */
export function alertReadsKey(
  namespace: string,
  userId: string,
  programUuid: string | undefined,
) {
  return alertReadsPrefix(namespace, userId) + (programUuid ?? "");
}

/**
 * For sign-out: deletes what this device keeps for one user in a namespace's
 * databases: the cached snapshot, the outbox entries they recorded, the photos
 * they queued, their favorites and their read-alert lists. Other people's
 * entries and photos stay, since only their author may discard them, and so
 * do the demo's own records (its full snapshot, files and read marks).
 *
 * @param namespace - The workspace namespace.
 * @param userId - The user signing out.
 */
export async function clearUserData(namespace: string, userId: string) {
  await clearCachedUserData(namespace, userId);
  await clearQueuedPhotos(namespace, userId);
}

/**
 * Reads a list of strings kept in device settings (favorites, read alerts).
 *
 * @param key - The settings key.
 * @returns The list, or undefined when none is kept.
 */
export async function readFavorites(key: string) {
  return (await cacheDb()).get("settings", key);
}

/**
 * Keeps a list of strings in device settings, replacing the previous list.
 *
 * @param key - The settings key.
 * @param values - The list to keep.
 */
export async function saveFavorites(key: string, values: string[]) {
  await (await cacheDb()).put("settings", values, key);
}

/**
 * Stores a manual's PDF on the device, replacing any earlier copy.
 *
 * @param namespace - The workspace namespace.
 * @param uuid - The manual's uuid.
 * @param file - The PDF.
 */
export async function saveManualBlob(
  namespace: string,
  uuid: string,
  file: Blob,
) {
  await (await manualDb()).put("files", file, entryKey(namespace, uuid));
}

/**
 * Reads a manual's PDF stored on the device.
 *
 * @param namespace - The workspace namespace.
 * @param uuid - The manual's uuid.
 * @returns The PDF, or undefined when none is stored.
 */
export async function readManualBlob(
  namespace: string,
  uuid: string,
): Promise<Blob | undefined> {
  return (await manualDb()).get("files", entryKey(namespace, uuid));
}

/**
 * Lists a namespace's logbook page photos waiting to upload.
 *
 * @param namespace - The workspace namespace.
 * @returns The photos, oldest `queuedAt` first.
 */
export async function readPendingPhotos(
  namespace: string,
): Promise<PendingLogbookPhoto[]> {
  return (await (await photoDb()).getAll("photos"))
    .filter((p) => p.namespace === namespace)
    .sort((a, b) => a.queuedAt - b.queuedAt);
}

/**
 * Stores a queued photo under its key, so saving it again (with the server's
 * refusal) replaces it rather than queuing a duplicate.
 *
 * @param namespace - The workspace namespace.
 * @param photo - The queued photo, bytes included.
 */
export async function savePendingPhoto(
  namespace: string,
  photo: PendingLogbookPhoto,
) {
  await (
    await photoDb()
  ).put("photos", { ...photo, namespace }, entryKey(namespace, photo.key));
}

/**
 * Deletes a queued photo; deleting one that is gone does nothing.
 *
 * @param namespace - The workspace namespace.
 * @param key - The photo's key.
 */
export async function removePendingPhoto(namespace: string, key: string) {
  await (await photoDb()).delete("photos", entryKey(namespace, key));
}

// One shared connection per database. A newer tab's upgrade (blocking) or a
// browser-side shutdown (terminated) drops the memo so the next call reopens;
// so does a failed open.
function shareConnection<Schema extends DBSchema | unknown>(
  name: string,
  version: number,
  upgrade: OpenDBCallbacks<Schema>["upgrade"],
): () => Promise<IDBPDatabase<Schema>> {
  let connection: Promise<IDBPDatabase<Schema>> | undefined;
  return () =>
    (connection ??= openDB<Schema>(name, version, {
      blocking(_current, _blocked, event) {
        (event.target as IDBDatabase).close();
        connection = undefined;
      },
      terminated() {
        connection = undefined;
      },
      upgrade,
    }).catch((error: unknown) => {
      connection = undefined;
      throw error;
    }));
}

function entryKey(namespace: string, uuid: string): string {
  return namespace + ":" + uuid;
}

function alertReadsPrefix(namespace: string, userId: string) {
  return `${namespace}:alert-reads:${userId}:`;
}

// One transaction, so a sign-out never leaves the snapshot gone but the
// outbox or settings half cleared.
async function clearCachedUserData(namespace: string, userId: string) {
  const tx = (await cacheDb()).transaction(
    ["snapshots", "outbox", "settings"],
    "readwrite",
  );
  const settings = tx.objectStore("settings");
  const reads = alertReadsPrefix(namespace, userId);
  for (const key of await settings.getAllKeys())
    if (key.startsWith(reads)) await settings.delete(key);
  await settings.delete(favoritesKey(namespace, userId));
  await tx.objectStore("snapshots").delete(namespace);
  let cursor = await tx.objectStore("outbox").openCursor();
  while (cursor) {
    const { namespace: owner, operation } = cursor.value;
    if (owner === namespace && operation.authorId === userId)
      await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

async function clearQueuedPhotos(namespace: string, userId: string) {
  const tx = (await photoDb()).transaction("photos", "readwrite");
  let cursor = await tx.store.openCursor();
  while (cursor) {
    if (
      cursor.value.namespace === namespace &&
      cursor.value.authorId === userId
    )
      await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}
