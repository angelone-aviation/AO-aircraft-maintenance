/**
 * Responsibility: Suggestions for a new flight drawn from the program's own
 *   flight records: the last flight's crew and route, and the most-used
 *   places.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: src/domain/model.ts (Flight, Member, isAvailablePilot).
 *
 * Suggestions never include readings, times, fuel or remarks: starting
 * readings come from the aircraft's totals, and the rest belongs to the
 * flight being logged.
 */
import { isAvailablePilot, type Flight, type Snapshot } from "./model";

/** How many places the route fields suggest. */
export const PLACE_SUGGESTION_LIMIT = 8;

/** What "Same as last flight" fills in on a new flight. */
export interface LastFlightFill {
  /** Undefined when that pilot can no longer be chosen. */
  pilotId?: string;
  /** Undefined for no copilot, or one who can no longer be chosen. */
  copilotId?: string;
  origin: string;
  destination: string;
}

/**
 * Finds the crew and route of an aircraft's most recent flight.
 *
 * @param s - The visible flights and the program's members.
 * @param aircraftUuid - The aircraft being flown.
 * @returns The fill from the flight with the latest start time (ties: the
 *   latest submitted), rejected flights left out; undefined when there is
 *   none.
 */
export function lastFlightFill(
  s: Pick<Snapshot, "flights" | "members">,
  aircraftUuid: string,
): LastFlightFill | undefined {
  const last = s.flights
    .filter((f) => f.aircraftUuid === aircraftUuid && f.status !== "rejected")
    .reduce<Flight | undefined>(
      (best, f) => (!best || isLater(f, best) ? f : best),
      undefined,
    );
  if (!last) return undefined;
  const choosable = (id: string | undefined) =>
    s.members.some((m) => m.id === id && isAvailablePilot(m)) ? id : undefined;
  return {
    pilotId: choosable(last.pilotId),
    copilotId: choosable(last.copilotId),
    origin: last.origin,
    destination: last.destination,
  };
}

/**
 * Lists the places the program flies to and from most, for the route
 * fields to suggest.
 *
 * @param flights - The program's visible flights.
 * @returns Up to {@link PLACE_SUGGESTION_LIMIT} places, most used first
 *   (origins and destinations counted together), ties most recent first.
 *   Spellings that differ only in case or surrounding spaces count as one
 *   place, shown as most recently written. Rejected flights are left out.
 */
export function frequentPlaces(flights: Flight[]): string[] {
  const tally = new Map<string, PlaceTally>();
  for (const f of flights) {
    if (f.status === "rejected") continue;
    countPlace(tally, f.origin, f.startTime);
    countPlace(tally, f.destination, f.startTime);
  }
  return [...tally.values()]
    .sort((x, y) => y.count - x.count || y.latest - x.latest)
    .slice(0, PLACE_SUGGESTION_LIMIT)
    .map((t) => t.name);
}

interface PlaceTally {
  name: string;
  count: number;
  latest: number;
}

function countPlace(tally: Map<string, PlaceTally>, raw: string, at: string) {
  const name = raw.trim();
  if (!name) return;
  const key = name.toUpperCase();
  const time = Date.parse(at);
  const seen = tally.get(key);
  if (!seen) {
    tally.set(key, { name, count: 1, latest: time });
    return;
  }
  seen.count++;
  if (time < seen.latest) return;
  seen.latest = time;
  seen.name = name;
}

function isLater(f: Flight, than: Flight) {
  const diff = Date.parse(f.startTime) - Date.parse(than.startTime);
  return diff > 0 || (diff === 0 && f.submittedAt > than.submittedAt);
}
