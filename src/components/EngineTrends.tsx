/**
 * Responsibility: An aircraft's engine trends window: importing JPI and Garmin
 *   engine logs, and the trend chart and table with their limit flags.
 * Layer: UI. React components; parsing and limits live in src/domain.
 * Dependencies: react, src/data/store.ts, src/domain/model.ts,
 *   src/domain/engineTrends.ts, ./ui.tsx, ./engineTrends.css.
 */
import "./engineTrends.css";
import { useCallback, useEffect, useId, useState } from "react";
import { useWorkspace } from "../data/store";
import { can } from "../domain/model";
import {
  CHT_SPREAD_LIMIT_F,
  ENGINE_FILE_MAX_MEGABYTES,
  defaultEngineLimits,
  engineFlags,
  engineSeries,
  parseEngineLog,
  type EngineLimits,
  type EngineSeries,
  type EngineSummary,
  type EngineTrendCommand,
  type EngineTrend,
  type EngineTrendData,
} from "../domain/engineTrends";
import { AsyncForm, Badge, Empty, Field, Modal, errorText, value } from "./ui";

const SOURCE_LABELS: Record<EngineSummary["source"], string> = {
  jpi: "JPI EDM",
  garmin: "Garmin G1000/G3X",
};
const TRENDS_FAILED = "Engine trends could not be loaded.";
const SECONDS_PER_HOUR = 3600;
const BYTES_PER_MEGABYTE = 1024 * 1024;
// The limit fields, with the bounds engineLimitsSchema sets.
const LIMIT_FIELDS = [
  {
    name: "cht",
    key: "chtMaxF",
    label: "CHT limit (°F)",
    hint: `Default ${defaultEngineLimits.chtMaxF} °F.`,
    range: { min: 200, max: 700 },
  },
  {
    name: "oil",
    key: "oilPressureMinPsi",
    label: "Minimum cruise oil pressure (psi)",
    range: { min: 0, max: 200 },
  },
] as const;
// The chart's SVG box. The margins hold the labels: value labels sit labelGap
// left of the axis and labelDrop below their value; date labels sit labelGap
// above the bottom edge.
const CHART = {
  width: 320,
  height: 150,
  left: 44,
  right: 10,
  top: 10,
  bottom: 24,
  labelGap: 6,
  labelDrop: 4,
};
const PLOT_WIDTH = CHART.width - CHART.left - CHART.right;
const PLOT_HEIGHT = CHART.height - CHART.top - CHART.bottom;
const PLOT_RIGHT = CHART.width - CHART.right;
const PLOT_BOTTOM = CHART.top + PLOT_HEIGHT;
const POINT_RADIUS = 2.5;
const FLAGGED_POINT_RADIUS = 4;

type Remove = (uuid: string) => Promise<unknown>;
type TableToggle = { id: string; shown: boolean; onToggle: () => void };
type ChartScale = ReturnType<typeof chartScale>;
type Column = ReturnType<typeof tableColumns>[number];
type TableTrend = EngineSummary & { uuid?: string };
type OnPreview = (summary?: EngineSummary) => void;
type OnSave = (summary: EngineSummary) => Promise<void>;
type View = {
  data: EngineTrendData;
  run: (command: EngineTrendCommand) => Promise<void>;
  writable: boolean;
  maintenance: boolean;
  preview?: EngineSummary;
  onPreview: OnPreview;
  table: TableToggle;
};
type TableProps = {
  trends: TableTrend[];
  series: EngineSeries[];
  limits: EngineLimits;
  onRemove?: Remove;
};

/**
 * An aircraft's Engine trends button. Its window shows the engine-monitor
 * imports: flags against the aircraft's limits, a chart per measured
 * quantity, and a data table. With maintenance access a user imports a log
 * after previewing its summary, removes imports and sets the limits. Trends
 * load and change only while connected.
 */
export function AircraftEngineTrends({
  aircraftUuid,
  registration,
}: {
  aircraftUuid: string;
  registration: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="button" onClick={() => setOpen(true)}>
        Engine trends
      </button>
      {open && (
        <Modal
          wide
          title={`Engine trends · ${registration}`}
          onClose={() => setOpen(false)}
        >
          <EngineTrendsPanel aircraftUuid={aircraftUuid} />
        </Modal>
      )}
    </>
  );
}

function EngineTrendsPanel({ aircraftUuid }: { aircraftUuid: string }) {
  const { snapshot: s, backend, online, connected } = useWorkspace();
  const writable = online && connected;
  const maintenance = can(s!, aircraftUuid, "maintenance");
  const { data, loadError, load } = useEngineTrends(aircraftUuid, writable);
  const [preview, setPreview] = useState<EngineSummary>();
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();
  if (!writable && !data)
    return (
      <p className="notice">Reconnect to view and import engine trends.</p>
    );
  if (loadError)
    return (
      <p role="alert" className="error">
        {loadError}
      </p>
    );
  if (!data) return <p role="status">Loading engine trends…</p>;
  const run = (command: EngineTrendCommand) =>
    backend!.engineTrend(aircraftUuid, command).then(load);
  const table = {
    id: tableId,
    shown: showTable,
    onToggle: () => setShowTable((v) => !v),
  };
  const view = { data, run, writable, maintenance, table };
  return <TrendsView view={{ ...view, preview, onPreview: setPreview }} />;
}

// A failed load replaces the window's content with its message.
function useEngineTrends(aircraftUuid: string, writable: boolean) {
  const { backend } = useWorkspace();
  const [data, setData] = useState<EngineTrendData>();
  const [loadError, setLoadError] = useState("");
  const load = useCallback(async () => {
    try {
      setData(await backend!.engineTrends(aircraftUuid));
      setLoadError("");
    } catch (e) {
      setLoadError(errorText(e, TRENDS_FAILED));
    }
  }, [backend, aircraftUuid]);
  useEffect(() => {
    if (writable) void load();
  }, [load, writable]);
  return { data, loadError, load };
}

function TrendsView({ view: v }: { view: View }) {
  const trends = [...v.data.trends].sort(chronological);
  const { limits } = v.data;
  const save = async (summary: EngineSummary) => {
    await v.run({ action: "import", uuid: crypto.randomUUID(), summary });
    v.onPreview(undefined);
  };
  const remove = (uuid: string) => v.run({ action: "remove", uuid });
  return (
    <>
      <TrendsIntro limits={limits} />
      {v.maintenance && (
        <EngineImport
          disabled={!v.writable}
          preview={v.preview}
          limits={limits}
          onPreview={v.onPreview}
          onSave={save}
        />
      )}
      <FlaggedImports trends={trends} limits={limits} />
      <TrendsData
        trends={trends}
        limits={limits}
        table={v.table}
        onRemove={v.maintenance && v.writable ? remove : undefined}
      />
      {v.maintenance && (
        <LimitsForm
          limits={limits}
          disabled={!v.writable}
          onSave={(next) => v.run({ action: "limits", limits: next })}
        />
      )}
    </>
  );
}

function chronological(a: EngineTrend, b: EngineTrend) {
  return (a.start ?? a.date).localeCompare(b.start ?? b.date);
}

function duration(seconds?: number) {
  return seconds === undefined
    ? "—"
    : `${(seconds / SECONDS_PER_HOUR).toFixed(1)} h`;
}

// The series with at least one value among the trends.
function seriesWithData(trends: EngineSummary[]) {
  return engineSeries.filter((se) =>
    trends.some((t) => se.lines.some((l) => l.value(t) !== undefined)),
  );
}

function TrendsIntro({ limits }: { limits: EngineLimits }) {
  return (
    <p className="muted">
      One summary per imported JPI EDM or Garmin G1000/G3X CSV log. Raw samples
      are not stored. Flags: hottest CHT above {limits.chtMaxF} °F, CHT spread
      above {CHT_SPREAD_LIMIT_F} °F, or cruise oil pressure below{" "}
      {limits.oilPressureMinPsi} psi.
    </p>
  );
}

function FlaggedImports({
  trends,
  limits,
}: {
  trends: EngineTrend[];
  limits: EngineLimits;
}) {
  const flagged = trends
    .map((t) => ({ t, flags: engineFlags(t, limits) }))
    .filter((f) => f.flags.length);
  return (
    <>
      <h3>Flagged imports</h3>
      {flagged.length ? (
        <ul className="engine-flags">
          {flagged.map(({ t, flags }) => (
            <li key={t.uuid}>
              <strong>
                {t.date} · {t.fileName}
              </strong>
              : {flags.join(" ")}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No imports exceed the limits.</p>
      )}
    </>
  );
}

function TrendsData({
  table,
  ...data
}: Omit<TableProps, "series"> & {
  trends: EngineTrend[];
  table: TableToggle;
}) {
  if (!data.trends.length)
    return (
      <Empty title="No engine data imported">
        Import an engine monitor CSV to start trend monitoring.
      </Empty>
    );
  const series = seriesWithData(data.trends);
  return (
    <>
      <div className="engine-chart-grid">
        {series.map((se) => (
          <TrendChart
            key={se.key}
            series={se}
            trends={data.trends}
            limits={data.limits}
          />
        ))}
      </div>
      <DataTable table={table} {...data} series={series} />
    </>
  );
}

function DataTable({ table, ...data }: TableProps & { table: TableToggle }) {
  return (
    <>
      <button
        type="button"
        className="button"
        aria-expanded={table.shown}
        aria-controls={table.id}
        onClick={table.onToggle}
      >
        {table.shown ? "Hide data table" : "Show data table"}
      </button>
      {table.shown && (
        <div className="table-wrap" id={table.id}>
          <TrendTable {...data} />
        </div>
      )}
    </>
  );
}

function LimitsForm({
  limits,
  disabled,
  onSave,
}: {
  limits: EngineLimits;
  disabled: boolean;
  onSave: (limits: EngineLimits) => Promise<void>;
}) {
  return (
    <>
      <h3>Limits for this aircraft</h3>
      <AsyncForm
        key={`${limits.chtMaxF}:${limits.oilPressureMinPsi}`}
        submitLabel="Save limits"
        disabled={disabled}
        onSubmit={(d) =>
          onSave({
            chtMaxF: Number(value(d, "cht")),
            oilPressureMinPsi: Number(value(d, "oil")),
          })
        }
      >
        <LimitFields limits={limits} />
      </AsyncForm>
    </>
  );
}

function EngineImport({
  disabled,
  preview,
  limits,
  onPreview,
  onSave,
}: {
  disabled: boolean;
  preview?: EngineSummary;
  limits: EngineLimits;
  onPreview: OnPreview;
  onSave: OnSave;
}) {
  return (
    <>
      <LogForm disabled={disabled} onPreview={onPreview} />
      {preview && (
        <PreviewSummary
          preview={preview}
          limits={limits}
          disabled={disabled}
          onSave={onSave}
        />
      )}
    </>
  );
}

function LimitFields({ limits }: { limits: EngineLimits }) {
  return (
    <div className="form-grid">
      {LIMIT_FIELDS.map((f) => (
        <Field
          key={f.name}
          label={f.label}
          hint={"hint" in f ? f.hint : undefined}
        >
          <input
            name={f.name}
            type="number"
            {...f.range}
            step="any"
            required
            defaultValue={limits[f.key]}
          />
        </Field>
      ))}
    </div>
  );
}

// Choosing another file drops the preview until it is read.
function LogForm({
  disabled,
  onPreview,
}: {
  disabled: boolean;
  onPreview: OnPreview;
}) {
  return (
    <AsyncForm
      submitLabel="Preview summary"
      disabled={disabled}
      onChange={() => onPreview(undefined)}
      onSubmit={async (d) => {
        onPreview(undefined);
        onPreview(await readEngineLog(d));
      }}
    >
      <Field
        label="Engine monitor CSV"
        hint="JPI EDM CSV export, or a Garmin G1000/G3X data log from the SD card."
      >
        <input name="engineLog" type="file" accept=".csv,text/csv" required />
      </Field>
    </AsyncForm>
  );
}

async function readEngineLog(d: FormData) {
  const file = d.get("engineLog");
  const maxBytes = ENGINE_FILE_MAX_MEGABYTES * BYTES_PER_MEGABYTE;
  if (!(file instanceof File) || !file.size || file.size > maxBytes)
    throw new Error(
      `Choose an engine monitor CSV up to ${ENGINE_FILE_MAX_MEGABYTES} MB.`,
    );
  // Garmin logs may hold Latin-1 degree signs; decode leniently.
  const text = new TextDecoder().decode(await file.arrayBuffer());
  return parseEngineLog(text, file.name);
}

function PreviewSummary({
  preview,
  limits,
  disabled,
  onSave,
}: {
  preview: EngineSummary;
  limits: EngineLimits;
  disabled: boolean;
  onSave: OnSave;
}) {
  return (
    <AsyncForm
      submitLabel="Save engine summary"
      disabled={disabled}
      onSubmit={() => onSave(preview)}
    >
      <p role="status">
        <strong>{preview.fileName}</strong>: {SOURCE_LABELS[preview.source]}{" "}
        log, {preview.date}, {duration(preview.durationSeconds)},{" "}
        {preview.samples} engine-running samples.
      </p>
      {engineFlags(preview, limits).map((f) => (
        <p key={f}>
          <Badge tone="danger">Flag</Badge> {f}
        </p>
      ))}
      <div className="table-wrap">
        <TrendTable
          trends={[preview]}
          series={seriesWithData([preview])}
          limits={limits}
        />
      </div>
    </AsyncForm>
  );
}

function TrendTable({ trends, series, limits, onRemove }: TableProps) {
  const [error, setError] = useState("");
  const columns = tableColumns(series);
  // A failed removal shows above the table; the import stays listed.
  const remove = onRemove
    ? (uuid: string) =>
        onRemove(uuid).catch((e) => setError(errorText(e, TRENDS_FAILED)))
    : undefined;
  return (
    <>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <table>
        <caption className="sr-only">Engine trend summaries</caption>
        <TrendHead columns={columns} actions={!!onRemove} />
        <tbody>
          {trends.map((t) => (
            <TrendRow
              key={t.uuid ?? t.fileName}
              trend={t}
              columns={columns}
              limits={limits}
              onRemove={remove}
            />
          ))}
        </tbody>
      </table>
    </>
  );
}

// One column per series line, labelled with the series and its unit.
function tableColumns(series: EngineSeries[]) {
  return series.flatMap((se) =>
    se.lines.map((l) => ({
      label: `${se.label} ${l.name.toLowerCase()} (${se.unit})`,
      value: l.value,
    })),
  );
}

function TrendHead({
  columns,
  actions,
}: {
  columns: Column[];
  actions: boolean;
}) {
  return (
    <thead>
      <tr>
        <th scope="col">Date</th>
        <th scope="col">File</th>
        <th scope="col">Duration</th>
        {columns.map((c) => (
          <th scope="col" key={c.label}>
            {c.label}
          </th>
        ))}
        <th scope="col">Flags</th>
        {actions && (
          <th scope="col">
            <span className="sr-only">Actions</span>
          </th>
        )}
      </tr>
    </thead>
  );
}

function TrendRow({
  trend: t,
  columns,
  limits,
  onRemove,
}: {
  trend: TableTrend;
  columns: Column[];
  limits: EngineLimits;
  onRemove?: Remove;
}) {
  return (
    <tr>
      <td>{t.start?.replace("T", " ") ?? t.date}</td>
      <td>{t.fileName}</td>
      <td>{duration(t.durationSeconds)}</td>
      {columns.map((c) => (
        <td key={c.label}>{c.value(t) ?? "—"}</td>
      ))}
      <td>{engineFlags(t, limits).join(" ") || "None"}</td>
      {onRemove && t.uuid && (
        <td>
          <button
            type="button"
            className="button"
            onClick={() => onRemove(t.uuid!)}
          >
            Remove
          </button>
        </td>
      )}
    </tr>
  );
}

function TrendChart({
  series,
  trends,
  limits,
}: {
  series: EngineSeries;
  trends: EngineTrend[];
  limits: EngineLimits;
}) {
  const captionId = useId();
  const scale = chartScale(series, trends, limits);
  return (
    <figure className="engine-chart">
      <figcaption id={captionId}>
        {series.label} ({series.unit})
      </figcaption>
      <svg
        viewBox={`0 0 ${CHART.width} ${CHART.height}`}
        role="img"
        aria-labelledby={captionId}
        aria-describedby={captionId + "-desc"}
      >
        <desc id={captionId + "-desc"}>
          {chartSummary(series, trends, scale)}
        </desc>
        <ChartAxes scale={scale} trends={trends} />
        <ChartLines scale={scale} />
      </svg>
      <ChartLegend series={series} limit={scale.limit} />
    </figure>
  );
}

// Values and the limit share one vertical scale, so the limit line is always
// in view; a single import sits mid-width.
function chartScale(
  series: EngineSeries,
  trends: EngineTrend[],
  limits: EngineLimits,
) {
  const limit = series.limit?.(limits);
  const lines = series.lines.map((l) =>
    trends.flatMap((t, i) => {
      const v = l.value(t);
      return v === undefined
        ? []
        : [{ i, v, flagged: !!engineFlags(t, limits).length }];
    }),
  );
  const values = [
    ...lines.flat().map((p) => p.v),
    ...(limit === undefined ? [] : [limit]),
  ];
  const lo = Math.min(...values),
    hi = Math.max(...values);
  const span = hi - lo || 1;
  const steps = trends.length - 1;
  const x = (i: number) =>
    CHART.left + (steps > 0 ? (i * PLOT_WIDTH) / steps : PLOT_WIDTH / 2);
  const y = (v: number) => CHART.top + ((hi - v) / span) * PLOT_HEIGHT;
  return { limit, lines, lo, hi, x, y };
}

// The chart's text alternative: range, latest first-line value and limit.
function chartSummary(
  series: EngineSeries,
  trends: EngineTrend[],
  { lines, limit }: ChartScale,
) {
  const latest = lines[0].at(-1);
  const name = series.lines[0].name.toLowerCase();
  return [
    `${series.label} across ${lines[0].length} imports from ${trends[0].date} to ${trends.at(-1)!.date}.`,
    latest ? ` Latest ${name}: ${latest.v} ${series.unit}.` : "",
    limit === undefined ? "" : ` Limit ${limit} ${series.unit}.`,
  ].join("");
}

function ChartAxes({
  scale: { lo, hi, y },
  trends,
}: {
  scale: ChartScale;
  trends: EngineTrend[];
}) {
  const labelX = CHART.left - CHART.labelGap;
  return (
    <>
      <line
        className="engine-axis"
        x1={CHART.left}
        x2={CHART.left}
        y1={CHART.top}
        y2={PLOT_BOTTOM}
      />
      <line
        className="engine-axis"
        x1={CHART.left}
        x2={PLOT_RIGHT}
        y1={PLOT_BOTTOM}
        y2={PLOT_BOTTOM}
      />
      <text x={labelX} y={y(hi) + CHART.labelDrop} textAnchor="end">
        {Math.round(hi)}
      </text>
      <text x={labelX} y={y(lo) + CHART.labelDrop} textAnchor="end">
        {Math.round(lo)}
      </text>
      <DateLabels trends={trends} />
    </>
  );
}

function DateLabels({ trends }: { trends: EngineTrend[] }) {
  const dateY = CHART.height - CHART.labelGap;
  return (
    <>
      <text x={CHART.left} y={dateY}>
        {trends[0].date}
      </text>
      {trends.length > 1 && (
        <text x={PLOT_RIGHT} y={dateY} textAnchor="end">
          {trends.at(-1)!.date}
        </text>
      )}
    </>
  );
}

// Only the first line marks flagged imports, so the points do not repeat.
function ChartLines({ scale: { limit, lines, x, y } }: { scale: ChartScale }) {
  const plotted = lines.map((points, n) => (
    <g key={n}>
      <polyline
        className={`engine-line engine-line-${n}`}
        points={points.map((p) => `${x(p.i)},${y(p.v)}`).join(" ")}
      />
      {points.map((p) => {
        const flagged = p.flagged && n === 0;
        return (
          <circle
            key={p.i}
            cx={x(p.i)}
            cy={y(p.v)}
            r={flagged ? FLAGGED_POINT_RADIUS : POINT_RADIUS}
            className={flagged ? "engine-point-flag" : `engine-point-${n}`}
          />
        );
      })}
    </g>
  ));
  if (limit === undefined) return plotted;
  return (
    <>
      <line
        className="engine-limit"
        x1={CHART.left}
        x2={PLOT_RIGHT}
        y1={y(limit)}
        y2={y(limit)}
      />
      {plotted}
    </>
  );
}

function ChartLegend({
  series,
  limit,
}: {
  series: EngineSeries;
  limit?: number;
}) {
  return (
    <ul className="engine-legend" aria-hidden="true">
      {series.lines.map((l, n) => (
        <li key={l.name}>
          <span className={`engine-legend-${n}`} />
          {l.name}
        </li>
      ))}
      {limit !== undefined && (
        <li>
          <span className="engine-legend-limit" />
          Limit
        </li>
      )}
    </ul>
  );
}
