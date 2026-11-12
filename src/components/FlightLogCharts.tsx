/**
 * Responsibility: The flight log's two weekly charts: Hobbs hours flown and
 *   flights, for the flights the log's filters list.
 * Layer: UI. Presentation over the flights it is given; no business rules.
 * Dependencies: src/domain/flightLog.ts (weekly figures), src/domain/model.ts
 *   (types), ./charts, ./design.
 */
import { weeklyFlightActivity } from "../domain/flightLog";
import type { Flight } from "../domain/model";
import { BarChart, type ChartSeries } from "./charts";
import { SectionHeading } from "./design";

const CHART_HEIGHT = 150;
const WEEK_LABEL = "Week starting";
const HOURS_SERIES: ChartSeries[] = [{ key: "hours", label: "Hobbs hours" }];
const FLIGHTS_SERIES: ChartSeries[] = [
  { key: "flights", label: "Flights", tone: "3" },
];
const hoursText = (hours: number) => `${hours.toFixed(1)} h`;

/**
 * Hobbs hours and flights per week over the twelve weeks up to the newest
 * listed flight, side by side.
 *
 * @param props.flights - Every flight matching the log's filters, not only
 *   the page shown.
 * @returns Two bar charts, each with its hidden data table, or nothing when
 *   no flight is listed.
 */
export function FlightLogCharts({ flights }: { flights: readonly Flight[] }) {
  const weeks = weeklyFlightActivity(flights);
  if (!weeks.length) return null;
  const total = weeks.reduce((sum, week) => sum + week.hours, 0);
  const count = weeks.reduce((sum, week) => sum + week.flights, 0);
  const rows = weeks.map(({ label, hours, flights }) => ({
    label,
    values: { hours, flights },
  }));
  return (
    <section
      className="rec-charts rise"
      aria-label="Flights in this view by week"
    >
      <div className="ds-card">
        <SectionHeading
          title="Hours flown"
          note={`${hoursText(total)} on the Hobbs meter over ${weeks.length} weeks`}
        />
        <BarChart
          label="Hobbs hours flown per week"
          categoryLabel={WEEK_LABEL}
          rows={rows}
          series={HOURS_SERIES}
          format={hoursText}
          height={CHART_HEIGHT}
        />
      </div>
      <div className="ds-card">
        <SectionHeading
          title="Flights"
          note={`${count} over ${weeks.length} weeks`}
        />
        <BarChart
          label="Flights per week"
          categoryLabel={WEEK_LABEL}
          rows={rows}
          series={FLIGHTS_SERIES}
          wholeNumbers
          height={CHART_HEIGHT}
        />
      </div>
    </section>
  );
}
