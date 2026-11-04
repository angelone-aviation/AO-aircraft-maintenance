/**
 * Responsibility: Pins read-alert tracking: the device copy, merging the
 *   server's reads, marking all read, and the error messages.
 * Layer: Test. Vitest suite over fake-indexeddb; never shipped in the build.
 * Dependencies: src/data/alerts.ts, src/data/store.ts, src/data/local.ts,
 *   convex/values.
 */
import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { demoSnapshot } from "./demo";
import { readFavorites, saveFavorites } from "./local";

afterEach(() => vi.unstubAllGlobals());

async function setup(namespace: string, backend: object) {
  vi.stubGlobal("navigator", { onLine: true });
  const { useWorkspace } = await import("./store");
  const { useAlertReads } = await import("./alerts");
  const snapshot = demoSnapshot();
  useWorkspace.setState({ namespace, snapshot, backend: backend as never });
  const scope = `${namespace}:alert-reads:${snapshot.user.id}:${snapshot.activeProgramUuid}`;
  return { reads: useAlertReads, scope };
}

it("merges the device copy with the server's reads and keeps both", async () => {
  const alertReads = vi.fn().mockResolvedValue(["server"]);
  const { reads, scope } = await setup("alerts-load", { alertReads });
  await saveFavorites(scope, ["device"]);
  await reads.getState().load();
  expect(reads.getState()).toMatchObject({ scope, keys: ["device", "server"] });
  expect(await readFavorites(scope)).toEqual(["device", "server"]);
});

it("marks keys read, or replaces the reads with them", async () => {
  const markAlertsRead = vi.fn().mockResolvedValue(undefined);
  const backend = { alertReads: async () => ["a"], markAlertsRead };
  const { reads, scope } = await setup("alerts-mark", backend);
  await reads.getState().load();
  await reads.getState().markRead(["b"]);
  expect(reads.getState().keys).toEqual(["a", "b"]);
  await reads.getState().markRead(["c"], true);
  expect(reads.getState().keys).toEqual(["c"]);
  expect(await readFavorites(scope)).toEqual(["c"]);
  expect(markAlertsRead).toHaveBeenLastCalledWith("demo-program", ["c"], true);
});

it("reports failures with the backend's message or a fallback", async () => {
  const backend = {
    alertReads: () => Promise.reject("offline"),
    markAlertsRead: () => Promise.reject(new Error("Session ended.")),
  };
  const { reads } = await setup("alerts-errors", backend);
  await reads.getState().load();
  expect(reads.getState().error).toBe("Unable to load read alerts.");
  await reads.getState().markRead(["x"]);
  expect(reads.getState().error).toBe("Session ended.");
});

it("shows the server's refusal, never the Convex client's wrapper", async () => {
  const { ConvexError } = await import("convex/values");
  const wrapper = "[CONVEX M(alerts:markRead)] [Request ID: x] Server Error";
  // Shaped as the Convex client throws it: the wrapper is the message and the
  // server's refusal is the data.
  const refusal = new ConvexError<string>(wrapper);
  refusal.data = "Choose an active Flight Program.";
  const backend = {
    alertReads: () => Promise.reject(new Error(wrapper)),
    markAlertsRead: () => Promise.reject(refusal),
  };
  const { reads } = await setup("alerts-convex-errors", backend);
  await reads.getState().load();
  expect(reads.getState().error).toBe("Unable to load read alerts.");
  await reads.getState().markRead(["x"]);
  expect(reads.getState().error).toBe("Choose an active Flight Program.");
});
