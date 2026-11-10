/**
 * Responsibility: Chooses what one aircraft's paper check for a month says:
 *   each flight and each completed work order as a row to tick against the
 *   paper logbook, with the month's totals.
 * Layer: Domain. Pure functions; no I/O and no layout.
 * Dependencies: src/domain (model, flights, flightFluids, aircraftFiles,
 *   workOrders, rejection).
 *
 * For its first year the program keeps paper logbooks beside the app. Once a
 * month someone ticks the app's rows against the paper lines; a photo of the
 * line or signed page attached to the row makes that a glance. The app's
 * rows are listed as recorded, with an empty Checked column: the signed
 * paper record governs (ADR-0004).
 */
import {
  hours,
  aircraftMeterLabels,
  localDate,
  type Aircraft,
  type Flight,
  type Snapshot,
} from "./model";
import { flightStatusLabels } from "./flights";
import type { OilReading } from "./flightFluids";
import { linkedLogbookPhotos, type AircraftFile } from "./aircraftFiles";
import type { WorkOrder } from "./workOrders";
import { Rejection } from "./rejection";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const YEAR_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
// The ending reading of each meter and the starting reading recorded with
// the flight, by the aircraft's tracking meter.
const METER_FIELDS: Record<
  Aircraft["meter"],
  { start: keyof Flight; end: keyof Flight }
> = {
  hobbs: { start: "hobbsOff", end: "hobbsOn" },
  tach: { start: "tachOff", end: "tachOn" },
  cyclic: { start: "cyclicHobbsOff", end: "cyclicHobbsOn" },
  flightTimeLog: { start: "flightTimeLogOff", end: "flightTimeLogOn" },
};

/** One flight of the month, as the paper line should read. */
export interface PaperCheckFlightRow {
  /** The local date the flight started on, `YYYY-MM-DD`. */
  date: string;
  pilot: string;
  /** Tracking-meter readings in hours to one decimal, or "" when unrecorded. */
  meterStart: string;
  meterEnd: string;
  /** End minus start, or "" when either reading is unrecorded. */
  hours: string;
  landings: string;
  /** Oil added on the flight, such as "1.5 US qt"; "" when none. */
  oilAdded: string;
  status: string;
  photo: "Yes" | "No";
  /** Always "": the box ticked on paper. */
  checked: "";
}

/** One work order completed in the month, as the signed page should read. */
export interface PaperCheckWorkRow {
  /** The completion date, `YYYY-MM-DD`. */
  date: string;
  /** The work order number and its scope. */
  summary: string;
  /** Who certified the close-out, else the order's supervisor. */
  signedBy: string;
  photo: "Yes" | "No";
  checked: "";
}

/** The month's paper check for one aircraft, in reading order. */
export interface PaperCheck {
  header: {
    registration: string;
    makeModel: string;
    serial: string;
    /** The month as written, such as "March 2026". */
    month: string;
    yearMonth: string;
    /** The tracking meter the readings come from, such as "Hobbs". */
    meter: string;
  };
  flights: PaperCheckFlightRow[];
  work: PaperCheckWorkRow[];
  /** Over accepted flights only: held and rejected flights change no totals. */
  totals: { flights: number; hours: string; landings: number };
}

/** The flight table's headings, in {@link PaperCheckFlightRow} field order. */
export const PAPER_CHECK_FLIGHT_COLUMNS = [
  "Date",
  "Pilot",
  "Meter start",
  "Meter end",
  "Hours",
  "Landings",
  "Oil added",
  "Status",
  "Photo",
  "Checked",
] as const;

/** The work table's headings, in {@link PaperCheckWorkRow} field order. */
export const PAPER_CHECK_WORK_COLUMNS = [
  "Date",
  "Work order",
  "Signed by",
  "Photo",
  "Checked",
] as const;

/**
 * Builds one aircraft's paper check for a month from the snapshot.
 *
 * @param s - Snapshot holding the aircraft, its flights, work orders and
 *   logbook page photos.
 * @param aircraftUuid - The aircraft.
 * @param yearMonth - The month as `YYYY-MM`.
 * @returns Flights that started in the month by local date (the date the
 *   Flight log shows on this device), earliest first; work orders completed
 *   in the month by completion date then number; totals over accepted
 *   flights. A month with nothing has empty rows and zero totals.
 * @throws {Rejection} "Aircraft not found."; "Choose a month as YYYY-MM."
 */
export function paperCheck(
  s: Snapshot,
  aircraftUuid: string,
  yearMonth: string,
): PaperCheck {
  const a = s.aircraft.find((x) => x.uuid === aircraftUuid);
  if (!a) throw new Rejection("Aircraft not found.");
  const match = YEAR_MONTH.exec(yearMonth);
  if (!match) throw new Rejection("Choose a month as YYYY-MM.");
  const flights = s.flights
    .filter(
      (f) => f.aircraftUuid === a.uuid && inMonth(flightDate(f), yearMonth),
    )
    .sort((x, z) => Date.parse(x.startTime) - Date.parse(z.startTime));
  const work = (s.workOrders ?? [])
    .filter(
      (w) =>
        w.aircraftUuid === a.uuid &&
        w.status === "completed" &&
        inMonth(w.completionDate, yearMonth),
    )
    .sort(
      (x, z) =>
        x.completionDate.localeCompare(z.completionDate) ||
        x.number.localeCompare(z.number),
    );
  return {
    header: {
      registration: a.registration,
      makeModel: `${a.make} ${a.model}`,
      serial: a.serial,
      month: `${MONTH_NAMES[Number(match[2]) - 1]} ${match[1]}`,
      yearMonth,
      meter: aircraftMeterLabels[a.meter],
    },
    flights: flights.map((f) => flightRow(s, a, f)),
    work: work.map((w) => workRow(s.aircraftFiles, w)),
    totals: totalsOf(a, flights),
  };
}

/**
 * The check as flat records for a CSV. Every record carries the same
 * columns, so an empty month still exports the full header: Section (Flight,
 * Work order or Totals), Date, Pilot, the meter's start and end, Hours,
 * Landings, Oil added, Status, Work order, Signed by, Photo, Checked,
 * Flights. Cells a section does not use are "".
 *
 * @param check - The built check.
 * @returns Flight records, work records, then the totals record.
 */
export function paperCheckRecords(check: PaperCheck): Record<string, string>[] {
  const meter = check.header.meter;
  const record = (fields: Record<string, string>) => ({
    ...blankRecord(meter),
    ...fields,
  });
  return [
    ...check.flights.map((r) => record(flightFields(r, meter))),
    ...check.work.map((r) =>
      record({
        Section: "Work order",
        Date: r.date,
        "Work order": r.summary,
        "Signed by": r.signedBy,
        Photo: r.photo,
      }),
    ),
    record({
      Section: "Totals",
      Hours: check.totals.hours,
      Landings: String(check.totals.landings),
      Flights: String(check.totals.flights),
    }),
  ];
}

/**
 * The oil added on a flight, as written on the paper line.
 *
 * @param oil - The flight's oil readings, if any.
 * @returns Each unit's total such as "1.5 US qt", joined by " + "; "" when
 *   nothing was added.
 */
export function formatOilAdded(oil: OilReading[] | undefined): string {
  const byUnit = new Map<string, number>();
  for (const reading of oil ?? []) {
    if (!reading.added) continue;
    const unit = reading.addedUnit ?? reading.unit;
    byUnit.set(unit, (byUnit.get(unit) ?? 0) + reading.added);
  }
  return [...byUnit].map(([unit, added]) => `${added} ${unit}`).join(" + ");
}

// A flight's start is stored as a UTC instant ("…Z"), so its first ten
// characters are the UTC date: a day late for an evening flight west of
// Greenwich. The paper line carries the local date, as the Flight log shows.
function flightDate(f: Flight): string {
  return localDate(Date.parse(f.startTime));
}

function inMonth(date: string, yearMonth: string): boolean {
  return date.startsWith(yearMonth);
}

function flightRow(s: Snapshot, a: Aircraft, f: Flight): PaperCheckFlightRow {
  const { start, end } = readings(a, f);
  return {
    date: flightDate(f),
    pilot: s.members.find((m) => m.id === f.pilotId)?.name ?? "Unknown pilot",
    meterStart: start === undefined ? "" : hours(start),
    meterEnd: end === undefined ? "" : hours(end),
    hours: start === undefined || end === undefined ? "" : hours(end - start),
    landings: String(f.landings),
    oilAdded: formatOilAdded(f.oil),
    status: capitalize(flightStatusLabels[f.status]),
    photo: hasPhoto(s.aircraftFiles, "flight", f.uuid),
    checked: "",
  };
}

function workRow(
  files: AircraftFile[] | undefined,
  w: WorkOrder,
): PaperCheckWorkRow {
  return {
    date: w.completionDate,
    summary: w.number ? `${w.number}: ${w.scope}` : w.scope,
    signedBy: w.closeout?.completedBy.name || w.supervisor,
    photo: hasPhoto(files, "work-order", w.uuid),
    checked: "",
  };
}

function totalsOf(a: Aircraft, flights: Flight[]): PaperCheck["totals"] {
  const accepted = flights.filter((f) => f.status === "accepted");
  let seconds = 0;
  for (const f of accepted) {
    const { start, end } = readings(a, f);
    if (start !== undefined && end !== undefined) seconds += end - start;
  }
  return {
    flights: accepted.length,
    hours: hours(seconds),
    landings: accepted.reduce((sum, f) => sum + f.landings, 0),
  };
}

function readings(a: Aircraft, f: Flight) {
  const fields = METER_FIELDS[a.meter];
  return {
    start: f[fields.start] as number | undefined,
    end: f[fields.end] as number | undefined,
  };
}

function hasPhoto(
  files: AircraftFile[] | undefined,
  linkedKind: "flight" | "work-order",
  linkedUuid: string,
): "Yes" | "No" {
  return linkedLogbookPhotos(files, { linkedKind, linkedUuid }).length
    ? "Yes"
    : "No";
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Every column of the CSV, empty, in its order.
function blankRecord(meter: string): Record<string, string> {
  return {
    Section: "",
    Date: "",
    Pilot: "",
    [`${meter} start`]: "",
    [`${meter} end`]: "",
    Hours: "",
    Landings: "",
    "Oil added": "",
    Status: "",
    "Work order": "",
    "Signed by": "",
    Photo: "",
    Checked: "",
    Flights: "",
  };
}

function flightFields(
  r: PaperCheckFlightRow,
  meter: string,
): Record<string, string> {
  return {
    Section: "Flight",
    Date: r.date,
    Pilot: r.pilot,
    [`${meter} start`]: r.meterStart,
    [`${meter} end`]: r.meterEnd,
    Hours: r.hours,
    Landings: r.landings,
    "Oil added": r.oilAdded,
    Status: r.status,
    Photo: r.photo,
  };
}
