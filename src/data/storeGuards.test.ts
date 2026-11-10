/**
 * Responsibility: Pins two workspace guards no store test reached: a device
 *   copy cached before Flight Program scoping is never opened, and a logbook
 *   photo is refused once offline access has ended.
 * Layer: Test. Vitest suite over fake-indexeddb; never shipped in the build.
 * Dependencies: src/data/store.ts, src/data/local.ts, src/data/demo.ts.
 */
import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { readPendingPhotos, saveSnapshot } from "./local";
import { demoSnapshot } from "./demo";
import { scopedSnapshot } from "../domain/programs";

afterEach(() => vi.unstubAllGlobals());

async function workspace() {
  vi.stubGlobal("navigator", { onLine: true });
  return (await import("./store")).useWorkspace;
}

it("opens a scoped device copy, and not one cached before Flight Program scoping", async () => {
  const useWorkspace = await workspace();
  const scoped = scopedSnapshot(demoSnapshot());
  expect(scoped.programScopeVersion).toBe(1);
  await saveSnapshot("cache-scoped", scoped);
  await useWorkspace.getState().initialize("cache-scoped", false);
  expect(useWorkspace.getState().snapshot?.user.id).toBe(scoped.user.id);
  const { programScopeVersion: _unscoped, ...older } = scoped;
  await saveSnapshot("cache-older", older);
  await useWorkspace.getState().initialize("cache-older", false);
  expect(useWorkspace.getState()).toMatchObject({
    ready: true,
    snapshot: null,
  });
});

it("refuses a logbook photo once offline access has ended, keeping nothing", async () => {
  const useWorkspace = await workspace();
  const namespace = "photo-blocked";
  await useWorkspace.getState().initialize(namespace, false);
  const s = scopedSnapshot(demoSnapshot());
  useWorkspace.setState({ snapshot: s, blocked: true });
  const photo = new File([new Uint8Array([255, 216])], "line.jpg", {
    type: "image/jpeg",
  });
  const target = {
    aircraftUuid: s.aircraft[0].uuid,
    linkedKind: "flight" as const,
    linkedUuid: crypto.randomUUID(),
  };
  await expect(
    useWorkspace.getState().attachLogbookPhoto(target, photo),
  ).rejects.toThrow(
    "Your offline access expired. Reconnect and sign in; pending entries are preserved.",
  );
  expect(await readPendingPhotos(namespace)).toEqual([]);
});
