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
  ENGINE_FILE_MAX_MEGABYTES,
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

const sourceLabels: Record<EngineSummary["source"], string> = {
  jpi: "JPI EDM",
  garmin: "Garmin G1000/G3X",
};
const TRENDS_FAILED = "Engine trends could not be loaded.";
const duration = (seconds?: number) =>
  seconds === undefined ? "—" : `${(seconds / 3600).toFixed(1)} h`;
const chronological = (a: EngineTrend, b: EngineTrend) =>
  (a.start ?? a.date).localeCompare(b.start ?? b.date);

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
  const [data, setData] = useState<EngineTrendData>();
  const [loadError, setLoadError] = useState("");
  const [preview, setPreview] = useState<EngineSummary>();
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();
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
  const trends = [...data.trends].sort(chronological);
  const flagged = trends
    .map((t) => ({ t, flags: engineFlags(t, data.limits) }))
    .filter((f) => f.flags.length);
  const series = engineSeries.filter((se) =>
    trends.some((t) => se.lines.some((l) => l.value(t) !== undefined)),
  );
  const run = (command: EngineTrendCommand) =>
    backend!.engineTrend(aircraftUuid, command).then(load);
  return (
    <>
      <p className="muted">
        One summary per imported JPI EDM or Garmin G1000/G3X CSV log. Raw
        samples are not stored. Flags: hottest CHT above {data.limits.chtMaxF}{" "}
        °F, CHT spread above 50 °F, or cruise oil pressure below{" "}
        {data.limits.oilPressureMinPsi} psi.
      </p>
      {maintenance && (
        <EngineImport
          disabled={!writable}
          preview={preview}
          limits={data.limits}
          onPreview={setPreview}
          onSave={async (summary) => {
            await run({ action: "import", uuid: crypto.randomUUID(), summary });
            setPreview(undefined);
          }}
        />
      )}
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
      {trends.length ? (
        <>
          <div className="engine-chart-grid">
            {series.map((se) => (
              <TrendChart
                key={se.key}
                series={se}
                trends={trends}
                limits={data.limits}
              />
            ))}
          </div>
          <button
            type="button"
            className="button"
            aria-expanded={showTable}
            aria-controls={tableId}
            onClick={() => setShowTable((v) => !v)}
          >
            {showTable ? "Hide data table" : "Show data table"}
          </button>
          {showTable && (
            <div className="table-wrap" id={tableId}>
              <TrendTable
                trends={trends}
                series={series}
                limits={data.limits}
                onRemove={
                  maintenance && writable
                    ? (uuid) => run({ action: "remove", uuid })
                    : undefined
                }
              />
            </div>
          )}
        </>
      ) : (
        <Empty title="No engine data imported">
          Import an engine monitor CSV to start trend monitoring.
        </Empty>
      )}
      {maintenance && (
        <>
          <h3>Limits for this aircraft</h3>
          <AsyncForm
            key={`${data.limits.chtMaxF}:${data.limits.oilPressureMinPsi}`}
            submitLabel="Save limits"
            disabled={!writable}
            onSubmit={(d) =>
              run({
                action: "limits",
                limits: {
                  chtMaxF: Number(value(d, "cht")),
                  oilPressureMinPsi: Number(value(d, "oil")),
                },
              })
            }
          >
            <div className="form-grid">
              <Field label="CHT limit (°F)" hint="Default 435 °F.">
                <input
                  name="cht"
                  type="number"
                  min={200}
                  max={700}
                  step="any"
                  required
                  defaultValue={data.limits.chtMaxF}
                />
              </Field>
              <Field label="Minimum cruise oil pressure (psi)">
                <input
                  name="oil"
                  type="number"
                  min={0}
                  max={200}
                  step="any"
                  required
                  defaultValue={data.limits.oilPressureMinPsi}
                />
              </Field>
            </div>
          </AsyncForm>
        </>
      )}
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
  onPreview: (summary?: EngineSummary) => void;
  onSave: (summary: EngineSummary) => Promise<void>;
}) {
  return (
    <>
      <AsyncForm
        submitLabel="Preview summary"
        disabled={disabled}
        onChange={() => onPreview(undefined)}
        onSubmit={async (d) => {
          onPreview(undefined);
          const file = d.get("engineLog");
          if (
            !(file instanceof File) ||
            !file.size ||
            file.size > ENGINE_FILE_MAX_MEGABYTES * 1024 * 1024
          )
            throw new Error(
              `Choose an engine monitor CSV up to ${ENGINE_FILE_MAX_MEGABYTES} MB.`,
            );
          // Garmin logs may hold Latin-1 degree signs; decode leniently.
          const text = new TextDecoder().decode(await file.arrayBuffer());
          onPreview(parseEngineLog(text, file.name));
        }}
      >
        <Field
          label="Engine monitor CSV"
          hint="JPI EDM CSV export, or a Garmin G1000/G3X data log from the SD card."
        >
          <input name="engineLog" type="file" accept=".csv,text/csv" required />
        </Field>
      </AsyncForm>
      {preview && (
        <AsyncForm
          submitLabel="Save engine summary"
          disabled={disabled}
          onSubmit={() => onSave(preview)}
        >
          <p role="status">
            <strong>{preview.fileName}</strong>: {sourceLabels[preview.source]}{" "}
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
              series={engineSeries.filter((se) =>
                se.lines.some((l) => l.value(preview) !== undefined),
              )}
              limits={limits}
            />
          </div>
        </AsyncForm>
      )}
    </>
  );
}

function TrendTable({
  trends,
  series,
  limits,
  onRemove,
}: {
  trends: (EngineSummary & { uuid?: string })[];
  series: EngineSeries[];
  limits: EngineLimits;
  onRemove?: (uuid: string) => Promise<unknown>;
}) {
  const [error, setError] = useState("");
  const columns = series.flatMap((se) =>
    se.lines.map((l) => ({
      label: `${se.label} ${l.name.toLowerCase()} (${se.unit})`,
      value: l.value,
    })),
  );
  return (
    <>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <table>
        <caption className="sr-only">Engine trend summaries</caption>
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
            {onRemove && (
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {trends.map((t) => (
            <tr key={t.uuid ?? t.fileName}>
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
                    onClick={() =>
                      onRemove(t.uuid!).catch((e) =>
                        setError(errorText(e, TRENDS_FAILED)),
                      )
                    }
                  >
                    Remove
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

const CHART = {
  width: 320,
  height: 150,
  left: 44,
  right: 10,
  top: 10,
  bottom: 24,
};
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
  const plotW = CHART.width - CHART.left - CHART.right,
    plotH = CHART.height - CHART.top - CHART.bottom;
  const x = (i: number) =>
    CHART.left +
    (trends.length > 1 ? (i * plotW) / (trends.length - 1) : plotW / 2);
  const y = (v: number) => CHART.top + ((hi - v) / span) * plotH;
  const latest = lines[0].at(-1);
  const summary = `${series.label} across ${lines[0].length} imports from ${trends[0].date} to ${trends.at(-1)!.date}.${latest ? ` Latest ${series.lines[0].name.toLowerCase()}: ${latest.v} ${series.unit}.` : ""}${limit === undefined ? "" : ` Limit ${limit} ${series.unit}.`}`;
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
        <desc id={captionId + "-desc"}>{summary}</desc>
        <line
          className="engine-axis"
          x1={CHART.left}
          x2={CHART.left}
          y1={CHART.top}
          y2={CHART.top + plotH}
        />
        <line
          className="engine-axis"
          x1={CHART.left}
          x2={CHART.width - CHART.right}
          y1={CHART.top + plotH}
          y2={CHART.top + plotH}
        />
        <text x={CHART.left - 6} y={y(hi) + 4} textAnchor="end">
          {Math.round(hi)}
        </text>
        <text x={CHART.left - 6} y={y(lo) + 4} textAnchor="end">
          {Math.round(lo)}
        </text>
        <text x={CHART.left} y={CHART.height - 6}>
          {trends[0].date}
        </text>
        {trends.length > 1 && (
          <text
            x={CHART.width - CHART.right}
            y={CHART.height - 6}
            textAnchor="end"
          >
            {trends.at(-1)!.date}
          </text>
        )}
        {limit !== undefined && (
          <line
            className="engine-limit"
            x1={CHART.left}
            x2={CHART.width - CHART.right}
            y1={y(limit)}
            y2={y(limit)}
          />
        )}
        {lines.map((points, n) => (
          <g key={n}>
            <polyline
              className={`engine-line engine-line-${n}`}
              points={points.map((p) => `${x(p.i)},${y(p.v)}`).join(" ")}
            />
            {points.map((p) => (
              <circle
                key={p.i}
                cx={x(p.i)}
                cy={y(p.v)}
                r={p.flagged && n === 0 ? 4 : 2.5}
                className={
                  p.flagged && n === 0
                    ? "engine-point-flag"
                    : `engine-point-${n}`
                }
              />
            ))}
          </g>
        ))}
      </svg>
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
    </figure>
  );
}
