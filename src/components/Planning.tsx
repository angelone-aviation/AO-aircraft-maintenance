/**
 * Responsibility: The Planning screen: upcoming inspections, component limits
 *   and ADs across the fleet, projected from recent utilization.
 * Layer: UI. Read-only; projections come from src/domain/forecast.ts.
 * Dependencies: react, @phosphor-icons/react, src/data/store.ts, src/domain
 *   (csv, forecast, maintenanceCharts, model, programs), ./ui, ./design,
 *   ./charts, ./OpsList, ./planning.css.
 */
import "./planning.css";
import { useMemo, useState } from "react";
import {
  Airplane,
  CalendarDots,
  DownloadSimple,
  Fan,
  Funnel,
  ListMagnifyingGlass,
  Printer,
  ShieldCheck,
} from "@phosphor-icons/react";
import { useWorkspace } from "../data/store";
import { toCsv } from "../domain/csv";
import {
  addDays,
  forecast,
  weekOf,
  type ForecastItem,
} from "../domain/forecast";
import { WORKLOAD_MONTHS, monthlyWorkload } from "../domain/maintenanceCharts";
import { can, localDate, type Snapshot } from "../domain/model";
import { programPermission } from "../domain/programs";
import { download } from "./ui";
import { BarChart, type ChartSeries } from "./charts";
import {
  EmptyState,
  ListCard,
  PageHeader,
  SectionHeading,
  StatsStrip,
  StatTile,
  StatusPill,
  Toolbar,
} from "./design";
import { OpsList, OpsMeters, OpsRow, OpsSelect } from "./OpsList";

// Horizon choices in days; the first is the default.
const HORIZONS = [30, 60, 90];
const KIND_LABELS = {
  inspection: "Inspection",
  component: "Component",
  ad: "AD",
} as const;
const KIND_ICONS = {
  inspection: ListMagnifyingGlass,
  component: Fan,
  ad: ShieldCheck,
} as const;
// Blues and a grey: the kinds are categories, not statuses.
const WORKLOAD_SERIES: (ChartSeries & { key: ForecastItem["kind"] })[] = [
  { key: "inspection", label: "Inspections", tone: "1" },
  { key: "component", label: "Component requirements", tone: "2" },
  { key: "ad", label: "Airworthiness directives", tone: "4" },
];
const BASIS_LABELS = {
  hours: "Hours",
  cycles: "Cycles",
  landings: "Landings",
  calendar: "Calendar",
} as const;

type Plan = ReturnType<typeof usePlanning>;
type PlanProps = { plan: Plan };

/**
 * The tone of a forecast item's status pill.
 *
 * @param item - The item; an overdue projection counts whatever its status.
 * @returns "danger" when overdue or past due, "warning" when due soon or due
 *   now, else "neutral".
 */
export function statusTone(item: ForecastItem) {
  if (item.projection?.overdue || /overdue|past due/i.test(item.status))
    return "danger" as const;
  return /due.soon|due now/i.test(item.status) ? "warning" : "neutral";
}

/**
 * The aircraft whose forecast the user may read.
 *
 * @param s - The snapshot.
 * @returns The aircraft the user holds read access to, in snapshot order.
 */
export function readableAircraft(s: Snapshot) {
  return s.aircraft.filter((a) => can(s, a.uuid, "read"));
}

/**
 * The forecast items the user may read: those of aircraft they can read, and
 * components held in inventory when they can read the program.
 *
 * @param s - The snapshot.
 * @param today - The day projections count from.
 * @returns The items in {@link forecast} order.
 */
export function readableForecast(s: Snapshot, today: string) {
  const readable = new Set(readableAircraft(s).map((a) => a.uuid));
  // Inventory components have no aircraft; program read access shows them.
  const showInventory = programPermission(s, "read");
  return forecast(s, today).filter((i) =>
    i.aircraftUuid ? readable.has(i.aircraftUuid) : showInventory,
  );
}

/**
 * The Planning screen: the forecast items the user may read, grouped by the
 * week they are projected to fall due within the chosen horizon, then the
 * items with too little usage to project. Filters by aircraft and item type,
 * prints, and exports the shown items as CSV.
 *
 * @returns The screen; it changes no records.
 */
export function Planning() {
  const plan = usePlanning();
  return (
    <div className="planning ops-page">
      <PageHeader
        eyebrow="MAINTENANCE"
        title="Planning"
        description="Upcoming maintenance across the fleet, projected from recent utilization — whichever limit comes first."
        actions={<PlanningActions plan={plan} />}
      />
      <PlanningFilters plan={plan} />
      <PlanningStats plan={plan} />
      <p className="ops-help">
        Projections average accepted flights from the last 90 days (or all
        history when that is too thin). They are estimates for planning, not
        compliance records.
      </p>
      <PlanningWorkload plan={plan} />
      <PlanningWeeks plan={plan} />
    </div>
  );
}

function usePlanning() {
  const { snapshot: s } = useWorkspace();
  const [horizon, setHorizon] = useState(HORIZONS[0]);
  const [aircraftFilter, setAircraftFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const today = localDate();
  const readable = readableAircraft(s!);
  const items = useMemo(() => readableForecast(s!, today), [s, today]).filter(
    (i) =>
      (!aircraftFilter || i.aircraftUuid === aircraftFilter) &&
      (!kindFilter || i.kind === kindFilter),
  );
  const end = addDays(today, horizon);
  return {
    today,
    readable,
    horizon,
    setHorizon,
    aircraftFilter,
    setAircraftFilter,
    kindFilter,
    setKindFilter,
    workload: monthlyWorkload(items, today),
    planned: items.filter((i) => i.projection && i.projection.date <= end),
    unprojected: items.filter((i) => !i.projection),
    registration: (i: ForecastItem) =>
      s!.aircraft.find((a) => a.uuid === i.aircraftUuid)?.registration ??
      "Inventory",
  };
}

function PlanningActions({ plan }: PlanProps) {
  return (
    <div className="ops-header-actions no-print">
      <button className="button" onClick={() => window.print()}>
        <Printer size={18} aria-hidden="true" /> Print
      </button>
      <button
        className="button primary"
        disabled={!plan.planned.length && !plan.unprojected.length}
        onClick={() => exportCsv(plan)}
      >
        <DownloadSimple size={18} weight="bold" aria-hidden="true" /> Export CSV
      </button>
    </div>
  );
}

function PlanningFilters({ plan }: PlanProps) {
  return (
    <Toolbar className="no-print">
      <div className="ops-filters">
        <OpsSelect
          label="Horizon"
          icon={CalendarDots}
          value={plan.horizon}
          onChange={(v) => plan.setHorizon(Number(v))}
        >
          {HORIZONS.map((d) => (
            <option key={d} value={d}>
              Next {d} days
            </option>
          ))}
        </OpsSelect>
        <OpsSelect
          label="Aircraft"
          icon={Airplane}
          value={plan.aircraftFilter}
          onChange={plan.setAircraftFilter}
        >
          <option value="">All aircraft</option>
          {plan.readable.map((a) => (
            <option key={a.uuid} value={a.uuid}>
              {a.registration}
            </option>
          ))}
        </OpsSelect>
        <KindFilter plan={plan} />
      </div>
    </Toolbar>
  );
}

function KindFilter({ plan }: PlanProps) {
  return (
    <OpsSelect
      label="Item type"
      icon={Funnel}
      value={plan.kindFilter}
      onChange={plan.setKindFilter}
    >
      <option value="">All items</option>
      <option value="inspection">Inspections</option>
      <option value="component">Component requirements</option>
      <option value="ad">Airworthiness directives</option>
    </OpsSelect>
  );
}

function PlanningStats({ plan: { planned, unprojected, horizon } }: PlanProps) {
  const affected = new Set(
    planned.map((i) => i.aircraftUuid).filter((id) => id !== undefined),
  ).size;
  return (
    <StatsStrip className="ops-stats">
      <StatTile label={`Next ${horizon} days`} value={planned.length} />
      <StatTile
        label="Overdue"
        value={planned.filter((i) => i.projection?.overdue).length}
      />
      <StatTile label="Aircraft affected" value={affected} />
      <StatTile label="Insufficient data" value={unprojected.length} />
    </StatsStrip>
  );
}

// Looks past the horizon: the filtered items due in each of the next twelve
// months, whatever horizon the list below shows.
function PlanningWorkload({ plan }: PlanProps) {
  const series = WORKLOAD_SERIES.filter(
    (kind) => !plan.kindFilter || kind.key === plan.kindFilter,
  );
  return (
    <section className="ds-section planning-workload no-print">
      <SectionHeading
        title="Projected workload"
        note={`Items due per month, next ${WORKLOAD_MONTHS} months`}
      />
      <div className="ds-card">
        <BarChart
          label={`Items projected to fall due in each of the next ${WORKLOAD_MONTHS} months`}
          categoryLabel="Month"
          rows={plan.workload}
          series={series}
          format={wholeCount}
          stacked
        />
      </div>
    </section>
  );
}

// Counts are whole, so the axis leaves its in-between ticks unlabelled.
function wholeCount(count: number) {
  return Number.isInteger(count) ? count.toLocaleString("en-US") : "";
}

function PlanningWeeks({ plan }: PlanProps) {
  const { planned, unprojected, registration } = plan;
  const weeks = [...new Set(planned.map((i) => weekOf(i.projection!.date)))];
  return (
    <>
      {weeks.map((week) => (
        <ListCard className="ops-week" key={week} title={`Week of ${week}`}>
          <ForecastList
            label={`Week of ${week}`}
            items={planned.filter((i) => weekOf(i.projection!.date) === week)}
            registration={registration}
          />
        </ListCard>
      ))}
      {!weeks.length && (
        <EmptyState
          title={`Nothing projected in the next ${plan.horizon} days`}
        >
          Items beyond the horizon or without enough data are not shown here.
        </EmptyState>
      )}
      {unprojected.length > 0 && (
        <ListCard className="ops-week" title="Insufficient data">
          <p className="ops-help ops-week-note">
            These items have usage limits but no flight history or usage on
            those limits to project from.
          </p>
          <ForecastList
            label="Insufficient data"
            items={unprojected}
            registration={registration}
          />
        </ListCard>
      )}
    </>
  );
}

type ListProps = {
  label: string;
  items: ForecastItem[];
  registration: (i: ForecastItem) => string;
};

function ForecastList({ label, items, registration }: ListProps) {
  return (
    <OpsList label={label}>
      {items.map((i) => (
        <ForecastRow key={i.key} item={i} registration={registration} />
      ))}
    </OpsList>
  );
}

function ForecastRow({
  item: i,
  registration,
}: Pick<ListProps, "registration"> & { item: ForecastItem }) {
  const tone = statusTone(i);
  return (
    <OpsRow
      icon={KIND_ICONS[i.kind]}
      tone={tone === "neutral" ? "blue" : tone}
      title={i.title}
      sub={
        <>
          {registration(i)} · {KIND_LABELS[i.kind]} · {i.detail}
        </>
      }
      meta={i.projection?.date ?? "Not projected"}
      badge={<StatusPill tone={tone}>{statusText(i)}</StatusPill>}
    >
      <OpsMeters
        items={[
          ["Basis", i.projection ? BASIS_LABELS[i.projection.basis] : "—"],
          ["Remaining", i.remaining || "—"],
        ]}
      />
      {i.note && <p className="ops-row-note">{i.note}</p>}
    </OpsRow>
  );
}

function exportCsv({ today, planned, unprojected, registration }: Plan) {
  const rows = [...planned, ...unprojected].map((i) => ({
    Aircraft: registration(i),
    Type: KIND_LABELS[i.kind],
    Item: i.title,
    Description: i.detail,
    "Projected date": i.projection?.date ?? "",
    Basis: i.projection ? BASIS_LABELS[i.projection.basis] : "",
    Overdue: i.projection?.overdue ? "Yes" : "",
    Remaining: i.remaining,
    Status: i.status,
    Note: i.note,
  }));
  download(
    `maintenance-forecast-${today}.csv`,
    toCsv(rows),
    "text/csv;charset=utf-8",
  );
}

// Status codes such as "due-soon" read as "Due soon".
function statusText(item: ForecastItem) {
  const text = (item.projection?.overdue ? "overdue" : item.status).replace(
    /-/g,
    " ",
  );
  return text.charAt(0).toUpperCase() + text.slice(1);
}
