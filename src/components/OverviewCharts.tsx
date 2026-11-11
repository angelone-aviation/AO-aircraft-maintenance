/**
 * Responsibility: The Overview's charts: hours flown per week, fleet
 *   readiness, and one aircraft's hours per month for its detail.
 * Layer: UI. Presentational React components over the workspace snapshot;
 *   the sums come from src/domain/flightHours.ts.
 * Dependencies: react, src/domain (flightHours, aircraftStatus, readings, model),
 *   ./charts, ./design.
 */
import { useMemo } from "react";
import {
  aircraftStatusLabels,
  type ShownAircraftStatus,
  type ShownStatusLevel,
} from "../domain/aircraftStatus";
import { flownByMonth, flownByWeek, flownSeconds } from "../domain/flightHours";
import type { Aircraft, Snapshot } from "../domain/model";
import { SECONDS_PER_HOUR } from "../domain/readings";
import {
  BarChart,
  Donut,
  type ChartRow,
  type ChartSeries,
  type ChartTone,
} from "./charts";
import { SectionHeading } from "./design";

const WEEKS_SHOWN = 8;
const MONTHS_SHOWN = 6;
// One colour per aircraft: the chart palette has five, and more bands than
// that cannot be told apart, so a larger fleet is drawn as one total.
const MAX_STACKED_AIRCRAFT = 5;
const TREND_HEIGHT = 150;
const FLEET_SERIES: ChartSeries[] = [{ key: "fleet", label: "All aircraft" }];
const TREND_SERIES: ChartSeries[] = [{ key: "hours", label: "Hours flown" }];
// Setup incomplete is drawn grey beside the amber of due soon: two amber
// slices side by side would read as one.
const LEVEL_SLICES: readonly [ShownStatusLevel, ChartTone][] = [
  ["airworthy", "good"],
  ["due-soon", "warn"],
  ["setup-incomplete", "4"],
  ["grounded", "danger"],
];

const toHours = (seconds: number) =>
  Math.round((seconds / SECONDS_PER_HOUR) * 10) / 10;
const formatHours = (hours: number) => `${hours.toFixed(1)} h`;

/**
 * Hours flown per week over the last eight weeks, stacked by aircraft for a
 * fleet of up to five that flew, otherwise as one fleet total.
 *
 * @param props.today - The device's date, YYYY-MM-DD.
 * @returns A card with the total and the chart; a sentence instead of the
 *   chart when no accepted flight falls in the eight weeks.
 */
export function HoursFlownChart({ s, today }: { s: Snapshot; today: string }) {
  // Stable rows: a new array on every render would restart the chart's
  // entry animation each time the page re-renders.
  const chart = useMemo(() => weeklyChart(s, today), [s, today]);
  return (
    <section className="ds-card dash-chart">
      <SectionHeading
        title="Hours flown"
        note={`Accepted flights, last ${WEEKS_SHOWN} weeks`}
        end={<b className="dash-chart-total">{formatHours(chart.total)}</b>}
      />
      {chart.total > 0 ? (
        <BarChart
          label={`Hours flown by week, last ${WEEKS_SHOWN} weeks`}
          categoryLabel="Week of"
          rows={chart.rows}
          series={chart.series}
          stacked
          format={formatHours}
        />
      ) : (
        <p className="dash-chart-empty">
          No accepted flights in the last {WEEKS_SHOWN} weeks.
        </p>
      )}
    </section>
  );
}

/**
 * How many aircraft are at each status level, as a donut around the number
 * that are OK to fly (every level but Grounded).
 *
 * @param props.statuses - Each aircraft's status as shown on its card.
 * @returns A card; levels with no aircraft are left out of the donut.
 */
export function FleetReadinessChart({
  statuses,
}: {
  statuses: readonly ShownAircraftStatus[];
}) {
  const slices = useMemo(() => levelSlices(statuses), [statuses]);
  const grounded = statuses.filter((s) => s.level === "grounded").length;
  return (
    <section className="ds-card dash-chart dash-chart-readiness">
      <SectionHeading title="Fleet readiness" note="By recorded status" />
      <Donut
        label="Fleet readiness: aircraft by status"
        slices={slices}
        center={
          <>
            {statuses.length - grounded}
            <small>of {statuses.length} OK to fly</small>
          </>
        }
      />
    </section>
  );
}

/**
 * One aircraft's hours flown per calendar month over the last six months.
 *
 * @param props.today - The device's date, YYYY-MM-DD.
 * @returns The chart, or a sentence when no accepted flight falls in the six
 *   months.
 */
export function AircraftHoursTrend({
  aircraft,
  s,
  today,
}: {
  aircraft: Aircraft;
  s: Snapshot;
  today: string;
}) {
  const rows = useMemo(
    () =>
      flownByMonth(s, today, MONTHS_SHOWN).map((month) => ({
        label: monthLabel(month.start),
        values: { hours: toHours(flownSeconds(month, aircraft.uuid)) },
      })),
    [s, today, aircraft.uuid],
  );
  if (rows.every((row) => row.values.hours === 0))
    return (
      <p className="dash-chart-empty">
        No accepted flights in the last {MONTHS_SHOWN} months.
      </p>
    );
  return (
    <BarChart
      label={`${aircraft.registration} hours flown by month, last ${MONTHS_SHOWN} months`}
      categoryLabel="Month"
      rows={rows}
      series={TREND_SERIES}
      format={formatHours}
      height={TREND_HEIGHT}
    />
  );
}

function weeklyChart(s: Snapshot, today: string) {
  const weeks = flownByWeek(s, today, WEEKS_SHOWN);
  const flew = s.aircraft.filter((a) =>
    weeks.some((week) => flownSeconds(week, a.uuid) > 0),
  );
  const stacked = flew.length <= MAX_STACKED_AIRCRAFT;
  const series = stacked
    ? flew.map((a) => ({ key: a.uuid, label: a.registration }))
    : FLEET_SERIES;
  const rows: ChartRow[] = weeks.map((week) => ({
    label: dayLabel(week.start),
    values: stacked
      ? Object.fromEntries(
          flew.map((a) => [a.uuid, toHours(flownSeconds(week, a.uuid))]),
        )
      : { fleet: toHours(flownSeconds(week)) },
  }));
  const seconds = weeks.reduce((sum, week) => sum + flownSeconds(week), 0);
  return { rows, series, total: toHours(seconds) };
}

function levelSlices(statuses: readonly ShownAircraftStatus[]) {
  return LEVEL_SLICES.map(([level, tone]) => ({
    label: aircraftStatusLabels[level],
    value: statuses.filter((status) => status.level === level).length,
    tone,
  })).filter((slice) => slice.value > 0);
}

/** "9 Nov" for 2026-11-09. */
const dayLabel = (iso: string) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

/** "Nov" for 2026-11-01. */
const monthLabel = (iso: string) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", {
    month: "short",
    timeZone: "UTC",
  });
