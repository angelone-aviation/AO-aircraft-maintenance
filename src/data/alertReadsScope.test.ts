/**
 * Responsibility: Pins that read-alert marks stay with the Flight Program
 *   they were made in: an answer for a program the user has left is
 *   dropped, and a mark made under a scope the user has left is not sent.
 * Layer: Test. Vitest suite over fake-indexeddb; never shipped in the build.
 * Dependencies: src/data/alerts.ts, src/data/store.ts, src/data/demo.ts.
 */
import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { demoSnapshot } from "./demo";

afterEach(() => vi.unstubAllGlobals());

async function setup(namespace: string, backend: object) {
  vi.stubGlobal("navigator", { onLine: true });
  const { useWorkspace } = await import("./store");
  const { useAlertReads } = await import("./alerts");
  const snapshot = demoSnapshot();
  useWorkspace.setState({ namespace, snapshot, backend: backend as never });
  const switchProgram = (programUuid: string) =>
    useWorkspace.setState({
      snapshot: { ...snapshot, activeProgramUuid: programUuid },
    });
  return { reads: useAlertReads, switchProgram };
}

it("drops the reads of a program the user switched away from while they loaded", async () => {
  const pending: ((keys: string[]) => void)[] = [];
  const alertReads = vi.fn(
    (programUuid: string) =>
      new Promise<string[]>((resolve) =>
        programUuid === "demo-program"
          ? pending.push(resolve)
          : resolve(["other-key"]),
      ),
  );
  const { reads, switchProgram } = await setup("alerts-switch", { alertReads });
  const first = reads.getState().load();
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  switchProgram("other-program");
  await reads.getState().load();
  pending[0](["demo-key"]);
  await first;
  expect(reads.getState().scope).toMatch(/:other-program$/);
  expect(reads.getState().keys).toEqual(["other-key"]);
});

it("sends no mark made under a program the user has since left", async () => {
  const markAlertsRead = vi.fn().mockResolvedValue(undefined);
  const backend = { alertReads: async () => [], markAlertsRead };
  const { reads, switchProgram } = await setup("alerts-left", backend);
  await reads.getState().load();
  switchProgram("other-program");
  await reads.getState().markRead(["k"]);
  expect(markAlertsRead).not.toHaveBeenCalled();
  expect(reads.getState().keys).toEqual([]);
});
