/**
 * Responsibility: Pins the meter and hours rules of the core model: the
 *   reading an aircraft's own meter gives, and hours typed as text.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/model.ts, ./rejection.
 */
import { describe, expect, it } from "vitest";
import { aircraftMeterReading, parseHours, type Aircraft } from "./model";
import { Rejection } from "./rejection";

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
