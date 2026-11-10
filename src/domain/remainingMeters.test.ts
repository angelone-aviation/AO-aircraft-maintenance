/**
 * Responsibility: Pins the remaining share of an interval and the per-limit
 *   meters of an inspection: clamping, unknown intervals and levels.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/remainingMeters.ts, ./maintenance, ./model.
 */
import { describe, expect, it } from "vitest";
import { inspectionStatus } from "./maintenance";
import type { Aircraft, Inspection } from "./model";
import {
  inspectionInterval,
  inspectionRemainingMeters,
  remainingShare,
} from "./remainingMeters";

const HOUR = 3600;
const TODAY = "2026-11-10";

describe("remainingShare", () => {
  it("is the remaining part of the interval", () => {
    expect(remainingShare(25, 100)).toBe(0.25);
  });

  it("is 0 at zero and below zero remaining", () => {
    expect(remainingShare(0, 100)).toBe(0);
    expect(remainingShare(-12, 100)).toBe(0);
  });

  it("is capped at 1 when more than the interval remains", () => {
    expect(remainingShare(150, 100)).toBe(1);
  });

  it("is unknown without a positive interval or a remainder", () => {
    expect(remainingShare(10, undefined)).toBeUndefined();
    expect(remainingShare(10, 0)).toBeUndefined();
    expect(remainingShare(10, -5)).toBeUndefined();
    expect(remainingShare(undefined, 100)).toBeUndefined();
  });
});

describe("inspectionInterval", () => {
  it("prefers the recorded interval over the span from the last compliance", () => {
    const i = inspection({
      intervalSeconds: 100 * HOUR,
      lastSeconds: 1000 * HOUR,
      dueSeconds: 1110 * HOUR,
    });
    expect(inspectionInterval(i, "hours")).toBe(100);
  });

  it("uses the span from the last compliance for a one-time limit", () => {
    const i = inspection({ lastCycles: 200, dueCycles: 500 });
    expect(inspectionInterval(i, "cycles")).toBe(300);
  });

  it("measures a calendar interval from the last date to the due date", () => {
    const i = inspection({ lastDate: "2026-01-15", intervalMonths: 12 });
    // Due at the end of January 2027: 381 days after 15 January 2026.
    expect(inspectionInterval(i, "days")).toBe(381);
  });

  it("is unknown with only a due value, or when calendar exempt", () => {
    expect(
      inspectionInterval(inspection({ dueLandings: 50 }), "landings"),
    ).toBeUndefined();
    const exempt = inspection({
      calendarExempt: true,
      lastDate: "2026-01-15",
      intervalMonths: 12,
    });
    expect(inspectionInterval(exempt, "days")).toBeUndefined();
  });
});

describe("inspectionRemainingMeters", () => {
  it("gives each set limit its share and the level its threshold sets", () => {
    const i = inspection({
      intervalSeconds: 100 * HOUR,
      dueSeconds: 1005 * HOUR,
      dueLandings: 40,
    });
    const meters = inspectionRemainingMeters(i, status(i, 1000 * HOUR));
    expect(meters).toEqual([
      { dimension: "hours", remaining: 5, share: 0.05, level: "due-soon" },
      { dimension: "landings", remaining: 30, share: undefined, level: "ok" },
    ]);
  });

  it("reads a usage limit at 0 as overdue and a calendar limit on its due day as due soon", () => {
    const i = inspection({
      lastCycles: 0,
      dueCycles: 10,
      lastDate: "2025-11-10",
      dueDate: TODAY,
    });
    const meters = inspectionRemainingMeters(i, status(i, 0, 10));
    expect(meters.map((m) => [m.dimension, m.share, m.level])).toEqual([
      ["days", 0, "due-soon"],
      ["cycles", 0, "overdue"],
    ]);
  });
});

function inspection(fields: Partial<Inspection>): Inspection {
  return {
    uuid: "i1",
    aircraftUuid: "a1",
    reference: "100-hour",
    description: "Inspection",
    ...fields,
  };
}

function status(i: Inspection, seconds: number, cycles = 0) {
  const aircraft = { landings: 10, cycles } as Aircraft;
  return inspectionStatus(i, aircraft, TODAY, { seconds, cycles });
}
