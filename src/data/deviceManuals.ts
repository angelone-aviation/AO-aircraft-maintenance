import { can, type Snapshot } from "../domain/model";

/**
 * Reference manuals a user chose to keep on this device ("Keep on this
 * device"), so they open instantly and without a connection.
 *
 * Copies live in Cache Storage: one cache per deployment namespace and user,
 * following the namespacing of src/data/local.ts, with each entry keyed by the
 * manual's UUID, never by the temporary signed file URL. Manuals are
 * immutable records (a new revision is a new record), so the UUID and the
 * recorded size identify the file completely.
 *
 * The device copy never widens access. Reads and listings check the caller's
 * current snapshot and serve a copy only for a manual in that snapshot which
 * the user may read. reconcileKeptManuals() deletes everything else (and any
 * other user's copies) whenever the snapshot changes, and sign-out removes
 * every copy kept for the deployment.
 */
const CACHE_PREFIX = "angel-one-kept-manuals-v1 ";
// Entry keys only; `.invalid` never resolves, so nothing can fetch them.
const KEY_ORIGIN = "https://kept-manuals.angel-one.invalid/";
const PDF = "application/pdf";
const UUID_HEADER = "X-Manual-Uuid";
const SIZE_HEADER = "X-Manual-Size";
const KEPT_AT_HEADER = "X-Kept-At";

export interface KeptManual {
  uuid: string;
  size: number;
  keptAt: number;
}
export type DeviceStorageErrorKind =
  | "unsupported"
  | "access"
  | "quota"
  | "download"
  | "incomplete"
  | "canceled"
  | "storage";
export class DeviceStorageError extends Error {
  readonly kind: DeviceStorageErrorKind;
  constructor(kind: DeviceStorageErrorKind, message: string) {
    super(message);
    this.name = "DeviceStorageError";
    this.kind = kind;
  }
}

export function formatBytes(bytes: number) {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

function cacheStorage(): CacheStorage | undefined {
  try {
    return (globalThis as { caches?: CacheStorage }).caches ?? undefined;
  } catch {
    return undefined; // Some private modes throw on access.
  }
}
function deviceStorage(): Partial<StorageManager> | undefined {
  try {
    return (globalThis as { navigator?: { storage?: StorageManager } })
      .navigator?.storage;
  } catch {
    return undefined;
  }
}
export function keptManualsSupported() {
  return !!cacheStorage();
}

const cacheName = (namespace: string, userId: string) =>
  CACHE_PREFIX + JSON.stringify([namespace, userId]);
function namespaceOf(name: string) {
  if (!name.startsWith(CACHE_PREFIX)) return undefined;
  try {
    const parts: unknown = JSON.parse(name.slice(CACHE_PREFIX.length));
    return Array.isArray(parts) &&
      parts.length === 2 &&
      typeof parts[0] === "string"
      ? parts[0]
      : undefined;
  } catch {
    return undefined;
  }
}
const entryUrl = (uuid: string) => KEY_ORIGIN + encodeURIComponent(uuid);
const uuidOf = (url: string) =>
  url.startsWith(KEY_ORIGIN)
    ? decodeURIComponent(url.slice(KEY_ORIGIN.length))
    : undefined;
/** The snapshot's manual, if the snapshot's user may read it. */
function readable(snapshot: Snapshot, uuid: string) {
  const manual = snapshot.manuals?.find((m) => m.uuid === uuid);
  return manual && can(snapshot, manual.aircraftUuid, "read")
    ? manual
    : undefined;
}

const listeners = new Set<() => void>();
/** Called after any copy is added or removed, including purges. */
export function onKeptManualsChange(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function changed() {
  for (const listener of listeners)
    try {
      listener();
    } catch {
      // A listener's failure must not stop the others.
    }
}

// Downloads in progress, so sign-out and access changes stop them before
// they can store anything.
type Download = { name: string; uuid: string; controller: AbortController };
const active = new Set<Download>();
function abortWhere(match: (download: Download) => boolean) {
  for (const download of active)
    if (match(download)) download.controller.abort();
}
async function dropIfEmpty(storage: CacheStorage, name: string, cache: Cache) {
  if (![...active].some((d) => d.name === name) && !(await cache.keys()).length)
    await storage.delete(name);
}

/** Whether this device holds any kept manual (for any deployment). */
export async function hasKeptManuals() {
  try {
    const names = (await cacheStorage()?.keys()) ?? [];
    return names.some((name) => namespaceOf(name) !== undefined);
  } catch {
    return false;
  }
}

/** Copies the current user may still open, from their cache only. */
export async function listKeptManuals(
  namespace: string,
  snapshot: Snapshot,
): Promise<KeptManual[]> {
  const storage = cacheStorage();
  if (!storage) return [];
  try {
    const name = cacheName(namespace, snapshot.user.id);
    if (!(await storage.has(name))) return [];
    const cache = await storage.open(name);
    const kept: KeptManual[] = [];
    for (const request of await cache.keys()) {
      const headers = (await cache.match(request))?.headers;
      const uuid = headers?.get(UUID_HEADER) ?? "";
      const size = Number(headers?.get(SIZE_HEADER));
      if (readable(snapshot, uuid)?.size === size)
        kept.push({ uuid, size, keptAt: Number(headers?.get(KEPT_AT_HEADER)) });
    }
    return kept;
  } catch {
    return [];
  }
}

/**
 * The device copy of a manual the user may read, or undefined when there is
 * none or it cannot be read; callers then use the online file. Never touches
 * the network. A copy of the wrong size is deleted.
 */
export async function readKeptManual(
  namespace: string,
  snapshot: Snapshot,
  uuid: string,
): Promise<Blob | undefined> {
  const manual = readable(snapshot, uuid);
  const storage = cacheStorage();
  if (!manual || !storage) return undefined;
  try {
    const name = cacheName(namespace, snapshot.user.id);
    if (!(await storage.has(name))) return undefined;
    const cache = await storage.open(name);
    const response = await cache.match(entryUrl(uuid));
    if (!response) return undefined;
    const blob = await response.blob();
    if (blob.size === manual.size)
      return blob.type === PDF ? blob : blob.slice(0, blob.size, PDF);
    await cache.delete(entryUrl(uuid));
    changed();
  } catch {
    // Unreadable: treated as missing.
  }
  return undefined;
}

const quotaError = (needed: number, available?: number) =>
  new DeviceStorageError(
    "quota",
    `Not enough storage on this device to keep this manual (${formatBytes(needed)} needed${available === undefined ? "" : `, ${formatBytes(available)} available`}). Remove other manuals from this device or free up space, then try again.`,
  );
function isQuotaError(error: unknown) {
  const { name, code } = (error ?? {}) as { name?: unknown; code?: unknown };
  return (
    name === "QuotaExceededError" ||
    name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    code === 22
  );
}

export interface KeepOptions {
  namespace: string;
  snapshot: Snapshot;
  uuid: string;
  /** Fetches the file through the existing authorized path (backend.openManual). */
  download: (signal: AbortSignal) => Promise<Response>;
  signal?: AbortSignal;
  onProgress?: (received: number, total: number) => void;
}
/**
 * Downloads a manual once and stores it for this user and deployment. The
 * body streams straight into Cache Storage, so a large manual is never held
 * in memory; it is kept only when exactly the recorded number of bytes
 * arrived.
 */
export async function keepManual(options: KeepOptions): Promise<KeptManual> {
  const { namespace, snapshot, signal, onProgress } = options;
  const storage = cacheStorage();
  if (!storage)
    throw new DeviceStorageError(
      "unsupported",
      "This browser cannot keep manuals on this device. Open them online instead.",
    );
  const manual = readable(snapshot, options.uuid);
  if (!manual)
    throw new DeviceStorageError(
      "access",
      "This manual is not available to you in the active Flight Program.",
    );
  const name = cacheName(namespace, snapshot.user.id);
  const url = entryUrl(manual.uuid);
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (signal?.aborted) stop();
  else signal?.addEventListener("abort", stop, { once: true });
  const download = { name, uuid: manual.uuid, controller };
  active.add(download);
  const canceled = () =>
    new DeviceStorageError("canceled", "Keeping this manual was canceled.");
  const incomplete = () =>
    new DeviceStorageError(
      "incomplete",
      "The download was incomplete, so the manual was not kept. Try again.",
    );
  const unreachable = () =>
    new DeviceStorageError(
      "download",
      "The manual could not be downloaded. Check the connection and try again.",
    );
  const keptAt = Date.now();
  try {
    const { usage, quota } = await keptStorage();
    if (
      usage !== undefined &&
      quota !== undefined &&
      quota - usage < manual.size
    )
      throw quotaError(manual.size, Math.max(0, quota - usage));
    if (controller.signal.aborted) throw canceled();
    let response: Response;
    try {
      response = await options.download(controller.signal);
    } catch {
      throw controller.signal.aborted ? canceled() : unreachable();
    }
    if (!response.ok || !response.body) throw unreachable();
    let received = 0;
    let failure: DeviceStorageError | undefined;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, stream) {
          if (controller.signal.aborted) throw (failure = canceled());
          received += chunk.byteLength;
          if (received > manual.size) throw (failure = incomplete());
          stream.enqueue(chunk);
          onProgress?.(received, manual.size);
        },
      }),
      // Cancel at once, even while the network is stalled.
      { signal: controller.signal },
    );
    const cache = await storage.open(name);
    try {
      await cache.put(
        url,
        new Response(body, {
          headers: {
            "Content-Type": PDF,
            [UUID_HEADER]: manual.uuid,
            [SIZE_HEADER]: String(manual.size),
            [KEPT_AT_HEADER]: String(keptAt),
          },
        }),
      );
    } catch (error) {
      await cache.delete(url).catch(() => false);
      if (controller.signal.aborted) throw canceled();
      if (failure) throw failure;
      if (isQuotaError(error)) throw quotaError(manual.size);
      if (error instanceof DeviceStorageError) throw error;
      throw new DeviceStorageError(
        "storage",
        "The manual could not be saved on this device. Try again.",
      );
    }
    if (controller.signal.aborted || received !== manual.size) {
      await cache.delete(url).catch(() => false);
      await dropIfEmpty(storage, name, cache).catch(() => undefined);
      throw controller.signal.aborted ? canceled() : incomplete();
    }
  } finally {
    active.delete(download);
    signal?.removeEventListener("abort", stop);
  }
  changed();
  return { uuid: manual.uuid, size: manual.size, keptAt };
}

/** Removes one manual from this device on request. */
export async function removeKeptManual(
  namespace: string,
  snapshot: Snapshot,
  uuid: string,
) {
  const name = cacheName(namespace, snapshot.user.id);
  abortWhere((d) => d.name === name && d.uuid === uuid);
  const storage = cacheStorage();
  if (!storage) return;
  try {
    if (await storage.has(name)) {
      const cache = await storage.open(name);
      await cache.delete(entryUrl(uuid));
      await dropIfEmpty(storage, name, cache);
    }
  } catch {
    throw new DeviceStorageError(
      "storage",
      "The manual could not be removed from this device. Try again.",
    );
  } finally {
    changed();
  }
}

/**
 * Sign-out and ended sessions: removes every manual kept for this deployment
 * on this device, for every user, and stops downloads in progress.
 */
export async function removeAllKeptManuals(namespace: string): Promise<void> {
  abortWhere((d) => namespaceOf(d.name) === namespace);
  const storage = cacheStorage();
  try {
    for (const name of storage ? await storage.keys() : [])
      if (namespaceOf(name) === namespace) await storage!.delete(name);
  } catch {
    // Storage that cannot be listed holds nothing this app can serve.
  }
  changed();
}

/**
 * Keeps only what the active snapshot allows: manuals still in it that its
 * user may read (removing those whose access was revoked, whose aircraft was
 * transferred, or whose program was switched away), and no other user's
 * copies for this deployment.
 */
export async function reconcileKeptManuals(
  namespace: string,
  snapshot: Snapshot,
): Promise<void> {
  const own = cacheName(namespace, snapshot.user.id);
  abortWhere(
    (d) =>
      namespaceOf(d.name) === namespace &&
      (d.name !== own || !readable(snapshot, d.uuid)),
  );
  const storage = cacheStorage();
  if (!storage) return;
  let removed = false;
  try {
    for (const name of await storage.keys()) {
      if (namespaceOf(name) !== namespace) continue;
      if (name !== own) {
        removed = (await storage.delete(name)) || removed;
        continue;
      }
      const cache = await storage.open(name);
      for (const request of await cache.keys()) {
        const uuid = uuidOf(request.url);
        if (uuid && readable(snapshot, uuid)) continue;
        removed = (await cache.delete(request)) || removed;
      }
      await dropIfEmpty(storage, name, cache);
    }
  } catch {
    // Retried on the next snapshot; reads check access regardless.
  }
  if (removed) changed();
}

/** Space used and allowed for this app, and whether it is protected. */
export async function keptStorage(): Promise<{
  usage?: number;
  quota?: number;
  persisted?: boolean;
}> {
  const storage = deviceStorage();
  const result: { usage?: number; quota?: number; persisted?: boolean } = {};
  try {
    const estimate = await storage?.estimate?.();
    if (estimate?.usage !== undefined) result.usage = estimate.usage;
    if (estimate?.quota !== undefined) result.quota = estimate.quota;
  } catch {
    // Not available in this browser.
  }
  try {
    if (storage?.persisted) result.persisted = await storage.persisted();
  } catch {
    // Not available in this browser.
  }
  return result;
}

/**
 * Asks the browser to protect this app's storage from automatic clean-up
 * when the device runs low, unless it already is.
 */
export async function requestPersistentStorage(): Promise<boolean | undefined> {
  const storage = deviceStorage();
  if (!storage?.persist) return undefined;
  try {
    if (await storage.persisted?.()) return true;
    return await storage.persist();
  } catch {
    return undefined;
  }
}
