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
import { aircraftStatus, type AircraftStatus } from "../domain/aircraftStatus";
import { requirementStatus } from "../domain/components";
import { inspectionCounters } from "../domain/management";
import {
  inspectionDueDate,
  inspectionDueLimit,
  inspectionStatus,
  type InspectionLimit,
} from "../domain/maintenance";
import { maintenancePartsPlans } from "../domain/partsPlanning";
import { partsAvailability } from "../domain/requiredParts";
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

/* ─────────────────────── Inspection schedule helpers ─────────────────────── */

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
const rank: Record<ScheduleState, number> = {
  overdue: 0,
  "due-soon": 1,
  scheduled: 2,
  unknown: 3,
};
const scheduleTone: Record<ScheduleState, Tone> = {
  overdue: "danger",
  "due-soon": "warn",
  scheduled: "good",
  unknown: "neutral",
};
/** Remaining amounts for one inspection; an uncomputable schedule (for
 * example a missing component) stays unverified instead of failing the page. */
function scheduleOf(s: Snapshot, i: Inspection, a: Aircraft): Schedule {
  try {
    const counters = inspectionCounters(i, a, s.management);
    const status = inspectionStatus(i, a, undefined, counters);
    return { i, counters, ...status, limit: inspectionDueLimit(status) };
  } catch {
    return { i, status: "unknown" };
  }
}
const urgency = (x: Schedule) => x.limit?.urgency ?? Number.MAX_VALUE;
/** Most urgent first: by status, then by how near the driving limit is. */
const byUrgency = (x: Schedule, y: Schedule) =>
  rank[x.status] - rank[y.status] || urgency(x) - urgency(y);
const dayNumber = (iso: string) => Date.parse(iso + "T00:00:00Z") / 86400000;
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
/** Fraction of the interval used, when both ends of the interval are recorded. */
function used(last: number | undefined, due: number | undefined, now: number) {
  return last !== undefined && due !== undefined && due > last
    ? (now - last) / (due - last)
    : undefined;
}
interface NextDue {
  reference: string;
  remaining: string;
  tone: Tone;
  progress?: number;
  last?: string;
  due?: string;
}
/** The most urgent inspection of an aircraft, described the way the card
 * shows it: remaining amount, and the last/due marks that are on record. */
function nextDue(schedules: Schedule[], a: Aircraft, today: string): NextDue {
  const next = [...schedules].sort(byUrgency)[0];
  if (!next)
    return {
      reference: "No inspection schedule",
      remaining: "Maintenance information needed",
      tone: "neutral",
    };
  const { i, counters } = next;
  const reference = i.reference || i.description;
  const tone = scheduleTone[next.status];
  const dimension = next.limit?.dimension;
  if (dimension === "hours" && next.hoursRemaining !== undefined)
    return {
      reference,
      tone,
      remaining: amount(next.hoursRemaining, "h", "h", 1),
      progress: counters && used(i.lastSeconds, i.dueSeconds, counters.seconds),
      last:
        i.lastSeconds !== undefined ? `${hours(i.lastSeconds)} h` : undefined,
      due: i.dueSeconds !== undefined ? `${hours(i.dueSeconds)} h` : undefined,
    };
  const dueDate = inspectionDueDate(i);
  if (dimension === "days" && dueDate && next.daysRemaining !== undefined)
    return {
      reference,
      tone,
      remaining: amount(next.daysRemaining, "day", "days", 0, "Due today"),
      progress: i.lastDate
        ? used(dayNumber(i.lastDate), dayNumber(dueDate), dayNumber(today))
        : undefined,
      last: i.lastDate ? formatDate(i.lastDate) : undefined,
      due: formatDate(dueDate),
    };
  if (dimension === "cycles" && next.cyclesRemaining !== undefined)
    return {
      reference,
      tone,
      remaining: amount(next.cyclesRemaining, "cycle", "cycles"),
      progress: counters && used(i.lastCycles, i.dueCycles, counters.cycles),
      last:
        i.lastCycles !== undefined
          ? `${i.lastCycles.toLocaleString()} cycles`
          : undefined,
      due:
        i.dueCycles !== undefined
          ? `${i.dueCycles.toLocaleString()} cycles`
          : undefined,
    };
  if (dimension === "landings" && next.landingsRemaining !== undefined)
    return {
      reference,
      tone,
      remaining: amount(next.landingsRemaining, "landing", "landings"),
      progress: used(i.lastLandings, i.dueLandings, a.landings),
      last:
        i.lastLandings !== undefined
          ? `${i.lastLandings.toLocaleString()} landings`
          : undefined,
      due:
        i.dueLandings !== undefined
          ? `${i.dueLandings.toLocaleString()} landings`
          : undefined,
    };
  return {
    reference,
    tone,
    remaining: i.calendarExempt
      ? "Calendar exempt"
      : "Maintenance information needed",
  };
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
const statusTone: Record<AircraftStatus["level"], Tone> = {
  airworthy: "good",
  "due-soon": "warn",
  grounded: "danger",
};
const statusLabel: Record<AircraftStatus["level"], string> = {
  airworthy: "Airworthy",
  "due-soon": "Due soon",
  grounded: "Grounded",
};
const operationalTone = (a: Aircraft): Tone =>
  a.operationalStatus === "grounded"
    ? "danger"
    : a.operationalStatus === "maintenance"
      ? "warn"
      : "neutral";
const tenths = (seconds: number) => (seconds / 3600).toFixed(1);

/* ──────────────────────────────── Dashboard ──────────────────────────────── */

export function Dashboard() {
  const { snapshot, favorites, toggleFavorite } = useWorkspace();
  const s = snapshot!;
  const [search, setSearch] = useState(""),
    [onlyFavorites, setOnlyFavorites] = useState(false),
    [flight, setFlight] = useState<string | null>(null),
    [detailUuid, setDetailUuid] = useState<string | null>(null);
  const pilotView = isPilotView(s);
  const today = localDate();
  const query = search.toLowerCase();
  const aircrafts = s.aircraft.filter(
    (a) =>
      (!onlyFavorites || favorites.includes(a.uuid)) &&
      (a.registration + " " + a.model + " " + a.program)
        .toLowerCase()
        .includes(query),
  );
  const schedules = new Map<string, Schedule[]>();
  for (const i of s.inspections) {
    if (i.archived) continue;
    const a = s.aircraft.find((a) => a.uuid === i.aircraftUuid);
    if (!a) continue;
    schedules.set(a.uuid, [
      ...(schedules.get(a.uuid) ?? []),
      scheduleOf(s, i, a),
    ]);
  }
  const due = [...schedules.values()]
    .flat()
    .filter((x) => x.status === "overdue" || x.status === "due-soon")
    .sort(byUrgency);
  const partsPlans = maintenancePartsPlans(s);
  const open = s.discrepancies.filter((d) => d.status === "open");
  const expiredComponents = (s.management ?? []).filter(
    (c) =>
      c.kind === "component" &&
      (s.management ?? []).some(
        (r) =>
          r.kind === "componentRequirement" &&
          r.componentUuid === c.uuid &&
          requirementStatus(
            r,
            c,
            s.aircraft.find((a) => a.uuid === c.aircraftUuid),
          ).status !== "Tracked",
      ),
  );
  const lowStock = (s.management ?? []).filter(
    (r) => r.kind === "stock" && r.quantity <= r.minimum,
  );
  const review = s.flights.filter((f) => f.status === "review");
  const canLog = s.aircraft.some((a) => can(s, a.uuid, "flight"));
  const filtered = onlyFavorites || search !== "";
  const detail = s.aircraft.find((a) => a.uuid === detailUuid);
  const registration = (uuid: string) =>
    s.aircraft.find((a) => a.uuid === uuid)?.registration ?? "Unknown aircraft";
  const otherPlans = partsPlans.filter(
    (p) =>
      p.upcoming &&
      !due.some((x) => x.i.uuid === p.uuid) &&
      !open.some((d) => d.uuid === p.uuid),
  );
  const outlookCount = due.length + open.length + otherPlans.length;
  return (
    <div className="dash">
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
          canLog && (
            <button
              type="button"
              className="button primary dash-log-cta"
              onClick={() => setFlight("")}
            >
              <Plus size={18} weight="bold" aria-hidden="true" /> Log a flight
            </button>
          )
        }
      />
      {!pilotView && (expiredComponents.length > 0 || lowStock.length > 0) && (
        <NoticeBar tone="warn" icon={Warning} className="dash-notice">
          {expiredComponents.length} component(s) with approaching or reached
          service limits · {lowStock.length} stock item(s) need replenishment.
          Review Components and Inventory.
        </NoticeBar>
      )}
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
          footnote="Within 10 hours / cycles or 30 days"
        />
        <KpiTile
          label="Open discrepancies"
          value={open.length}
          icon={Wrench}
          tone="danger"
          valueTone={open.length ? "danger" : undefined}
          footnote="Awaiting maintenance resolution"
        />
        {!pilotView && (
          <KpiTile
            label="Flights awaiting review"
            value={review.length}
            icon={ClipboardText}
            tone="good"
            footnote="Excluded from aircraft totals"
          />
        )}
      </KpiStrip>
      <Toolbar
        className="dash-toolbar"
        end={
          <>
            <button
              type="button"
              className="dash-fav-toggle"
              aria-pressed={onlyFavorites}
              onClick={() => setOnlyFavorites(!onlyFavorites)}
            >
              <Star
                size={17}
                weight={onlyFavorites ? "fill" : "regular"}
                aria-hidden="true"
              />
              Favorites
            </button>
            <SearchField
              className="dash-search"
              label="Search aircraft"
              value={search}
              onChange={setSearch}
            />
          </>
        }
      >
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
            <AircraftCard
              key={a.uuid}
              index={index}
              aircraft={a}
              s={s}
              status={aircraftStatus(s, a.uuid)}
              next={nextDue(schedules.get(a.uuid) ?? [], a, today)}
              pilotView={pilotView}
              favorite={favorites.includes(a.uuid)}
              onFavorite={() => void toggleFavorite(a.uuid)}
              onView={() => setDetailUuid(a.uuid)}
              onLog={() => setFlight(a.uuid)}
              componentWarning={
                pilotView &&
                expiredComponents.some(
                  (c) => c.kind === "component" && c.aircraftUuid === a.uuid,
                )
              }
              partsAttention={
                !pilotView &&
                partsPlans.some(
                  (p) =>
                    p.aircraftUuid === a.uuid &&
                    p.upcoming &&
                    partsAvailability(s, p.parts).some(
                      (r) => r.available === undefined || (r.shortage ?? 0) > 0,
                    ),
                )
              }
            />
          ))}
        </div>
      ) : filtered && s.aircraft.length > 0 ? (
        <EmptyState
          className="dash-empty"
          title="No aircraft match"
          action={
            <button
              type="button"
              className="button small"
              onClick={() => {
                setSearch("");
                setOnlyFavorites(false);
              }}
            >
              Clear filters
            </button>
          }
        >
          Adjust your search or favorites filter.
        </EmptyState>
      ) : (
        <EmptyState className="dash-empty" title="No aircraft to display">
          {s.user.isAdmin
            ? "Add an aircraft in Administration, or adjust your filters."
            : "Ask your administrator to assign aircraft access."}
        </EmptyState>
      )}
      <section className="dash-panel dash-ads">
        <Suspense fallback={null}>
          <ADAlerts />
        </Suspense>
      </section>
      {!pilotView && <FaaRenewalAlert />}
      <div className="dash-bottom">
        {!pilotView && (
          <section className="dash-panel dash-outlook">
            <div className="dash-panel-head">
              <h2>Maintenance outlook</h2>
              <StatusPill tone={outlookCount ? "warn" : "neutral"} dot={false}>
                {outlookCount} {outlookCount === 1 ? "item" : "items"}
              </StatusPill>
            </div>
            {!due.length && (
              <div className="dash-outlook-empty">
                <strong>No approaching inspections</strong>
                <span>Missing schedules remain unverified.</span>
              </div>
            )}
            {due.map((x) => (
              <OutlookRow
                key={x.i.uuid}
                to="/inspections"
                icon={Clock}
                tone={x.status === "overdue" ? "danger" : "warn"}
                title={x.i.reference}
                sub={`${registration(x.i.aircraftUuid)} · ${x.i.description}`}
                value={dueShort(x, today)}
              >
                <PartsAvailability
                  parts={x.i.requiredParts}
                  source={{
                    kind: "inspection",
                    uuid: x.i.uuid,
                    workOrderUuid: "",
                  }}
                />
              </OutlookRow>
            ))}
            {open.map((d) => (
              <OutlookRow
                key={d.uuid}
                to="/discrepancies"
                icon={Warning}
                tone={d.deferral ? "warn" : "danger"}
                title={d.deferral ? "Deferred discrepancy" : "Open discrepancy"}
                sub={`${registration(d.aircraftUuid)} · ${d.description}`}
                value={d.deferral ? "Deferred" : "Open"}
              >
                <PartsAvailability
                  parts={d.requiredParts}
                  source={{
                    kind: "discrepancy",
                    uuid: d.uuid,
                    workOrderUuid: "",
                  }}
                />
              </OutlookRow>
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
        )}
        <section className="dash-callout">
          <div className="dash-callout-text">
            <p className="eyebrow">BEFORE YOUR NEXT FLIGHT</p>
            <h2>
              Good records.
              <br />
              Better decisions.
            </h2>
            <p className="dash-callout-body">
              Log each flight, report what you find, and keep your team informed
              — even when you’re away from a connection.
            </p>
            <p className="dash-callout-foot">
              Dashboard indicators summarize recorded data. Missing information
              never implies aircraft readiness.
            </p>
          </div>
          <AircraftArt drift className="dash-callout-art" />
        </section>
      </div>
      {flight !== null && (
        <Dialog
          title="Log a flight"
          subtitle="Saved on this device first, then synced."
          onClose={() => setFlight(null)}
          dismissOnScrim={false}
          className="dash-flight"
        >
          <FlightForm
            aircraftUuid={flight || undefined}
            onDone={() => setFlight(null)}
            onCancel={() => setFlight(null)}
          />
        </Dialog>
      )}
      {detail && (
        <AircraftDetail
          aircraft={detail}
          s={s}
          pilotView={pilotView}
          partsPlans={partsPlans}
          onClose={() => setDetailUuid(null)}
          onLog={() => {
            setDetailUuid(null);
            setFlight(detail.uuid);
          }}
        />
      )}
    </div>
  );
}

/* ─────────────────────────────── Aircraft card ───────────────────────────── */

function AircraftCard({
  aircraft: a,
  index,
  s,
  status,
  next,
  pilotView,
  favorite,
  onFavorite,
  onView,
  onLog,
  componentWarning,
  partsAttention,
}: {
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
}) {
  const headingId = `dash-reg-${a.uuid}`;
  const pct =
    next.progress === undefined
      ? undefined
      : Math.round(Math.min(1, Math.max(0, next.progress)) * 100);
  return (
    <article
      className="dash-card"
      aria-labelledby={headingId}
      style={{ "--i": index } as CSSProperties}
    >
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
        <p className="dash-card-model">
          {a.make} {a.model}
          <span className="dash-card-program">
            {" · "}
            {a.program || "No program assigned"}
          </span>
        </p>
      </header>
      {(status.reasons.length > 0 || pilotView) && (
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
      )}
      <dl className="dash-meters">
        <div>
          <dt>Total</dt>
          <dd>
            {hours(totalSeconds(a))}
            <span className="dash-unit"> h</span>
          </dd>
        </div>
        <div>
          <dt>Hobbs</dt>
          <dd>{tenths(a.currentHobbs)}</dd>
        </div>
        <div>
          <dt>Tach</dt>
          <dd>{tenths(a.currentTach)}</dd>
        </div>
        <div>
          <dt>Landings</dt>
          <dd>{a.landings.toLocaleString()}</dd>
        </div>
        {a.turbine && (
          <div>
            <dt>Cycles</dt>
            <dd>{a.cycles.toLocaleString()}</dd>
          </div>
        )}
      </dl>
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
      {partsAttention && (
        <div className="dash-card-parts">
          <StatusPill tone="warn">Parts need attention</StatusPill>
        </div>
      )}
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
    </article>
  );
}

/* ──────────────────────────── Maintenance outlook ────────────────────────── */

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

/* ───────────────────────────── Aircraft detail ───────────────────────────── */

function AircraftDetail({
  aircraft: a,
  s,
  pilotView,
  partsPlans,
  onClose,
  onLog,
}: {
  aircraft: Aircraft;
  s: Snapshot;
  pilotView: boolean;
  partsPlans: ReturnType<typeof maintenancePartsPlans>;
  onClose: () => void;
  onLog: () => void;
}) {
  const status = aircraftStatus(s, a.uuid);
  const tone = statusTone[status.level];
  const plans = partsPlans.filter((p) => p.aircraftUuid === a.uuid);
  return (
    <Dialog
      title={a.registration}
      onClose={onClose}
      className="dash-detail"
      header={
        <div className="dash-detail-hero">
          <AircraftArt opacity={0.28} className="dash-detail-art" />
          <RoundButton
            label="Close dialog"
            onNavy
            onClick={onClose}
            className="dash-detail-close"
          />
          <span className={"dash-detail-pill dash-dot-" + tone}>
            <span className="dash-detail-dot" aria-hidden="true" />
            {statusLabel[status.level]}
          </span>
          <h2>{a.registration}</h2>
          <p className="dash-detail-sub">
            {a.make} {a.model} · Serial {a.serial} ·{" "}
            {a.program || "No program assigned"}
          </p>
        </div>
      }
      footer={
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
      }
    >
      <dl className="dash-detail-stats">
        <div>
          <dt>
            {a.helicopter ? "Run-time hourmeter (console Hobbs)" : "Hobbs"}
          </dt>
          <dd>
            {hours(a.currentHobbs)}
            <span className="dash-unit"> h</span>
          </dd>
        </div>
        <div>
          <dt>Tach</dt>
          <dd>
            {hours(a.currentTach)}
            <span className="dash-unit"> h</span>
          </dd>
        </div>
        {a.flightTimeLog && (
          <div>
            <dt>Flight time log</dt>
            <dd>
              {a.currentFlightTimeLog === undefined ? (
                "Not recorded"
              ) : (
                <>
                  {hours(a.currentFlightTimeLog)}
                  <span className="dash-unit"> h</span>
                </>
              )}
            </dd>
          </div>
        )}
        {a.helicopter && a.currentCyclicHobbs !== undefined && (
          <div>
            <dt>Collective hourmeter</dt>
            <dd>
              {hours(a.currentCyclicHobbs)}
              <span className="dash-unit"> h</span>
            </dd>
          </div>
        )}
        <div>
          <dt>Landings</dt>
          <dd>{a.landings.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Tracking meter</dt>
          <dd className="dash-detail-text">{aircraftMeterLabels[a.meter]}</dd>
        </div>
      </dl>
      <section className="dash-detail-section" aria-labelledby="dash-notes">
        <h3 className="dash-detail-label" id="dash-notes">
          Status notes
        </h3>
        <ul
          className="dash-notes"
          aria-label={`${a.registration} status notes`}
        >
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
      {!pilotView && (
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
      )}
    </Dialog>
  );
}
