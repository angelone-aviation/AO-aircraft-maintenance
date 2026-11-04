/**
 * Responsibility: Pins counter events in the flight chronology: what an
 *   aircraft save records, and how rebuilt flights honour or refuse it.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/fleet.ts, ./flights, ./model, ./rejection,
 *   src/data/demo.ts (seed).
 */
import { describe, it, expect } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  applyFleet,
  aircraftInputSchema,
  type AircraftCounterEvent,
} from "./fleet";
import { applyFlight, rebuildFlights, resequencedFlights } from "./flights";
import { totalSeconds, type Aircraft, type Flight } from "./model";
import { Rejection } from "./rejection";

const HOUR_SECONDS = 3600;
const h = (hours: number) => Math.round(hours * HOUR_SECONDS);
const now = Date.parse("2026-10-03T12:00:00Z");
function flight(a: Aircraft, overrides: Partial<Flight> = {}): Flight {
  return {
    uuid: crypto.randomUUID(),
    aircraftUuid: a.uuid,
    authorId: "demo-admin",
    pilotId: "demo-admin",
    submittedAt: 0,
    status: "accepted",
    startTime: "2026-10-03T09:00:00Z",
    hobbsOff: a.currentHobbs,
    tachOff: a.currentTach,
    hobbsOn: a.currentHobbs + h(1),
    landings: 1,
    cycles: 0,
    origin: "",
    destination: "",
    operation: "Mission",
    flightRules: "VFR",
    remarks: "",
    discrepancy: "",
    ...overrides,
  };
}
// The administrator saves the aircraft form with some fields changed.
function saveAircraft(
  s: ReturnType<typeof demoSnapshot>,
  changes: Partial<Aircraft>,
) {
  const current = s.aircraft[0];
  return applyFleet(
    s,
    {
      requestUuid: crypto.randomUUID(),
      reason: "Verified aircraft records",
      action: "aircraft.save",
      aircraft: { ...aircraftInputSchema.parse(current), ...changes },
    },
    now,
  ).aircraft!;
}
// N206MA: Hobbs 2341.2, 2,194 landings; one accepted flight this morning.
function flown() {
  const s = demoSnapshot();
  const opening = s.aircraft[0];
  const first = flight(opening);
  s.aircraft[0] = applyFlight(opening, first);
  return { s, opening, first };
}
/** After {@link flown}: a counter event recorded before the fix, with every
 * counter and no record of what changed, and a correction of the flight. */
function legacyHistory() {
  const { s, opening, first } = flown();
  const before = s.aircraft[0];
  const legacy: AircraftCounterEvent = {
    at: "2026-10-03T12:00:00.000Z",
    meter: "hobbs",
    adjustmentSeconds: 0,
    currentHobbs: before.currentHobbs,
    currentTach: before.currentTach,
    currentFlightTimeLog: h(100),
    cycles: before.cycles,
    landings: before.landings,
  };
  const corrected = {
    ...first,
    hobbsOn: opening.currentHobbs + h(1.4),
    landings: 3,
  };
  return { opening, first, before, legacy, corrected };
}
describe("counter events in the flight chronology", () => {
  it("records only the counters the administrator changed", () => {
    const { s } = flown();
    const next = saveAircraft(s, {
      flightTimeLog: true,
      currentFlightTimeLog: h(100),
    });
    expect(next.counterEvents).toHaveLength(1);
    expect(next.counterEvents![0]).toMatchObject({
      changed: ["currentFlightTimeLog"],
      previous: {},
      currentFlightTimeLog: h(100),
    });
  });
  it("applies a correction of an earlier flight after an unrelated counter change", () => {
    const { s, opening, first } = flown();
    const a = saveAircraft(s, {
      flightTimeLog: true,
      currentFlightTimeLog: h(100),
    });
    const corrected = {
      ...first,
      hobbsOn: opening.currentHobbs + h(1.4),
      landings: 3,
    };
    const rebuilt = rebuildFlights(a, [corrected], [first]);
    expect(rebuilt.aircraft.currentHobbs).toBe(opening.currentHobbs + h(1.4));
    expect(rebuilt.aircraft.landings).toBe(opening.landings + 3);
    expect(rebuilt.aircraft.currentFlightTimeLog).toBe(h(100));
    expect(totalSeconds(rebuilt.aircraft)).toBe(totalSeconds(opening) + h(1.4));
  });
  it("adds an accepted flight held for predating a counter change, and removes a rejected one", () => {
    const s = demoSnapshot();
    const opening = s.aircraft[0];
    const a = saveAircraft(s, {
      flightTimeLog: true,
      currentFlightTimeLog: h(100),
    });
    const held = flight(opening, {
      status: "review",
      hobbsOn: opening.currentHobbs + h(1.3),
      landings: 2,
    });
    const accepted = rebuildFlights(
      a,
      [{ ...held, status: "accepted" }],
      [held],
    );
    expect(accepted.aircraft.currentHobbs).toBe(opening.currentHobbs + h(1.3));
    expect(accepted.aircraft.landings).toBe(opening.landings + 2);
    expect(accepted.aircraft.currentFlightTimeLog).toBe(h(100));
    const { s: s2, opening: o2, first } = flown();
    const b = saveAircraft(s2, {
      flightTimeLog: true,
      currentFlightTimeLog: h(100),
    });
    const rejected = rebuildFlights(
      b,
      [{ ...first, status: "rejected" }],
      [first],
    );
    expect(rejected.aircraft.currentHobbs).toBe(o2.currentHobbs);
    expect(rejected.aircraft.landings).toBe(o2.landings);
    expect(rejected.aircraft.currentFlightTimeLog).toBe(h(100));
  });
  it("keeps an absolute counter override and refuses corrections that would make it inconsistent", () => {
    const { s, opening, first } = flown();
    // Hobbs meter replaced: the administrator sets the new meter to 0.0.
    const a = saveAircraft(s, { currentHobbs: 0 });
    expect(a.counterEvents![0]).toMatchObject({
      changed: ["currentHobbs"],
      previous: { currentHobbs: opening.currentHobbs + h(1) },
    });
    const later = flight(a, {
      startTime: "2026-10-03T13:00:00Z",
      hobbsOff: 0,
      hobbsOn: h(1),
    });
    const landingsOnly = rebuildFlights(
      a,
      [{ ...first, landings: 3 }, later],
      [first, later],
    );
    expect(landingsOnly.aircraft.currentHobbs).toBe(h(1));
    expect(landingsOnly.aircraft.landings).toBe(opening.landings + 4);
    expect(landingsOnly.flights[1].hobbsOff).toBe(0);
    expect(() =>
      rebuildFlights(
        a,
        [{ ...first, hobbsOn: opening.currentHobbs + h(1.4) }, later],
        [first, later],
      ),
    ).toThrow(
      /Cannot accept this chronology: .*inconsistent.*Hobbs.*2,342\.2.*2,342\.6/,
    );
  });
  it("refuses corrections that change the reading a time-source switch was based on", () => {
    const { s, opening, first } = flown();
    const current = s.aircraft[0];
    const a = saveAircraft(s, {
      flightTimeLog: true,
      currentFlightTimeLog: h(100),
      meter: "flightTimeLog",
      adjustmentSeconds: totalSeconds(current) - h(100),
    });
    expect(a.counterEvents![0].changed).toEqual([
      "meter",
      "adjustmentSeconds",
      "currentFlightTimeLog",
    ]);
    const landings = rebuildFlights(a, [{ ...first, landings: 2 }], [first]);
    expect(totalSeconds(landings.aircraft)).toBe(totalSeconds(current));
    expect(landings.aircraft.landings).toBe(opening.landings + 2);
    const corrected = [{ ...first, hobbsOn: opening.currentHobbs + h(1.4) }];
    expect(() => rebuildFlights(a, corrected, [first])).toThrow(
      /Cannot accept this chronology: .*time source/,
    );
    expect(() => rebuildFlights(a, corrected, [first])).toThrow(Rejection);
  });
  it("derives what a legacy event changed from the flights as stored, and records it", () => {
    const { opening, first, before, legacy, corrected } = legacyHistory();
    const a: Aircraft = {
      ...before,
      flightTimeLog: true,
      currentFlightTimeLog: h(100),
      counterEvents: [legacy],
    };
    const rebuilt = rebuildFlights(a, [corrected], [first]);
    expect(rebuilt.aircraft.currentHobbs).toBe(opening.currentHobbs + h(1.4));
    expect(rebuilt.aircraft.landings).toBe(opening.landings + 3);
    expect(rebuilt.aircraft.currentFlightTimeLog).toBe(h(100));
    expect(rebuilt.aircraft.counterEvents).toEqual([
      { ...legacy, changed: ["currentFlightTimeLog"], previous: {} },
    ]);
    // The recorded change keeps the correction on every later rebuild.
    const again = rebuildFlights(rebuilt.aircraft, [corrected], [corrected]);
    expect(again.aircraft.currentHobbs).toBe(opening.currentHobbs + h(1.4));
    expect(again.aircraft.landings).toBe(opening.landings + 3);
  });
  it("keeps a legacy absolute override, and still guards its chronology", () => {
    const { opening, first, before, legacy, corrected } = legacyHistory();
    const replaced: Aircraft = {
      ...before,
      currentHobbs: 0,
      counterEvents: [{ ...legacy, currentHobbs: 0 }],
    };
    const landings = rebuildFlights(
      replaced,
      [{ ...first, landings: 3 }],
      [first],
    );
    expect(landings.aircraft.currentHobbs).toBe(0);
    expect(landings.aircraft.landings).toBe(opening.landings + 3);
    expect(landings.aircraft.counterEvents![0]).toMatchObject({
      changed: ["currentHobbs", "currentFlightTimeLog"],
      previous: { currentHobbs: before.currentHobbs },
    });
    expect(() => rebuildFlights(replaced, [corrected], [first])).toThrow(
      /Cannot accept this chronology/,
    );
  });
});
describe("resequenced flights", () => {
  it("lists the other accepted flights whose starting readings changed", () => {
    const s = demoSnapshot();
    const opening = s.aircraft[0];
    const later = flight(opening, { startTime: "2026-10-03T11:00:00Z" });
    const a = applyFlight(opening, later);
    const earlier = flight(opening, {
      startTime: "2026-10-03T08:00:00Z",
      hobbsOn: opening.currentHobbs + h(0.5),
      status: "review",
      hobbsOff: a.currentHobbs,
    });
    const stored = [later, earlier];
    const rebuilt = rebuildFlights(
      a,
      [later, { ...earlier, status: "accepted" }],
      stored,
    );
    expect(resequencedFlights(stored, rebuilt.flights, earlier.uuid)).toEqual([
      {
        flight: rebuilt.flights[1],
        before: { hobbsOff: opening.currentHobbs },
        after: { hobbsOff: opening.currentHobbs + h(0.5) },
      },
    ]);
  });
});
