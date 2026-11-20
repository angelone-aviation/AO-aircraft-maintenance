/**
 * Responsibility: Pins the flight log's rows: what the search matches, the
 *   aircraft and status filters, newest-first order, the status counts and
 *   the weekly hours and flights behind the log's charts.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/flightLog.ts, src/data/demo.ts (seed).
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  FLIGHT_ACTIVITY_WEEKS,
  flightLogRows,
  weeklyFlightActivity,
  type FlightLogFilters,
} from "./flightLog";
import type { Flight } from "./model";

const DEMO = demoSnapshot();
const [N206, N208] = DEMO.aircraft;
const HOUR_SECONDS = 3600;
const ALL: FlightLogFilters = { search: "", aircraftUuid: "", status: "all" };

describe("flightLogRows", () => {
  it("lists every flight newest first with no filters", () => {
    const s = withFlights(
      flight("a", { startTime: "2026-10-01T12:00:00Z" }),
      flight("b", { startTime: "2026-10-03T12:00:00Z" }),
      flight("c", { startTime: "2026-10-02T12:00:00Z" }),
    );
    expect(uuids(flightLogRows(s, ALL).flights)).toEqual(["b", "c", "a"]);
  });

  it("orders by start instant across offsets, equal starts by uuid highest first, as history pages do", () => {
    const s = withFlights(
      flight("utc", { startTime: "2026-10-01T14:00:00Z" }),
      flight("pacific", { startTime: "2026-10-01T12:00:00-07:00" }),
      flight("tie-a", { startTime: "2026-09-30T12:00:00Z" }),
      flight("tie-b", { startTime: "2026-09-30T05:00:00-07:00" }),
    );
    expect(uuids(flightLogRows(s, ALL).flights)).toEqual([
      "pacific",
      "utc",
      "tie-b",
      "tie-a",
    ]);
  });

  it("matches registration, pilot, copilot, route and remarks, ignoring case and spaces", () => {
    const s = withFlights(
      flight("reg", { aircraftUuid: N208.uuid }),
      flight("pilot", { pilotId: "demo-pilot" }),
      flight("copilot", { copilotId: "demo-pilot", pilotId: "nobody" }),
      flight("origin", { origin: "KPAE" }),
      flight("destination", { destination: "KPAE" }),
      flight("remarks", { remarks: "Medevac to Spokane" }),
    );
    expect(search(s, "n208")).toEqual(["reg"]);
    expect(search(s, "  jordan ")).toEqual(["copilot", "pilot"]);
    expect(search(s, "kpae")).toEqual(["destination", "origin"]);
    expect(search(s, "SPOKANE")).toEqual(["remarks"]);
  });

  it("matches the date as recorded and as shown", () => {
    const s = withFlights(
      flight("nov", { startTime: "2026-11-03T12:00:00Z" }),
      flight("oct", { startTime: "2026-10-30T12:00:00Z" }),
    );
    expect(search(s, "2026-11-03")).toEqual(["nov"]);
    expect(search(s, "Nov 3")).toEqual(["nov"]);
    expect(search(s, "Oct 30, 2026")).toEqual(["oct"]);
  });

  it("does not match across two fields", () => {
    const s = withFlights(flight("a", { origin: "KSEA", destination: "KBFI" }));
    expect(search(s, "KSEA KBFI")).toEqual([]);
  });

  it("narrows to one aircraft and one status", () => {
    const s = withFlights(
      flight("206", { aircraftUuid: N206.uuid }),
      flight("208", { aircraftUuid: N208.uuid }),
      flight("208-held", { aircraftUuid: N208.uuid, status: "review" }),
    );
    const one = { ...ALL, aircraftUuid: N208.uuid };
    expect(uuids(flightLogRows(s, one).flights)).toEqual(["208-held", "208"]);
    const held = { ...one, status: "review" as const };
    expect(uuids(flightLogRows(s, held).flights)).toEqual(["208-held"]);
  });

  it("counts statuses over the search and aircraft, whatever status is chosen", () => {
    const s = withFlights(
      flight("a", { aircraftUuid: N208.uuid }),
      flight("b", { aircraftUuid: N208.uuid, status: "review" }),
      flight("c", { aircraftUuid: N208.uuid, status: "rejected" }),
      flight("d", { aircraftUuid: N206.uuid }),
    );
    const { counts } = flightLogRows(s, {
      search: "N208",
      aircraftUuid: "",
      status: "rejected",
    });
    expect(counts).toEqual({ all: 3, accepted: 1, review: 1, rejected: 1 });
  });
});

// Local times with no zone, so the weeks are the same wherever this runs.
describe("weeklyFlightActivity", () => {
  it("returns no weeks for no flights", () => {
    expect(weeklyFlightActivity([])).toEqual([]);
  });

  it("sums Hobbs hours and counts flights by Monday-first week, oldest first", () => {
    const weeks = weeklyFlightActivity(
      [
        // Sunday 8 Nov 2026 belongs to the week of Monday 2 Nov.
        flight("sun", { startTime: "2026-11-08T23:30", ...hobbs(10, 11.2) }),
        flight("mon", { startTime: "2026-11-02T00:10", ...hobbs(8, 8.7) }),
        flight("next", { startTime: "2026-11-09T09:00", ...hobbs(11.2, 13.3) }),
      ],
      3,
    );
    expect(weeks).toEqual([
      { label: "Oct 26", hours: 0, flights: 0 },
      { label: "Nov 2", hours: 1.9, flights: 2 },
      { label: "Nov 9", hours: 2.1, flights: 1 },
    ]);
  });

  it("counts a flight missing a reading with no hours, and leaves out flights before the first week", () => {
    const weeks = weeklyFlightActivity(
      [
        flight("new", { startTime: "2026-11-10T09:00", hobbsOn: 5 }),
        flight("old", { startTime: "2026-10-01T09:00", ...hobbs(1, 4) }),
      ],
      2,
    );
    expect(weeks).toEqual([
      { label: "Nov 2", hours: 0, flights: 0 },
      { label: "Nov 9", hours: 0, flights: 1 },
    ]);
  });

  it("keeps weeks on local Mondays across a daylight-saving change", () => {
    const weeks = weeklyFlightActivity([
      flight("spring", { startTime: "2026-03-20T12:00", ...hobbs(1, 2) }),
    ]);
    expect(weeks).toHaveLength(FLIGHT_ACTIVITY_WEEKS);
    expect(weeks.at(-1)).toEqual({ label: "Mar 16", hours: 1, flights: 1 });
    expect(weeks[0].label).toBe("Dec 29");
  });
});

// Readings in hours, stored in seconds as the app stores them.
function hobbs(off: number, on: number) {
  return { hobbsOff: off * HOUR_SECONDS, hobbsOn: on * HOUR_SECONDS };
}

// Sorted by uuid: these tests pin what matches, not the order.
function search(s: ReturnType<typeof withFlights>, text: string) {
  return uuids(flightLogRows(s, { ...ALL, search: text }).flights).sort();
}

function uuids(flights: Flight[]) {
  return flights.map((f) => f.uuid);
}

function withFlights(...flights: Flight[]) {
  return { ...DEMO, flights };
}

// Each flight starts a minute after the previous one, so the order of the
// arguments is the oldest-first order unless a start time is given.
let minute = 0;
function flight(uuid: string, overrides: Partial<Flight> = {}): Flight {
  minute++;
  return {
    uuid,
    aircraftUuid: N206.uuid,
    authorId: DEMO.user.id,
    pilotId: DEMO.user.id,
    submittedAt: 0,
    status: "accepted",
    startTime: `2026-09-01T12:${String(minute % 60).padStart(2, "0")}:00Z`,
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
