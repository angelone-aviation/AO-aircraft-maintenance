/**
 * Responsibility: Pins saved preflight sessions and the flight fields a filed
 *   flight plan fills in.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/flightSession.ts, flightPlans.ts, flights.ts,
 *   pdf/icao.ts, model.ts, rejection.ts; src/data/demo.ts and
 *   tests/fixtures/icao-text.json (fixtures).
 */
import { expect, it } from "vitest";
import items from "../../tests/fixtures/icao-text.json";
import { parseIcao } from "./pdf/icao";
import { flightPlanSchema } from "./flightPlans";
import { demoSnapshot } from "../data/demo";
import { type FlightInput } from "./model";
import { conflictReason, validateFlight } from "./flights";
import {
  flightSessionSchema,
  plannedFlightPrefill,
  startFlightSession,
} from "./flightSession";
import { Rejection } from "./rejection";

const aircraft = { ...demoSnapshot().aircraft[0], twin: false, turbine: true };
const verifiedAt = "2026-01-01T10:00:00.000Z";
const input: FlightInput = {
  aircraftUuid: aircraft.uuid,
  pilotId: "demo-admin",
  startTime: verifiedAt,
  origin: "AAA",
  destination: "BBB",
  landings: 1,
  cycles: 1,
  flightRules: "VFR",
  operation: "Mission",
  remarks: "",
  discrepancy: "",
  fuel: { unit: "US gal", start: 50, added: 0 },
  oil: [{ engine: "single", unit: "US qt", start: 6, added: 0 }],
};
it("saved preflight round-trips without ending readings or changing aircraft totals", () => {
  const before = structuredClone(aircraft);
  const session = startFlightSession(
    aircraft,
    {
      ...input,
      hobbsOn: aircraft.currentHobbs + 3600,
      engineStarts: [{ engine: "single", maxEgtC: 600 }],
    },
    verifiedAt,
  );
  const restored = flightSessionSchema.parse(
    JSON.parse(JSON.stringify(session)),
  );
  expect(restored.input.fuel).toEqual(input.fuel);
  expect(restored.input.oil).toEqual(input.oil);
  expect(restored.input.hobbsOn).toBeUndefined();
  expect(restored.input.engineStarts).toBeUndefined();
  expect(restored.verifiedAt).toBe(verifiedAt);
  expect(aircraft).toEqual(before);
  expect(() => validateFlight(aircraft, restored.input)).toThrow(
    "reading is required",
  );
  const finished = {
    ...restored.input,
    hobbsOn: aircraft.currentHobbs + 3600,
    tachOn: aircraft.currentTach + 3600,
    cyclicHobbsOn: (aircraft.currentCyclicHobbs ?? 0) + 3600,
  };
  expect(() => validateFlight(aircraft, finished)).not.toThrow();
  expect(
    conflictReason(
      { ...aircraft, version: aircraft.version + 1 },
      finished,
      restored.opening.version,
    ),
  ).toContain("totals changed");
});
it("a saved preflight requires fluids for the actual engine layout", () => {
  expect(() =>
    startFlightSession(aircraft, { ...input, fuel: undefined }, verifiedAt),
  ).toThrow("preflight fuel");
  expect(() =>
    startFlightSession(aircraft, { ...input, oil: [] }, verifiedAt),
  ).toThrow("preflight oil");
  expect(() =>
    startFlightSession({ ...aircraft, twin: true }, input, verifiedAt),
  ).toThrow("each engine");
  const twin = {
    ...input,
    oil: (["left", "right"] as const).map((engine) => ({
      engine,
      unit: "US qt" as const,
      start: 6,
      added: 0,
    })),
  };
  expect(
    startFlightSession({ ...aircraft, twin: true }, twin, verifiedAt).input.oil,
  ).toHaveLength(2);
});
it("a saved preflight refuses a mismatched aircraft and invalid data", () => {
  expect(() =>
    startFlightSession(
      aircraft,
      { ...input, aircraftUuid: "other" },
      verifiedAt,
    ),
  ).toThrow("does not match");
  expect(() => flightSessionSchema.parse({ input })).toThrow();
});

// The ICAO fixture filed as an IFR plan for the first aircraft.
function filedPlan(pilotText: string) {
  return flightPlanSchema.parse({
    ...parseIcao(items),
    uuid: crypto.randomUUID(),
    version: 1,
    aircraftUuid: aircraft.uuid,
    pilotText,
    flightRules: "I",
    durationMinutes: 100,
    cycles: 2,
    landings: 3,
    sourceName: "plan.pdf",
    sourceHash: "a".repeat(64),
    createdAt: 0,
    status: "proposed",
  });
}

it("carries flight plan data through saved preflight without treating estimates as actual readings", () => {
  const s = demoSnapshot();
  const pilot = s.members.find(
    (m) => m.active && m.availableAsPilot !== false,
  )!;
  const plan = filedPlan(pilot.name);
  const prefill = plannedFlightPrefill(plan, s.members, s.user.id);
  expect(prefill).toMatchObject({
    aircraftUuid: aircraft.uuid,
    flightPlanUuid: plan.uuid,
    pilotId: pilot.id,
    startTime: plan.departureAt,
    origin: plan.origin,
    destination: plan.destination,
    flightRules: "IFR",
    landings: 3,
    cycles: 2,
  });
  const restored = flightSessionSchema.parse(
    JSON.parse(
      JSON.stringify(
        startFlightSession(aircraft, { ...input, ...prefill }, verifiedAt),
      ),
    ),
  );
  expect(restored.input.flightPlanUuid).toBe(plan.uuid);
  expect(restored.input.hobbsOn).toBeUndefined();
  expect(restored.input.tachOn).toBeUndefined();
  expect(restored.input.fuel).toEqual(input.fuel);
  expect(
    plannedFlightPrefill(
      { ...plan, pilotText: "Unmatched pilot" },
      s.members,
      "current-user",
    ).pilotId,
  ).toBe("current-user");
});

it("a saved preflight clears every ending reading and the ending fuel", () => {
  const ending = {
    hobbsOn: 3600,
    tachOn: 3600,
    cyclicHobbsOn: 3600,
    flightTimeLogOn: 3600,
  };
  const { input: saved } = startFlightSession(
    aircraft,
    { ...input, ...ending, fuel: { ...input.fuel!, end: 40 } },
    verifiedAt,
  );
  for (const reading of Object.keys(ending) as (keyof typeof ending)[])
    expect(saved[reading]).toBeUndefined();
  expect(saved.fuel).toEqual(input.fuel);
});

it("refuses an incomplete preflight as a Rejection", () => {
  for (const refused of [
    { ...input, aircraftUuid: "other" },
    { ...input, fuel: { unit: "US gal" as const, start: 50 } },
    { ...input, oil: [{ ...input.oil![0], added: undefined }] },
  ])
    expect(() => startFlightSession(aircraft, refused, verifiedAt)).toThrow(
      Rejection,
    );
});

it("departs IFR on I or Y plans and picks the pilot only on one active match", () => {
  const s = demoSnapshot();
  const pilot = s.members.find(
    (m) => m.active && m.availableAsPilot !== false,
  )!;
  const plan = filedPlan(` ${pilot.name.toUpperCase()} `);
  const prefill = (patch: object, members = s.members) =>
    plannedFlightPrefill({ ...plan, ...patch }, members, "me");
  expect(
    ["I", "Y", "V", "Z"].map((rules) => prefill({ flightRules: rules })),
  ).toMatchObject([
    { flightRules: "IFR", pilotId: pilot.id },
    { flightRules: "IFR" },
    { flightRules: "VFR" },
    { flightRules: "VFR" },
  ]);
  expect(prefill({ route: "DCT" }).remarks).toBe("Planned route: DCT");
  expect(prefill({ route: "" }).remarks).toBe("");
  for (const members of [
    [...s.members, { ...pilot, id: "twin" }],
    [{ ...pilot, active: false }],
    [{ ...pilot, availableAsPilot: false }],
  ])
    expect(prefill({}, members).pilotId).toBe("me");
});
