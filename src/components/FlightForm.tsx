/**
 * Responsibility: The flight log form: a new flight, the preflight or end of
 *   a flight session, or an administrator's review of a held flight.
 * Layer: UI. React component; new flights queue in the offline outbox and
 *   reviews save online.
 * Dependencies: react, @phosphor-icons/react, src/data/store.ts, src/domain
 *   (model, flights, flightPlans, flightReview, flightSession,
 *   flightSubmission, readings, aircraftStatus), ./FlightFluids, ./FlightParts, ./AircraftStatus,
 *   ./StaleSave, ./design, ./ui.
 */
import { useId, useState } from "react";
import {
  ArrowsClockwise,
  ClipboardText,
  CloudSlash,
  NotePencil,
  Warning,
} from "@phosphor-icons/react";
import { useWorkspace } from "../data/store";
import type { FlightPlan } from "../domain/flightPlans";
import {
  flightEnginePositions,
  flightOptionalEntries,
  meterAtFlight,
} from "../domain/flights";
import {
  heldFlightComparison,
  REVIEW_REASON_MAX_LENGTH,
  REVIEW_REASON_MIN_LENGTH,
} from "../domain/flightReview";
import { plannedFlightRules } from "../domain/flightSession";
import { aircraftAfterPendingFlights } from "../domain/flightSubmission";
import { SECONDS_PER_HOUR } from "../domain/readings";
import {
  can,
  FLIGHT_COUNT_MAX,
  FLIGHT_PLACE_MAX_LENGTH,
  flightInputSchema,
  isAvailablePilot,
  logsEngineStartsAsCycles,
  NOTE_MAX_LENGTH,
  parseHours,
  type Aircraft,
  type Flight,
  type FlightInput,
  type Operation,
  type QueuedOperation,
  type Snapshot,
} from "../domain/model";
import {
  aircraftStatus,
  canOverrideDispatch,
  groundedDuringFlight,
} from "../domain/aircraftStatus";
import { DispatchGate } from "./AircraftStatus";
import { FlightFluidFields, type Fluids } from "./FlightFluids";
import {
  FlightField,
  FlightSection,
  FlightTimeStrip,
  MeterBox,
} from "./FlightParts";
import { NoticeBar } from "./design";
import { AsyncForm, value } from "./ui";
import { DifferenceTable } from "./StaleSave";

const MINUTE_MS = 60_000;
const OPERATIONS = flightInputSchema.shape.operation.options;
const FLIGHT_RULES = flightInputSchema.shape.flightRules.options;
const METER_INPUTS = ["hobbs", "tach", "cyclic", "flightTimeLog"] as const;
/** The FlightInput field each ending meter reading fills. */
const METER_FIELDS = {
  hobbs: "hobbsOn",
  tach: "tachOn",
  cyclic: "cyclicHobbsOn",
  flightTimeLog: "flightTimeLogOn",
} as const;
const ENGINE_PREFIXES = { single: "", left: "Left ", right: "Right " };
const COUNT_INPUT = {
  type: "number",
  min: "0",
  max: String(FLIGHT_COUNT_MAX),
  step: "1",
  inputMode: "numeric",
} as const;
const FLUID_PHASES = {
  all: "all",
  preflight: "preflight",
  end: "shutdown",
} as const;

type MeterInput = (typeof METER_INPUTS)[number];
type TypedEnds = { aircraftUuid: string; ends: Record<MeterInput, string> };
type Draft = ReturnType<typeof useFlightDraft>;
type Model = ReturnType<typeof useFlightModel>;
type FlightFormProps = {
  onDone: () => void;
  /** Called with a new flight once it is queued, before `onDone`. */
  onSaved?: (flight: { uuid: string; aircraftUuid: string }) => void;
  /** Closes without saving; adds a secondary footer button beside Save. */
  onCancel?: () => void;
  initial?: Flight;
  aircraftUuid?: string;
  plan?: FlightPlan;
  prefill?: Partial<FlightInput>;
  openingOverride?: {
    version: number;
    hobbs: number;
    tach: number;
    cyclic?: number;
    flightTimeLog?: number;
  };
  operationUuid?: string;
  /** A failed outbox entry this flight replaces (Edit and retry): it is
   * discarded and the new entry queued under its own request id. */
  replaces?: string;
  phase?: "all" | "preflight" | "end";
  onSavePreflight?: (input: FlightInput) => Promise<void>;
  /** An administrator override already entered, e.g. at guided flight start. */
  dispatchOverrideReason?: string;
};

/**
 * Logs a flight: crew, meter readings, engine starts, route, fluids, remarks
 * and a discrepancy, or reviews a held flight (`initial`).
 *
 * @param props.initial - A held flight to review: its aircraft is fixed, its
 *   starting readings are the flight's own, and saving accepts or rejects it
 *   with a reason.
 * @param props.plan - A flight plan that fills in the aircraft, route, rules
 *   and counts, and is linked to the flight.
 * @param props.openingOverride - Starting readings and version to use instead
 *   of the aircraft's readings when the form opened.
 * @param props.phase - "preflight" saves fluids through `onSavePreflight`
 *   without closing readings; "end" collects them.
 * @param props.onSaved - Receives a new flight's uuid and aircraft once it is
 *   queued, so the caller can offer a logbook page photo.
 * @param props.replaces - A failed outbox entry to replace with this one.
 * @returns The form. A new flight queues in the outbox against the readings
 *   it opened with; a grounded aircraft needs an administrator's override.
 *   A review needs a connection and shows the held entry beside the
 *   aircraft's current totals. Preflight without `onSavePreflight` refuses
 *   with "Preflight saving is unavailable.".
 */
export function FlightForm(props: FlightFormProps) {
  const m = useFlightModel(props);
  const meterHintId = useId();
  const rulesId = useId();
  return (
    <div className="flight-form">
      <AsyncForm
        submitLabel={submitLabel(m.phase, !!props.initial)}
        disabled={saveBlocked(m)}
        onClose={props.onCancel}
        onChange={(data) => m.setTypedEnds(typedEndsFrom(m.selected, data))}
        onSubmit={(data) => submitFlight(m, data)}
      >
        <FlightNotices m={m} />
        <CrewSection m={m} />
        <MeterSection m={m} hintId={meterHintId} />
        {m.phase !== "preflight" && !!m.engines.length && (
          <EngineStartsSection
            key={`${m.selected}:${m.engines.join(",")}`}
            m={m}
          />
        )}
        <RouteSection m={m} rulesId={rulesId} />
        <FluidFields m={m} />
        <RemarksSection m={m} />
        {props.initial && <ReviewSection m={m} />}
        {!m.online && m.phase !== "preflight" && <OfflineNotice />}
      </AsyncForm>
    </div>
  );
}

function useFlightModel(props: FlightFormProps) {
  const { snapshot, queue, enqueue, replace, backend, online, connected } =
    useWorkspace();
  const s = snapshot!;
  const draft = useFlightDraft(props, s, queue);
  return {
    props,
    phase: props.phase ?? "all",
    s,
    enqueue,
    replace,
    backend,
    online,
    connected,
    ...draft,
    ...flightView(props, s, draft),
  };
}

function useFlightDraft(
  props: FlightFormProps,
  s: Snapshot,
  queue: QueuedOperation[],
) {
  // The entry an Edit and retry replaces is not an earlier leg of itself.
  const pending = queue
    .map((q) => q.operation)
    .filter((op) => op.uuid !== props.replaces);
  const choice = useAircraftChoice(props, s, pending);
  const defaults = props.initial ?? props.prefill;
  const [fluids, setFluids] = useState<Fluids>({
    fuel: defaults?.fuel,
    oil: defaults?.oil,
  });
  const [decision, setDecision] = useState<"accept" | "reject">("accept");
  const [override, setOverride] = useState(props.dispatchOverrideReason ?? "");
  // Presentation only: the ending readings typed so far drive the live
  // flight-time strip. The inputs stay uncontrolled form fields, keyed by the
  // aircraft so that switching aircraft clears them; readings typed for
  // another aircraft are ignored.
  const [typedEnds, setTypedEnds] = useState<TypedEnds>();
  return {
    ...choice,
    defaults,
    fluids,
    setFluids,
    decision,
    setDecision,
    override,
    setOverride,
    typedEnds,
    setTypedEnds,
  };
}

function useAircraftChoice(
  props: FlightFormProps,
  s: Snapshot,
  pending: Operation[],
) {
  const { initial, plan } = props;
  const aircrafts = s.aircraft.filter(
    (a) => can(s, a.uuid, "flight") || !!initial,
  );
  const [selected, setSelected] = useState(
    initial?.aircraftUuid ??
      plan?.aircraftUuid ??
      props.aircraftUuid ??
      aircrafts[0]?.uuid ??
      "",
  );
  // Freeze the readings together with their version so a live update cannot
  // silently change what the pilot verified while this form was open. A leg
  // logged behind the user's own unsynced legs starts where they end.
  const [openingReadings] = useState(() =>
    openingReadingsOf(aircrafts.map((a) => afterPending(s, a, pending))),
  );
  const opening = props.openingOverride ?? openingReadings[selected];
  return { aircrafts, selected, setSelected, opening, pending };
}

// What the form shows for the chosen aircraft. A review starts from the
// flight's own closing readings, a new flight from the opening readings.
function flightView(props: FlightFormProps, s: Snapshot, d: Draft) {
  const { initial } = props;
  const { defaults, opening } = d;
  const aircraft = d.aircrafts.find((a) => a.uuid === d.selected);
  const requiredMeter =
    aircraft && initial
      ? meterAtFlight(aircraft, initial.startTime)
      : aircraft?.meter;
  const typed =
    d.typedEnds?.aircraftUuid === d.selected ? d.typedEnds.ends : undefined;
  const shown = flightOptionalEntries(aircraft ?? {}, requiredMeter, defaults);
  return {
    aircraft,
    requiredMeter,
    starts: startingReadings(initial, opening),
    ends: typed ?? defaultEnds(defaults),
    showCyclic: shown.cyclic,
    showFlightTimeLog: shown.flightTimeLog,
    readingsChanged:
      !initial &&
      aircraft &&
      opening &&
      afterPending(s, aircraft, d.pending).version !== opening.version,
    engines: aircraft ? flightEnginePositions(aircraft, defaults) : [],
    showLandingSurface: shown.landingSurface,
    ...dispatchState(props, s, aircraft),
  };
}

// Reviews correct existing records; only new flights pass the dispatch gate.
// Ending a started flight the aircraft was grounded after it began skips it:
// the entry is saved and held for review (decision D6).
function dispatchState(
  props: FlightFormProps,
  s: Snapshot,
  aircraft: Aircraft | undefined,
) {
  const startTime = props.phase === "end" ? props.prefill?.startTime : "";
  if (props.initial || !aircraft)
    return { gated: false, grounded: false, heldInFlight: false };
  if (startTime && groundedDuringFlight(s, aircraft.uuid, startTime))
    return { gated: false, grounded: false, heldInFlight: true };
  const grounded = aircraftStatus(s, aircraft.uuid).level === "grounded";
  return { gated: true, grounded, heldInFlight: false };
}

function FluidFields({ m }: { m: Model }) {
  const { initial, prefill } = m.props;
  return (
    <FlightFluidFields
      inventoryReadOnly={!!initial}
      fluids={m.fluids}
      onChange={m.setFluids}
      twin={m.aircraft?.twin}
      phase={FLUID_PHASES[m.phase]}
      required={m.phase === "preflight" || !!prefill?.checklistRun}
    />
  );
}

function GroundedInFlightNotice({ m }: { m: Model }) {
  return (
    <NoticeBar
      tone="warn"
      icon={Warning}
      role="status"
      className="flight-notice"
    >
      <strong>
        {m.aircraft!.registration} was grounded during this flight.
      </strong>{" "}
      Save the flight to record it: it will be held for an administrator's
      review, and aircraft totals stay unchanged until then. No new flight can
      start until the grounding items are resolved or deferred.
    </NoticeBar>
  );
}

function OfflineNotice() {
  return (
    <NoticeBar tone="neutral" icon={CloudSlash} className="flight-notice">
      Offline · This entry will be saved on this device until it can sync.
    </NoticeBar>
  );
}

function FlightNotices({ m }: { m: Model }) {
  const { initial, plan } = m.props;
  return (
    <>
      {m.gated && (
        <DispatchGate
          aircraftUuid={m.aircraft!.uuid}
          reason={m.override}
          onReason={m.setOverride}
        />
      )}
      {m.heldInFlight && <GroundedInFlightNotice m={m} />}
      {plan && (
        <NoticeBar icon={ClipboardText} className="flight-notice">
          {m.phase === "preflight"
            ? "Flight plan details are filled in below. Confirm the actual departure date and pilot, then enter preflight fuel and oil. The saved preflight remains linked to this plan."
            : "Verify the actual date, pilot, cycles, landings, and ending meter readings below. Saving links this entry to the plan; planned duration is never used as an actual meter reading."}
        </NoticeBar>
      )}
      {initial && (
        <NoticeBar
          tone={initial.reviewReason ? "warn" : "blue"}
          icon={initial.reviewReason ? Warning : NotePencil}
          className="flight-notice"
        >
          {initial.reviewReason ??
            "Corrections preserve original values in the audit history and recheck subsequent flights."}
        </NoticeBar>
      )}
      {initial?.status === "review" && m.aircraft && (
        <HeldFlightReview flight={initial} aircraft={m.aircraft} />
      )}
    </>
  );
}

// The held entry beside the aircraft as it stands, so the reviewer sees what
// the reason above refers to before correcting or accepting the entry.
function HeldFlightReview({
  flight,
  aircraft,
}: {
  flight: Flight;
  aircraft: Aircraft;
}) {
  return (
    <FlightSection title="Held entry beside the aircraft now">
      <DifferenceTable
        differences={heldFlightComparison(flight, aircraft)}
        mineLabel="Held entry"
        theirsLabel="Aircraft now"
        empty="The entry matches the aircraft's current totals."
      />
    </FlightSection>
  );
}

function CrewSection({ m }: { m: Model }) {
  const { s, defaults, props } = m;
  return (
    <FlightSection title="Aircraft & crew">
      <div className="flight-grid">
        <FlightField label="Aircraft">
          <select
            value={m.selected}
            disabled={
              !!props.initial || !!props.plan || !!props.openingOverride
            }
            onChange={(e) => {
              m.setSelected(e.target.value);
              m.setFluids({});
            }}
          >
            {m.aircrafts.map((a) => (
              <option key={a.uuid} value={a.uuid}>
                {a.registration} · {a.model}
              </option>
            ))}
          </select>
        </FlightField>
        <FlightField label="Pilot">
          <select
            name="pilot"
            defaultValue={defaults?.pilotId ?? s.user.id}
            required
          >
            {memberOptions(s, defaults?.pilotId)}
          </select>
        </FlightField>
        <CopilotField m={m} />
        <FlightTimeField m={m} />
      </div>
    </FlightSection>
  );
}

function CopilotField({ m }: { m: Model }) {
  return (
    <FlightField
      label={
        <>
          Copilot <span className="flight-optional">(optional)</span>
        </>
      }
    >
      <select name="copilot" defaultValue={m.defaults?.copilotId ?? ""}>
        <option value="">No copilot</option>
        {memberOptions(m.s, m.defaults?.copilotId)}
      </select>
    </FlightField>
  );
}

function FlightTimeField({ m }: { m: Model }) {
  const start =
    m.defaults?.startTime ??
    m.props.plan?.departureAt ??
    new Date().toISOString();
  return (
    <FlightField
      label="Flight date & time"
      hint={`Your timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}. Stored with a UTC timestamp.`}
    >
      <input
        name="time"
        type="datetime-local"
        defaultValue={localTime(start)}
        required
      />
    </FlightField>
  );
}

function MeterSection({ m, hintId }: { m: Model; hintId: string }) {
  const notes = meterNotes(m);
  const required = m.requiredMeter;
  return (
    <FlightSection
      title="Meter readings"
      hint="Read-only starts · verify against the aircraft meters"
      hintId={hintId}
    >
      {m.readingsChanged && (
        <NoticeBar
          tone="warn"
          icon={ArrowsClockwise}
          role="status"
          className="flight-notice"
        >
          Aircraft readings changed while this form was open. Close and reopen
          it to verify the latest readings, or save this entry for review.
        </NoticeBar>
      )}
      <MeterBoxes key={m.selected} m={m} hintId={hintId} />
      {m.phase !== "preflight" && required && (
        <FlightTimeStrip
          meterLabel={stripLabel(required, m.aircraft?.helicopter)}
          entryName={meterName(required, m.aircraft?.helicopter)}
          startSeconds={m.starts[required]}
          endHours={m.ends[required]}
        />
      )}
      {notes.length > 0 && <p className="flight-note">{notes.join(" ")}</p>}
    </FlightSection>
  );
}

function MeterBoxes({ m, hintId }: { m: Model; hintId: string }) {
  const helicopter = m.aircraft?.helicopter;
  const box = (meter: MeterInput) => ({
    startLabel: `Starting ${meterName(meter, helicopter)}`,
    startSrSuffix: " (hours)",
    startValue: readout(m.starts[meter]),
    describedBy: hintId,
    endInput: m.phase !== "preflight" ? endInput(m, meter) : undefined,
  });
  const endLabel = (meter: MeterInput) =>
    `Ending ${meterName(meter, helicopter)} ${m.requiredMeter === meter ? "*" : ""}`;
  return (
    <div className="flight-meters">
      <MeterBox {...box("hobbs")} endLabel={endLabel("hobbs")} />
      <MeterBox {...box("tach")} endLabel={endLabel("tach")} />
      {m.showCyclic && (
        <MeterBox
          {...box("cyclic")}
          endLabel="Ending Collective hourmeter"
          endSrSuffix=" (hours)"
        />
      )}
      {m.showFlightTimeLog && (
        <MeterBox
          {...box("flightTimeLog")}
          endLabel="Ending Flight time log"
          endSrSuffix=" (hours)"
          hint={
            m.phase !== "preflight"
              ? "Enter the updated cumulative takeoff-to-touchdown hours from the flight-time log. Verify the start against the aircraft flight-time log."
              : "Read-only · verify against the aircraft flight-time log"
          }
        />
      )}
    </div>
  );
}

function EngineStartsSection({ m }: { m: Model }) {
  return (
    <FlightSection title="Engine starts">
      <div className="flight-engines">
        {m.engines.map((engine) => {
          const reading = m.defaults?.engineStarts?.find(
            (s) => s.engine === engine,
          );
          const prefix = ENGINE_PREFIXES[engine];
          return (
            <div className="flight-grid flight-engine" key={engine}>
              <FlightField
                label={`${prefix}Start time (seconds)`}
                hint="Engine-start duration"
              >
                <input
                  name={`${engine}-start-duration`}
                  type="number"
                  min="0"
                  step="any"
                  inputMode="decimal"
                  defaultValue={reading?.durationSeconds ?? ""}
                />
              </FlightField>
              <FlightField label={`${prefix}Start max EGT (°C)`}>
                <input
                  name={`${engine}-start-egt`}
                  type="number"
                  step="any"
                  inputMode="decimal"
                  defaultValue={reading?.maxEgtC ?? ""}
                />
              </FlightField>
            </div>
          );
        })}
      </div>
    </FlightSection>
  );
}

function RouteSection({ m, rulesId }: { m: Model; rulesId: string }) {
  const { defaults, props } = m;
  // In the two-column grid, the operation field would sit alone on its row
  // after an even number of fields, so it spans the row instead.
  const fieldsBefore =
    4 + (m.showLandingSurface ? 1 : 0) + (m.aircraft?.turbine ? 1 : 0);
  return (
    <FlightSection title="Route & operation">
      <div className="flight-grid">
        {(["origin", "destination"] as const).map((place) => (
          <FlightField
            key={place}
            label={place === "origin" ? "Origin" : "Destination"}
          >
            <input
              name={place}
              defaultValue={defaults?.[place] ?? props.plan?.[place]}
              maxLength={FLIGHT_PLACE_MAX_LENGTH}
              placeholder="Code or location; optional"
            />
          </FlightField>
        ))}
        <CountFields m={m} />
        <RulesField m={m} rulesId={rulesId} />
        <FlightField label="Type of operation" wide={fieldsBefore % 2 === 0}>
          <select
            name="operation"
            defaultValue={defaults?.operation ?? "Mission"}
          >
            {OPERATIONS.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </FlightField>
      </div>
    </FlightSection>
  );
}

function CountFields({ m }: { m: Model }) {
  const { defaults, aircraft } = m;
  const plan = m.props.plan;
  return (
    <>
      <FlightField label="Landings">
        <input
          name="landings"
          {...COUNT_INPUT}
          defaultValue={defaults?.landings ?? plan?.landings ?? 1}
          required
        />
      </FlightField>
      {m.showLandingSurface && (
        <FlightField label="Landing surface">
          <select
            key={m.selected}
            name="landingSurface"
            defaultValue={defaults?.landingSurface ?? ""}
          >
            <option value="">Select Sea or Land</option>
            <option value="sea">Sea</option>
            <option value="land">Land</option>
          </select>
        </FlightField>
      )}
      {aircraft?.turbine && (
        <FlightField label={cyclesLabel(aircraft.model)}>
          <input
            key={m.selected}
            name="cycles"
            {...COUNT_INPUT}
            defaultValue={defaults?.cycles ?? plan?.cycles ?? 1}
            required
          />
        </FlightField>
      )}
    </>
  );
}

function RulesField({ m, rulesId }: { m: Model; rulesId: string }) {
  const chosen = rulesDefault(m.defaults?.flightRules, m.props.plan);
  return (
    <div
      className="flight-field flight-rules"
      role="radiogroup"
      aria-labelledby={rulesId}
    >
      <span className="flight-field-label" id={rulesId}>
        Flight rules
      </span>
      <div className="flight-segmented">
        {FLIGHT_RULES.map((rule) => (
          <label key={rule}>
            <input
              type="radio"
              name="rules"
              value={rule}
              defaultChecked={chosen === rule}
            />
            <span>{rule}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function RemarksSection({ m }: { m: Model }) {
  const { initial, plan } = m.props;
  const discrepancyShown = !initial && m.phase !== "preflight";
  return (
    <FlightSection
      title={discrepancyShown ? "Remarks & discrepancy" : "Remarks"}
    >
      <div className="flight-stack">
        <FlightField label="Remarks">
          <textarea
            name="remarks"
            defaultValue={
              m.defaults?.remarks ??
              (plan ? `Planned route: ${plan.route}` : "")
            }
            maxLength={NOTE_MAX_LENGTH}
            rows={2}
            placeholder="Anything worth noting about this flight"
          />
        </FlightField>
        {discrepancyShown && (
          <DiscrepancyField defaultValue={m.defaults?.discrepancy} />
        )}
      </div>
    </FlightSection>
  );
}

// Prefilled on Edit and retry: the failed entry may hold the only copy of
// the defect the pilot wrote.
function DiscrepancyField({ defaultValue }: { defaultValue?: string }) {
  return (
    <FlightField
      className="flight-discrepancy"
      label={
        <>
          <Warning
            size={16}
            weight="bold"
            className="flight-discrepancy-icon"
            aria-hidden="true"
          />
          Discrepancy
        </>
      }
      hint="This creates a linked open report, even if the flight requires review."
    >
      <textarea
        name="discrepancy"
        defaultValue={defaultValue}
        maxLength={NOTE_MAX_LENGTH}
        rows={2}
        placeholder="Any problem observed during this flight?"
      />
    </FlightField>
  );
}

function ReviewSection({ m }: { m: Model }) {
  return (
    <FlightSection title="Review decision">
      <div className="flight-stack">
        <FlightField label="Review decision">
          <select
            value={m.decision}
            onChange={(e) =>
              m.setDecision(e.target.value as "accept" | "reject")
            }
          >
            <option value="accept">
              Accept corrected entry and recalculate totals
            </option>
            <option value="reject">
              Reject entry and exclude it from totals
            </option>
          </select>
        </FlightField>
        <FlightField label="Explanation">
          <textarea
            name="reason"
            minLength={REVIEW_REASON_MIN_LENGTH}
            maxLength={REVIEW_REASON_MAX_LENGTH}
            required
            rows={3}
          />
        </FlightField>
      </div>
    </FlightSection>
  );
}

function saveBlocked(m: Model) {
  return (
    !m.aircraft ||
    (!!m.props.initial && (!m.online || !m.connected)) ||
    // Administrators stay enabled; their override field is required.
    (m.grounded && !canOverrideDispatch(m.s))
  );
}

async function submitFlight(m: Model, data: FormData) {
  const { initial, onDone } = m.props;
  const input = flightInput(m, data);
  if (m.phase === "preflight") {
    if (!m.props.onSavePreflight)
      throw new Error("Preflight saving is unavailable.");
    await m.props.onSavePreflight(input);
    onDone();
    return;
  }
  if (initial)
    await m.backend!.review(
      initial.uuid,
      m.decision,
      value(data, "reason"),
      input,
    );
  else await queueFlight(m, input);
  onDone();
}

// An edited retry replaces the failed entry; everything else queues as new.
async function queueFlight(m: Model, input: FlightInput) {
  const operation = {
    kind: "flight" as const,
    uuid: m.props.operationUuid ?? crypto.randomUUID(),
    authorId: m.s.user.id,
    baseVersion: m.opening.version,
    input,
    dispatchOverrideReason: m.grounded ? m.override.trim() : undefined,
  };
  await (m.props.replaces
    ? m.replace(m.props.replaces, operation)
    : m.enqueue(operation));
  m.props.onSaved?.({
    uuid: operation.uuid,
    aircraftUuid: input.aircraftUuid,
  });
}

function flightInput(m: Model, data: FormData): FlightInput {
  const { initial, plan } = m.props;
  const { defaults, fluids } = m;
  return {
    ...fluids,
    // Legacy shutdown oil levels stay on the stored flight a review
    // corrects; a new flight never records one.
    oil: initial
      ? fluids.oil
      : fluids.oil?.map(({ end: _legacyEnd, ...reading }) => reading),
    checklistRun: defaults?.checklistRun,
    aircraftUuid: m.selected,
    flightPlanUuid: defaults?.flightPlanUuid ?? plan?.uuid,
    pilotId: value(data, "pilot"),
    copilotId: value(data, "copilot") || undefined,
    startTime: new Date(value(data, "time")).toISOString(),
    ...meterReadings(m, data),
    engineStarts: engineStarts(m.engines, data),
    landingSurface: m.showLandingSurface
      ? (value(data, "landingSurface") as FlightInput["landingSurface"]) || null
      : undefined,
    landings: Number(value(data, "landings")),
    cycles: m.aircraft?.turbine
      ? Number(value(data, "cycles"))
      : (initial?.cycles ?? 0),
    origin: value(data, "origin"),
    destination: value(data, "destination"),
    operation: value(data, "operation") as FlightInput["operation"],
    flightRules: value(data, "rules") as FlightInput["flightRules"],
    remarks: value(data, "remarks"),
    discrepancy: initial?.discrepancy ?? value(data, "discrepancy"),
  };
}

function meterReadings(m: Model, data: FormData) {
  const hours = (meter: MeterInput) => parseHours(value(data, meter));
  return {
    hobbsOn: hours("hobbs"),
    tachOn: hours("tach"),
    cyclicHobbsOn: m.showCyclic ? hours("cyclic") : undefined,
    flightTimeLogOn: m.showFlightTimeLog ? hours("flightTimeLog") : undefined,
  };
}

function engineStarts(engines: Model["engines"], data: FormData) {
  if (!engines.length) return undefined;
  return engines.map((engine) => ({
    engine,
    durationSeconds: optionalNumber(data, `${engine}-start-duration`),
    maxEgtC: optionalNumber(data, `${engine}-start-egt`),
  }));
}

function optionalNumber(data: FormData, name: string) {
  return value(data, name) === "" ? undefined : Number(value(data, name));
}

// The aircraft select's own change also bubbles to the form while the
// previous aircraft's readings are still in it, so they are tagged with it.
function typedEndsFrom(aircraftUuid: string, data: FormData): TypedEnds {
  return {
    aircraftUuid,
    ends: Object.fromEntries(
      METER_INPUTS.map((name) => [name, value(data, name)]),
    ) as Record<MeterInput, string>,
  };
}

function afterPending(s: Snapshot, a: Aircraft, pending: Operation[]) {
  return aircraftAfterPendingFlights(s, a.uuid, pending) ?? a;
}

function openingReadingsOf(aircrafts: Snapshot["aircraft"]) {
  return Object.fromEntries(
    aircrafts.map((a) => [
      a.uuid,
      {
        version: a.version,
        hobbs: a.currentHobbs,
        tach: a.currentTach,
        cyclic: a.currentCyclicHobbs,
        flightTimeLog: a.currentFlightTimeLog,
      },
    ]),
  );
}

function startingReadings(
  initial: Flight | undefined,
  opening: Draft["opening"] | undefined,
): Record<MeterInput, number | undefined> {
  if (initial)
    return {
      hobbs: initial.hobbsOff,
      tach: initial.tachOff,
      cyclic: initial.cyclicHobbsOff,
      flightTimeLog: initial.flightTimeLogOff,
    };
  return {
    hobbs: opening?.hobbs,
    tach: opening?.tach,
    cyclic: opening?.cyclic,
    flightTimeLog: opening?.flightTimeLog,
  };
}

function defaultEnds(defaults: Draft["defaults"]) {
  const hours = (seconds: number | undefined) =>
    seconds === undefined ? "" : String(seconds / SECONDS_PER_HOUR);
  return Object.fromEntries(
    METER_INPUTS.map((meter) => [
      meter,
      hours(defaults?.[METER_FIELDS[meter]]),
    ]),
  ) as Record<MeterInput, string>;
}

function endInput(m: Model, meter: MeterInput) {
  const seconds = m.defaults?.[METER_FIELDS[meter]];
  return (
    <input
      name={meter}
      type="number"
      min="0"
      step="0.1"
      placeholder="0.0"
      inputMode="decimal"
      defaultValue={seconds === undefined ? "" : seconds / SECONDS_PER_HOUR}
      required={m.requiredMeter === meter}
    />
  );
}

function meterNotes(m: Model) {
  return [
    m.phase === "preflight" &&
      "Closing readings will be entered when you end the flight.",
    !m.online &&
      "Starting readings are from the last synchronized aircraft record.",
    m.props.initial?.status === "review" &&
      "Starting readings are provisional until the flight sequence is reviewed.",
  ].filter(Boolean);
}

function meterName(meter: MeterInput, helicopter: boolean | undefined) {
  if (meter === "hobbs") return helicopter ? "run-time hourmeter" : "Hobbs";
  if (meter === "tach") return "tach";
  return meter === "cyclic" ? "Collective hourmeter" : "Flight time log";
}

function stripLabel(meter: MeterInput, helicopter: boolean | undefined) {
  if (meter === "hobbs" && helicopter) return "Run-time hourmeter";
  return meter === "tach" ? "Tach" : meterName(meter, helicopter);
}

function memberOptions(s: Snapshot, keep: string | undefined) {
  return s.members
    .filter((m) => isAvailablePilot(m) || m.id === keep)
    .map((m) => (
      <option key={m.id} value={m.id}>
        {m.name}
      </option>
    ));
}

function rulesDefault(saved: string | undefined, plan: FlightPlan | undefined) {
  if (saved !== undefined) return saved;
  return plan ? plannedFlightRules(plan) : "VFR";
}

function cyclesLabel(model: string) {
  return logsEngineStartsAsCycles(model) ? "Engine start cycles" : "Cycles";
}

function submitLabel(phase: "all" | "preflight" | "end", review: boolean) {
  if (phase === "preflight") return "Save preflight & start flight";
  if (phase === "end") return "End flight & save";
  return review ? "Record review" : "Save flight";
}

function localTime(iso: string) {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * MINUTE_MS)
    .toISOString()
    .slice(0, 16);
}

function readout(seconds: number | undefined) {
  return seconds === undefined
    ? "Unknown"
    : (seconds / SECONDS_PER_HOUR).toFixed(1);
}
