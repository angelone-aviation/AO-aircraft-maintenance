/**
 * Responsibility: Chooses and orders what one aircraft's status sheet says:
 *   totals, installed components, inspections, ADs, Form 337 copies and open
 *   discrepancies, as rows of text.
 * Layer: Domain. Pure functions; no I/O and no layout.
 * Dependencies: src/domain (model, dueItems, maintenance, components,
 *   componentCalendar, airworthiness, adRemaining, aircraftFiles, rejection).
 *
 * The content of the 14 CFR 91.417(a)(2) status records, kept apart from any
 * document so it can be tested as data.
 */
import {
  localDate,
  recordedTotalSeconds,
  aircraftMeterLabels,
  type Aircraft,
  type Inspection,
  type Snapshot,
} from "./model";
import {
  dueItems,
  type AdDue,
  type InspectionDue,
  type MaintenanceDue,
} from "./dueItems";
import { inspectionDueDate } from "./maintenance";
import { componentTotals, type Component } from "./components";
import { daysPerServiceMonth } from "./componentCalendar";
import type { AD } from "./airworthiness";
import { adRemaining } from "./adRemaining";
import { isCurrentAircraftFile } from "./aircraftFiles";
import { Rejection } from "./rejection";

const SECONDS_PER_HOUR = 3600;
const BYTES_PER_KB = 1024;
const NOT_TRACKED = "Not tracked";
const NUMERIC = { numeric: true } as const;

/** Names a section, so a layout can size its columns. */
export type StatusSectionId =
  | "overview"
  | "components"
  | "inspections"
  | "airworthiness"
  | "form337"
  | "discrepancies";

/** One table of the sheet and the notes that follow it. */
export interface StatusSection {
  id: StatusSectionId;
  title: string;
  columns: string[];
  /** One cell per column; an empty table holds one placeholder row. */
  rows: string[][];
  notes: string[];
}

/** What one aircraft's status sheet says, in reading order. */
export interface StatusSheet {
  header: { registration: string; makeModel: string; serial: string };
  sections: StatusSection[];
}

/**
 * Builds the status sheet content for one aircraft as recorded in `s`, with
 * its inspections and ADs from {@link dueItems}. A Component whose times
 * cannot be computed reads "Review", and a total time that cannot be read
 * "Not recorded", instead of failing the sheet.
 * @param s - Snapshot holding the aircraft and its records.
 * @param aircraftUuid - The aircraft to report on.
 * @param today - Local `YYYY-MM-DD` that due dates are counted from.
 * @returns The header and six sections: overview, installed components,
 *   inspections by reference, every AD (closed ones too) by Component uuid
 *   then AD number (digit runs in references and AD numbers compare as
 *   numbers), current Form 337 copies oldest first, and open discrepancies.
 * @throws {Rejection} "Aircraft not found." when `s` lacks the aircraft;
 *   what an inspection's status threw, as {@link dueItems} keeps it.
 */
export function statusSheet(
  s: Snapshot,
  aircraftUuid: string,
  today: string,
): StatusSheet {
  const a = s.aircraft.find((x) => x.uuid === aircraftUuid);
  if (!a) throw new Rejection("Aircraft not found.");
  const components = (s.management ?? []).filter(
    (c): c is Component =>
      c.kind === "component" && c.installed && c.aircraftUuid === a.uuid,
  );
  const due = dueItems(s, a.uuid, today);
  return {
    header: {
      registration: a.registration,
      makeModel: `${a.make} ${a.model}`,
      serial: a.serial,
    },
    sections: [
      overviewSection(s, a),
      componentsSection(components, a, today),
      inspectionsSection(due, components),
      airworthinessSection(s, due, components, today),
      form337Section(s, a),
      discrepanciesSection(s, a),
    ],
  };
}

function overviewSection(s: Snapshot, a: Aircraft): StatusSection {
  const notes: string[] = [];
  if (a.flightTimeLog && a.currentFlightTimeLog !== undefined)
    notes.push(`Flight time log: ${formatHours(a.currentFlightTimeLog)} hours`);
  if (a.currentCyclicHobbs !== undefined)
    notes.push(
      `Collective hourmeter: ${formatHours(a.currentCyclicHobbs)} hours`,
    );
  notes.push(
    `Data synchronized ${formatUtc(new Date(s.syncedAt))} UTC. Negative remaining values are overdue; months are approximate. Calendar exempt suppresses calendar only.`,
  );
  return {
    id: "overview",
    title: "Aircraft overview",
    columns: [
      "Recorded aircraft status:",
      "Aircraft total time:",
      "Hobbs / Tach (hours)",
      "Cycles / Landings",
      "Tracking meter",
      "Flight program",
    ],
    rows: [
      [
        a.operationalStatus,
        formatTotal(recordedTotalSeconds(a)),
        `${formatHours(a.currentHobbs)} / ${formatHours(a.currentTach)}`,
        `${a.cycles} / ${a.landings}`,
        aircraftMeterLabels[a.meter],
        a.program,
      ],
    ],
    notes,
  };
}

// Only damaged data has a meter without a reading: the aircraft form requires
// one.
function formatTotal(seconds: number | undefined) {
  return seconds === undefined
    ? "Not recorded"
    : `${formatHours(seconds)} hours`;
}

function componentsSection(
  components: Component[],
  a: Aircraft,
  today: string,
): StatusSection {
  return {
    id: "components",
    title: "Installed components",
    columns: [
      "Position / component",
      "Part number / model",
      "Serial number",
      "TSN hours",
      "TSO hours",
      "TSR hours",
      "Cycles",
    ],
    rows: components.length
      ? components.map((c) => componentRow(c, a, today))
      : [["No installed component records", "-", "-", "-", "-", "-", "-"]],
    notes: [],
  };
}

function componentRow(c: Component, a: Aircraft, today: string): string[] {
  const identity = [
    `${c.installPosition || ""} ${c.componentType}`,
    c.partNumber,
    c.serial,
  ];
  let totals: ReturnType<typeof componentTotals>;
  try {
    totals = componentTotals(c, a, today);
  } catch {
    // Usage that cannot be computed (readings before the installation
    // baseline) is flagged for review rather than stopping the sheet.
    return [...identity, "Review", "Review", "Review", "Review"];
  }
  const times = c.trackTime
    ? [
        formatHours(totals.timeSinceNew),
        formatHours(totals.timeSinceOverhaul),
        formatHours(totals.timeSinceRepair),
      ]
    : [NOT_TRACKED, NOT_TRACKED, NOT_TRACKED];
  const cycles = c.trackCycles ? String(totals.cyclesSinceNew) : NOT_TRACKED;
  return [...identity, ...times, cycles];
}

function inspectionsSection(
  due: MaintenanceDue[],
  components: Component[],
): StatusSection {
  const items = due
    .filter((d): d is InspectionDue => d.kind === "inspection")
    .sort((x, z) =>
      x.inspection.reference.localeCompare(
        z.inspection.reference,
        undefined,
        NUMERIC,
      ),
    );
  const columns = [
    "Inspection / component",
    "Repeat interval",
    "Last completed",
    "Next due\nHours / cycles / landings",
    "Date due",
    "Hours remaining",
    "Months remaining*",
    "Cycles / landings remaining",
    "Status",
  ];
  const empty = Array<string>(columns.length - 1).fill("-");
  return {
    id: "inspections",
    title: "Inspection schedules",
    columns,
    rows: items.length
      ? items.map((d) => inspectionRow(d, components))
      : [["No active inspection schedules", ...empty]],
    notes: [
      ...listExemptionNotes(items.map((d) => d.inspection)),
      "* Months remaining are approximate; the exact date due controls. Hours and cycles use each inspection's configured counter; landings use aircraft total landings.",
    ],
  };
}

// T13 leaves what an uncomputable status means to each caller: here it fails
// the whole sheet, so a printed status record never guesses at one.
function inspectionRow(d: InspectionDue, components: Component[]): string[] {
  if (!d.due) throw d.error;
  const { inspection: i, due: r } = d;
  const component = components.find((c) => c.uuid === i.componentUuid);
  const asset = component
    ? `\n${component.installPosition || ""} S/N ${component.serial}`
    : "";
  const months =
    r.daysRemaining === undefined
      ? undefined
      : r.daysRemaining / daysPerServiceMonth;
  return [
    (i.reference || i.description) + asset,
    joinLines(listInterval(i)) || "One-time",
    joinLines(listLastDone(i)) || "-",
    joinLines(listNextDue(i)) || "-",
    i.calendarExempt ? "Calendar exempt" : inspectionDueDate(i) || "-",
    formatNumber(r.hoursRemaining),
    formatNumber(months),
    joinLines(listCountsRemaining(r)) || "-",
    r.status,
  ];
}

function listCountsRemaining(r: NonNullable<InspectionDue["due"]>) {
  return [
    r.cyclesRemaining === undefined
      ? ""
      : `${formatNumber(r.cyclesRemaining, 0)} cyc`,
    r.landingsRemaining === undefined
      ? ""
      : `${formatNumber(r.landingsRemaining, 0)} landings`,
  ];
}

function listInterval(i: Inspection): (string | null | undefined)[] {
  const exempt = i.calendarExempt ? " (exempt)" : "";
  return [
    i.intervalSeconds ? `${formatHours(i.intervalSeconds)} h` : null,
    i.intervalCycles ? `${i.intervalCycles} cyc` : null,
    i.intervalLandings ? `${i.intervalLandings} landings` : null,
    i.intervalMonths ? `${i.intervalMonths} mo${exempt}` : null,
  ];
}

function listLastDone(i: Inspection): (string | null | undefined)[] {
  return [
    i.lastSeconds !== undefined ? `${formatHours(i.lastSeconds)} h` : null,
    i.lastCycles !== undefined ? `${i.lastCycles} cyc` : null,
    i.lastLandings !== undefined ? `${i.lastLandings} landings` : null,
    i.lastDate,
  ];
}

function listNextDue(i: Inspection): (string | null | undefined)[] {
  return [
    i.dueSeconds !== undefined ? `${formatHours(i.dueSeconds)} h` : null,
    i.dueCycles !== undefined ? `${i.dueCycles} cyc` : null,
    i.dueLandings !== undefined ? `${i.dueLandings} landings` : null,
  ];
}

// One note per reason, naming every inspection exempt for it.
function listExemptionNotes(inspections: Inspection[]): string[] {
  const reasons = new Map<string, string[]>();
  for (const i of inspections.filter((i) => i.calendarExempt)) {
    const reason = i.calendarExemptReason || "Reason not recorded";
    reasons.set(reason, [...(reasons.get(reason) || []), i.reference]);
  }
  return [...reasons].map(
    ([reason, refs]) => `Calendar exemption - ${refs.join(", ")}: ${reason}`,
  );
}

function airworthinessSection(
  s: Snapshot,
  due: MaintenanceDue[],
  components: Component[],
  today: string,
): StatusSection {
  const ads = due
    .filter((d): d is AdDue => d.kind === "ad")
    .sort(
      (x, z) =>
        x.ad.componentUuid.localeCompare(z.ad.componentUuid) ||
        x.ad.source.number.localeCompare(
          z.ad.source.number,
          undefined,
          NUMERIC,
        ),
    );
  return {
    id: "airworthiness",
    title: "Airworthiness directives",
    columns: [
      "AD number",
      "Aircraft / component",
      "Subject / required action",
      "Remaining / prior compliance",
      "Status",
    ],
    rows: ads.length
      ? ads.map((d) => adRow(d, s, components, today))
      : [["No AD records", "-", "-", "-", "-"]],
    notes: [],
  };
}

// Only a Component installed on this aircraft is named. A removed one's AD
// stays on the aircraft (adAircraftUuid) and is named by its section.
function adRow(
  d: AdDue,
  s: Snapshot,
  components: Component[],
  today: string,
): string[] {
  const { ad: r } = d;
  const component = components.find((c) => c.uuid === r.componentUuid);
  const asset = component
    ? `${component.installPosition || ""} ${component.componentType}\nS/N ${component.serial}`
    : r.source.section;
  const units = r.tasks.flatMap((t) =>
    adRemaining(s, r, t, today).map((x) => `${x.label}: ${x.value}`),
  );
  if (r.priorCompliance)
    units.push(
      `PCW ${r.priorCompliance.date}`,
      formatPriorHours(r.priorCompliance),
    );
  return [
    r.source.number,
    asset,
    [r.source.subject, ...r.tasks.map((t) => t.description)].join("\n"),
    units.join("\n") || "-",
    d.status,
  ];
}

function formatPriorHours(prior: NonNullable<AD["priorCompliance"]>): string {
  if (prior.componentHours !== null)
    return `Engine/component ${prior.componentHours.toFixed(1)} h`;
  if (prior.aircraftHours !== null)
    return `Aircraft ${prior.aircraftHours.toFixed(1)} h`;
  return "";
}

// Status record under 14 CFR 91.417(a)(2)(vi): current copies are listed;
// archived ones are counted, since they are kept but hidden.
function form337Section(s: Snapshot, a: Aircraft): StatusSection {
  const all337 = (s.aircraftFiles ?? []).filter(
    (f) => f.aircraftUuid === a.uuid && f.category === "form-337",
  );
  const current = all337
    .filter(isCurrentAircraftFile)
    .sort((x, z) => x.uploadedAt - z.uploadedAt);
  const archived = all337.length - current.length;
  return {
    id: "form337",
    title: "Form 337 copies",
    columns: ["Document", "Uploaded", "Size"],
    rows: current.length
      ? current.map((f) => [
          f.name,
          localDate(f.uploadedAt),
          `${Math.ceil(f.size / BYTES_PER_KB)} KB`,
        ])
      : [["No Form 337 copies on file", "-", "-"]],
    notes: archived
      ? [
          `${archived} archived Form 337 ${archived === 1 ? "copy is" : "copies are"} not listed. Archived copies are kept in Angel One (View aircraft > Form 337 copies > Show archived).`,
        ]
      : [],
  };
}

function discrepanciesSection(s: Snapshot, a: Aircraft): StatusSection {
  const open = s.discrepancies.filter(
    (d) => d.aircraftUuid === a.uuid && d.status === "open",
  );
  return {
    id: "discrepancies",
    title: "Open discrepancies",
    columns: ["Reported", "Description", "Status"],
    rows: open.length
      ? open.map((d) => [localDate(d.createdAt), d.description, "Open"])
      : [["-", "No open discrepancies recorded", "-"]],
    notes: [],
  };
}

function formatHours(seconds: number | null | undefined): string {
  return seconds == null ? "-" : (seconds / SECONDS_PER_HOUR).toFixed(1);
}

function formatNumber(v: number | undefined, digits = 1): string {
  return v === undefined ? "-" : v.toFixed(digits);
}

function formatUtc(date: Date): string {
  return date
    .toISOString()
    .slice(0, "YYYY-MM-DDTHH:mm".length)
    .replace("T", " ");
}

function joinLines(parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join("\n");
}
