/**
 * Responsibility: The guided flight: checklists, engine start and shutdown
 *   readings, paused flights kept on this device, and the flight log review.
 * Layer: UI. React components; flight rules live in src/domain.
 * Dependencies: react, @phosphor-icons/react, src/data/store.ts, src/domain
 *   (flightFluids, model, programs, checklists, guidedFlight, flights,
 *   flightPlans, flightSession, flightSubmission, readings, aircraftStatus),
 *   ./Checklists, ./FlightFluids, ./FlightForm, ./FlightParts,
 *   ./AircraftStatus, ./design, ./ui.
 *
 * Drafts live only in this browser's localStorage, so every storage failure
 * offers an export of the draft rather than losing its readings.
 */
import { oilLevelLabel } from "../domain/flightFluids";
import { useEffect, useMemo, useState } from "react";
import { useWorkspace } from "../data/store";
import {
  can,
  aircraftMeterLabels,
  type Aircraft,
  type Flight,
  type FlightInput,
  type QueuedOperation,
  type Snapshot,
} from "../domain/model";
import { activeProgram } from "../domain/programs";
import {
  checklistReadable,
  type ChecklistList,
  type ChecklistRecord,
} from "../domain/checklists";
import {
  suggestedPreflightSection,
  suggestedShutdownSection,
  suggestedStartSection,
  guidedDraftSchema,
  guidedFlightLink,
  type GuidedDraft,
} from "../domain/guidedFlight";
import { flightOptionalEntries, validateFlight } from "../domain/flights";
import { plannedFlightRules } from "../domain/flightSession";
import { isPlanFlightOlder } from "../domain/flightPlans";
import { aircraftAfterPendingFlights } from "../domain/flightSubmission";
import { SECONDS_PER_HOUR, parseHours, readingText } from "../domain/readings";
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
import { download, errorText } from "./ui";

// src/data/store.ts clears localStorage keys with this prefix on sign-out.
const DRAFT_KEY_PREFIX = "angel-one-guided";
const START_SECTION = {
  label: "Engine start section (optional)",
  none: "Do not include engine start fields",
};

type GuidedFlightProps = {
  records: ChecklistRecord[];
  selectedChecklist?: ChecklistRecord;
  onSelectChecklist?: (uuid: string) => void;
};
type Drafts = ReturnType<typeof useGuidedDrafts>;
type Setup = ReturnType<typeof useGuidedSetup>;
type Setter<T> = (value: T) => void;
type SectionSetters = {
  setAircraft: Setter<string>;
  setPlan: Setter<string>;
  setChecklist: Setter<string>;
  setPreflight: Setter<string>;
  setShutdown: Setter<string>;
  setStartSection: Setter<string | undefined>;
};
type Chosen = {
  aircraftId: string;
  planId: string;
  checklistId: string;
  preflight: string;
  startSection?: string;
  shutdown: string;
};
type DraftProps = {
  draft: GuidedDraft;
  aircraft: Aircraft | undefined;
  drafts: Drafts;
};
type ShutdownKey = "hobbsOn" | "tachOn" | "flightTimeLogOn" | "cyclicHobbsOn";
type EnginePosition = "single" | "left" | "right";
type EngineStartKey = "durationSeconds" | "maxEgtC";

/**
 * The guided flight trial: choose an aircraft, flight plan and checklist,
 * then work through preflight readings, the checklist and shutdown readings
 * to the flight log review.
 *
 * @param props.records - The checklists the user may read.
 * @param props.selectedChecklist - The checklist open on the screen. The next
 *   flight follows it; a running flight keeps its own.
 * @param props.onSelectChecklist - Called with a checklist uuid when the
 *   guided flight moves to another checklist.
 * @returns The panel. The trial switch, the running draft and paused flights
 *   are kept in this browser per user and Flight Program; the reviewed flight
 *   is saved through the flight form.
 */
export function GuidedFlight(props: GuidedFlightProps) {
  const { snapshot, namespace, queue } = useWorkspace();
  const s = useMemo(() => withPendingLegs(snapshot!, queue), [snapshot, queue]);
  const drafts = useGuidedDrafts(
    `${DRAFT_KEY_PREFIX}:${namespace}:${s.user.id}:${activeProgram(s)}`,
  );
  const setup = useGuidedSetup(s, queue, props, drafts);
  const { enabled, draft } = drafts;
  return (
    <section className="panel guided-flight flight-guided">
      <GuidedIntro drafts={drafts} />
      <GuidedNotices drafts={drafts} />
      {enabled && !draft && drafts.paused.length > 0 && (
        <PausedFlights s={s} drafts={drafts} checklists={props} />
      )}
      {enabled &&
        (!draft ? (
          <GuidedSetup s={s} setup={setup} drafts={drafts} checklists={props} />
        ) : (
          <ActiveDraft
            s={s}
            queue={queue}
            draft={draft}
            drafts={drafts}
            checklists={props}
          />
        ))}
    </section>
  );
}

function useGuidedDrafts(key: string) {
  const [loaded] = useState(() => loadDrafts(key));
  const [enabled, setEnabled] = useState(loaded.enabled);
  const [draft, setDraft] = useState<GuidedDraft | undefined>(loaded.draft);
  const [paused, setPaused] = useState(() =>
    loaded.paused.filter((d) => d.uuid !== loaded.draft?.uuid),
  );
  const [error, setError] = useState(loaded.error);
  const [review, setReview] = useState<Partial<FlightInput>>();
  const [message, setMessage] = useState("");
  const [section, setSection] = useState("");
  return {
    key,
    loadError: loaded.error,
    enabled,
    setEnabled,
    draft,
    setDraft,
    paused,
    setPaused,
    error,
    setError,
    review,
    setReview,
    message,
    setMessage,
    section,
    setSection,
  };
}

function useGuidedSetup(
  s: Snapshot,
  queue: QueuedOperation[],
  checklists: GuidedFlightProps,
  { draft, paused }: Drafts,
) {
  const aircrafts = s.aircraft.filter((a) => can(s, a.uuid, "flight"));
  const [aircraftId, setAircraft] = useState(aircrafts[0]?.uuid ?? "");
  const [planId, setPlan] = useState("");
  const [checklistId, setChecklist] = useState("");
  const [preflight, setPreflight] = useState("");
  const [startSection, setStartSection] = useState<string>();
  const [shutdown, setShutdown] = useState("");
  const [override, setOverride] = useState("");
  const setters = {
    setAircraft,
    setPlan,
    setChecklist,
    setPreflight,
    setShutdown,
    setStartSection,
  };
  useFollowSelectedChecklist(checklists.selectedChecklist, draft, setters);
  const chosen = {
    aircraftId,
    planId,
    checklistId,
    preflight,
    startSection,
    shutdown,
  };
  return {
    ...setters,
    ...setupChoices(s, queue, checklists.records, paused, chosen),
    aircrafts,
    aircraftId,
    override,
    setOverride,
  };
}

// A running flight keeps its captured checklist and readings until it is
// finished or discarded, so only the setup follows the checklist on screen.
function useFollowSelectedChecklist(
  selected: ChecklistRecord | undefined,
  draft: GuidedDraft | undefined,
  setters: SectionSetters,
) {
  const selectionKey = selected
    ? `${selected.uuid}:${selected.version}:${selected.aircraftUuid}`
    : "";
  useEffect(() => {
    if (draft || !selected) return;
    setters.setChecklist(selected.uuid);
    if (selected.aircraftUuid) {
      setters.setAircraft(selected.aircraftUuid);
      setters.setPlan("");
    }
    resetSections(setters);
  }, [selectionKey, draft?.uuid]);
}

function GuidedIntro({ drafts: d }: { drafts: Drafts }) {
  const toggle = (checked: boolean) => {
    d.setEnabled(checked);
    try {
      localStorage.setItem(`${d.key}:enabled`, String(checked));
    } catch {
      // Blocked storage: the switch still holds for this visit.
      d.setError("The trial setting could not be saved in this browser.");
    }
  };
  return (
    <div className="flight-guided-intro">
      <Switch
        className="flight-guided-switch"
        checked={d.enabled}
        onChange={toggle}
        label="Enable guided flight trial"
      />
      <p className="flight-note">
        Select aircraft and flight plan → preflight readings → checklist →
        shutdown readings → review and save flight. Turning this off keeps your
        draft and saved flights.
      </p>
    </div>
  );
}

function GuidedNotices({ drafts: d }: { drafts: Drafts }) {
  return (
    <>
      {d.message && (
        <NoticeBar icon={Info} role="status" className="flight-notice">
          {d.message}
        </NoticeBar>
      )}
      {d.error && (
        <NoticeBar
          tone="danger"
          icon={WarningCircle}
          role="alert"
          className="flight-notice"
        >
          {d.error}{" "}
          <button className="button small" onClick={() => exportDraft(d)}>
            <DownloadSimple size={16} aria-hidden="true" /> Export saved draft
          </button>
        </NoticeBar>
      )}
    </>
  );
}

function PausedFlights(props: {
  s: Snapshot;
  drafts: Drafts;
  checklists: GuidedFlightProps;
}) {
  const { s, drafts: d } = props;
  return (
    <div className="flight-paused">
      <h3 className="flight-section-title">Paused guided flights</h3>
      <p className="flight-note">
        Resume a saved flight, or start a different flight below.
      </p>
      {d.paused.map((saved) => {
        const registration =
          s.aircraft.find((a) => a.uuid === saved.aircraftUuid)?.registration ??
          saved.plan.registration;
        const route = `${saved.plan.origin} → ${saved.plan.destination}`;
        return (
          <div className="flight-paused-row" key={saved.uuid}>
            <IconTile icon={PauseCircle} tone="warn" size="md" />
            <span className="flight-paused-text">
              <strong>{registration}</strong>
              <span>{route}</span>
            </span>
            <button
              className="button small"
              onClick={() => resumeFlight(d, saved, props.checklists)}
            >
              <Play size={16} aria-hidden="true" /> Resume
              <span className="flight-sr-only">
                {" "}
                {registration} · {route}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

function GuidedSetup(props: {
  s: Snapshot;
  setup: Setup;
  drafts: Drafts;
  checklists: GuidedFlightProps;
}) {
  const { setup, checklists } = props;
  const { aircraft } = setup;
  return (
    <div className="flight-guided-setup">
      <div className="flight-grid">
        <AircraftSelect setup={setup} checklists={checklists} />
        <PlanSelect setup={setup} />
        <ChecklistSelect setup={setup} checklists={checklists} />
        <SetupSections setup={setup} />
      </div>
      {aircraft && (
        <DispatchGate
          aircraftUuid={aircraft.uuid}
          reason={setup.override}
          onReason={setup.setOverride}
        />
      )}
      <StartButton s={props.s} setup={setup} drafts={props.drafts} />
    </div>
  );
}

function SetupSections({ setup }: { setup: Setup }) {
  const { lists } = setup;
  return (
    <>
      {setup.aircraft?.turbine && (
        <SectionField
          {...START_SECTION}
          value={setup.startId}
          lists={lists}
          onChange={setup.setStartSection}
        />
      )}
      <SectionField
        label="Preflight section"
        value={setup.preflightId}
        lists={lists}
        onChange={setup.setPreflight}
      />
      <SectionField
        label="Shutdown section"
        value={setup.shutdownId}
        lists={lists}
        onChange={setup.setShutdown}
      />
    </>
  );
}

function AircraftSelect(props: {
  setup: Setup;
  checklists: GuidedFlightProps;
}) {
  const { setup, checklists } = props;
  return (
    <FlightField label="Guided aircraft">
      <select
        value={setup.aircraftId}
        onChange={(e) => chooseAircraft(setup, checklists, e.target.value)}
      >
        {setup.aircrafts.map((a) => (
          <option key={a.uuid} value={a.uuid}>
            {a.registration}
          </option>
        ))}
      </select>
    </FlightField>
  );
}

function PlanSelect({ setup }: { setup: Setup }) {
  return (
    <FlightField label="Associated flight plan">
      <select
        value={setup.plan?.uuid ?? ""}
        onChange={(e) => setup.setPlan(e.target.value)}
      >
        {!setup.plans.length && (
          <option value="">
            No unlogged flight plans — add one in Flight plans
          </option>
        )}
        {setup.plans.map((p) => (
          <option value={p.uuid} key={p.uuid}>
            {p.origin} → {p.destination} ·{" "}
            {new Date(p.departureAt).toLocaleString()}
          </option>
        ))}
      </select>
    </FlightField>
  );
}

function ChecklistSelect(props: {
  setup: Setup;
  checklists: GuidedFlightProps;
}) {
  const { setup } = props;
  const choose = (uuid: string) => {
    setup.setChecklist(uuid);
    props.checklists.onSelectChecklist?.(uuid);
    resetSections(setup);
  };
  return (
    <FlightField label="Guided checklist">
      <select
        value={setup.checklist?.uuid ?? ""}
        onChange={(e) => choose(e.target.value)}
      >
        {!setup.compatible.length && (
          <option value="">
            Link a checklist to this aircraft or the program library
          </option>
        )}
        {setup.compatible.map((r) => (
          <option key={r.uuid} value={r.uuid}>
            {r.document.payload.metadata.name ||
              r.sourceName ||
              "Untitled checklist"}
          </option>
        ))}
      </select>
    </FlightField>
  );
}

function SectionField(props: {
  label: string;
  none?: string;
  value: string;
  lists: ChecklistList[];
  onChange: (objectId: string) => void;
}) {
  return (
    <FlightField label={props.label}>
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      >
        {props.none && <option value="">{props.none}</option>}
        {props.lists.map((l) => (
          <option key={l.objectId} value={l.objectId}>
            {l.title || "Untitled section"}
          </option>
        ))}
      </select>
    </FlightField>
  );
}

function StartButton(props: { s: Snapshot; setup: Setup; drafts: Drafts }) {
  const { aircraft, ...setup } = props.setup;
  const blocked =
    !aircraft ||
    dispatchBlocked(props.s, aircraft.uuid, setup.override) ||
    !setup.plan ||
    !setup.checklist ||
    !setup.preflightId ||
    !setup.shutdownId ||
    !!props.drafts.loadError;
  return (
    <div className="flight-actions">
      <button
        className="button primary"
        disabled={blocked}
        onClick={() => startDraft(props.s, props.setup, props.drafts)}
      >
        <Play size={17} weight="bold" aria-hidden="true" /> Start guided
        checklist
      </button>
    </div>
  );
}

function ActiveDraft(props: {
  s: Snapshot;
  queue: QueuedOperation[];
  draft: GuidedDraft;
  drafts: Drafts;
  checklists: GuidedFlightProps;
}) {
  const { s, draft, drafts: d } = props;
  const { records, selectedChecklist: selected } = props.checklists;
  const aircraft = s.aircraft.find((a) => a.uuid === draft.aircraftUuid);
  const recorded = s.flights.find((f) => f.uuid === draft.uuid);
  const done =
    !!recorded || props.queue.some((q) => q.operation.uuid === draft.uuid);
  const available = draftAvailable(s, draft, aircraft, records);
  const view = { draft, aircraft, drafts: d };
  return (
    <div className="flight-guided-draft">
      <DraftHeading {...view} canPause={!done} />
      {selected && selected.uuid !== draft.checklist.uuid && (
        <NoticeBar tone="warn" icon={Info} className="flight-notice">
          Your active guided flight still uses{" "}
          {draft.checklist.document.payload.metadata.name ||
            "its original checklist"}{" "}
          for {aircraft?.registration}. Use Pause flight and switch above to
          start the selected checklist while keeping this flight’s readings and
          checkmarks.
        </NoticeBar>
      )}
      <DraftStage {...view} s={s} state={{ available, done, recorded }} />
      <DraftActions drafts={d} done={done} />
      {d.review && available && !done && (
        <ReviewDialog draft={draft} review={d.review} drafts={d} />
      )}
    </div>
  );
}

function DraftHeading(props: DraftProps & { canPause: boolean }) {
  const { draft, aircraft } = props;
  return (
    <div className="flight-guided-head">
      <IconTile icon={AirplaneTakeoff} tone="blue" />
      <div className="flight-guided-title">
        <h2>
          {aircraft?.registration ?? "Aircraft unavailable"} ·{" "}
          {draft.plan.origin} → {draft.plan.destination}
        </h2>
        <p className="flight-note">
          Draft started {new Date(draft.startedAt).toLocaleString()} · saved in
          this browser. Checklist revision {draft.checklist.version}.
        </p>
      </div>
      {props.canPause && (
        <button
          className="button small"
          onClick={() => pauseFlight(props.drafts)}
        >
          <Pause size={16} aria-hidden="true" /> Pause flight and switch
        </button>
      )}
    </div>
  );
}

function DraftStage(
  props: DraftProps & {
    s: Snapshot;
    state: { available: boolean; done: boolean; recorded?: Flight };
  },
) {
  const { available, done, recorded } = props.state;
  if (!available)
    return (
      <NoticeBar tone="danger" icon={WarningCircle} className="flight-notice">
        This aircraft or checklist is no longer available to you. Export or
        discard the draft.
      </NoticeBar>
    );
  if (done)
    return (
      <NoticeBar icon={Info} className="flight-notice">
        This flight is already{" "}
        {recorded
          ? `recorded (${recorded.status})`
          : "saved on this device awaiting sync"}
        . View Flight log or Sync center. It will not be submitted again.
      </NoticeBar>
    );
  return <DraftSteps {...props} />;
}

function DraftSteps(props: DraftProps & { s: Snapshot }) {
  const { s, draft, aircraft, drafts: d } = props;
  const lists = checklistSections(draft.checklist);
  const startId = draft.startList ?? suggestedStartSection(lists);
  return (
    <>
      {aircraft?.version !== draft.opening.version && (
        <NoticeBar tone="warn" icon={Info} className="flight-notice">
          The aircraft record changed since preflight. Your original readings
          are preserved; this flight will require review if submitted.
        </NoticeBar>
      )}
      <DraftNavigation {...props} lists={lists} startId={startId} />
      <DraftChecklist {...props} startId={startId} />
      <div className="flight-actions">
        <button
          className="button primary"
          onClick={() => reviewFlight(s, draft, aircraft, d)}
        >
          <ClipboardText size={17} weight="bold" aria-hidden="true" /> Review
          flight log
        </button>
      </div>
    </>
  );
}

function DraftNavigation(
  props: DraftProps & { lists: ChecklistList[]; startId: string },
) {
  const { draft, drafts: d, startId } = props;
  const turbine = props.aircraft?.turbine;
  return (
    <>
      <div className="flight-guided-steps">
        <button
          className="button"
          onClick={() => d.setSection(draft.preflightList)}
        >
          <ListChecks size={17} aria-hidden="true" /> Go to preflight
        </button>
        {turbine && startId && (
          <button className="button" onClick={() => d.setSection(startId)}>
            <Engine size={17} aria-hidden="true" /> Go to engine start
          </button>
        )}
        <button
          className="button"
          onClick={() => d.setSection(draft.shutdownList)}
        >
          <Power size={17} aria-hidden="true" /> Go to shutdown
        </button>
      </div>
      {turbine && (
        <div className="flight-grid">
          <SectionField
            {...START_SECTION}
            value={startId}
            lists={props.lists}
            onChange={(startList) => updateDraft(d, { startList })}
          />
        </div>
      )}
    </>
  );
}

function DraftChecklist(props: DraftProps & { s: Snapshot; startId: string }) {
  const { draft, aircraft, drafts: d } = props;
  return (
    <ChecklistReader
      key={`${draft.uuid}:${d.section}`}
      record={draft.checklist}
      initialList={d.section || draft.preflightList}
      progress={draft.progress}
      onProgress={(progress) => updateDraft(d, { progress })}
      sectionEndExtras={(id) =>
        id === props.startId && aircraft?.turbine ? (
          <EngineStartPanel {...props} />
        ) : undefined
      }
      sectionExtras={(id) => (
        <>
          {id === draft.preflightList && <PreflightPanel {...props} />}
          {id === draft.shutdownList && <ShutdownPanel {...props} />}
        </>
      )}
    />
  );
}

function PreflightPanel(props: DraftProps & { s: Snapshot }) {
  const { draft, aircraft, drafts: d } = props;
  return (
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
      <OpeningReadings draft={draft} aircraft={aircraft} />
      {aircraft && <LastFlightNote s={props.s} aircraft={aircraft} />}
      <label className="flight-attest">
        <input
          type="checkbox"
          checked={!!draft.metersVerifiedAt}
          onChange={(e) =>
            updateDraft(d, {
              metersVerifiedAt: e.target.checked
                ? new Date().toISOString()
                : undefined,
            })
          }
        />{" "}
        I verified the starting meter readings against the aircraft
      </label>
      <FluidFields {...props} phase="preflight" />
    </section>
  );
}

function OpeningReadings({ draft, aircraft }: Omit<DraftProps, "drafts">) {
  const { opening } = draft;
  return (
    <dl className="flight-readings">
      <div>
        <dt>Hobbs</dt>
        <dd>{readingText(opening.hobbs)} hr</dd>
      </div>
      <div>
        <dt>Tach</dt>
        <dd>{readingText(opening.tach)} hr</dd>
      </div>
      {aircraft?.flightTimeLog && opening.flightTimeLog !== undefined && (
        <div>
          <dt>Flight time log</dt>
          <dd>{readingText(opening.flightTimeLog)} hr</dd>
        </div>
      )}
      {opening.cyclic !== undefined && (
        <div>
          <dt>Cyclic</dt>
          <dd>{readingText(opening.cyclic)} hr</dd>
        </div>
      )}
    </dl>
  );
}

function LastFlightNote({ s, aircraft }: { s: Snapshot; aircraft: Aircraft }) {
  const latest = s.flights
    .filter((f) => f.aircraftUuid === aircraft.uuid && f.status === "accepted")
    .sort((a, b) => b.startTime.localeCompare(a.startTime))[0];
  if (!latest) return null;
  return (
    <p className="flight-note">
      Last accepted flight: {new Date(latest.startTime).toLocaleString()}.
      Shutdown fuel: {latest.fuel?.end ?? "not recorded"}{" "}
      {latest.fuel?.unit ?? ""}
      {latest.oil
        ?.map(
          (o) => ` · ${o.engine} starting oil: ${oilLevelLabel(o, o.start)}`,
        )
        .join("")}
      . Take fresh physical readings below.
    </p>
  );
}

function FluidFields(props: DraftProps & { phase: "preflight" | "shutdown" }) {
  return (
    <FlightFluidFields
      fluids={props.draft}
      twin={props.aircraft?.twin}
      phase={props.phase}
      required
      onChange={(patch) => updateDraft(props.drafts, patch)}
    />
  );
}

function EngineStartPanel(props: DraftProps) {
  const positions = props.aircraft?.twin
    ? (["left", "right"] as const)
    : (["single"] as const);
  return (
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
        {positions.map((engine) => (
          <EngineStartFields
            key={engine}
            {...props}
            engine={engine}
            positions={positions}
          />
        ))}
      </div>
    </section>
  );
}

function EngineStartFields(
  props: DraftProps & {
    engine: EnginePosition;
    positions: readonly EnginePosition[];
  },
) {
  const { draft, engine } = props;
  const reading = draft.engineStarts?.find((r) => r.engine === engine);
  const prefix = { single: "", left: "Left ", right: "Right " }[engine];
  const setReading = (key: EngineStartKey, typed: string) =>
    updateDraft(props.drafts, {
      engineStarts: withEngineStart(draft, props.positions, engine, key, typed),
    });
  return (
    <div className="flight-grid flight-engine">
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
          onChange={(e) => setReading("durationSeconds", e.target.value)}
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
}

function ShutdownPanel(props: DraftProps) {
  const { draft, aircraft } = props;
  const meters = shutdownMeters(draft, aircraft);
  const primary = meters.find((m) => m.meter === aircraft?.meter);
  return (
    <section className="guided-readings flight-guided-readings">
      <div className="flight-section-head">
        <h3 className="flight-section-title">Shutdown flight-log readings</h3>
      </div>
      <p className="flight-note">
        Enter actual ending meter readings in hours. The aircraft’s primary
        meter is {aircraft ? aircraftMeterLabels[aircraft.meter] : "Unknown"}.
      </p>
      <div className="flight-meters">
        {meters.map((m) => (
          <ShutdownMeterBox key={m.key} {...props} meter={m} />
        ))}
      </div>
      {primary && (
        <FlightTimeStrip
          meterLabel={primary.label}
          entryName={primary.meter === "tach" ? "tach" : primary.label}
          startSeconds={primary.opening}
          endHours={String(shutdownHours(draft, primary.key))}
        />
      )}
      <FluidFields {...props} phase="shutdown" />
    </section>
  );
}

function ShutdownMeterBox(
  props: DraftProps & { meter: ReturnType<typeof shutdownMeters>[number] },
) {
  const { key, label, opening } = props.meter;
  return (
    <MeterBox
      startInput={false}
      startLabel={`Preflight ${label}`}
      startValue={opening === undefined ? "Unknown" : readingText(opening)}
      endLabel={`Shutdown ${label}`}
      endSrSuffix=" (hours)"
      endInput={
        <input
          type="number"
          min="0"
          step="0.1"
          placeholder="0.0"
          inputMode="decimal"
          value={shutdownHours(props.draft, key)}
          onChange={(e) => recordShutdown(props.drafts, key, e.target.value)}
        />
      }
    />
  );
}

function DraftActions({ drafts: d, done }: { drafts: Drafts; done: boolean }) {
  const discard = () => {
    const question = done
      ? "Clear this completed draft? The flight record is kept."
      : "Discard this guided draft and its readings/checkmarks? No flight will be saved.";
    if (!window.confirm(question)) return;
    persistDraft(d, undefined);
    d.setReview(undefined);
  };
  return (
    <div className="flight-actions flight-actions-quiet">
      <button className="button" onClick={() => exportDraft(d)}>
        <DownloadSimple size={17} aria-hidden="true" /> Export draft
      </button>
      <button className="text-button" onClick={discard}>
        <Trash size={17} aria-hidden="true" />{" "}
        {done ? "Clear completed draft" : "Discard draft"}
      </button>
    </div>
  );
}

function ReviewDialog(props: {
  draft: GuidedDraft;
  review: Partial<FlightInput>;
  drafts: Drafts;
}) {
  const { draft, drafts: d } = props;
  const close = () => d.setReview(undefined);
  return (
    <Dialog
      title="Review guided flight log"
      subtitle="Saved on this device first, then synced."
      dismissOnScrim={false}
      onClose={close}
    >
      <ReviewSummary run={props.review.checklistRun} />
      <FlightForm
        plan={draft.plan}
        prefill={props.review}
        openingOverride={draft.opening}
        operationUuid={draft.uuid}
        dispatchOverrideReason={draft.dispatchOverrideReason}
        onCancel={close}
        onDone={() => {
          close();
          persistDraft(d, undefined);
          d.setMessage(
            "Flight saved on this device. See Flight log and Sync center for its acceptance or review status.",
          );
        }}
      />
    </Dialog>
  );
}

function ReviewSummary({ run }: { run: FlightInput["checklistRun"] }) {
  const unchecked =
    (run?.totalChecks ?? 0) -
    (run?.checked.length ?? 0) -
    (run?.skipped.length ?? 0);
  return (
    <NoticeBar icon={ListChecks} className="flight-notice">
      {run?.checked.length}/{run?.totalChecks} items checked ·{" "}
      {run?.skipped.length} skipped · {unchecked} unchecked. Review actual
      readings and flight details. Saving records the flight; skipped items
      remain incomplete. Unsaved changes in this review are discarded if you
      close it; checklist readings stay in your draft.
    </NoticeBar>
  );
}

function loadDrafts(key: string) {
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
    // Blocked storage or a stored draft that no longer parses: start empty
    // with Start disabled (loadError), so the stored draft is never
    // overwritten and can still be exported.
    return {
      draft: undefined,
      paused: [] as GuidedDraft[],
      enabled: false,
      error:
        "The saved guided draft could not be loaded. It has not been overwritten. Export the saved draft before starting again.",
    };
  }
}

function persistDraft(d: Drafts, next: GuidedDraft | undefined) {
  try {
    if (next) localStorage.setItem(d.key, JSON.stringify(next));
    else localStorage.removeItem(d.key);
    d.setError("");
  } catch {
    // Blocked or full storage: keep the draft on screen and ask for an export.
    d.setError(
      "Browser storage failed. Keep this page open and export the draft before leaving; recent changes may not survive a reload.",
    );
  }
  d.setDraft(next);
}

function updateDraft(d: Drafts, patch: Partial<GuidedDraft>) {
  if (d.draft) persistDraft(d, { ...d.draft, ...patch });
}

function pauseFlight(d: Drafts) {
  const { draft } = d;
  if (!draft) return;
  const next = [...d.paused.filter((p) => p.uuid !== draft.uuid), draft];
  try {
    // Save the backup before removing the active draft.
    localStorage.setItem(`${d.key}:paused`, JSON.stringify(next));
    localStorage.removeItem(d.key);
    d.setPaused(next);
    d.setDraft(undefined);
    d.setReview(undefined);
    d.setSection("");
    d.setError("");
    d.setMessage(
      "Flight paused. Its readings and checkmarks are saved in this browser. Select another aircraft or checklist below.",
    );
  } catch {
    d.setError(
      "Could not pause the flight. Your active draft is still open; export it before leaving.",
    );
  }
}

function resumeFlight(
  d: Drafts,
  saved: GuidedDraft,
  { onSelectChecklist }: GuidedFlightProps,
) {
  const next = d.paused.filter((p) => p.uuid !== saved.uuid);
  try {
    localStorage.setItem(d.key, JSON.stringify(saved));
    localStorage.setItem(`${d.key}:paused`, JSON.stringify(next));
    d.setPaused(next);
    d.setDraft(saved);
    d.setReview(undefined);
    d.setSection(saved.preflightList);
    onSelectChecklist?.(saved.checklist.uuid);
    d.setError("");
    d.setMessage("");
  } catch {
    d.setError("Could not resume the saved flight. Its draft has been kept.");
  }
}

// Without an open draft, exports the stored one, so a draft that failed to
// load can still be recovered.
function exportDraft(d: Drafts) {
  const raw = d.draft
    ? JSON.stringify(d.draft, null, 2)
    : localStorage.getItem(d.key);
  if (raw) download("guided-flight-draft.json", raw);
}

// The aircraft as the user's own unsynced legs will leave them, so a flight
// started behind them opens on their ending readings and version (decision
// D7); the outbox chains its version the same way.
function withPendingLegs(s: Snapshot, queue: QueuedOperation[]): Snapshot {
  const pending = queue.map((q) => q.operation);
  return {
    ...s,
    aircraft: s.aircraft.map(
      (a) => aircraftAfterPendingFlights(s, a.uuid, pending) ?? a,
    ),
  };
}

function startDraft(s: Snapshot, setup: Setup, d: Drafts) {
  const { aircraft, plan, checklist } = setup;
  if (!aircraft || !plan || !checklist) return;
  persistDraft(d, {
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
    preflightList: setup.preflightId,
    shutdownList: setup.shutdownId,
    startList: aircraft.turbine ? setup.startId : "",
    dispatchOverrideReason:
      aircraftStatus(s, aircraft.uuid).level === "grounded"
        ? setup.override.trim()
        : undefined,
    progress: {},
  });
  setup.setOverride("");
  d.setSection(setup.preflightId);
  d.setMessage("");
}

// A new aircraft keeps the chosen checklist when it fits, else takes the
// aircraft's own checklist, else the first library one.
function chooseAircraft(
  setup: Setup,
  { records, onSelectChecklist }: GuidedFlightProps,
  aircraftUuid: string,
) {
  const { checklist } = setup;
  const fits =
    checklist &&
    (!checklist.aircraftUuid || checklist.aircraftUuid === aircraftUuid);
  const next =
    (fits ? checklist : undefined) ??
    records.find((r) => r.aircraftUuid === aircraftUuid) ??
    records.find((r) => !r.aircraftUuid);
  setup.setAircraft(aircraftUuid);
  if (next) onSelectChecklist?.(next.uuid);
  setup.setPlan("");
  setup.setChecklist(next?.uuid ?? "");
  resetSections(setup);
}

function resetSections(setters: SectionSetters) {
  setters.setPreflight("");
  setters.setShutdown("");
  setters.setStartSection(undefined);
}

// A plan is used once it is paused, logged (unless rejected) or queued.
function usedPlanIds(
  s: Snapshot,
  queue: QueuedOperation[],
  paused: GuidedDraft[],
) {
  return new Set([
    ...paused.map((d) => d.plan.uuid),
    ...s.flights
      .filter((f) => f.status !== "rejected")
      .map((f) => f.flightPlanUuid),
    ...queue.flatMap((q) =>
      q.operation.kind === "flight" ? [q.operation.input.flightPlanUuid] : [],
    ),
  ]);
}

function checklistSections(checklist?: ChecklistRecord): ChecklistList[] {
  return (
    checklist?.document.payload.groups.flatMap((c) =>
      c.items.flatMap((g) => g.items),
    ) ?? []
  );
}

function setupChoices(
  s: Snapshot,
  queue: QueuedOperation[],
  records: ChecklistRecord[],
  paused: GuidedDraft[],
  chosen: Chosen,
) {
  const used = usedPlanIds(s, queue, paused);
  const plans = (s.flightPlans ?? []).filter(
    (p) =>
      p.aircraftUuid === chosen.aircraftId &&
      p.status === "proposed" &&
      !used.has(p.uuid) &&
      !isPlanFlightOlder(s, p),
  );
  const compatible = records.filter(
    (r) => !r.aircraftUuid || r.aircraftUuid === chosen.aircraftId,
  );
  const checklist =
    compatible.find((r) => r.uuid === chosen.checklistId) ?? compatible[0];
  return {
    aircraft: s.aircraft.find((a) => a.uuid === chosen.aircraftId),
    plans,
    plan: plans.find((p) => p.uuid === chosen.planId) ?? plans[0],
    compatible,
    checklist,
    ...sectionChoices(checklistSections(checklist), chosen),
  };
}

// A chosen section counts while the checklist still has it.
function sectionChoices(lists: ChecklistList[], chosen: Chosen) {
  const has = (id?: string) => lists.some((l) => l.objectId === id);
  const { preflight, startSection, shutdown } = chosen;
  return {
    lists,
    startId:
      startSection === "" || has(startSection)
        ? startSection!
        : suggestedStartSection(lists),
    preflightId: has(preflight) ? preflight : suggestedPreflightSection(lists),
    shutdownId: has(shutdown) ? shutdown : suggestedShutdownSection(lists),
  };
}

// A draft outlives access changes: its aircraft, flight access and checklist
// (still readable, still for this aircraft) must all hold to continue.
function draftAvailable(
  s: Snapshot,
  draft: GuidedDraft,
  aircraft: Aircraft | undefined,
  records: ChecklistRecord[],
) {
  const checklist = records.find((r) => r.uuid === draft.checklist.uuid);
  return (
    !!aircraft &&
    can(s, aircraft.uuid, "flight") &&
    !!checklist &&
    checklistReadable(s, checklist) &&
    (!checklist.aircraftUuid || checklist.aircraftUuid === aircraft.uuid)
  );
}

// Every position is written back, so the other engine's reading is kept.
function withEngineStart(
  draft: GuidedDraft,
  positions: readonly EnginePosition[],
  engine: EnginePosition,
  key: EngineStartKey,
  typed: string,
) {
  return positions.map((position) => ({
    ...draft.engineStarts?.find((r) => r.engine === position),
    engine: position,
    ...(position === engine
      ? { [key]: typed === "" ? undefined : Number(typed) }
      : {}),
  }));
}

// Hobbs and tach always; the flight time log and collective hourmeter as any
// flight on the aircraft records them.
function shutdownMeters(draft: GuidedDraft, aircraft?: Aircraft) {
  const { opening } = draft;
  const shown = flightOptionalEntries(aircraft ?? {}, aircraft?.meter);
  const meters: {
    key: ShutdownKey;
    meter: Aircraft["meter"];
    label: string;
    opening?: number;
  }[] = [
    { key: "hobbsOn", meter: "hobbs", label: "Hobbs", opening: opening.hobbs },
    { key: "tachOn", meter: "tach", label: "Tach", opening: opening.tach },
  ];
  if (shown.flightTimeLog)
    meters.push({
      key: "flightTimeLogOn",
      meter: "flightTimeLog",
      label: "Flight time log",
      opening: opening.flightTimeLog,
    });
  if (shown.cyclic)
    meters.push({
      key: "cyclicHobbsOn",
      meter: "cyclic",
      label: "Collective hourmeter",
      opening: opening.cyclic,
    });
  return meters;
}

// A number, not text, so React compares it numerically and leaves an entry
// such as "2342.0" as typed.
function shutdownHours(draft: GuidedDraft, key: ShutdownKey) {
  const seconds = draft[key];
  return seconds === undefined ? "" : seconds / SECONDS_PER_HOUR;
}

// Only whole tenths of an hour are kept, as the flight log takes them; a
// refused entry leaves the last reading the field accepted.
function recordShutdown(d: Drafts, key: ShutdownKey, typed: string) {
  try {
    updateDraft(d, { [key]: parseHours(typed) });
  } catch (e) {
    d.setError(errorText(e));
  }
}

function reviewFlight(
  s: Snapshot,
  draft: GuidedDraft,
  aircraft: Aircraft | undefined,
  d: Drafts,
) {
  try {
    const input = flightInput(s, draft, aircraft);
    validateFlight(aircraft!, input);
    d.setReview(input);
    d.setError("");
  } catch (e) {
    d.setError(errorText(e, "Check the readings."));
  }
}

function flightInput(
  s: Snapshot,
  draft: GuidedDraft,
  aircraft: Aircraft | undefined,
): FlightInput {
  const { plan } = draft;
  return {
    aircraftUuid: draft.aircraftUuid,
    flightPlanUuid: plan.uuid,
    pilotId: s.user.id,
    startTime: draft.startedAt,
    hobbsOn: draft.hobbsOn,
    tachOn: draft.tachOn,
    cyclicHobbsOn: draft.cyclicHobbsOn,
    flightTimeLogOn: draft.flightTimeLogOn,
    engineStarts: aircraft?.turbine ? draft.engineStarts : undefined,
    fuel: draft.fuel,
    oil: draft.oil,
    checklistRun: guidedFlightLink(draft, !!aircraft?.twin),
    origin: plan.origin,
    destination: plan.destination,
    landings: plan.landings,
    cycles: plan.cycles,
    flightRules: plannedFlightRules(plan),
    operation: "Mission",
    remarks: `Planned route: ${plan.route}`,
    discrepancy: "",
  };
}
