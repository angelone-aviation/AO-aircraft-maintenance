/**
 * Responsibility: The shared charts screens use: bar, line, sparkline and
 *   donut charts, and the plain-CSS meter and stacked bar, each with a text
 *   alternative.
 * Layer: UI. Presentational React components; no workspace data. Screens
 *   import charts from here and never from recharts.
 * Dependencies: react, ./chartData.ts, ./chartsPlot.tsx (loaded on demand),
 *   src/styles/charts.css.
 *
 * The plots load in their own chunk the first time a chart is shown. The
 * frame, legend and data table render at once, so a chart reserves its space
 * and is readable by screen readers before, and without, the plot.
 */
import {
  Component,
  Suspense,
  lazy,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  chartColor,
  chartTable,
  meterPercent,
  plotRows,
  shares,
  trendSummary,
  type ChartFormat,
  type ChartRow,
  type ChartSeries,
  type ChartSlice,
  type ChartTone,
} from "./chartData";
import "../styles/charts.css";

export type { ChartFormat, ChartRow, ChartSeries, ChartSlice, ChartTone };

const BarPlot = lazy(() =>
  import("./chartsPlot").then((m) => ({ default: m.BarPlot })),
);
const LinePlot = lazy(() =>
  import("./chartsPlot").then((m) => ({ default: m.LinePlot })),
);
const DonutPlot = lazy(() =>
  import("./chartsPlot").then((m) => ({ default: m.DonutPlot })),
);

const CHART_HEIGHT = 220;
const SPARK_HEIGHT = 36;
const DONUT_SIZE = 148;
const SPARK_SERIES: ChartSeries[] = [{ key: "value", label: "Value" }];
const plain: ChartFormat = (value) => value.toLocaleString("en-US");

/** What every axis chart takes. */
export type AxisChartProps = {
  /** Names the chart for screen readers and captions its data table. */
  label: string;
  /** Categories along the bottom, in order. */
  rows: readonly ChartRow[];
  /** What is measured; two or more show a legend. */
  series: readonly ChartSeries[];
  /** Heads the category column of the data table, such as "Month". */
  categoryLabel: string;
  /** Formats axis ticks, tooltips and the data table; plain numbers if left out. */
  format?: ChartFormat;
  /** The plot's height in CSS pixels; defaults to 220. */
  height?: number;
  /** Keeps axis ticks to whole numbers; set it when the values are counts. */
  wholeNumbers?: boolean;
  /** Hides the whole chart below 760px, for a chart a phone has no room for. */
  hideOnPhone?: boolean;
  className?: string;
};

/**
 * A vertical bar chart, one group of bars per row.
 *
 * @param props.stacked - Stacks the series in each row instead of placing
 *   them side by side.
 * @returns A figure named by `label`. Its data is also a visually hidden
 *   table, which is shown in place of the plot if the plot cannot load.
 */
export function BarChart({
  stacked = false,
  ...props
}: AxisChartProps & { stacked?: boolean }) {
  const format = props.format ?? plain;
  return (
    <AxisChart {...props} format={format}>
      <BarPlot
        rows={plotRows(props.rows, props.series)}
        series={props.series}
        format={format}
        wholeNumbers={props.wholeNumbers}
        stacked={stacked}
      />
    </AxisChart>
  );
}

/**
 * A line chart, one smooth line per series.
 *
 * @returns A figure named by `label`, with the same hidden data table and
 *   fallback as {@link BarChart}.
 */
export function LineChart(props: AxisChartProps) {
  const format = props.format ?? plain;
  return (
    <AxisChart {...props} format={format}>
      <LinePlot
        rows={plotRows(props.rows, props.series)}
        series={props.series}
        format={format}
        wholeNumbers={props.wholeNumbers}
        bare={false}
      />
    </AxisChart>
  );
}

/**
 * A small trend line with no axes, for a card or a table cell.
 *
 * @param props.label - What is trending, such as "Hours flown, last 12
 *   weeks".
 * @param props.values - The points, oldest first.
 * @returns An image named "<label>. Latest L; low A, high B over N points."
 */
export function Sparkline({
  label,
  values,
  format = plain,
  tone,
  height = SPARK_HEIGHT,
  className,
}: {
  label: string;
  values: readonly number[];
  format?: ChartFormat;
  tone?: ChartTone;
  height?: number;
  className?: string;
}) {
  const rows = values.map((value, i) => ({
    label: String(i),
    values: { value },
  }));
  const series = tone ? [{ ...SPARK_SERIES[0], tone }] : SPARK_SERIES;
  return (
    <span
      className={cx("ds-spark", className)}
      style={{ height }}
      role="img"
      aria-label={`${label}. ${trendSummary(values, format)}`}
    >
      <PlotBoundary fallback={null}>
        <Suspense fallback={null}>
          <LinePlot
            rows={plotRows(rows, series)}
            series={series}
            format={format}
            bare
          />
        </Suspense>
      </PlotBoundary>
    </span>
  );
}

/**
 * A ring showing parts of a whole, beside a legend that lists every part
 * with its value and share.
 *
 * @param props.slices - Drawn clockwise from the top in this order.
 * @param props.center - Shown inside the ring, such as the total.
 * @returns A figure named by `label`; the legend is its text alternative.
 */
export function Donut({
  label,
  slices,
  center,
  format = plain,
  hideOnPhone = false,
  className,
}: {
  label: string;
  slices: readonly ChartSlice[];
  center?: ReactNode;
  format?: ChartFormat;
  hideOnPhone?: boolean;
  className?: string;
}) {
  return (
    <figure
      className={cx(
        "ds-chart ds-donut",
        hideOnPhone && "hide-phone",
        className,
      )}
      aria-label={label}
    >
      <div
        className="ds-donut-ring"
        style={{ width: DONUT_SIZE, height: DONUT_SIZE }}
      >
        <PlotBoundary fallback={null}>
          <Suspense fallback={<span className="ds-chart-loading round" />}>
            <div className="ds-chart-plot" aria-hidden="true">
              <DonutPlot slices={slices} format={format} />
            </div>
          </Suspense>
        </PlotBoundary>
        {center && <div className="ds-donut-center">{center}</div>}
      </div>
      <SliceLegend slices={slices} format={format} />
    </figure>
  );
}

/**
 * A labelled horizontal meter: how much of a limit is used or left.
 *
 * @param props.value - Out of `max` (default 100); clamped to the track.
 * @param props.valueText - The amount as the screen words it, such as
 *   "8.8 h remaining"; shown at the right and read as the meter's value.
 * @param props.tone - "warn" and "danger" only when the amount is a status;
 *   the words must say so too.
 * @param props.note - A light line under the track, such as "Due at 2,350.0 h".
 */
export function Meter({
  label,
  value,
  max = 100,
  valueText,
  tone = "blue",
  note,
  className,
}: {
  label: string;
  value: number;
  max?: number;
  valueText: string;
  tone?: "blue" | "good" | "warn" | "danger";
  note?: ReactNode;
  className?: string;
}) {
  const percent = meterPercent(value, max);
  return (
    <div className={cx("ds-meter", "ds-meter-" + tone, className)}>
      <div className="ds-meter-head">
        <span>{label}</span>
        <b>{valueText}</b>
      </div>
      <div
        className="ds-meter-track"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={valueText}
      >
        <i style={{ width: percent + "%" }} />
      </div>
      {note && <small>{note}</small>}
    </div>
  );
}

/**
 * One horizontal bar split into parts of a whole, over a legend that lists
 * every part with its value and share.
 *
 * @param props.segments - Left to right in this order; parts of zero keep
 *   their legend line.
 * @returns A figure named by `label`; the legend is its text alternative.
 */
export function StackedBar({
  label,
  segments,
  format = plain,
  className,
}: {
  label: string;
  segments: readonly ChartSlice[];
  format?: ChartFormat;
  className?: string;
}) {
  const widths = shares(segments.map((s) => s.value));
  return (
    <figure className={cx("ds-chart ds-stack", className)} aria-label={label}>
      <div className="ds-stack-bar" aria-hidden="true">
        {segments.map((segment, i) => (
          <i
            key={segment.label}
            style={{
              width: widths[i] + "%",
              background: chartColor(segment.tone, i),
            }}
          />
        ))}
      </div>
      <SliceLegend slices={segments} format={format} />
    </figure>
  );
}

const cx = (...names: (string | false | null | undefined)[]) =>
  names.filter(Boolean).join(" ");

type TextTable = ReturnType<typeof chartTable>;

function AxisChart({
  label,
  rows,
  series,
  categoryLabel,
  format,
  height = CHART_HEIGHT,
  hideOnPhone = false,
  className,
  children,
}: AxisChartProps & { format: ChartFormat; children: ReactNode }) {
  const table = chartTable(rows, series, format, categoryLabel);
  return (
    <figure
      className={cx("ds-chart", hideOnPhone && "hide-phone", className)}
      aria-label={label}
    >
      <PlotBoundary fallback={<DataTable caption={label} table={table} />}>
        <div className="ds-chart-plot" style={{ height }} aria-hidden="true">
          <Suspense fallback={<span className="ds-chart-loading" />}>
            {children}
          </Suspense>
        </div>
        {series.length > 1 && <SeriesLegend series={series} />}
        <DataTable caption={label} table={table} hidden />
      </PlotBoundary>
    </figure>
  );
}

function DataTable({
  caption,
  table,
  hidden = false,
}: {
  caption: string;
  table: TextTable;
  hidden?: boolean;
}) {
  return (
    <table className={hidden ? "sr-only" : "ds-chart-table"}>
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          {table.head.map((cell, i) => (
            <th key={i} scope="col">
              {cell}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {table.body.map((line, r) => (
          <tr key={r}>
            {line.map((cell, c) =>
              c === 0 ? (
                <th key={c} scope="row">
                  {cell}
                </th>
              ) : (
                <td key={c}>{cell}</td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// The table already names each series for screen readers.
function SeriesLegend({ series }: { series: readonly ChartSeries[] }) {
  return (
    <ul className="ds-chart-legend" aria-hidden="true">
      {series.map((s, i) => (
        <li key={s.key}>
          <Swatch color={chartColor(s.tone, i)} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

function SliceLegend({
  slices,
  format,
}: {
  slices: readonly ChartSlice[];
  format: ChartFormat;
}) {
  const percents = shares(slices.map((s) => s.value));
  return (
    <ul className="ds-chart-legend values">
      {slices.map((slice, i) => (
        <li key={slice.label}>
          <Swatch color={chartColor(slice.tone, i)} />
          <span>{slice.label}</span>
          <b>{format(slice.value)}</b>
          <small>{percents[i]}%</small>
        </li>
      ))}
    </ul>
  );
}

function Swatch({ color }: { color: string }) {
  return (
    <i
      className="ds-chart-swatch"
      style={{ "--swatch": color } as CSSProperties}
      aria-hidden="true"
    />
  );
}

type BoundaryProps = { fallback: ReactNode; children: ReactNode };

// A plot that cannot load or draw (its chunk is unreachable, or the library
// throws) must not take the screen down with it: the chart's data is still
// there as text, so the boundary shows that instead. React reports the
// caught error to the console and to the app's error monitoring.
class PlotBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
