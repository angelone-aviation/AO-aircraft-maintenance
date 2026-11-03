import { FlightFluidFields, type Fluids } from "./FlightFluids";
import type { FlightPlan } from "../domain/flightPlans";
import { flightEnginePositions, meterAtFlight } from "../domain/flights";
import { useId, useState } from "react";
import { useWorkspace } from "../data/store";
import {
  can,
  parseHours,
  type Flight,
  type FlightInput,
} from "../domain/model";
import { AsyncForm, value } from "./ui";
import { aircraftStatus, canOverrideDispatch } from "../domain/aircraftStatus";
import { DispatchGate } from "./AircraftStatus";
import { NoticeBar } from "./design";
import {
  FlightField,
  FlightSection,
  FlightTimeStrip,
  MeterBox,
} from "./FlightParts";
import {
  ArrowsClockwise,
  ClipboardText,
  CloudSlash,
  NotePencil,
  Warning,
} from "@phosphor-icons/react";
function localTime(iso: string) {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
const meterInputs = ["hobbs", "tach", "cyclic", "flightTimeLog"] as const;
type MeterInput = (typeof meterInputs)[number];
const readout = (seconds: number | undefined) =>
  seconds === undefined ? "Unknown" : (seconds / 3600).toFixed(1);
export function FlightForm({
  onDone,
  onCancel,
  initial,
  aircraftUuid,
  plan,
  prefill,
  openingOverride,
  operationUuid,
  phase = "all",
  onSavePreflight,
  dispatchOverrideReason,
}: {
  onDone: () => void;
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
  phase?: "all" | "preflight" | "end";
  onSavePreflight?: (input: FlightInput) => Promise<void>;
  /** An administrator override already entered, e.g. at guided flight start. */
  dispatchOverrideReason?: string;
}) {
  const { snapshot: s, enqueue, backend, online, connected } = useWorkspace();
  const aircrafts = s!.aircraft.filter(
    (a) => can(s!, a.uuid, "flight") || !!initial,
  );
  const [selected, setSelected] = useState(
    initial?.aircraftUuid ??
      plan?.aircraftUuid ??
      aircraftUuid ??
      aircrafts[0]?.uuid ??
      "",
  );
  const aircraft = aircrafts.find((a) => a.uuid === selected);
  // Freeze the readings together with their version so a live update cannot
  // silently change what the pilot verified while this form was open.
  const [openingReadings] = useState(() =>
    Object.fromEntries(
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
    ),
  );
  const opening = openingOverride ?? openingReadings[selected];
  const defaults = initial ?? prefill;
  const [fluids, setFluids] = useState<Fluids>({
    fuel: defaults?.fuel,
    oil: defaults?.oil,
  });
  const requiredMeter =
    aircraft && initial
      ? meterAtFlight(aircraft, initial.startTime)
      : aircraft?.meter;
  const startingHobbs = initial ? initial.hobbsOff : opening?.hobbs;
  const startingCyclic = initial ? initial.cyclicHobbsOff : opening?.cyclic;
  const showCyclic =
    aircraft?.helicopter ||
    requiredMeter === "cyclic" ||
    defaults?.cyclicHobbsOn !== undefined;
  const startingFlightTimeLog = initial
    ? initial.flightTimeLogOff
    : opening?.flightTimeLog;
  const showFlightTimeLog =
    aircraft?.flightTimeLog ||
    requiredMeter === "flightTimeLog" ||
    defaults?.flightTimeLogOn !== undefined;
  const startingTach = initial ? initial.tachOff : opening?.tach;
  const readingsChanged =
    !initial && aircraft && opening && aircraft.version !== opening.version;
  const engines = aircraft ? flightEnginePositions(aircraft, defaults) : [];
  const showLandingSurface =
    !!aircraft?.amphibious || defaults?.landingSurface != null;
  const optionalNumber = (data: FormData, name: string) =>
    value(data, name) === "" ? undefined : Number(value(data, name));
  const [decision, setDecision] = useState<"accept" | "reject">("accept");
  const [override, setOverride] = useState(dispatchOverrideReason ?? "");
  // Reviews correct existing records; only new flights pass the dispatch gate.
  const gated = !initial && !!aircraft;
  const grounded =
    gated && aircraftStatus(s!, aircraft.uuid).level === "grounded";
  const inputFrom = (data: FormData): FlightInput => ({
    ...fluids,
    oil: initial
      ? fluids.oil
      : fluids.oil?.map(({ end: _legacyEnd, ...reading }) => reading),
    checklistRun: defaults?.checklistRun,
    aircraftUuid: selected,
    flightPlanUuid: defaults?.flightPlanUuid ?? plan?.uuid,
    pilotId: value(data, "pilot"),
    copilotId: value(data, "copilot") || undefined,
    startTime: new Date(value(data, "time")).toISOString(),
    hobbsOn: parseHours(value(data, "hobbs")),
    tachOn: parseHours(value(data, "tach")),
    cyclicHobbsOn: showCyclic ? parseHours(value(data, "cyclic")) : undefined,
    flightTimeLogOn: showFlightTimeLog
      ? parseHours(value(data, "flightTimeLog"))
      : undefined,
    engineStarts: engines.length
      ? engines.map((engine) => ({
          engine,
          durationSeconds: optionalNumber(data, `${engine}-start-duration`),
          maxEgtC: optionalNumber(data, `${engine}-start-egt`),
        }))
      : undefined,
    landingSurface: showLandingSurface
      ? (value(data, "landingSurface") as FlightInput["landingSurface"]) || null
      : undefined,
    landings: Number(value(data, "landings")),
    cycles: aircraft?.turbine
      ? Number(value(data, "cycles"))
      : (initial?.cycles ?? 0),
    origin: value(data, "origin"),
    destination: value(data, "destination"),
    operation: value(data, "operation") as FlightInput["operation"],
    flightRules: value(data, "rules") as FlightInput["flightRules"],
    remarks: value(data, "remarks"),
    discrepancy: initial?.discrepancy ?? value(data, "discrepancy"),
  });

  // Presentation only: the ending readings typed so far drive the live
  // flight-time strip. The inputs stay uncontrolled form fields, keyed by the
  // aircraft so that switching aircraft clears them; readings typed for
  // another aircraft are ignored.
  const defaultEnd = (seconds: number | undefined) =>
    seconds === undefined ? "" : String(seconds / 3600);
  const [typedEnds, setTypedEnds] = useState<{
    aircraftUuid: string;
    ends: Record<MeterInput, string>;
  }>();
  const typed =
    typedEnds?.aircraftUuid === selected ? typedEnds.ends : undefined;
  const ends: Record<MeterInput, string> = typed ?? {
    hobbs: defaultEnd(defaults?.hobbsOn),
    tach: defaultEnd(defaults?.tachOn),
    cyclic: defaultEnd(defaults?.cyclicHobbsOn),
    flightTimeLog: defaultEnd(defaults?.flightTimeLogOn),
  };
  const meterName = (meter: MeterInput) =>
    meter === "hobbs"
      ? aircraft?.helicopter
        ? "run-time hourmeter"
        : "Hobbs"
      : meter === "tach"
        ? "tach"
        : meter === "cyclic"
          ? "Collective hourmeter"
          : "Flight time log";
  const startFor = (meter: MeterInput) =>
    meter === "hobbs"
      ? startingHobbs
      : meter === "tach"
        ? startingTach
        : meter === "cyclic"
          ? startingCyclic
          : startingFlightTimeLog;
  const meterHintId = useId();
  const verifyHint =
    phase === "preflight"
      ? "Closing readings will be entered when you end the flight."
      : undefined;
  const meterNotes = [
    !online &&
      "Starting readings are from the last synchronized aircraft record.",
    initial?.status === "review" &&
      "Starting readings are provisional until the flight sequence is reviewed.",
  ].filter(Boolean);
  const endInput = (name: MeterInput, defaultSeconds: number | undefined) => (
    <input
      name={name}
      type="number"
      min="0"
      step="0.1"
      placeholder="0.0"
      inputMode="decimal"
      defaultValue={defaultSeconds === undefined ? "" : defaultSeconds / 3600}
      required={requiredMeter === name}
    />
  );
  const routeCount =
    4 + (showLandingSurface ? 1 : 0) + (aircraft?.turbine ? 1 : 0);
  const rulesDefault =
    defaults?.flightRules ??
    (plan ? (["I", "Y"].includes(plan.flightRules) ? "IFR" : "VFR") : "VFR");
  const rulesId = useId();
  const discrepancyShown = !initial && phase !== "preflight";
  return (
    <div className="flight-form">
      <AsyncForm
        submitLabel={
          phase === "preflight"
            ? "Save preflight & start flight"
            : phase === "end"
              ? "End flight & save"
              : initial
                ? "Record review"
                : "Save flight"
        }
        disabled={
          !aircraft ||
          (!!initial && (!online || !connected)) ||
          // Administrators stay enabled; their override field is required.
          (grounded && !canOverrideDispatch(s!))
        }
        onClose={onCancel}
        onChange={(data) =>
          // The aircraft select's own change also bubbles here, while the
          // previous aircraft's readings are still in the form: tag them.
          setTypedEnds({
            aircraftUuid: selected,
            ends: Object.fromEntries(
              meterInputs.map((name) => [name, value(data, name)]),
            ) as Record<MeterInput, string>,
          })
        }
        onSubmit={async (data) => {
          const input = inputFrom(data);
          if (phase === "preflight") {
            if (!onSavePreflight)
              throw new Error("Preflight saving is unavailable.");
            await onSavePreflight(input);
            onDone();
            return;
          }
          if (initial)
            await backend!.review(
              initial.uuid,
              decision,
              value(data, "reason"),
              input,
            );
          else
            await enqueue({
              kind: "flight",
              uuid: operationUuid ?? crypto.randomUUID(),
              authorId: s!.user.id,
              baseVersion: opening.version,
              input,
              dispatchOverrideReason: grounded ? override.trim() : undefined,
            });
          onDone();
        }}
      >
        {gated && (
          <DispatchGate
            aircraftUuid={aircraft.uuid}
            reason={override}
            onReason={setOverride}
          />
        )}
        {plan && (
          <NoticeBar icon={ClipboardText} className="flight-notice">
            {phase === "preflight"
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
        <FlightSection title="Aircraft & crew">
          <div className="flight-grid">
            <FlightField label="Aircraft">
              <select
                value={selected}
                disabled={!!initial || !!plan || !!openingOverride}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setFluids({});
                }}
              >
                {aircrafts.map((a) => (
                  <option key={a.uuid} value={a.uuid}>
                    {a.registration} · {a.model}
                  </option>
                ))}
              </select>
            </FlightField>
            <FlightField label="Pilot">
              <select
                name="pilot"
                defaultValue={defaults?.pilotId ?? s!.user.id}
                required
              >
                {s!.members
                  .filter(
                    (m) =>
                      (m.active && m.availableAsPilot !== false) ||
                      m.id === defaults?.pilotId,
                  )
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </select>
            </FlightField>
            <FlightField
              label={
                <>
                  Copilot <span className="flight-optional">(optional)</span>
                </>
              }
            >
              <select name="copilot" defaultValue={defaults?.copilotId ?? ""}>
                <option value="">No copilot</option>
                {s!.members
                  .filter(
                    (m) =>
                      (m.active && m.availableAsPilot !== false) ||
                      m.id === defaults?.copilotId,
                  )
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </select>
            </FlightField>
            <FlightField
              label="Flight date & time"
              hint={`Your timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}. Stored with a UTC timestamp.`}
            >
              <input
                name="time"
                type="datetime-local"
                defaultValue={localTime(
                  defaults?.startTime ??
                    plan?.departureAt ??
                    new Date().toISOString(),
                )}
                required
              />
            </FlightField>
          </div>
        </FlightSection>
        <FlightSection
          title="Meter readings"
          hint="Read-only starts · verify against the aircraft meters"
          hintId={meterHintId}
        >
          {readingsChanged && (
            <NoticeBar
              tone="warn"
              icon={ArrowsClockwise}
              role="status"
              className="flight-notice"
            >
              Aircraft readings changed while this form was open. Close and
              reopen it to verify the latest readings, or save this entry for
              review.
            </NoticeBar>
          )}
          <div className="flight-meters" key={selected}>
            <MeterBox
              startLabel={
                aircraft?.helicopter
                  ? "Starting run-time hourmeter"
                  : "Starting Hobbs"
              }
              startSrSuffix=" (hours)"
              startValue={readout(startingHobbs)}
              describedBy={meterHintId}
              endLabel={`Ending ${aircraft?.helicopter ? "run-time hourmeter" : "Hobbs"} ${requiredMeter === "hobbs" ? "*" : ""}`}
              endInput={
                phase !== "preflight"
                  ? endInput("hobbs", defaults?.hobbsOn)
                  : undefined
              }
            />
            <MeterBox
              startLabel="Starting tach"
              startSrSuffix=" (hours)"
              startValue={readout(startingTach)}
              describedBy={meterHintId}
              endLabel={`Ending tach ${requiredMeter === "tach" ? "*" : ""}`}
              endInput={
                phase !== "preflight"
                  ? endInput("tach", defaults?.tachOn)
                  : undefined
              }
            />
            {showCyclic && (
              <MeterBox
                startLabel="Starting Collective hourmeter"
                startSrSuffix=" (hours)"
                startValue={readout(startingCyclic)}
                describedBy={meterHintId}
                endLabel="Ending Collective hourmeter"
                endSrSuffix=" (hours)"
                endInput={
                  phase !== "preflight"
                    ? endInput("cyclic", defaults?.cyclicHobbsOn)
                    : undefined
                }
              />
            )}
            {showFlightTimeLog && (
              <MeterBox
                startLabel="Starting Flight time log"
                startSrSuffix=" (hours)"
                startValue={readout(startingFlightTimeLog)}
                describedBy={meterHintId}
                endLabel="Ending Flight time log"
                endSrSuffix=" (hours)"
                endInput={
                  phase !== "preflight"
                    ? endInput("flightTimeLog", defaults?.flightTimeLogOn)
                    : undefined
                }
                hint={
                  phase !== "preflight"
                    ? "Enter the updated cumulative takeoff-to-touchdown hours from the flight-time log. Verify the start against the aircraft flight-time log."
                    : "Read-only · verify against the aircraft flight-time log"
                }
              />
            )}
          </div>
          {phase !== "preflight" && requiredMeter && (
            <FlightTimeStrip
              meterLabel={
                requiredMeter === "hobbs" && aircraft?.helicopter
                  ? "Run-time hourmeter"
                  : requiredMeter === "tach"
                    ? "Tach"
                    : meterName(requiredMeter)
              }
              entryName={meterName(requiredMeter)}
              startSeconds={startFor(requiredMeter)}
              endHours={ends[requiredMeter]}
            />
          )}
          {(verifyHint || meterNotes.length > 0) && (
            <p className="flight-note">
              {[verifyHint, ...meterNotes].filter(Boolean).join(" ")}
            </p>
          )}
        </FlightSection>
        {phase !== "preflight" && !!engines.length && (
          <FlightSection
            key={`${selected}:${engines.join(",")}`}
            title="Engine starts"
          >
            <div className="flight-engines">
              {engines.map((engine) => {
                const reading = defaults?.engineStarts?.find(
                  (s) => s.engine === engine,
                );
                const prefix =
                  engine === "single"
                    ? ""
                    : engine === "left"
                      ? "Left "
                      : "Right ";
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
        )}
        <FlightSection title="Route & operation">
          <div className="flight-grid">
            <FlightField label="Origin">
              <input
                name="origin"
                defaultValue={defaults?.origin ?? plan?.origin}
                maxLength={100}
                placeholder="Code or location; optional"
              />
            </FlightField>
            <FlightField label="Destination">
              <input
                name="destination"
                defaultValue={defaults?.destination ?? plan?.destination}
                maxLength={100}
                placeholder="Code or location; optional"
              />
            </FlightField>
            <FlightField label="Landings">
              <input
                name="landings"
                type="number"
                min="0"
                max="1000"
                step="1"
                inputMode="numeric"
                defaultValue={defaults?.landings ?? plan?.landings ?? 1}
                required
              />
            </FlightField>
            {showLandingSurface && (
              <FlightField label="Landing surface">
                <select
                  key={selected}
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
              <FlightField
                label={
                  aircraft?.model.trim().toUpperCase() === "R66"
                    ? "Engine start cycles"
                    : "Cycles"
                }
              >
                <input
                  key={selected}
                  name="cycles"
                  type="number"
                  min="0"
                  max="1000"
                  step="1"
                  inputMode="numeric"
                  defaultValue={defaults?.cycles ?? plan?.cycles ?? 1}
                  required
                />
              </FlightField>
            )}
            <div
              className="flight-field flight-rules"
              role="radiogroup"
              aria-labelledby={rulesId}
            >
              <span className="flight-field-label" id={rulesId}>
                Flight rules
              </span>
              <div className="flight-segmented">
                {(["VFR", "IFR"] as const).map((rule) => (
                  <label key={rule}>
                    <input
                      type="radio"
                      name="rules"
                      value={rule}
                      defaultChecked={rulesDefault === rule}
                    />
                    <span>{rule}</span>
                  </label>
                ))}
              </div>
            </div>
            <FlightField label="Type of operation" wide={routeCount % 2 === 0}>
              <select
                name="operation"
                defaultValue={defaults?.operation ?? "Mission"}
              >
                {[
                  "Gov medical",
                  "Mission medical",
                  "Mission",
                  "Commercial",
                  "Private",
                ].map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            </FlightField>
          </div>
        </FlightSection>
        <FlightFluidFields
          inventoryReadOnly={!!initial}
          fluids={fluids}
          onChange={setFluids}
          twin={aircraft?.twin}
          phase={
            phase === "preflight"
              ? "preflight"
              : phase === "end"
                ? "shutdown"
                : "all"
          }
          required={phase === "preflight" || !!prefill?.checklistRun}
        />
        <FlightSection
          title={discrepancyShown ? "Remarks & discrepancy" : "Remarks"}
        >
          <div className="flight-stack">
            <FlightField label="Remarks">
              <textarea
                name="remarks"
                defaultValue={
                  defaults?.remarks ??
                  (plan ? `Planned route: ${plan.route}` : "")
                }
                maxLength={5000}
                rows={2}
                placeholder="Anything worth noting about this flight"
              />
            </FlightField>
            {discrepancyShown && (
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
                  maxLength={5000}
                  rows={2}
                  placeholder="Any problem observed during this flight?"
                />
              </FlightField>
            )}
          </div>
        </FlightSection>
        {initial && (
          <FlightSection title="Review decision">
            <div className="flight-stack">
              <FlightField label="Review decision">
                <select
                  value={decision}
                  onChange={(e) =>
                    setDecision(e.target.value as "accept" | "reject")
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
                  minLength={5}
                  maxLength={5000}
                  required
                  rows={3}
                />
              </FlightField>
            </div>
          </FlightSection>
        )}
        {!online && phase !== "preflight" && (
          <NoticeBar tone="neutral" icon={CloudSlash} className="flight-notice">
            Offline · This entry will be saved on this device until it can sync.
          </NoticeBar>
        )}
      </AsyncForm>
    </div>
  );
}
