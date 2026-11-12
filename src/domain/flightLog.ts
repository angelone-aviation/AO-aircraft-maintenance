/**
 * Responsibility: Chooses the flight log's rows: the search, aircraft and
 *   status filters, newest first, the status counts beside them, and the
 *   rows' Hobbs hours and flights by week for the log's charts.
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

/** The weeks the flight log's charts show, ending at the newest flight. */
export const FLIGHT_ACTIVITY_WEEKS = 12;

/** One week of the flight log's charts. */
export interface FlightWeek {
  /** The week's Monday in this browser's time zone, as "Nov 2". */
  label: string;
  /** Hobbs hours flown, to a tenth; a flight missing a reading adds none. */
  hours: number;
  flights: number;
}

const DAYS_PER_WEEK = 7;
// getDay() counts from Sunday; the log's weeks start on Monday.
const DAYS_SINCE_MONDAY = [6, 0, 1, 2, 3, 4, 5];
const TENTHS = 10;
const HOUR_SECONDS = 3600;

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

/**
 * Hobbs hours and flights by week, for the flights the log lists.
 *
 * @param flights - Counted whatever their status, so the charts follow the
 *   status filter.
 * @param weeks - How many weeks to return.
 * @returns Consecutive weeks, oldest first, ending with the week of the
 *   newest flight; weeks with no flight are included with zeros, and flights
 *   older than the first week are left out. Empty when there is no flight.
 */
export function weeklyFlightActivity(
  flights: readonly Flight[],
  weeks = FLIGHT_ACTIVITY_WEEKS,
): FlightWeek[] {
  if (!flights.length) return [];
  const mondays = flights.map((f) => mondayOf(f.startTime));
  const last = new Date(Math.max(...mondays));
  const activity = Array.from({ length: weeks }, (_, i) => {
    const monday = weeksBefore(last, weeks - 1 - i);
    return { at: monday.getTime(), label: shortDay(monday), seconds: 0, n: 0 };
  });
  flights.forEach((f, i) => {
    const week = activity.find((w) => w.at === mondays[i]);
    if (!week) return;
    week.n++;
    week.seconds += hobbsSeconds(f);
  });
  return activity.map((w) => ({
    label: w.label,
    hours: Math.round((w.seconds / HOUR_SECONDS) * TENTHS) / TENTHS,
    flights: w.n,
  }));
}

// Local midnight on the Monday of the week the flight started in.
function mondayOf(startTime: string) {
  const at = new Date(startTime);
  return new Date(
    at.getFullYear(),
    at.getMonth(),
    at.getDate() - DAYS_SINCE_MONDAY[at.getDay()],
  ).getTime();
}

// By calendar date, not milliseconds, so a daylight-saving change in between
// still lands on local midnight.
function weeksBefore(monday: Date, count: number) {
  return new Date(
    monday.getFullYear(),
    monday.getMonth(),
    monday.getDate() - count * DAYS_PER_WEEK,
  );
}

// Meter readings are stored in seconds.
function hobbsSeconds(f: Flight) {
  if (f.hobbsOff === undefined || f.hobbsOn === undefined) return 0;
  return Math.max(0, f.hobbsOn - f.hobbsOff);
}

const shortDay = (at: Date) => `${MONTHS[at.getMonth()]} ${at.getDate()}`;

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
  return `${shortDay(at)}, ${at.getFullYear()}`;
}
