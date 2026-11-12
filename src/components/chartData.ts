/**
 * Responsibility: The pure data shaping behind the shared charts: series
 *   colours, the text table that stands in for a chart, shares of a whole,
 *   and the rows the plotting library reads.
 * Layer: UI. Pure functions; no React, no browser, no chart library.
 * Dependencies: none.
 */

/**
 * A series colour: "1" to "5" are the chart palette (cobalt first, then
 * lighter and darker blues and two greys); slate, good, warn and danger are
 * the status fills, for data that is a status and nothing else. A status
 * that only means "on track" takes cobalt ("1"), one not yet started takes
 * slate; green is for airworthy or done.
 */
export type ChartTone =
  "1" | "2" | "3" | "4" | "5" | "slate" | "good" | "warn" | "danger";

/** One measured thing across the chart, such as "Flight hours". */
export type ChartSeries = { key: string; label: string; tone?: ChartTone };

/** One position on the category axis, with a value for each series key. */
export type ChartRow = { label: string; values: Record<string, number> };

/** One part of a whole, for a Donut or a StackedBar. */
export type ChartSlice = { label: string; value: number; tone?: ChartTone };

/** Formats a value for axes, tooltips and the text alternative. */
export type ChartFormat = (value: number) => string;

const PALETTE: readonly ChartTone[] = ["1", "2", "3", "4", "5"];
const TONE_COLOR: Record<ChartTone, string> = {
  "1": "var(--chart-1)",
  "2": "var(--chart-2)",
  "3": "var(--chart-3)",
  "4": "var(--chart-4)",
  "5": "var(--chart-5)",
  slate: "var(--chart-slate)",
  good: "var(--chart-good)",
  warn: "var(--chart-warn)",
  danger: "var(--chart-danger)",
};
const PERCENT = 100;
// Shares are shown to a tenth of a percent.
const SHARE_PRECISION = 10;

/**
 * The CSS colour of a series or slice.
 *
 * @param tone - Its own tone, when it has one.
 * @param index - Its position; without a tone the palette repeats from "1"
 *   every five positions.
 * @returns A `var(--…)` token reference, so both themes follow.
 */
export function chartColor(tone: ChartTone | undefined, index: number): string {
  return TONE_COLOR[tone ?? PALETTE[index % PALETTE.length]];
}

/**
 * The parts of a whole that a ring or bar draws, each with its colour.
 *
 * @param slices - In drawing order; a part without a tone takes its
 *   position's palette colour, as in the legend.
 * @returns The parts above 0, in order. A part of 0 keeps its legend line but
 *   draws nothing, not even a gap.
 */
export function drawnSlices(
  slices: readonly ChartSlice[],
): { label: string; value: number; color: string }[] {
  return slices
    .map((slice, i) => ({
      label: slice.label,
      value: finite(slice.value),
      color: chartColor(slice.tone, i),
    }))
    .filter((slice) => slice.value > 0);
}

/**
 * The chart's data as a text table, for screen readers and for the view
 * shown when the plot cannot load.
 *
 * @returns `head`: the category heading then each series label, in order.
 *   `body`: one line per row in the order given, its label then each
 *   formatted value; a value the row lacks reads as 0.
 */
export function chartTable(
  rows: readonly ChartRow[],
  series: readonly ChartSeries[],
  format: ChartFormat,
  categoryLabel: string,
): { head: string[]; body: string[][] } {
  return {
    head: [categoryLabel, ...series.map((s) => s.label)],
    body: rows.map((row) => [
      row.label,
      ...series.map((s) => format(finite(row.values[s.key]))),
    ]),
  };
}

/**
 * The rows in the flat shape the plotting library reads: `label` plus one
 * property per series key.
 *
 * @returns One object per row, in order; missing or non-finite values are 0.
 */
export function plotRows(
  rows: readonly ChartRow[],
  series: readonly ChartSeries[],
): Record<string, string | number>[] {
  return rows.map((row) => ({
    label: row.label,
    ...Object.fromEntries(
      series.map((s) => [s.key, finite(row.values[s.key])]),
    ),
  }));
}

/**
 * Each value's share of the total, in percent.
 *
 * @returns One share per value, in order, to a tenth of a percent. Negative
 *   and non-finite values count as 0; when nothing is left every share is 0.
 */
export function shares(values: readonly number[]): number[] {
  const amounts = values.map((v) => Math.max(0, finite(v)));
  const total = amounts.reduce((sum, v) => sum + v, 0);
  if (total === 0) return amounts.map(() => 0);
  return amounts.map(
    (v) =>
      Math.round((v / total) * PERCENT * SHARE_PRECISION) / SHARE_PRECISION,
  );
}

/**
 * How full a meter is.
 *
 * @returns `value / max` in percent, clamped to 0–100 and rounded to a whole
 *   number; 0 when either is not finite or `max` is not above 0.
 */
export function meterPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.round(Math.min(1, Math.max(0, value / max)) * PERCENT);
}

/**
 * A one-sentence reading of a sparkline, since it has no axes to read.
 *
 * @returns "Latest L; low A, high B over N points." with each number
 *   formatted, or "No data." for an empty series. Non-finite points read 0.
 */
export function trendSummary(
  values: readonly number[],
  format: ChartFormat,
): string {
  if (!values.length) return "No data.";
  const points = values.map(finite);
  const latest = format(points[points.length - 1]);
  const low = format(Math.min(...points));
  const high = format(Math.max(...points));
  return `Latest ${latest}; low ${low}, high ${high} over ${points.length} points.`;
}

function finite(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0;
}
