/**
 * Responsibility: The flight log, Sync center and change history screens.
 * Layer: UI. Screens over the workspace snapshot; holds no business rules.
 * Dependencies: src/data (store, auditHistory, pendingEntries,
 *   logbookPhotos), src/domain (model, programs, flights, flightLog,
 *   flightFluids, auditHistory), ./design, ./ui, ./recordDates,
 *   ./Discrepancies (the report dialog), and the flight, logbook photo,
 *   paper check, chart, summary and records package components.
 */
import "../styles/screens/records.css";
import { ReportDialog } from "./Discrepancies";
import { dateTime, shortDate, TIME_OPTIONS } from "./recordDates";
import { FlightFluidSummary } from "./FlightFluids";
import { WeeklySummary } from "./AuditSummary";
import { programPermission } from "../domain/programs";
import { useId, useMemo, useRef, useState, type ReactNode } from "react";
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
  CheckCircle,
  ClipboardText,
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
  WarningCircle,
  WifiSlash,
  XCircle,
} from "@phosphor-icons/react";
import { useWorkspace, type Workspace } from "../data/store";
import { useAuditHistory } from "../data/auditHistory";
import {
  HistoryRecordsContext,
  useHistoryPages,
  withHistory,
  type HistoryPages,
} from "../data/historyPages";
import { ownEntries, pendingEntriesFile } from "../data/pendingEntries";
import {
  ownPendingPhotos,
  type PendingLogbookPhoto,
} from "../data/logbookPhotos";
import { previousFlights } from "../domain/flightFluids";
import { auditActionLabel } from "../domain/auditHistory";
import { flightStatusLabels } from "../domain/flights";
import {
  FLIGHT_LOG_PAGE_SIZE,
  flightLogRows,
  type FlightLogFilters,
  type FlightStatusFilter,
} from "../domain/flightLog";
import {
  CHANGE_HISTORY_SUMMARY,
  changeHistoryPages,
  HistoryPager,
  windowSummary,
} from "./HistoryPager";
import { HISTORY_PAGE_SIZE, historyWindowMonths } from "../domain/retention";
import { ExportRecordsPackage } from "./ExportRecordsPackage";
import {
  can,
  hours,
  type Aircraft,
  type AuditEntry,
  type EngineStart,
  type Flight,
  type Snapshot,
} from "../domain/model";
import { download } from "./ui";
import {
  Dialog,
  EmptyState,
  ListCard,
  ListRow,
  NoticeBar,
  PageHeader,
  SearchField,
  Segmented,
  StatTile,
  StatsStrip,
  StatusPill,
  Toolbar,
  useBreakpoint,
  type IconType,
  type Tone,
} from "./design";
import { FlightForm } from "./FlightForm";
import { FlightLogCharts } from "./FlightLogCharts";
import { FlightSessions } from "./FlightSession";
import { FlightLogImportButton } from "./FlightLogImport";
import {
  LogbookPhotoPrompt,
  LogbookPhotoStrip,
  PendingThumbnail,
  type LogbookPhotoTarget,
} from "./LogbookPhotos";
import { PaperCheckButton } from "./PaperCheck";

const FLIGHT_PHOTO_LABEL = "Add a photo of the logbook line";

const NO_FLIGHT_FILTERS: FlightLogFilters = {
  search: "",
  aircraftUuid: "",
  status: "all",
};
const FLIGHT_FILTERS: { value: FlightStatusFilter; label: string }[] = [
  { value: "all", label: "All flights" },
  { value: "accepted", label: "Accepted" },
  { value: "review", label: "Needs review" },
  { value: "rejected", label: "Rejected" },
];
const FLIGHT_LOOKS: Record<Flight["status"], { tone: Tone; icon: IconType }> = {
  accepted: { tone: "good", icon: CheckCircle },
  review: { tone: "warn", icon: WarningCircle },
  rejected: { tone: "neutral", icon: XCircle },
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
  /** The matching flights shown so far. */
  flights: Flight[];
  /** Whether the program has any flight, matching or not. */
  anyFlights: boolean;
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
type FlightLogView = ReturnType<typeof useFlightLogView>;
type QueuedEntry = Workspace["queue"][number];

/**
 * The flight log: the program's flights, newest first, narrowed by a search,
 * an aircraft and a status, with a link to the Sync center while the user's
 * flights wait on this device.
 *
 * @returns Stacked rows on a phone, otherwise a table, of the first 50
 *   matching flights; Show more adds 50 at a time, and changing a filter
 *   starts again at 50. Under the last row, Load older adds the flights the
 *   workspace's window leaves out, filtered by aircraft and status on the
 *   server (H2); the search, the status counts and the charts cover the
 *   flights loaded, and a line under the search says so. The status counts
 *   cover every loaded flight matching the search and aircraft. Above a phone's width, two charts show the matching
 *   flights' Hobbs hours and count by week. The collective, flight time log, cycles and engine start
 *   readings show only when an aircraft or a matching flight has them. Each
 *   flight shows its logbook page photos and, with flight permission, the
 *   control to add one; a flight just saved is offered one at the top.
 *   Administrators can correct a flight, or review a held one, while
 *   connected.
 */
export function Flights() {
  const { snapshot: s, queue, online, connected } = useWorkspace();
  const [modal, setModal] = useState<"new" | Flight | null>(null),
    [saved, setSaved] = useState<LogbookPhotoTarget | null>(null);
  const view = useFlightLogView(s!);
  const log = flightLog(view.s, view, {
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
    <HistoryRecordsContext.Provider value={view.s}>
      <FlightLogHeader s={s!} onNew={() => setModal("new")} />
      {saved && (
        <LogbookPhotoPrompt target={saved} onDismiss={() => setSaved(null)} />
      )}
      <FlightSessions onFlightSaved={offerPhoto} />
      <FlightToolbar
        s={s!}
        pending={pendingFlightCount(s!, queue)}
        view={view}
      />
      <FlightLogBody view={view} log={log} />
      {modal && (
        <FlightDialog
          modal={modal}
          onSaved={offerPhoto}
          onClose={() => setModal(null)}
        />
      )}
    </HistoryRecordsContext.Provider>
  );
}

// Load older waits under the last loaded flight, after any Show more.
function FlightLogBody({ view, log }: { view: FlightLogView; log: FlightLog }) {
  const phone = useBreakpoint() === "phone";
  return (
    <>
      {!!view.filters.search && <SearchScope view={view} />}
      {!phone && <FlightLogCharts flights={view.rows.flights} />}
      <FlightList log={log} phone={phone} />
      <ShowMoreFlights view={view} />
      {view.limit >= view.rows.flights.length && (
        <HistoryPager
          pages={view.older}
          summary={windowSummary("flights", view.olderCount, "flight")}
        />
      )}
    </>
  );
}

// Changing a filter starts the list again at its first page, and the
// aircraft and status choose the older flights the server pages (H2). A page
// loaded is shown at once rather than behind another Show more.
function useFlightLogView(workspace: Snapshot) {
  const [filters, setFilters] = useState(NO_FLIGHT_FILTERS),
    [limit, setLimit] = useState(FLIGHT_LOG_PAGE_SIZE);
  const pages = useHistoryPages({
    kind: "flights",
    aircraftUuid: filters.aircraftUuid || undefined,
    status: filters.status === "all" ? undefined : filters.status,
  });
  const s = useMemo(
    () => withHistory(workspace, { ...pages.records, members: pages.members }),
    [workspace, pages.records, pages.members],
  );
  const rows = flightLogRows(s, filters);
  const older: HistoryPages = {
    ...pages,
    loadOlder: () => {
      setLimit(rows.flights.length + HISTORY_PAGE_SIZE);
      pages.loadOlder();
    },
  };
  return {
    s,
    filters,
    limit,
    rows,
    older,
    olderCount: s.flights.length - workspace.flights.length,
    change: (patch: Partial<FlightLogFilters>) => {
      setFilters({ ...filters, ...patch });
      setLimit(FLIGHT_LOG_PAGE_SIZE);
    },
    showMore: () => setLimit(limit + FLIGHT_LOG_PAGE_SIZE),
  };
}

// Columns follow every matching flight, so they stay put on Show more.
function flightLog(
  s: Snapshot,
  view: FlightLogView,
  correct: CorrectAction,
): FlightLog {
  const { flights } = view.rows;
  return {
    s,
    flights: flights.slice(0, view.limit),
    anyFlights: s.flights.length > 0,
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
      title="Flight"
      accent="log"
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
  view,
}: {
  s: Snapshot;
  pending: number;
  view: FlightLogView;
}) {
  const { filters, change } = view;
  const { counts } = view.rows;
  return (
    <Toolbar
      className="rise"
      end={!!pending && <PendingFlightsLink count={pending} />}
    >
      <SearchField
        className="rec-search"
        label="Search flights"
        placeholder="Aircraft, pilot, route, remarks or date"
        value={filters.search}
        onChange={(search) => change({ search })}
      />
      <AircraftSelect
        s={s}
        allLabel="All aircraft"
        value={filters.aircraftUuid}
        onChange={(aircraftUuid) => change({ aircraftUuid })}
      />
      <Segmented
        label="Flight status"
        value={filters.status}
        onChange={(status) => change({ status: status as FlightStatusFilter })}
        options={FLIGHT_FILTERS.map((o) => ({
          ...o,
          count: counts[o.value] || undefined,
        }))}
      />
    </Toolbar>
  );
}

// H2: the server filters older flights by aircraft and status, but the
// search reads only the flights this screen has loaded.
function SearchScope({ view }: { view: FlightLogView }) {
  const months = historyWindowMonths("flights");
  const older = view.olderCount ? ` and ${view.olderCount} older` : "";
  return (
    <p className="rec-search-scope muted">
      Search covers the flights loaded here: the last {months} months{older}.
      Load older to search further back.
    </p>
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
        {log.anyFlights
          ? "Try another search, aircraft or status."
          : "Log your first flight to start building the aircraft record."}
      </EmptyState>
    );
  if (!phone) return <FlightTable log={log} />;
  return (
    <div className="ds-rows rec-flight-cards rise">
      {log.flights.map((f) => (
        <article className="rec-flight-card" key={f.uuid}>
          <FlightCard log={log} flight={f} />
        </article>
      ))}
    </div>
  );
}

// The count line stays once the list was long enough to page, and takes focus
// when the last Show more removes the button, so keyboard focus is not lost.
function ShowMoreFlights({ view }: { view: FlightLogView }) {
  const status = useRef<HTMLParagraphElement>(null);
  const total = view.rows.flights.length;
  const shown = Math.min(view.limit, total);
  if (total <= FLIGHT_LOG_PAGE_SIZE) return null;
  const showMore = () => {
    view.showMore();
    if (shown + FLIGHT_LOG_PAGE_SIZE >= total)
      requestAnimationFrame(() => status.current?.focus());
  };
  return (
    <div className="rec-pager">
      <p ref={status} role="status" tabIndex={-1}>
        Showing {shown} of {total} flights
      </p>
      {shown < total && (
        <button type="button" className="button" onClick={showMore}>
          Show more
        </button>
      )}
    </div>
  );
}

function FlightCard({ log, flight: f }: FlightProps) {
  const aircraft = aircraftOf(log.s, f);
  const fluids = !!(f.fuel || f.oil?.length || f.checklistRun);
  return (
    <>
      <FlightCardHead log={log} flight={f} aircraft={aircraft} />
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
          className="button small rec-card-action"
        />
      )}
    </>
  );
}

function FlightCardHead({
  log,
  flight: f,
  aircraft,
}: FlightProps & { aircraft?: Aircraft }) {
  return (
    <div className="rec-flight-card-head">
      <div>
        <strong>{aircraft?.registration}</strong>
        <span className="rec-when">
          {dateTime(f.startTime)} · {pilotOf(log.s, f)}
        </span>
      </div>
      <FlightStatus flight={f} />
    </div>
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
    <section className="ds-rows rec-table-card rise">
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
        <th scope="col" className="rec-wrap">
          Fuel / oil / checklist
        </th>
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
    <StatusPill {...FLIGHT_LOOKS[flight.status]}>
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
  const [editing, setEditing] = useState<QueuedEntry | null>(null);
  const own = ownEntries(queue, s!.user.id);
  const photos = ownPendingPhotos(pendingPhotos, s!.user.id);
  const live = online && connected;
  return (
    <>
      <PageHeader
        eyebrow="DEVICE"
        title="Sync"
        accent="center"
        description="Entries recorded on this device wait here until the server acknowledges them."
        actions={<SyncActions own={own} live={live} />}
      />
      <SyncStats s={s!} own={own} photos={photos} />
      <SyncList
        s={s!}
        own={own}
        photos={photos}
        live={live}
        onEdit={setEditing}
      />
      {editing && (
        <RetryDialog s={s!} entry={editing} onClose={() => setEditing(null)} />
      )}
    </>
  );
}

function SyncList({
  s,
  own,
  photos,
  live,
  onEdit,
}: {
  s: Snapshot;
  own: QueuedEntry[];
  photos: PendingLogbookPhoto[];
  live: boolean;
  onEdit: (entry: QueuedEntry) => void;
}) {
  return (
    <ListCard className="rec-list-card">
      <SyncListHead s={s} count={own.length + photos.length} live={live} />
      {own.map((q) => (
        <QueuedEntryRow
          key={q.operation.uuid}
          s={s}
          entry={q}
          onEdit={() => onEdit(q)}
        />
      ))}
      {photos.map((p) => (
        <PendingPhotoRow key={p.key} s={s} photo={p} />
      ))}
      {!own.length && !photos.length && (
        <EmptyState title="Everything is synchronized">
          There are no pending entries for this account.
        </EmptyState>
      )}
    </ListCard>
  );
}

// Edit and retry: the failed entry's form, prefilled, saving a new entry in
// its place. A flight starts from the aircraft's readings as they are now.
function RetryDialog({
  s,
  entry,
  onClose,
}: {
  s: Snapshot;
  entry: QueuedEntry;
  onClose: () => void;
}) {
  const op = entry.operation;
  if (op.kind === "discrepancy")
    return (
      <ReportDialog
        aircraft={s.aircraft.filter((a) => can(s, a.uuid, "discrepancy"))}
        initial={op}
        replaces={op.uuid}
        onClose={onClose}
      />
    );
  return (
    <Dialog
      className="rec-dialog"
      title="Edit and retry flight"
      subtitle="Saved as a new entry in place of the failed one."
      dismissOnScrim={false}
      onClose={onClose}
    >
      <FlightForm
        aircraftUuid={op.input.aircraftUuid}
        prefill={op.input}
        dispatchOverrideReason={op.dispatchOverrideReason}
        replaces={op.uuid}
        onDone={onClose}
        onCancel={onClose}
      />
    </Dialog>
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

function QueuedEntryRow({
  s,
  entry: q,
  onEdit,
}: {
  s: Snapshot;
  entry: QueuedEntry;
  onEdit: () => void;
}) {
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
        action={
          q.error && (
            <span className="rec-entry-actions">
              <EditRetryButton onClick={onEdit} />
              <DiscardButton uuid={op.uuid} />
            </span>
          )
        }
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
  const { queue } = useWorkspace();
  const orphan = isOrphanPhoto(s, queue, photo);
  const record = photo.linkedKind === "flight" ? "flight" : "work order";
  const registration =
    s.aircraft.find((a) => a.uuid === photo.aircraftUuid)?.registration ??
    photo.aircraftUuid;
  return (
    <div className="rec-entry">
      <ListRow
        icon={Camera}
        tone={photo.error || orphan ? "danger" : "warn"}
        title={
          <>
            Logbook photo · {registration} · {programName(s, photo.programUuid)}
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
          (photo.error || orphan) && <DiscardPhotoButton photoKey={photo.key} />
        }
      />
      <PendingPhotoNotes photo={photo} orphan={orphan} record={record} />
    </div>
  );
}

function isOrphanPhoto(
  s: Snapshot,
  queue: QueuedEntry[],
  photo: PendingLogbookPhoto,
) {
  const queued = queue.some((q) => q.operation.uuid === photo.linkedUuid);
  const synced =
    s.flights.some((f) => f.uuid === photo.linkedUuid) ||
    (s.workOrders ?? []).some((w) => w.uuid === photo.linkedUuid);
  return !photo.olderRecord && !queued && !synced;
}

function DiscardPhotoButton({ photoKey }: { photoKey: string }) {
  const { syncing, discardPhoto } = useWorkspace();
  return (
    <button
      type="button"
      className="button small"
      disabled={syncing}
      onClick={() => discardPhotoEntry(photoKey, discardPhoto)}
    >
      Discard photo
    </button>
  );
}

function PendingPhotoNotes({
  photo,
  orphan,
  record,
}: {
  photo: PendingLogbookPhoto;
  orphan: boolean;
  record: string;
}) {
  return (
    <div className="rec-entry-extra">
      <PendingThumbnail photo={photo} />
      {photo.error && (
        <p role="alert" className="error">
          {photo.error}
        </p>
      )}
      {!photo.error && !orphan && (
        <p>
          {photo.olderRecord
            ? "Uploads when connected."
            : `Uploads once its ${record} has synced.`}
        </p>
      )}
      {orphan && (
        <p>
          Its {record} is not on this device or the server, so the photo cannot
          be filed.
        </p>
      )}
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

function EditRetryButton({ onClick }: { onClick: () => void }) {
  const { syncing } = useWorkspace();
  return (
    <button
      type="button"
      className="button small primary"
      disabled={syncing}
      onClick={onClick}
    >
      Edit and retry
    </button>
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
 * get the Summary tab (src/components/AuditSummary.tsx).
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
        title="Change"
        accent="history"
        description="An append-only record of submissions, corrections, and administrative changes."
        actions={
          admin && (
            <Segmented
              label="History view"
              options={[
                { value: "log", label: "Change log" },
                { value: "summary", label: "Summary" },
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
  const [aircraftUuid, setAircraftUuid] = useState("");
  const history = useAuditHistory({ aircraftUuid: aircraftUuid || undefined });
  return (
    <>
      <AircraftFilter
        s={s}
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
        <HistoryPager
          className="rec-pager"
          pages={changeHistoryPages(history)}
          summary={CHANGE_HISTORY_SUMMARY}
        />
      </ListCard>
    </>
  );
}

// A chosen aircraft offers its records package (maintenance permission only).
function AircraftFilter({
  s,
  aircraftUuid,
  onChange,
}: {
  s: Snapshot;
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
      <AircraftSelect
        s={s}
        allLabel="All aircraft and program records"
        value={aircraftUuid}
        onChange={onChange}
      />
    </Toolbar>
  );
}

function AircraftSelect({
  s,
  allLabel,
  value,
  onChange,
}: {
  s: Snapshot;
  allLabel: string;
  value: string;
  onChange: (aircraftUuid: string) => void;
}) {
  const id = useId();
  return (
    <div className="rec-select">
      <Airplane size={18} aria-hidden="true" />
      <label htmlFor={id}>Aircraft</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{allLabel}</option>
        {s.aircraft.map((a) => (
          <option key={a.uuid} value={a.uuid}>
            {a.registration}
          </option>
        ))}
      </select>
    </div>
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
