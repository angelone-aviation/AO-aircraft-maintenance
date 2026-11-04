/**
 * Responsibility: Pins what src/domain/flights.ts promises: the meter in use,
 *   flight validation, conflict order, counter advance, the chronology replay
 *   and its change-history wording.
 * Layer: Test. Vitest suite on the demo fleet; never shipped in the build.
 * Dependencies: ./flights, ./model, ./fleet (types), ./rejection,
 *   src/data/demo.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { demoSnapshot } from "../data/demo";
import type { AircraftCounterEvent } from "./fleet";
import type { Aircraft, Flight, FlightInput } from "./model";
import { Rejection } from "./rejection";
import {
  applyFlight,
  conflictReason,
  flightStatusLabels,
  meterAtFlight,
  rebuildFlights,
  resequenceReason,
  resequencedFlights,
  validateFlight,
} from "./flights";

const h = (hours: number) => Math.round(hours * 3600);
const START = "2026-10-03T09:00:00Z";
const LATER = "2026-10-03T11:00:00Z";

// N206MA: Hobbs meter, Hobbs 2341.2, tach 2261.2, 2,194 landings, version 0.
const n206 = (changes: Partial<Aircraft> = {}): Aircraft => ({
  ...demoSnapshot().aircraft[0],
  ...changes,
});

function input(a: Aircraft, changes: Partial<FlightInput> = {}): FlightInput {
  return {
    aircraftUuid: a.uuid,
    pilotId: "demo-admin",
    startTime: START,
    hobbsOn: a.currentHobbs + h(1),
    landings: 1,
    cycles: 1,
    origin: "AAA",
    destination: "BBB",
    operation: "Mission",
    flightRules: "VFR",
    remarks: "",
    discrepancy: "",
    ...changes,
  };
}

function flight(a: Aircraft, changes: Partial<Flight> = {}): Flight {
  return {
    ...input(a),
    uuid: crypto.randomUUID(),
    authorId: "demo-admin",
    submittedAt: 0,
    status: "accepted",
    ...changes,
  };
}

const event = (at: string, changes: Partial<AircraftCounterEvent>) => ({
  ...n206(),
  at,
  ...changes,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("flightStatusLabels", () => {
  it("writes the review status as Flight records shows it", () => {
    expect(flightStatusLabels).toEqual({
      accepted: "accepted",
      review: "Needs review",
      rejected: "rejected",
    });
  });
});

describe("meterAtFlight", () => {
  const changes = {
    baselineMeter: "hobbs" as const,
    meter: "cyclic" as const,
    counterEvents: [
      event("2026-10-02T00:00:00.000Z", { meter: "tach" }),
      event("2026-10-04T00:00:00.000Z", { meter: "cyclic" }),
    ],
  };

  it("is the current meter while the aircraft has no counter changes", () => {
    const a = n206({ baselineMeter: "hobbs", meter: "tach" });
    expect(meterAtFlight(a, START)).toBe("tach");
  });

  it("is that of the latest change at or before the time", () => {
    const a = n206(changes);
    expect(meterAtFlight(a, "2026-10-02T00:00:00.000Z")).toBe("tach");
    expect(meterAtFlight(a, START)).toBe("tach");
    expect(meterAtFlight(a, "2026-10-05T00:00:00Z")).toBe("cyclic");
  });

  it("is the baseline meter before the first change, else the current one", () => {
    const early = "2026-10-01T00:00:00Z";
    expect(meterAtFlight(n206(changes), early)).toBe("hobbs");
    const noBaseline = n206({ ...changes, baselineMeter: undefined });
    expect(meterAtFlight(noBaseline, early)).toBe("cyclic");
  });
});

describe("validateFlight", () => {
  it.each([
    ["hobbs", "hobbs"],
    ["tach", "tach"],
    ["cyclic", "Collective hourmeter"],
    ["flightTimeLog", "Flight time log"],
  ] as const)("requires the %s reading", (meter, label) => {
    const a = n206({ meter });
    expect(() =>
      validateFlight(a, input(a, { hobbsOn: undefined, tachOn: undefined })),
    ).toThrow(`The ${label} reading is required for this aircraft.`);
  });

  it("requires the reading of the meter in use at the flight's start", () => {
    const a = n206({
      baselineMeter: "hobbs",
      meter: "tach",
      counterEvents: [event(LATER, { meter: "tach" })],
    });
    expect(() =>
      validateFlight(a, input(a, { hobbsOn: undefined, tachOn: h(2262) })),
    ).toThrow("The hobbs reading is required for this aircraft.");
  });

  it("accepts a start up to five minutes ahead of the clock", () => {
    vi.useFakeTimers({ now: Date.parse(START) });
    const a = n206();
    const at = (ms: number) =>
      input(a, { startTime: new Date(Date.parse(START) + ms).toISOString() });
    expect(() => validateFlight(a, at(5 * 60_000))).not.toThrow();
    expect(() => validateFlight(a, at(5 * 60_000 + 1))).toThrow(
      "Flight time cannot be in the future.",
    );
  });

  it("parses the input first, then checks the reading, then the clock", () => {
    vi.useFakeTimers({ now: Date.parse(START) });
    const a = n206();
    expect(() => validateFlight(a, input(a, { hobbsOn: h(1.25) }))).toThrow(
      z.ZodError,
    );
    const future = input(a, {
      hobbsOn: undefined,
      startTime: "2026-10-04T09:00:00Z",
    });
    expect(() => validateFlight(a, future)).toThrow(
      "The hobbs reading is required for this aircraft.",
    );
  });
});

describe("conflictReason", () => {
  const latest = n206({
    latestFlightAt: "2026-10-03T08:00:00Z",
    currentCyclicHobbs: h(10),
    currentFlightTimeLog: h(10),
  });
  const lower = {
    hobbsOn: latest.currentHobbs - h(0.1),
    cyclicHobbsOn: h(9.9),
    flightTimeLogOn: h(9.9),
    tachOn: latest.currentTach - h(0.1),
  };

  it("checks the version, the counter changes, the latest flight, then each reading", () => {
    // Every cause at once; each step clears the one reported before it.
    const aircraft: Aircraft = {
      ...latest,
      version: 1,
      counterEvents: [event(START, {})],
      latestFlightAt: START,
    };
    const flown: FlightInput = input(latest, lower);
    const steps: [() => void, string][] = [
      [() => {}, "Aircraft totals changed after this entry was started."],
      [
        () => (aircraft.version = 0),
        "Flight predates an aircraft counter change and requires chronology review.",
      ],
      [
        () => (aircraft.counterEvents = undefined),
        "Backdated or duplicate-time flight requires a chronology review.",
      ],
      [
        () => (aircraft.latestFlightAt = latest.latestFlightAt),
        "Hobbs reading is lower than the current counter.",
      ],
      [
        () => (flown.hobbsOn = undefined),
        "Collective hourmeter reading is lower than the current counter.",
      ],
      [
        () => (flown.cyclicHobbsOn = undefined),
        "Flight time log reading is lower than the current counter.",
      ],
      [
        () => (flown.flightTimeLogOn = undefined),
        "Tach reading is lower than the current counter.",
      ],
    ];
    for (const [clear, reason] of steps) {
      clear();
      expect(conflictReason(aircraft, flown, 0)).toBe(reason);
    }
  });

  it("holds a start at the same instant as a counter change or the latest flight", () => {
    const a = n206({ counterEvents: [event(LATER, {})] });
    expect(conflictReason(a, input(a, { startTime: LATER }), 0)).toMatch(
      /^Flight predates/,
    );
    const b = n206({ latestFlightAt: START });
    expect(conflictReason(b, input(b), 0)).toMatch(/^Backdated/);
  });

  it("finds nothing for readings equal to the counters", () => {
    expect(
      conflictReason(
        latest,
        input(latest, {
          hobbsOn: latest.currentHobbs,
          tachOn: latest.currentTach,
          cyclicHobbsOn: h(10),
          flightTimeLogOn: h(10),
        }),
        0,
      ),
    ).toBeUndefined();
  });

  it("reads an unset collective or flight time log counter as zero", () => {
    const a = n206();
    expect(
      conflictReason(a, input(a, { cyclicHobbsOn: 0, flightTimeLogOn: 0 }), 0),
    ).toBeUndefined();
  });
});

describe("applyFlight", () => {
  it("replaces the logged readings, adds landings and cycles, and moves one version on", () => {
    const a = n206({ version: 4 });
    const copy = structuredClone(a);
    const next = applyFlight(a, input(a, { landings: 2, cycles: 3 }));
    expect(next).toEqual({
      ...a,
      currentHobbs: a.currentHobbs + h(1),
      landings: a.landings + 2,
      cycles: a.cycles + 3,
      version: 5,
      latestFlightAt: START,
    });
    expect(a).toEqual(copy);
  });
});

describe("rebuildFlights", () => {
  const opening = n206({ version: 7 });
  const first = flight(opening);
  const second = flight(opening, {
    startTime: LATER,
    hobbsOn: opening.currentHobbs + h(2.5),
    tachOn: opening.currentTach + h(2),
  });

  it("replays accepted flights in time order from the baseline", () => {
    const held = flight(opening, {
      status: "review",
      startTime: "2026-10-03T10:00:00Z",
    });
    const rejected = flight(opening, { status: "rejected" });
    const { aircraft, flights } = rebuildFlights(opening, [
      second,
      held,
      rejected,
      first,
    ]);
    expect(flights.map((f) => f.uuid)).toEqual([first.uuid, second.uuid]);
    expect(flights[0]).toMatchObject({
      hobbsOff: opening.baselineHobbs,
      tachOff: opening.baselineTach,
      hobbsOn: first.hobbsOn,
    });
    expect(flights[1]).toMatchObject({
      hobbsOff: first.hobbsOn,
      tachOff: opening.baselineTach,
      hobbsOn: second.hobbsOn,
      tachOn: second.tachOn,
    });
    expect(aircraft).toMatchObject({
      currentHobbs: second.hobbsOn,
      currentTach: second.tachOn,
      landings: opening.baselineLandings + 2,
      cycles: opening.baselineCycles + 2,
      latestFlightAt: LATER,
    });
  });

  it("moves the aircraft one version on, however many flights replay", () => {
    expect(rebuildFlights(opening, [first, second]).aircraft.version).toBe(8);
    expect(rebuildFlights(opening, []).aircraft.version).toBe(8);
  });

  it("counts a flight at the same instant as a counter change before it", () => {
    const a = n206({
      counterEvents: [
        {
          ...event(START, { cycles: 5000 }),
          changed: ["cycles"],
          previous: { cycles: opening.baselineCycles + 1 },
        },
      ],
    });
    expect(rebuildFlights(a, [first]).aircraft.cycles).toBe(5000);
  });

  it("refuses a flight that conflicts, naming the reason", () => {
    const lower = { ...second, hobbsOn: opening.currentHobbs + h(0.5) };
    expect(() => rebuildFlights(opening, [first, lower])).toThrow(
      "Cannot accept this chronology: Hobbs reading is lower than the current counter.",
    );
    expect(() => rebuildFlights(opening, [first, lower])).toThrow(Rejection);
  });

  it("refuses an accepted flight that validateFlight refuses", () => {
    const unread = { ...first, hobbsOn: undefined };
    expect(() => rebuildFlights(opening, [unread])).toThrow(
      "The hobbs reading is required for this aircraft.",
    );
  });
});

describe("resequencedFlights", () => {
  const a = n206();
  const one = flight(a, { hobbsOff: h(1), tachOff: h(1) });
  const two = flight(a, { hobbsOff: h(2) });
  const three = flight(a, { hobbsOff: h(3) });

  it("lists, in rebuilt order, each other flight with only the readings that moved", () => {
    const rebuilt = [
      { ...three, hobbsOff: h(3.5) },
      { ...one, hobbsOff: h(1.5), cyclicHobbsOff: h(4) },
      two,
    ];
    expect(resequencedFlights([one, two, three], rebuilt)).toEqual([
      {
        flight: rebuilt[0],
        before: { hobbsOff: h(3) },
        after: { hobbsOff: h(3.5) },
      },
      {
        flight: rebuilt[1],
        before: { hobbsOff: h(1), cyclicHobbsOff: null },
        after: { hobbsOff: h(1.5), cyclicHobbsOff: h(4) },
      },
    ]);
  });

  it("leaves out the excepted flight and flights not stored before", () => {
    const fresh = flight(a, { hobbsOff: h(9) });
    const rebuilt = [{ ...one, hobbsOff: h(1.5) }, fresh];
    expect(resequencedFlights([one], rebuilt, one.uuid)).toEqual([]);
  });
});

describe("resequenceReason", () => {
  it.each([
    ["review", "accepted", "accepted"],
    ["rejected", "accepted", "accepted"],
    ["accepted", "accepted", "corrected"],
    ["accepted", "rejected", "rejected"],
    ["review", "rejected", "rejected"],
  ] as const)("a %s flight now %s was %s", (before, after, verb) => {
    expect(
      resequenceReason({ status: before }, { status: after, startTime: START }),
    ).toBe(
      `Starting readings recalculated after the flight of 2026-10-03 09:00 UTC was ${verb}.`,
    );
  });

  it("prints the start as written; characterizes current behaviour", () => {
    // An offset start is not converted: 09:00-05:00 is 14:00 UTC.
    expect(
      resequenceReason(
        { status: "review" },
        { status: "accepted", startTime: "2026-10-03T09:00:00-05:00" },
      ),
    ).toMatch(/of 2026-10-03 09:00 UTC/);
  });
});
