/**
 * Responsibility: Pins kept manuals' promises: per-user and per-deployment
 *   copies, access checks, complete downloads only, purges and storage reports.
 * Layer: Test. An in-memory Cache Storage stands in for the browser's.
 * Dependencies: vitest, src/data/deviceManuals.ts, src/data/demo.ts,
 *   tests/fixtures/cacheStorage.ts.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  MemoryCacheStorage,
  pdfBytes,
  streamedResponse,
} from "../../tests/fixtures/cacheStorage";
import { demoSnapshot } from "./demo";
import type { Snapshot } from "../domain/model";
import type { Manual } from "../domain/manuals";
import {
  DeviceStorageError,
  formatBytes,
  hasKeptManuals,
  keepManual,
  keptManualsSupported,
  keptStorage,
  listKeptManuals,
  onKeptManualsChange,
  readKeptManual,
  reconcileKeptManuals,
  removeAllKeptManuals,
  removeKeptManual,
  requestPersistentStorage,
} from "./deviceManuals";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
function manual(uuid: string, size: number, aircraftUuid = "demo-206"): Manual {
  return {
    uuid,
    aircraftUuid,
    title: "Manual " + uuid.slice(-1),
    documentNumber: "",
    revision: "1",
    revisionDate: "",
    filename: uuid + ".pdf",
    size,
    pageCount: 3,
    uploadedAt: 1,
    uploadedBy: "demo-admin",
  };
}
function snapshot(manuals: Manual[], userId = "demo-admin"): Snapshot {
  const s = demoSnapshot();
  return { ...s, user: { ...s.user, id: userId }, manuals };
}
/** The same user, now limited to reading demo-206 only. */
function restricted(s: Snapshot): Snapshot {
  const group = {
    id: "pilots-206",
    name: "Pilots",
    programUuid: "demo-program",
    aircraftIds: ["demo-206"],
    permissions: ["read" as const],
  };
  return {
    ...s,
    user: { ...s.user, isAdmin: false, groupIds: [group.id] },
    groups: [...s.groups, group],
  };
}
const file = (size: number) => async () => streamedResponse(pdfBytes(size), 5);
let storage: MemoryCacheStorage;
beforeEach(() => {
  storage = new MemoryCacheStorage();
  vi.stubGlobal("caches", storage);
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it("keeps a manual for one user and deployment and reads it back without downloading again", async () => {
  const s = snapshot([manual(A, 1000)]);
  const download = vi.fn(file(1000));
  const progress: number[][] = [];
  const kept = await keepManual({
    namespace: "live:a",
    snapshot: s,
    uuid: A,
    download,
    onProgress: (received, total) => progress.push([received, total]),
  });
  expect(kept).toMatchObject({ uuid: A, size: 1000 });
  expect(progress.length).toBeGreaterThan(1);
  expect(progress.at(-1)).toEqual([1000, 1000]);
  expect(await listKeptManuals("live:a", s)).toEqual([kept]);

  const blob = await readKeptManual("live:a", s, A);
  expect(blob?.size).toBe(1000);
  expect(blob?.type).toBe("application/pdf");
  expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(pdfBytes(1000));
  expect(download).toHaveBeenCalledOnce();

  // Another user of this device, or another deployment, never sees it.
  const other = snapshot([manual(A, 1000)], "someone-else");
  expect(await readKeptManual("live:a", other, A)).toBeUndefined();
  expect(await listKeptManuals("live:a", other)).toEqual([]);
  expect(await readKeptManual("live:b", s, A)).toBeUndefined();
  // Keys are the manual's identity, not a temporary file URL.
  expect(JSON.stringify(storage.contents())).toContain(A);
  expect(JSON.stringify(storage.contents())).not.toContain("blob:");
});

it("removes a kept manual on demand", async () => {
  const s = snapshot([manual(A, 300), manual(B, 200)]);
  await keepManual({
    namespace: "live:a",
    snapshot: s,
    uuid: A,
    download: file(300),
  });
  await keepManual({
    namespace: "live:a",
    snapshot: s,
    uuid: B,
    download: file(200),
  });
  const changed = vi.fn();
  const stop = onKeptManualsChange(changed);
  await removeKeptManual("live:a", s, A);
  stop();
  expect(changed).toHaveBeenCalled();
  expect(await readKeptManual("live:a", s, A)).toBeUndefined();
  expect((await listKeptManuals("live:a", s)).map((m) => m.uuid)).toEqual([B]);
});

it("refuses to keep a manual the user cannot read", async () => {
  const s = restricted(snapshot([manual(A, 100, "demo-208")]));
  const download = vi.fn(file(100));
  await expect(
    keepManual({ namespace: "live:a", snapshot: s, uuid: A, download }),
  ).rejects.toMatchObject({ kind: "access" });
  await expect(
    keepManual({ namespace: "live:a", snapshot: s, uuid: C, download }),
  ).rejects.toMatchObject({ kind: "access" });
  expect(download).not.toHaveBeenCalled();
});

it("explains a full device before downloading and when the browser runs out of quota", async () => {
  const s = snapshot([manual(A, 1000)]);
  vi.stubGlobal("navigator", {
    storage: { estimate: async () => ({ usage: 600, quota: 1000 }) },
  });
  const download = vi.fn(file(1000));
  const early = keepManual({
    namespace: "live:a",
    snapshot: s,
    uuid: A,
    download,
  });
  await expect(early).rejects.toBeInstanceOf(DeviceStorageError);
  await expect(early).rejects.toMatchObject({
    kind: "quota",
    message: expect.stringMatching(/Not enough storage on this device/),
  });
  expect(download).not.toHaveBeenCalled();

  vi.stubGlobal("navigator", {});
  storage.quota = 400;
  await expect(
    keepManual({ namespace: "live:a", snapshot: s, uuid: A, download }),
  ).rejects.toMatchObject({
    kind: "quota",
    message: expect.stringMatching(/Remove other manuals from this device/),
  });
  expect(await listKeptManuals("live:a", s)).toEqual([]);
  expect(storage.used()).toBe(0);
});

it("keeps nothing from a canceled, failed, short or oversized download", async () => {
  const s = snapshot([manual(A, 1000)]);
  const controller = new AbortController();
  await expect(
    keepManual({
      namespace: "live:a",
      snapshot: s,
      uuid: A,
      download: file(1000),
      signal: controller.signal,
      onProgress: () => controller.abort(),
    }),
  ).rejects.toMatchObject({ kind: "canceled" });
  await expect(
    keepManual({
      namespace: "live:a",
      snapshot: s,
      uuid: A,
      download: async () => new Response("Forbidden", { status: 403 }),
    }),
  ).rejects.toMatchObject({ kind: "download" });
  await expect(
    keepManual({
      namespace: "live:a",
      snapshot: s,
      uuid: A,
      download: async () => {
        throw new TypeError("Failed to fetch");
      },
    }),
  ).rejects.toMatchObject({ kind: "download" });
  await expect(
    keepManual({
      namespace: "live:a",
      snapshot: s,
      uuid: A,
      download: file(600),
    }),
  ).rejects.toMatchObject({ kind: "incomplete" });
  await expect(
    keepManual({
      namespace: "live:a",
      snapshot: s,
      uuid: A,
      download: file(1200),
    }),
  ).rejects.toMatchObject({ kind: "incomplete" });
  expect(await listKeptManuals("live:a", s)).toEqual([]);
  expect(storage.used()).toBe(0);
});

it("cancels at once while the download is stalled", async () => {
  const s = snapshot([manual(A, 1000)]);
  const controller = new AbortController();
  let pulls = 0;
  const keeping = keepManual({
    namespace: "live:a",
    snapshot: s,
    uuid: A,
    signal: controller.signal,
    download: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async pull(stream) {
            // The network stalls after the first chunk and never recovers.
            if (pulls++) await new Promise(() => {});
            stream.enqueue(pdfBytes(100));
          },
        }),
      ),
  });
  await vi.waitFor(() => expect(pulls).toBeGreaterThan(1));
  controller.abort();
  await expect(keeping).rejects.toMatchObject({ kind: "canceled" });
  expect(storage.used()).toBe(0);
});

it("purges kept manuals the active snapshot no longer contains or allows, and other users' copies", async () => {
  const all = snapshot([manual(A, 100), manual(B, 100, "demo-208")]);
  await keepManual({
    namespace: "live:a",
    snapshot: all,
    uuid: A,
    download: file(100),
  });
  await keepManual({
    namespace: "live:a",
    snapshot: all,
    uuid: B,
    download: file(100),
  });
  const earlier = snapshot([manual(C, 100)], "previous-user");
  await keepManual({
    namespace: "live:a",
    snapshot: earlier,
    uuid: C,
    download: file(100),
  });
  await keepManual({
    namespace: "live:b",
    snapshot: all,
    uuid: B,
    download: file(100),
  });

  // Access to demo-208 revoked: its manual stays listed but is no longer readable.
  await reconcileKeptManuals("live:a", restricted(all));
  expect((await listKeptManuals("live:a", all)).map((m) => m.uuid)).toEqual([
    A,
  ]);
  expect(await listKeptManuals("live:a", earlier)).toEqual([]);
  // Another deployment's device data is governed by its own snapshot.
  expect((await listKeptManuals("live:b", all)).map((m) => m.uuid)).toEqual([
    B,
  ]);

  // Program switched away / aircraft transferred: the manual leaves the snapshot.
  await reconcileKeptManuals("live:a", snapshot([]));
  expect(await listKeptManuals("live:a", all)).toEqual([]);
  expect(Object.keys(storage.contents())).toHaveLength(1);
});

it("removes every kept manual of a deployment on sign-out, including a download in progress", async () => {
  const s = snapshot([manual(A, 100), manual(B, 1000)]);
  await keepManual({
    namespace: "live:a",
    snapshot: s,
    uuid: A,
    download: file(100),
  });
  await keepManual({
    namespace: "live:b",
    snapshot: s,
    uuid: A,
    download: file(100),
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const bytes = pdfBytes(1000);
  let sent = 0;
  const slow = keepManual({
    namespace: "live:a",
    snapshot: s,
    uuid: B,
    download: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (sent >= bytes.byteLength) return controller.close();
            if (sent) await gate;
            controller.enqueue(bytes.slice(sent, sent + 250));
            sent += 250;
          },
        }),
      ),
  });
  await vi.waitFor(() => expect(sent).toBeGreaterThan(0));
  const changed = vi.fn();
  const stop = onKeptManualsChange(changed);
  await removeAllKeptManuals("live:a");
  stop();
  release();
  await expect(slow).rejects.toMatchObject({ kind: "canceled" });
  expect(changed).toHaveBeenCalled();
  expect(await listKeptManuals("live:a", s)).toEqual([]);
  expect((await listKeptManuals("live:b", s)).map((m) => m.uuid)).toEqual([A]);
});

it("treats an unreadable device copy as missing so the viewer falls back to the online file", async () => {
  const s = snapshot([manual(A, 500)]);
  await keepManual({
    namespace: "live:a",
    snapshot: s,
    uuid: A,
    download: file(500),
  });
  for (const cache of storage.caches.values())
    for (const entry of cache.entries.values())
      entry.body = entry.body.slice(0, 200);
  expect(await readKeptManual("live:a", s, A)).toBeUndefined();
  expect(await listKeptManuals("live:a", s)).toEqual([]);

  await keepManual({
    namespace: "live:a",
    snapshot: s,
    uuid: A,
    download: file(500),
  });
  vi.stubGlobal("caches", {
    has: async () => true,
    open: async () => {
      throw new Error("The cache is unavailable.");
    },
  });
  expect(await readKeptManual("live:a", s, A)).toBeUndefined();
  expect(await listKeptManuals("live:a", s)).toEqual([]);
  await expect(removeAllKeptManuals("live:a")).resolves.toBeUndefined();
});

it("degrades quietly where the browser has no Cache Storage", async () => {
  vi.stubGlobal("caches", undefined);
  const s = snapshot([manual(A, 100)]);
  expect(keptManualsSupported()).toBe(false);
  expect(await listKeptManuals("live:a", s)).toEqual([]);
  expect(await readKeptManual("live:a", s, A)).toBeUndefined();
  await expect(
    keepManual({
      namespace: "live:a",
      snapshot: s,
      uuid: A,
      download: file(100),
    }),
  ).rejects.toMatchObject({ kind: "unsupported" });
  await expect(reconcileKeptManuals("live:a", s)).resolves.toBeUndefined();
  await expect(removeAllKeptManuals("live:a")).resolves.toBeUndefined();
});

it("reports space used and left, and asks for persistent storage only until granted", async () => {
  const persist = vi.fn(async () => true);
  let persisted = false;
  vi.stubGlobal("navigator", {
    storage: {
      estimate: async () => ({ usage: 2_000, quota: 10_000 }),
      persisted: async () => persisted,
      persist,
    },
  });
  expect(await keptStorage()).toEqual({
    usage: 2_000,
    quota: 10_000,
    persisted: false,
  });
  expect(await requestPersistentStorage()).toBe(true);
  persisted = true;
  expect(await requestPersistentStorage()).toBe(true);
  expect(persist).toHaveBeenCalledOnce();

  vi.stubGlobal("navigator", {});
  expect(await keptStorage()).toEqual({});
  expect(await requestPersistentStorage()).toBeUndefined();
});

it("formats sizes in binary megabytes, switching to gigabytes at 1,024 MB", () => {
  expect(formatBytes(1_572_864)).toBe("1.5 MB");
  expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
  // Characterizes current behaviour: rounding can show "1024.0 MB".
  expect(formatBytes(1024 ** 3 - 1)).toBe("1024.0 MB");
});

it("tells every listener about a change, even when one throws", async () => {
  const s = snapshot([manual(A, 100)]);
  const failing = vi.fn(() => {
    throw new Error("listener broke");
  });
  const working = vi.fn();
  const stopFailing = onKeptManualsChange(failing);
  const stopWorking = onKeptManualsChange(working);

  await keepManual({
    namespace: "live:a",
    snapshot: s,
    uuid: A,
    download: file(100),
  });
  stopWorking();
  await removeAllKeptManuals("live:a");
  stopFailing();

  expect(failing).toHaveBeenCalledTimes(2);
  expect(working).toHaveBeenCalledOnce();
});

it("says whether the device holds any kept manual, for any deployment", async () => {
  expect(await hasKeptManuals()).toBe(false);
  await keepManual({
    namespace: "live:b",
    snapshot: snapshot([manual(A, 100)], "another-user"),
    uuid: A,
    download: file(100),
  });

  expect(await hasKeptManuals()).toBe(true);
  vi.stubGlobal("caches", {
    keys: async () => {
      throw new Error("The cache is unavailable.");
    },
  });
  expect(await hasKeptManuals()).toBe(false);
});

it("tells listeners when a read deletes a damaged copy, and reconcile only when it removes one", async () => {
  const s = snapshot([manual(A, 500)]);
  await keepManual({
    namespace: "live:a",
    snapshot: s,
    uuid: A,
    download: file(500),
  });
  const changed = vi.fn();
  const stop = onKeptManualsChange(changed);

  await reconcileKeptManuals("live:a", s);
  expect(changed).not.toHaveBeenCalled();
  for (const cache of storage.caches.values())
    for (const entry of cache.entries.values())
      entry.body = entry.body.slice(0, 200);
  await readKeptManual("live:a", s, A);
  stop();

  expect(changed).toHaveBeenCalledOnce();
});

it("reports a removal the device refuses, and still tells listeners", async () => {
  const s = snapshot([manual(A, 100)]);
  vi.stubGlobal("caches", {
    has: async () => true,
    open: async () => {
      throw new Error("The cache is unavailable.");
    },
  });
  const changed = vi.fn();
  const stop = onKeptManualsChange(changed);

  await expect(removeKeptManual("live:a", s, A)).rejects.toMatchObject({
    name: "DeviceStorageError",
    kind: "storage",
    message: "The manual could not be removed from this device. Try again.",
  });
  stop();
  expect(changed).toHaveBeenCalledOnce();
});
