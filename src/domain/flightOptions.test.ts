/**
 * Responsibility: Pins the per-aircraft flight fields: engine positions, the
 *   optional meters, start readings and landing surface through validation,
 *   outbox and rebuilds.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/flights.ts, ./model, src/data/demo.ts (fixture).
 */
import { describe, it, expect } from "vitest";
import { demoSnapshot } from "../data/demo";
import { flightInputSchema, operationSchema, type FlightInput } from "./model";
import {
  flightEnginePositions,
  flightOptionalEntries,
  rebuildFlights,
} from "./flights";

const HOUR_SECONDS = 3600;

/** A one-hour flight, by Hobbs, on the first demo aircraft. */
const input: FlightInput = {
  aircraftUuid: "demo-206",
  pilotId: "demo-admin",
  startTime: "2026-01-01T10:00:00Z",
  hobbsOn: demoSnapshot().aircraft[0].currentHobbs + HOUR_SECONDS,
  landings: 1,
  cycles: 1,
  origin: "AAA",
  destination: "BBB",
  operation: "Mission",
  flightRules: "VFR",
  remarks: "",
  discrepancy: "",
};
describe("aircraft-specific flight fields", () => {
  it.each([
    [{}, []],
    [{ twin: true }, []],
    [{ turbine: true }, ["single"]],
    [{ twin: true, turbine: true }, ["left", "right"]],
  ] as const)("selects engine fields for %j", (options, engines) => {
    expect(flightEnginePositions(options)).toEqual(engines);
  });
  it("retains historical positions even when aircraft options change", () => {
    expect(
      flightEnginePositions(
        {},
        { engineStarts: [{ engine: "left" }, { engine: "right" }] },
      ),
    ).toEqual(["left", "right"]);
    expect(
      flightEnginePositions(
        { twin: true, turbine: true },
        { engineStarts: [{ engine: "single" }] },
      ),
    ).toEqual(["single"]);
  });
  it("records the collective, flight time log and landing surface where the aircraft keeps them", () => {
    expect(flightOptionalEntries({})).toEqual({
      cyclic: false,
      flightTimeLog: false,
      landingSurface: false,
    });
    expect(
      flightOptionalEntries({
        helicopter: true,
        flightTimeLog: true,
        amphibious: true,
      }),
    ).toEqual({ cyclic: true, flightTimeLog: true, landingSurface: true });
  });
  it("records the meter a flight needs and entries a flight already holds", () => {
    expect(flightOptionalEntries({}, "cyclic")).toMatchObject({
      cyclic: true,
      flightTimeLog: false,
    });
    expect(flightOptionalEntries({}, "flightTimeLog")).toMatchObject({
      cyclic: false,
      flightTimeLog: true,
    });
    const held = { cyclicHobbsOn: 0, flightTimeLogOn: 0, landingSurface: null };
    expect(flightOptionalEntries({}, "hobbs", held)).toEqual({
      cyclic: true,
      flightTimeLog: true,
      landingSurface: false,
    });
    expect(
      flightOptionalEntries({}, "tach", { landingSurface: "land" }),
    ).toMatchObject({ landingSurface: true });
  });
  it("preserves turbine and landing information through offline payload validation and flight rebuilds", () => {
    const engineStarts = [
      { engine: "left" as const, durationSeconds: 12.5, maxEgtC: 670 },
      { engine: "right" as const, durationSeconds: 14, maxEgtC: 690 },
    ];
    const parsed = flightInputSchema.parse({
      ...input,
      engineStarts,
      landingSurface: "sea",
    });
    const operation = operationSchema.parse({
      kind: "flight",
      uuid: crypto.randomUUID(),
      authorId: "demo-admin",
      baseVersion: 0,
      input: parsed,
    });
    expect(operation.kind === "flight" && operation.input.engineStarts).toEqual(
      engineStarts,
    );
    const rebuilt = rebuildFlights(demoSnapshot().aircraft[0], [
      {
        ...parsed,
        uuid: "flight",
        authorId: "demo-admin",
        submittedAt: 0,
        status: "accepted",
      },
    ]);
    expect(rebuilt.flights[0]).toMatchObject({
      engineStarts,
      landingSurface: "sea",
    });
    expect(rebuilt.aircraft.landings).toBe(
      demoSnapshot().aircraft[0].baselineLandings + 1,
    );
  });
  it("accepts old logs and missing optional readings without manufacturing zeros", () => {
    expect(flightInputSchema.parse(input).engineStarts).toBeUndefined();
    expect(
      flightInputSchema.parse({
        ...input,
        engineStarts: [{ engine: "single" }],
      }).engineStarts,
    ).toEqual([{ engine: "single" }]);
  });
  it("rejects invalid durations, duplicate engines, mixed layouts and unknown landing surfaces", () => {
    for (const engineStarts of [
      [{ engine: "single", durationSeconds: -1 }],
      [{ engine: "left" }, { engine: "left" }],
      [{ engine: "single" }, { engine: "right" }],
    ])
      expect(() =>
        flightInputSchema.parse({ ...input, engineStarts }),
      ).toThrow();
    expect(() =>
      flightInputSchema.parse({ ...input, landingSurface: "water-or-land" }),
    ).toThrow();
  });
});
