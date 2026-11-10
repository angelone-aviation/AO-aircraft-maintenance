/**
 * Responsibility: Pins read-alert tracking: the device copy until the server
 *   answers, marks not saved yet, marking all read, forgetting the marks of
 *   cleared alerts, and the error messages.
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

it("shows the device copy until the server answers, then the server's reads", async () => {
  let answer: (keys: string[]) => void = () => {};
  const alertReads = () => new Promise<string[]>((r) => (answer = r));
  const { reads, scope } = await setup("alerts-load", { alertReads });
  await saveFavorites(scope, ["device"]);
  const loading = reads.getState().load();
  await vi.waitFor(() => expect(reads.getState().keys).toEqual(["device"]));
  expect(reads.getState().synced).toBe(false);
  // The server forgot "device" when its alert cleared: the copy must not
  // bring the mark back.
  answer(["server"]);
  await loading;
  expect(reads.getState()).toMatchObject({
    scope,
    keys: ["server"],
    synced: true,
  });
  expect(await readFavorites(scope)).toEqual(["server"]);
});

it("keeps a mark the server has not saved yet when its reads arrive", async () => {
  const markAlertsRead = vi.fn().mockRejectedValue(new Error("Offline."));
  const backend = { alertReads: async () => ["a"], markAlertsRead };
  const { reads } = await setup("alerts-unsaved", backend);
  await reads.getState().load();
  await reads.getState().markRead(["b"]);
  await reads.getState().load();
  expect(reads.getState().keys).toEqual(["a", "b"]);
  // Once saved, the server's answer alone decides.
  markAlertsRead.mockResolvedValue(undefined);
  await reads.getState().markRead(["b"]);
  await reads.getState().load();
  expect(reads.getState().keys).toEqual(["a"]);
});

it("forgets the marks of alerts no longer shown, once the server's reads have loaded", async () => {
  const forgetAlertReads = vi.fn().mockResolvedValue(undefined);
  const backend = { alertReads: async () => ["a", "b", "c"], forgetAlertReads };
  const { reads, scope } = await setup("alerts-forget", backend);
  // Before the load the device copy may be incomplete: nothing is forgotten.
  await reads.getState().forgetCleared(["a"]);
  expect(forgetAlertReads).not.toHaveBeenCalled();
  await reads.getState().load();
  await reads.getState().forgetCleared(["a", "c", "unread"]);
  expect(reads.getState().keys).toEqual(["a", "c"]);
  expect(await readFavorites(scope)).toEqual(["a", "c"]);
  expect(forgetAlertReads).toHaveBeenCalledExactlyOnceWith("demo-program", [
    "b",
  ]);
  await reads.getState().forgetCleared(["a", "c"]);
  expect(forgetAlertReads).toHaveBeenCalledTimes(1);
  // A failed save is not an error to show: the server forgets by itself.
  forgetAlertReads.mockRejectedValue(new Error("Offline."));
  await reads.getState().forgetCleared(["a"]);
  expect(reads.getState()).toMatchObject({ keys: ["a"], error: "" });
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
