/**
 * Responsibility: Pins how flights are added up per week and per month: the
 *   Monday week, the period order, which flights count and the fleet total.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/flightHours.ts, src/domain/model.ts,
 *   src/data/demo.ts.
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { flownByMonth, flownByWeek, flownSeconds } from "./flightHours";
import type { Flight, Snapshot } from "./model";

const HOUR = 3600;
// A Wednesday; its week starts on Monday 2026-11-09.
const TODAY = "2026-11-11";

/** The demo with accepted flights of the given length on local noon. */
function flown(
  ...flights: [date: string, aircraftUuid: string, hours: number][]
): Snapshot {
  const s = demoSnapshot();
  s.flights = flights.map(([date, aircraftUuid, hours], n) =>
    flight(n, date, aircraftUuid, hours),
  );
  return s;
}

function flight(n: number, date: string, aircraftUuid: string, hours: number) {
  const [year, month, day] = date.split("-").map(Number);
  return {
    uuid: `flight-${n}`,
    aircraftUuid,
    startTime: new Date(year, month - 1, day, 12).toISOString(),
    pilotId: "demo-admin",
    authorId: "demo-admin",
    submittedAt: 0,
    status: "accepted",
    landings: 1,
    cycles: 1,
    origin: "",
    destination: "",
    operation: "Mission",
    flightRules: "VFR",
    remarks: "",
    discrepancy: "",
    hobbsOff: 100 * HOUR,
    hobbsOn: (100 + hours) * HOUR,
  } satisfies Flight;
}

describe("flownByWeek", () => {
  it("returns Monday weeks, oldest first, ending with this week", () => {
    const weeks = flownByWeek(flown(), TODAY, 3);
    expect(weeks.map((w) => w.start)).toEqual([
      "2026-10-26",
      "2026-11-02",
      "2026-11-09",
    ]);
    expect(weeks.every((w) => flownSeconds(w) === 0)).toBe(true);
  });

  it("starts the week on Monday itself and keeps Sunday in the week before", () => {
    expect(flownByWeek(flown(), "2026-11-09", 1)[0].start).toBe("2026-11-09");
    expect(flownByWeek(flown(), "2026-11-08", 1)[0].start).toBe("2026-11-02");
  });

  it("adds each aircraft's flights in the week they started", () => {
    const s = flown(
      ["2026-11-09", "demo-206", 1.5],
      ["2026-11-10", "demo-206", 0.5],
      ["2026-11-10", "demo-208", 2],
      ["2026-11-08", "demo-208", 3],
    );
    const [last, current] = flownByWeek(s, TODAY, 2);
    expect(current.seconds).toEqual({
      "demo-206": 2 * HOUR,
      "demo-208": 2 * HOUR,
    });
    expect(last.seconds).toEqual({ "demo-208": 3 * HOUR });
    expect(flownSeconds(current)).toBe(4 * HOUR);
    expect(flownSeconds(current, "demo-206")).toBe(2 * HOUR);
    expect(flownSeconds(last, "demo-206")).toBe(0);
  });

  it("leaves out flights before the first week, held flights and unknown aircraft", () => {
    const s = flown(
      ["2026-11-01", "demo-206", 1],
      ["2026-11-10", "demo-206", 1],
      ["2026-11-10", "not-in-snapshot", 1],
    );
    s.flights[1] = { ...s.flights[1], status: "review" };
    expect(flownByWeek(s, TODAY, 1)[0].seconds).toEqual({});
  });
});

describe("flownByMonth", () => {
  it("returns calendar months, oldest first, across a year end", () => {
    const s = flown(
      ["2025-12-31", "demo-182", 1],
      ["2026-01-01", "demo-182", 2],
      ["2026-02-28", "demo-182", 4],
    );
    const months = flownByMonth(s, "2026-02-15", 3);
    expect(months.map((m) => m.start)).toEqual([
      "2025-12-01",
      "2026-01-01",
      "2026-02-01",
    ]);
    expect(months.map((m) => flownSeconds(m, "demo-182"))).toEqual([
      1 * HOUR,
      2 * HOUR,
      4 * HOUR,
    ]);
  });
});
