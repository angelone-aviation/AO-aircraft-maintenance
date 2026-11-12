/**
 * Responsibility: The Costs page's charts: an aircraft's spending by month
 *   and its split between labor, parts and other costs.
 * Layer: UI. Presentational components; cost rules live in src/domain.
 * Dependencies: src/domain (model, costs, shopCharts), ./charts, ./design.
 */
import type { Snapshot } from "../domain/model";
import { formatCents, type AircraftCostReport } from "../domain/costs";
import { monthlyCosts, type MonthCosts } from "../domain/shopCharts";
import { BarChart, Donut } from "./charts";
import { SectionHeading } from "./design";

const CENTS_PER_DOLLAR = 100;
const SERIES = [
  { key: "labor", label: "Labor" },
  { key: "parts", label: "Parts" },
  { key: "other", label: "Other", tone: "4" },
] as const;

/**
 * Charts of a cost report: stacked bars of labor, parts and other costs for
 * each month of the period, and a ring of the three totals.
 *
 * @param props.s - The snapshot the report was built from.
 * @returns Nothing when the report has no costs. The month chart is left out
 *   for a period longer than 24 months and hidden on phones, where the
 *   totals above and the ring carry the same amounts.
 */
export function CostCharts({
  s,
  report,
}: {
  s: Snapshot;
  report: AircraftCostReport;
}) {
  if (!report.totalCents) return null;
  const months = monthlyCosts(s, report);
  return (
    <div className={months.length ? "shop-chart-row" : undefined}>
      {months.length > 0 && <MonthChart months={months} />}
      <section className="ds-card shop-chart-card">
        <SectionHeading
          title="By category"
          note={`${formatCents(report.totalCents)} in total`}
        />
        <Donut
          label="Costs by category"
          format={formatDollars}
          slices={[
            { label: "Labor", value: dollars(report.laborCents) },
            { label: "Parts", value: dollars(report.partsCents) },
            { label: "Other", value: dollars(report.otherCents), tone: "4" },
          ]}
        />
      </section>
    </div>
  );
}

function MonthChart({ months }: { months: MonthCosts[] }) {
  return (
    <section className="ds-card shop-chart-card shop-hide-phone">
      <SectionHeading title="Spending by month" />
      <BarChart
        label="Costs by month"
        categoryLabel="Month"
        stacked
        format={formatDollars}
        series={[...SERIES]}
        rows={months.map((m) => ({
          label: monthLabel(m.month, months),
          values: {
            labor: dollars(m.laborCents),
            parts: dollars(m.partsCents),
            other: dollars(m.otherCents),
          },
        }))}
      />
    </section>
  );
}

const dollars = (cents: number) => cents / CENTS_PER_DOLLAR;

// Whole amounts drop their cents ("$600"), which keeps axis labels short.
function formatDollars(amount: number): string {
  const text = formatCents(Math.round(amount * CENTS_PER_DOLLAR));
  return text.endsWith(".00") ? text.slice(0, -".00".length) : text;
}

// "Mar", or "Mar 26" when the chart crosses a year end.
function monthLabel(month: string, all: MonthCosts[]): string {
  const [year, number] = month.split("-").map(Number);
  const name = new Date(Date.UTC(year, number - 1, 1)).toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  const oneYear = all[0].month.slice(0, 4) === all.at(-1)!.month.slice(0, 4);
  return oneYear ? name : `${name} ${String(year).slice(2)}`;
}
