/**
 * Responsibility: The guided flight: checklists, engine start and shutdown
 *   readings, paused flights kept on this device, and the flight log review.
 * Layer: UI. React components; flight rules live in src/domain.
 * Dependencies: react, @phosphor-icons/react, src/data/store.ts, src/domain
 *   (flightFluids, model, programs, checklists, guidedFlight, flights,
 *   readings, aircraftStatus), ./Checklists, ./FlightFluids, ./FlightForm,
 *   ./FlightParts, ./AircraftStatus, ./design, ./ui.
 */
import { oilLevelLabel } from "../domain/flightFluids";
import { useEffect, useState } from "react";
import { useWorkspace } from "../data/store";
import { can, aircraftMeterLabels, type FlightInput } from "../domain/model";
import { activeProgram } from "../domain/programs";
import { checklistReadable, type ChecklistRecord } from "../domain/checklists";
import {
  suggestedStartSection,
  guidedDraftSchema,
  guidedFlightLink,
  type GuidedDraft,
} from "../domain/guidedFlight";
import { validateFlight } from "../domain/flights";
import { parseHours, readingText } from "../domain/readings";
import { ChecklistReader } from "./Checklists";
import { FlightFluidFields } from "./FlightFluids";
import { FlightForm } from "./FlightForm";
import { Dialog, IconTile, NoticeBar, Switch } from "./design";
import { FlightField, FlightTimeStrip, MeterBox } from "./FlightParts";
import {
  AirplaneTakeoff,
  ClipboardText,
  DownloadSimple,
  Engine,
  Info,
  ListChecks,
  Pause,
  PauseCircle,
  Play,
  Power,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import { aircraftStatus } from "../domain/aircraftStatus";
import { DispatchGate, dispatchBlocked } from "./AircraftStatus";
import { errorText } from "./ui";
export function GuidedFlight({
  records,
  selectedChecklist,
  onSelectChecklist,
}: {
  records: ChecklistRecord[];
  selectedChecklist?: ChecklistRecord;
  onSelectChecklist?: (uuid: string) => void;
}) {
  const { snapshot: s, namespace, queue } = useWorkspace();
  const key = `angel-one-guided:${namespace}:${s!.user.id}:${activeProgram(s!)}`;
  const [loaded] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return {
        draft: raw ? guidedDraftSchema.parse(JSON.parse(raw)) : undefined,
        paused: guidedDraftSchema
          .array()
          .parse(JSON.parse(localStorage.getItem(`${key}:paused`) ?? "[]")),
        enabled: localStorage.getItem(`${key}:enabled`) === "true",
        error: "",
      };
    } catch {
      return {
        draft: undefined,
        paused: [] as GuidedDraft[],
        enabled: false,
        error:
          "The saved guided draft could not be loaded. It has not been overwritten. Export the saved draft before starting again.",
      };
    }
  });
  const [enabled, setEnabled] = useState(loaded.enabled);
  const [draft, setDraft] = useState<GuidedDraft | undefined>(loaded.draft);
  const [paused, setPaused] = useState(() =>
    loaded.paused.filter((d) => d.uuid !== loaded.draft?.uuid),
  );
  const [error, setError] = useState(loaded.error);
  const [review, setReview] = useState<Partial<FlightInput>>();
  const [message, setMessage] = useState("");
  const [section, setSection] = useState("");
  const aircrafts = s!.aircraft.filter((a) => can(s!, a.uuid, "flight"));
  const [aircraftId, setAircraft] = useState(aircrafts[0]?.uuid ?? "");
  const [planId, setPlan] = useState("");
  const [checklistId, setChecklist] = useState("");
  const [preflight, setPreflight] = useState("");
  const [startSection, setStartSection] = useState<string>();
  const [shutdown, setShutdown] = useState("");
  const [override, setOverride] = useState("");
  const selectionKey = selectedChecklist
    ? `${selectedChecklist.uuid}:${selectedChecklist.version}:${selectedChecklist.aircraftUuid}`
    : "";
  useEffect(() => {
    // A running flight retains its captured checklist and readings until explicitly finished/discarded.
    if (draft || !selectedChecklist) return;
    setChecklist(selectedChecklist.uuid);
    if (selectedChecklist.aircraftUuid) {
      setAircraft(selectedChecklist.aircraftUuid);
      setPlan("");
    }
    setPreflight("");
    setShutdown("");
    setStartSection(undefined);
  }, [selectionKey, draft?.uuid]);

  const usedPlans = new Set([
    ...paused.map((d) => d.plan.uuid),
    ...s!.flights
      .filter((f) => f.status !== "rejected")
      .map((f) => f.flightPlanUuid),
    ...queue.flatMap((q) =>
      q.operation.kind === "flight" ? [q.operation.input.flightPlanUuid] : [],
    ),
  ]);
  const plans = (s!.flightPlans ?? []).filter(
    (p) =>
      p.aircraftUuid === aircraftId &&
      p.status === "proposed" &&
      !usedPlans.has(p.uuid),
  );
  const plan = plans.find((p) => p.uuid === planId) ?? plans[0];
  const compatible = records.filter(
    (r) => !r.aircraftUuid || r.aircraftUuid === aircraftId,
  );
  const checklist =
    compatible.find((r) => r.uuid === checklistId) ?? compatible[0];
  const lists =
    checklist?.document.payload.groups.flatMap((c) =>
      c.items.flatMap((g) => g.items),
    ) ?? [];
  const startId =
    startSection === "" || lists.some((l) => l.objectId === startSection)
      ? startSection!
      : suggestedStartSection(lists);
  const draftLists =
    draft?.checklist.document.payload.groups.flatMap((c) =>
      c.items.flatMap((g) => g.items),
    ) ?? [];
  const draftStartId = draft?.startList ?? suggestedStartSection(draftLists);
  const preflightId = lists.some((l) => l.objectId === preflight)
    ? preflight
    : ((
        lists.find((l) => /pre.?flight|before.*start/i.test(l.title ?? "")) ??
        lists[0]
      )?.objectId ?? "");
  const shutdownId = lists.some((l) => l.objectId === shutdown)
    ? shutdown
    : ((
        lists.find((l) => /shut.?down|after.*flight/i.test(l.title ?? "")) ??
        lists.at(-1)
      )?.objectId ?? "");
  const aircraft = s!.aircraft.find(
    (a) => a.uuid === (draft?.aircraftUuid ?? aircraftId),
  );
  const savedFlight = draft && s!.flights.find((f) => f.uuid === draft.uuid);
  const queued = draft && queue.some((q) => q.operation.uuid === draft.uuid);
  const currentChecklist =
    draft && records.find((r) => r.uuid === draft.checklist.uuid);
  const available =
    !draft ||
    (!!aircraft &&
      can(s!, aircraft.uuid, "flight") &&
      !!currentChecklist &&
      checklistReadable(s!, currentChecklist) &&
      (!currentChecklist.aircraftUuid ||
        currentChecklist.aircraftUuid === aircraft.uuid));
  function persist(next: GuidedDraft | undefined) {
    try {
      if (next) localStorage.setItem(key, JSON.stringify(next));
      else localStorage.removeItem(key);
      setError("");
    } catch {
      setError(
        "Browser storage failed. Keep this page open and export the draft before leaving; recent changes may not survive a reload.",
      );
    }
    setDraft(next);
  }
  function pauseFlight() {
    if (!draft) return;
    const next = [...paused.filter((d) => d.uuid !== draft.uuid), draft];
    try {
      // Save the backup before removing the active draft.
      localStorage.setItem(`${key}:paused`, JSON.stringify(next));
      localStorage.removeItem(key);
      setPaused(next);
      setDraft(undefined);
      setReview(undefined);
      setSection("");
      setError("");
      setMessage(
        "Flight paused. Its readings and checkmarks are saved in this browser. Select another aircraft or checklist below.",
      );
    } catch {
      setError(
        "Could not pause the flight. Your active draft is still open; export it before leaving.",
      );
    }
  }
  function resumeFlight(saved: GuidedDraft) {
    const next = paused.filter((d) => d.uuid !== saved.uuid);
    try {
      localStorage.setItem(key, JSON.stringify(saved));
      localStorage.setItem(`${key}:paused`, JSON.stringify(next));
      setPaused(next);
      setDraft(saved);
      setReview(undefined);
      setSection(saved.preflightList);
      onSelectChecklist?.(saved.checklist.uuid);
      setError("");
      setMessage("");
    } catch {
      setError("Could not resume the saved flight. Its draft has been kept.");
    }
  }
  const update = (patch: Partial<GuidedDraft>) =>
    draft && persist({ ...draft, ...patch });
  const latest =
    aircraft &&
    [...s!.flights]
      .filter(
        (f) => f.aircraftUuid === aircraft.uuid && f.status === "accepted",
      )
      .sort((a, b) => b.startTime.localeCompare(a.startTime))[0];
  function exportDraft() {
    const raw = draft
      ? JSON.stringify(draft, null, 2)
      : localStorage.getItem(key);
    if (!raw) return;
    const url = URL.createObjectURL(
      new Blob([raw], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "guided-flight-draft.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const fluidPanel = (phase: "preflight" | "shutdown") =>
    draft && (
      <FlightFluidFields
        fluids={draft}
        twin={aircraft?.twin}
        phase={phase}
        required
        onChange={update}
      />
    );
  const preflightPanel = draft && (
    <section className="guided-readings flight-guided-readings">
      <div className="flight-section-head">
        <h3 className="flight-section-title">
          Preflight flight-log verification
        </h3>
      </div>
      <p className="flight-note">
        Compare these last recorded readings with the aircraft. If they differ,
        resolve the flight log before confirming.
      </p>
      <dl className="flight-readings">
        <div>
          <dt>Hobbs</dt>
          <dd>{readingText(draft.opening.hobbs)} hr</dd>
        </div>
        <div>
          <dt>Tach</dt>
          <dd>{readingText(draft.opening.tach)} hr</dd>
        </div>
        {aircraft?.flightTimeLog &&
          draft.opening.flightTimeLog !== undefined && (
            <div>
              <dt>Flight time log</dt>
              <dd>{readingText(draft.opening.flightTimeLog)} hr</dd>
            </div>
          )}
        {draft.opening.cyclic !== undefined && (
          <div>
            <dt>Cyclic</dt>
            <dd>{readingText(draft.opening.cyclic)} hr</dd>
          </div>
        )}
      </dl>
      {latest && (
        <p className="flight-note">
          Last accepted flight: {new Date(latest.startTime).toLocaleString()}.
          Shutdown fuel: {latest.fuel?.end ?? "not recorded"}{" "}
          {latest.fuel?.unit ?? ""}
          {latest.oil
            ?.map(
              (o) =>
                ` · ${o.engine} starting oil: ${oilLevelLabel(o, o.start)}`,
            )
            .join("")}
          . Take fresh physical readings below.
        </p>
      )}
      <label className="flight-attest">
        <input
          type="checkbox"
          checked={!!draft.metersVerifiedAt}
          onChange={(e) =>
            update({
              metersVerifiedAt: e.target.checked
                ? new Date().toISOString()
                : undefined,
            })
          }
        />{" "}
        I verified the starting meter readings against the aircraft
      </label>
      {fluidPanel("preflight")}
    </section>
  );
  const enginePositions = aircraft?.twin
    ? (["left", "right"] as const)
    : (["single"] as const);
  const startPanel = draft && aircraft?.turbine && (
    <section
      className="guided-readings flight-guided-readings"
      aria-label="Engine start readings"
    >
      <div className="flight-section-head">
        <h3 className="flight-section-title">Engine start readings</h3>
      </div>
      <p className="flight-note">
        Optional · Record start duration in seconds and maximum EGT in °C for
        this start.
      </p>
      <div className="flight-engines">
        {enginePositions.map((engine) => {
          const reading = draft.engineStarts?.find((r) => r.engine === engine);
          const prefix =
            engine === "single" ? "" : engine === "left" ? "Left " : "Right ";
          const setReading = (
            key: "durationSeconds" | "maxEgtC",
            value: string,
          ) =>
            update({
              engineStarts: enginePositions.map((position) => ({
                ...draft.engineStarts?.find((r) => r.engine === position),
                engine: position,
                ...(position === engine
                  ? { [key]: value === "" ? undefined : Number(value) }
                  : {}),
              })),
            });
          return (
            <div className="flight-grid flight-engine" key={engine}>
              <FlightField
                label={`${prefix}Start time (seconds)`}
                hint="Engine-start duration"
              >
                <input
                  type="number"
                  min="0"
                  step="any"
                  inputMode="decimal"
                  value={reading?.durationSeconds ?? ""}
                  onChange={(e) =>
                    setReading("durationSeconds", e.target.value)
                  }
                />
              </FlightField>
              <FlightField label={`${prefix}Start max EGT (°C)`}>
                <input
                  type="number"
                  step="any"
                  inputMode="decimal"
                  value={reading?.maxEgtC ?? ""}
                  onChange={(e) => setReading("maxEgtC", e.target.value)}
                />
              </FlightField>
            </div>
          );
        })}
      </div>
    </section>
  );
  const shutdownMeters = (
    [
      { key: "hobbsOn", label: "Hobbs", opening: draft?.opening.hobbs },
      { key: "tachOn", label: "Tach", opening: draft?.opening.tach },
      ...(aircraft?.flightTimeLog || aircraft?.meter === "flightTimeLog"
        ? [
            {
              key: "flightTimeLogOn",
              label: "Flight time log",
              opening: draft?.opening.flightTimeLog,
            },
          ]
        : []),
      ...(aircraft?.helicopter || aircraft?.meter === "cyclic"
        ? [
            {
              key: "cyclicHobbsOn",
              label: "Collective hourmeter",
              opening: draft?.opening.cyclic,
            },
          ]
        : []),
    ] as const
  ).map((m) => ({
    ...m,
    meter: (
      {
        hobbsOn: "hobbs",
        tachOn: "tach",
        flightTimeLogOn: "flightTimeLog",
        cyclicHobbsOn: "cyclic",
      } as const
    )[m.key],
  }));
  const primaryShutdown = shutdownMeters.find(
    (m) => m.meter === aircraft?.meter,
  );
  type ShutdownKey = (typeof shutdownMeters)[number]["key"];
  // A number, not text, so React compares it numerically and leaves an entry
  // such as "2342.0" as typed.
  const shutdownHours = (k: ShutdownKey) =>
    draft?.[k as "hobbsOn"] === undefined ? "" : draft[k as "hobbsOn"]! / 3600;
  // Only whole tenths of an hour are kept, as the flight log takes them; a
  // refused entry leaves the last reading the field accepted.
  const recordShutdown = (k: ShutdownKey, typed: string) => {
    try {
      update({ [k]: parseHours(typed) });
    } catch (e) {
      setError(errorText(e));
    }
  };
  const shutdownPanel = draft && (
    <section className="guided-readings flight-guided-readings">
      <div className="flight-section-head">
        <h3 className="flight-section-title">Shutdown flight-log readings</h3>
      </div>
      <p className="flight-note">
        Enter actual ending meter readings in hours. The aircraft’s primary
        meter is {aircraft ? aircraftMeterLabels[aircraft.meter] : "Unknown"}.
      </p>
      <div className="flight-meters">
        {shutdownMeters.map(({ key: k, label, opening }) => (
          <MeterBox
            key={k}
            startInput={false}
            startLabel={`Preflight ${label}`}
            startValue={
              opening === undefined ? "Unknown" : readingText(opening)
            }
            endLabel={`Shutdown ${label}`}
            endSrSuffix=" (hours)"
            endInput={
              <input
                type="number"
                min="0"
                step="0.1"
                placeholder="0.0"
                inputMode="decimal"
                value={shutdownHours(k)}
                onChange={(e) => recordShutdown(k, e.target.value)}
              />
            }
          />
        ))}
      </div>
      {primaryShutdown && (
        <FlightTimeStrip
          meterLabel={primaryShutdown.label}
          entryName={
            primaryShutdown.meter === "tach" ? "tach" : primaryShutdown.label
          }
          startSeconds={primaryShutdown.opening}
          endHours={String(shutdownHours(primaryShutdown.key))}
        />
      )}
      {fluidPanel("shutdown")}
    </section>
  );
  return (
    <section className="panel guided-flight flight-guided">
      <div className="flight-guided-intro">
        <Switch
          className="flight-guided-switch"
          checked={enabled}
          onChange={(checked) => {
            setEnabled(checked);
            try {
              localStorage.setItem(`${key}:enabled`, String(checked));
            } catch {
              setError("The trial setting could not be saved in this browser.");
            }
          }}
          label="Enable guided flight trial"
        />
        <p className="flight-note">
          Select aircraft and flight plan → preflight readings → checklist →
          shutdown readings → review and save flight. Turning this off keeps
          your draft and saved flights.
        </p>
      </div>
      {message && (
        <NoticeBar icon={Info} role="status" className="flight-notice">
          {message}
        </NoticeBar>
      )}
      {error && (
        <NoticeBar
          tone="danger"
          icon={WarningCircle}
          role="alert"
          className="flight-notice"
        >
          {error}{" "}
          <button className="button small" onClick={exportDraft}>
            <DownloadSimple size={16} aria-hidden="true" /> Export saved draft
          </button>
        </NoticeBar>
      )}
      {enabled && !draft && paused.length > 0 && (
        <div className="flight-paused">
          <h3 className="flight-section-title">Paused guided flights</h3>
          <p className="flight-note">
            Resume a saved flight, or start a different flight below.
          </p>
          {paused.map((saved) => {
            const registration =
              s!.aircraft.find((a) => a.uuid === saved.aircraftUuid)
                ?.registration ?? saved.plan.registration;
            return (
              <div className="flight-paused-row" key={saved.uuid}>
                <IconTile icon={PauseCircle} tone="warn" size="md" />
                <span className="flight-paused-text">
                  <strong>{registration}</strong>
                  <span>
                    {saved.plan.origin} → {saved.plan.destination}
                  </span>
                </span>
                <button
                  className="button small"
                  onClick={() => resumeFlight(saved)}
                >
                  <Play size={16} aria-hidden="true" /> Resume
                  <span className="flight-sr-only">
                    {" "}
                    {registration} · {saved.plan.origin} →{" "}
                    {saved.plan.destination}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      )}
      {enabled &&
        (!draft ? (
          <div className="flight-guided-setup">
            <div className="flight-grid">
              <FlightField label="Guided aircraft">
                <select
                  value={aircraftId}
                  onChange={(e) => {
                    const nextAircraft = e.target.value;
                    setAircraft(nextAircraft);
                    const nextChecklist =
                      (checklist &&
                      (!checklist.aircraftUuid ||
                        checklist.aircraftUuid === nextAircraft)
                        ? checklist
                        : undefined) ??
                      records.find((r) => r.aircraftUuid === nextAircraft) ??
                      records.find((r) => !r.aircraftUuid);
                    if (nextChecklist) onSelectChecklist?.(nextChecklist.uuid);
                    setPlan("");
                    setChecklist(nextChecklist?.uuid ?? "");
                    setPreflight("");
                    setShutdown("");
                    setStartSection(undefined);
                  }}
                >
                  {aircrafts.map((a) => (
                    <option key={a.uuid} value={a.uuid}>
                      {a.registration}
                    </option>
                  ))}
                </select>
              </FlightField>
              <FlightField label="Associated flight plan">
                <select
                  value={plan?.uuid ?? ""}
                  onChange={(e) => setPlan(e.target.value)}
                >
                  {!plans.length && (
                    <option value="">
                      No unlogged flight plans — add one in Flight plans
                    </option>
                  )}
                  {plans.map((p) => (
                    <option value={p.uuid} key={p.uuid}>
                      {p.origin} → {p.destination} ·{" "}
                      {new Date(p.departureAt).toLocaleString()}
                    </option>
                  ))}
                </select>
              </FlightField>
              <FlightField label="Guided checklist">
                <select
                  value={checklist?.uuid ?? ""}
                  onChange={(e) => {
                    setChecklist(e.target.value);
                    onSelectChecklist?.(e.target.value);
                    setPreflight("");
                    setShutdown("");
                    setStartSection(undefined);
                  }}
                >
                  {!compatible.length && (
                    <option value="">
                      Link a checklist to this aircraft or the program library
                    </option>
                  )}
                  {compatible.map((r) => (
                    <option key={r.uuid} value={r.uuid}>
                      {r.document.payload.metadata.name ||
                        r.sourceName ||
                        "Untitled checklist"}
                    </option>
                  ))}
                </select>
              </FlightField>
              {aircraft?.turbine && (
                <FlightField label="Engine start section (optional)">
                  <select
                    value={startId}
                    onChange={(e) => setStartSection(e.target.value)}
                  >
                    <option value="">Do not include engine start fields</option>
                    {lists.map((l) => (
                      <option key={l.objectId} value={l.objectId}>
                        {l.title || "Untitled section"}
                      </option>
                    ))}
                  </select>
                </FlightField>
              )}
              {[
                {
                  label: "Preflight section",
                  value: preflightId,
                  set: setPreflight,
                },
                {
                  label: "Shutdown section",
                  value: shutdownId,
                  set: setShutdown,
                },
              ].map((f) => (
                <FlightField key={f.label} label={f.label}>
                  <select
                    value={f.value}
                    onChange={(e) => f.set(e.target.value)}
                  >
                    {lists.map((l) => (
                      <option key={l.objectId} value={l.objectId}>
                        {l.title || "Untitled section"}
                      </option>
                    ))}
                  </select>
                </FlightField>
              ))}
            </div>
            {aircraft && (
              <DispatchGate
                aircraftUuid={aircraft.uuid}
                reason={override}
                onReason={setOverride}
              />
            )}
            <div className="flight-actions">
              <button
                className="button primary"
                disabled={
                  !aircraft ||
                  dispatchBlocked(s!, aircraft.uuid, override) ||
                  !plan ||
                  !checklist ||
                  !preflightId ||
                  !shutdownId ||
                  !!loaded.error
                }
                onClick={() => {
                  if (!aircraft || !plan || !checklist) return;
                  persist({
                    uuid: crypto.randomUUID(),
                    aircraftUuid: aircraft.uuid,
                    startedAt: new Date().toISOString(),
                    opening: {
                      version: aircraft.version,
                      hobbs: aircraft.currentHobbs,
                      tach: aircraft.currentTach,
                      cyclic: aircraft.currentCyclicHobbs,
                      flightTimeLog: aircraft.currentFlightTimeLog,
                    },
                    checklist: structuredClone(checklist),
                    plan: structuredClone(plan),
                    preflightList: preflightId,
                    shutdownList: shutdownId,
                    startList: aircraft.turbine ? startId : "",
                    dispatchOverrideReason:
                      aircraftStatus(s!, aircraft.uuid).level === "grounded"
                        ? override.trim()
                        : undefined,
                    progress: {},
                  });
                  setOverride("");
                  setSection(preflightId);
                  setMessage("");
                }}
              >
                <Play size={17} weight="bold" aria-hidden="true" /> Start guided
                checklist
              </button>
            </div>
          </div>
        ) : (
          <div className="flight-guided-draft">
            <div className="flight-guided-head">
              <IconTile icon={AirplaneTakeoff} tone="blue" />
              <div className="flight-guided-title">
                <h2>
                  {aircraft?.registration ?? "Aircraft unavailable"} ·{" "}
                  {draft.plan.origin} → {draft.plan.destination}
                </h2>
                <p className="flight-note">
                  Draft started {new Date(draft.startedAt).toLocaleString()} ·
                  saved in this browser. Checklist revision{" "}
                  {draft.checklist.version}.
                </p>
              </div>
              {!savedFlight && !queued && (
                <button className="button small" onClick={pauseFlight}>
                  <Pause size={16} aria-hidden="true" /> Pause flight and switch
                </button>
              )}
            </div>
            {selectedChecklist &&
              selectedChecklist.uuid !== draft.checklist.uuid && (
                <NoticeBar tone="warn" icon={Info} className="flight-notice">
                  Your active guided flight still uses{" "}
                  {draft.checklist.document.payload.metadata.name ||
                    "its original checklist"}{" "}
                  for {aircraft?.registration}. Use Pause flight and switch
                  above to start the selected checklist while keeping this
                  flight’s readings and checkmarks.
                </NoticeBar>
              )}
            {!available ? (
              <NoticeBar
                tone="danger"
                icon={WarningCircle}
                className="flight-notice"
              >
                This aircraft or checklist is no longer available to you. Export
                or discard the draft.
              </NoticeBar>
            ) : savedFlight || queued ? (
              <NoticeBar icon={Info} className="flight-notice">
                This flight is already{" "}
                {savedFlight
                  ? `recorded (${savedFlight.status})`
                  : "saved on this device awaiting sync"}
                . View Flight log or Sync center. It will not be submitted
                again.
              </NoticeBar>
            ) : (
              <>
                {aircraft?.version !== draft.opening.version && (
                  <NoticeBar tone="warn" icon={Info} className="flight-notice">
                    The aircraft record changed since preflight. Your original
                    readings are preserved; this flight will require review if
                    submitted.
                  </NoticeBar>
                )}
                <div className="flight-guided-steps">
                  <button
                    className="button"
                    onClick={() => setSection(draft.preflightList)}
                  >
                    <ListChecks size={17} aria-hidden="true" /> Go to preflight
                  </button>
                  {aircraft?.turbine && draftStartId && (
                    <button
                      className="button"
                      onClick={() => setSection(draftStartId)}
                    >
                      <Engine size={17} aria-hidden="true" /> Go to engine start
                    </button>
                  )}
                  <button
                    className="button"
                    onClick={() => setSection(draft.shutdownList)}
                  >
                    <Power size={17} aria-hidden="true" /> Go to shutdown
                  </button>
                </div>
                {aircraft?.turbine && (
                  <div className="flight-grid">
                    <FlightField label="Engine start section (optional)">
                      <select
                        value={draftStartId}
                        onChange={(e) => update({ startList: e.target.value })}
                      >
                        <option value="">
                          Do not include engine start fields
                        </option>
                        {draftLists.map((l) => (
                          <option key={l.objectId} value={l.objectId}>
                            {l.title || "Untitled section"}
                          </option>
                        ))}
                      </select>
                    </FlightField>
                  </div>
                )}
                <ChecklistReader
                  key={`${draft.uuid}:${section}`}
                  record={draft.checklist}
                  initialList={section || draft.preflightList}
                  progress={draft.progress}
                  onProgress={(progress) => update({ progress })}
                  sectionEndExtras={(id) =>
                    id === draftStartId ? startPanel : undefined
                  }
                  sectionExtras={(id) => (
                    <>
                      {id === draft.preflightList && preflightPanel}
                      {id === draft.shutdownList && shutdownPanel}
                    </>
                  )}
                />
                <div className="flight-actions">
                  <button
                    className="button primary"
                    onClick={() => {
                      try {
                        const link = guidedFlightLink(draft, !!aircraft?.twin);
                        const input: FlightInput = {
                          aircraftUuid: draft.aircraftUuid,
                          flightPlanUuid: draft.plan.uuid,
                          pilotId: s!.user.id,
                          startTime: draft.startedAt,
                          hobbsOn: draft.hobbsOn,
                          tachOn: draft.tachOn,
                          cyclicHobbsOn: draft.cyclicHobbsOn,
                          flightTimeLogOn: draft.flightTimeLogOn,
                          engineStarts: aircraft?.turbine
                            ? draft.engineStarts
                            : undefined,
                          fuel: draft.fuel,
                          oil: draft.oil,
                          checklistRun: link,
                          origin: draft.plan.origin,
                          destination: draft.plan.destination,
                          landings: draft.plan.landings,
                          cycles: draft.plan.cycles,
                          flightRules: ["I", "Y"].includes(
                            draft.plan.flightRules,
                          )
                            ? "IFR"
                            : "VFR",
                          operation: "Mission",
                          remarks: `Planned route: ${draft.plan.route}`,
                          discrepancy: "",
                        };
                        validateFlight(aircraft!, input);
                        setReview(input);
                        setError("");
                      } catch (e) {
                        setError(errorText(e, "Check the readings."));
                      }
                    }}
                  >
                    <ClipboardText size={17} weight="bold" aria-hidden="true" />{" "}
                    Review flight log
                  </button>
                </div>
              </>
            )}
            <div className="flight-actions flight-actions-quiet">
              <button className="button" onClick={exportDraft}>
                <DownloadSimple size={17} aria-hidden="true" /> Export draft
              </button>
              <button
                className="text-button"
                onClick={() => {
                  if (
                    window.confirm(
                      savedFlight || queued
                        ? "Clear this completed draft? The flight record is kept."
                        : "Discard this guided draft and its readings/checkmarks? No flight will be saved.",
                    )
                  ) {
                    persist(undefined);
                    setReview(undefined);
                  }
                }}
              >
                <Trash size={17} aria-hidden="true" />{" "}
                {savedFlight || queued
                  ? "Clear completed draft"
                  : "Discard draft"}
              </button>
            </div>
            {review && available && !savedFlight && !queued && (
              <Dialog
                title="Review guided flight log"
                subtitle="Saved on this device first, then synced."
                dismissOnScrim={false}
                onClose={() => setReview(undefined)}
              >
                <NoticeBar icon={ListChecks} className="flight-notice">
                  {review.checklistRun?.checked.length}/
                  {review.checklistRun?.totalChecks} items checked ·{" "}
                  {review.checklistRun?.skipped.length} skipped ·{" "}
                  {(review.checklistRun?.totalChecks ?? 0) -
                    (review.checklistRun?.checked.length ?? 0) -
                    (review.checklistRun?.skipped.length ?? 0)}{" "}
                  unchecked. Review actual readings and flight details. Saving
                  records the flight; skipped items remain incomplete. Unsaved
                  changes in this review are discarded if you close it;
                  checklist readings stay in your draft.
                </NoticeBar>
                <FlightForm
                  plan={draft.plan}
                  prefill={review}
                  openingOverride={draft.opening}
                  operationUuid={draft.uuid}
                  dispatchOverrideReason={draft.dispatchOverrideReason}
                  onCancel={() => setReview(undefined)}
                  onDone={() => {
                    setReview(undefined);
                    persist(undefined);
                    setMessage(
                      "Flight saved on this device. See Flight log and Sync center for its acceptance or review status.",
                    );
                  }}
                />
              </Dialog>
            )}
          </div>
        ))}
    </section>
  );
}
