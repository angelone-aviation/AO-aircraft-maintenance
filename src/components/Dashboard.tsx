/**
 * Responsibility: The fleet dashboard: KPIs, aircraft cards with their next
 *   inspection, the maintenance outlook and the aircraft detail dialog.
 * Layer: UI. Screen over the workspace snapshot; status rules live in
 *   src/domain.
 * Dependencies: src/data/store.ts, src/domain (model, dueItems, maintenance,
 *   aircraftStatus, management, partsPlanning, requiredParts, pilotView,
 *   readings, rejection),
 *   ./design and the aircraft, flight, parts and FAA components.
 */
import {
  lazy,
  Suspense,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Link } from "@tanstack/react-router";
import {
  AirplaneTilt,
  ArrowUpRight,
  BookOpen,
  ClipboardText,
  Clock,
  HourglassMedium,
  Info,
  Package,
  Plus,
  Star,
  Warning,
  WarningCircle,
  Wrench,
  ArrowRight,
} from "@phosphor-icons/react";
import { useWorkspace } from "../data/store";
import { isPilotView } from "../domain/pilotView";
import {
  aircraftStatus,
  aircraftStatusLabels,
  type AircraftStatus,
} from "../domain/aircraftStatus";
import {
  dueItems,
  type InspectionDue,
  type MaintenanceDue,
  type RequirementDue,
} from "../domain/dueItems";
import { inspectionCounters } from "../domain/management";
import {
  compareInspectionUrgency,
  INSPECTION_DUE_SOON_WITHIN,
  inspectionDueDate,
  inspectionDueLimit,
  type InspectionLimit,
} from "../domain/maintenance";
import { maintenancePartsPlans, type PartsPlan } from "../domain/partsPlanning";
import { partsNeedAttention } from "../domain/requiredParts";
import { SECONDS_PER_HOUR } from "../domain/readings";
import { Rejection } from "../domain/rejection";
import {
  aircraftMeterLabels,
  can,
  hours,
  localDate,
  totalSeconds,
  type Aircraft,
  type Inspection,
  type Snapshot,
} from "../domain/model";
import { FaaRenewalAlert } from "./FaaKeySettings";
import { ExportAircraftStatus } from "./ExportAircraftStatus";
import { AircraftForm337 } from "./AircraftFiles";
import { AircraftInspectionSchedules } from "./AircraftInspectionSchedules";
import { PartsAvailability } from "./RequiredParts";
import { FlightForm } from "./FlightForm";
import { AircraftStatusBadge, AircraftStatusReasons } from "./AircraftStatus";
import {
  AircraftArt,
  Dialog,
  EmptyState,
  IconTile,
  KpiStrip,
  KpiTile,
  NoticeBar,
  PageHeader,
  ProgressTrack,
  RoundButton,
  SearchField,
  StatusPill,
  Toolbar,
  type IconType,
  type Tone,
} from "./design";
import "../styles/screens/dashboard.css";

// The AD screen module is large; load its alerts panel after first paint.
const ADAlerts = lazy(() =>
  import("./Airworthiness").then((m) => ({ default: m.ADAlerts })),
);

const DAY_MS = 86_400_000;
const SCHEDULE_TONES: Record<ScheduleState, Tone> = {
  overdue: "danger",
  "due-soon": "warn",
  scheduled: "good",
  unknown: "neutral",
};
const STATUS_TONES: Record<AircraftStatus["level"], Tone> = {
  airworthy: "good",
  "due-soon": "warn",
  grounded: "danger",
};
const OPERATIONAL_TONES: Partial<Record<Aircraft["operationalStatus"], Tone>> =
  { grounded: "danger", maintenance: "warn" };

type ScheduleState = "overdue" | "due-soon" | "scheduled" | "unknown";
interface Schedule {
  i: Inspection;
  counters?: ReturnType<typeof inspectionCounters>;
  hoursRemaining?: number;
  cyclesRemaining?: number;
  landingsRemaining?: number;
  daysRemaining?: number;
  /** The limit that drives the status; the card and outlook show it. */
  limit?: InspectionLimit;
  status: ScheduleState;
}
interface NextDue {
  reference: string;
  remaining: string;
  tone: Tone;
  progress?: number;
  last?: string;
  due?: string;
}
type Marks = Omit<NextDue, "reference" | "tone">;
type DashboardState = ReturnType<typeof useDashboard>;
type Fleet = ReturnType<typeof fleetOf>;
type FleetProps = { s: Snapshot; fleet: Fleet };
interface CardProps {
  aircraft: Aircraft;
  index: number;
  s: Snapshot;
  status: AircraftStatus;
  next: NextDue;
  pilotView: boolean;
  favorite: boolean;
  onFavorite: () => void;
  onView: () => void;
  onLog: () => void;
  componentWarning: boolean;
  partsAttention: boolean;
}
interface DetailProps {
  aircraft: Aircraft;
  s: Snapshot;
  pilotView: boolean;
  partsPlans: PartsPlan[];
  onClose: () => void;
  onLog: () => void;
}

/**
 * The fleet dashboard: KPIs, a card per aircraft (filtered by search text and
 * favorites) with its most urgent inspection, AD alerts, the maintenance
 * outlook and an aircraft detail dialog.
 *
 * @returns The screen. Pilot view leaves out the inventory notice, the review
 *   KPI, the FAA renewal alert, the outlook and parts availability, and shows
 *   each aircraft's operational status. Logging a flight needs the flight
 *   permission on an aircraft.
 */
export function Dashboard() {
  const d = useDashboard();
  const { s, pilotView, fleet } = d;
  return (
    <div className="dash">
      <DashboardHeader
        s={s}
        pilotView={pilotView}
        onLog={() => d.setFlight("")}
      />
      {!pilotView && <InventoryNotice s={s} fleet={fleet} />}
      <FleetKpis s={s} fleet={fleet} pilotView={pilotView} />
      <FleetSection d={d} />
      <section className="dash-panel dash-ads">
        <Suspense fallback={null}>
          <ADAlerts />
        </Suspense>
      </section>
      {!pilotView && <FaaRenewalAlert />}
      <div className="dash-bottom">
        {!pilotView && <MaintenanceOutlook s={s} fleet={fleet} />}
        <RecordsCallout />
      </div>
      <DashboardDialogs d={d} />
    </div>
  );
}

function useDashboard() {
  const { snapshot, favorites, toggleFavorite } = useWorkspace();
  const s = snapshot!;
  // flight: null while closed, "" when no aircraft is chosen yet.
  const [search, setSearch] = useState(""),
    [onlyFavorites, setOnlyFavorites] = useState(false),
    [flight, setFlight] = useState<string | null>(null),
    [detailUuid, setDetailUuid] = useState<string | null>(null);
  return {
    s,
    favorites,
    toggleFavorite,
    pilotView: isPilotView(s),
    fleet: fleetOf(s),
    search,
    setSearch,
    onlyFavorites,
    setOnlyFavorites,
    flight,
    setFlight,
    detailUuid,
    setDetailUuid,
  };
}

function fleetOf(s: Snapshot) {
  const today = localDate();
  const due = dueItems(s, undefined, today);
  const schedules = inspectionSchedules(s, due, today);
  return {
    today,
    schedules,
    /** Overdue and due-soon inspections, most urgent first. */
    due: [...schedules.values()]
      .flat()
      .filter((x) => x.status === "overdue" || x.status === "due-soon")
      .sort(compareInspectionUrgency),
    open: s.discrepancies.filter((d) => d.status === "open"),
    partsPlans: maintenancePartsPlans(s),
    expiredComponents: expiredComponents(s, due),
  };
}

function inspectionSchedules(
  s: Snapshot,
  due: MaintenanceDue[],
  today: string,
) {
  const schedules = new Map<string, Schedule[]>();
  for (const d of due) {
    if (d.kind !== "inspection") continue;
    const uuid = d.aircraft.uuid;
    schedules.set(uuid, [
      ...(schedules.get(uuid) ?? []),
      scheduleOf(s, d, today),
    ]);
  }
  return schedules;
}

// Components with a requirement that is anything but "Tracked": approaching
// or past a service limit.
function expiredComponents(s: Snapshot, due: MaintenanceDue[]) {
  const requirements = due.filter(
    (d): d is RequirementDue => d.kind === "componentRequirement",
  );
  return (s.management ?? []).filter(
    (c) =>
      c.kind === "component" &&
      requirements.some((d) => d.component.uuid === c.uuid && isPastTracked(d)),
  );
}

// T13 leaves what an uncomputable status means to each caller: a requirement
// fails the page, checked in record order up to the first one past Tracked.
function isPastTracked(d: RequirementDue) {
  if (!d.due) throw d.error;
  return d.due.status !== "Tracked";
}

/** Remaining amounts for one inspection; an uncomputable schedule (for
 * example a missing component) stays unverified instead of failing the page. */
function scheduleOf(s: Snapshot, d: InspectionDue, today: string): Schedule {
  const { inspection: i, aircraft: a } = d;
  if (!d.due) return { i, status: "unknown" };
  // Read again for the progress bars; dueItems measured the status on these.
  const counters = inspectionCounters(i, a, s.management, today);
  return { i, counters, ...d.due, limit: inspectionDueLimit(d.due) };
}

function DashboardHeader({
  s,
  pilotView,
  onLog,
}: {
  s: Snapshot;
  pilotView: boolean;
  onLog: () => void;
}) {
  return (
    <PageHeader
      hero
      eyebrow={pilotView ? "PILOT OVERVIEW" : "OPERATIONS OVERVIEW"}
      title="Your fleet,"
      accent="at a glance."
      description={
        pilotView
          ? "Check your aircraft, log flights and report problems."
          : "Fleet status, hours and what’s coming due."
      }
      actions={
        s.aircraft.some((a) => can(s, a.uuid, "flight")) && (
          <button
            type="button"
            className="button primary dash-log-cta"
            onClick={onLog}
          >
            <Plus size={18} weight="bold" aria-hidden="true" /> Log a flight
          </button>
        )
      }
    />
  );
}

function InventoryNotice({ s, fleet }: FleetProps) {
  const lowStock = (s.management ?? []).filter(
    (r) => r.kind === "stock" && r.quantity <= r.minimum,
  );
  const components = fleet.expiredComponents.length;
  if (!components && !lowStock.length) return null;
  return (
    <NoticeBar tone="warn" icon={Warning} className="dash-notice">
      {components} component(s) with approaching or reached service limits ·{" "}
      {lowStock.length} stock item(s) need replenishment. Review Components and
      Inventory.
    </NoticeBar>
  );
}

function FleetKpis({
  s,
  fleet,
  pilotView,
}: FleetProps & { pilotView: boolean }) {
  const { due, open } = fleet;
  // One number for hours and cycles: they share a due-soon window.
  const soon = INSPECTION_DUE_SOON_WITHIN;
  return (
    <KpiStrip
      columns={pilotView ? 3 : 4}
      className={pilotView ? "dash-kpis dash-kpis-odd" : "dash-kpis"}
    >
      <KpiTile
        label="Aircraft in your fleet"
        value={s.aircraft.length}
        icon={AirplaneTilt}
        tone="blue"
        footnote="Within your access"
      />
      <KpiTile
        label="Inspections approaching"
        value={due.length}
        icon={HourglassMedium}
        tone="warn"
        valueTone={due.length ? "warn" : undefined}
        footnote={`Within ${soon.hours} hours / cycles or ${soon.days} days`}
      />
      <KpiTile
        label="Open discrepancies"
        value={open.length}
        icon={Wrench}
        tone="danger"
        valueTone={open.length ? "danger" : undefined}
        footnote="Awaiting maintenance resolution"
      />
      {!pilotView && <ReviewKpi s={s} />}
    </KpiStrip>
  );
}

function ReviewKpi({ s }: { s: Snapshot }) {
  return (
    <KpiTile
      label="Flights awaiting review"
      value={s.flights.filter((f) => f.status === "review").length}
      icon={ClipboardText}
      tone="good"
      footnote="Excluded from aircraft totals"
    />
  );
}

function FleetSection({ d }: { d: DashboardState }) {
  const aircrafts = visibleAircraft(d);
  return (
    <>
      <Toolbar className="dash-toolbar" end={<FleetFilters d={d} />}>
        <h2 className="dash-section-title">
          Aircraft{" "}
          <span className="dash-count">
            {String(aircrafts.length).padStart(2, "0")}
          </span>
        </h2>
      </Toolbar>
      {aircrafts.length > 0 ? (
        <div className="dash-grid">
          {aircrafts.map((a, index) => (
            <AircraftCard key={a.uuid} {...cardProps(d, a, index)} />
          ))}
        </div>
      ) : (
        <NoAircraft d={d} />
      )}
    </>
  );
}

function visibleAircraft(d: DashboardState) {
  const query = d.search.toLowerCase();
  return d.s.aircraft.filter(
    (a) =>
      (!d.onlyFavorites || d.favorites.includes(a.uuid)) &&
      (a.registration + " " + a.model + " " + a.program)
        .toLowerCase()
        .includes(query),
  );
}

function FleetFilters({ d }: { d: DashboardState }) {
  return (
    <>
      <button
        type="button"
        className="dash-fav-toggle"
        aria-pressed={d.onlyFavorites}
        onClick={() => d.setOnlyFavorites(!d.onlyFavorites)}
      >
        <Star
          size={17}
          weight={d.onlyFavorites ? "fill" : "regular"}
          aria-hidden="true"
        />
        Favorites
      </button>
      <SearchField
        className="dash-search"
        label="Search aircraft"
        value={d.search}
        onChange={d.setSearch}
      />
    </>
  );
}

function cardProps(d: DashboardState, a: Aircraft, index: number): CardProps {
  const { s, fleet, pilotView } = d;
  return {
    index,
    aircraft: a,
    s,
    status: aircraftStatus(s, a.uuid),
    next: nextDue(fleet.schedules.get(a.uuid) ?? [], a, fleet.today),
    pilotView,
    favorite: d.favorites.includes(a.uuid),
    onFavorite: () => void d.toggleFavorite(a.uuid),
    onView: () => d.setDetailUuid(a.uuid),
    onLog: () => d.setFlight(a.uuid),
    componentWarning:
      pilotView &&
      fleet.expiredComponents.some(
        (c) => c.kind === "component" && c.aircraftUuid === a.uuid,
      ),
    partsAttention:
      !pilotView && upcomingPartsNeedAttention(s, fleet.partsPlans, a.uuid),
  };
}

function upcomingPartsNeedAttention(
  s: Snapshot,
  plans: PartsPlan[],
  uuid: string,
) {
  return plans.some(
    (p) =>
      p.aircraftUuid === uuid && p.upcoming && partsNeedAttention(s, p.parts),
  );
}

function NoAircraft({ d }: { d: DashboardState }) {
  const filtered = d.onlyFavorites || d.search !== "";
  if (filtered && d.s.aircraft.length > 0)
    return (
      <EmptyState
        className="dash-empty"
        title="No aircraft match"
        action={
          <button
            type="button"
            className="button small"
            onClick={() => {
              d.setSearch("");
              d.setOnlyFavorites(false);
            }}
          >
            Clear filters
          </button>
        }
      >
        Adjust your search or favorites filter.
      </EmptyState>
    );
  return (
    <EmptyState className="dash-empty" title="No aircraft to display">
      {d.s.user.isAdmin
        ? "Add an aircraft in Administration, or adjust your filters."
        : "Ask your administrator to assign aircraft access."}
    </EmptyState>
  );
}

function MaintenanceOutlook({ s, fleet }: FleetProps) {
  const { due, open, today } = fleet;
  const otherPlans = otherUpcomingPlans(fleet);
  const count = due.length + open.length + otherPlans.length;
  const registration = (uuid: string) => registrationOf(s, uuid);
  return (
    <section className="dash-panel dash-outlook">
      <OutlookHead count={count} anyDue={due.length > 0} />
      {due.map((x) => (
        <InspectionOutlook
          key={x.i.uuid}
          schedule={x}
          registration={registration(x.i.aircraftUuid)}
          today={today}
        />
      ))}
      {open.map((d) => (
        <DiscrepancyOutlook
          key={d.uuid}
          report={d}
          registration={registration(d.aircraftUuid)}
        />
      ))}
      {otherPlans.map((p) => (
        <OutlookRow
          key={p.uuid}
          to="/components"
          icon={Package}
          tone="warn"
          title={p.label}
          sub={registration(p.aircraftUuid)}
        >
          <PartsAvailability parts={p.parts} />
        </OutlookRow>
      ))}
    </section>
  );
}

// Upcoming parts plans for anything the outlook does not already list.
function otherUpcomingPlans({ partsPlans, due, open }: Fleet) {
  return partsPlans.filter(
    (p) =>
      p.upcoming &&
      !due.some((x) => x.i.uuid === p.uuid) &&
      !open.some((d) => d.uuid === p.uuid),
  );
}

const registrationOf = (s: Snapshot, uuid: string) =>
  s.aircraft.find((a) => a.uuid === uuid)?.registration ?? "Unknown aircraft";

function OutlookHead({ count, anyDue }: { count: number; anyDue: boolean }) {
  return (
    <>
      <div className="dash-panel-head">
        <h2>Maintenance outlook</h2>
        <StatusPill tone={count ? "warn" : "neutral"} dot={false}>
          {count} {count === 1 ? "item" : "items"}
        </StatusPill>
      </div>
      {!anyDue && (
        <div className="dash-outlook-empty">
          <strong>No approaching inspections</strong>
          <span>Missing schedules remain unverified.</span>
        </div>
      )}
    </>
  );
}

function InspectionOutlook({
  schedule: x,
  registration,
  today,
}: {
  schedule: Schedule;
  registration: string;
  today: string;
}) {
  return (
    <OutlookRow
      to="/inspections"
      icon={Clock}
      tone={x.status === "overdue" ? "danger" : "warn"}
      title={x.i.reference}
      sub={`${registration} · ${x.i.description}`}
      value={dueShort(x, today)}
    >
      <PartsAvailability
        parts={x.i.requiredParts}
        source={{ kind: "inspection", uuid: x.i.uuid, workOrderUuid: "" }}
      />
    </OutlookRow>
  );
}

function DiscrepancyOutlook({
  report: d,
  registration,
}: {
  report: Snapshot["discrepancies"][number];
  registration: string;
}) {
  return (
    <OutlookRow
      to="/discrepancies"
      icon={Warning}
      tone={d.deferral ? "warn" : "danger"}
      title={d.deferral ? "Deferred discrepancy" : "Open discrepancy"}
      sub={`${registration} · ${d.description}`}
      value={d.deferral ? "Deferred" : "Open"}
    >
      <PartsAvailability
        parts={d.requiredParts}
        source={{ kind: "discrepancy", uuid: d.uuid, workOrderUuid: "" }}
      />
    </OutlookRow>
  );
}

function OutlookRow({
  to,
  icon,
  tone,
  title,
  sub,
  value,
  children,
}: {
  to: "/inspections" | "/discrepancies" | "/components";
  icon: IconType;
  tone: Tone;
  title: string;
  sub: string;
  value?: string;
  children?: ReactNode;
}) {
  return (
    <Link to={to} className="dash-outlook-row">
      <IconTile icon={icon} tone={tone} />
      <span className="dash-outlook-text">
        <strong className="dash-outlook-title">{title}</strong>
        <span className="dash-outlook-sub">{sub}</span>
        {children}
      </span>
      {value && (
        <span className={"dash-outlook-value dash-tone-" + tone}>{value}</span>
      )}
    </Link>
  );
}

function RecordsCallout() {
  return (
    <section className="dash-callout">
      <div className="dash-callout-text">
        <p className="eyebrow">BEFORE YOUR NEXT FLIGHT</p>
        <h2>
          Good records.
          <br />
          Better decisions.
        </h2>
        <p className="dash-callout-body">
          Log each flight, report what you find, and keep your team informed —
          even when you’re away from a connection.
        </p>
        <p className="dash-callout-foot">
          Dashboard indicators summarize recorded data. Missing information
          never implies aircraft readiness.
        </p>
      </div>
      <AircraftArt drift className="dash-callout-art" opacity={0.78} />
    </section>
  );
}

function DashboardDialogs({ d }: { d: DashboardState }) {
  const detail = d.s.aircraft.find((a) => a.uuid === d.detailUuid);
  const closeFlight = () => d.setFlight(null);
  return (
    <>
      {d.flight !== null && (
        <Dialog
          title="Log a flight"
          subtitle="Saved on this device first, then synced."
          onClose={closeFlight}
          dismissOnScrim={false}
          className="dash-flight"
        >
          <FlightForm
            aircraftUuid={d.flight || undefined}
            onDone={closeFlight}
            onCancel={closeFlight}
          />
        </Dialog>
      )}
      {detail && (
        <AircraftDetail
          aircraft={detail}
          s={d.s}
          pilotView={d.pilotView}
          partsPlans={d.fleet.partsPlans}
          onClose={() => d.setDetailUuid(null)}
          onLog={() => {
            d.setDetailUuid(null);
            d.setFlight(detail.uuid);
          }}
        />
      )}
    </>
  );
}

/** The most urgent inspection of an aircraft, described the way the card
 * shows it: remaining amount, and the last/due marks that are on record. */
function nextDue(schedules: Schedule[], a: Aircraft, today: string): NextDue {
  const next = [...schedules].sort(compareInspectionUrgency)[0];
  if (!next)
    return {
      reference: "No inspection schedule",
      remaining: "Maintenance information needed",
      tone: "neutral",
    };
  const { i } = next;
  const reference = i.reference || i.description;
  const tone = SCHEDULE_TONES[next.status];
  const marks = limitMarks(next, a, today);
  if (marks) return { reference, tone, ...marks };
  return {
    reference,
    tone,
    remaining: i.calendarExempt
      ? "Calendar exempt"
      : "Maintenance information needed",
  };
}

function limitMarks(x: Schedule, a: Aircraft, today: string) {
  const { i, counters } = x;
  switch (x.limit?.dimension) {
    case "hours":
      return hoursMarks(x);
    case "days":
      return daysMarks(x, today);
    case "cycles":
      return countMarks(x.cyclesRemaining, "cycle", "cycles", {
        last: i.lastCycles,
        due: i.dueCycles,
        now: counters?.cycles,
      });
    case "landings":
      return countMarks(x.landingsRemaining, "landing", "landings", {
        last: i.lastLandings,
        due: i.dueLandings,
        now: a.landings,
      });
  }
  return undefined;
}

function hoursMarks({ i, counters, hoursRemaining }: Schedule) {
  if (hoursRemaining === undefined) return undefined;
  return {
    remaining: amount(hoursRemaining, "h", "h", 1),
    progress: counters && used(i.lastSeconds, i.dueSeconds, counters.seconds),
    last: i.lastSeconds !== undefined ? `${hours(i.lastSeconds)} h` : undefined,
    due: i.dueSeconds !== undefined ? `${hours(i.dueSeconds)} h` : undefined,
  };
}

function daysMarks({ i, daysRemaining }: Schedule, today: string) {
  const dueDate = inspectionDueDate(i);
  if (!dueDate || daysRemaining === undefined) return undefined;
  return {
    remaining: amount(daysRemaining, "day", "days", 0, "Due today"),
    progress: i.lastDate
      ? used(dayNumber(i.lastDate), dayNumber(dueDate), dayNumber(today))
      : undefined,
    last: i.lastDate ? formatDate(i.lastDate) : undefined,
    due: formatDate(dueDate),
  };
}

// Cycles and landings: the marks read "1,200 cycles" whatever the count.
function countMarks(
  remaining: number | undefined,
  singular: string,
  plural: string,
  counter: { last?: number; due?: number; now?: number },
): Marks | undefined {
  if (remaining === undefined) return undefined;
  const { last, due, now } = counter;
  const mark = (n?: number) =>
    n !== undefined ? `${n.toLocaleString()} ${plural}` : undefined;
  return {
    remaining: amount(remaining, singular, plural),
    progress: now === undefined ? undefined : used(last, due, now),
    last: mark(last),
    due: mark(due),
  };
}

const dayNumber = (iso: string) => Date.parse(iso + "T00:00:00Z") / DAY_MS;
function formatDate(iso: string, today?: string) {
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(today && today.slice(0, 4) === iso.slice(0, 4)
      ? {}
      : { year: "numeric" }),
    timeZone: "UTC",
  });
}
const fixed = (value: number, decimals: number) =>
  value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
/** "8.8 h remaining", "3 days overdue", "Due now". */
function amount(
  value: number,
  singular: string,
  plural: string,
  decimals = 0,
  zero = "Due now",
) {
  if (value === 0) return zero;
  const abs = Math.abs(value);
  return `${fixed(abs, decimals)} ${abs === 1 ? singular : plural} ${value < 0 ? "overdue" : "remaining"}`;
}
/** Fraction of the interval used, when both ends of the interval are
 * recorded. */
function used(last: number | undefined, due: number | undefined, now: number) {
  return last !== undefined && due !== undefined && due > last
    ? (now - last) / (due - last)
    : undefined;
}
/** Compact due value for the maintenance outlook ("8.8 h", "26 Nov"), for
 * the limit that drives the inspection's status. */
function dueShort(x: Schedule, today: string) {
  const short = (v: number, unit: string, decimals = 0) =>
    v < 0
      ? `${fixed(-v, decimals)} ${unit} overdue`
      : `${fixed(v, decimals)} ${unit}`;
  const { limit } = x;
  if (limit?.dimension === "hours") return short(limit.remaining, "h", 1);
  const dueDate = inspectionDueDate(x.i);
  if (limit?.dimension === "days" && dueDate)
    return (
      formatDate(dueDate, today) + (limit.remaining < 0 ? " · overdue" : "")
    );
  if (limit?.dimension === "landings")
    return short(limit.remaining, "landings");
  return short(x.cyclesRemaining ?? 0, "cycles");
}
const operationalTone = (a: Aircraft): Tone =>
  OPERATIONAL_TONES[a.operationalStatus] ?? "neutral";
const tenths = (seconds: number) => (seconds / SECONDS_PER_HOUR).toFixed(1);

function AircraftCard(card: CardProps) {
  const { aircraft: a, index, status, pilotView } = card;
  const headingId = `dash-reg-${a.uuid}`;
  return (
    <article
      className="dash-card"
      aria-labelledby={headingId}
      style={{ "--i": index } as CSSProperties}
    >
      <CardHead {...card} headingId={headingId} />
      {(status.reasons.length > 0 || pilotView) && <CardNotes {...card} />}
      <CardMeters aircraft={a} />
      <CardTimeline next={card.next} />
      {card.partsAttention && (
        <div className="dash-card-parts">
          <StatusPill tone="warn">Parts need attention</StatusPill>
        </div>
      )}
      <CardActions {...card} />
    </article>
  );
}

function CardHead({
  aircraft: a,
  status,
  favorite,
  onFavorite,
  headingId,
}: CardProps & { headingId: string }) {
  return (
    <header className="dash-card-head">
      <div className="dash-card-id">
        {a.photoUrl && (
          <img
            className="dash-card-photo"
            src={a.photoUrl}
            alt={`${a.registration} aircraft`}
            loading="lazy"
          />
        )}
        <h3 id={headingId}>{a.registration}</h3>
      </div>
      <CardFlags
        aircraft={a}
        status={status}
        favorite={favorite}
        onFavorite={onFavorite}
      />
      <p className="dash-card-model">
        {a.make} {a.model}
        <span className="dash-card-program">
          {" · "}
          {a.program || "No program assigned"}
        </span>
      </p>
    </header>
  );
}

function CardFlags({
  aircraft: a,
  status,
  favorite,
  onFavorite,
}: Pick<CardProps, "aircraft" | "status" | "favorite" | "onFavorite">) {
  return (
    <div className="dash-card-flags">
      <AircraftStatusBadge status={status} />
      <button
        type="button"
        className="dash-star"
        aria-label={`Favorite ${a.registration}`}
        aria-pressed={favorite}
        onClick={onFavorite}
      >
        <Star
          size={20}
          weight={favorite ? "fill" : "regular"}
          aria-hidden="true"
        />
      </button>
    </div>
  );
}

function CardNotes({
  aircraft: a,
  status,
  pilotView,
  componentWarning,
}: CardProps) {
  return (
    <div className="dash-card-notes">
      {pilotView && (
        <StatusPill tone={operationalTone(a)}>
          Aircraft status: {a.operationalStatus}
        </StatusPill>
      )}
      {componentWarning && (
        <p className="dash-card-warning">
          <Warning size={16} weight="bold" aria-hidden="true" />
          Component service limits need maintenance review.
        </p>
      )}
      <AircraftStatusReasons
        status={status}
        label={`${a.registration} status reasons`}
      />
    </div>
  );
}

function CardMeters({ aircraft: a }: { aircraft: Aircraft }) {
  const total = readTotalSeconds(a);
  return (
    <dl className="dash-meters">
      <div>
        <dt>Total</dt>
        <dd>
          {total === undefined ? (
            "Not recorded"
          ) : (
            <>
              {hours(total)}
              <span className="dash-unit"> h</span>
            </>
          )}
        </dd>
      </div>
      <Meter term="Hobbs">{tenths(a.currentHobbs)}</Meter>
      <Meter term="Tach">{tenths(a.currentTach)}</Meter>
      <Meter term="Landings">{a.landings.toLocaleString()}</Meter>
      {a.turbine && <Meter term="Cycles">{a.cycles.toLocaleString()}</Meter>}
    </dl>
  );
}

// Total time is read from the aircraft's own meter, which can lack a reading;
// the card says so instead of failing the whole page.
function readTotalSeconds(a: Aircraft) {
  try {
    return totalSeconds(a);
  } catch (error) {
    if (error instanceof Rejection) return undefined;
    throw error;
  }
}

function Meter({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function CardTimeline({ next }: { next: NextDue }) {
  const pct =
    next.progress === undefined
      ? undefined
      : Math.round(Math.min(1, Math.max(0, next.progress)) * 100);
  return (
    <div className={"dash-timeline dash-tone-" + next.tone}>
      <div className="dash-timeline-row">
        <span className="dash-timeline-ref">{next.reference}</span>
        <strong className="dash-timeline-value">{next.remaining}</strong>
      </div>
      {pct !== undefined && (
        <ProgressTrack
          value={pct / 100}
          tone={next.tone}
          marker
          label={`${next.reference}: ${pct}% of the interval used`}
        />
      )}
      {(next.last || next.due) && (
        <div className="dash-timeline-marks">
          {next.last && <span>Last {next.last}</span>}
          {next.due && (
            <span className="dash-timeline-due">Due {next.due}</span>
          )}
        </div>
      )}
    </div>
  );
}

function CardActions({ aircraft: a, s, pilotView, onView, onLog }: CardProps) {
  return (
    <div className="dash-card-actions">
      <div className="dash-card-links">
        <button
          type="button"
          className="text-button dash-link"
          onClick={onView}
        >
          View aircraft <ArrowUpRight size={15} aria-hidden="true" />
        </button>
        {pilotView && can(s, a.uuid, "discrepancy") && (
          <Link className="text-button dash-link" to="/discrepancies">
            Report a problem
          </Link>
        )}
      </div>
      {can(s, a.uuid, "flight") && (
        <button
          type="button"
          className="button primary small dash-card-log"
          onClick={onLog}
        >
          <Plus size={15} weight="bold" aria-hidden="true" /> Log flight
        </button>
      )}
    </div>
  );
}

function AircraftDetail(detail: DetailProps) {
  const { aircraft: a, s, pilotView } = detail;
  const status = aircraftStatus(s, a.uuid);
  return (
    <Dialog
      title={a.registration}
      onClose={detail.onClose}
      className="dash-detail"
      header={<DetailHero {...detail} status={status} />}
      footer={<DetailActions {...detail} />}
    >
      <DetailStats aircraft={a} />
      <StatusNotes aircraft={a} status={status} />
      <div className="dash-detail-section dash-detail-inspections">
        <AircraftInspectionSchedules key={a.uuid} aircraft={a} state={s} />
        {!pilotView && (
          <Link to="/inspections" className="dash-detail-manage">
            Manage <ArrowRight size={14} aria-hidden="true" />
          </Link>
        )}
      </div>
      <div className="dash-detail-section dash-detail-ads">
        <Suspense fallback={null}>
          <ADAlerts aircraftUuid={a.uuid} />
        </Suspense>
      </div>
      <AircraftForm337 state={s} aircraft={a} />
      {!pilotView && <DetailParts {...detail} />}
    </Dialog>
  );
}

function DetailHero({
  aircraft: a,
  status,
  onClose,
}: DetailProps & { status: AircraftStatus }) {
  return (
    <div className="dash-detail-hero">
      <AircraftArt opacity={0.28} className="dash-detail-art" />
      <RoundButton
        label="Close dialog"
        onNavy
        onClick={onClose}
        className="dash-detail-close"
      />
      <span
        className={"dash-detail-pill dash-dot-" + STATUS_TONES[status.level]}
      >
        <span className="dash-detail-dot" aria-hidden="true" />
        {aircraftStatusLabels[status.level]}
      </span>
      <h2>{a.registration}</h2>
      <p className="dash-detail-sub">
        {a.make} {a.model} · Serial {a.serial} ·{" "}
        {a.program || "No program assigned"}
      </p>
    </div>
  );
}

function DetailActions({ aircraft: a, s, onLog }: DetailProps) {
  return (
    <div className="dash-detail-actions">
      <div className="dash-detail-export">
        <ExportAircraftStatus aircraftUuid={a.uuid} state={s} />
      </div>
      <Link to="/flights" className="button">
        <BookOpen size={18} aria-hidden="true" /> Flight history
      </Link>
      {can(s, a.uuid, "flight") && (
        <button type="button" className="button primary" onClick={onLog}>
          <Plus size={18} weight="bold" aria-hidden="true" /> Log flight
        </button>
      )}
    </div>
  );
}

function DetailStats({ aircraft: a }: { aircraft: Aircraft }) {
  return (
    <dl className="dash-detail-stats">
      <HoursStat
        term={a.helicopter ? "Run-time hourmeter (console Hobbs)" : "Hobbs"}
        seconds={a.currentHobbs}
      />
      <HoursStat term="Tach" seconds={a.currentTach} />
      {a.flightTimeLog && (
        <Meter term="Flight time log">
          {a.currentFlightTimeLog === undefined ? (
            "Not recorded"
          ) : (
            <HoursValue seconds={a.currentFlightTimeLog} />
          )}
        </Meter>
      )}
      {a.helicopter && a.currentCyclicHobbs !== undefined && (
        <HoursStat term="Collective hourmeter" seconds={a.currentCyclicHobbs} />
      )}
      <Meter term="Landings">{a.landings.toLocaleString()}</Meter>
      <div>
        <dt>Tracking meter</dt>
        <dd className="dash-detail-text">{aircraftMeterLabels[a.meter]}</dd>
      </div>
    </dl>
  );
}

function HoursStat({ term, seconds }: { term: string; seconds: number }) {
  return (
    <Meter term={term}>
      <HoursValue seconds={seconds} />
    </Meter>
  );
}

function HoursValue({ seconds }: { seconds: number }) {
  return (
    <>
      {hours(seconds)}
      <span className="dash-unit"> h</span>
    </>
  );
}

function StatusNotes({
  aircraft: a,
  status,
}: {
  aircraft: Aircraft;
  status: AircraftStatus;
}) {
  const tone = STATUS_TONES[status.level];
  return (
    <section className="dash-detail-section" aria-labelledby="dash-notes">
      <h3 className="dash-detail-label" id="dash-notes">
        Status notes
      </h3>
      <ul className="dash-notes" aria-label={`${a.registration} status notes`}>
        {status.reasons.map((r) => (
          <li key={r.kind + r.entityUuid} className={"dash-note " + tone}>
            <WarningCircle size={18} aria-hidden="true" />
            {r.label}
          </li>
        ))}
        <li className={"dash-note " + operationalTone(a)}>
          <Info size={18} aria-hidden="true" />
          Aircraft status: {a.operationalStatus}.
        </li>
      </ul>
      <p className="dash-detail-foot">
        Status derives from recorded data. Missing information never implies
        aircraft readiness.
      </p>
    </section>
  );
}

function DetailParts({ aircraft: a, partsPlans }: DetailProps) {
  const plans = partsPlans.filter((p) => p.aircraftUuid === a.uuid);
  return (
    <section
      className="dash-detail-section"
      aria-labelledby="dash-detail-parts"
    >
      <h3 className="dash-detail-label" id="dash-detail-parts">
        Maintenance parts availability
      </h3>
      {plans.length ? (
        plans.map((p) => (
          <div className="dash-detail-part" key={p.uuid}>
            <strong>{p.label}</strong>
            <PartsAvailability parts={p.parts} />
          </div>
        ))
      ) : (
        <p className="dash-detail-empty">
          No inventory parts linked to active maintenance items.
        </p>
      )}
    </section>
  );
}
