/**
 * Responsibility: Pins which checklist runs a flight may link, and that a
 *   review keeps the recorded run.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/flightChecklistLink.ts, checklists.ts, model.ts,
 *   rejection.ts; src/data/demo.ts (fixture).
 */
import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { emptyChecklist } from "./checklists";
import {
  preserveChecklistLink,
  validateChecklistFlight,
} from "./flightChecklistLink";
import type { FlightInput } from "./model";
import { Rejection } from "./rejection";

const now = new Date().toISOString();
const unlinkedFlight: FlightInput = {
  aircraftUuid: "demo-206",
  pilotId: "demo-admin",
  startTime: now,
  hobbsOn: 2342.2 * 3600,
  cycles: 1,
  landings: 1,
  origin: "A",
  destination: "B",
  operation: "Private",
  flightRules: "VFR",
  remarks: "",
  discrepancy: "",
};

// Version 2 of an N206MA checklist, and an N206MA flight that ran it.
function linkedFlight(checklistVersion = 2) {
  const s = demoSnapshot();
  const checklist = {
    uuid: crypto.randomUUID(),
    version: 2,
    programUuid: "demo-program",
    aircraftUuid: "demo-206",
    sourceName: "",
    updatedAt: 0,
    updatedBy: "demo-admin",
    document: emptyChecklist(),
  };
  s.checklists = [checklist];
  const flight: FlightInput = {
    ...unlinkedFlight,
    checklistRun: {
      sessionUuid: crypto.randomUUID(),
      checklistUuid: checklist.uuid,
      checklistVersion,
      checklistName: "Preflight",
      startedAt: now,
      metersVerifiedAt: now,
      preflight: { hobbs: 360, tach: 360 },
      checked: ["check"],
      skipped: [],
      totalChecks: 1,
    },
  };
  return { s, checklist, flight };
}

it("accepts a readable checklist for this aircraft or all aircraft, at the stored version or older, or no checklist", () => {
  const older = linkedFlight(1);
  older.checklist.aircraftUuid = "";
  for (const { s, flight } of [linkedFlight(), older])
    expect(() => validateChecklistFlight(s, flight)).not.toThrow();
  const { s } = linkedFlight();
  s.checklists = [];
  expect(() => validateChecklistFlight(s, unlinkedFlight)).not.toThrow();
});

it("refuses a missing, unreadable, other-aircraft, other-program or newer checklist", () => {
  const missing = linkedFlight();
  missing.s.checklists = [];
  const unreadable = linkedFlight();
  unreadable.s.user = { ...unreadable.s.user, isAdmin: false, groupIds: [] };
  const otherAircraft = linkedFlight();
  otherAircraft.checklist.aircraftUuid = "demo-208";
  const otherProgram = linkedFlight();
  otherProgram.checklist.aircraftUuid = "";
  otherProgram.s.aircraft[0].programUuid = "other";
  for (const { s, flight } of [
    missing,
    unreadable,
    otherAircraft,
    otherProgram,
    linkedFlight(3),
  ])
    expect(() => validateChecklistFlight(s, flight)).toThrow(
      Error("Checklist is unavailable for this aircraft or Flight Program."),
    );
});

it("refuses a review that changes the recorded checklist run", () => {
  const { flight } = linkedFlight();
  const run = flight.checklistRun!;
  expect(() =>
    preserveChecklistLink(flight, { ...flight, remarks: "Corrected" }),
  ).not.toThrow();
  for (const after of [
    { ...flight, checklistRun: undefined },
    { ...flight, checklistRun: { ...run, checked: [], skipped: ["check"] } },
  ]) {
    expect(() => preserveChecklistLink(flight, after)).toThrow(Rejection);
    expect(() => preserveChecklistLink(flight, after)).toThrow(
      Error("A review cannot change the recorded checklist run."),
    );
  }
});
