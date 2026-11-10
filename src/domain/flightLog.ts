/**
 * Responsibility: Chooses the flight log's rows: the search, aircraft and
 *   status filters, newest first, and the status counts beside them.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: src/domain/model.ts (types), src/domain/listSearch.ts.
 */
import type { Flight, Snapshot } from "./model";
import { matchesSearch } from "./listSearch";

/** The flights the log shows at first, and adds with each "Show more". */
export const FLIGHT_LOG_PAGE_SIZE = 50;

/** The flight log's status choices: every flight or one status. */
export type FlightStatusFilter = "all" | Flight["status"];

/** What the user chose to narrow the flight log by. */
export interface FlightLogFilters {
  /** Matched against registration, pilot, route, remarks and date. */
  search: string;
  /** One aircraft, or "" for every aircraft. */
  aircraftUuid: string;
  status: FlightStatusFilter;
}

/** The flight log's rows and its status counts. */
export interface FlightLogRows {
  /** Every flight matching all three filters, newest first. */
  flights: Flight[];
  /** Flights matching the search and aircraft, by status, whatever status
   * is chosen, so each status choice shows what picking it would list. */
  counts: Record<FlightStatusFilter, number>;
}

// The date as the log shows it in the US ("Nov 3, 2026").
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * The flight log's rows for the chosen filters.
 *
 * @param s - The flights, and the aircraft and members whose registration
 *   and names the search matches.
 * @returns The rows, newest start time first, and the status counts. The
 *   date matches as recorded ("2026-11-03") and as shown in this browser's
 *   time zone ("Nov 3, 2026").
 */
export function flightLogRows(
  s: Pick<Snapshot, "flights" | "aircraft" | "members">,
  filters: FlightLogFilters,
): FlightLogRows {
  const counts = { all: 0, accepted: 0, review: 0, rejected: 0 };
  const flights = s.flights
    .filter(
      (f) => !filters.aircraftUuid || f.aircraftUuid === filters.aircraftUuid,
    )
    .filter((f) => matchesSearch(filters.search, searchFields(s, f)));
  for (const f of flights) {
    counts.all++;
    counts[f.status]++;
  }
  return {
    flights: flights
      .filter((f) => filters.status === "all" || f.status === filters.status)
      .sort((a, b) => b.startTime.localeCompare(a.startTime)),
    counts,
  };
}

function searchFields(s: Pick<Snapshot, "aircraft" | "members">, f: Flight) {
  const name = (id?: string) => s.members.find((m) => m.id === id)?.name;
  return [
    s.aircraft.find((a) => a.uuid === f.aircraftUuid)?.registration,
    name(f.pilotId),
    name(f.copilotId),
    f.origin,
    f.destination,
    f.remarks,
    f.startTime.slice(0, "YYYY-MM-DD".length),
    shownDate(f.startTime),
  ];
}

function shownDate(startTime: string) {
  const at = new Date(startTime);
  return `${MONTHS[at.getMonth()]} ${at.getDate()}, ${at.getFullYear()}`;
}
