import { z } from "zod";
import { readCsvRows } from "./maintenanceCsv";
import { parseExportDate, parseExportTime } from "./engineTrends";
import {
  applyFlight,
  conflictReason,
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

export const LOGBOOK_MAX_MEGABYTES = 5;
const LOGBOOK_MAX_RECORDS = 20_000;
const HEADER_SEARCH_ROWS = 20;
// Logbook totals and meter deltas agree to the tenth of an hour.
const DUPLICATE_TOLERANCE_SECONDS = 360;
const DEFAULT_HOUR = 12;
export type LogbookFormat = "foreflight" | "garmin-pilot";
export const logbookFormatLabels: Record<LogbookFormat, string> = {
  foreflight: "ForeFlight",
  "garmin-pilot": "Garmin Pilot",
};
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
const aliases = {
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
type Field = keyof typeof aliases;
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
function columns(header: string[]) {
  const names = header.map(normalize);
  return Object.fromEntries(
    (Object.keys(aliases) as Field[]).map((f) => [
      f,
      names.findIndex((n) => (aliases[f] as readonly string[]).includes(n)),
    ]),
  ) as Record<Field, number>;
}
function hoursToSeconds(text: string, label: string) {
  if (!text) return undefined;
  const hm = /^(\d+):([0-5]\d)$/.exec(text);
  if (hm) return (+hm[1] * 60 + +hm[2]) * 60;
  if (!/^\d*\.?\d+$/.test(text))
    throw new Error(`${label} must be decimal hours or h:mm.`);
  return Math.round(Number(text) * 3600);
}
function meter(text: string, label: string) {
  if (!text) return undefined;
  const tenths = Math.round(Number(text) * 10);
  if (
    !/^\d+(?:\.\d+)?$/.test(text) ||
    Math.abs(Number(text) * 10 - tenths) > 1e-6
  )
    throw new Error(`${label} must use tenths of an hour, for example 1234.5.`);
  return tenths * 360;
}
function count(text: string, label: string) {
  if (!text) return undefined;
  if (!/^\d{1,4}$/.test(text))
    throw new Error(`${label} must be a whole number.`);
  return Number(text);
}
function readRow(cells: string[], c: Record<Field, number>, row: number) {
  const cell = (f: Field) => (c[f] < 0 ? "" : (cells[c[f]] ?? "").trim());
  const base = {
    row,
    registration: cell("registration"),
    date: cell("date"),
    from: cell("from").toUpperCase(),
    to: cell("to").toUpperCase(),
    landings: 0,
    comments: cell("comments"),
  };
  try {
    const date = parseExportDate(base.date);
    if (!date) throw new Error("Date must be YYYY-MM-DD or MM/DD/YYYY.");
    if (!base.registration) throw new Error("Aircraft ID is required.");
    const out = cell("timeOut").replace(/^(\d{1,2})(\d{2})$/, "$1:$2");
    const timeOut = out ? parseExportTime(out)?.slice(0, 5) : undefined;
    if (out && !timeOut) throw new Error("Time out must be hh:mm.");
    const totalSeconds = hoursToSeconds(cell("total"), "Total time");
    if (!totalSeconds) throw new Error("Total time is required.");
    const dayLandings =
      count(cell("day"), "Day landings") ??
      count(cell("dayFullStop"), "Day full-stop landings");
    const nightLandings =
      count(cell("night"), "Night landings") ??
      count(cell("nightFullStop"), "Night full-stop landings");
    const fullStops = [cell("dayFullStop"), cell("nightFullStop")]
      .filter(Boolean)
      .map(Number);
    return {
      ...base,
      date,
      timeOut,
      totalSeconds,
      landings:
        count(cell("allLandings"), "Landings") ??
        (dayLandings ?? 0) + (nightLandings ?? 0),
      dayLandings,
      nightLandings,
      fullStopLandings: fullStops.length
        ? fullStops.reduce((a, b) => a + b, 0)
        : undefined,
      hobbsEnd: meter(cell("hobbsEnd"), "Hobbs end"),
      tachEnd: meter(cell("tachEnd"), "Tach end"),
      cycles: count(cell("cycles"), "Cycles"),
    };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : "Invalid row." };
  }
}
/** Rows keep their 1-based spreadsheet row number for review. */
export function parseLogbook(text: string): {
  format: LogbookFormat;
  rows: LogbookRow[];
} {
  const rows = readCsvRows(text, {
    maxMegabytes: LOGBOOK_MAX_MEGABYTES,
    maxRecords: LOGBOOK_MAX_RECORDS,
  });
  const section = rows.findIndex(
    (r) => normalize(r.cells[0] ?? "") === "flightstable",
  );
  const format: LogbookFormat = section >= 0 ? "foreflight" : "garmin-pilot";
  const searchFrom = section + 1;
  const at = rows
    .slice(searchFrom, searchFrom + HEADER_SEARCH_ROWS)
    .findIndex((r) => {
      const c = columns(r.cells);
      return c.date >= 0 && c.registration >= 0;
    });
  if (at < 0)
    throw new Error(
      "Unrecognized logbook file. Export the logbook as CSV from ForeFlight or Garmin Pilot.",
    );
  const headerAt = searchFrom + at;
  const c = columns(rows[headerAt].cells);
  const data = rows.slice(headerAt + 1);
  const end = data.findIndex((r) => /table$/i.test(r.cells[0]?.trim() ?? ""));
  return {
    format,
    rows: (end < 0 ? data : data.slice(0, end)).map((r) =>
      readRow(r.cells, c, r.row),
    ),
  };
}
export interface PlannedRow extends LogbookRow {
  aircraftUuid: string;
  input?: FlightInput;
  duplicate: boolean;
}
const registrationKey = (r: string) =>
  r.toUpperCase().replace(/[^A-Z0-9]/g, "");
const sameRoute = (a: string, b: string) =>
  a.trim().toUpperCase() === b.trim().toUpperCase();
function loggedSeconds(a: Aircraft, f: Flight) {
  const m = meterAtFlight(a, f.startTime);
  const [on, off] =
    m === "hobbs"
      ? [f.hobbsOn, f.hobbsOff]
      : m === "tach"
        ? [f.tachOn, f.tachOff]
        : m === "cyclic"
          ? [f.cyclicHobbsOn, f.cyclicHobbsOff]
          : [f.flightTimeLogOn, f.flightTimeLogOff];
  return on !== undefined && off !== undefined ? on - off : undefined;
}
interface Logged {
  aircraftUuid: string;
  date: string;
  origin: string;
  destination: string;
  seconds?: number;
}
const matches = (row: Logged, other: Logged) =>
  row.aircraftUuid === other.aircraftUuid &&
  row.date === other.date &&
  sameRoute(row.origin, other.origin) &&
  sameRoute(row.destination, other.destination) &&
  // An unknown duration still counts: double-logging is worse than a skip.
  (row.seconds === undefined ||
    other.seconds === undefined ||
    Math.abs(row.seconds - other.seconds) <= DUPLICATE_TOLERANCE_SECONDS);
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
  return [
    `Imported from ${format} logbook row ${row.row}. Total time ${((row.totalSeconds ?? 0) / 3600).toFixed(1)} h.`,
    landings.length && `Landings: ${landings.join(", ")}.`,
    row.comments,
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 5000);
}
const message = (e: unknown) =>
  e instanceof z.ZodError
    ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    : e instanceof Error
      ? e.message
      : "Invalid flight.";
/**
 * Rows for aircraft the user can log flights for, each validated exactly like
 * a manual entry; other aircraft (rentals, prior employers) are only counted.
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
  const logged: Logged[] = [
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
  const perDay = new Map<string, number>();
  let otherAircraft = 0;
  const planned: PlannedRow[] = [];
  for (const row of rows) {
    const aircraft = loggable.find(
      (a) =>
        registrationKey(a.registration) === registrationKey(row.registration),
    );
    if (!aircraft) {
      otherAircraft++;
      continue;
    }
    if (row.error) {
      planned.push({ ...row, aircraftUuid: aircraft.uuid, duplicate: false });
      continue;
    }
    const dayKey = aircraft.uuid + row.date;
    const sameDay = perDay.get(dayKey) ?? 0;
    perDay.set(dayKey, sameDay + 1);
    const input: FlightInput = {
      aircraftUuid: aircraft.uuid,
      pilotId: options.pilotId,
      startTime: startTime(row, sameDay, now).toISOString(),
      hobbsOn: row.hobbsEnd,
      tachOn: row.tachEnd,
      landings: row.landings,
      cycles: row.cycles ?? 0,
      origin: row.from,
      destination: row.to,
      operation: options.operation,
      flightRules: options.flightRules,
      remarks: remarks(row, logbookFormatLabels[format]),
      discrepancy: "",
    };
    const entry: Logged = {
      ...input,
      date: row.date,
      seconds: row.totalSeconds,
    };
    try {
      if (aircraft.turbine && row.cycles === undefined)
        throw new Error(
          "Turbine aircraft need engine cycles. Add a Cycles column or log this flight manually.",
        );
      validateFlight(aircraft, input);
    } catch (e) {
      planned.push({
        ...row,
        aircraftUuid: aircraft.uuid,
        duplicate: false,
        error: message(e),
      });
      continue;
    }
    planned.push({
      ...row,
      aircraftUuid: aircraft.uuid,
      input,
      duplicate: logged.some((l) => matches(entry, l)),
    });
    logged.push(entry);
  }
  return { rows: planned, otherAircraft };
}
/**
 * Chronological submission order with the aircraft version each entry expects,
 * replaying the server's conflict rules so held-for-review rows are known.
 */
export function sequenceImport(s: Snapshot, rows: PlannedRow[]) {
  const running = new Map(s.aircraft.map((a) => [a.uuid, a]));
  return rows
    .filter((r) => r.input && !r.error)
    .sort((a, b) => a.input!.startTime.localeCompare(b.input!.startTime))
    .map((row) => {
      const input = row.input!;
      const aircraft = running.get(input.aircraftUuid)!;
      const reviewReason = conflictReason(aircraft, input, aircraft.version);
      if (!reviewReason)
        running.set(aircraft.uuid, applyFlight(aircraft, input));
      return { row, input, baseVersion: aircraft.version, reviewReason };
    });
}
