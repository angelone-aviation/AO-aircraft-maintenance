/**
 * Responsibility: The flight log, discrepancy reports, Sync center and change
 *   history screens.
 * Layer: UI. Screens over the workspace snapshot; holds no business rules.
 * Dependencies: src/data (store, auditHistory, pendingEntries,
 *   logbookPhotos), src/domain (model, programs, pilotView, flights,
 *   flightFluids, deferrals, auditHistory), ./design, ./ui,
 *   ./ExportRecordsPackage, ./AuditSummary and the flight, logbook photo,
 *   paper check, deferral, parts, task card and work order components.
 */
import "../styles/screens/records.css";
import { isPilotView } from "../domain/pilotView";
import { RequestPartsButton } from "./PartsRequests";
import { FlightFluidSummary } from "./FlightFluids";
import { DiscrepancyParts } from "./RequiredParts";
import { LinkedTaskCards } from "./TaskCards";
import { AddToWorkOrder } from "./WorkOrders";
import { WeeklySummary } from "./AuditSummary";
import { programPermission } from "../domain/programs";
import { useId, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  Airplane,
  AirplaneTakeoff,
  AirplaneTilt,
  ArrowRight,
  ArrowsClockwise,
  Books,
  Buildings,
  Camera,
  Check,
  CheckCircle,
  ClipboardText,
  ClockCountdown,
  ClockCounterClockwise,
  CurrencyCircleDollar,
  DownloadSimple,
  Fan,
  ListChecks,
  ListMagnifyingGlass,
  MapPin,
  PencilSimple,
  Plus,
  Stack,
  UserPlus,
  Users,
  Warning,
  WifiSlash,
} from "@phosphor-icons/react";
import { useWorkspace, type Workspace } from "../data/store";
import { useAuditHistory } from "../data/auditHistory";
import { ownEntries, pendingEntriesFile } from "../data/pendingEntries";
import {
  ownPendingPhotos,
  type PendingLogbookPhoto,
} from "../data/logbookPhotos";
import { isGroundingReport, MAX_RESOLUTION_LENGTH } from "../domain/deferrals";
import { previousFlights } from "../domain/flightFluids";
import { auditActionLabel } from "../domain/auditHistory";
import { flightStatusLabels } from "../domain/flights";
import { HistoryPager } from "./ManagementShared";
import { ExportRecordsPackage } from "./ExportRecordsPackage";
import {
  can,
  hours,
  NOTE_MAX_LENGTH,
  type Aircraft,
  type AuditEntry,
  type Discrepancy,
  type EngineStart,
  type Flight,
  type Snapshot,
} from "../domain/model";
import { AsyncForm, Field, download, value } from "./ui";
import {
  Dialog,
  EmptyState,
  IconTile,
  ListCard,
  ListRow,
  NoticeBar,
  PageHeader,
  Segmented,
  StatTile,
  StatsStrip,
  StatusPill,
  Switch,
  Toolbar,
  useBreakpoint,
  type IconType,
  type Tone,
} from "./design";
import { FlightForm } from "./FlightForm";
import { FlightSessions } from "./FlightSession";
import { DeferralStatus, DeferDiscrepancyForm } from "./Deferrals";
import { FlightLogImportButton } from "./FlightLogImport";
import {
  LogbookPhotoPrompt,
  LogbookPhotoStrip,
  PendingThumbnail,
  type LogbookPhotoTarget,
} from "./LogbookPhotos";
import { PaperCheckButton } from "./PaperCheck";

const FLIGHT_PHOTO_LABEL = "Add a photo of the logbook line";

// Cards and rows enter one after another; the cap lets long lists settle
// quickly.
const STAGGER_CAP = 8;
const TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
};
const FLIGHT_FILTERS = [
  { value: "all", label: "All flights" },
  { value: "accepted", label: "Accepted" },
  { value: "review", label: "Needs review" },
  { value: "rejected", label: "Rejected" },
];
const FLIGHT_TONES: Record<Flight["status"], Tone> = {
  accepted: "good",
  review: "warn",
  rejected: "neutral",
};
const ENGINE_LABELS: Record<EngineStart["engine"], string> = {
  single: "Engine",
  left: "Left",
  right: "Right",
};
// The audit icon follows the record type before the first dot
// ("flight.reviewed" → flight): an unknown type gets the edit icon, or the
// history icon when the action has no verb.
const AUDIT_ICONS: Record<string, IconType> = {
  flight: AirplaneTilt,
  plan: AirplaneTakeoff,
  discrepancy: Warning,
  aircraft: Airplane,
  inspection: ListMagnifyingGlass,
  component: Fan,
  stock: Stack,
  inventory: Stack,
  manual: Books,
  program: Buildings,
  user: UserPlus,
  group: Users,
  checklist: ListChecks,
  address: MapPin,
  record: ClipboardText,
  budget: CurrencyCircleDollar,
  labor: CurrencyCircleDollar,
};

/** The flight log's rows and the columns and actions they show. */
interface FlightLog {
  s: Snapshot;
  flights: Flight[];
  /** Each flight's previous accepted or held flight on its aircraft, by start
   * time: oil used is measured from it. */
  previous: Map<string, Flight>;
  columns: Record<
    "engineStarts" | "collective" | "flightTimeLog" | "cycles",
    boolean
  >;
  /** Set for administrators: Correct, or Review for a held flight. */
  correct?: CorrectAction;
}
interface CorrectAction {
  disabled: boolean;
  open: (flight: Flight) => void;
}
type FlightProps = { log: FlightLog; flight: Flight };
interface ReportActions {
  disabled: boolean;
  onDefer: (uuid: string) => void;
  onResolve: (uuid: string) => void;
}
type ReportProps = { s: Snapshot; report: Discrepancy };
type QueuedEntry = Workspace["queue"][number];

const stagger = (i: number) =>
  ({ "--i": Math.min(i, STAGGER_CAP) + 1 }) as CSSProperties;
const shortDate = (at: number | string) =>
  new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
const dateTime = (at: number | string) =>
  `${shortDate(at)} · ${new Date(at).toLocaleTimeString(undefined, TIME_OPTIONS)}`;

/**
 * The flight log: the program's flights, newest first, filtered by status,
 * with a link to the Sync center while the user's flights wait on this
 * device.
 *
 * @returns Cards on a phone, otherwise a table. The collective, flight time
 *   log, cycles and engine start readings show only when an aircraft or a
 *   listed flight has them. Each flight shows its logbook page photos and,
 *   with flight permission, the control to add one; a flight just saved is
 *   offered one at the top. Administrators can correct a flight, or review a
 *   held one, while connected.
 */
export function Flights() {
  const { snapshot: s, queue, online, connected } = useWorkspace();
  const breakpoint = useBreakpoint();
  const [modal, setModal] = useState<"new" | Flight | null>(null),
    [filter, setFilter] = useState("all"),
    [saved, setSaved] = useState<LogbookPhotoTarget | null>(null);
  const log = flightLog(s!, filter, {
    disabled: !online || !connected,
    open: setModal,
  });
  const offerPhoto = (f: { uuid: string; aircraftUuid: string }) =>
    setSaved({
      aircraftUuid: f.aircraftUuid,
      linkedKind: "flight",
      linkedUuid: f.uuid,
    });
  return (
    <>
      <FlightLogHeader s={s!} onNew={() => setModal("new")} />
      {saved && (
        <LogbookPhotoPrompt target={saved} onDismiss={() => setSaved(null)} />
      )}
      <FlightSessions onFlightSaved={offerPhoto} />
      <FlightToolbar
        s={s!}
        pending={pendingFlightCount(s!, queue)}
        filter={filter}
        onFilter={setFilter}
      />
      <FlightList log={log} phone={breakpoint === "phone"} />
      {modal && (
        <FlightDialog
          modal={modal}
          onSaved={offerPhoto}
          onClose={() => setModal(null)}
        />
      )}
    </>
  );
}

function flightLog(
  s: Snapshot,
  filter: string,
  correct: CorrectAction,
): FlightLog {
  const flights = [...s.flights]
    .sort((a, b) => b.startTime.localeCompare(a.startTime))
    .filter((f) => filter === "all" || f.status === filter);
  return {
    s,
    flights,
    previous: previousFlights(s.flights),
    columns: {
      engineStarts: flights.some((f) => f.engineStarts?.length),
      collective:
        s.aircraft.some((a) => a.helicopter) ||
        flights.some((f) => f.cyclicHobbsOn !== undefined),
      flightTimeLog:
        s.aircraft.some((a) => a.flightTimeLog) ||
        flights.some((f) => f.flightTimeLogOn !== undefined),
      cycles: s.aircraft.some((a) => a.turbine),
    },
    correct: programPermission(s, "admin") ? correct : undefined,
  };
}

function pendingFlightCount(s: Snapshot, queue: QueuedEntry[]) {
  return ownEntries(queue, s.user.id).filter(
    (q) =>
      q.operation.programUuid === s.activeProgramUuid &&
      q.operation.kind === "flight",
  ).length;
}

const aircraftOf = (s: Snapshot, f: Flight) =>
  s.aircraft.find((a) => a.uuid === f.aircraftUuid);
const pilotOf = (s: Snapshot, f: Flight) =>
  s.members.find((m) => m.id === f.pilotId)?.name ?? "Unknown pilot";
const photoTarget = (f: Flight): LogbookPhotoTarget => ({
  aircraftUuid: f.aircraftUuid,
  linkedKind: "flight",
  linkedUuid: f.uuid,
});
// Status (and Correct / Review) stay pinned while the table scrolls.
const statusClass = (log: FlightLog) =>
  log.correct ? "rec-status before-actions" : "rec-status";

function FlightLogHeader({ s, onNew }: { s: Snapshot; onNew: () => void }) {
  return (
    <PageHeader
      eyebrow="FLIGHT OPERATIONS"
      title="Flight log"
      description="Every flight recorded. Every change accounted for."
      actions={
        <>
          <PaperCheckButton state={s} />
          {s.aircraft.some((a) => can(s, a.uuid, "flight")) && (
            <>
              <FlightLogImportButton />
              <button type="button" className="button primary" onClick={onNew}>
                <Plus size={18} weight="bold" aria-hidden="true" /> Log a
                completed flight
              </button>
            </>
          )}
        </>
      }
    />
  );
}

function FlightToolbar({
  s,
  pending,
  filter,
  onFilter,
}: {
  s: Snapshot;
  pending: number;
  filter: string;
  onFilter: (filter: string) => void;
}) {
  const counts: Record<string, number> = { all: s.flights.length };
  for (const f of s.flights) counts[f.status] = (counts[f.status] ?? 0) + 1;
  return (
    <Toolbar
      className="rise"
      end={!!pending && <PendingFlightsLink count={pending} />}
    >
      <Segmented
        label="Flight status"
        value={filter}
        onChange={onFilter}
        options={FLIGHT_FILTERS.map((o) => ({
          ...o,
          count: counts[o.value] || undefined,
        }))}
      />
    </Toolbar>
  );
}

function PendingFlightsLink({ count }: { count: number }) {
  return (
    <Link to="/sync" className="rec-sync-chip">
      <ArrowsClockwise size={16} aria-hidden="true" />
      {count} flight {count === 1 ? "entry" : "entries"} awaiting sync
      <span className="rec-sync-chip-link">
        Sync center <ArrowRight size={14} aria-hidden="true" />
      </span>
    </Link>
  );
}

function FlightList({ log, phone }: { log: FlightLog; phone: boolean }) {
  if (!log.flights.length)
    return (
      <EmptyState title="No flights in this view">
        Log your first flight to start building the aircraft record.
      </EmptyState>
    );
  if (!phone) return <FlightTable log={log} />;
  return (
    <div className="rec-flight-cards">
      {log.flights.map((f, i) => (
        <article
          className="rec-flight-card rise"
          style={stagger(i)}
          key={f.uuid}
        >
          <FlightCard log={log} flight={f} />
        </article>
      ))}
    </div>
  );
}

function FlightCard({ log, flight: f }: FlightProps) {
  const aircraft = aircraftOf(log.s, f);
  const fluids = !!(f.fuel || f.oil?.length || f.checklistRun);
  return (
    <>
      <div className="rec-flight-card-head">
        <div>
          <strong>{aircraft?.registration}</strong>
          <span className="rec-when">
            {dateTime(f.startTime)} · {pilotOf(log.s, f)}
          </span>
        </div>
        <FlightStatus flight={f} />
      </div>
      <FlightFacts log={log} flight={f} aircraft={aircraft} />
      {!!f.engineStarts?.length && (
        <div className="rec-card-extra rec-starts">
          <h3>Engine starts</h3>
          <EngineStarts flight={f} />
        </div>
      )}
      {fluids && (
        <div className="rec-card-extra">
          <h3>Fuel / oil / checklist</h3>
          <div className="rec-fluids">
            <FluidSummary log={log} flight={f} aircraft={aircraft} />
          </div>
        </div>
      )}
      <div className="rec-card-extra">
        <h3>Logbook page</h3>
        <LogbookPhotoStrip target={photoTarget(f)} label={FLIGHT_PHOTO_LABEL} />
      </div>
      {log.correct && (
        <CorrectButton
          flight={f}
          correct={log.correct}
          className="button rec-card-action"
        />
      )}
    </>
  );
}

function FlightFacts({
  log,
  flight: f,
  aircraft,
}: FlightProps & { aircraft?: Aircraft }) {
  const { columns } = log;
  return (
    <dl className="rec-facts">
      <Fact term="Route">
        <Place code={f.origin} /> → <Place code={f.destination} />
      </Fact>
      <Fact term="Hobbs">{span(f.hobbsOff, f.hobbsOn)}</Fact>
      <Fact term="Tach">{span(f.tachOff, f.tachOn)}</Fact>
      {columns.collective && (
        <Fact term="Collective hourmeter">
          {span(f.cyclicHobbsOff, f.cyclicHobbsOn)}
        </Fact>
      )}
      {columns.flightTimeLog && (
        <Fact term="Flight time log">
          {span(f.flightTimeLogOff, f.flightTimeLogOn)}
        </Fact>
      )}
      <Fact term={columns.cycles ? "Landings / cycles" : "Landings"}>
        <Landings flight={f} aircraft={aircraft} />
      </Fact>
    </dl>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function FlightTable({ log }: { log: FlightLog }) {
  return (
    <section className="rec-table-card rise" style={stagger(1)}>
      <div className="rec-table-scroll">
        <table className="rec-table">
          <FlightTableHead log={log} />
          <tbody>
            {log.flights.map((f) => (
              <FlightRow key={f.uuid} log={log} flight={f} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FlightTableHead({ log }: { log: FlightLog }) {
  const { columns } = log;
  return (
    <thead>
      <tr>
        <th scope="col">Aircraft · date</th>
        <th scope="col">Route</th>
        <th scope="col">Pilot</th>
        <NumberHeading>Hobbs</NumberHeading>
        <NumberHeading>Tach</NumberHeading>
        {columns.collective && (
          <NumberHeading>Collective hourmeter</NumberHeading>
        )}
        {columns.flightTimeLog && (
          <NumberHeading>Flight time log</NumberHeading>
        )}
        <NumberHeading>
          {columns.cycles ? "Landings / cycles" : "Landings"}
        </NumberHeading>
        {columns.engineStarts && <th scope="col">Engine starts</th>}
        <th scope="col">Fuel / oil / checklist</th>
        <th scope="col">Logbook page</th>
        <th scope="col" className={statusClass(log)}>
          Status
        </th>
        {log.correct && (
          <th scope="col" className="rec-actions">
            <span className="sr-only">Actions</span>
          </th>
        )}
      </tr>
    </thead>
  );
}

function NumberHeading({ children }: { children: ReactNode }) {
  return (
    <th scope="col" className="rec-num">
      {children}
    </th>
  );
}

function FlightRow({ log, flight: f }: FlightProps) {
  const aircraft = aircraftOf(log.s, f);
  return (
    <tr>
      <td>
        <strong className="rec-reg">{aircraft?.registration}</strong>
        <span className="rec-when">{dateTime(f.startTime)}</span>
      </td>
      <RouteCell flight={f} />
      <td>{pilotOf(log.s, f)}</td>
      <ReadingCells log={log} flight={f} />
      <td className="rec-num">
        <Landings flight={f} aircraft={aircraft} />
      </td>
      {log.columns.engineStarts && (
        <td className="rec-starts">
          <EngineStarts flight={f} />
        </td>
      )}
      <td className="rec-fluids">
        <FluidSummary log={log} flight={f} aircraft={aircraft} />
      </td>
      <td className="rec-photos">
        <LogbookPhotoStrip target={photoTarget(f)} label={FLIGHT_PHOTO_LABEL} />
      </td>
      <td className={statusClass(log)}>
        <FlightStatus flight={f} />
      </td>
      {log.correct && (
        <td className="rec-actions">
          <CorrectButton
            flight={f}
            correct={log.correct}
            className="button small"
          />
        </td>
      )}
    </tr>
  );
}

function RouteCell({ flight: f }: { flight: Flight }) {
  return (
    <td>
      <span className="rec-route">
        <Place code={f.origin} />
        <ArrowRight size={14} aria-hidden="true" />
        <span className="sr-only">to</span>
        <Place code={f.destination} />
      </span>
    </td>
  );
}

function ReadingCells({ log, flight: f }: FlightProps) {
  return (
    <>
      <td className="rec-num">
        <Reading start={f.hobbsOff} end={f.hobbsOn} />
      </td>
      <td className="rec-num">
        <Reading start={f.tachOff} end={f.tachOn} />
      </td>
      {log.columns.collective && (
        <td className="rec-num">
          <Reading start={f.cyclicHobbsOff} end={f.cyclicHobbsOn} />
        </td>
      )}
      {log.columns.flightTimeLog && (
        <td className="rec-num">
          <Reading start={f.flightTimeLogOff} end={f.flightTimeLogOn} />
        </td>
      )}
    </>
  );
}

function FluidSummary({
  log,
  flight,
  aircraft,
}: FlightProps & { aircraft?: Aircraft }) {
  return (
    <FlightFluidSummary
      previousFlight={log.previous.get(flight.uuid)}
      flight={flight}
      aircraft={aircraft}
    />
  );
}

function CorrectButton({
  flight,
  correct,
  className,
}: {
  flight: Flight;
  correct: CorrectAction;
  className: string;
}) {
  return (
    <button
      type="button"
      className={className}
      disabled={correct.disabled}
      onClick={() => correct.open(flight)}
    >
      {flight.status === "review" ? "Review" : "Correct"}
    </button>
  );
}

function FlightDialog({
  modal,
  onSaved,
  onClose,
}: {
  modal: "new" | Flight;
  onSaved: (flight: { uuid: string; aircraftUuid: string }) => void;
  onClose: () => void;
}) {
  const isNew = modal === "new";
  return (
    <Dialog
      className="rec-dialog"
      title={isNew ? "Log a flight" : "Review flight record"}
      subtitle={isNew ? "Saved on this device first, then synced." : undefined}
      dismissOnScrim={false}
      onClose={onClose}
    >
      <FlightForm
        initial={isNew ? undefined : modal}
        onSaved={onSaved}
        onDone={onClose}
        onCancel={onClose}
      />
    </Dialog>
  );
}

function FlightStatus({ flight }: { flight: Flight }) {
  return (
    <StatusPill tone={FLIGHT_TONES[flight.status]}>
      <span className="rec-cap">{flightStatusLabels[flight.status]}</span>
    </StatusPill>
  );
}
// Ending reading with its starting reading beneath ("2,342.2 from 2,341.2").
function Reading({ start, end }: { start?: number; end?: number }) {
  if (start === undefined && end === undefined) return <>—</>;
  return (
    <>
      {end === undefined ? "—" : hours(end)}
      {start !== undefined && (
        <>
          {" "}
          <span className="rec-from">from {hours(start)}</span>
        </>
      )}
    </>
  );
}
// Starting → ending reading, for the phone cards.
const span = (start?: number, end?: number) =>
  `${start === undefined ? "—" : hours(start)} → ${end === undefined ? "—" : hours(end)}`;
function Place({ code }: { code: string }) {
  return code ? <>{code}</> : <span className="rec-unset">Unspecified</span>;
}
function Landings({
  flight: f,
  aircraft,
}: {
  flight: Flight;
  aircraft?: Aircraft;
}) {
  return (
    <>
      {f.landings}
      {f.landingSurface
        ? ` ${f.landingSurface === "sea" ? "Sea" : "Land"}`
        : ""}{" "}
      {aircraft?.turbine && <>/ {f.cycles}</>}
    </>
  );
}
function EngineStarts({ flight: f }: { flight: Flight }) {
  if (!f.engineStarts?.length) return <>—</>;
  return (
    <>
      {f.engineStarts.map((start) => (
        <div key={start.engine}>
          {ENGINE_LABELS[start.engine]}:{" "}
          {start.durationSeconds === undefined
            ? "—"
            : `${start.durationSeconds} s`}{" "}
          · max EGT {start.maxEgtC === undefined ? "—" : `${start.maxEgtC} °C`}
        </div>
      ))}
    </>
  );
}

/**
 * Discrepancy reports, newest first: the open ones, or all of them with
 * "Include resolved reports", under counts of open, deferred and grounding
 * reports.
 *
 * @returns The report cards. Reporting a problem queues it on this device,
 *   so it works offline; deferring and recording a resolution need a
 *   connection and the resolve permission. Pilot view leaves out the parts,
 *   task card and work order tools.
 */
export function Discrepancies() {
  const { snapshot: s, online, connected } = useWorkspace();
  const [adding, setAdding] = useState(false),
    [resolve, setResolve] = useState<string | null>(null),
    [defer, setDefer] = useState<string | null>(null),
    [showResolved, setShowResolved] = useState(false);
  const available = s!.aircraft.filter((a) => can(s!, a.uuid, "discrepancy"));
  const actions = {
    disabled: !online || !connected,
    onDefer: setDefer,
    onResolve: setResolve,
  };
  return (
    <>
      <DiscrepancyHeader
        canReport={!!available.length}
        onReport={() => setAdding(true)}
      />
      <DiscrepancyToolbar
        s={s!}
        showResolved={showResolved}
        onShowResolved={setShowResolved}
      />
      <ReportList s={s!} showResolved={showResolved} actions={actions} />
      {adding && (
        <ReportDialog aircraft={available} onClose={() => setAdding(false)} />
      )}
      {defer && <DeferDialog uuid={defer} onClose={() => setDefer(null)} />}
      {resolve && (
        <ResolveDialog uuid={resolve} onClose={() => setResolve(null)} />
      )}
    </>
  );
}

function DiscrepancyHeader({
  canReport,
  onReport,
}: {
  canReport: boolean;
  onReport: () => void;
}) {
  return (
    <PageHeader
      eyebrow="MAINTENANCE REPORTS"
      title="Discrepancies"
      description="Report a problem from the air or on the ground. Keep the resolution on record."
      actions={
        canReport && (
          <button type="button" className="button primary" onClick={onReport}>
            <Warning size={18} weight="bold" aria-hidden="true" /> Report a
            problem
          </button>
        )
      }
    />
  );
}

function DiscrepancyToolbar({
  s,
  showResolved,
  onShowResolved,
}: {
  s: Snapshot;
  showResolved: boolean;
  onShowResolved: (show: boolean) => void;
}) {
  const open = s.discrepancies.filter((d) => d.status === "open");
  const deferred = open.filter((d) => d.deferral).length;
  const grounding = open.filter(isGroundingReport).length;
  return (
    <Toolbar
      className="rise"
      end={
        <Switch
          className="rec-switch"
          checked={showResolved}
          onChange={onShowResolved}
          label="Include resolved reports"
        />
      }
    >
      <div className="rec-chips">
        <StatusPill tone="warn" className="rec-count">
          {open.length} open
        </StatusPill>
        <StatusPill tone="neutral" dot={false} className="rec-count">
          {deferred} deferred
        </StatusPill>
        {grounding > 0 && (
          <StatusPill tone="danger" className="rec-count">
            {grounding} grounding
          </StatusPill>
        )}
      </div>
    </Toolbar>
  );
}

function ReportList({
  s,
  showResolved,
  actions,
}: {
  s: Snapshot;
  showResolved: boolean;
  actions: ReportActions;
}) {
  const pilotView = isPilotView(s);
  const reports = s.discrepancies
    .filter((d) => showResolved || d.status === "open")
    .sort((a, b) => b.createdAt - a.createdAt);
  if (!reports.length)
    return (
      <EmptyState title="No open reports">
        New discrepancies will appear here.
      </EmptyState>
    );
  return (
    <div className="rec-disc-grid">
      {reports.map((d, i) => (
        <article className="rec-disc-card rise" style={stagger(i)} key={d.uuid}>
          <ReportCard
            s={s}
            report={d}
            pilotView={pilotView}
            actions={actions}
          />
        </article>
      ))}
    </div>
  );
}

function ReportCard({
  s,
  report: d,
  pilotView,
  actions,
}: ReportProps & { pilotView: boolean; actions: ReportActions }) {
  const reporter = s.members.find((m) => m.id === d.authorId)?.name;
  const resolvable = d.status === "open" && can(s, d.aircraftUuid, "resolve");
  return (
    <>
      <ReportHead s={s} report={d} />
      <p className="rec-disc-text">{d.description}</p>
      <p className="rec-disc-meta">
        {reporter ? `Reported by ${reporter} · ` : "Reported "}
        {shortDate(d.createdAt)}
      </p>
      {d.deferral && (
        <div className="rec-note-block rec-deferral">
          <DeferralStatus report={d} />
        </div>
      )}
      {d.resolution && <ResolutionNote s={s} report={d} />}
      {!pilotView && <MaintenanceTools report={d} />}
      {resolvable && <ReportButtons report={d} actions={actions} />}
    </>
  );
}

function ReportHead({ s, report: d }: ReportProps) {
  const isOpen = d.status === "open";
  const grounds = isGroundingReport(d);
  return (
    <div className="rec-disc-head">
      <div className="rec-disc-id">
        <IconTile
          icon={isOpen ? Warning : CheckCircle}
          tone={reportTone(isOpen, grounds)}
          size="md"
        />
        <div>
          <strong>
            {s.aircraft.find((a) => a.uuid === d.aircraftUuid)?.registration}
          </strong>
          <span>
            {d.flightUuid ? "Linked to a flight" : "Ground / standalone report"}
          </span>
        </div>
      </div>
      <div className="rec-disc-pills">
        {grounds && <StatusPill tone="danger">Grounds aircraft</StatusPill>}
        <StatusPill tone={isOpen ? "warn" : "good"} dot={false}>
          <span className="rec-cap">{d.status}</span>
        </StatusPill>
      </div>
    </div>
  );
}

function reportTone(isOpen: boolean, grounds: boolean): Tone {
  if (!isOpen) return "good";
  return grounds ? "danger" : "warn";
}

function ResolutionNote({ s, report: d }: ReportProps) {
  return (
    <div className="rec-note-block rec-resolution">
      <strong className="rec-note-label">
        <CheckCircle size={16} weight="bold" aria-hidden="true" />
        Resolution
      </strong>
      <p>{d.resolution}</p>
      <small>
        {s.members.find((m) => m.id === d.resolvedBy)?.name ??
          "Maintenance user"}{" "}
        · {dateTime(d.resolvedAt!)}
      </small>
    </div>
  );
}

function MaintenanceTools({ report: d }: { report: Discrepancy }) {
  const link = { kind: "discrepancy", uuid: d.uuid } as const;
  return (
    <>
      <DiscrepancyParts report={d} />
      <div className="rec-disc-tools">
        <RequestPartsButton source={{ ...link, workOrderUuid: "" }} />
        <LinkedTaskCards aircraftUuid={d.aircraftUuid} link={link} />
        {d.status === "open" && (
          <AddToWorkOrder aircraftUuid={d.aircraftUuid} source={link} />
        )}
      </div>
    </>
  );
}

function ReportButtons({
  report: d,
  actions,
}: {
  report: Discrepancy;
  actions: ReportActions;
}) {
  return (
    <div className="rec-disc-actions">
      {!d.deferral && (
        <button
          type="button"
          className="button"
          disabled={actions.disabled}
          onClick={() => actions.onDefer(d.uuid)}
        >
          <ClockCountdown size={17} aria-hidden="true" /> Defer (MEL / 91.213)
        </button>
      )}
      <button
        type="button"
        className="button soft rec-resolve"
        disabled={actions.disabled}
        onClick={() => actions.onResolve(d.uuid)}
      >
        <Check size={17} weight="bold" aria-hidden="true" /> Record resolution
      </button>
    </div>
  );
}

function ReportDialog({
  aircraft,
  onClose,
}: {
  aircraft: Aircraft[];
  onClose: () => void;
}) {
  const { snapshot: s, online, enqueue } = useWorkspace();
  return (
    <Dialog
      className="rec-dialog"
      size="narrow"
      title="Report a problem"
      dismissOnScrim={false}
      onClose={onClose}
    >
      <AsyncForm
        submitLabel="Save report"
        onSubmit={async (data) => {
          await enqueue(reportOperation(s!, data));
          onClose();
        }}
      >
        <ReportFields aircraft={aircraft} />
        {!online && (
          <p className="callout">
            This report will be saved on this device and synced when connected.
          </p>
        )}
      </AsyncForm>
    </Dialog>
  );
}

function reportOperation(s: Snapshot, data: FormData) {
  return {
    kind: "discrepancy" as const,
    uuid: crypto.randomUUID(),
    authorId: s.user.id,
    aircraftUuid: value(data, "aircraft"),
    description: value(data, "description"),
    grounding: data.get("grounding") === "on",
  };
}

function ReportFields({ aircraft }: { aircraft: Aircraft[] }) {
  return (
    <>
      <Field label="Aircraft">
        <select name="aircraft">
          {aircraft.map((a) => (
            <option key={a.uuid} value={a.uuid}>
              {a.registration}
            </option>
          ))}
        </select>
      </Field>
      <Field label="What did you observe?">
        <textarea
          name="description"
          rows={5}
          maxLength={NOTE_MAX_LENGTH}
          required
          placeholder="Describe the problem and where you noticed it."
        />
      </Field>
      <label className="checkbox">
        <input type="checkbox" name="grounding" /> Aircraft not airworthy until
        resolved
      </label>
    </>
  );
}

function DeferDialog({ uuid, onClose }: { uuid: string; onClose: () => void }) {
  return (
    <Dialog
      className="rec-dialog"
      title="Defer discrepancy"
      dismissOnScrim={false}
      onClose={onClose}
    >
      <DeferDiscrepancyForm uuid={uuid} onDone={onClose} />
    </Dialog>
  );
}

function ResolveDialog({
  uuid,
  onClose,
}: {
  uuid: string;
  onClose: () => void;
}) {
  const { backend, online, connected } = useWorkspace();
  return (
    <Dialog
      className="rec-dialog"
      size="narrow"
      title="Record maintenance resolution"
      dismissOnScrim={false}
      onClose={onClose}
    >
      <AsyncForm
        submitLabel="Mark resolved"
        disabled={!online || !connected}
        onSubmit={async (data) => {
          await backend!.resolve(uuid, value(data, "resolution"));
          onClose();
        }}
      >
        <Field label="What fixed the problem?">
          <textarea
            name="resolution"
            rows={5}
            maxLength={MAX_RESOLUTION_LENGTH}
            required
          />
        </Field>
        <p className="muted">
          Your name, the time, and this explanation will remain in the history.
        </p>
      </AsyncForm>
    </Dialog>
  );
}

/**
 * The Sync center: the signed-in user's entries waiting on this device,
 * oldest first, until the server acknowledges them.
 *
 * @returns The entries with their errors, and Export and Sync now; syncing
 *   needs a connection, and an entry from another program syncs only from
 *   that program. Discarding a failed entry asks to confirm; if it fails,
 *   the workspace error reads "Could not discard the entry. Try again."
 */
export function SyncCenter() {
  const {
    snapshot: s,
    queue,
    pendingPhotos,
    online,
    connected,
  } = useWorkspace();
  const own = ownEntries(queue, s!.user.id);
  const photos = ownPendingPhotos(pendingPhotos, s!.user.id);
  const live = online && connected;
  return (
    <>
      <PageHeader
        eyebrow="DEVICE"
        title="Sync center"
        description="Entries recorded on this device wait here until the server acknowledges them."
        actions={<SyncActions own={own} live={live} />}
      />
      <SyncStats s={s!} own={own} photos={photos} />
      <ListCard className="rec-list-card">
        <SyncListHead s={s!} count={own.length + photos.length} live={live} />
        {own.map((q) => (
          <QueuedEntryRow key={q.operation.uuid} s={s!} entry={q} />
        ))}
        {photos.map((p) => (
          <PendingPhotoRow key={p.key} s={s!} photo={p} />
        ))}
        {!own.length && !photos.length && (
          <EmptyState title="Everything is synchronized">
            There are no pending entries for this account.
          </EmptyState>
        )}
      </ListCard>
    </>
  );
}

function SyncActions({ own, live }: { own: QueuedEntry[]; live: boolean }) {
  const { snapshot: s, queue, syncing, flush } = useWorkspace();
  return (
    <>
      {!!own.length && (
        <button
          type="button"
          className="button"
          onClick={() => {
            const file = pendingEntriesFile(queue, s!.user.id);
            download(file.name, file.text);
          }}
        >
          <DownloadSimple size={18} aria-hidden="true" /> Export pending entries
        </button>
      )}
      <button
        type="button"
        className="button primary"
        disabled={!live || syncing}
        onClick={() => void flush(true)}
      >
        <ArrowsClockwise
          size={18}
          weight="bold"
          className={syncing ? "spin" : undefined}
          aria-hidden="true"
        />{" "}
        Sync now
      </button>
    </>
  );
}

function SyncStats({
  s,
  own,
  photos,
}: {
  s: Snapshot;
  own: QueuedEntry[];
  photos: PendingLogbookPhoto[];
}) {
  const synced = new Date(s.syncedAt);
  const failed = [...own, ...photos].filter((q) => q.error).length;
  return (
    <StatsStrip>
      <StatTile label="Pending upload" value={own.length + photos.length} />
      <StatTile label="Needs attention" value={failed} />
      <StatTile
        label="Last snapshot"
        value={
          <>
            {synced.toLocaleTimeString(undefined, TIME_OPTIONS)}
            <span className="rec-stat-date">{shortDate(s.syncedAt)}</span>
          </>
        }
      />
    </StatsStrip>
  );
}

function SyncListHead({
  s,
  count,
  live,
}: {
  s: Snapshot;
  count: number;
  live: boolean;
}) {
  return (
    <>
      <div className="rec-list-head">
        <h2>
          {count} pending {count === 1 ? "entry" : "entries"}
        </h2>
        <StatusPill tone={live ? "good" : "warn"}>
          {live ? "Connected" : "Offline / reconnecting"}
        </StatusPill>
      </div>
      <p className="rec-list-note">
        Last snapshot: {new Date(s.syncedAt).toLocaleString()}. Conflicting
        flights are sent to administrator review and excluded from totals.
      </p>
    </>
  );
}

function QueuedEntryRow({ s, entry: q }: { s: Snapshot; entry: QueuedEntry }) {
  const op = q.operation;
  return (
    <div className="rec-entry">
      <ListRow
        icon={op.kind === "flight" ? AirplaneTakeoff : Warning}
        tone={q.error ? "danger" : "warn"}
        title={entryTitle(s, op)}
        sub={entrySummary(op)}
        meta={dateTime(q.queuedAt)}
        badge={
          <StatusPill tone={q.error ? "danger" : "warn"}>
            {q.error ? "Needs attention" : "Awaiting sync"}
          </StatusPill>
        }
        action={q.error && <DiscardButton uuid={op.uuid} />}
      />
      <QueuedEntryDetails s={s} entry={q} />
    </div>
  );
}

function entryTitle(s: Snapshot, op: QueuedEntry["operation"]) {
  const uuid = op.kind === "flight" ? op.input.aircraftUuid : op.aircraftUuid;
  return (
    <>
      {op.kind === "flight" ? "Flight" : "Discrepancy"} ·{" "}
      {s.aircraft.find((a) => a.uuid === uuid)?.registration ?? uuid} ·{" "}
      {programName(s, op.programUuid)}
    </>
  );
}

function entrySummary(op: QueuedEntry["operation"]) {
  if (op.kind !== "flight") return op.description;
  const { origin, destination, startTime } = op.input;
  return `${origin || "—"} → ${destination || "—"} · ${dateTime(startTime)}`;
}

const programName = (s: Snapshot, uuid?: string) =>
  uuid
    ? (s.programs?.find((p) => p.uuid === uuid)?.name ?? "another program")
    : "Unassigned records";

function QueuedEntryDetails({
  s,
  entry: q,
}: {
  s: Snapshot;
  entry: QueuedEntry;
}) {
  const op = q.operation;
  return (
    <div className="rec-entry-extra">
      {op.programUuid !== s.activeProgramUuid && (
        <p>Switch to {programName(s, op.programUuid)} to sync this entry.</p>
      )}
      {q.error && (
        <p role="alert" className="error">
          {q.error}
        </p>
      )}
      <details>
        <summary>View saved entry</summary>
        <pre>{JSON.stringify(op, null, 2)}</pre>
      </details>
    </div>
  );
}

// A photo waits for its flight to reach the server; one whose flight is on
// neither this device nor the server can only be discarded.
function PendingPhotoRow({
  s,
  photo,
}: {
  s: Snapshot;
  photo: PendingLogbookPhoto;
}) {
  const { queue, syncing, discardPhoto } = useWorkspace();
  const queued = queue.some((q) => q.operation.uuid === photo.linkedUuid);
  const synced =
    s.flights.some((f) => f.uuid === photo.linkedUuid) ||
    (s.workOrders ?? []).some((w) => w.uuid === photo.linkedUuid);
  const orphan = !queued && !synced;
  const record = photo.linkedKind === "flight" ? "flight" : "work order";
  return (
    <div className="rec-entry">
      <ListRow
        icon={Camera}
        tone={photo.error || orphan ? "danger" : "warn"}
        title={
          <>
            Logbook photo ·{" "}
            {s.aircraft.find((a) => a.uuid === photo.aircraftUuid)
              ?.registration ?? photo.aircraftUuid}{" "}
            · {programName(s, photo.programUuid)}
          </>
        }
        sub={`${photo.name} · for a ${record}`}
        meta={dateTime(photo.queuedAt)}
        badge={
          <StatusPill tone={photo.error || orphan ? "danger" : "warn"}>
            {photo.error ? "Needs attention" : "Photo waiting"}
          </StatusPill>
        }
        action={
          (photo.error || orphan) && (
            <button
              type="button"
              className="button small"
              disabled={syncing}
              onClick={() => discardPhotoEntry(photo.key, discardPhoto)}
            >
              Discard photo
            </button>
          )
        }
      />
      <div className="rec-entry-extra">
        <PendingThumbnail photo={photo} />
        {photo.error && (
          <p role="alert" className="error">
            {photo.error}
          </p>
        )}
        {!photo.error && !orphan && (
          <p>Uploads once its {record} has synced.</p>
        )}
        {orphan && (
          <p>
            Its {record} is not on this device or the server, so the photo
            cannot be filed.
          </p>
        )}
      </div>
    </div>
  );
}

function discardPhotoEntry(key: string, discard: Workspace["discardPhoto"]) {
  if (
    !confirm(
      "Discard this photo from this device? It has not reached the server and cannot be recovered.",
    )
  )
    return;
  discard(key).catch(() =>
    useWorkspace.setState({ error: "Could not discard the photo. Try again." }),
  );
}

function DiscardButton({ uuid }: { uuid: string }) {
  const { syncing, discard } = useWorkspace();
  return (
    <button
      type="button"
      className="button small"
      disabled={syncing}
      onClick={() => discardEntry(uuid, discard)}
    >
      Discard entry
    </button>
  );
}

function discardEntry(uuid: string, discard: Workspace["discard"]) {
  if (
    !confirm(
      "Discard this failed entry from this device? It has not reached the server and cannot be recovered. Export pending entries first if you need a copy.",
    )
  )
    return;
  // The entry stays queued, so saying so lets the user try again.
  discard(uuid).catch(() =>
    useWorkspace.setState({
      error: "Could not discard the entry. Try again.",
    }),
  );
}

/**
 * The program's append-only change history, newest first, for all records or
 * one aircraft, loaded a page at a time; Flight Program administrators also
 * get the Weekly summary tab (src/components/AuditSummary.tsx).
 *
 * @returns The entries with their reasons and recorded values. Offline it
 *   lists only the recent changes saved on this device.
 */
export function History() {
  const { snapshot: s } = useWorkspace();
  const [tab, setTab] = useState<"log" | "summary">("log");
  const admin = programPermission(s!, "admin");
  return (
    <>
      <PageHeader
        eyebrow="AUDIT"
        title="Change history"
        description="An append-only record of submissions, corrections, and administrative changes."
        actions={
          admin && (
            <Segmented
              label="History view"
              options={[
                { value: "log", label: "Change log" },
                { value: "summary", label: "Weekly summary" },
              ]}
              value={tab}
              onChange={(value) => setTab(value as "log" | "summary")}
            />
          )
        }
      />
      {admin && tab === "summary" ? <WeeklySummary /> : <ChangeLog s={s!} />}
    </>
  );
}

function ChangeLog({ s }: { s: Snapshot }) {
  const filterId = useId();
  const [aircraftUuid, setAircraftUuid] = useState("");
  const history = useAuditHistory({ aircraftUuid: aircraftUuid || undefined });
  return (
    <>
      <AircraftFilter
        s={s}
        id={filterId}
        aircraftUuid={aircraftUuid}
        onChange={setAircraftUuid}
      />
      {history.offline && (
        <NoticeBar tone="warn" icon={WifiSlash}>
          Showing recent changes saved on this device. Reconnect to load the
          full history.
        </NoticeBar>
      )}
      <ListCard className="rec-list-card">
        {history.entries.map((entry) => (
          <AuditRow key={entry.uuid} s={s} entry={entry} />
        ))}
        {!history.entries.length && history.isDone && (
          <EmptyState title="No changes recorded yet">
            New entries and administrative changes will appear here.
          </EmptyState>
        )}
        <div className="rec-pager">
          <HistoryPager history={history} />
        </div>
      </ListCard>
    </>
  );
}

// A chosen aircraft offers its records package (maintenance permission only).
function AircraftFilter({
  s,
  id,
  aircraftUuid,
  onChange,
}: {
  s: Snapshot;
  id: string;
  aircraftUuid: string;
  onChange: (aircraftUuid: string) => void;
}) {
  return (
    <Toolbar
      className="rise"
      end={
        aircraftUuid && (
          <ExportRecordsPackage state={s} aircraftUuid={aircraftUuid} />
        )
      }
    >
      <div className="rec-select">
        <Airplane size={18} aria-hidden="true" />
        <label htmlFor={id}>Aircraft</label>
        <select
          id={id}
          value={aircraftUuid}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">All aircraft and program records</option>
          {s.aircraft.map((a) => (
            <option key={a.uuid} value={a.uuid}>
              {a.registration}
            </option>
          ))}
        </select>
      </div>
    </Toolbar>
  );
}

function AuditRow({ s, entry }: { s: Snapshot; entry: AuditEntry }) {
  const look = auditLook(entry.action);
  const registration =
    entry.aircraftUuid &&
    (s.aircraft.find((a) => a.uuid === entry.aircraftUuid)?.registration ??
      entry.aircraftUuid);
  return (
    <div className="rec-entry">
      <ListRow
        icon={look.icon}
        tone={look.tone}
        title={auditActionLabel(entry.action)}
        sub={
          <>
            {s.members.find((m) => m.id === entry.actorId)?.name ?? "User"}
            {registration && ` · ${registration}`}
          </>
        }
        meta={new Date(entry.at).toLocaleString()}
      />
      {(entry.reason || entry.before || entry.after) && (
        <div className="rec-entry-extra">
          {entry.reason && <p className="rec-reason">{entry.reason}</p>}
          {(entry.before || entry.after) && <AuditValues entry={entry} />}
        </div>
      )}
    </div>
  );
}

function auditLook(action: string): { icon: IconType; tone: Tone } {
  const [type, ...rest] = action.split(".");
  const verb = rest.join(".");
  if (/resolved|complete/.test(verb))
    return { icon: CheckCircle, tone: "good" };
  return {
    icon: AUDIT_ICONS[type] ?? (verb ? PencilSimple : ClockCounterClockwise),
    tone: /deferred|held|override/.test(verb) ? "warn" : "blue",
  };
}

function AuditValues({ entry }: { entry: AuditEntry }) {
  return (
    <details>
      <summary>View recorded values</summary>
      <div className="rec-audit-values">
        <AuditValue
          heading="Before"
          json={entry.before}
          empty="No previous value"
        />
        <AuditValue heading="After" json={entry.after} empty="No new value" />
      </div>
    </details>
  );
}

function AuditValue({
  heading,
  json,
  empty,
}: {
  heading: string;
  json?: string;
  empty: string;
}) {
  return (
    <div>
      <h4>{heading}</h4>
      <pre>{json ? JSON.stringify(JSON.parse(json), null, 2) : empty}</pre>
    </div>
  );
}
