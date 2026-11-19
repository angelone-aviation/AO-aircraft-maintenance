/**
 * Responsibility: Imports a pilot's ForeFlight or Garmin Pilot logbook CSV:
 *   reads its rows, plans them as flights, and orders them for submission.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: zod, ./maintenanceCsv, ./engineTrends, ./flights, ./model,
 *   ./rejection.
 */
import { z } from "zod";
import { readCsvRows } from "./maintenanceCsv";
import { parseExportDate, parseExportTime } from "./engineTrends";
import {
  applyFlight,
  heldReason,
  meterAtFlight,
  validateFlight,
} from "./flights";
import {
  can,
  localDate,
  type Aircraft,
  type Flight,
  type FlightInput,
  type Snapshot,
} from "./model";
import { Rejection } from "./rejection";

/** The largest logbook file accepted, in MiB. */
export const LOGBOOK_MAX_MEGABYTES = 5;
const LOGBOOK_MAX_RECORDS = 20_000;
const HEADER_SEARCH_ROWS = 20;
// Logbook totals and meter deltas agree to the tenth of an hour.
const DUPLICATE_TOLERANCE_SECONDS = 360;
// A row without a time out starts at noon, one minute later for each earlier
// row of that aircraft and day, so same-day flights keep their file order.
const DEFAULT_HOUR = 12;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const TENTH_HOUR_SECONDS = 360;
// Absorbs float error when checking that a reading is in whole tenths.
const TENTHS_EPSILON = 1e-6;
// The flight remarks limit (NOTE_MAX_LENGTH in model.ts).
const REMARKS_MAX_LENGTH = 5000;

// Header names each export may use for a field, as normalizeHeader leaves
// them.
const COLUMN_ALIASES = {
  date: ["date", "flightdate"],
  registration: [
    "aircraftid",
    "aircraftident",
    "ident",
    "tail",
    "tailnumber",
    "registration",
    "aircraftregistration",
    "aircraft",
  ],
  from: ["from", "departure", "dep", "origin", "departureairport"],
  to: ["to", "arrival", "arr", "destination", "arrivalairport"],
  timeOut: ["timeout", "out", "outtime", "departuretime"],
  total: [
    "totaltime",
    "total",
    "totalflighttime",
    "totalduration",
    "flighttime",
    "duration",
  ],
  allLandings: ["alllandings", "landings", "totallandings"],
  day: ["daylandings"],
  night: ["nightlandings"],
  dayFullStop: ["daylandingsfullstop"],
  nightFullStop: ["nightlandingsfullstop"],
  hobbsEnd: ["hobbsend", "hobbsin", "hobbsstop"],
  tachEnd: ["tachend", "tachin", "tachstop"],
  cycles: ["cycles", "enginecycles"],
  comments: ["pilotcomments", "remarks", "comments", "notes"],
} as const;

// Each meter's on and off readings; any other meter is the flight time log.
const METER_READINGS = {
  hobbs: ["hobbsOn", "hobbsOff"],
  tach: ["tachOn", "tachOff"],
  cyclic: ["cyclicHobbsOn", "cyclicHobbsOff"],
  flightTimeLog: ["flightTimeLogOn", "flightTimeLogOff"],
} as const;

/** The logbook apps whose CSV export can be imported. */
export type LogbookFormat = "foreflight" | "garmin-pilot";

/** Each format's name as shown to the user and written into remarks. */
export const logbookFormatLabels: Record<LogbookFormat, string> = {
  foreflight: "ForeFlight",
  "garmin-pilot": "Garmin Pilot",
};

/**
 * One logbook row as read: airports upper-cased, times in seconds, meter
 * readings in tenth-hour seconds. A row that cannot be read keeps its raw
 * text and carries `error`.
 */
export interface LogbookRow {
  row: number;
  registration: string;
  date: string;
  timeOut?: string;
  from: string;
  to: string;
  totalSeconds?: number;
  landings: number;
  dayLandings?: number;
  nightLandings?: number;
  fullStopLandings?: number;
  hobbsEnd?: number;
  tachEnd?: number;
  cycles?: number;
  comments: string;
  error?: string;
}

/**
 * A row matched to one of the user's aircraft: the flight it would log, or
 * the reason it cannot, and whether it looks already logged.
 */
export interface PlannedRow extends LogbookRow {
  aircraftUuid: string;
  input?: FlightInput;
  duplicate: boolean;
}

type Field = keyof typeof COLUMN_ALIASES;
type Cell = (field: Field) => string;

interface Logged {
  aircraftUuid: string;
  date: string;
  origin: string;
  destination: string;
  seconds?: number;
}

interface Planner {
  options: Pick<FlightInput, "pilotId" | "operation" | "flightRules">;
  format: LogbookFormat;
  now: number;
  // Flights already logged, pending, or planned so far, to find duplicates.
  logged: Logged[];
  // Rows planned so far for each aircraft and day.
  perDay: Map<string, number>;
}

/**
 * Reads a ForeFlight or Garmin Pilot logbook CSV export. ForeFlight files are
 * known by their "Flights Table" section; data ends at the next "…Table" row.
 *
 * @param text - The file's text.
 * @returns The format and one row per flight with its 1-based spreadsheet row;
 *   a row that cannot be read carries `error` instead.
 * @throws {Rejection} "Unrecognized logbook file. Export the logbook as CSV
 *   from ForeFlight or Garmin Pilot." when no date and aircraft header is
 *   found; and as readCsvRows, over 5 MiB or 20,000 records.
 */
export function parseLogbook(text: string): {
  format: LogbookFormat;
  rows: LogbookRow[];
} {
  const rows = readCsvRows(text, {
    maxMegabytes: LOGBOOK_MAX_MEGABYTES,
    maxRecords: LOGBOOK_MAX_RECORDS,
  });
  const section = rows.findIndex(
    (r) => normalizeHeader(r.cells[0] ?? "") === "flightstable",
  );
  const format: LogbookFormat = section >= 0 ? "foreflight" : "garmin-pilot";
  const searchFrom = section + 1;
  const at = rows
    .slice(searchFrom, searchFrom + HEADER_SEARCH_ROWS)
    .findIndex((r) => {
      const c = findColumns(r.cells);
      return c.date >= 0 && c.registration >= 0;
    });
  if (at < 0)
    throw new Rejection(
      "Unrecognized logbook file. Export the logbook as CSV from ForeFlight or Garmin Pilot.",
    );
  const headerAt = searchFrom + at;
  const c = findColumns(rows[headerAt].cells);
  const data = rows.slice(headerAt + 1);
  const end = data.findIndex((r) => /table$/i.test(r.cells[0]?.trim() ?? ""));
  return {
    format,
    rows: (end < 0 ? data : data.slice(0, end)).map((r) =>
      readRow(r.cells, c, r.row),
    ),
  };
}

/**
 * Plans each row as a flight on one of the user's aircraft (matched by
 * registration, ignoring case and punctuation), validated exactly like a
 * manual entry. Rows for other aircraft (rentals, prior employers) are only
 * counted. A row is a duplicate when a logged, pending or earlier row has the
 * same aircraft, date and route, and a total within a tenth of an hour.
 *
 * @param s - The snapshot; only aircraft the user may log flights for match.
 * @param rows - Rows from {@link parseLogbook}.
 * @param options - The pilot, operation and flight rules for every row.
 * @param pending - Flights queued but not yet synced.
 * @param format - The export the rows came from, named in each remark.
 * @param now - The clock; a flight cannot start in the future.
 * @returns Planned rows in file order, and the count of other aircraft's rows.
 */
export function planLogbookImport(
  s: Snapshot,
  rows: LogbookRow[],
  options: Pick<FlightInput, "pilotId" | "operation" | "flightRules">,
  pending: FlightInput[] = [],
  format: LogbookFormat = "foreflight",
  now = Date.now(),
): { rows: PlannedRow[]; otherAircraft: number } {
  const loggable = s.aircraft.filter((a) => can(s, a.uuid, "flight"));
  const plan: Planner = {
    options,
    format,
    now,
    logged: loggedFlights(s, pending),
    perDay: new Map(),
  };
  let otherAircraft = 0;
  const planned: PlannedRow[] = [];
  for (const row of rows) {
    const aircraft = loggable.find(
      (a) =>
        registrationKey(a.registration) === registrationKey(row.registration),
    );
    if (aircraft) planned.push(planRow(plan, row, aircraft));
    else otherAircraft++;
  }
  return { rows: planned, otherAircraft };
}

/**
 * Orders planned flights by start time with the aircraft version each one
 * expects, replaying the server's conflict rules so that rows it will hold
 * for review are known before submission.
 *
 * @param s - The snapshot with each aircraft's current readings and version.
 * @param rows - Planned rows; rows with an error or no flight are left out.
 * @returns Each flight with its `baseVersion`, and its `reviewReason` when it
 *   conflicts; a held flight does not advance the aircraft.
 */
export function sequenceImport(s: Snapshot, rows: PlannedRow[]) {
  const running = new Map(s.aircraft.map((a) => [a.uuid, a]));
  return rows
    .filter((r) => r.input && !r.error)
    .sort((a, b) => a.input!.startTime.localeCompare(b.input!.startTime))
    .map((row) => {
      const input = row.input!;
      const aircraft = running.get(input.aircraftUuid)!;
      const reviewReason = heldReason(aircraft, input, aircraft.version);
      if (!reviewReason)
        running.set(aircraft.uuid, applyFlight(aircraft, input));
      return { row, input, baseVersion: aircraft.version, reviewReason };
    });
}

function normalizeHeader(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findColumns(header: string[]) {
  const names = header.map(normalizeHeader);
  return Object.fromEntries(
    (Object.keys(COLUMN_ALIASES) as Field[]).map((f) => [
      f,
      names.findIndex((n) =>
        (COLUMN_ALIASES[f] as readonly string[]).includes(n),
      ),
    ]),
  ) as Record<Field, number>;
}

function readRow(
  cells: string[],
  c: Record<Field, number>,
  row: number,
): LogbookRow {
  const cell: Cell = (f) => (c[f] < 0 ? "" : (cells[c[f]] ?? "").trim());
  const base = {
    row,
    registration: cell("registration"),
    date: cell("date"),
    from: cell("from").toUpperCase(),
    to: cell("to").toUpperCase(),
    landings: 0,
    comments: cell("comments"),
  };
  // A row that cannot be read is shown with its reason; the rest still import.
  try {
    return {
      ...base,
      ...readFlightCells(cell),
      ...readLandingCells(cell),
      hobbsEnd: readMeter(cell("hobbsEnd"), "Hobbs end"),
      tachEnd: readMeter(cell("tachEnd"), "Tach end"),
      cycles: readCount(cell("cycles"), "Cycles"),
    };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : "Invalid row." };
  }
}

// Checked in this order, so a row with several problems shows the first.
function readFlightCells(cell: Cell) {
  const date = parseExportDate(cell("date"));
  if (!date) throw new Rejection("Date must be YYYY-MM-DD or MM/DD/YYYY.");
  if (!cell("registration")) throw new Rejection("Aircraft ID is required.");
  const out = cell("timeOut").replace(/^(\d{1,2})(\d{2})$/, "$1:$2");
  const timeOut = out ? parseExportTime(out)?.slice(0, 5) : undefined;
  if (out && !timeOut) throw new Rejection("Time out must be hh:mm.");
  const totalSeconds = readHours(cell("total"), "Total time");
  if (!totalSeconds) throw new Rejection("Total time is required.");
  return { date, timeOut, totalSeconds };
}

// Full-stop counts stand in for day or night landings when those are blank;
// all landings default to day plus night.
function readLandingCells(cell: Cell) {
  const dayLandings =
    readCount(cell("day"), "Day landings") ??
    readCount(cell("dayFullStop"), "Day full-stop landings");
  const nightLandings =
    readCount(cell("night"), "Night landings") ??
    readCount(cell("nightFullStop"), "Night full-stop landings");
  const fullStops = [cell("dayFullStop"), cell("nightFullStop")]
    .filter(Boolean)
    .map(Number);
  return {
    landings:
      readCount(cell("allLandings"), "Landings") ??
      (dayLandings ?? 0) + (nightLandings ?? 0),
    dayLandings,
    nightLandings,
    fullStopLandings: fullStops.length
      ? fullStops.reduce((a, b) => a + b, 0)
      : undefined,
  };
}

function readHours(text: string, label: string) {
  if (!text) return undefined;
  const hm = /^(\d+):([0-5]\d)$/.exec(text);
  if (hm) return +hm[1] * SECONDS_PER_HOUR + +hm[2] * SECONDS_PER_MINUTE;
  if (!/^\d*\.?\d+$/.test(text))
    throw new Rejection(`${label} must be decimal hours or h:mm.`);
  return Math.round(Number(text) * SECONDS_PER_HOUR);
}

function readMeter(text: string, label: string) {
  if (!text) return undefined;
  const tenths = Math.round(Number(text) * 10);
  if (
    !/^\d+(?:\.\d+)?$/.test(text) ||
    Math.abs(Number(text) * 10 - tenths) > TENTHS_EPSILON
  )
    throw new Rejection(
      `${label} must use tenths of an hour, for example 1234.5.`,
    );
  return tenths * TENTH_HOUR_SECONDS;
}

function readCount(text: string, label: string) {
  if (!text) return undefined;
  if (!/^\d{1,4}$/.test(text))
    throw new Rejection(`${label} must be a whole number.`);
  return Number(text);
}

function loggedFlights(s: Snapshot, pending: FlightInput[]): Logged[] {
  return [
    ...s.flights
      .filter((f) => f.status !== "rejected")
      .map((f) => ({
        ...f,
        date: localDate(Date.parse(f.startTime)),
        seconds: loggedSeconds(
          s.aircraft.find((a) => a.uuid === f.aircraftUuid)!,
          f,
        ),
      })),
    ...pending.map((f) => ({ ...f, date: localDate(Date.parse(f.startTime)) })),
  ];
}

function loggedSeconds(a: Aircraft, f: Flight) {
  const meter = meterAtFlight(a, f.startTime);
  const [on, off] = (METER_READINGS[meter] ?? METER_READINGS.flightTimeLog).map(
    (key) => f[key],
  );
  return on !== undefined && off !== undefined ? on - off : undefined;
}

function registrationKey(registration: string) {
  return registration.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function planRow(
  plan: Planner,
  row: LogbookRow,
  aircraft: Aircraft,
): PlannedRow {
  const aircraftUuid = aircraft.uuid;
  if (row.error) return { ...row, aircraftUuid, duplicate: false };
  const dayKey = aircraftUuid + row.date;
  const sameDay = plan.perDay.get(dayKey) ?? 0;
  plan.perDay.set(dayKey, sameDay + 1);
  const input = flightInput(plan, row, aircraftUuid, sameDay);
  const entry: Logged = { ...input, date: row.date, seconds: row.totalSeconds };
  const error = refusalOf(aircraft, row, input);
  if (error) return { ...row, aircraftUuid, duplicate: false, error };
  const duplicate = plan.logged.some((l) => matches(entry, l));
  plan.logged.push(entry);
  return { ...row, aircraftUuid, input, duplicate };
}

function flightInput(
  plan: Planner,
  row: LogbookRow,
  aircraftUuid: string,
  sameDay: number,
): FlightInput {
  return {
    aircraftUuid,
    pilotId: plan.options.pilotId,
    startTime: startTime(row, sameDay, plan.now).toISOString(),
    hobbsOn: row.hobbsEnd,
    tachOn: row.tachEnd,
    landings: row.landings,
    cycles: row.cycles ?? 0,
    origin: row.from,
    destination: row.to,
    operation: plan.options.operation,
    flightRules: plan.options.flightRules,
    remarks: remarks(row, logbookFormatLabels[plan.format]),
    discrepancy: "",
  };
}

function startTime(row: LogbookRow, sameDay: number, now: number) {
  const [y, m, d] = row.date.split("-").map(Number);
  const [hh, mm] = row.timeOut
    ? row.timeOut.split(":").map(Number)
    : [DEFAULT_HOUR, sameDay];
  const start = new Date(y, m - 1, d, hh, mm);
  // A flight logged earlier today without a time must not read as future.
  return row.date === localDate(now) && start.getTime() > now
    ? new Date(now)
    : start;
}

function remarks(row: LogbookRow, format: string) {
  const landings = [
    row.dayLandings !== undefined && `day ${row.dayLandings}`,
    row.nightLandings !== undefined && `night ${row.nightLandings}`,
    row.fullStopLandings !== undefined && `full-stop ${row.fullStopLandings}`,
  ].filter(Boolean);
  const hours = ((row.totalSeconds ?? 0) / SECONDS_PER_HOUR).toFixed(1);
  return [
    `Imported from ${format} logbook row ${row.row}. Total time ${hours} h.`,
    landings.length && `Landings: ${landings.join(", ")}.`,
    row.comments,
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, REMARKS_MAX_LENGTH);
}

// Turbine aircraft track engine cycles, which an export may lack; importing 0
// would undercount them. A refused row is shown with its reason.
function refusalOf(aircraft: Aircraft, row: LogbookRow, input: FlightInput) {
  if (aircraft.turbine && row.cycles === undefined)
    return "Turbine aircraft need engine cycles. Add a Cycles column or log this flight manually.";
  try {
    validateFlight(aircraft, input);
    return undefined;
  } catch (e) {
    return describeError(e);
  }
}

function describeError(e: unknown) {
  if (e instanceof z.ZodError)
    return e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  return e instanceof Error ? e.message : "Invalid flight.";
}

function sameRoute(a: string, b: string) {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

function matches(row: Logged, other: Logged) {
  return (
    row.aircraftUuid === other.aircraftUuid &&
    row.date === other.date &&
    sameRoute(row.origin, other.origin) &&
    sameRoute(row.destination, other.destination) &&
    // An unknown duration still counts: double-logging is worse than a skip.
    (row.seconds === undefined ||
      other.seconds === undefined ||
      Math.abs(row.seconds - other.seconds) <= DUPLICATE_TOLERANCE_SECONDS)
  );
}
