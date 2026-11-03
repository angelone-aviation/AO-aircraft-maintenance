import "fake-indexeddb/auto";
import { it, expect } from "vitest";
import {
  readQueue,
  persistOperation,
  removeOperation,
  saveSnapshot,
  readSnapshot,
  clearSnapshot,
} from "./local";
import { demoSnapshot } from "./demo";
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
});
