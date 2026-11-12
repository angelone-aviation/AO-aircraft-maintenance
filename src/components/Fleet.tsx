/**
 * Responsibility: The fleet screens: the aircraft form and page, and the
 *   Flight Programs page and dialog.
 * Layer: UI. React components; aircraft and program rules live in src/domain.
 * Dependencies: react, @tanstack/react-router, src/data/store.ts, src/domain
 *   (aircraftStatus, addresses, programs, programTransfers, model, fleet,
 *   readings, aircraftSetup), ./Costs, ./AircraftStatus, ./AircraftPhoto,
 *   ./Components, ./design, ./OpsList, ./ui and others,
 *   src/styles/screens/fleet.css.
 */
import { AircraftCostSummary } from "./Costs";
import {
  AircraftStatusReasons,
  STATUS_ICON,
  STATUS_TONE,
} from "./AircraftStatus";
import {
  aircraftStatusLabels,
  shownAircraftStatus,
  type ShownAircraftStatus,
} from "../domain/aircraftStatus";
import { AircraftPhoto } from "./AircraftPhoto";
import { AddressFields } from "./AddressFields";
import { addressFromForm } from "../domain/addresses";
import { DrsComboBox } from "./DrsComboBox";
import { ComponentForm } from "./Components";
import { AircraftManuals } from "./Manuals";
import { AircraftEngineTrends } from "./EngineTrends";
import { programPermission } from "../domain/programs";
import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useWorkspace } from "../data/store";
import {
  can,
  aircraftMeterLabels,
  hours,
  logsEngineStartsAsCycles,
  recordedTotalSeconds,
  type Aircraft,
  type Snapshot,
} from "../domain/model";
import { hoursField, parseHours } from "../domain/readings";
import {
  FLEET_NAME_MAX_LENGTH,
  parseAdjustment,
  normalizeWebsite,
  type Program,
  type AircraftInput,
  type FleetCommand,
  operationalStatusLabels,
} from "../domain/fleet";
import { TRANSFER_REASON_MAX_LENGTH } from "../domain/programTransfers";
import { SETUP_GAPS, setupStatus } from "../domain/aircraftSetup";
import { AsyncForm, Field, Modal, value, safeHref } from "./ui";
import { History } from "./ManagementShared";
import {
  ArrowsLeftRight,
  Buildings,
  CheckCircle,
  ListChecks,
  Plus,
  WifiSlash,
} from "@phosphor-icons/react";
import {
  AircraftArt,
  EmptyState,
  IconTile,
  ListCard,
  NoticeBar,
  PageHeader,
  SearchField,
  StatusPill,
  Toolbar,
} from "./design";
import { OpsList, OpsMeters, OpsRow } from "./OpsList";
import "../styles/screens/fleet.css";

const ROW_ART_WIDTH = 96;

const TEXT_FIELDS = [
  ["registration", "Registration"],
  ["make", "Make"],
  ["model", "Model"],
  ["serial", "Serial number"],
] as const;
const OPTION_FIELDS = [
  ["twin", "Twin"],
  ["turbine", "Turbine"],
  ["amphibious", "Amphibious"],
] as const;

type Meter = Aircraft["meter"];
type TransferKind = "aircraft" | "component" | "location";

/**
 * Adds an aircraft, or edits one, with its meters, counters and options; a
 * meter switch keeps total time by moving the adjustment.
 *
 * @param initial - The aircraft to edit; none adds one.
 * @param onDone - Called with the aircraft's uuid after it is saved.
 */
export function AircraftForm({
  initial,
  onDone,
}: {
  initial?: Aircraft;
  onDone: (aircraftUuid: string) => void;
}) {
  const form = useAircraftForm(initial);
  return (
    <AsyncForm
      disabled={!form.writable}
      submitLabel={initial ? "Save aircraft" : "Add aircraft"}
      onSubmit={async (d) => {
        const command = aircraftSaveCommand(d, form, initial);
        await form.save(command);
        onDone(command.aircraft.uuid);
      }}
    >
      {initial ? (
        <AircraftPhoto aircraftUuid={initial.uuid} />
      ) : (
        <p className="muted">
          Save the aircraft, then open Edit aircraft to add its dashboard photo.
        </p>
      )}
      <AircraftIdentity s={form.s} initial={initial} />
      <AircraftOptions form={form} initial={initial} />
      <MaintenanceTime form={form} />
      <AircraftCounters form={form} initial={initial} />
      {initial && (
        <p className="muted">
          Counter changes are recorded separately from flights.
          Installed-component baselines are adjusted to preserve their
          accumulated usage.
        </p>
      )}
      {initial && <History uuid={initial.uuid} />}
    </AsyncForm>
  );
}

/** The Aircraft screen: the fleet list, each aircraft's record and the
 * aircraft form; a program administrator adds aircraft, and changes need a
 * connection. */
export function AircraftPage() {
  const page = useAircraftPage();
  const { s, writable, setSelected, setComponentAircraft } = page;
  return (
    <div className="ops-page">
      <AircraftHeader
        s={s}
        writable={writable}
        onAdd={() => setSelected("new")}
      />
      <AircraftToolbar page={page} />
      {!writable && (
        <NoticeBar tone="neutral" icon={WifiSlash}>
          Aircraft records are available offline. Reconnect to add or edit.
        </NoticeBar>
      )}
      <AircraftList
        aircraft={page.aircraft}
        writable={writable}
        onEdit={setSelected}
        onAddComponent={setComponentAircraft}
      />
      {page.componentAircraft && (
        <InitialComponentDialog
          aircraft={page.componentAircraft}
          onClose={() => setComponentAircraft(null)}
        />
      )}
      {page.selected && (
        <AircraftDialog
          selected={page.selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

/** The Flight Programs screen: every program for a system administrator, the
 * active one for anyone else. */
export function ProgramsPage() {
  const { s, writable } = useFleet();
  const [selected, setSelected] = useState<Program | "new" | null>(null);
  const record = selected && selected !== "new" ? selected : undefined;
  const programs = (s.programs ?? []).filter(
    (p) => s.user.isAdmin || p.uuid === s.activeProgramUuid,
  );
  return (
    <div className="ops-page">
      <ProgramsHeader
        admin={s.user.isAdmin}
        writable={writable}
        onAdd={() => setSelected("new")}
      />
      <ProgramList
        s={s}
        programs={programs}
        writable={writable}
        onEdit={setSelected}
      />
      {s.user.isAdmin && <ProgramTransfers />}
      {selected && (
        <ProgramDialog program={record} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

/** The Add / Edit Flight Program form. Flight Programs and Settings →
 * Flight Program both open it; the backend's program.save command decides who
 * may save (system administrators, or the active program's administrators). */
export function ProgramDialog({
  program: record,
  onClose,
}: {
  program?: Program;
  onClose: () => void;
}) {
  const { s, writable, save } = useFleet();
  return (
    <Modal
      title={record ? "Edit Flight Program details" : "Add Flight Program"}
      onClose={onClose}
    >
      <AsyncForm
        disabled={!writable}
        submitLabel="Save Flight Program"
        onSubmit={async (d) => {
          await save(programSaveCommand(d, record));
          onClose();
        }}
      >
        <ProgramFields record={record} />
      </AsyncForm>
      {/* Another program's history is read from inside that program. */}
      {record && record.uuid === s.activeProgramUuid && (
        <History uuid={record.uuid} />
      )}
    </Modal>
  );
}

function useFleet() {
  const { snapshot, backend, online, connected } = useWorkspace();
  return {
    s: snapshot!,
    writable: online && connected,
    save: async (c: FleetCommand) => {
      if (!online || !connected || !backend)
        throw new Error("Reconnect to save changes.");
      await backend.fleet(c);
      useWorkspace.setState({ notice: "Change saved." });
    },
  };
}

type AircraftFormState = ReturnType<typeof useAircraftForm>;

function useAircraftForm(initial?: Aircraft) {
  const { s, writable, save } = useFleet();
  const [meter, setMeter] = useState<Meter>(initial?.meter ?? "hobbs");
  const [flightTimeLog, setFlightTimeLog] = useState(
    initial?.flightTimeLog ?? false,
  );
  const [flightTimeReading, setFlightTimeReading] = useState(
    hoursField(initial?.currentFlightTimeLog ?? 0),
  );
  const [turbine, setTurbine] = useState(initial?.turbine ?? false);
  const [helicopter, setHelicopter] = useState(initial?.helicopter ?? false);
  const [cyclic, setCyclic] = useState(
    hoursField(initial?.currentCyclicHobbs ?? 0),
  );
  const [hobbs, setHobbs] = useState(hoursField(initial?.currentHobbs ?? 0)),
    [tach, setTach] = useState(hoursField(initial?.currentTach ?? 0)),
    [adjustment, setAdjustment] = useState(
      hoursField(initial?.adjustmentSeconds ?? 0),
    );
  const readings = { flightTimeLog: flightTimeReading, cyclic, hobbs, tach };
  const total = totalOf(readings[meter], adjustment);
  const switchMeter = (next: Meter) => {
    const kept = keptAdjustment(total, readings[next]);
    if (kept !== undefined) setAdjustment(kept);
    setMeter(next);
  };
  return {
    ...{ s, writable, save, meter, switchMeter, readings, total },
    ...{ flightTimeLog, setFlightTimeLog, setFlightTimeReading },
    ...{ turbine, setTurbine, helicopter, setHelicopter, setCyclic },
    ...{ setHobbs, setTach, adjustment, setAdjustment },
  };
}

// A reading or adjustment still being typed shows no total yet.
function totalOf(reading: string, adjustment: string) {
  try {
    return (parseHours(reading) ?? 0) + parseAdjustment(adjustment);
  } catch {
    return undefined;
  }
}

// The adjustment that keeps total time when the meter changes; undefined
// when it cannot be worked out yet, and the form's validation reports why on
// save.
function keptAdjustment(total: number | undefined, reading: string) {
  if (total === undefined) return undefined;
  try {
    return hoursField(total - (parseHours(reading) ?? 0));
  } catch {
    return undefined;
  }
}

function aircraftSaveCommand(
  d: FormData,
  form: AircraftFormState,
  initial?: Aircraft,
): Extract<FleetCommand, { action: "aircraft.save" }> {
  return {
    action: "aircraft.save",
    aircraft: aircraftFromForm(d, form, initial),
    requestUuid: crypto.randomUUID(),
    reason: initial ? "Aircraft details updated." : "Aircraft created.",
  };
}

// The flight time log and collective readings are read only while their
// option is on; otherwise the stored reading is kept.
function aircraftFromForm(
  d: FormData,
  form: AircraftFormState,
  initial?: Aircraft,
): AircraftInput {
  const { flightTimeLog, helicopter, readings } = form;
  return {
    uuid: initial?.uuid ?? crypto.randomUUID(),
    version: initial?.version ?? 0,
    registration: value(d, "registration"),
    make: value(d, "make"),
    model: value(d, "model"),
    faaSearchModel: value(d, "faaSearchModel"),
    serial: value(d, "serial"),
    twin: d.has("twin"),
    turbine: d.has("turbine"),
    amphibious: d.has("amphibious"),
    helicopter,
    flightTimeLog,
    currentFlightTimeLog: flightTimeLog
      ? parseHours(readings.flightTimeLog)!
      : initial?.currentFlightTimeLog,
    currentCyclicHobbs: helicopter
      ? parseHours(readings.cyclic)!
      : initial?.currentCyclicHobbs,
    ...countersFromForm(d, form, initial),
  };
}

function countersFromForm(
  d: FormData,
  form: AircraftFormState,
  initial?: Aircraft,
) {
  return {
    programUuid: initial?.programUuid ?? form.s.activeProgramUuid,
    meter: form.meter,
    adjustmentSeconds: parseAdjustment(form.adjustment),
    currentHobbs: parseHours(form.readings.hobbs)!,
    currentTach: parseHours(form.readings.tach)!,
    cycles: form.turbine ? Number(value(d, "cycles")) : (initial?.cycles ?? 0),
    landings: Number(value(d, "landings")),
    operationalStatus: value(d, "status") as Aircraft["operationalStatus"],
  };
}

function AircraftIdentity({ s, initial }: { s: Snapshot; initial?: Aircraft }) {
  return (
    <div className="form-grid">
      {TEXT_FIELDS.map(([k, label]) => (
        <Field key={k} label={label}>
          {k === "make" || k === "model" ? (
            <DrsComboBox
              kind={k === "make" ? "makes" : "models"}
              name={k}
              defaultValue={initial?.[k]}
              required
            />
          ) : (
            <input
              name={k}
              defaultValue={initial?.[k]}
              maxLength={FLEET_NAME_MAX_LENGTH}
              required={k !== "serial"}
            />
          )}
        </Field>
      ))}
      <Field
        label="FAA search model (optional)"
        hint="Uses this model for AD searches without changing the aircraft model. Leave blank to use the profile model."
      >
        <DrsComboBox
          kind="models"
          name="faaSearchModel"
          defaultValue={initial?.faaSearchModel}
        />
      </Field>
      <ProgramField s={s} initial={initial} />
      <StatusField initial={initial} />
    </div>
  );
}

// Shown for reference only: transfers move an aircraft between programs.
function ProgramField({ s, initial }: { s: Snapshot; initial?: Aircraft }) {
  return (
    <Field label="Flight Program name">
      <select
        name="program"
        value={initial?.programUuid ?? s.activeProgramUuid ?? ""}
        disabled
      >
        <option value="">Unassigned</option>
        {(s.programs ?? [])
          .filter((p) => s.user.isAdmin || p.uuid === s.activeProgramUuid)
          .map((p) => (
            <option key={p.uuid} value={p.uuid}>
              {p.name}
            </option>
          ))}
      </select>
    </Field>
  );
}

function StatusField({ initial }: { initial?: Aircraft }) {
  return (
    <Field label="Status (manual assessment)">
      <select
        name="status"
        defaultValue={initial?.operationalStatus ?? "unknown"}
      >
        <option value="unknown">Unverified</option>
        <option value="airworthy">Airworthy</option>
        <option value="maintenance">Maintenance</option>
        <option value="grounded">Grounded</option>
      </select>
    </Field>
  );
}

// Turning off the helicopter or flight time log option moves a meter that
// depends on it back to the Hobbs.
function AircraftOptions({
  form,
  initial,
}: {
  form: AircraftFormState;
  initial?: Aircraft;
}) {
  const { meter, switchMeter } = form;
  return (
    <fieldset>
      <legend>Aircraft options</legend>
      <div className="form-grid">
        <MeterOption
          name="helicopter"
          label="Helicopter"
          checked={form.helicopter}
          onChange={(on) => {
            if (!on && meter === "cyclic") switchMeter("hobbs");
            form.setHelicopter(on);
          }}
        />
        <MeterOption
          label="Flight time log"
          checked={form.flightTimeLog}
          onChange={(on) => {
            if (!on && meter === "flightTimeLog") switchMeter("hobbs");
            form.setFlightTimeLog(on);
          }}
        />
        <OptionBoxes form={form} initial={initial} />
      </div>
    </fieldset>
  );
}

function MeterOption({
  name,
  label,
  checked,
  onChange,
}: {
  name?: string;
  label: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label>
      <input
        type="checkbox"
        name={name}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />{" "}
      {label}
    </label>
  );
}

function OptionBoxes({
  form,
  initial,
}: {
  form: AircraftFormState;
  initial?: Aircraft;
}) {
  return OPTION_FIELDS.map(([key, label]) => (
    <label key={key}>
      <input
        type="checkbox"
        name={key}
        defaultChecked={initial?.[key] ?? false}
        onChange={
          key === "turbine"
            ? (e) => form.setTurbine(e.target.checked)
            : undefined
        }
      />{" "}
      {label}
    </label>
  ));
}

function MaintenanceTime({ form }: { form: AircraftFormState }) {
  return (
    <>
      <h3>Aircraft maintenance time</h3>
      <p className="muted">
        Maintenance time = selected meter reading + total time adjustment.
        Inspections and components use this default unless they have an explicit
        time source. For the R66, use the collective hourmeter for time in
        service; retain console run time for reference.
      </p>
      <div className="form-grid">
        <MeterReadings form={form} />
        <MeterSourceField form={form} />
        <Field
          label="Total time adjustment (hours)"
          hint="Added to the selected meter. Positive and negative values are allowed."
        >
          <input
            type="number"
            step="0.1"
            value={form.adjustment}
            onChange={(e) => form.setAdjustment(e.target.value)}
            required
          />
        </Field>
      </div>
      <TotalTime form={form} />
      <p className="muted">
        Changing the source adjusts the offset to keep total time unchanged.
        Enter a different adjustment if the verified aircraft records require
        it.
      </p>
    </>
  );
}

function MeterReadings({ form }: { form: AircraftFormState }) {
  const { readings, helicopter } = form;
  return (
    <>
      <HoursField
        label={
          helicopter
            ? "Run-time hourmeter (console Hobbs, hours)"
            : "Current Hobbs (hours)"
        }
        value={readings.hobbs}
        onChange={form.setHobbs}
      />
      <HoursField
        label="Current tach (hours)"
        value={readings.tach}
        onChange={form.setTach}
      />
      {helicopter && (
        <HoursField
          label="Collective hourmeter (hours)"
          value={readings.cyclic}
          onChange={form.setCyclic}
        />
      )}
      {form.flightTimeLog && (
        <HoursField
          label="Current Flight time log (hours)"
          value={readings.flightTimeLog}
          onChange={form.setFlightTimeReading}
        />
      )}
    </>
  );
}

function HoursField({
  label,
  value: reading,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (reading: string) => void;
}) {
  return (
    <Field label={label}>
      <input
        type="number"
        min="0"
        step="0.1"
        value={reading}
        onChange={(e) => onChange(e.target.value)}
        required
      />
    </Field>
  );
}

function MeterSourceField({ form }: { form: AircraftFormState }) {
  const { helicopter } = form;
  return (
    <Field label="Default maintenance time source">
      <select
        value={form.meter}
        onChange={(e) => form.switchMeter(e.target.value as Meter)}
      >
        <option value="hobbs">
          {helicopter ? "Run-time hourmeter (console Hobbs)" : "Hobbs"}
        </option>
        <option value="tach">Tach</option>
        {form.flightTimeLog && (
          <option value="flightTimeLog">Flight time log</option>
        )}
        {helicopter && <option value="cyclic">Collective hourmeter</option>}
      </select>
    </Field>
  );
}

function TotalTime({ form }: { form: AircraftFormState }) {
  const { total, meter } = form;
  return (
    <p className="callout" role="status">
      Aircraft total time:{" "}
      <strong>
        {total === undefined ? "Enter valid readings" : hours(total) + " hours"}
      </strong>
      <br />
      {aircraftMeterLabels[meter]} {form.readings[meter]} + adjustment{" "}
      {form.adjustment}
    </p>
  );
}

function AircraftCounters({
  form,
  initial,
}: {
  form: AircraftFormState;
  initial?: Aircraft;
}) {
  return (
    <div className="form-grid">
      {form.turbine && (
        <Field
          label={
            initial && logsEngineStartsAsCycles(initial.model)
              ? "Engine start cycles"
              : "Current cycles"
          }
        >
          <input
            name="cycles"
            type="number"
            step="1"
            min="0"
            defaultValue={initial?.cycles ?? 0}
            required
          />
        </Field>
      )}
      <Field label="Current landings">
        <input
          name="landings"
          type="number"
          step="1"
          min="0"
          defaultValue={initial?.landings ?? 0}
          required
        />
      </Field>
    </div>
  );
}

type AircraftPageState = ReturnType<typeof useAircraftPage>;

function useAircraftPage() {
  const [componentAircraft, setComponentAircraft] = useState<Aircraft | null>(
    null,
  );
  const { s, writable } = useFleet();
  const [selected, setSelected] = useState<Aircraft | "new" | null>(null),
    [search, setSearch] = useState("");
  const aircraft = searchAircraft(s.aircraft, search);
  return {
    ...{ s, writable, aircraft, search, setSearch },
    ...{ componentAircraft, setComponentAircraft, selected, setSelected },
  };
}

function searchAircraft(aircraft: Aircraft[], search: string) {
  const query = search.toLowerCase();
  return aircraft.filter((a) =>
    `${a.registration} ${a.make} ${a.model} ${a.program}`
      .toLowerCase()
      .includes(query),
  );
}

function AircraftHeader({
  s,
  writable,
  onAdd,
}: {
  s: Snapshot;
  writable: boolean;
  onAdd: () => void;
}) {
  return (
    <PageHeader
      eyebrow="FLEET"
      title="Aircraft"
      description="Registration, airworthiness status and meters for every aircraft you can access."
      actions={
        <>
          <Link className="button" to="/programs">
            <Buildings size={18} aria-hidden="true" /> Flight Programs
          </Link>
          {programPermission(s, "admin") && (
            <>
              <Link className="button" to="/aircraft/setup">
                <ListChecks size={18} aria-hidden="true" /> Set up an aircraft
              </Link>
              <button
                className="button primary"
                disabled={!writable}
                onClick={onAdd}
              >
                <Plus size={18} weight="bold" aria-hidden="true" /> Add aircraft
              </button>
            </>
          )}
        </>
      }
    />
  );
}

function AircraftToolbar({ page }: { page: AircraftPageState }) {
  const shown = page.aircraft.length,
    total = page.s.aircraft.length;
  return (
    <Toolbar
      end={
        <SearchField
          label="Search aircraft"
          value={page.search}
          onChange={page.setSearch}
          placeholder="Registration or model"
        />
      }
    >
      <p className="ops-count">
        <strong>{shown}</strong>{" "}
        {shown === total ? "aircraft" : `of ${total} aircraft`}
      </p>
    </Toolbar>
  );
}

function AircraftList({
  aircraft,
  writable,
  onEdit,
  onAddComponent,
}: {
  aircraft: Aircraft[];
  writable: boolean;
  onEdit: (a: Aircraft) => void;
  onAddComponent: (a: Aircraft) => void;
}) {
  if (!aircraft.length)
    return (
      <EmptyState title="No aircraft found">
        Add an aircraft with verified starting readings.
      </EmptyState>
    );
  return (
    <ListCard>
      <OpsList label="Aircraft">
        {aircraft.map((a) => (
          <AircraftRow
            key={a.uuid}
            aircraft={a}
            writable={writable}
            onEdit={() => onEdit(a)}
            onAddComponent={() => onAddComponent(a)}
          />
        ))}
      </OpsList>
    </ListCard>
  );
}

function InitialComponentDialog({
  aircraft,
  onClose,
}: {
  aircraft: Aircraft;
  onClose: () => void;
}) {
  return (
    <Modal
      title={`Add component · ${aircraft.registration} · Initial setup`}
      onClose={onClose}
    >
      <p>
        Record a component already installed on this aircraft. Later
        installations and removals go through a work order.
      </p>
      <ComponentForm
        initialAircraftUuid={aircraft.uuid}
        aircraftUuids={[aircraft.uuid]}
        onDone={onClose}
      />
    </Modal>
  );
}

function AircraftDialog({
  selected,
  onClose,
}: {
  selected: Aircraft | "new";
  onClose: () => void;
}) {
  const initial = selected === "new" ? undefined : selected;
  return (
    <Modal
      title={initial ? `Edit ${initial.registration}` : "Add aircraft"}
      onClose={onClose}
    >
      <AircraftForm initial={initial} onDone={onClose} />
      {initial && <AircraftCostSummary aircraftUuid={initial.uuid} />}
    </Modal>
  );
}

interface RowProps {
  aircraft: Aircraft;
  writable: boolean;
  onEdit: () => void;
  onAddComponent: () => void;
}

function AircraftRow(props: RowProps) {
  const { aircraft: a, writable } = props;
  const { s } = useFleet();
  const status = shownAircraftStatus(s, a.uuid);
  const maintenance = can(s, a.uuid, "maintenance");
  const tone = STATUS_TONE[status.level];
  return (
    <OpsRow
      icon={RowPicture}
      tone={tone}
      title={a.registration}
      sub={<AircraftSub a={a} />}
      meta={<AircraftTotal a={a} />}
      badge={
        <StatusPill tone={tone} icon={STATUS_ICON[status.level]}>
          {aircraftStatusLabels[status.level]}
        </StatusPill>
      }
      actions={
        maintenance && (
          <button
            className="button small"
            disabled={!writable}
            onClick={props.onEdit}
          >
            Edit aircraft
          </button>
        )
      }
      extra={<AircraftExtras {...props} maintenance={maintenance} />}
    >
      <OpsMeters items={aircraftMeters(a)} />
      <SetupChips s={s} a={a} />
      <AircraftStatusReasons
        status={withoutChipReasons(s, status)}
        label={`${a.registration} status reasons`}
      />
    </OpsRow>
  );
}

// The aircraft picture, in the row's icon place.
function RowPicture() {
  return <AircraftArt width={ROW_ART_WIDTH} className="fleet-art" />;
}

// Each gap in the aircraft's setup opens the wizard at the step that fills
// it; only program administrators can run the wizard.
function SetupChips({ s, a }: { s: Snapshot; a: Aircraft }) {
  if (!programPermission(s, "admin")) return null;
  const { gaps } = setupStatus(s, a.uuid);
  if (!gaps.length) return null;
  return (
    <p className="setup-chips" aria-label={`${a.registration} setup`}>
      {gaps.map((gap) => (
        <Link
          key={gap}
          className="setup-chip"
          to="/aircraft/setup/$aircraftUuid"
          params={{ aircraftUuid: a.uuid }}
          search={{ step: SETUP_GAPS[gap].step }}
        >
          {SETUP_GAPS[gap].label}
        </Link>
      ))}
    </p>
  );
}

// An administrator sees the setup gaps as chips that open the wizard, so the
// reason list leaves them out rather than naming each gap twice.
function withoutChipReasons(
  s: Snapshot,
  status: ShownAircraftStatus,
): ShownAircraftStatus {
  if (!programPermission(s, "admin")) return status;
  return {
    ...status,
    reasons: status.reasons.filter((r) => r.kind !== "setup"),
  };
}

// Only damaged data has a meter without a reading (the form requires one),
// and this page is where it is repaired, so the row says so, not the page.
function AircraftTotal({ a }: { a: Aircraft }) {
  const seconds = recordedTotalSeconds(a);
  return <>{seconds === undefined ? "Not recorded" : `${hours(seconds)} h`}</>;
}

function AircraftSub({ a }: { a: Aircraft }) {
  return (
    <>
      {a.make} {a.model}
      {a.serial && <> · Serial {a.serial}</>} · {a.program || "Unassigned"}
    </>
  );
}

function AircraftExtras({
  aircraft: a,
  maintenance,
  writable,
  onAddComponent,
}: RowProps & { maintenance: boolean }) {
  return (
    <>
      {maintenance && (
        <button
          className="button small"
          disabled={!writable}
          onClick={onAddComponent}
        >
          Add component
        </button>
      )}
      <AircraftManuals aircraftUuid={a.uuid} />
      <AircraftEngineTrends
        aircraftUuid={a.uuid}
        registration={a.registration}
      />
    </>
  );
}

// A meter or counter is listed only when the aircraft has it.
function aircraftMeters(a: Aircraft) {
  const meters: [string, ReactNode][] = [
    [
      "Total time source",
      <>
        {aircraftMeterLabels[a.meter]} · Adjustment {hours(a.adjustmentSeconds)}{" "}
        h
      </>,
    ],
    [
      a.helicopter ? "Run-time hourmeter / tach" : "Hobbs / tach",
      <>
        {hours(a.currentHobbs)} / {hours(a.currentTach)} h
      </>,
    ],
  ];
  if (a.flightTimeLog)
    meters.push(["Flight time log", optionalHours(a.currentFlightTimeLog)]);
  if (a.helicopter && a.currentCyclicHobbs !== undefined)
    meters.push(["Collective hourmeter", `${hours(a.currentCyclicHobbs)} h`]);
  meters.push(countersMeter(a));
  meters.push(["Profile", operationalStatusLabels[a.operationalStatus]]);
  const options = aircraftOptions(a);
  if (options) meters.push(["Options", options]);
  return meters;
}

function optionalHours(seconds: number | undefined) {
  return seconds === undefined ? "Not recorded" : `${hours(seconds)} h`;
}

function countersMeter(a: Aircraft): [string, string] {
  const counts = a.turbine ? `${a.cycles} / ${a.landings}` : String(a.landings);
  return [countersLabel(a), counts];
}

function countersLabel(a: Aircraft) {
  if (logsEngineStartsAsCycles(a.model)) return "Engine starts / landings";
  return a.turbine ? "Cycles / landings" : "Landings";
}

function aircraftOptions(a: Aircraft) {
  return [
    a.helicopter && "Helicopter",
    a.twin && "Twin",
    a.turbine && "Turbine",
    a.flightTimeLog && "Flight time log",
    a.amphibious && "Amphibious",
  ]
    .filter(Boolean)
    .join(" · ");
}

function ProgramsHeader({
  admin,
  writable,
  onAdd,
}: {
  admin: boolean;
  writable: boolean;
  onAdd: () => void;
}) {
  return (
    <PageHeader
      eyebrow="WORKSPACE"
      title="Flight Programs"
      description="Programs group aircraft, people and permissions. Switch the active program with the Flight Program selector: in the sidebar, or under All sections on phones and tablets."
      actions={
        admin && (
          <button
            className="button primary"
            disabled={!writable}
            onClick={onAdd}
          >
            <Plus size={18} weight="bold" aria-hidden="true" /> Add Flight
            Program
          </button>
        )
      }
    />
  );
}

function ProgramList({
  s,
  programs,
  writable,
  onEdit,
}: {
  s: Snapshot;
  programs: Program[];
  writable: boolean;
  onEdit: (p: Program) => void;
}) {
  if (!programs.length)
    return (
      <EmptyState title="No Flight Programs yet">
        Add Flight Program details, then choose a Flight Program in the aircraft
        form.
      </EmptyState>
    );
  return (
    <ListCard>
      <OpsList label="Flight Programs">
        {programs.map((p) => (
          <ProgramRow
            key={p.uuid}
            s={s}
            program={p}
            writable={writable}
            onEdit={() => onEdit(p)}
          />
        ))}
      </OpsList>
    </ListCard>
  );
}

function ProgramRow({
  s,
  program: p,
  writable,
  onEdit,
}: {
  s: Snapshot;
  program: Program;
  writable: boolean;
  onEdit: () => void;
}) {
  const active = p.uuid === s.activeProgramUuid;
  return (
    <OpsRow
      icon={Buildings}
      tone={active ? "good" : "blue"}
      title={p.name}
      sub={p.address || "No address recorded"}
      badge={
        active ? (
          <StatusPill tone="good" icon={CheckCircle}>
            Active
          </StatusPill>
        ) : undefined
      }
      actions={
        canEditProgram(s, active) && (
          <button
            className="button small"
            disabled={!writable}
            onClick={onEdit}
          >
            Edit Flight Program details
          </button>
        )
      }
    >
      <OpsMeters items={programMeters(p)} />
    </OpsRow>
  );
}

function programMeters(p: Program): [string, ReactNode][] {
  return [
    ["Email", p.email || "—"],
    ["Contact name", p.contactName || "—"],
    ["Website", websiteLink(p.website)],
  ];
}

// A system administrator edits any program; a program administrator only the
// active one.
function canEditProgram(s: Snapshot, active: boolean) {
  return s.user.isAdmin || (active && programPermission(s, "admin"));
}

function websiteLink(url: string | undefined): ReactNode {
  if (!url) return "—";
  return (
    <a href={safeHref(url)} target="_blank" rel="noreferrer">
      {url}
    </a>
  );
}

// The form edits the structured address; the legacy address, email and
// contact name are kept as stored.
function programSaveCommand(d: FormData, record?: Program): FleetCommand {
  return {
    action: "program.save",
    requestUuid: crypto.randomUUID(),
    reason: record ? "Program details updated." : "Program created.",
    program: {
      uuid: record?.uuid ?? crypto.randomUUID(),
      version: record?.version ?? 0,
      name: value(d, "name"),
      addressDetails: addressFromForm(d),
      address: record?.address ?? "",
      email: record?.email ?? "",
      contactName: record?.contactName ?? "",
      website: value(d, "website"),
    },
  };
}

function ProgramFields({ record }: { record?: Program }) {
  return (
    <>
      <Field label="Flight Program name">
        <input
          name="name"
          defaultValue={record?.name}
          maxLength={FLEET_NAME_MAX_LENGTH}
          required
        />
      </Field>
      <AddressFields
        label="Program address"
        name="addressDetails"
        value={record?.addressDetails}
        legacy={record?.address}
        contactName={record?.contactName}
        email={record?.email}
      />
      <Field label="Website">
        <input
          name="website"
          type="text"
          inputMode="url"
          placeholder="example.com"
          defaultValue={record?.website}
          onBlur={(e) => {
            e.currentTarget.value = normalizeWebsite(e.currentTarget.value);
          }}
        />
      </Field>
    </>
  );
}

function ProgramTransfers() {
  const { snapshot: s, backend, online, connected } = useWorkspace();
  const [kind, setKind] = useState<TransferKind>("aircraft");
  const [revision, setRevision] = useState(0);
  return (
    <section className="ops-card" aria-labelledby="ops-transfer-title">
      <TransferIntro />
      <AsyncForm
        key={revision}
        disabled={!online || !connected}
        submitLabel="Transfer record"
        onSubmit={async (d) => {
          await backend!.transferProgram({
            kind,
            uuid: value(d, "record"),
            destination: value(d, "destination"),
            reason: value(d, "reason"),
          });
          setRevision((r) => r + 1);
          useWorkspace.setState({
            notice: "Record transferred to its destination Flight Program.",
          });
        }}
      >
        <TransferFields s={s!} kind={kind} onKind={setKind} />
      </AsyncForm>
    </section>
  );
}

function TransferIntro() {
  return (
    <header className="ops-card-head">
      <IconTile icon={ArrowsLeftRight} tone="blue" size="md" />
      <div>
        <h2 id="ops-transfer-title">
          Transfer records between Flight Programs
        </h2>
        <p>
          System administrators can assign unassigned records or transfer them
          from the active program. Aircraft transfers include their flights,
          inspections, discrepancies, and associated components. Location
          transfers include stock. Standalone component transfers require
          removal from the aircraft first.
        </p>
      </div>
    </header>
  );
}

function TransferFields({
  s,
  kind,
  onKind,
}: {
  s: Snapshot;
  kind: TransferKind;
  onKind: (kind: TransferKind) => void;
}) {
  return (
    <>
      <Field label="Record type">
        <select
          value={kind}
          onChange={(e) => onKind(e.target.value as TransferKind)}
        >
          <option value="aircraft">Aircraft</option>
          <option value="component">Stored component</option>
          <option value="location">Storage location</option>
        </select>
      </Field>
      <RecordField s={s} kind={kind} />
      <DestinationField s={s} />
      <Field label="Transfer reason">
        <textarea
          name="reason"
          required
          maxLength={TRANSFER_REASON_MAX_LENGTH}
        />
      </Field>
    </>
  );
}

// The record list is keyed by kind, so switching kind clears the choice.
function RecordField({ s, kind }: { s: Snapshot; kind: TransferKind }) {
  return (
    <Field label="Record to transfer">
      <select key={kind} name="record" required>
        <option value="">Select record</option>
        {transferRecords(s, kind).map((r) => (
          <option key={r.uuid} value={r.uuid}>
            {r.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

function transferRecords(s: Snapshot, kind: TransferKind) {
  if (kind === "aircraft")
    return s.aircraft.map((a) => ({ uuid: a.uuid, label: a.registration }));
  return (s.management ?? []).flatMap((r) => {
    if (r.kind !== kind) return [];
    const label =
      r.kind === "component" ? `${r.componentType} · ${r.serial}` : r.name;
    return [{ uuid: r.uuid, label }];
  });
}

function DestinationField({ s }: { s: Snapshot }) {
  return (
    <Field label="Destination Flight Program">
      <select name="destination" required>
        <option value="">Select destination</option>
        {s.programs
          ?.filter((p) => p.uuid !== s.activeProgramUuid)
          .map((p) => (
            <option key={p.uuid} value={p.uuid}>
              {p.name}
            </option>
          ))}
      </select>
    </Field>
  );
}
