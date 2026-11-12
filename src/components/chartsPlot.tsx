/**
 * Responsibility: Draws the shared charts' plots (bars, lines, donut) with
 *   Recharts, themed only through the design tokens.
 * Layer: UI. Presentational; loaded on demand by ./charts.tsx, the only
 *   module that may import this one.
 * Dependencies: react, recharts, ./chartData.ts.
 *
 * Recharts and its d3 and state libraries are about a third of a megabyte,
 * so they live in this chunk and never in the first load. The plots are
 * hidden from screen readers: charts.tsx renders the text alternative.
 */
import type { ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import {
  chartColor,
  type ChartFormat,
  type ChartSeries,
  type ChartSlice,
} from "./chartData";

/** What a bar or line plot draws: flat rows from `plotRows` and its series. */
export type PlotProps = {
  rows: Record<string, string | number>[];
  series: readonly ChartSeries[];
  format: ChartFormat;
  /** Keeps axis ticks to whole numbers, for counts. */
  wholeNumbers?: boolean;
};

// SPEC rule 11: entry motion only for a mouse, and never against the
// reduced-motion preference.
const ENTRY_MOTION_QUERY =
  "(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)";
const ENTRY_MS = 700;
const AXIS_TICK = { fill: "var(--chart-axis)", fontSize: 12 };
const PLOT_MARGIN = { top: 8, right: 8, bottom: 0, left: 0 };
const SPARK_MARGIN = { top: 3, right: 3, bottom: 3, left: 3 };
const Y_AXIS_WIDTH = 44;
const MAX_BAR_WIDTH = 36;
const BAR_TOP_RADIUS: [number, number, number, number] = [6, 6, 0, 0];
const LINE_WIDTH = 2;
const LINE_INSET = 14;
const DONUT_HOLE = "68%";
// 12 o'clock, clockwise: how people read a share ring.
const DONUT_START_DEG = 90;
const DONUT_END_DEG = -270;

/**
 * Vertical bars, grouped side by side or stacked.
 *
 * @param props.stacked - Stacks the series; only the last series' bars are
 *   rounded then, as the top of the stack.
 */
export function BarPlot({
  rows,
  series,
  format,
  wholeNumbers,
  stacked,
}: PlotProps & { stacked: boolean }) {
  const animate = entryMotionAllowed();
  const top = series.length - 1;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={rows} margin={PLOT_MARGIN} accessibilityLayer={false}>
        {axes(format, 0, wholeNumbers)}
        <Tooltip
          content={tipContent(format)}
          cursor={{ fill: "var(--chart-cursor)" }}
        />
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            fill={chartColor(s.tone, i)}
            stackId={stacked ? "stack" : undefined}
            radius={!stacked || i === top ? BAR_TOP_RADIUS : undefined}
            maxBarSize={MAX_BAR_WIDTH}
            isAnimationActive={animate}
            animationDuration={ENTRY_MS}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * One smooth line per series.
 *
 * @param props.bare - A sparkline: the line alone, with no axes, grid or
 *   tooltip.
 */
export function LinePlot({
  rows,
  series,
  format,
  wholeNumbers,
  bare,
}: PlotProps & { bare: boolean }) {
  const animate = entryMotionAllowed();
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart
        data={rows}
        margin={bare ? SPARK_MARGIN : PLOT_MARGIN}
        accessibilityLayer={false}
      >
        {!bare && axes(format, LINE_INSET, wholeNumbers)}
        {!bare && (
          <Tooltip
            content={tipContent(format)}
            cursor={{ stroke: "var(--chart-grid)" }}
          />
        )}
        {series.map((s, i) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label}
            stroke={chartColor(s.tone, i)}
            strokeWidth={LINE_WIDTH}
            dot={false}
            activeDot={bare ? false : { r: 4 }}
            isAnimationActive={animate}
            animationDuration={ENTRY_MS}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

/** A ring of shares, read clockwise from 12 o'clock in the order given. */
export function DonutPlot({
  slices,
  format,
}: {
  slices: readonly ChartSlice[];
  format: ChartFormat;
}) {
  const data = slices.map((slice, i) => ({
    label: slice.label,
    value: Math.max(0, slice.value),
    fill: chartColor(slice.tone, i),
  }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart accessibilityLayer={false}>
        <Tooltip content={tipContent(format)} />
        <Pie
          data={data}
          dataKey="value"
          nameKey="label"
          innerRadius={DONUT_HOLE}
          outerRadius="100%"
          startAngle={DONUT_START_DEG}
          endAngle={DONUT_END_DEG}
          stroke="var(--surface)"
          strokeWidth={2}
          isAnimationActive={entryMotionAllowed()}
          animationDuration={ENTRY_MS}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

// `inset` keeps a line chart's first and last labels inside the plot.
function axes(format: ChartFormat, inset = 0, wholeNumbers = false): ReactNode {
  return (
    <>
      <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
      <XAxis
        dataKey="label"
        padding={{ left: inset, right: inset }}
        tick={AXIS_TICK}
        axisLine={false}
        tickLine={false}
        tickMargin={8}
      />
      <YAxis
        tick={AXIS_TICK}
        axisLine={false}
        tickLine={false}
        tickFormatter={format}
        allowDecimals={!wholeNumbers}
        width={Y_AXIS_WIDTH}
      />
    </>
  );
}

type TipProps = Pick<TooltipContentProps, "active" | "payload" | "label">;

function tipContent(format: ChartFormat) {
  return ({ active, payload, label }: TipProps) => (
    <PlotTip active={active} payload={payload} label={label} format={format} />
  );
}

// The hover card: the category, then each series with its colour and value.
function PlotTip({
  active,
  payload,
  label,
  format,
}: TipProps & { format: ChartFormat }) {
  if (!active || !payload.length) return null;
  return (
    <div className="ds-chart-tip">
      {label !== undefined && <strong>{label}</strong>}
      {payload.map((entry) => (
        <span key={`${entry.dataKey}-${entry.name}`}>
          <i style={{ background: entry.color ?? entry.payload?.fill }} />
          {entry.name}
          <b>{format(Number(entry.value))}</b>
        </span>
      ))}
    </div>
  );
}

function entryMotionAllowed(): boolean {
  return window.matchMedia(ENTRY_MOTION_QUERY).matches;
}
