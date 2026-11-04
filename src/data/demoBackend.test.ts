/**
 * Responsibility: Pins the demo adapter's discrepancy resolution and flight
 *   review against the server's rules: the same refusals, stored records and
 *   change-log rows.
 * Layer: Test. Vitest suite with fake IndexedDB; never shipped in the build.
 * Dependencies: src/data/store.ts (the demo workspace), ./local, ./demo
 *   (seed), src/domain (model, flights, rejection).
 *
 * Before Batch 269 the demo resolved without the resolve permission or a
 * length limit, stored the text untrimmed, said "Describe the repair." and
 * "Already resolved.", and crashed on a missing report. Before Batch 300 its
 * flight review skipped the administrator, aircraft, crew, problem-report,
 * reason-length and (on a rejection) reading checks, said "Provide a
 * meaningful explanation.", moved a flight to the aircraft a correction named,
 * and crashed on a missing flight.
 */
import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { readSnapshot, saveSnapshot } from "./local";
import { demoSnapshot } from "./demo";
import type { Flight, FlightInput, Snapshot } from "../domain/model";
import { applyFlight } from "../domain/flights";
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

const REASON = "Checked against the paper log";

// N206MA flew at 11:00; a flight at 09:00 synced later and is held for review.
function heldFlight(s: Snapshot) {
  const opening = s.aircraft[0];
  const input: FlightInput = {
    aircraftUuid: opening.uuid,
    pilotId: "demo-pilot",
    startTime: "2026-10-03T09:00:00Z",
    hobbsOn: opening.currentHobbs + 3600,
    landings: 1,
    cycles: 1,
    origin: "AAA",
    destination: "BBB",
    operation: "Mission",
    flightRules: "VFR",
    remarks: "",
    discrepancy: "",
  };
  const flight = (changes: Partial<Flight>): Flight => ({
    ...input,
    uuid: crypto.randomUUID(),
    authorId: "demo-pilot",
    submittedAt: 0,
    status: "accepted",
    hobbsOff: opening.currentHobbs,
    tachOff: opening.currentTach,
    ...changes,
  });
  const later = flight({
    uuid: "demo-later",
    startTime: "2026-10-03T11:00:00Z",
    hobbsOn: opening.currentHobbs + 7200,
  });
  const held = flight({
    uuid: "demo-held",
    status: "review",
    reviewReason: "Aircraft totals changed after this entry was started.",
    hobbsOff: later.hobbsOn,
  });
  s.aircraft[0] = applyFlight(opening, later);
  s.flights = [later, held];
  return input;
}

it("reviews a held flight: replays the aircraft and audits the review and each move", async () => {
  let input!: FlightInput;
  const { backend, stored } = await demo("demo-review", (seed) => {
    input = heldFlight(seed);
  });
  const before = await stored();
  const [later, held] = before.flights;
  const corrected = { ...input, remarks: "Paper log" };
  await backend.review(held.uuid, "accept", REASON, corrected);
  const s = await stored();
  const reviewed = {
    ...held,
    ...corrected,
    status: "accepted",
    reviewReason: REASON,
    hobbsOff: before.aircraft[0].baselineHobbs,
  };
  expect(s.flights).toEqual([{ ...later, hobbsOff: input.hobbsOn }, reviewed]);
  expect(s.aircraft[0]).toMatchObject({
    currentHobbs: later.hobbsOn,
    landings: before.aircraft[0].baselineLandings + 2,
    version: 2,
  });
  const [moved, review] = s.audit;
  expect(review).toMatchObject({
    action: "flight.reviewed",
    entityUuid: held.uuid,
    aircraftUuid: held.aircraftUuid,
    actorId: s.user.id,
    reason: REASON,
    before: JSON.stringify(held),
  });
  expect(JSON.parse(review.after!)).toEqual(reviewed);
  expect(moved).toMatchObject({
    action: "flight.resequenced",
    entityUuid: later.uuid,
    reason:
      "Starting readings recalculated after the flight of 2026-10-03 09:00 UTC was accepted.",
    before: JSON.stringify({ hobbsOff: later.hobbsOff }),
    after: JSON.stringify({ hobbsOff: input.hobbsOn }),
  });
});

it.each([
  [
    "a member who is not an administrator",
    {},
    (s: Snapshot) => (s.user = { ...s.members[1] }),
    "Flight Program administrator required.",
  ],
  [
    "a short reason",
    { reason: "ok" },
    undefined,
    "Provide a meaningful review explanation.",
  ],
  [
    "a reason over 5000 characters",
    { reason: "x".repeat(5001) },
    undefined,
    "Provide a meaningful review explanation.",
  ],
  ["a missing flight", { uuid: "missing" }, undefined, "Flight not found."],
  [
    "a change of aircraft",
    { input: { aircraftUuid: "demo-208" } },
    undefined,
    "A correction cannot change aircraft.",
  ],
  [
    "a change to the problem report",
    { input: { discrepancy: "Loose cowling" } },
    undefined,
    "Use the discrepancy workflow to update problem reports.",
  ],
  [
    "an unknown pilot",
    { input: { pilotId: "ghost" } },
    undefined,
    "Pilot not found.",
  ],
  [
    "a new copilot outside the Flight Program",
    { input: { copilotId: "outsider" } },
    (s: Snapshot) =>
      s.members.push({ ...s.members[1], id: "outsider", groupIds: [] }),
    "Pilot must belong to this Flight Program.",
  ],
  [
    "a rejection without the aircraft's reading",
    { decision: "reject" as const, input: { hobbsOn: undefined } },
    undefined,
    "The hobbs reading is required for this aircraft.",
  ],
])(
  "refuses a review with %s, with the server's message, and changes nothing",
  async (_, change, edit, message) => {
    let input!: FlightInput;
    const { backend, stored } = await demo(`demo-review-${message}`, (seed) => {
      input = heldFlight(seed);
      edit?.(seed);
    });
    const before = await stored();
    const error = await backend
      .review(
        "uuid" in change ? change.uuid : "demo-held",
        "decision" in change ? change.decision : "accept",
        "reason" in change ? change.reason : REASON,
        { ...input, ...("input" in change ? change.input : {}) },
      )
      .catch((e) => e);
    expect(error).toBeInstanceOf(Rejection);
    expect(error).toMatchObject({ message });
    expect(await stored()).toEqual(before);
  },
);
