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
import { can, localDate } from "../domain/model";
import { programPermission } from "../domain/programs";
import { download } from "./ui";
import {
  EmptyState,
  ListCard,
  PageHeader,
  StatsStrip,
  StatTile,
  StatusPill,
  Toolbar,
} from "./design";
import { OpsList, OpsMeters, OpsRow, OpsSelect } from "./OpsList";

const HORIZONS = [30, 60, 90];
const kindLabels = {
  inspection: "Inspection",
  component: "Component",
  ad: "AD",
} as const;
const kindIcons = {
  inspection: ListMagnifyingGlass,
  component: Fan,
  ad: ShieldCheck,
} as const;
const basisLabels = {
  hours: "Hours",
  cycles: "Cycles",
  landings: "Landings",
  calendar: "Calendar",
} as const;
export function statusTone(item: ForecastItem) {
  if (item.projection?.overdue || /overdue|past due/i.test(item.status))
    return "danger" as const;
  return /due.soon|due now/i.test(item.status) ? "warning" : "neutral";
}
// Status codes such as "due-soon" read as "Due soon".
const statusText = (item: ForecastItem) => {
  const text = (item.projection?.overdue ? "overdue" : item.status).replace(
    /-/g,
    " ",
  );
  return text.charAt(0).toUpperCase() + text.slice(1);
};

export function Planning() {
  const { snapshot: s } = useWorkspace();
  const [horizon, setHorizon] = useState(30),
    [aircraftFilter, setAircraftFilter] = useState(""),
    [kindFilter, setKindFilter] = useState("");
  const today = localDate();
  const readable = s!.aircraft.filter((a) => can(s!, a.uuid, "read"));
  const showInventory = programPermission(s!, "read");
  const items = useMemo(() => forecast(s!, today), [s, today]).filter(
    (i) =>
      (i.aircraftUuid
        ? readable.some((a) => a.uuid === i.aircraftUuid)
        : showInventory) &&
      (!aircraftFilter || i.aircraftUuid === aircraftFilter) &&
      (!kindFilter || i.kind === kindFilter),
  );
  const end = addDays(today, horizon);
  const planned = items.filter((i) => i.projection && i.projection.date <= end);
  const unprojected = items.filter((i) => !i.projection);
  const weeks = [...new Set(planned.map((i) => weekOf(i.projection!.date)))];
  const registration = (i: ForecastItem) =>
    s!.aircraft.find((a) => a.uuid === i.aircraftUuid)?.registration ??
    "Inventory";
  const exportCsv = () =>
    download(
      `maintenance-forecast-${today}.csv`,
      toCsv(
        [...planned, ...unprojected].map((i) => ({
          Aircraft: registration(i),
          Type: kindLabels[i.kind],
          Item: i.title,
          Description: i.detail,
          "Projected date": i.projection?.date ?? "",
          Basis: i.projection ? basisLabels[i.projection.basis] : "",
          Overdue: i.projection?.overdue ? "Yes" : "",
          Remaining: i.remaining,
          Status: i.status,
          Note: i.note,
        })),
      ),
      "text/csv;charset=utf-8",
    );
  const affected = new Set(
    planned.map((i) => i.aircraftUuid).filter((id) => id !== undefined),
  ).size;
  return (
    <div className="planning ops-page">
      <PageHeader
        eyebrow="MAINTENANCE"
        title="Planning"
        description="Upcoming maintenance across the fleet, projected from recent utilization — whichever limit comes first."
        actions={
          <div className="ops-header-actions no-print">
            <button className="button" onClick={() => window.print()}>
              <Printer size={18} aria-hidden="true" /> Print
            </button>
            <button
              className="button primary"
              disabled={!planned.length && !unprojected.length}
              onClick={exportCsv}
            >
              <DownloadSimple size={18} weight="bold" aria-hidden="true" />{" "}
              Export CSV
            </button>
          </div>
        }
      />
      <Toolbar className="no-print">
        <div className="ops-filters">
          <OpsSelect
            label="Horizon"
            icon={CalendarDots}
            value={horizon}
            onChange={(v) => setHorizon(Number(v))}
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
            value={aircraftFilter}
            onChange={setAircraftFilter}
          >
            <option value="">All aircraft</option>
            {readable.map((a) => (
              <option key={a.uuid} value={a.uuid}>
                {a.registration}
              </option>
            ))}
          </OpsSelect>
          <OpsSelect
            label="Item type"
            icon={Funnel}
            value={kindFilter}
            onChange={setKindFilter}
          >
            <option value="">All items</option>
            <option value="inspection">Inspections</option>
            <option value="component">Component requirements</option>
            <option value="ad">Airworthiness directives</option>
          </OpsSelect>
        </div>
      </Toolbar>
      <StatsStrip className="ops-stats">
        <StatTile label={`Next ${horizon} days`} value={planned.length} />
        <StatTile
          label="Overdue"
          value={planned.filter((i) => i.projection?.overdue).length}
        />
        <StatTile label="Aircraft affected" value={affected} />
        <StatTile label="Insufficient data" value={unprojected.length} />
      </StatsStrip>
      <p className="ops-help">
        Projections average accepted flights from the last 90 days (or all
        history when that is too thin). They are estimates for planning, not
        compliance records.
      </p>
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
        <EmptyState title={`Nothing projected in the next ${horizon} days`}>
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
    </div>
  );
}

function ForecastList({
  label,
  items,
  registration,
}: {
  label: string;
  items: ForecastItem[];
  registration: (i: ForecastItem) => string;
}) {
  return (
    <OpsList label={label}>
      {items.map((i) => {
        const tone = statusTone(i);
        return (
          <OpsRow
            key={i.key}
            icon={kindIcons[i.kind]}
            tone={tone === "neutral" ? "blue" : tone}
            title={i.title}
            sub={
              <>
                {registration(i)} · {kindLabels[i.kind]} · {i.detail}
              </>
            }
            meta={i.projection?.date ?? "Not projected"}
            badge={<StatusPill tone={tone}>{statusText(i)}</StatusPill>}
          >
            <OpsMeters
              items={[
                ["Basis", i.projection ? basisLabels[i.projection.basis] : "—"],
                ["Remaining", i.remaining || "—"],
              ]}
            />
            {i.note && <p className="ops-row-note">{i.note}</p>}
          </OpsRow>
        );
      })}
    </OpsList>
  );
}
