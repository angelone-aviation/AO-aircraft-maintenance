/**
 * Responsibility: Pins the device cache: its database, store and key names,
 *   queue order, the queued photo store, and connection release on another
 *   tab's upgrade.
 * Layer: Test. Vitest suite over fake-indexeddb; never shipped in the build.
 * Dependencies: src/data/local.ts, src/data/demo.ts, fake-indexeddb, idb.
 */
import "fake-indexeddb/auto";
import { openDB } from "idb";
import { it, expect } from "vitest";
import {
  readQueue,
  persistOperation,
  removeOperation,
  saveSnapshot,
  readSnapshot,
  clearSnapshot,
  saveFavorites,
  readFavorites,
  saveManualBlob,
  readManualBlob,
  readPendingPhotos,
  savePendingPhoto,
  removePendingPhoto,
  favoritesKey,
  alertReadsKey,
  clearUserData,
} from "./local";
import { demoSnapshot } from "./demo";

function discrepancy(queuedAt: number, uuid: string, authorId = "user-a") {
  return {
    queuedAt,
    operation: {
      kind: "discrepancy" as const,
      uuid,
      authorId,
      aircraftUuid: "aircraft",
      description: "Broken light",
    },
  };
}
it("persists idempotent offline operations separately from snapshots and deployments", async () => {
  const entry = {
    queuedAt: 123,
    operation: {
      kind: "discrepancy" as const,
      uuid: crypto.randomUUID(),
      authorId: "user-a",
      aircraftUuid: "aircraft",
      description: "Broken light",
    },
  };
  await persistOperation("live:a", entry);
  await persistOperation("live:a", entry);
  await saveSnapshot("live:a", demoSnapshot());
  await clearSnapshot("live:a");
  expect(await readSnapshot("live:a")).toBeUndefined();
  expect(await readQueue("live:a")).toHaveLength(1);
  expect(await readQueue("demo")).toHaveLength(0);
  await removeOperation("live:a", entry.operation.uuid);
  expect(await readQueue("live:a")).toHaveLength(0);
});
// Devices already hold data under these names: renaming any of them strands it.
it("keeps data under the database, store and key names devices hold", async () => {
  await saveSnapshot("layout", demoSnapshot());
  await persistOperation("layout", discrepancy(2, "op-late"));
  await persistOperation("layout", discrepancy(1, "op-early"));
  await saveFavorites("layout:user", ["N1"]);
  await saveManualBlob("layout", "manual", new Blob(["pdf"]));
  const cache = await openDB("angel-one-v1");
  expect(cache.version).toBe(2);
  expect([...cache.objectStoreNames]).toEqual([
    "outbox",
    "settings",
    "snapshots",
  ]);
  expect(await cache.getAllKeys("outbox")).toEqual(
    expect.arrayContaining(["layout:op-early", "layout:op-late"]),
  );
  expect(await cache.get("outbox", "layout:op-late")).toMatchObject({
    namespace: "layout",
    queuedAt: 2,
  });
  expect(await cache.get("settings", "layout:user")).toEqual(["N1"]);
  expect(await cache.get("snapshots", "layout")).toBeDefined();
  cache.close();
  const manuals = await openDB("angel-one-manuals-v1");
  expect(manuals.version).toBe(1);
  expect([...manuals.objectStoreNames]).toEqual(["files"]);
  expect(await manuals.getAllKeys("files")).toEqual(["layout:manual"]);
  manuals.close();
  expect((await readQueue("layout")).map((q) => q.operation.uuid)).toEqual([
    "op-early",
    "op-late",
  ]);
  expect(await readFavorites("layout:user")).toEqual(["N1"]);
  expect(await (await readManualBlob("layout", "manual"))?.text()).toBe("pdf");
});

it("rewrites a cached snapshot that still holds retired work-order fields", async () => {
  const s = demoSnapshot();
  s.workOrders = [{ uuid: "wo", estimate: "100 USD" } as never];
  const cache = await openDB("angel-one-v1");
  await cache.put("snapshots", s, "retired");
  expect((await readSnapshot("retired"))?.workOrders).toEqual([{ uuid: "wo" }]);
  expect((await cache.get("snapshots", "retired")).workOrders).toEqual([
    { uuid: "wo" },
  ]);
  cache.close();
  await expect(removeOperation("retired", "missing")).resolves.toBeUndefined();
});

// Keep last: upgrades the shared database past the version this module opens.
it("clears one user's device data but keeps other authors' unsynced work and the demo's own records", async () => {
  const ns = "wipe";
  const photo = (key: string, authorId: string) => ({
    key,
    aircraftUuid: "aircraft",
    linkedKind: "flight" as const,
    linkedUuid: "flight-1",
    authorId,
    name: key,
    type: "image/jpeg",
    size: 1,
    queuedAt: 1,
    blob: new Blob([new Uint8Array([1])], { type: "image/jpeg" }),
  });
  await saveSnapshot(ns, demoSnapshot());
  await saveSnapshot(`${ns}:all`, demoSnapshot());
  await persistOperation(ns, discrepancy(1, "mine"));
  await persistOperation(ns, discrepancy(2, "theirs", "user-b"));
  await persistOperation("other", discrepancy(3, "elsewhere"));
  await savePendingPhoto(ns, photo("mine.jpg", "user-a"));
  await savePendingPhoto(ns, photo("theirs.jpg", "user-b"));
  await savePendingPhoto("other", photo("elsewhere.jpg", "user-a"));
  await saveFavorites(favoritesKey(ns, "user-a"), ["N1"]);
  await saveFavorites(favoritesKey(ns, "user-b"), ["N2"]);
  await saveFavorites(alertReadsKey(ns, "user-a", "program"), ["due"]);
  await saveFavorites(alertReadsKey(ns, "user-a", undefined), ["due"]);
  await saveFavorites(alertReadsKey(ns, "user-b", "program"), ["due"]);
  await saveFavorites(`${ns}:demo-alert-reads:user-a:program`, ["due"]);

  await clearUserData(ns, "user-a");

  expect(await readSnapshot(ns)).toBeUndefined();
  expect(await readSnapshot(`${ns}:all`)).toBeDefined();
  const uuids = async (n: string) =>
    (await readQueue(n)).map((q) => q.operation.uuid);
  expect(await uuids(ns)).toEqual(["theirs"]);
  expect(await uuids("other")).toEqual(["elsewhere"]);
  const keys = async (n: string) =>
    (await readPendingPhotos(n)).map((p) => p.key);
  expect(await keys(ns)).toEqual(["theirs.jpg"]);
  expect(await keys("other")).toEqual(["elsewhere.jpg"]);
  expect(await readFavorites(`${ns}:user-a`)).toBeUndefined();
  expect(await readFavorites(`${ns}:user-b`)).toEqual(["N2"]);
  expect(
    await readFavorites(`${ns}:alert-reads:user-a:program`),
  ).toBeUndefined();
  expect(await readFavorites(`${ns}:alert-reads:user-a:`)).toBeUndefined();
  expect(await readFavorites(`${ns}:alert-reads:user-b:program`)).toEqual([
    "due",
  ]);
  expect(await readFavorites(`${ns}:demo-alert-reads:user-a:program`)).toEqual([
    "due",
  ]);
  // The photo store test lists every key the store holds.
  await removePendingPhoto(ns, "theirs.jpg");
  await removePendingPhoto("other", "elsewhere.jpg");
});

it("releases its shared connection when another tab upgrades the database", async () => {
  await readQueue("upgrade-test");
  const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("angel-one-v1", 3);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("A stale connection blocked the upgrade."));
  });
  expect(upgraded.version).toBe(3);
  upgraded.close();
  await expect(readQueue("upgrade-test")).rejects.toMatchObject({
    name: "VersionError",
  });
});

it("releases the manual files connection when another tab upgrades it", async () => {
  await readManualBlob("upgrade-test", "manual");
  const upgraded = await openDB("angel-one-manuals-v1", 2, {
    blocked: () => {
      throw new Error("A stale connection blocked the upgrade.");
    },
  });
  expect(upgraded.version).toBe(2);
  upgraded.close();
  await expect(readManualBlob("upgrade-test", "manual")).rejects.toMatchObject({
    name: "VersionError",
  });
});

it("queues logbook page photos per namespace, replacing a photo saved again under its key", async () => {
  const photo = (key: string, queuedAt: number, error?: string) => ({
    key,
    aircraftUuid: "aircraft",
    linkedKind: "flight" as const,
    linkedUuid: "flight-1",
    authorId: "user-a",
    programUuid: "program",
    name: key,
    type: "image/jpeg",
    size: 3,
    queuedAt,
    error,
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }),
  });
  await savePendingPhoto("live:a", photo("late.jpg", 5));
  await savePendingPhoto("live:a", photo("early.jpg", 1));
  await savePendingPhoto("live:a", photo("early.jpg", 1, "Refused"));
  await savePendingPhoto("demo", photo("demo.jpg", 2));
  const queued = await readPendingPhotos("live:a");
  expect(queued.map((p) => [p.key, p.error])).toEqual([
    ["early.jpg", "Refused"],
    ["late.jpg", undefined],
  ]);
  expect(await queued[0].blob.arrayBuffer()).toEqual(
    new Uint8Array([1, 2, 3]).buffer,
  );
  await removePendingPhoto("live:a", "early.jpg");
  await removePendingPhoto("live:a", "missing.jpg");
  expect((await readPendingPhotos("live:a")).map((p) => p.key)).toEqual([
    "late.jpg",
  ]);
  expect((await readPendingPhotos("demo")).map((p) => p.key)).toEqual([
    "demo.jpg",
  ]);
  const db = await openDB("angel-one-logbook-photos-v1", 1);
  expect([...db.objectStoreNames]).toEqual(["photos"]);
  expect(await db.getAllKeys("photos")).toEqual([
    "demo:demo.jpg",
    "live:a:late.jpg",
  ]);
  db.close();
});
