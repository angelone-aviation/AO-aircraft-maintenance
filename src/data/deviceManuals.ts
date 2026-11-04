/**
 * Responsibility: Keeps the reference manuals a user chose to keep on this
 *   device, so they open at once and offline, without ever widening access.
 * Layer: Data. Browser Cache Storage and StorageManager; no React.
 * Dependencies: src/domain/model.ts, src/domain/manuals.ts (types).
 *
 * One cache per deployment namespace and user (as in src/data/local.ts), each
 * entry keyed by manual UUID, never by the temporary signed file URL. Manuals
 * are immutable (a new revision is a new record), so the UUID and recorded
 * size identify the file. Reads and listings serve only manuals in the
 * caller's snapshot that they may read; reconcileKeptManuals() deletes the
 * rest, and sign-out deletes every copy kept for the deployment.
 */
import { can, type Snapshot } from "../domain/model";
import type { Manual } from "../domain/manuals";

const CACHE_PREFIX = "angel-one-kept-manuals-v1 ";
// Entry keys only; `.invalid` never resolves, so nothing can fetch them.
const KEY_ORIGIN = "https://kept-manuals.angel-one.invalid/";
const PDF = "application/pdf";
const UUID_HEADER = "X-Manual-Uuid";
const SIZE_HEADER = "X-Manual-Size";
const KEPT_AT_HEADER = "X-Kept-At";
// Legacy DOMException.QUOTA_EXCEEDED_ERR, all some older browsers set.
const LEGACY_QUOTA_CODE = 22;

/** A manual kept on this device, with when it was stored (epoch ms). */
export interface KeptManual {
  uuid: string;
  size: number;
  keptAt: number;
}

/**
 * Why a device copy could not be kept or removed: `unsupported` (no Cache
 * Storage), `access`, `quota`, `download` (fetch failed), `incomplete` (byte
 * count differs from the record), `canceled` or `storage` (cache write failed).
 */
export type DeviceStorageErrorKind =
  | "unsupported"
  | "access"
  | "quota"
  | "download"
  | "incomplete"
  | "canceled"
  | "storage";

/** A refusal or failure with a message for the user and a kind for the UI. */
export class DeviceStorageError extends Error {
  readonly kind: DeviceStorageErrorKind;
  constructor(kind: DeviceStorageErrorKind, message: string) {
    super(message);
    this.name = "DeviceStorageError";
    this.kind = kind;
  }
}

/**
 * Formats a byte count for people, in binary units.
 *
 * @param bytes - The count to show.
 * @returns One decimal place: "MB" below 1,024 MB, otherwise "GB".
 */
export function formatBytes(bytes: number) {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

/** Whether this browser can keep manuals at all (has Cache Storage). */
export function keptManualsSupported() {
  return !!cacheStorage();
}

/**
 * Subscribes to changes in what this device holds.
 *
 * @param listener - Called after any copy is added or removed, purges
 *   included; a listener that throws does not stop the others.
 * @returns A function that unsubscribes.
 */
export function onKeptManualsChange(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Whether this device holds any kept manual, for any deployment or user.
 *
 * @returns False too when storage cannot be listed.
 */
export async function hasKeptManuals() {
  try {
    const names = (await cacheStorage()?.keys()) ?? [];
    return names.some((name) => namespaceOf(name) !== undefined);
  } catch {
    return false;
  }
}

/**
 * Lists the copies the snapshot's user may still open, from their cache only.
 *
 * @param namespace - Deployment namespace, as in src/data/local.ts.
 * @param snapshot - The active snapshot; its user owns the cache.
 * @returns Copies in cache order whose manual is readable and whose stored
 *   size matches its record; empty when storage is missing or unreadable.
 */
export async function listKeptManuals(
  namespace: string,
  snapshot: Snapshot,
): Promise<KeptManual[]> {
  try {
    return await listReadableCopies(namespace, snapshot);
  } catch {
    return [];
  }
}

/**
 * Reads the device copy of a manual the user may read, without the network.
 *
 * @param namespace - Deployment namespace.
 * @param snapshot - The active snapshot; its user owns the cache.
 * @param uuid - The manual.
 * @returns The file as a PDF blob, or undefined when there is no readable
 *   copy; callers then open the online file. A copy of the wrong size is
 *   deleted, and listeners are told.
 */
export async function readKeptManual(
  namespace: string,
  snapshot: Snapshot,
  uuid: string,
): Promise<Blob | undefined> {
  const manual = readable(snapshot, uuid);
  if (!manual) return undefined;
  try {
    return await readCopy(namespace, snapshot, manual);
  } catch {
    // Unreadable: treated as missing.
    return undefined;
  }
}

/** What keepManual needs to download and store one manual. */
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
 * Downloads a manual once and keeps it for this user and deployment. The body
 * streams straight into Cache Storage, so a large manual is never held in
 * memory, and it is kept only when exactly the recorded size arrived.
 *
 * @param options - The manual, its download and progress callbacks.
 * @returns The kept copy; listeners are told.
 * @throws {DeviceStorageError} Of kind `unsupported` or `access` before any
 *   download; `quota`, `download`, `incomplete`, `canceled` or `storage` after
 *   which nothing is kept. Sign-out and lost access cancel it.
 */
export async function keepManual(options: KeepOptions): Promise<KeptManual> {
  const { namespace, snapshot, signal } = options;
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
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (signal?.aborted) stop();
  else signal?.addEventListener("abort", stop, { once: true });
  const download = { name, uuid: manual.uuid, controller };
  active.add(download);
  const kept = { uuid: manual.uuid, size: manual.size, keptAt: Date.now() };
  try {
    await storeCopy(storage, download, kept, options);
  } finally {
    active.delete(download);
    signal?.removeEventListener("abort", stop);
  }
  changed();
  return kept;
}

/**
 * Removes one manual from this device on request, stopping its download if
 * one is in progress. Listeners are told, even when removal fails.
 *
 * @param namespace - Deployment namespace.
 * @param snapshot - The active snapshot; its user owns the cache.
 * @param uuid - The manual.
 * @throws {DeviceStorageError} Of kind `storage` when the cache cannot be
 *   changed.
 */
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
 * For sign-out and ended sessions: removes every manual kept for this
 * deployment on this device, for every user, and stops downloads in progress.
 * Never throws; listeners are told.
 *
 * @param namespace - Deployment namespace.
 */
export async function removeAllKeptManuals(namespace: string): Promise<void> {
  abortWhere((d) => namespaceOf(d.name) === namespace);
  try {
    await deleteNamespace(namespace);
  } catch {
    // Storage that cannot be listed holds nothing this app can serve.
  }
  changed();
}

/**
 * Keeps only what the active snapshot allows: its user's copies of manuals
 * still in it that they may read. Removes copies whose access was revoked,
 * whose aircraft was transferred or whose program was switched away, and
 * every other user's copies for this deployment, stopping their downloads.
 * Never throws; listeners are told when anything was removed.
 *
 * @param namespace - Deployment namespace.
 * @param snapshot - The active snapshot.
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
  const purge = { removed: false };
  try {
    await purgeNamespace(storage, namespace, snapshot, purge);
  } catch {
    // Retried on the next snapshot; reads check access regardless.
  }
  if (purge.removed) changed();
}

/** Device storage for this app, as far as the browser reports it. */
interface StorageReport {
  usage?: number;
  quota?: number;
  persisted?: boolean;
}

/**
 * Reports space used and allowed for this app, and whether the browser
 * protects it from automatic clean-up.
 *
 * @returns Only the fields this browser can report.
 */
export async function keptStorage(): Promise<StorageReport> {
  const storage = deviceStorage();
  const result: StorageReport = {};
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
 *
 * @returns Whether storage is protected; undefined where the browser cannot
 *   say or ask.
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

// Some private browsing modes throw on reading these globals.
function cacheStorage(): CacheStorage | undefined {
  try {
    return (globalThis as { caches?: CacheStorage }).caches ?? undefined;
  } catch {
    return undefined;
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

function cacheName(namespace: string, userId: string) {
  return CACHE_PREFIX + JSON.stringify([namespace, userId]);
}

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

function entryUrl(uuid: string) {
  return KEY_ORIGIN + encodeURIComponent(uuid);
}

function uuidOf(url: string) {
  return url.startsWith(KEY_ORIGIN)
    ? decodeURIComponent(url.slice(KEY_ORIGIN.length))
    : undefined;
}

/** The snapshot's manual, if the snapshot's user may read it. */
function readable(snapshot: Snapshot, uuid: string) {
  const manual = snapshot.manuals?.find((m) => m.uuid === uuid);
  return manual && can(snapshot, manual.aircraftUuid, "read")
    ? manual
    : undefined;
}

const listeners = new Set<() => void>();

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

async function openOwnCache(namespace: string, snapshot: Snapshot) {
  const storage = cacheStorage();
  const name = cacheName(namespace, snapshot.user.id);
  if (!storage || !(await storage.has(name))) return undefined;
  return storage.open(name);
}

async function listReadableCopies(namespace: string, snapshot: Snapshot) {
  const cache = await openOwnCache(namespace, snapshot);
  if (!cache) return [];
  const kept: KeptManual[] = [];
  for (const request of await cache.keys()) {
    const headers = (await cache.match(request))?.headers;
    const uuid = headers?.get(UUID_HEADER) ?? "";
    const size = Number(headers?.get(SIZE_HEADER));
    if (readable(snapshot, uuid)?.size === size)
      kept.push({ uuid, size, keptAt: Number(headers?.get(KEPT_AT_HEADER)) });
  }
  return kept;
}

async function readCopy(namespace: string, snapshot: Snapshot, manual: Manual) {
  const cache = await openOwnCache(namespace, snapshot);
  if (!cache) return undefined;
  const response = await cache.match(entryUrl(manual.uuid));
  if (!response) return undefined;
  const blob = await response.blob();
  if (blob.size === manual.size)
    return blob.type === PDF ? blob : blob.slice(0, blob.size, PDF);
  await cache.delete(entryUrl(manual.uuid));
  changed();
  return undefined;
}

// Bytes that passed through a download, and why it was stopped, if it was.
interface Tally {
  received: number;
  failure?: DeviceStorageError;
}

async function storeCopy(
  storage: CacheStorage,
  { name, controller }: Download,
  kept: KeptManual,
  options: KeepOptions,
) {
  const { signal } = controller;
  await assertRoomFor(kept.size);
  if (signal.aborted) throw canceledError();
  const source = await fetchCopy(options.download, signal);
  const tally: Tally = { received: 0 };
  const body = source.pipeThrough(
    tallyBytes(tally, kept.size, signal, options.onProgress),
    // Cancel at once, even while the network is stalled.
    { signal },
  );
  const cache = await storage.open(name);
  await putCopy(cache, body, kept, tally, signal);
  if (!signal.aborted && tally.received === kept.size) return;
  // Best effort: the user needs to hear why keeping failed, not this.
  await cache.delete(entryUrl(kept.uuid)).catch(() => false);
  await dropIfEmpty(storage, name, cache).catch(() => undefined);
  throw signal.aborted ? canceledError() : incompleteError();
}

// Checked first, so a manual that cannot fit is never downloaded.
async function assertRoomFor(size: number) {
  const { usage, quota } = await keptStorage();
  if (usage !== undefined && quota !== undefined && quota - usage < size)
    throw quotaError(size, Math.max(0, quota - usage));
}

async function fetchCopy(
  download: KeepOptions["download"],
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  let response: Response;
  try {
    response = await download(signal);
  } catch {
    throw signal.aborted ? canceledError() : downloadError();
  }
  if (!response.ok || !response.body) throw downloadError();
  return response.body;
}

function tallyBytes(
  tally: Tally,
  size: number,
  signal: AbortSignal,
  onProgress: KeepOptions["onProgress"],
) {
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, stream) {
      if (signal.aborted) throw (tally.failure = canceledError());
      tally.received += chunk.byteLength;
      if (tally.received > size) throw (tally.failure = incompleteError());
      stream.enqueue(chunk);
      onProgress?.(tally.received, size);
    },
  });
}

async function putCopy(
  cache: Cache,
  body: ReadableStream<Uint8Array>,
  kept: KeptManual,
  tally: Tally,
  signal: AbortSignal,
) {
  const url = entryUrl(kept.uuid);
  const headers = {
    "Content-Type": PDF,
    [UUID_HEADER]: kept.uuid,
    [SIZE_HEADER]: String(kept.size),
    [KEPT_AT_HEADER]: String(kept.keptAt),
  };
  try {
    await cache.put(url, new Response(body, { headers }));
  } catch (error) {
    // Best effort, as in storeCopy.
    await cache.delete(url).catch(() => false);
    throw storeFailure(error, tally, signal, kept.size);
  }
}

function storeFailure(
  error: unknown,
  tally: Tally,
  signal: AbortSignal,
  size: number,
): DeviceStorageError {
  if (signal.aborted) return canceledError();
  if (tally.failure) return tally.failure;
  if (isQuotaError(error)) return quotaError(size);
  if (error instanceof DeviceStorageError) return error;
  return new DeviceStorageError(
    "storage",
    "The manual could not be saved on this device. Try again.",
  );
}

async function deleteNamespace(namespace: string) {
  const storage = cacheStorage();
  if (!storage) return;
  const names = await storage.keys();
  for (const name of names.filter((n) => namespaceOf(n) === namespace))
    await storage.delete(name);
}

// Records each removal as it happens, so a failure part-way still reports
// what went.
async function purgeNamespace(
  storage: CacheStorage,
  namespace: string,
  snapshot: Snapshot,
  purge: { removed: boolean },
) {
  const own = cacheName(namespace, snapshot.user.id);
  for (const name of await storage.keys()) {
    if (namespaceOf(name) !== namespace) continue;
    if (name !== own)
      purge.removed = (await storage.delete(name)) || purge.removed;
    else await purgeUnreadable(storage, name, snapshot, purge);
  }
}

async function purgeUnreadable(
  storage: CacheStorage,
  name: string,
  snapshot: Snapshot,
  purge: { removed: boolean },
) {
  const cache = await storage.open(name);
  for (const request of await cache.keys()) {
    const uuid = uuidOf(request.url);
    if (uuid && readable(snapshot, uuid)) continue;
    purge.removed = (await cache.delete(request)) || purge.removed;
  }
  await dropIfEmpty(storage, name, cache);
}

function isQuotaError(error: unknown) {
  const { name, code } = (error ?? {}) as { name?: unknown; code?: unknown };
  return (
    name === "QuotaExceededError" ||
    name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    code === LEGACY_QUOTA_CODE
  );
}

function quotaError(needed: number, available?: number) {
  return new DeviceStorageError(
    "quota",
    `Not enough storage on this device to keep this manual (${formatBytes(needed)} needed${available === undefined ? "" : `, ${formatBytes(available)} available`}). Remove other manuals from this device or free up space, then try again.`,
  );
}

function canceledError() {
  return new DeviceStorageError(
    "canceled",
    "Keeping this manual was canceled.",
  );
}

function incompleteError() {
  return new DeviceStorageError(
    "incomplete",
    "The download was incomplete, so the manual was not kept. Try again.",
  );
}

function downloadError() {
  return new DeviceStorageError(
    "download",
    "The manual could not be downloaded. Check the connection and try again.",
  );
}
