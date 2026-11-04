/**
 * Responsibility: Pins the device cache: its database, store and key names,
 *   queue order, and connection release on another tab's upgrade.
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
} from "./local";
import { demoSnapshot } from "./demo";

function discrepancy(queuedAt: number, uuid: string) {
  return {
    queuedAt,
    operation: {
      kind: "discrepancy" as const,
      uuid,
      authorId: "user-a",
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
