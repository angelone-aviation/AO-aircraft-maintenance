/**
 * Responsibility: Pins the meter, hours and flight entry rules of the core
 *   model: the reading an aircraft's own meter gives, its total time when
 *   recorded, hours typed as text, the flight entry limits, who may fly, and
 *   the R66's cycles.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/model.ts, ./rejection, src/data/demo.ts (seed).
 */
import { describe, expect, it } from "vitest";
import {
  aircraftMeterReading,
  FLIGHT_COUNT_MAX,
  FLIGHT_PLACE_MAX_LENGTH,
  flightInputSchema,
  isAvailablePilot,
  logsEngineStartsAsCycles,
  NOTE_MAX_LENGTH,
  operationSchema,
  parseHours,
  recordedTotalSeconds,
  type Aircraft,
  type FlightInput,
} from "./model";
import { Rejection } from "./rejection";
import { demoSnapshot } from "../data/demo";

const READINGS = {
  meter: "hobbs" as Aircraft["meter"],
  currentHobbs: 3600,
  currentTach: 7200,
  currentCyclicHobbs: 10800,
  currentFlightTimeLog: 14400,
};

function expectRejection(run: () => unknown, message: string) {
  expect(run).toThrow(Rejection);
  expect(run).toThrow(new Error(message));
}

describe("aircraftMeterReading", () => {
  it("reads the aircraft's own meter", () => {
    const meters = ["hobbs", "tach", "cyclic", "flightTimeLog"] as const;
    expect(
      meters.map((meter) => aircraftMeterReading({ ...READINGS, meter })),
    ).toEqual([3600, 7200, 10800, 14400]);
  });

  it("refuses a meter without a reading, as a Rejection", () => {
    expectRejection(
      () =>
        aircraftMeterReading({
          ...READINGS,
          meter: "flightTimeLog",
          currentFlightTimeLog: undefined,
        }),
      "Flight time log reading is required.",
    );
    expectRejection(
      () =>
        aircraftMeterReading({
          ...READINGS,
          meter: "cyclic",
          currentCyclicHobbs: undefined,
        }),
      "Collective hourmeter reading is required.",
    );
  });
});

describe("recordedTotalSeconds", () => {
  const aircraft = {
    ...demoSnapshot().aircraft[0],
    ...READINGS,
    adjustmentSeconds: 60,
  };

  it("is the total time, or undefined when the meter has no reading", () => {
    expect(recordedTotalSeconds(aircraft)).toBe(3660);
    for (const meter of ["flightTimeLog", "cyclic"] as const)
      expect(
        recordedTotalSeconds({
          ...aircraft,
          meter,
          currentFlightTimeLog: undefined,
          currentCyclicHobbs: undefined,
        }),
      ).toBeUndefined();
  });

  it("lets any other error through", () => {
    expect(() =>
      recordedTotalSeconds(undefined as unknown as Aircraft),
    ).toThrow(TypeError);
  });
});

describe("parseHours", () => {
  it("reads blank as no value and tenths of an hour as seconds", () => {
    expect([parseHours(" "), parseHours("1234.5")]).toEqual([
      undefined,
      4444200,
    ]);
  });

  it("refuses other text and readings past the safe range, as a Rejection", () => {
    for (const value of ["1.25", " 1", "-1", "1e3"])
      expectRejection(
        () => parseHours(value),
        "Use positive hours with at most one decimal place.",
      );
    expectRejection(
      () => parseHours("9".repeat(16)),
      "Meter reading is too large.",
    );
  });
});

describe("flight entry rules", () => {
  const flight: FlightInput = {
    aircraftUuid: "demo-206",
    pilotId: "demo-admin",
    startTime: "2026-01-01T10:00:00Z",
    landings: 1,
    cycles: 0,
    origin: "",
    destination: "",
    operation: "Mission",
    flightRules: "VFR",
    remarks: "",
    discrepancy: "",
  };
  const accepts = (field: keyof FlightInput, value: string | number) =>
    flightInputSchema.safeParse({ ...flight, [field]: value }).success;

  it("bounds places, notes and counts at the exported limits", () => {
    const limits = [
      ["origin", FLIGHT_PLACE_MAX_LENGTH],
      ["destination", FLIGHT_PLACE_MAX_LENGTH],
      ["remarks", NOTE_MAX_LENGTH],
      ["discrepancy", NOTE_MAX_LENGTH],
    ] as const;
    for (const [field, max] of limits) {
      expect(accepts(field, "x".repeat(max))).toBe(true);
      expect(accepts(field, "x".repeat(max + 1))).toBe(false);
    }
    for (const field of ["landings", "cycles"] as const) {
      expect(accepts(field, FLIGHT_COUNT_MAX)).toBe(true);
      expect(accepts(field, FLIGHT_COUNT_MAX + 1)).toBe(false);
    }
  });

  it("bounds a problem report at the note limit", () => {
    const report = (description: string) =>
      operationSchema.safeParse({
        kind: "discrepancy",
        uuid: crypto.randomUUID(),
        authorId: "demo-pilot",
        aircraftUuid: "demo-206",
        description,
      }).success;
    expect(report("x".repeat(NOTE_MAX_LENGTH))).toBe(true);
    expect(report("x".repeat(NOTE_MAX_LENGTH + 1))).toBe(false);
  });

  it("offers active members not marked unavailable as pilots", () => {
    expect(
      [
        { active: true },
        { active: true, availableAsPilot: true },
        { active: true, availableAsPilot: false },
        { active: false, availableAsPilot: true },
      ].map(isAvailablePilot),
    ).toEqual([true, true, false, false]);
  });

  it("counts an R66's cycles as engine starts, ignoring case and spaces", () => {
    expect(
      ["R66", " r66 ", "R44", "R660"].map(logsEngineStartsAsCycles),
    ).toEqual([true, true, false, false]);
  });
});
