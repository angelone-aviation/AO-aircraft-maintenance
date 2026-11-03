import { useState } from "react";
import { type FlightPlan, validatePlanFlight } from "../domain/flightPlans";
import { plannedFlightPrefill } from "../domain/flightSession";
import { useWorkspace } from "../data/store";
import { can, hours, totalSeconds, type Aircraft } from "../domain/model";
import { activeProgram } from "../domain/programs";
import {
  flightSessionSchema,
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

type FlightSessionsProps = {
  plan?: FlightPlan;
  onClose?: () => void;
  onSaved?: () => void;
};
export function FlightSessions(props: FlightSessionsProps = {}) {
  const { snapshot: s, namespace } = useWorkspace();
  return (
    <FlightSessionsForProgram
      key={`${namespace}:${s!.user.id}:${activeProgram(s!)}:${props.plan?.uuid ?? ""}`}
      {...props}
    />
  );
}

function FlightSessionsForProgram({
  plan,
  onClose,
  onSaved,
}: FlightSessionsProps) {
  const { snapshot: s, namespace, queue, online, connected } = useWorkspace();
  const key = `angel-one-flight-sessions:${namespace}:${s!.user.id}:${activeProgram(s!)}`;
  const [loaded] = useState(() => {
    try {
      return {
        sessions: flightSessionSchema
          .array()
          .parse(JSON.parse(localStorage.getItem(key) ?? "[]")),
        error: "",
      };
    } catch {
      return {
        sessions: [] as FlightSession[],
        error:
          "Saved preflight data could not be read. It has been kept in browser storage; do not clear browser data.",
      };
    }
  });
  const [sessions, setSessions] = useState(loaded.sessions);
  const [error, setError] = useState(loaded.error);
  const resumed =
    plan &&
    loaded.sessions.find(
      (f) =>
        f.input.flightPlanUuid === plan.uuid &&
        !s!.flights.some((flight) => flight.uuid === f.uuid) &&
        !queue.some((q) => q.operation.uuid === f.uuid),
    );
  const [starting, setStarting] = useState(!!plan && !resumed);
  const [ending, setEnding] = useState<FlightSession | undefined>(
    resumed || undefined,
  );
  const [verified, setVerified] = useState<{
    aircraft: Aircraft;
    at: string;
  }>();
  const aircrafts = s!.aircraft.filter((a) => can(s!, a.uuid, "flight"));
  const [aircraftUuid, setAircraftUuid] = useState(
    plan?.aircraftUuid ?? aircrafts[0]?.uuid ?? "",
  );
  const aircraft = aircrafts.find((a) => a.uuid === aircraftUuid);
  const recorded = (id: string) =>
    s!.flights.some((f) => f.uuid === id) ||
    queue.some((q) => q.operation.uuid === id);
  const active = sessions.filter((f) => !recorded(f.uuid));
  function persist(next: FlightSession[]) {
    // Never dismiss a preflight form until the complete draft has been stored.
    localStorage.setItem(key, JSON.stringify(next));
    setSessions(next);
    setError("");
  }
  const closeStart = () => {
    setStarting(false);
    onClose?.();
  };
  const closeEnd = () => {
    setEnding(undefined);
    onClose?.();
  };
  return (
    <>
      {!plan && (
        <section className="panel flight-session-panel flight-session">
          <div className="flight-session-head">
            <IconTile icon={AirplaneTakeoff} tone="blue" />
            <div className="flight-session-intro">
              <h2>Start flight / End flight</h2>
              <p>
                Verify aircraft → flight details → preflight fuel and oil → save
                → end flight.
              </p>
            </div>
            <button
              className="button primary"
              disabled={!aircrafts.length || !!loaded.error}
              onClick={() => {
                setVerified(undefined);
                setStarting(true);
              }}
            >
              <AirplaneTakeoff size={17} weight="bold" aria-hidden="true" />{" "}
              Start flight
            </button>
          </div>
          <p className="flight-note">
            Preflight is saved in this browser on this device. Return here to
            end the flight. Aircraft totals update after the completed flight is
            accepted.
          </p>
          {error && (
            <NoticeBar
              tone="danger"
              icon={WarningCircle}
              role="alert"
              className="flight-notice"
            >
              {error}
            </NoticeBar>
          )}
          {active.length > 0 && (
            <div className="flight-session-list">
              {active.map((session) => {
                const a = aircrafts.find(
                  (a) => a.uuid === session.input.aircraftUuid,
                );
                return (
                  <div className="flight-session-row" key={session.uuid}>
                    <IconTile icon={AirplaneInFlight} tone="warn" size="md" />
                    <div className="flight-session-text">
                      <span className="flight-session-route">
                        <strong>
                          {a?.registration ?? "Aircraft unavailable"}
                        </strong>{" "}
                        · {session.input.origin || "Origin not entered"} →{" "}
                        {session.input.destination || "Destination not entered"}
                      </span>
                      <small>
                        Preflight saved{" "}
                        {new Date(session.savedAt).toLocaleString()} · Opening
                        Hobbs {hours(session.opening.hobbs)} h
                      </small>
                    </div>
                    <div className="flight-session-actions">
                      <button
                        className="button primary small"
                        disabled={!a}
                        onClick={() => setEnding(session)}
                      >
                        <AirplaneLanding
                          size={16}
                          weight="bold"
                          aria-hidden="true"
                        />{" "}
                        End flight
                      </button>
                      <button
                        className="button small"
                        onClick={() => {
                          if (
                            !window.confirm(
                              "Cancel this started flight and remove its saved preflight? No flight hours will be recorded.",
                            )
                          )
                            return;
                          try {
                            persist(
                              sessions.filter((f) => f.uuid !== session.uuid),
                            );
                          } catch {
                            setError(
                              "Could not remove the saved preflight. It has been kept.",
                            );
                          }
                        }}
                      >
                        Cancel flight
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}
      {starting && (
        <Dialog
          title={
            verified
              ? "Start flight · Flight information and preflight"
              : "Start flight · Verify aircraft"
          }
          subtitle="Preflight is saved in this browser on this device."
          size={verified ? "default" : "wide"}
          dismissOnScrim={false}
          onClose={closeStart}
        >
          {!verified ? (
            <div className="flight-form">
              <AsyncForm
                submitLabel="Verified — continue to flight information"
                disabled={!aircraft || !!loaded.error}
                onClose={closeStart}
                onSubmit={async () => {
                  if (!aircraft) return;
                  if (
                    active.some((f) => f.input.aircraftUuid === aircraft.uuid)
                  )
                    throw new Error(
                      "This aircraft already has saved preflight data on this device. End or cancel that flight first.",
                    );
                  setVerified({
                    aircraft: structuredClone(aircraft),
                    at: new Date().toISOString(),
                  });
                }}
              >
                {error && (
                  <NoticeBar
                    tone="danger"
                    icon={WarningCircle}
                    role="alert"
                    className="flight-notice"
                  >
                    {error}
                  </NoticeBar>
                )}
                {plan && (
                  <NoticeBar icon={ClipboardText} className="flight-notice">
                    Planned flight: {plan.origin} → {plan.destination} ·{" "}
                    {new Date(plan.departureAt).toLocaleString()}.{" "}
                    {plan.pilotText && `Planned pilot: ${plan.pilotText}. `}
                    Verify the aircraft first, then confirm the prefilled flight
                    details.
                  </NoticeBar>
                )}
                <div className="flight-grid">
                  <FlightField label="Aircraft">
                    <select
                      value={aircraftUuid}
                      disabled={!!plan}
                      onChange={(e) => setAircraftUuid(e.target.value)}
                    >
                      {aircrafts.map((a) => (
                        <option key={a.uuid} value={a.uuid}>
                          {a.registration} · {a.model}
                        </option>
                      ))}
                    </select>
                  </FlightField>
                </div>
                {aircraft && (
                  <div
                    className="flight-session-verify"
                    key={`${aircraft.uuid}:${aircraft.version}`}
                  >
                    <FlightSection title="1. Verify maintenance data">
                      {!online || !connected ? (
                        <NoticeBar
                          tone="neutral"
                          icon={CloudSlash}
                          className="flight-notice"
                        >
                          Offline · Showing the last synchronized maintenance
                          data and meter readings.
                        </NoticeBar>
                      ) : null}
                      <PreflightMaintenance aircraft={aircraft} snapshot={s!} />
                      <label className="flight-attest">
                        <input type="checkbox" required /> I reviewed the
                        aircraft maintenance status, inspection data, open
                        discrepancies and work orders.
                      </label>
                    </FlightSection>
                    <FlightSection title="2. Verify aircraft time data">
                      <dl className="flight-readings">
                        <div>
                          <dt>Hobbs</dt>
                          <dd>{hours(aircraft.currentHobbs)} h</dd>
                        </div>
                        <div>
                          <dt>Tach</dt>
                          <dd>{hours(aircraft.currentTach)} h</dd>
                        </div>
                        {aircraft.flightTimeLog && (
                          <div>
                            <dt>Flight time log</dt>
                            <dd>
                              {aircraft.currentFlightTimeLog === undefined
                                ? "Not recorded"
                                : `${hours(aircraft.currentFlightTimeLog)} h`}
                            </dd>
                          </div>
                        )}
                        {(aircraft.helicopter ||
                          aircraft.meter === "cyclic") && (
                          <div>
                            <dt>Collective hourmeter</dt>
                            <dd>
                              {aircraft.currentCyclicHobbs === undefined
                                ? "Not recorded"
                                : `${hours(aircraft.currentCyclicHobbs)} h`}
                            </dd>
                          </div>
                        )}
                        <div>
                          <dt>Total aircraft time</dt>
                          <dd>{hours(totalSeconds(aircraft))} h</dd>
                        </div>
                        {aircraft.turbine && (
                          <div>
                            <dt>Cycles</dt>
                            <dd>{aircraft.cycles}</dd>
                          </div>
                        )}
                        <div>
                          <dt>Landings</dt>
                          <dd>{aircraft.landings}</dd>
                        </div>
                      </dl>
                      <label className="flight-attest">
                        <input type="checkbox" required /> I verified these
                        starting readings against the aircraft meters.
                      </label>
                    </FlightSection>
                  </div>
                )}
              </AsyncForm>
            </div>
          ) : (
            <>
              <NoticeBar
                tone="good"
                icon={CheckCircle}
                className="flight-notice"
              >
                Maintenance and starting readings verified for{" "}
                {verified.aircraft.registration}. Enter flight information, then
                preflight fuel and oil. Save before leaving this page.
              </NoticeBar>
              <button
                className="button small flight-back"
                onClick={() => setVerified(undefined)}
              >
                <ArrowLeft size={16} aria-hidden="true" /> Back to verification
              </button>
              <FlightForm
                aircraftUuid={verified.aircraft.uuid}
                plan={plan}
                prefill={
                  plan
                    ? plannedFlightPrefill(plan, s!.members, s!.user.id)
                    : undefined
                }
                openingOverride={{
                  version: verified.aircraft.version,
                  hobbs: verified.aircraft.currentHobbs,
                  tach: verified.aircraft.currentTach,
                  cyclic: verified.aircraft.currentCyclicHobbs,
                  flightTimeLog: verified.aircraft.currentFlightTimeLog,
                }}
                phase="preflight"
                onCancel={closeStart}
                onSavePreflight={async (input) => {
                  const current = s!.aircraft.find(
                    (a) => a.uuid === verified.aircraft.uuid,
                  );
                  if (!current || !can(s!, current.uuid, "flight"))
                    throw new Error(
                      "Aircraft access has changed. Reopen Start flight.",
                    );
                  if (current.version !== verified.aircraft.version)
                    throw new Error(
                      "Aircraft readings changed. Go back and verify the latest readings.",
                    );
                  validatePlanFlight(s!, input);
                  if (
                    input.flightPlanUuid &&
                    queue.some(
                      (q) =>
                        q.operation.kind === "flight" &&
                        q.operation.input.flightPlanUuid ===
                          input.flightPlanUuid,
                    )
                  )
                    throw new Error(
                      "This flight plan already has a flight pending sync.",
                    );
                  persist([
                    ...sessions.filter((f) => !recorded(f.uuid)),
                    startFlightSession(verified.aircraft, input, verified.at),
                  ]);
                }}
                onDone={() => {
                  setStarting(false);
                  onSaved?.();
                }}
              />
            </>
          )}
        </Dialog>
      )}
      {ending && (
        <Dialog
          title="End flight"
          subtitle="Saved on this device first, then synced."
          dismissOnScrim={false}
          onClose={closeEnd}
        >
          <NoticeBar icon={AirplaneLanding} className="flight-notice">
            Your preflight data is loaded below. Confirm actual flight details
            and enter closing meter readings
            {aircrafts.find((a) => a.uuid === ending.input.aircraftUuid)
              ?.turbine
              ? ", engine-start duration and maximum EGT"
              : ""}
            . Saving completes the flight log entry.
          </NoticeBar>
          <FlightForm
            aircraftUuid={ending.input.aircraftUuid}
            prefill={ending.input}
            openingOverride={ending.opening}
            operationUuid={ending.uuid}
            phase="end"
            onCancel={closeEnd}
            onDone={() => {
              try {
                persist(sessions.filter((f) => f.uuid !== ending.uuid));
              } catch {
                setError(
                  "Flight submitted, but browser cleanup failed. Its saved preflight will be hidden once the flight appears in the log or sync queue.",
                );
              }
              setEnding(undefined);
              onClose?.();
            }}
          />
        </Dialog>
      )}
    </>
  );
}
