import { z } from "zod";
import { readCsvRows } from "./maintenanceCsv";
import { latestLocalDate } from "./model";

export const ENGINE_FILE_MAX_MEGABYTES = 7;
export const CHT_SPREAD_LIMIT_F = 50;
export const MAX_ENGINE_TRENDS = 1000;
// Samples at or above this share of the file's highest RPM count as cruise.
const CRUISE_RPM_SHARE = 0.8;
const HEADER_SEARCH_ROWS = 20;

export const engineLimitsSchema = z.object({
  chtMaxF: z.number().finite().min(200).max(700),
  oilPressureMinPsi: z.number().finite().min(0).max(200),
});
export type EngineLimits = z.infer<typeof engineLimitsSchema>;
export const defaultEngineLimits: EngineLimits = {
  chtMaxF: 435,
  oilPressureMinPsi: 25,
};
const reading = z.number().finite();
const channelStat = z.object({ max: reading, avg: reading });
export const engineSummarySchema = z.object({
  source: z.enum(["jpi", "garmin"]),
  fileName: z.string().trim().min(1).max(200),
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
export type EngineSummary = z.infer<typeof engineSummarySchema>;
export const engineTrendSchema = engineSummarySchema.extend({
  uuid: z.string().uuid(),
  aircraftUuid: z.string().min(1),
  importedAt: z.number(),
  importedBy: z.string(),
});
export type EngineTrend = z.infer<typeof engineTrendSchema>;
export const engineTrendCommandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("import"),
    uuid: z.string().uuid(),
    summary: engineSummarySchema,
  }),
  z.object({ action: z.literal("remove"), uuid: z.string().uuid() }),
  z.object({ action: z.literal("limits"), limits: engineLimitsSchema }),
]);
export type EngineTrendCommand = z.infer<typeof engineTrendCommandSchema>;
export interface EngineTrendData {
  trends: EngineTrend[];
  limits: EngineLimits;
}

const normalize = (header: string) =>
  header
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]|°\s*[cf]\b/g, "")
    .replace(/[^a-z0-9]/g, "");
/** Engine-1 channel for a JPI or Garmin header; other engines are ignored. */
export function channelForHeader(header: string): string | undefined {
  const raw = normalize(header);
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
export function detectEngineFormat(
  headers: string[],
  airframeInfo: boolean,
): EngineSummary["source"] {
  const normalized = headers.map(normalize);
  return airframeInfo ||
    normalized.some(
      (h) => h === "lcldate" || h === "localdate" || /^e1[a-z]{2}/.test(h),
    )
    ? "garmin"
    : "jpi";
}
export function parseExportDate(text: string) {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text);
  const parts = iso
    ? [+iso[1], +iso[2], +iso[3]]
    : us
      ? [us[3].length === 2 ? 2000 + +us[3] : +us[3], +us[1], +us[2]]
      : undefined;
  if (!parts) return undefined;
  const [y, m, d] = parts;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d
    ? date.toISOString().slice(0, 10)
    : undefined;
}
export function parseExportTime(text: string) {
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!t || +t[1] > 23 || +t[2] > 59 || +(t[3] ?? 0) > 59) return undefined;
  return [t[1].padStart(2, "0"), t[2], t[3] ?? "00"].join(":");
}
const isTemperature = (channel: string) =>
  /^(?:CHT|EGT|TIT|OILT)/.test(channel);
function converter(channel: string, units: string[]) {
  const unit = (pattern: RegExp) => units.some((u) => pattern.test(u));
  if (isTemperature(channel) && unit(/^(?:°\s*c|deg\s*c|degc|c|celsius)$/))
    return (v: number) => (v * 9) / 5 + 32;
  if (channel === "OILP" && unit(/^kpa$/)) return (v: number) => v * 0.145038;
  if (channel === "OILP" && unit(/^bar$/)) return (v: number) => v * 14.5038;
  if (channel === "MAP" && unit(/^kpa$/)) return (v: number) => v * 0.2953;
  return (v: number) => v;
}
const round = (n: number) => Math.round(n * 10) / 10;
interface Column {
  index: number;
  channel: string;
  convert: (v: number) => number;
}
function locateHeader(rows: { cells: string[] }[]) {
  let best = { at: -1, count: 0 };
  rows.slice(0, HEADER_SEARCH_ROWS).forEach(({ cells }, at) => {
    const count = cells.filter((c) => channelForHeader(c)).length;
    if (count > best.count) best = { at, count };
  });
  if (best.at < 0)
    throw new Error(
      "Unrecognized engine data file. Use a JPI EDM or Garmin G1000/G3X CSV export with CHT or EGT columns.",
    );
  return best.at;
}
function columnsFor(header: string[], unitsRow: string[]) {
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
    columns.push({ index, channel, convert: converter(channel, units) });
  });
  return columns;
}
function spread(values: Record<string, number>, prefix: string) {
  const v = Object.entries(values)
    .filter(([k]) => k.startsWith(prefix))
    .map(([, n]) => n);
  return v.length > 1 ? Math.max(...v) - Math.min(...v) : undefined;
}
const maxOf = (a: number | undefined, b: number | undefined) =>
  a === undefined ? b : b === undefined ? a : Math.max(a, b);
/** One summary per file: raw samples are never kept. */
export function parseEngineLog(text: string, fileName: string): EngineSummary {
  if (text.length > ENGINE_FILE_MAX_MEGABYTES * 1024 * 1024)
    throw new Error(
      `Engine data files must be at most ${ENGINE_FILE_MAX_MEGABYTES} MB.`,
    );
  // Garmin comment lines (#airframe_info, #units) hold unquoted quotes; blank
  // them so row numbers stay intact and keep the units row for conversions.
  let airframeInfo = false,
    unitsRow: string[] = [];
  const cleaned = text
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
  const rows = readCsvRows(cleaned, {
    maxMegabytes: ENGINE_FILE_MAX_MEGABYTES,
    maxRecords: 200_000,
  });
  const at = locateHeader(rows);
  const header = rows[at].cells;
  const columns = columnsFor(header, unitsRow);
  const find = (...names: string[]) =>
    header.findIndex((h) => names.includes(normalize(h)));
  const dateColumn = find("date", "lcldate", "localdate");
  const timeColumn = find("time", "lcltime", "localtime");
  if (dateColumn < 0)
    throw new Error("The engine data file has no recognizable date column.");
  const stats = new Map<string, { max: number; sum: number; count: number }>();
  const cruise: { rpm: number; oilp?: number }[] = [];
  let samples = 0,
    date: string | undefined,
    start: string | undefined,
    end: string | undefined,
    chtSpread: number | undefined,
    egtSpread: number | undefined;
  for (const { cells } of rows.slice(at + 1)) {
    const day = parseExportDate(cells[dateColumn]?.trim() ?? "");
    const time = parseExportTime(cells[timeColumn]?.trim() ?? "");
    if (day && !date) date = day;
    if (day && time) {
      start ??= `${day}T${time}`;
      end = `${day}T${time}`;
    }
    const values: Record<string, number> = {};
    for (const c of columns) {
      const cell = cells[c.index]?.trim() ?? "";
      if (/^-?\d+(?:\.\d+)?$/.test(cell))
        values[c.channel] = c.convert(Number(cell));
    }
    if (!Object.keys(values).length) continue;
    if (values.RPM !== undefined && values.RPM <= 0) continue;
    samples++;
    for (const [channel, v] of Object.entries(values)) {
      const s = stats.get(channel);
      stats.set(
        channel,
        s
          ? { max: Math.max(s.max, v), sum: s.sum + v, count: s.count + 1 }
          : { max: v, sum: v, count: 1 },
      );
    }
    chtSpread = maxOf(chtSpread, spread(values, "CHT"));
    egtSpread = maxOf(egtSpread, spread(values, "EGT"));
    if (values.RPM !== undefined)
      cruise.push({ rpm: values.RPM, oilp: values.OILP });
  }
  if (!date)
    throw new Error("The engine data file has no recognizable date column.");
  if (date > latestLocalDate())
    throw new Error(`Engine data dated ${date} is in the future.`);
  if (!samples)
    throw new Error("No engine samples were found with the engine running.");
  const maxRpm = stats.get("RPM")?.max;
  const cruiseOil = cruise
    .filter((s) => maxRpm && s.rpm >= maxRpm * CRUISE_RPM_SHARE)
    .flatMap((s) => (s.oilp === undefined ? [] : [s.oilp]));
  return engineSummarySchema.parse({
    source: detectEngineFormat(header, airframeInfo),
    fileName: fileName.slice(0, 200),
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
        { max: round(s.max), avg: round(s.sum / s.count) },
      ]),
    ),
    maxChtSpread: chtSpread === undefined ? undefined : round(chtSpread),
    maxEgtSpread: egtSpread === undefined ? undefined : round(egtSpread),
    minCruiseOilPressure: cruiseOil.length
      ? round(Math.min(...cruiseOil))
      : undefined,
  });
}
const channelsOf = (t: EngineSummary, prefix: string) =>
  Object.entries(t.channels).filter(([k]) => k.startsWith(prefix));
/** Highest maximum across every channel with the prefix (e.g. all CHTs). */
export function hottest(t: EngineSummary, prefix: string) {
  const c = channelsOf(t, prefix);
  return c.length ? Math.max(...c.map(([, s]) => s.max)) : undefined;
}
function meanAverage(t: EngineSummary, prefix: string) {
  const c = channelsOf(t, prefix);
  return c.length
    ? round(c.reduce((sum, [, s]) => sum + s.avg, 0) / c.length)
    : undefined;
}
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
export interface EngineSeries {
  key: string;
  label: string;
  unit: string;
  lines: { name: string; value: (t: EngineSummary) => number | undefined }[];
  limit?: (l: EngineLimits) => number;
}
const maxAvg = (
  key: string,
  label: string,
  unit: string,
  prefix: string,
  limit?: EngineSeries["limit"],
): EngineSeries => ({
  key,
  label,
  unit,
  limit,
  lines: [
    { name: "Max", value: (t) => hottest(t, prefix) },
    { name: "Average", value: (t) => meanAverage(t, prefix) },
  ],
});
export const engineSeries: EngineSeries[] = [
  maxAvg("cht", "CHT (hottest cylinder)", "°F", "CHT", (l) => l.chtMaxF),
  {
    key: "chtSpread",
    label: "CHT spread",
    unit: "°F",
    limit: () => CHT_SPREAD_LIMIT_F,
    lines: [{ name: "Max spread", value: (t) => t.maxChtSpread }],
  },
  maxAvg("egt", "EGT (hottest cylinder)", "°F", "EGT"),
  {
    key: "egtSpread",
    label: "EGT spread",
    unit: "°F",
    lines: [{ name: "Max spread", value: (t) => t.maxEgtSpread }],
  },
  maxAvg("tit", "TIT", "°F", "TIT"),
  maxAvg("oilt", "Oil temperature", "°F", "OILT"),
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
  maxAvg("rpm", "RPM", "rpm", "RPM"),
  maxAvg("map", "Manifold pressure", "inHg", "MAP"),
  maxAvg("ff", "Fuel flow", "gph", "FF"),
];
const sameFlight = (a: EngineSummary, b: EngineSummary) =>
  a.date === b.date && a.start === b.start && a.samples === b.samples;
/** Shared by the Convex mutation and the demo backend; never mutates input. */
export function applyEngineTrendCommand(
  data: EngineTrendData,
  raw: EngineTrendCommand,
  context: { aircraftUuid: string; actorId: string; now: number },
): EngineTrendData & { created?: EngineTrend; removed?: EngineTrend } {
  const command = engineTrendCommandSchema.parse(raw);
  if (command.action === "limits") return { ...data, limits: command.limits };
  if (command.action === "remove") {
    const removed = data.trends.find((t) => t.uuid === command.uuid);
    if (!removed) throw new Error("Engine trend import not found.");
    return {
      ...data,
      trends: data.trends.filter((t) => t !== removed),
      removed,
    };
  }
  if (data.trends.some((t) => sameFlight(t, command.summary)))
    throw new Error("This engine data file was already imported.");
  if (data.trends.length >= MAX_ENGINE_TRENDS)
    throw new Error(
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
