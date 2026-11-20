/**
 * Responsibility: Start flight / End flight: verify the aircraft, save the
 *   preflight on this device, end the flight from that saved preflight, and
 *   name the flight plans whose preflight can be resumed.
 * Layer: UI. React components; sessions live in this browser's localStorage
 *   until the completed flight is queued.
 * Dependencies: react, @phosphor-icons/react, src/data/store.ts, src/domain
 *   (model, programs, flightPlans, flights, flightSession), ./FlightForm.tsx,
 *   ./PreflightMaintenance.tsx, ./FlightParts.tsx, ./design.tsx, ./ui.tsx.
 */
import { useState, type ReactNode } from "react";
import { type FlightPlan, validatePlanFlight } from "../domain/flightPlans";
import { useWorkspace } from "../data/store";
import {
  can,
  hours,
  totalSeconds,
  type Aircraft,
  type FlightInput,
  type QueuedOperation,
  type Snapshot,
} from "../domain/model";
import { activeProgram } from "../domain/programs";
import { flightOptionalEntries } from "../domain/flights";
import {
  flightSessionSchema,
  plannedFlightPrefill,
  startFlightSession,
  type FlightSession,
} from "../domain/flightSession";
import { FlightForm } from "./FlightForm";
import { PreflightMaintenance } from "./PreflightMaintenance";
import { AsyncForm } from "./ui";
import { Dialog, IconTile, NoticeBar } from "./design";
import { FlightField, FlightSection } from "./FlightParts";
import {
  AirplaneInFlight,
  AirplaneLanding,
  AirplaneTakeoff,
  ArrowLeft,
  CheckCircle,
  ClipboardText,
  CloudSlash,
  WarningCircle,
} from "@phosphor-icons/react";

const SESSIONS_KEY = "angel-one-flight-sessions";

type FlightSessionsProps = {
  plan?: FlightPlan;
  onClose?: () => void;
  onSaved?: () => void;
  /** Called with an ended flight once it is queued, before `onClose`. */
  onFlightSaved?: (flight: { uuid: string; aircraftUuid: string }) => void;
};
type Verified = { aircraft: Aircraft; at: string };
type Flow = ReturnType<typeof useSessionFlow>;
type FlowProps = { flow: Flow };
type SessionProps = FlowProps & { session: FlightSession };

/**
 * Start flight and End flight for the signed-in pilot in the active Flight
 * Program: verify an aircraft's maintenance status and meter readings, save
 * the preflight in this browser, and later end the flight from it. With a
 * flight plan, only its dialog shows: Start flight, or End flight when its
 * preflight is already saved.
 *
 * @param props.plan - Starts (or resumes) the flight for this plan.
 * @param props.onClose - Called when a dialog is closed or cancelled, and
 *   once an ended flight is saved.
 * @param props.onSaved - Called once a preflight is saved, which closes
 *   Start flight.
 * @param props.onFlightSaved - Receives an ended flight's uuid and aircraft
 *   once it is queued, so the caller can offer a logbook page photo.
 */
export function FlightSessions(props: FlightSessionsProps = {}) {
  const { snapshot: s, namespace } = useWorkspace();
  return (
    <FlightSessionsForProgram
      key={`${namespace}:${s!.user.id}:${activeProgram(s!)}:${props.plan?.uuid ?? ""}`}
      {...props}
    />
  );
}

/**
 * The flight plans whose preflight is saved in this browser for the signed-in
 * pilot and active Flight Program, and not yet logged or queued: opening such
 * a plan's flight resumes it as End flight, which needs no connection.
 *
 * @returns Their plan uuids; empty while saved preflights cannot be read.
 */
export function useResumablePlans(): ReadonlySet<string> {
  const { snapshot, namespace, queue } = useWorkspace();
  const s = snapshot!;
  const { sessions } = readSessions(sessionsKey(namespace, s));
  const plans = sessions
    .filter((f) => !isRecorded(f.uuid, s, queue))
    .map((f) => f.input.flightPlanUuid);
  return new Set(plans.filter((uuid) => uuid !== undefined));
}

function FlightSessionsForProgram(props: FlightSessionsProps) {
  const flow = useSessionFlow(props);
  return (
    <>
      {!props.plan && <SessionPanel flow={flow} />}
      {flow.starting && <StartDialog flow={flow} />}
      {flow.ending && <EndDialog flow={flow} session={flow.ending} />}
    </>
  );
}

function useSessionFlow(props: FlightSessionsProps) {
  const { snapshot, namespace, queue } = useWorkspace();
  const s = snapshot!;
  const store = useStoredSessions(sessionsKey(namespace, s));
  const dialogs = useSessionDialogs(
    store.loaded.sessions,
    props.plan,
    s,
    queue,
  );
  const pick = useAircraftPick(s, props.plan);
  const recorded = (id: string) => isRecorded(id, s, queue);
  const active = store.sessions.filter((f) => !recorded(f.uuid));
  return { ...props, s, queue, store, ...dialogs, ...pick, recorded, active };
}

// Preflights are kept per device namespace, pilot and Flight Program.
function sessionsKey(namespace: string, s: Snapshot) {
  return `${SESSIONS_KEY}:${namespace}:${s.user.id}:${activeProgram(s)}`;
}

// A session's flight is recorded once it is in the log or the outbox.
function isRecorded(id: string, s: Snapshot, queue: QueuedOperation[]) {
  return (
    s.flights.some((f) => f.uuid === id) ||
    queue.some((q) => q.operation.uuid === id)
  );
}

function useStoredSessions(key: string) {
  const [loaded] = useState(() => readSessions(key));
  const [sessions, setSessions] = useState(loaded.sessions);
  const [error, setError] = useState(loaded.error);
  // Never dismiss a preflight form until the complete draft has been stored.
  const persist = (next: FlightSession[]) => {
    localStorage.setItem(key, JSON.stringify(next));
    setSessions(next);
    setError("");
  };
  return { loaded, sessions, error, setError, persist };
}

// Unreadable sessions stay in storage untouched: starting a flight is
// disabled, so nothing overwrites a preflight someone may still recover.
function readSessions(key: string) {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? "[]");
    return { sessions: flightSessionSchema.array().parse(stored), error: "" };
  } catch {
    return {
      sessions: [] as FlightSession[],
      error:
        "Saved preflight data could not be read. It has been kept in browser storage; do not clear browser data.",
    };
  }
}

// A plan's saved preflight, unless its flight is already logged or queued,
// reopens as End flight instead of Start flight.
function useSessionDialogs(
  saved: FlightSession[],
  plan: FlightPlan | undefined,
  s: Snapshot,
  queue: QueuedOperation[],
) {
  const resumed =
    plan &&
    saved.find(
      (f) =>
        f.input.flightPlanUuid === plan.uuid && !isRecorded(f.uuid, s, queue),
    );
  const [starting, setStarting] = useState(!!plan && !resumed);
  const [ending, setEnding] = useState<FlightSession | undefined>(
    resumed || undefined,
  );
  const [verified, setVerified] = useState<Verified>();
  return { starting, setStarting, ending, setEnding, verified, setVerified };
}

function useAircraftPick(s: Snapshot, plan?: FlightPlan) {
  const aircrafts = s.aircraft.filter((a) => can(s, a.uuid, "flight"));
  const [aircraftUuid, setAircraftUuid] = useState(
    plan?.aircraftUuid ?? aircrafts[0]?.uuid ?? "",
  );
  const aircraft = aircrafts.find((a) => a.uuid === aircraftUuid);
  return { aircrafts, aircraftUuid, setAircraftUuid, aircraft };
}

function closeStart(flow: Flow) {
  flow.setStarting(false);
  flow.onClose?.();
}

function closeEnd(flow: Flow) {
  flow.setEnding(undefined);
  flow.onClose?.();
}

function cancelSession(flow: Flow, session: FlightSession) {
  if (
    !window.confirm(
      "Cancel this started flight and remove its saved preflight? No flight hours will be recorded.",
    )
  )
    return;
  try {
    flow.store.persist(
      flow.store.sessions.filter((f) => f.uuid !== session.uuid),
    );
  } catch {
    // Storage refused the write, so the preflight is still saved.
    flow.store.setError(
      "Could not remove the saved preflight. It has been kept.",
    );
  }
}

// The preflight opens from a copy of the verified readings; a later change
// to the aircraft refuses the save.
function verifyAircraft(flow: Flow) {
  const { aircraft } = flow;
  if (!aircraft) return;
  if (flow.active.some((f) => f.input.aircraftUuid === aircraft.uuid))
    throw new Error(
      "This aircraft already has saved preflight data on this device. End or cancel that flight first.",
    );
  flow.setVerified({
    aircraft: structuredClone(aircraft),
    at: new Date().toISOString(),
  });
}

function savePreflight(flow: Flow, verified: Verified, input: FlightInput) {
  const { s, queue } = flow;
  const current = s.aircraft.find((a) => a.uuid === verified.aircraft.uuid);
  if (!current || !can(s, current.uuid, "flight"))
    throw new Error("Aircraft access has changed. Reopen Start flight.");
  if (current.version !== verified.aircraft.version)
    throw new Error(
      "Aircraft readings changed. Go back and verify the latest readings.",
    );
  validatePlanFlight(s, input);
  if (
    input.flightPlanUuid &&
    queue.some(
      (q) =>
        q.operation.kind === "flight" &&
        q.operation.input.flightPlanUuid === input.flightPlanUuid,
    )
  )
    throw new Error("This flight plan already has a flight pending sync.");
  flow.store.persist([
    ...flow.store.sessions.filter((f) => !flow.recorded(f.uuid)),
    startFlightSession(verified.aircraft, input, verified.at),
  ]);
}

function finishSession(flow: Flow, session: FlightSession) {
  try {
    flow.store.persist(
      flow.store.sessions.filter((f) => f.uuid !== session.uuid),
    );
  } catch {
    // The flight is already queued; only its browser copy remains, and it is
    // hidden once the flight shows in the log or the sync queue.
    flow.store.setError(
      "Flight submitted, but browser cleanup failed. Its saved preflight will be hidden once the flight appears in the log or sync queue.",
    );
  }
  flow.setEnding(undefined);
  flow.onClose?.();
}

function ErrorNotice({ error }: { error: string }) {
  if (!error) return null;
  return (
    <NoticeBar
      tone="danger"
      icon={WarningCircle}
      role="alert"
      className="flight-notice"
    >
      {error}
    </NoticeBar>
  );
}

function SessionPanel({ flow }: FlowProps) {
  return (
    <section className="panel flight-session-panel flight-session">
      <SessionHead flow={flow} />
      <p className="flight-note">
        Preflight is saved in this browser on this device. Return here to end
        the flight. Aircraft totals update after the completed flight is
        accepted.
      </p>
      <ErrorNotice error={flow.store.error} />
      {flow.active.length > 0 && (
        <div className="flight-session-list">
          {flow.active.map((session) => (
            <SessionRow key={session.uuid} flow={flow} session={session} />
          ))}
        </div>
      )}
    </section>
  );
}

function SessionHead({ flow }: FlowProps) {
  return (
    <div className="flight-session-head">
      <IconTile icon={AirplaneTakeoff} tone="blue" />
      <div className="flight-session-intro">
        <h2>Start flight / End flight</h2>
        <p>
          Verify aircraft → flight details → preflight fuel and oil → save → end
          flight.
        </p>
      </div>
      <button
        className="button primary"
        disabled={!flow.aircrafts.length || !!flow.store.loaded.error}
        onClick={() => {
          flow.setVerified(undefined);
          flow.setStarting(true);
        }}
      >
        <AirplaneTakeoff size={17} weight="bold" aria-hidden="true" /> Start
        flight
      </button>
    </div>
  );
}

function SessionRow({ flow, session }: SessionProps) {
  const { input } = session;
  const a = flow.aircrafts.find((a) => a.uuid === input.aircraftUuid);
  return (
    <div className="flight-session-row">
      <IconTile icon={AirplaneInFlight} tone="warn" size="md" />
      <div className="flight-session-text">
        <span className="flight-session-route">
          <strong>{a?.registration ?? "Aircraft unavailable"}</strong> ·{" "}
          {input.origin || "Origin not entered"} →{" "}
          {input.destination || "Destination not entered"}
        </span>
        <small>
          Preflight saved {new Date(session.savedAt).toLocaleString()} · Opening
          Hobbs {hours(session.opening.hobbs)} h
        </small>
      </div>
      <div className="flight-session-actions">
        <button
          className="button primary small"
          disabled={!a}
          onClick={() => flow.setEnding(session)}
        >
          <AirplaneLanding size={16} weight="bold" aria-hidden="true" /> End
          flight
        </button>
        <button
          className="button small"
          onClick={() => cancelSession(flow, session)}
        >
          Cancel flight
        </button>
      </div>
    </div>
  );
}

function StartDialog({ flow }: FlowProps) {
  const { verified } = flow;
  return (
    <Dialog
      title={
        verified
          ? "Start flight · Flight information and preflight"
          : "Start flight · Verify aircraft"
      }
      subtitle="Preflight is saved in this browser on this device."
      size={verified ? "default" : "wide"}
      dismissOnScrim={false}
      onClose={() => closeStart(flow)}
    >
      {!verified ? (
        <VerifyForm flow={flow} />
      ) : (
        <PreflightStep flow={flow} verified={verified} />
      )}
    </Dialog>
  );
}

function VerifyForm({ flow }: FlowProps) {
  const { aircraft, plan } = flow;
  return (
    <div className="flight-form">
      <AsyncForm
        submitLabel="Verified — continue to flight information"
        disabled={!aircraft || !!flow.store.loaded.error}
        onClose={() => closeStart(flow)}
        onSubmit={async () => verifyAircraft(flow)}
      >
        <ErrorNotice error={flow.store.error} />
        {plan && <PlanNotice plan={plan} />}
        <div className="flight-grid">
          <FlightField label="Aircraft">
            <select
              value={flow.aircraftUuid}
              disabled={!!plan}
              onChange={(e) => flow.setAircraftUuid(e.target.value)}
            >
              {flow.aircrafts.map((a) => (
                <option key={a.uuid} value={a.uuid}>
                  {a.registration} · {a.model}
                </option>
              ))}
            </select>
          </FlightField>
        </div>
        {aircraft && (
          <AircraftCheck
            key={`${aircraft.uuid}:${aircraft.version}`}
            s={flow.s}
            aircraft={aircraft}
          />
        )}
      </AsyncForm>
    </div>
  );
}

function PlanNotice({ plan }: { plan: FlightPlan }) {
  return (
    <NoticeBar icon={ClipboardText} className="flight-notice">
      Planned flight: {plan.origin} → {plan.destination} ·{" "}
      {new Date(plan.departureAt).toLocaleString()}.{" "}
      {plan.pilotText && `Planned pilot: ${plan.pilotText}. `}
      Verify the aircraft first, then confirm the prefilled flight details.
    </NoticeBar>
  );
}

function AircraftCheck({ s, aircraft }: { s: Snapshot; aircraft: Aircraft }) {
  const { online, connected } = useWorkspace();
  return (
    <div className="flight-session-verify">
      <FlightSection title="1. Verify maintenance data">
        {!online || !connected ? (
          <NoticeBar tone="neutral" icon={CloudSlash} className="flight-notice">
            Offline · Showing the last synchronized maintenance data and meter
            readings.
          </NoticeBar>
        ) : null}
        <PreflightMaintenance aircraft={aircraft} snapshot={s} />
        <label className="flight-attest">
          <input type="checkbox" required /> I reviewed the aircraft maintenance
          status, inspection data, open discrepancies and work orders.
        </label>
      </FlightSection>
      <FlightSection title="2. Verify aircraft time data">
        <Readings aircraft={aircraft} />
        <label className="flight-attest">
          <input type="checkbox" required /> I verified these starting readings
          against the aircraft meters.
        </label>
      </FlightSection>
    </div>
  );
}

// The flight time log row keeps to the aircraft's option: the shared rule
// also counts the meter, which would add the row for an older record whose
// meter is the flight time log without the option.
function Readings({ aircraft: a }: { aircraft: Aircraft }) {
  const shown = flightOptionalEntries(a, a.meter);
  return (
    <dl className="flight-readings">
      <Reading term="Hobbs">{hours(a.currentHobbs)} h</Reading>
      <Reading term="Tach">{hours(a.currentTach)} h</Reading>
      {a.flightTimeLog && (
        <Reading term="Flight time log">
          {optionalHours(a.currentFlightTimeLog)}
        </Reading>
      )}
      {shown.cyclic && (
        <Reading term="Collective hourmeter">
          {optionalHours(a.currentCyclicHobbs)}
        </Reading>
      )}
      <Reading term="Total aircraft time">{hours(totalSeconds(a))} h</Reading>
      {a.turbine && <Reading term="Cycles">{a.cycles}</Reading>}
      <Reading term="Landings">{a.landings}</Reading>
    </dl>
  );
}

function Reading({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function optionalHours(seconds?: number) {
  return seconds === undefined ? "Not recorded" : `${hours(seconds)} h`;
}

function PreflightStep({ flow, verified }: FlowProps & { verified: Verified }) {
  const { plan, s } = flow;
  const { aircraft } = verified;
  return (
    <>
      <NoticeBar tone="good" icon={CheckCircle} className="flight-notice">
        Maintenance and starting readings verified for {aircraft.registration}.
        Enter flight information, then preflight fuel and oil. Save before
        leaving this page.
      </NoticeBar>
      <button
        className="button small flight-back"
        onClick={() => flow.setVerified(undefined)}
      >
        <ArrowLeft size={16} aria-hidden="true" /> Back to verification
      </button>
      <FlightForm
        aircraftUuid={aircraft.uuid}
        plan={plan}
        prefill={
          plan ? plannedFlightPrefill(plan, s.members, s.user.id) : undefined
        }
        openingOverride={{
          version: aircraft.version,
          hobbs: aircraft.currentHobbs,
          tach: aircraft.currentTach,
          cyclic: aircraft.currentCyclicHobbs,
          flightTimeLog: aircraft.currentFlightTimeLog,
        }}
        phase="preflight"
        onCancel={() => closeStart(flow)}
        onSavePreflight={async (input) => savePreflight(flow, verified, input)}
        onDone={() => {
          flow.setStarting(false);
          flow.onSaved?.();
        }}
      />
    </>
  );
}

function EndDialog({ flow, session }: SessionProps) {
  const turbine = flow.aircrafts.find(
    (a) => a.uuid === session.input.aircraftUuid,
  )?.turbine;
  return (
    <Dialog
      title="End flight"
      subtitle="Saved on this device first, then synced."
      dismissOnScrim={false}
      onClose={() => closeEnd(flow)}
    >
      <NoticeBar icon={AirplaneLanding} className="flight-notice">
        Your preflight data is loaded below. Confirm actual flight details and
        enter closing meter readings
        {turbine ? ", engine-start duration and maximum EGT" : ""}. Saving
        completes the flight log entry.
      </NoticeBar>
      <FlightForm
        aircraftUuid={session.input.aircraftUuid}
        prefill={session.input}
        openingOverride={session.opening}
        operationUuid={session.uuid}
        phase="end"
        onCancel={() => closeEnd(flow)}
        onSaved={flow.onFlightSaved}
        onDone={() => finishSession(flow, session)}
      />
    </Dialog>
  );
}
