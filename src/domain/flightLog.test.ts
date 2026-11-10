/**
 * Responsibility: Pins the flight log's rows: what the search matches, the
 *   aircraft and status filters, newest-first order and the status counts.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/flightLog.ts, src/data/demo.ts (seed).
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { flightLogRows, type FlightLogFilters } from "./flightLog";
import type { Flight } from "./model";

const DEMO = demoSnapshot();
const [N206, N208] = DEMO.aircraft;
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
