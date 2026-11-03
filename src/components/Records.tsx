import "../styles/screens/records.css";
import { isPilotView } from "../domain/pilotView";
import { RequestPartsButton } from "./PartsRequests";
import { FlightFluidSummary } from "./FlightFluids";
import { DiscrepancyParts } from "./RequiredParts";
import { LinkedTaskCards } from "./TaskCards";
import { AddToWorkOrder } from "./WorkOrders";
import { programPermission } from "../domain/programs";
import { useId, useState, type CSSProperties } from "react";
import { Link } from "@tanstack/react-router";
import {
  Airplane,
  AirplaneTakeoff,
  AirplaneTilt,
  ArrowRight,
  ArrowsClockwise,
  Books,
  Buildings,
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
import { useWorkspace } from "../data/store";
import { useAuditHistory } from "../data/auditHistory";
import { auditActionLabel } from "../domain/auditHistory";
import { flightStatusLabels } from "../domain/flights";
import { HistoryPager } from "./ManagementShared";
import {
  can,
  hours,
  type Aircraft,
  type AuditEntry,
  type Flight,
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

// Entrance stagger for cards and rows (capped so long lists settle quickly).
const stagger = (i: number) => ({ "--i": Math.min(i, 8) + 1 }) as CSSProperties;
const shortDate = (at: number | string) =>
  new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
const dateTime = (at: number | string) =>
  `${shortDate(at)} · ${new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })}`;

const flightFilters = [
  { value: "all", label: "All flights" },
  { value: "accepted", label: "Accepted" },
  { value: "review", label: "Needs review" },
  { value: "rejected", label: "Rejected" },
];
const flightTone = (f: Flight): Tone =>
  f.status === "accepted" ? "good" : f.status === "review" ? "warn" : "neutral";

function FlightStatus({ flight }: { flight: Flight }) {
  return (
    <StatusPill tone={flightTone(flight)}>
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
  return f.engineStarts?.length ? (
    <>
      {f.engineStarts.map((start) => (
        <div key={start.engine}>
          {start.engine === "single"
            ? "Engine"
            : start.engine === "left"
              ? "Left"
              : "Right"}
          :{" "}
          {start.durationSeconds === undefined
            ? "—"
            : `${start.durationSeconds} s`}{" "}
          · max EGT {start.maxEgtC === undefined ? "—" : `${start.maxEgtC} °C`}
        </div>
      ))}
    </>
  ) : (
    <>—</>
  );
}

export function Flights() {
  const { snapshot: s, queue, online, connected } = useWorkspace();
  const breakpoint = useBreakpoint();
  const [modal, setModal] = useState<"new" | Flight | null>(null),
    [filter, setFilter] = useState("all");
  const flights = [...s!.flights]
    .sort((a, b) => b.startTime.localeCompare(a.startTime))
    .filter((f) => filter === "all" || f.status === filter);
  const oilHistory = [...s!.flights]
    .filter((f) => f.status !== "rejected")
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  const previousFlights = new Map<string, Flight>();
  const latestByAircraft = new Map<string, Flight>();
  for (const flight of oilHistory) {
    const previous = latestByAircraft.get(flight.aircraftUuid);
    if (previous) previousFlights.set(flight.uuid, previous);
    latestByAircraft.set(flight.aircraftUuid, flight);
  }
  const showEngineStarts = flights.some((f) => f.engineStarts?.length);
  const showCollective =
    s!.aircraft.some((a) => a.helicopter) ||
    flights.some((f) => f.cyclicHobbsOn !== undefined);
  const showFlightTimeLog =
    s!.aircraft.some((a) => a.flightTimeLog) ||
    flights.some((f) => f.flightTimeLogOn !== undefined);
  const showCycles = s!.aircraft.some((a) => a.turbine);
  const pending = queue.filter(
    (q) =>
      q.operation.authorId === s!.user.id &&
      q.operation.programUuid === s!.activeProgramUuid &&
      q.operation.kind === "flight",
  );
  const counts: Record<string, number> = { all: s!.flights.length };
  for (const f of s!.flights) counts[f.status] = (counts[f.status] ?? 0) + 1;
  const canCorrect = programPermission(s!, "admin");
  // Status (and Correct / Review) stay pinned while the table scrolls.
  const statusClass = canCorrect ? "rec-status before-actions" : "rec-status";
  const aircraftOf = (f: Flight) =>
    s!.aircraft.find((a) => a.uuid === f.aircraftUuid);
  const pilotOf = (f: Flight) =>
    s!.members.find((m) => m.id === f.pilotId)?.name ?? "Unknown pilot";
  const correctButton = (f: Flight, className: string) =>
    canCorrect && (
      <button
        type="button"
        className={className}
        disabled={!online || !connected}
        onClick={() => setModal(f)}
      >
        {f.status === "review" ? "Review" : "Correct"}
      </button>
    );
  return (
    <>
      <PageHeader
        eyebrow="FLIGHT OPERATIONS"
        title="Flight log"
        description="Every flight recorded. Every change accounted for."
        actions={
          s!.aircraft.some((a) => can(s!, a.uuid, "flight")) && (
            <>
              <FlightLogImportButton />
              <button
                type="button"
                className="button primary"
                onClick={() => setModal("new")}
              >
                <Plus size={18} weight="bold" aria-hidden="true" /> Log a
                completed flight
              </button>
            </>
          )
        }
      />
      <FlightSessions />
      <Toolbar
        className="rise"
        end={
          !!pending.length && (
            <Link to="/sync" className="rec-sync-chip">
              <ArrowsClockwise size={16} aria-hidden="true" />
              {pending.length} flight{" "}
              {pending.length === 1 ? "entry" : "entries"} awaiting sync
              <span className="rec-sync-chip-link">
                Sync center <ArrowRight size={14} aria-hidden="true" />
              </span>
            </Link>
          )
        }
      >
        <Segmented
          label="Flight status"
          value={filter}
          onChange={setFilter}
          options={flightFilters.map((o) => ({
            ...o,
            count: counts[o.value] || undefined,
          }))}
        />
      </Toolbar>
      {!flights.length ? (
        <EmptyState title="No flights in this view">
          Log your first flight to start building the aircraft record.
        </EmptyState>
      ) : breakpoint === "phone" ? (
        <div className="rec-flight-cards">
          {flights.map((f, i) => {
            const aircraft = aircraftOf(f);
            const fluids = !!(f.fuel || f.oil?.length || f.checklistRun);
            return (
              <article
                className="rec-flight-card rise"
                style={stagger(i)}
                key={f.uuid}
              >
                <div className="rec-flight-card-head">
                  <div>
                    <strong>{aircraft?.registration}</strong>
                    <span className="rec-when">
                      {dateTime(f.startTime)} · {pilotOf(f)}
                    </span>
                  </div>
                  <FlightStatus flight={f} />
                </div>
                <dl className="rec-facts">
                  <div>
                    <dt>Route</dt>
                    <dd>
                      <Place code={f.origin} /> → <Place code={f.destination} />
                    </dd>
                  </div>
                  <div>
                    <dt>Hobbs</dt>
                    <dd>{span(f.hobbsOff, f.hobbsOn)}</dd>
                  </div>
                  <div>
                    <dt>Tach</dt>
                    <dd>{span(f.tachOff, f.tachOn)}</dd>
                  </div>
                  {showCollective && (
                    <div>
                      <dt>Collective hourmeter</dt>
                      <dd>{span(f.cyclicHobbsOff, f.cyclicHobbsOn)}</dd>
                    </div>
                  )}
                  {showFlightTimeLog && (
                    <div>
                      <dt>Flight time log</dt>
                      <dd>{span(f.flightTimeLogOff, f.flightTimeLogOn)}</dd>
                    </div>
                  )}
                  <div>
                    <dt>{showCycles ? "Landings / cycles" : "Landings"}</dt>
                    <dd>
                      <Landings flight={f} aircraft={aircraft} />
                    </dd>
                  </div>
                </dl>
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
                      <FlightFluidSummary
                        previousFlight={previousFlights.get(f.uuid)}
                        flight={f}
                        aircraft={aircraft}
                      />
                    </div>
                  </div>
                )}
                {correctButton(f, "button rec-card-action")}
              </article>
            );
          })}
        </div>
      ) : (
        <section className="rec-table-card rise" style={stagger(1)}>
          <div className="rec-table-scroll">
            <table className="rec-table">
              <thead>
                <tr>
                  <th scope="col">Aircraft · date</th>
                  <th scope="col">Route</th>
                  <th scope="col">Pilot</th>
                  <th scope="col" className="rec-num">
                    Hobbs
                  </th>
                  <th scope="col" className="rec-num">
                    Tach
                  </th>
                  {showCollective && (
                    <th scope="col" className="rec-num">
                      Collective hourmeter
                    </th>
                  )}
                  {showFlightTimeLog && (
                    <th scope="col" className="rec-num">
                      Flight time log
                    </th>
                  )}
                  <th scope="col" className="rec-num">
                    {showCycles ? "Landings / cycles" : "Landings"}
                  </th>
                  {showEngineStarts && <th scope="col">Engine starts</th>}
                  <th scope="col">Fuel / oil / checklist</th>
                  <th scope="col" className={statusClass}>
                    Status
                  </th>
                  {canCorrect && (
                    <th scope="col" className="rec-actions">
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {flights.map((f) => {
                  const aircraft = aircraftOf(f);
                  return (
                    <tr key={f.uuid}>
                      <td>
                        <strong className="rec-reg">
                          {aircraft?.registration}
                        </strong>
                        <span className="rec-when">
                          {dateTime(f.startTime)}
                        </span>
                      </td>
                      <td>
                        <span className="rec-route">
                          <Place code={f.origin} />
                          <ArrowRight size={14} aria-hidden="true" />
                          <span className="sr-only">to</span>
                          <Place code={f.destination} />
                        </span>
                      </td>
                      <td>{pilotOf(f)}</td>
                      <td className="rec-num">
                        <Reading start={f.hobbsOff} end={f.hobbsOn} />
                      </td>
                      <td className="rec-num">
                        <Reading start={f.tachOff} end={f.tachOn} />
                      </td>
                      {showCollective && (
                        <td className="rec-num">
                          <Reading
                            start={f.cyclicHobbsOff}
                            end={f.cyclicHobbsOn}
                          />
                        </td>
                      )}
                      {showFlightTimeLog && (
                        <td className="rec-num">
                          <Reading
                            start={f.flightTimeLogOff}
                            end={f.flightTimeLogOn}
                          />
                        </td>
                      )}
                      <td className="rec-num">
                        <Landings flight={f} aircraft={aircraft} />
                      </td>
                      {showEngineStarts && (
                        <td className="rec-starts">
                          <EngineStarts flight={f} />
                        </td>
                      )}
                      <td className="rec-fluids">
                        <FlightFluidSummary
                          previousFlight={previousFlights.get(f.uuid)}
                          flight={f}
                          aircraft={aircraft}
                        />
                      </td>
                      <td className={statusClass}>
                        <FlightStatus flight={f} />
                      </td>
                      {canCorrect && (
                        <td className="rec-actions">
                          {correctButton(f, "button small")}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {modal && (
        <Dialog
          className="rec-dialog"
          title={modal === "new" ? "Log a flight" : "Review flight record"}
          subtitle={
            modal === "new"
              ? "Saved on this device first, then synced."
              : undefined
          }
          dismissOnScrim={false}
          onClose={() => setModal(null)}
        >
          <FlightForm
            initial={modal === "new" ? undefined : modal}
            onDone={() => setModal(null)}
            onCancel={() => setModal(null)}
          />
        </Dialog>
      )}
    </>
  );
}

export function Discrepancies() {
  const { snapshot: s, online, connected, enqueue, backend } = useWorkspace();
  const pilotView = isPilotView(s!);
  const [adding, setAdding] = useState(false),
    [resolve, setResolve] = useState<string | null>(null),
    [defer, setDefer] = useState<string | null>(null),
    [showResolved, setShowResolved] = useState(false);
  const reports = s!.discrepancies
    .filter((d) => showResolved || d.status === "open")
    .sort((a, b) => b.createdAt - a.createdAt);
  const open = s!.discrepancies.filter((d) => d.status === "open");
  const deferred = open.filter((d) => d.deferral).length;
  const grounding = open.filter((d) => d.grounding && !d.deferral).length;
  const available = s!.aircraft.filter((a) => can(s!, a.uuid, "discrepancy"));
  return (
    <>
      <PageHeader
        eyebrow="MAINTENANCE REPORTS"
        title="Discrepancies"
        description="Report a problem from the air or on the ground. Keep the resolution on record."
        actions={
          !!available.length && (
            <button
              type="button"
              className="button primary"
              onClick={() => setAdding(true)}
            >
              <Warning size={18} weight="bold" aria-hidden="true" /> Report a
              problem
            </button>
          )
        }
      />
      <Toolbar
        className="rise"
        end={
          <Switch
            className="rec-switch"
            checked={showResolved}
            onChange={setShowResolved}
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
      {!reports.length ? (
        <EmptyState title="No open reports">
          New discrepancies will appear here.
        </EmptyState>
      ) : (
        <div className="rec-disc-grid">
          {reports.map((d, i) => {
            const isOpen = d.status === "open";
            const grounds = !!d.grounding && isOpen && !d.deferral;
            const reporter = s!.members.find((m) => m.id === d.authorId)?.name;
            const resolvable = isOpen && can(s!, d.aircraftUuid, "resolve");
            return (
              <article
                className="rec-disc-card rise"
                style={stagger(i)}
                key={d.uuid}
              >
                <div className="rec-disc-head">
                  <div className="rec-disc-id">
                    <IconTile
                      icon={isOpen ? Warning : CheckCircle}
                      tone={!isOpen ? "good" : grounds ? "danger" : "warn"}
                      size="md"
                    />
                    <div>
                      <strong>
                        {
                          s!.aircraft.find((a) => a.uuid === d.aircraftUuid)
                            ?.registration
                        }
                      </strong>
                      <span>
                        {d.flightUuid
                          ? "Linked to a flight"
                          : "Ground / standalone report"}
                      </span>
                    </div>
                  </div>
                  <div className="rec-disc-pills">
                    {grounds && (
                      <StatusPill tone="danger">Grounds aircraft</StatusPill>
                    )}
                    <StatusPill tone={isOpen ? "warn" : "good"} dot={false}>
                      <span className="rec-cap">{d.status}</span>
                    </StatusPill>
                  </div>
                </div>
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
                {d.resolution && (
                  <div className="rec-note-block rec-resolution">
                    <strong className="rec-note-label">
                      <CheckCircle size={16} weight="bold" aria-hidden="true" />
                      Resolution
                    </strong>
                    <p>{d.resolution}</p>
                    <small>
                      {s!.members.find((m) => m.id === d.resolvedBy)?.name ??
                        "Maintenance user"}{" "}
                      · {dateTime(d.resolvedAt!)}
                    </small>
                  </div>
                )}
                {!pilotView && (
                  <>
                    <DiscrepancyParts report={d} />
                    <div className="rec-disc-tools">
                      <RequestPartsButton
                        source={{
                          kind: "discrepancy",
                          uuid: d.uuid,
                          workOrderUuid: "",
                        }}
                      />
                      <LinkedTaskCards
                        aircraftUuid={d.aircraftUuid}
                        link={{ kind: "discrepancy", uuid: d.uuid }}
                      />
                      {isOpen && (
                        <AddToWorkOrder
                          aircraftUuid={d.aircraftUuid}
                          source={{ kind: "discrepancy", uuid: d.uuid }}
                        />
                      )}
                    </div>
                  </>
                )}
                {resolvable && (
                  <div className="rec-disc-actions">
                    {!d.deferral && (
                      <button
                        type="button"
                        className="button"
                        disabled={!online || !connected}
                        onClick={() => setDefer(d.uuid)}
                      >
                        <ClockCountdown size={17} aria-hidden="true" /> Defer
                        (MEL / 91.213)
                      </button>
                    )}
                    <button
                      type="button"
                      className="button soft rec-resolve"
                      disabled={!online || !connected}
                      onClick={() => setResolve(d.uuid)}
                    >
                      <Check size={17} weight="bold" aria-hidden="true" />{" "}
                      Record resolution
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
      {adding && (
        <Dialog
          className="rec-dialog"
          size="narrow"
          title="Report a problem"
          dismissOnScrim={false}
          onClose={() => setAdding(false)}
        >
          <AsyncForm
            submitLabel="Save report"
            onSubmit={async (data) => {
              await enqueue({
                kind: "discrepancy",
                uuid: crypto.randomUUID(),
                authorId: s!.user.id,
                aircraftUuid: value(data, "aircraft"),
                description: value(data, "description"),
                grounding: data.get("grounding") === "on",
              });
              setAdding(false);
            }}
          >
            <Field label="Aircraft">
              <select name="aircraft">
                {available.map((a) => (
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
                maxLength={5000}
                required
                placeholder="Describe the problem and where you noticed it."
              />
            </Field>
            <label className="checkbox">
              <input type="checkbox" name="grounding" /> Aircraft not airworthy
              until resolved
            </label>
            {!online && (
              <p className="callout">
                This report will be saved on this device and synced when
                connected.
              </p>
            )}
          </AsyncForm>
        </Dialog>
      )}
      {defer && (
        <Dialog
          className="rec-dialog"
          title="Defer discrepancy"
          dismissOnScrim={false}
          onClose={() => setDefer(null)}
        >
          <DeferDiscrepancyForm uuid={defer} onDone={() => setDefer(null)} />
        </Dialog>
      )}
      {resolve && (
        <Dialog
          className="rec-dialog"
          size="narrow"
          title="Record maintenance resolution"
          dismissOnScrim={false}
          onClose={() => setResolve(null)}
        >
          <AsyncForm
            submitLabel="Mark resolved"
            disabled={!online || !connected}
            onSubmit={async (data) => {
              await backend!.resolve(resolve, value(data, "resolution"));
              setResolve(null);
            }}
          >
            <Field label="What fixed the problem?">
              <textarea name="resolution" rows={5} maxLength={5000} required />
            </Field>
            <p className="muted">
              Your name, the time, and this explanation will remain in the
              history.
            </p>
          </AsyncForm>
        </Dialog>
      )}
    </>
  );
}

export function SyncCenter() {
  const {
    snapshot: s,
    queue,
    syncing,
    flush,
    online,
    connected,
    discard,
  } = useWorkspace();
  const own = queue.filter((q) => q.operation.authorId === s!.user.id);
  const failed = own.filter((q) => q.error).length;
  const live = online && connected;
  const programName = (uuid?: string) =>
    uuid
      ? (s!.programs?.find((p) => p.uuid === uuid)?.name ?? "another program")
      : "Unassigned records";
  const synced = new Date(s!.syncedAt);
  return (
    <>
      <PageHeader
        eyebrow="DEVICE"
        title="Sync center"
        description="Entries recorded on this device wait here until the server acknowledges them."
        actions={
          <>
            {!!own.length && (
              <button
                type="button"
                className="button"
                onClick={() =>
                  download(
                    "angel-one-pending-entries.json",
                    JSON.stringify(own, null, 2),
                  )
                }
              >
                <DownloadSimple size={18} aria-hidden="true" /> Export pending
                entries
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
        }
      />
      <StatsStrip>
        <StatTile label="Pending upload" value={own.length} />
        <StatTile label="Needs attention" value={failed} />
        <StatTile
          label="Last snapshot"
          value={
            <>
              {synced.toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
                hourCycle: "h23",
              })}
              <span className="rec-stat-date">{shortDate(s!.syncedAt)}</span>
            </>
          }
        />
      </StatsStrip>
      <ListCard className="rec-list-card">
        <div className="rec-list-head">
          <h2>
            {own.length} pending {own.length === 1 ? "entry" : "entries"}
          </h2>
          <StatusPill tone={live ? "good" : "warn"}>
            {live ? "Connected" : "Offline / reconnecting"}
          </StatusPill>
        </div>
        <p className="rec-list-note">
          Last snapshot: {synced.toLocaleString()}. Conflicting flights are sent
          to administrator review and excluded from totals.
        </p>
        {own.map((q) => {
          const op = q.operation;
          const uuid =
            op.kind === "flight" ? op.input.aircraftUuid : op.aircraftUuid;
          const otherProgram = op.programUuid !== s!.activeProgramUuid;
          return (
            <div className="rec-entry" key={op.uuid}>
              <ListRow
                icon={op.kind === "flight" ? AirplaneTakeoff : Warning}
                tone={q.error ? "danger" : "warn"}
                title={
                  <>
                    {op.kind === "flight" ? "Flight" : "Discrepancy"} ·{" "}
                    {s!.aircraft.find((a) => a.uuid === uuid)?.registration ??
                      uuid}{" "}
                    · {programName(op.programUuid)}
                  </>
                }
                sub={
                  op.kind === "flight"
                    ? `${op.input.origin || "—"} → ${op.input.destination || "—"} · ${dateTime(op.input.startTime)}`
                    : op.description
                }
                meta={dateTime(q.queuedAt)}
                badge={
                  <StatusPill tone={q.error ? "danger" : "warn"}>
                    {q.error ? "Needs attention" : "Awaiting sync"}
                  </StatusPill>
                }
                action={
                  q.error && (
                    <button
                      type="button"
                      className="button small"
                      disabled={syncing}
                      onClick={() => {
                        if (
                          !confirm(
                            "Discard this failed entry from this device? It has not reached the server and cannot be recovered. Export pending entries first if you need a copy.",
                          )
                        )
                          return;
                        discard(op.uuid).catch(() =>
                          useWorkspace.setState({
                            error: "Could not discard the entry. Try again.",
                          }),
                        );
                      }}
                    >
                      Discard entry
                    </button>
                  )
                }
              />
              <div className="rec-entry-extra">
                {otherProgram && (
                  <p>
                    Switch to {programName(op.programUuid)} to sync this entry.
                  </p>
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
            </div>
          );
        })}
        {!own.length && (
          <EmptyState title="Everything is synchronized">
            There are no pending entries for this account.
          </EmptyState>
        )}
      </ListCard>
    </>
  );
}

// Leading icon for an audit entry, from the record type in its action
// ("flight.reviewed" → flight). Unknown types fall back to the history icon.
const auditIcons: Record<string, IconType> = {
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
function auditLook(action: string): { icon: IconType; tone: Tone } {
  const [type, ...rest] = action.split(".");
  const verb = rest.join(".");
  if (/resolved|complete/.test(verb))
    return { icon: CheckCircle, tone: "good" };
  return {
    icon: auditIcons[type] ?? (verb ? PencilSimple : ClockCounterClockwise),
    tone: /deferred|held|override/.test(verb) ? "warn" : "blue",
  };
}
function AuditValues({ entry }: { entry: AuditEntry }) {
  return (
    <details>
      <summary>View recorded values</summary>
      <div className="rec-audit-values">
        <div>
          <h4>Before</h4>
          <pre>
            {entry.before
              ? JSON.stringify(JSON.parse(entry.before), null, 2)
              : "No previous value"}
          </pre>
        </div>
        <div>
          <h4>After</h4>
          <pre>
            {entry.after
              ? JSON.stringify(JSON.parse(entry.after), null, 2)
              : "No new value"}
          </pre>
        </div>
      </div>
    </details>
  );
}

export function History() {
  const { snapshot: s } = useWorkspace();
  const filterId = useId();
  const [aircraftUuid, setAircraftUuid] = useState("");
  const history = useAuditHistory({ aircraftUuid: aircraftUuid || undefined });
  return (
    <>
      <PageHeader
        eyebrow="AUDIT"
        title="Change history"
        description="An append-only record of submissions, corrections, and administrative changes."
      />
      <Toolbar className="rise">
        <div className="rec-select">
          <Airplane size={18} aria-hidden="true" />
          <label htmlFor={filterId}>Aircraft</label>
          <select
            id={filterId}
            value={aircraftUuid}
            onChange={(e) => setAircraftUuid(e.target.value)}
          >
            <option value="">All aircraft and program records</option>
            {s!.aircraft.map((a) => (
              <option key={a.uuid} value={a.uuid}>
                {a.registration}
              </option>
            ))}
          </select>
        </div>
      </Toolbar>
      {history.offline && (
        <NoticeBar tone="warn" icon={WifiSlash}>
          Showing recent changes saved on this device. Reconnect to load the
          full history.
        </NoticeBar>
      )}
      <ListCard className="rec-list-card">
        {history.entries.map((entry) => {
          const look = auditLook(entry.action);
          const registration =
            entry.aircraftUuid &&
            (s!.aircraft.find((a) => a.uuid === entry.aircraftUuid)
              ?.registration ??
              entry.aircraftUuid);
          return (
            <div className="rec-entry" key={entry.uuid}>
              <ListRow
                icon={look.icon}
                tone={look.tone}
                title={auditActionLabel(entry.action)}
                sub={
                  <>
                    {s!.members.find((m) => m.id === entry.actorId)?.name ??
                      "User"}
                    {registration && ` · ${registration}`}
                  </>
                }
                meta={new Date(entry.at).toLocaleString()}
              />
              {(entry.reason || entry.before || entry.after) && (
                <div className="rec-entry-extra">
                  {entry.reason && <p className="rec-reason">{entry.reason}</p>}
                  {(entry.before || entry.after) && (
                    <AuditValues entry={entry} />
                  )}
                </div>
              )}
            </div>
          );
        })}
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
