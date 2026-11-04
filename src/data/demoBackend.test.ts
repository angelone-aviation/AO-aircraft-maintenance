/**
 * Responsibility: Pins the demo adapter's discrepancy resolution against the
 *   server's rules: the same refusals, trimmed text and change-log row.
 * Layer: Test. Vitest suite with fake IndexedDB; never shipped in the build.
 * Dependencies: src/data/store.ts (the demo workspace), ./local, ./demo
 *   (seed), src/domain (model, rejection).
 *
 * Before Batch 269 the demo resolved without the resolve permission or a
 * length limit, stored the text untrimmed, said "Describe the repair." and
 * "Already resolved.", and crashed on a missing report.
 */
import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { readSnapshot, saveSnapshot } from "./local";
import { demoSnapshot } from "./demo";
import type { Snapshot } from "../domain/model";
import { Rejection } from "../domain/rejection";

const REPORT = "demo-report";
const LENGTH = "Describe the repair in 1–5000 characters.";

// A demo workspace over its own copy of the seed, online.
async function demo(namespace: string, edit: (s: Snapshot) => void = () => {}) {
  vi.stubGlobal("navigator", { onLine: true });
  const seed = demoSnapshot();
  edit(seed);
  await saveSnapshot(namespace + ":all", seed);
  const { useWorkspace } = await import("./store");
  await useWorkspace.getState().initialize(namespace, true);
  useWorkspace.setState({ online: true });
  return {
    backend: useWorkspace.getState().backend!,
    stored: async () => (await readSnapshot(namespace + ":all"))!,
  };
}

it("resolves with the trimmed repair and audits the record before and after", async () => {
  const { backend, stored } = await demo("demo-resolve");
  const before = (await stored()).discrepancies.find((d) => d.uuid === REPORT);
  await backend.resolve(REPORT, "  Reseated the connector ");
  const s = await stored();
  const after = s.discrepancies.find((d) => d.uuid === REPORT)!;
  expect(after).toEqual({
    ...before,
    status: "resolved",
    resolution: "Reseated the connector",
    resolvedBy: s.user.id,
    resolvedAt: expect.any(Number),
  });
  expect(s.audit[0]).toMatchObject({
    action: "discrepancy.resolved",
    entityUuid: REPORT,
    aircraftUuid: after.aircraftUuid,
    actorId: s.user.id,
    reason: "  Reseated the connector ",
    before: JSON.stringify(before),
    after: JSON.stringify(after),
  });
});

it.each([
  [
    "a member without the resolve permission",
    REPORT,
    "Fixed",
    "You do not have permission for this aircraft.",
    (s: Snapshot) => (s.user = { ...s.members[1] }),
  ],
  ["a blank repair", REPORT, "  ", LENGTH, undefined],
  [
    "a repair over 5000 characters",
    REPORT,
    "x".repeat(5001),
    LENGTH,
    undefined,
  ],
  [
    "a resolved report",
    REPORT,
    "Again",
    "This report is already resolved.",
    (s: Snapshot) => (s.discrepancies[0].status = "resolved"),
  ],
  ["a missing report", "missing", "Fixed", "Report not found.", undefined],
])(
  "refuses %s with the server's message and changes nothing",
  async (_, uuid, resolution, message, edit) => {
    const { backend, stored } = await demo(
      `demo-refuse-${uuid}-${message}`,
      edit,
    );
    const before = await stored();
    const error = await backend.resolve(uuid, resolution).catch((e) => e);
    expect(error).toBeInstanceOf(Rejection);
    expect(error).toMatchObject({ message });
    expect(await stored()).toEqual(before);
  },
);
