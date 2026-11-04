/**
 * Responsibility: Engine trend monitoring: summarizes a JPI EDM or Garmin
 *   engine-data CSV into one record per flight, flags readings against the
 *   aircraft's limits, and applies import, remove and limit commands.
 * Layer: Domain. Pure parsing and rules; no I/O, no React.
 * Dependencies: zod, ./maintenanceCsv, ./model, ./rejection, ./commandRequest.
 *
 * Only the summary is kept, never the raw samples.
 */
import { z } from "zod";
import { readCsvRows } from "./maintenanceCsv";
import { latestLocalDate } from "./model";
import { Rejection } from "./rejection";
import { requestUuidField } from "./commandRequest";

/** Largest engine-data file accepted, in megabytes. */
export const ENGINE_FILE_MAX_MEGABYTES = 7;

/** A CHT spread across cylinders above this, in °F, is flagged. */
export const CHT_SPREAD_LIMIT_F = 50;

/** Most engine trend imports an aircraft keeps. */
export const MAX_ENGINE_TRENDS = 1000;

// Samples at or above this share of the file's highest RPM count as cruise.
const CRUISE_RPM_SHARE = 0.8;
const HEADER_SEARCH_ROWS = 20;
const ENGINE_FILE_MAX_ROWS = 200_000;
const FILE_NAME_MAX = 200;

const KPA_TO_PSI = 0.145038;
const BAR_TO_PSI = 14.5038;
const KPA_TO_INHG = 0.2953;

const NOT_ENGINE_FILE =
  "Unrecognized engine data file. Use a JPI EDM or Garmin G1000/G3X CSV export with CHT or EGT columns.";
const NO_DATE_COLUMN = "The engine data file has no recognizable date column.";

/**
 * An aircraft's engine limits: the highest CHT and the lowest cruise oil
 * pressure before a flight is flagged.
 *
 * @throws {z.ZodError} From `parse()` on a value outside 200–700 °F or
 *   0–200 psi.
 */
export const engineLimitsSchema = z.object({
  chtMaxF: z.number().finite().min(200).max(700),
  oilPressureMinPsi: z.number().finite().min(0).max(200),
});

/** Parsed engine limits. */
export type EngineLimits = z.infer<typeof engineLimitsSchema>;

/** Limits used until an aircraft has its own. */
export const defaultEngineLimits: EngineLimits = {
  chtMaxF: 435,
  oilPressureMinPsi: 25,
};

const reading = z.number().finite();
const channelStat = z.object({ max: reading, avg: reading });

/**
 * One flight's engine summary: maximum and average per channel (°F, psi,
 * inHg, gph), the widest CHT and EGT spreads, and the lowest cruise oil
 * pressure.
 *
 * @throws {z.ZodError} From `parse()` on an unknown channel, no channels
 *   ("No engine channels."), or an invalid field.
 */
export const engineSummarySchema = z.object({
  source: z.enum(["jpi", "garmin"]),
  fileName: z.string().trim().min(1).max(FILE_NAME_MAX),
  date: z.iso.date(),
  start: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
    .optional(),
  durationSeconds: z
    .number()
    .int()
    .nonnegative()
    .max(7 * 86400)
    .optional(),
  samples: z.number().int().positive(),
  channels: z
    .record(
      z.string().regex(/^(?:CHT[1-9]|EGT[1-9]|TIT|OILT|OILP|RPM|MAP|FF)$/),
      channelStat,
    )
    .refine((c) => Object.keys(c).length > 0, "No engine channels."),
  maxChtSpread: reading.optional(),
  maxEgtSpread: reading.optional(),
  minCruiseOilPressure: reading.optional(),
});

/** A parsed engine summary. */
export type EngineSummary = z.infer<typeof engineSummarySchema>;

/**
 * A stored engine trend import: a summary with its aircraft and importer.
 *
 * @throws {z.ZodError} From `parse()` on an invalid field.
 */
export const engineTrendSchema = engineSummarySchema.extend({
  uuid: z.string().uuid(),
  aircraftUuid: z.string().min(1),
  importedAt: z.number(),
  importedBy: z.string(),
});

/** A parsed engine trend import. */
export type EngineTrend = z.infer<typeof engineTrendSchema>;

/**
 * A command on an aircraft's engine trends: import a summary, remove an
 * import, or set the limits; each may carry its request id.
 *
 * @throws {z.ZodError} From `parse()` on an unknown action or invalid field.
 */
export const engineTrendCommandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("import"),
    uuid: z.string().uuid(),
    summary: engineSummarySchema,
    ...requestUuidField,
  }),
  z.object({
    action: z.literal("remove"),
    uuid: z.string().uuid(),
    ...requestUuidField,
  }),
  z.object({
    action: z.literal("limits"),
    limits: engineLimitsSchema,
    ...requestUuidField,
  }),
]);

/** A parsed engine trend command. */
export type EngineTrendCommand = z.infer<typeof engineTrendCommandSchema>;

/** An aircraft's engine trend imports and limits. */
export interface EngineTrendData {
  trends: EngineTrend[];
  limits: EngineLimits;
}

/**
 * Names the engine-1 channel a JPI or Garmin column header holds. Units in
 * brackets or parentheses and punctuation are ignored.
 *
 * @param header - A column header, such as "E1 CHT1" or "Oil Press (PSI)".
 * @returns "CHT1"–"CHT9", "EGT1"–"EGT9", "TIT", "OILT", "OILP", "RPM", "MAP"
 *   or "FF"; undefined for another engine's column or any other header.
 */
export function channelForHeader(header: string): string | undefined {
  const raw = normalizeHeader(header);
  if (/^(?:e|eng|engine)[2-9][a-z]{2}/.test(raw)) return undefined;
  const h = raw.replace(/^(?:e|eng|engine)1(?=[a-z]{2})/, "");
  const cylinder = /^(cht|c|egt|e)([1-9])$/.exec(h);
  if (cylinder)
    return (cylinder[1].startsWith("c") ? "CHT" : "EGT") + cylinder[2];
  if (/^(?:tit1?|t1)$/.test(h)) return "TIT";
  if (/^oil(?:t|temp|temperature)$/.test(h)) return "OILT";
  if (/^oil(?:p|press|pressure|prs)$/.test(h)) return "OILP";
  if (h === "rpm") return "RPM";
  if (/^(?:map|manp|manpress|manifoldpress|manifoldpressure)$/.test(h))
    return "MAP";
  if (/^(?:ff|fflow|fuelflow)$/.test(h)) return "FF";
}

/**
 * Tells a Garmin export from a JPI one.
 *
 * @param headers - The file's column headers.
 * @param airframeInfo - Whether the file has a Garmin "#airframe_info" line.
 * @returns "garmin" with that line, a local-date column or "E1" channel
 *   names; otherwise "jpi".
 */
export function detectEngineFormat(
  headers: string[],
  airframeInfo: boolean,
): EngineSummary["source"] {
  const normalized = headers.map(normalizeHeader);
  const garmin = normalized.some(
    (h) => h === "lcldate" || h === "localdate" || /^e1[a-z]{2}/.test(h),
  );
  return airframeInfo || garmin ? "garmin" : "jpi";
}

/**
 * Reads a date as an engine or flight-log export writes it.
 *
 * @param text - "YYYY-M-D", or US "M/D/YY" or "M/D/YYYY" (two-digit years
 *   are 20YY).
 * @returns The date as YYYY-MM-DD, or undefined for any other text or a day
 *   the calendar does not have.
 */
export function parseExportDate(text: string) {
  const parts = readDateParts(text);
  if (!parts) return undefined;
  const [y, m, d] = parts;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d
    ? date.toISOString().slice(0, 10)
    : undefined;
}

/**
 * Reads a time of day as an export writes it.
 *
 * @param text - "H:MM" or "H:MM:SS", 24-hour.
 * @returns The time as HH:MM:SS, or undefined for any other text.
 */
export function parseExportTime(text: string) {
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!t || +t[1] > 23 || +t[2] > 59 || +(t[3] ?? 0) > 59) return undefined;
  return [t[1].padStart(2, "0"), t[2], t[3] ?? "00"].join(":");
}

/**
 * Summarizes one engine-data export. Samples with no readings, or with the
 * engine stopped (RPM 0 or less), are skipped; Celsius, kPa and bar are
 * converted to °F, psi and inHg.
 *
 * @param text - The CSV file's text.
 * @param fileName - The file's name, kept to 200 characters.
 * @returns The summary, readings rounded to tenths; its date is the first
 *   dated row's, and its duration runs from the first to the last timed row.
 * @throws {Rejection} For a file over 7 MB, no engine columns, no date column
 *   or dated row, a date in the future, or no sample with the engine running;
 *   also as {@link readCsvRows}.
 * @throws {z.ZodError} When the summary fails the schema (over 7 days long).
 */
export function parseEngineLog(text: string, fileName: string): EngineSummary {
  if (text.length > ENGINE_FILE_MAX_MEGABYTES * 1024 * 1024)
    throw new Rejection(
      `Engine data files must be at most ${ENGINE_FILE_MAX_MEGABYTES} MB.`,
    );
  const { body, airframeInfo, unitsRow } = stripCommentLines(text);
  const rows = readCsvRows(body, {
    maxMegabytes: ENGINE_FILE_MAX_MEGABYTES,
    maxRecords: ENGINE_FILE_MAX_ROWS,
  });
  const at = locateHeader(rows);
  const header = rows[at].cells;
  const find = (...names: string[]) =>
    header.findIndex((h) => names.includes(normalizeHeader(h)));
  const layout = {
    columns: mapColumns(header, unitsRow),
    date: find("date", "lcldate", "localdate"),
    time: find("time", "lcltime", "localtime"),
  };
  if (layout.date < 0) throw new Rejection(NO_DATE_COLUMN);
  const totals = newTotals();
  for (const { cells } of rows.slice(at + 1)) addSample(totals, layout, cells);
  return summarize(totals, detectEngineFormat(header, airframeInfo), fileName);
}

/**
 * Finds the hottest reading across every channel with a prefix.
 *
 * @param t - The summary.
 * @param prefix - A channel prefix, such as "CHT" for all cylinders.
 * @returns The highest maximum, or undefined without such a channel.
 */
export function hottest(t: EngineSummary, prefix: string) {
  const c = channelsOf(t, prefix);
  return c.length ? Math.max(...c.map(([, s]) => s.max)) : undefined;
}

/**
 * Lists what in a flight's summary breaks the aircraft's limits.
 *
 * @param t - The summary.
 * @param limits - The aircraft's limits.
 * @returns Messages in the order hottest CHT, CHT spread over
 *   {@link CHT_SPREAD_LIMIT_F}, cruise oil pressure; empty when none.
 */
export function engineFlags(t: EngineSummary, limits: EngineLimits) {
  const flags: string[] = [];
  const cht = hottest(t, "CHT");
  if (cht !== undefined && cht > limits.chtMaxF)
    flags.push(`Hottest CHT ${cht} °F exceeds the ${limits.chtMaxF} °F limit.`);
  if (t.maxChtSpread !== undefined && t.maxChtSpread > CHT_SPREAD_LIMIT_F)
    flags.push(
      `CHT spread ${t.maxChtSpread} °F exceeds ${CHT_SPREAD_LIMIT_F} °F.`,
    );
  if (
    t.minCruiseOilPressure !== undefined &&
    t.minCruiseOilPressure < limits.oilPressureMinPsi
  )
    flags.push(
      `Cruise oil pressure ${t.minCruiseOilPressure} psi is below the ${limits.oilPressureMinPsi} psi minimum.`,
    );
  return flags;
}

/** A chart of one quantity across flights, with its lines and limit. */
export interface EngineSeries {
  key: string;
  label: string;
  unit: string;
  lines: { name: string; value: (t: EngineSummary) => number | undefined }[];
  limit?: (l: EngineLimits) => number;
}

/** The engine trend charts, in display order. */
export const engineSeries: EngineSeries[] = [
  maxAndAverage("cht", "CHT (hottest cylinder)", "°F", "CHT", (l) => l.chtMaxF),
  {
    key: "chtSpread",
    label: "CHT spread",
    unit: "°F",
    limit: () => CHT_SPREAD_LIMIT_F,
    lines: [{ name: "Max spread", value: (t) => t.maxChtSpread }],
  },
  maxAndAverage("egt", "EGT (hottest cylinder)", "°F", "EGT"),
  {
    key: "egtSpread",
    label: "EGT spread",
    unit: "°F",
    lines: [{ name: "Max spread", value: (t) => t.maxEgtSpread }],
  },
  maxAndAverage("tit", "TIT", "°F", "TIT"),
  maxAndAverage("oilt", "Oil temperature", "°F", "OILT"),
  {
    key: "oilp",
    label: "Oil pressure",
    unit: "psi",
    limit: (l) => l.oilPressureMinPsi,
    lines: [
      { name: "Min in cruise", value: (t) => t.minCruiseOilPressure },
      { name: "Average", value: (t) => t.channels.OILP?.avg },
    ],
  },
  maxAndAverage("rpm", "RPM", "rpm", "RPM"),
  maxAndAverage("map", "Manifold pressure", "inHg", "MAP"),
  maxAndAverage("ff", "Fuel flow", "gph", "FF"),
];

/**
 * Applies an engine trend command to an aircraft's data, without changing
 * the input. The Convex mutation and the demo backend share it.
 *
 * @param data - The aircraft's imports and limits.
 * @param raw - The command, parsed with {@link engineTrendCommandSchema}.
 * @param context - The aircraft, the user, and the import time.
 * @returns The new data, with the `created` or `removed` import.
 * @throws {Rejection} "Engine trend import not found.", "This engine data file
 *   was already imported." (same date, start and sample count), or the
 *   {@link MAX_ENGINE_TRENDS} limit; {z.ZodError} for a bad command.
 */
export function applyEngineTrendCommand(
  data: EngineTrendData,
  raw: EngineTrendCommand,
  context: { aircraftUuid: string; actorId: string; now: number },
): EngineTrendData & { created?: EngineTrend; removed?: EngineTrend } {
  const command = engineTrendCommandSchema.parse(raw);
  if (command.action === "limits") return { ...data, limits: command.limits };
  if (command.action === "remove") {
    const removed = data.trends.find((t) => t.uuid === command.uuid);
    if (!removed) throw new Rejection("Engine trend import not found.");
    const trends = data.trends.filter((t) => t !== removed);
    return { ...data, trends, removed };
  }
  if (data.trends.some((t) => isSameFlight(t, command.summary)))
    throw new Rejection("This engine data file was already imported.");
  if (data.trends.length >= MAX_ENGINE_TRENDS)
    throw new Rejection(
      `An aircraft can keep up to ${MAX_ENGINE_TRENDS} engine trend imports. Remove old imports first.`,
    );
  const created: EngineTrend = {
    ...command.summary,
    uuid: command.uuid,
    aircraftUuid: context.aircraftUuid,
    importedAt: context.now,
    importedBy: context.actorId,
  };
  return { ...data, trends: [...data.trends, created], created };
}

interface Column {
  index: number;
  channel: string;
  convert: (v: number) => number;
}

interface Layout {
  columns: Column[];
  date: number;
  time: number;
}

interface SampleTotals {
  samples: number;
  date?: string;
  start?: string;
  end?: string;
  stats: Map<string, { max: number; sum: number; count: number }>;
  cruise: { rpm: number; oilp?: number }[];
  chtSpread?: number;
  egtSpread?: number;
}

function normalizeHeader(header: string) {
  return header
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]|°\s*[cf]\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function readDateParts(text: string) {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) return [+iso[1], +iso[2], +iso[3]];
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text);
  if (!us) return undefined;
  const year = us[3].length === 2 ? 2000 + +us[3] : +us[3];
  return [year, +us[1], +us[2]];
}

function chooseConverter(channel: string, units: string[]) {
  const unit = (pattern: RegExp) => units.some((u) => pattern.test(u));
  const temperature = /^(?:CHT|EGT|TIT|OILT)/.test(channel);
  if (temperature && unit(/^(?:°\s*c|deg\s*c|degc|c|celsius)$/))
    return (v: number) => (v * 9) / 5 + 32;
  if (channel === "OILP" && unit(/^kpa$/)) return (v: number) => v * KPA_TO_PSI;
  if (channel === "OILP" && unit(/^bar$/)) return (v: number) => v * BAR_TO_PSI;
  if (channel === "MAP" && unit(/^kpa$/)) return (v: number) => v * KPA_TO_INHG;
  return (v: number) => v;
}

function roundTenth(n: number) {
  return Math.round(n * 10) / 10;
}

// Garmin comment lines (#airframe_info, #units) hold unquoted quotes; blank
// them so row numbers stay intact, and keep the units row for conversions.
// Any comment line but #airframe_info is read as the units row.
function stripCommentLines(text: string) {
  let airframeInfo = false;
  let unitsRow: string[] = [];
  const body = text
    .replace(/^﻿/, "")
    .split(/\r\n|\n|\r/)
    .map((line) => {
      const t = line.trim();
      if (!t.startsWith("#")) return line;
      if (/^#airframe_info/i.test(t)) airframeInfo = true;
      else unitsRow = t.slice(1).split(",");
      return "";
    })
    .join("\n");
  return { body, airframeInfo, unitsRow };
}

// The header is the row, among the first 20, that names the most channels.
function locateHeader(rows: { cells: string[] }[]) {
  let best = { at: -1, count: 0 };
  rows.slice(0, HEADER_SEARCH_ROWS).forEach(({ cells }, at) => {
    const count = cells.filter((c) => channelForHeader(c)).length;
    if (count > best.count) best = { at, count };
  });
  if (best.at < 0) throw new Rejection(NOT_ENGINE_FILE);
  return best.at;
}

// The first column for a channel wins; its units come from the header text
// or the units row.
function mapColumns(header: string[], unitsRow: string[]) {
  const columns: Column[] = [];
  header.forEach((cell, index) => {
    const channel = channelForHeader(cell);
    if (!channel || columns.some((c) => c.channel === channel)) return;
    const units = [
      ...[...cell.matchAll(/\(([^)]*)\)|\[([^\]]*)\]|(°\s*[cf])\b/gi)].map(
        (m) => m[1] ?? m[2] ?? m[3],
      ),
      unitsRow[index] ?? "",
    ].map((u) => u.trim().toLowerCase());
    columns.push({ index, channel, convert: chooseConverter(channel, units) });
  });
  return columns;
}

function newTotals(): SampleTotals {
  return { samples: 0, stats: new Map(), cruise: [] };
}

function addSample(totals: SampleTotals, layout: Layout, cells: string[]) {
  const day = parseExportDate(cells[layout.date]?.trim() ?? "");
  const time = parseExportTime(cells[layout.time]?.trim() ?? "");
  if (day && !totals.date) totals.date = day;
  if (day && time) {
    totals.start ??= `${day}T${time}`;
    totals.end = `${day}T${time}`;
  }
  const values = readValues(layout.columns, cells);
  if (!Object.keys(values).length) return;
  if (values.RPM !== undefined && values.RPM <= 0) return;
  totals.samples++;
  for (const [channel, v] of Object.entries(values)) {
    const s = totals.stats.get(channel);
    totals.stats.set(
      channel,
      s
        ? { max: Math.max(s.max, v), sum: s.sum + v, count: s.count + 1 }
        : { max: v, sum: v, count: 1 },
    );
  }
  totals.chtSpread = maxDefined(totals.chtSpread, measureSpread(values, "CHT"));
  totals.egtSpread = maxDefined(totals.egtSpread, measureSpread(values, "EGT"));
  if (values.RPM !== undefined)
    totals.cruise.push({ rpm: values.RPM, oilp: values.OILP });
}

function readValues(columns: Column[], cells: string[]) {
  const values: Record<string, number> = {};
  for (const c of columns) {
    const cell = cells[c.index]?.trim() ?? "";
    if (/^-?\d+(?:\.\d+)?$/.test(cell))
      values[c.channel] = c.convert(Number(cell));
  }
  return values;
}

function summarize(
  totals: SampleTotals,
  source: EngineSummary["source"],
  fileName: string,
) {
  const { date, start, end, samples, stats } = totals;
  if (!date) throw new Rejection(NO_DATE_COLUMN);
  if (date > latestLocalDate())
    throw new Rejection(`Engine data dated ${date} is in the future.`);
  if (!samples)
    throw new Rejection(
      "No engine samples were found with the engine running.",
    );
  const cruiseOil = listCruiseOilPressures(totals);
  return engineSummarySchema.parse({
    source,
    fileName: fileName.slice(0, FILE_NAME_MAX),
    date,
    start,
    durationSeconds:
      start && end
        ? Math.max(0, (Date.parse(end + "Z") - Date.parse(start + "Z")) / 1000)
        : undefined,
    samples,
    channels: Object.fromEntries(
      [...stats].map(([k, s]) => [
        k,
        { max: roundTenth(s.max), avg: roundTenth(s.sum / s.count) },
      ]),
    ),
    maxChtSpread: roundDefined(totals.chtSpread),
    maxEgtSpread: roundDefined(totals.egtSpread),
    minCruiseOilPressure: cruiseOil.length
      ? roundTenth(Math.min(...cruiseOil))
      : undefined,
  });
}

function listCruiseOilPressures(totals: SampleTotals) {
  const maxRpm = totals.stats.get("RPM")?.max;
  return totals.cruise
    .filter((s) => maxRpm && s.rpm >= maxRpm * CRUISE_RPM_SHARE)
    .flatMap((s) => (s.oilp === undefined ? [] : [s.oilp]));
}

function roundDefined(n: number | undefined) {
  return n === undefined ? undefined : roundTenth(n);
}

function measureSpread(values: Record<string, number>, prefix: string) {
  const v = Object.entries(values)
    .filter(([k]) => k.startsWith(prefix))
    .map(([, n]) => n);
  return v.length > 1 ? Math.max(...v) - Math.min(...v) : undefined;
}

function maxDefined(a: number | undefined, b: number | undefined) {
  if (a === undefined) return b;
  return b === undefined ? a : Math.max(a, b);
}

function channelsOf(t: EngineSummary, prefix: string) {
  return Object.entries(t.channels).filter(([k]) => k.startsWith(prefix));
}

function averageOf(t: EngineSummary, prefix: string) {
  const c = channelsOf(t, prefix);
  return c.length
    ? roundTenth(c.reduce((sum, [, s]) => sum + s.avg, 0) / c.length)
    : undefined;
}

function maxAndAverage(
  key: string,
  label: string,
  unit: string,
  prefix: string,
  limit?: EngineSeries["limit"],
): EngineSeries {
  return {
    key,
    label,
    unit,
    limit,
    lines: [
      { name: "Max", value: (t) => hottest(t, prefix) },
      { name: "Average", value: (t) => averageOf(t, prefix) },
    ],
  };
}

function isSameFlight(a: EngineSummary, b: EngineSummary) {
  return a.date === b.date && a.start === b.start && a.samples === b.samples;
}
