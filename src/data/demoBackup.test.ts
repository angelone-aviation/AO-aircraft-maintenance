/**
 * Responsibility: Pins what the demo backup holds: the full snapshot, the
 *   outbox, stored manuals as data URLs and the manuals with no file.
 * Layer: Test. Vitest suite over fake-indexeddb; never shipped in the build.
 * Dependencies: src/data/demoBackup.ts, src/data/local.ts, src/data/demo.ts.
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDemoBackup } from "./demoBackup";
import { persistOperation, saveManualBlob, saveSnapshot } from "./local";
import { demoSnapshot } from "./demo";

// FileReader is browser-only; this one reads like the browser's.
class TestFileReader {
  result: string | null = null;
  onload?: () => void;
  onerror?: () => void;
  readAsDataURL(blob: Blob) {
    void blob.arrayBuffer().then((bytes) => {
      if (!blob.size) return this.onerror?.();
      const base64 = Buffer.from(bytes).toString("base64");
      this.result = `data:${blob.type};base64,${base64}`;
      this.onload?.();
    });
  }
}

beforeEach(() => vi.stubGlobal("FileReader", TestFileReader));
afterEach(() => vi.unstubAllGlobals());

function manual(uuid: string) {
  return { uuid, title: uuid } as never;
}

it("exports the full demo snapshot, outbox and manual files", async () => {
  const full = { ...demoSnapshot(), manuals: [manual("kept"), manual("gone")] };
  await saveSnapshot("backup:all", full);
  await saveSnapshot("backup", demoSnapshot());
  await saveManualBlob("backup", "kept", new Blob(["pdf"], { type: "x/y" }));
  const operation = { uuid: "op" } as never;
  await persistOperation("backup", { operation, queuedAt: 1 });
  const backup = await createDemoBackup("backup", demoSnapshot());
  expect(backup).toMatchObject({
    format: "angel-one-demo-backup",
    version: 1,
    snapshot: { manuals: full.manuals },
    pendingOperations: [{ operation, namespace: "backup" }],
    manualFiles: [{ uuid: "kept", dataUrl: "data:x/y;base64,cGRm" }],
    missingManualFiles: ["gone"],
  });
});

it("falls back to the cached scoped snapshot, then the visible one", async () => {
  const cached = { ...demoSnapshot(), syncedAt: 1 };
  await saveSnapshot("scoped-only", cached);
  expect(
    (await createDemoBackup("scoped-only", demoSnapshot())).snapshot,
  ).toMatchObject({ syncedAt: 1 });
  const current = { ...demoSnapshot(), syncedAt: 2 };
  expect((await createDemoBackup("nothing-cached", current)).snapshot).toBe(
    current,
  );
});

it("refuses a manual file it cannot read", async () => {
  await saveSnapshot("unreadable:all", {
    ...demoSnapshot(),
    manuals: [manual("empty")],
  });
  await saveManualBlob("unreadable", "empty", new Blob([]));
  await expect(createDemoBackup("unreadable", demoSnapshot())).rejects.toThrow(
    "Could not read an uploaded manual for backup.",
  );
});
