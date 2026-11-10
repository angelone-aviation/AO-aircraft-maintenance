/**
 * Responsibility: Pins what "Same as last flight" copies and which places
 *   the route fields suggest, in which order.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/flightSuggestions.ts, src/domain/model.ts.
 */
import { describe, expect, it } from "vitest";
import {
  frequentPlaces,
  lastFlightFill,
  PLACE_SUGGESTION_LIMIT,
} from "./flightSuggestions";
import type { Flight, Member } from "./model";

const PLANE = "plane-1";

function flight(over: Partial<Flight>): Flight {
  return {
    uuid: crypto.randomUUID(),
    aircraftUuid: PLANE,
    pilotId: "ann",
    startTime: "2026-11-01T10:00:00Z",
    hobbsOn: 100,
    landings: 1,
    cycles: 0,
    origin: "",
    destination: "",
    operation: "Mission",
    flightRules: "VFR",
    remarks: "",
    discrepancy: "",
    authorId: "ann",
    submittedAt: 0,
    status: "accepted",
    ...over,
  };
}

function member(id: string, over: Partial<Member> = {}): Member {
  return {
    id,
    name: id,
    email: `${id}@example.com`,
    active: true,
    isAdmin: false,
    groupIds: [],
    ...over,
  };
}

const members = [member("ann"), member("bob"), member("cy")];

describe("lastFlightFill", () => {
  it("copies only pilot, copilot and route from the latest flight", () => {
    const flights = [
      flight({
        startTime: "2026-11-02T08:00:00Z",
        pilotId: "bob",
        origin: "KBOI",
        destination: "KMYL",
        copilotId: "cy",
        fuel: { unit: "US gal", added: 10 },
      }),
      flight({
        startTime: "2026-11-01T08:00:00Z",
        pilotId: "ann",
        origin: "KOLD",
      }),
    ];
    expect(lastFlightFill({ flights, members }, PLANE)).toEqual({
      pilotId: "bob",
      copilotId: "cy",
      origin: "KBOI",
      destination: "KMYL",
    });
  });

  it("orders by flight time across time zones, then by submission", () => {
    const flights = [
      flight({ startTime: "2026-11-02T09:00:00+02:00", origin: "EARLIER" }),
      flight({
        startTime: "2026-11-02T08:00:00Z",
        origin: "LATER",
        submittedAt: 1,
      }),
      flight({
        startTime: "2026-11-02T08:00:00Z",
        origin: "LATEST",
        submittedAt: 2,
      }),
    ];
    expect(lastFlightFill({ flights, members }, PLANE)?.origin).toBe("LATEST");
  });

  it("ignores other aircraft and rejected flights", () => {
    const flights = [
      flight({
        startTime: "2026-11-03T08:00:00Z",
        aircraftUuid: "other",
        origin: "OTHER",
      }),
      flight({
        startTime: "2026-11-02T08:00:00Z",
        status: "rejected",
        origin: "REJECTED",
      }),
      flight({ startTime: "2026-11-01T08:00:00Z", origin: "KEPT" }),
    ];
    expect(lastFlightFill({ flights, members }, PLANE)?.origin).toBe("KEPT");
  });

  it("returns undefined when the aircraft has no previous flight", () => {
    expect(lastFlightFill({ flights: [], members }, PLANE)).toBeUndefined();
  });

  it("leaves out a pilot or copilot who can no longer be chosen", () => {
    const flights = [flight({ pilotId: "gone", copilotId: "away" })];
    const people = [
      ...members,
      member("gone", { active: false }),
      member("away", { availableAsPilot: false }),
    ];
    const fill = lastFlightFill({ flights, members: people }, PLANE);
    expect(fill).toMatchObject({ pilotId: undefined, copilotId: undefined });
  });
});

describe("frequentPlaces", () => {
  it("ranks by use across origins and destinations, then by recency", () => {
    const flights = [
      flight({
        startTime: "2026-11-01T08:00:00Z",
        origin: "KBOI",
        destination: "KMYL",
      }),
      flight({
        startTime: "2026-11-02T08:00:00Z",
        origin: "KMYL",
        destination: "KBOI",
      }),
      flight({
        startTime: "2026-11-03T08:00:00Z",
        origin: "KMYL",
        destination: "S87",
      }),
      flight({ startTime: "2026-11-04T08:00:00Z", origin: "U70" }),
    ];
    expect(frequentPlaces(flights)).toEqual(["KMYL", "KBOI", "U70", "S87"]);
  });

  it("merges spellings that differ only in case or spaces, keeping the latest", () => {
    const flights = [
      flight({ startTime: "2026-11-02T08:00:00Z", origin: " KBOI " }),
      flight({ startTime: "2026-11-01T08:00:00Z", origin: "kboi" }),
      flight({ startTime: "2026-10-01T08:00:00Z", destination: "Kboi" }),
    ];
    expect(frequentPlaces(flights)).toEqual(["KBOI"]);
  });

  it("skips blank places and rejected flights", () => {
    const flights = [
      flight({ origin: "  ", destination: "" }),
      flight({ origin: "KREJ", status: "rejected" }),
    ];
    expect(frequentPlaces(flights)).toEqual([]);
  });

  it(`keeps the top ${PLACE_SUGGESTION_LIMIT}`, () => {
    const flights = Array.from({ length: 10 }, (_, i) =>
      flight({ origin: `P${i}`, destination: i < 2 ? "HUB" : "" }),
    );
    const places = frequentPlaces(flights);
    expect(places).toHaveLength(PLACE_SUGGESTION_LIMIT);
    expect(places[0]).toBe("HUB");
  });
});
