/**
 * Responsibility: The Components screen: tracked components, their service
 *   and requirement forms, inventory, attachments and movements.
 * Layer: UI. Renders and collects input; rules live in src/domain.
 * Dependencies: src/domain (components, dueItems, componentCalendar,
 *   requiredParts, programs, model, ata), src/data (store, errors), ./ui,
 *   ./design, ./ManagementShared and the parts, inventory, manual, job-card
 *   and work-order components.
 *
 * Record lists keep real <table> markup restyled as CSS-grid cards, so the
 * explicit table, row and cell roles are deliberate (see .oxlintrc.json).
 */
import { RequestPartsButton } from "./PartsRequests";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { ScanButton } from "./InventoryScanner";
import { DrsComboBox } from "./DrsComboBox";
import { PlanComponentMovement } from "./PlanComponentMovement";
import { tagFieldLabels } from "../domain/inventoryPrinting";
import { InventoryPrintButtons } from "./InventoryPrinting";
import {
  InventoryAttachments,
  InventoryFilePicker,
} from "./InventoryAttachments";
import { validateInventoryFile } from "../domain/inventoryAttachments";
import { useWorkspace } from "../data/store";
import type { Backend } from "../data/backend";
import { errorText } from "../data/errors";
import { componentStorage } from "../domain/componentInventory";
import { partsInventory, type PartsInventory } from "../domain/requiredParts";
import {
  serviceMonthsFromDays,
  serviceDaysFromMonths,
  daysPerServiceMonth,
} from "../domain/componentCalendar";
import {
  RequiredPartsFields,
  PartsAvailability,
  requiredPartsFromForm,
} from "./RequiredParts";
import {
  ManualLink,
  ManualReferenceFields,
  manualReferenceFromForm,
} from "./Manuals";
import { LinkedTaskCards } from "./TaskCards";
import { AddToWorkOrder } from "./WorkOrders";
import { programPermission } from "../domain/programs";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  can,
  hours,
  totalSeconds,
  parseHours,
  type Aircraft,
  type Snapshot,
} from "../domain/model";
import { ataChapterSchema, ataLabel } from "../domain/ata";
import {
  componentTotals,
  saveRequirement,
  tracking,
  requirementDueDate,
  POSITIONS,
  COMPONENT_NOTES_MAX_LENGTH,
  COMPONENT_PART_ID_MAX_LENGTH,
  PARTS_LOCATION_MAX_LENGTH,
  INCOMING_TAG_FIELD_MAX_LENGTH,
  REQUIREMENT_DESCRIPTION_MAX_LENGTH,
  REQUIREMENT_WARNING_DEFAULTS,
  type Component,
  type ComponentRequirement,
  type ComponentMovement,
} from "../domain/components";
import type { ManagementCommand } from "../domain/management";
import {
  dueItems,
  type DueLevel,
  type RequirementDue,
} from "../domain/dueItems";
import { AtaChapterField } from "./AtaChapterField";
import { AsyncForm, Field, Modal, value } from "./ui";
import {
  useStaleSave,
  type StaleSaveAttempt,
  type StaleSaveOptions,
} from "./StaleSave";
import {
  EmptyState,
  IconTile,
  NoticeBar,
  PageHeader,
  SearchField,
  Segmented,
  StatusPill,
  Toolbar,
  type IconType,
  type Tone,
} from "./design";
import {
  AirplaneTilt,
  CaretDown,
  Copy,
  Cube,
  Engine,
  Fan,
  GearSix,
  PencilSimple,
  Plus,
  Warehouse,
  Warning,
  WifiSlash,
  Wrench,
} from "@phosphor-icons/react";
import { FactLabel } from "./MaintenanceUi";
import "../styles/screens/maintenance.css";
import {
  today,
  NumberField,
  num,
  secs,
  History,
  useManagement,
  Reason,
} from "./ManagementShared";

const SECONDS_PER_HOUR = 3600;
const COMPONENT_TYPES = [
  "Appliance",
  "Engine",
  "Propeller",
  "Main Rotor",
  "Tail Rotor",
];
const PREVIEW_PROMPT =
  "Enter the limits and verified compliance history to preview due values.";

type Tracking = ReturnType<typeof tracking>;
type Dimension = keyof Tracking | "landings";
type Track<K extends string> = Record<K, boolean>;
type Mode =
  "details" | "edit" | "baseline" | "service" | "requirement" | "child";
type ServiceOperation = "install" | "remove" | "overhaul" | "repair";
type Remaining = NonNullable<RequirementDue["due"]>;
type Totals = ReturnType<typeof componentTotals>;
type RequirementInput = Partial<ComponentRequirement>;
type BaselineCommand = Extract<
  ManagementCommand,
  { action: "component.baseline" }
>;

interface TrackChoice<K extends string> {
  key: K;
  label: string;
}

const COMPONENT_TRACKING: TrackChoice<keyof Tracking>[] = [
  { key: "calendar", label: "Calendar" },
  { key: "time", label: "Time" },
  { key: "cycles", label: "Cycles" },
];
const REQUIREMENT_TRACKING: TrackChoice<Dimension>[] = [
  { key: "time", label: "Hours" },
  { key: "calendar", label: "Calendar" },
  { key: "cycles", label: "Cycles" },
  { key: "landings", label: "Landings" },
];
const DETAIL_MODES: [Mode, string][] = [
  ["edit", "Edit component"],
  ["baseline", "Set baseline"],
  ["service", "Move / service"],
];
const LEVEL_TONES: Record<DueLevel, Tone> = {
  overdue: "danger",
  "due-soon": "warn",
  ok: "good",
  unknown: "warn",
};
const DIALOG_TITLES: Record<Exclude<Mode, "details">, string> = {
  child: "Add trackable parts",
  edit: "Edit component",
  baseline: "Set installation baseline",
  service: "Component service",
  requirement: "Component service requirement",
};

/** What {@link ComponentForm} creates or edits, and what it reports. */
interface ComponentFormProps {
  /** Records a component already installed here, during aircraft setup. */
  initialAircraftUuid?: string;
  /** The assembly a new trackable part belongs to; it takes its position. */
  parentComponent?: Component;
  /** Requires the part and serial numbers. */
  inventoryOnly?: boolean;
  /** The component to edit; absent for a new one. */
  record?: Component;
  /** Reopens the form on the record as it stands, after a stale save the
   * user resolved with Use theirs; without it the form closes. */
  onReload?: (current: Component) => void;
  /** Values a new component starts with; its readings start blank. */
  defaults?: Partial<Component>;
  /** Limits the aircraft offered to these. */
  aircraftUuids?: string[];
  /** Shown above the fields. */
  review?: ReactNode;
  /** Receives the saved component, its version advanced, once all files
   * have uploaded. */
  onDone: (uuid: string, component: Component) => void | Promise<void>;
}

/** What {@link RequirementForm} creates or edits, and what it reports. */
interface RequirementFormProps {
  /** The component the requirement limits. */
  c: Component;
  /** The requirement to edit; absent for a new one. */
  record?: ComponentRequirement;
  /** Values a new requirement starts with; given these, the form previews
   * when it falls due. */
  defaults?: RequirementInput;
  /** Shown above the fields. */
  review?: ReactNode;
  /** Called once the requirement is saved. */
  onDone: () => void;
}

/**
 * Creates a component, in inventory or (during aircraft setup) installed, or
 * edits one's details. Readings change only through a baseline or a
 * movement, so an edit keeps them as stored.
 *
 * Attachments upload after the save, so the form refuses them offline
 * ("Reconnect before saving a component with attachments."); if one fails,
 * the saved component offers it and the rest for retry.
 */
export function ComponentForm(props: ComponentFormProps) {
  const form = useComponentForm(props);
  if (form.saved)
    return (
      <UploadRetry
        component={form.saved}
        files={form.files}
        error={form.uploadError}
        onDone={props.onDone}
      />
    );
  return (
    <>
      <AsyncForm
        key={form.stale.formKey}
        disabled={!form.writable}
        submitLabel={props.record ? "Save component details" : "Save component"}
        onSubmit={form.submit}
      >
        {props.review}
        <ComponentFields form={form} props={props} />
      </AsyncForm>
      {form.stale.dialog}
    </>
  );
}

// How the stale-save review names and formats a component's fields.
const COMPONENT_STALE_SAVE: StaleSaveOptions<Component> = {
  label: "component",
  entityUuid: (c) => c.uuid,
  specs: {
    componentType: "Component type",
    manufacturer: "Manufacturer",
    model: "Model",
    partNumber: "Part number",
    serial: "Serial number",
    installPosition: "Install position",
    installed: "Installed",
    aircraftUuid: "Aircraft",
    locationUuid: "Inventory location",
    manualReference: "Manual reference",
  },
};

/**
 * Plans a component's installation or removal onto a work order, or records
 * a workshop overhaul or repair of a stored one with today's date.
 *
 * @param props.c - The component.
 * @param props.onDone - Called once the plan or service event is saved.
 */
export function ServiceForm({
  c,
  onDone,
}: {
  c: Component;
  onDone: () => void;
}) {
  const { writable, execute } = useManagement();
  const [operation, setOperation] = useState<ServiceOperation>(
    c.installed ? "remove" : "install",
  );
  if (operation === "install" || operation === "remove")
    return (
      <PlannedMovement c={c} operation={operation} onChange={setOperation}>
        <PlanComponentMovement c={c} onDone={onDone} />
      </PlannedMovement>
    );
  return (
    <AsyncForm
      disabled={!writable}
      submitLabel="Save service event"
      onSubmit={async (d) => {
        await execute(serviceCommand(c, operation, value(d, "reason")));
        onDone();
      }}
    >
      <p>
        Record workshop service for this stored component. Installation and
        removal must be recorded through a work order.
      </p>
      <ServiceActionField c={c} operation={operation} onChange={setOperation} />
      <Field label="Movement / service date">
        <input type="date" value={today()} readOnly />
      </Field>
      <Reason />
    </AsyncForm>
  );
}

/**
 * Adds or edits a component's service requirement: its limits on each
 * dimension the component tracks, the due-soon warnings, the last
 * compliance and the parts it needs. Landings need the component installed.
 */
export function RequirementForm({
  c,
  record: existing,
  defaults,
  review,
  onDone,
}: RequirementFormProps) {
  const record = existing ?? defaults;
  const { s, writable, execute } = useManagement(),
    available = { ...tracking(c), landings: c.installed };
  const [track, setTrack] = useState(() => initialTrack(available, record));
  const [preview, setPreview] = useState(PREVIEW_PROMPT);
  const build = (d: FormData) => requirementFromForm(d, c, record, track);
  return (
    <AsyncForm
      disabled={!writable}
      submitLabel="Calculate and save"
      onChange={(d) => setPreview(previewDue(s, () => build(d)))}
      onSubmit={async (d) => {
        await execute(requirementSaveCommand(build(d), !!existing));
        onDone();
      }}
    >
      {review}
      <RequirementBasics record={record} />
      <RequirementLimits
        available={available}
        track={track}
        onTrack={setTrack}
        record={record}
      />
      <NotesField label="Service notes" initial={record?.notes} />
      {defaults && <p role="status">{preview}</p>}
      {existing && <History uuid={existing.uuid} />}
    </AsyncForm>
  );
}

/**
 * The Components screen: components grouped under their aircraft or
 * Inventory, searchable and filterable by location, with a dialog for
 * details, edits, baselines, service and requirements. A `?item=` link opens
 * that component's details.
 *
 * @throws {Error} What componentTotals throws for a listed component, or
 *   what the due list caught for one of its requirements, such as "Aircraft
 *   readings or date precede the installation baseline."; the page fails.
 */
export function Components() {
  const screen = useComponentsScreen();
  const { s, writable, items } = screen;
  const filtered = filterComponents(s, items, screen.search, screen.location);
  return (
    <>
      <ComponentsHeader
        canAdd={writable && canAddComponents(s)}
        onNew={() => screen.open("new", "edit")}
      />
      {screen.linkMissing && (
        <NoticeBar tone="warn" icon={Warning} role="status">
          This component is not available in the active Flight Program. Select
          its Flight Program or check your access.
        </NoticeBar>
      )}
      <ComponentFilters screen={screen} />
      {!writable && (
        <NoticeBar tone="neutral" icon={WifiSlash}>
          Cached components are available. Reconnect to make changes.
        </NoticeBar>
      )}
      {groupComponents(s, filtered).map(([key, group]) => (
        <ComponentGroup key={key} id={key} group={group} screen={screen} />
      ))}
      {!filtered.length && <NoComponents hasComponents={items.length > 0} />}
      {screen.selected && (
        <ComponentDialog screen={screen} selected={screen.selected} />
      )}
    </>
  );
}

const displayHours = (n: number | null | undefined) =>
  n == null ? "Unknown" : hours(n) + " h";

function toHours(seconds: number | null | undefined) {
  return seconds == null ? undefined : seconds / SECONDS_PER_HOUR;
}

function formatMonths(days: number) {
  return (days / daysPerServiceMonth).toFixed(1);
}

// The program's component requirements, in record order. A requirement of a
// component installed on an aircraft the snapshot lacks is left out; its row
// fails on the component's own totals first.
function requirementDues(s: Snapshot) {
  return dueItems(s).filter(
    (d): d is RequirementDue => d.kind === "componentRequirement",
  );
}

// T13 leaves what an uncomputable status means to each caller: here it fails
// the page, at the component's first such requirement in record order.
function measured(d: RequirementDue): Remaining {
  if (!d.due) throw d.error;
  return d.due;
}

function duesOf(due: RequirementDue[], c: Component) {
  return due.filter((d) => d.component.uuid === c.uuid);
}

function componentIcon(type: string): IconType {
  if (type === "Engine") return Engine;
  if (/propeller|rotor/i.test(type)) return Fan;
  return type === "Appliance" ? GearSix : Cube;
}

function registrationOf(s: Snapshot, aircraftUuid: string | undefined) {
  return s.aircraft.find((a) => a.uuid === aircraftUuid)?.registration;
}

// A component on an aircraft needs maintenance there; one held for the
// Flight Program needs it program-wide.
function canMaintain(s: Snapshot, c: Component) {
  return c.aircraftUuid
    ? can(s, c.aircraftUuid, "maintenance")
    : programPermission(s, "maintenance");
}

function canAddComponents(s: Snapshot) {
  return (
    programPermission(s, "maintenance") ||
    s.aircraft.some((a) => can(s, a.uuid, "maintenance"))
  );
}

function requirementSource(uuid: string) {
  return { kind: "componentRequirement" as const, uuid, workOrderUuid: "" };
}

function TrackChoices<K extends string>({
  choices,
  track,
  available,
  onChange,
}: {
  choices: TrackChoice<K>[];
  track: Track<K>;
  available?: Track<K>;
  onChange: (track: Track<K>) => void;
}) {
  return (
    <>
      <h3>Track by</h3>
      <div className="management-actions">
        {choices.map(({ key, label }) => (
          <label className="checkbox" key={key}>
            <input
              type="checkbox"
              checked={track[key]}
              disabled={available && !available[key]}
              onChange={(e) => onChange({ ...track, [key]: e.target.checked })}
            />
            {label}
          </label>
        ))}
      </div>
    </>
  );
}

function Position({ initial }: { initial?: Component["installPosition"] }) {
  return (
    <Field label="Installed position">
      <select name="installPosition" defaultValue={initial ?? "MAIN"}>
        {POSITIONS.map((p) => (
          <option key={p}>{p}</option>
        ))}
      </select>
    </Field>
  );
}

interface BaselineProps {
  c?: Component;
  time: boolean;
  cycles: boolean;
  calendar: boolean;
  installed: boolean;
  aircraftSeconds?: number;
  aircraftCycles?: number;
  verifiedEntry?: boolean;
}

// A verified entry (a new component from `defaults`) starts its readings
// blank, so they are entered rather than assumed to be zero.
function BaselineFields(props: BaselineProps) {
  const { c, time, cycles, calendar, installed } = props;
  const start = props.verifiedEntry ? undefined : 0;
  return (
    <>
      <p className="muted">
        Enter verified readings at installation, or stored readings for an
        inventory component. Blank TSO and TSR mean unknown / not applicable.
      </p>
      <div className="form-grid">
        {installed && <InstallReadingFields {...props} />}
        {time && <TimeBaselineFields c={c} start={start} />}
        {cycles && (
          <NumberField
            name="cyclesSinceNew"
            label="Component cycles at install"
            initial={c?.cyclesSinceNew ?? start}
            required
          />
        )}
        {calendar && <CalendarBaselineFields c={c} />}
      </div>
    </>
  );
}

function InstallReadingFields(props: BaselineProps) {
  const { c, verifiedEntry } = props;
  return (
    <>
      <Field label="Installation date">
        <input
          type="date"
          name="installedDate"
          defaultValue={c?.installedDate ?? (verifiedEntry ? "" : today())}
          max={today()}
          required
        />
      </Field>
      {props.time && (
        <NumberField
          name="installedSeconds"
          label="Aircraft total time at install (hours)"
          decimal
          initial={toHours(c ? c.installedSeconds : props.aircraftSeconds)}
          required
        />
      )}
      {props.cycles && (
        <NumberField
          name="installedCycles"
          label="Aircraft cycles at install"
          initial={c?.installedCycles ?? props.aircraftCycles}
          required
        />
      )}
    </>
  );
}

function TimeBaselineFields({ c, start }: { c?: Component; start?: number }) {
  return (
    <>
      <NumberField
        name="timeSinceNew"
        label="Time Since New (TSN) at install (hours)"
        decimal
        initial={c ? toHours(c.timeSinceNew) : start}
        required
      />
      <NumberField
        name="timeSinceOverhaul"
        label="Time Since Overhaul (TSO) at install (hours)"
        decimal
        initial={toHours(c?.timeSinceOverhaul)}
      />
      <NumberField
        name="timeSinceRepair"
        label="Time Since Repair (TSR) at install (hours)"
        decimal
        initial={toHours(c?.timeSinceRepair)}
      />
    </>
  );
}

function CalendarBaselineFields({ c }: { c?: Component }) {
  return (
    <>
      <Field
        label="Calendar time since new (months)"
        hint="Service age uses average months (365.25 ÷ 12); calendar due dates use the actual calendar."
      >
        <input
          name="serviceMonthsBase"
          type="number"
          min="0"
          step="any"
          defaultValue={
            c && !c.calendarSinceNewUnknown
              ? serviceMonthsFromDays(c.serviceDaysBase)
              : undefined
          }
        />
      </Field>
      <Field
        label="Calendar time since overhaul (months)"
        hint="Optional; leave blank if unknown or not applicable."
      >
        <input
          name="calendarOverhaulMonths"
          type="number"
          min="0"
          step="any"
          defaultValue={
            c?.calendarOverhaulDaysBase == null
              ? undefined
              : serviceMonthsFromDays(c.calendarOverhaulDaysBase)
          }
        />
      </Field>
    </>
  );
}

function ComponentStorageFields({ initial }: { initial?: Component }) {
  const { s } = useManagement();
  const locations = partsInventory(s).locations;
  return (
    <>
      <InventoryLocationField
        initial={initial?.locationUuid}
        locations={locations}
      />
      <Field
        label="Parts location"
        hint="Optional shelf, bin or room within the inventory location."
      >
        <input
          name="partsLocation"
          defaultValue={initial?.partsLocation}
          maxLength={PARTS_LOCATION_MAX_LENGTH}
          placeholder="Shelf / bin / room"
          required={!locations.length}
        />
      </Field>
    </>
  );
}

// A stored location this user can no longer see stays selected, labelled.
function InventoryLocationField({
  initial,
  locations,
}: {
  initial?: string;
  locations: PartsInventory["locations"];
}) {
  const unavailable = initial && !locations.some((l) => l.uuid === initial);
  return (
    <Field label="Inventory location">
      <select
        name="locationUuid"
        defaultValue={initial ?? ""}
        required={locations.length > 0}
      >
        <option value="">
          {locations.length
            ? "Select inventory location"
            : "No locations configured"}
        </option>
        {unavailable && (
          <option value={initial}>Previous location unavailable</option>
        )}
        {locations.map((l) => (
          <option key={l.uuid} value={l.uuid}>
            {l.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

type ComponentFormState = ReturnType<typeof useComponentForm>;

function useComponentForm(props: ComponentFormProps) {
  const { s, writable, execute } = useManagement();
  const { backend, online, connected } = useWorkspace();
  const [files, setFiles] = useState<File[]>([]);
  const [saved, setSaved] = useState<Component>();
  const [uploadError, setUploadError] = useState("");
  const choices = useComponentChoices(s, props);
  const stale = useStaleSave(COMPONENT_STALE_SAVE);
  const save = async (r: Component) => {
    await execute(componentSaveCommand(r, props));
    const next = { ...r, version: r.version + 1 };
    const failed = await uploadAttachments(backend!, r.uuid, files);
    if (failed) {
      setFiles(failed.remaining);
      setUploadError(failed.error);
      setSaved(next);
      return;
    }
    await props.onDone(r.uuid, next);
  };
  const submit = (d: FormData) => {
    assertAttachable(files, !!backend && online && connected);
    const installed =
      props.record?.installed ?? choices.location === "aircraft";
    const r = componentFromForm(d, { ...props, ...choices, installed, s });
    return stale.run(componentAttempt(r, props, save));
  };
  return {
    s,
    writable,
    files,
    setFiles,
    saved,
    uploadError,
    submit,
    stale,
    ...choices,
  };
}

function useComponentChoices(s: Snapshot, props: ComponentFormProps) {
  const { record, initialAircraftUuid, aircraftUuids } = props;
  const editable = s.aircraft.filter(
    (a) =>
      can(s, a.uuid, "maintenance") &&
      (!aircraftUuids || aircraftUuids.includes(a.uuid)),
  );
  const location =
    record?.installed || initialAircraftUuid ? "aircraft" : "inventory";
  const [aircraftId, setAircraftId] = useState(
    record?.aircraftUuid ?? initialAircraftUuid ?? editable[0]?.uuid ?? "",
  );
  const [track, setTrack] = useState(
    record ? tracking(record) : { time: true, cycles: true, calendar: true },
  );
  const aircraft = s.aircraft.find((a) => a.uuid === aircraftId);
  return {
    editable,
    location,
    aircraftId,
    setAircraftId,
    aircraft,
    track,
    setTrack,
  };
}

// The save as the stale-save review retries or abandons it.
function componentAttempt(
  r: Component,
  props: ComponentFormProps,
  save: (r: Component) => Promise<void>,
): StaleSaveAttempt<Component> {
  return {
    draft: r,
    loaded: props.record,
    find: (live) => findComponent(live, props.record?.uuid),
    save: (version) => save({ ...r, version }),
    useTheirs: (current) =>
      current && props.onReload
        ? props.onReload(current)
        : props.onDone(r.uuid, current ?? r),
  };
}

function findComponent(s: Snapshot, uuid: string | undefined) {
  const found = s.management?.find(
    (r) => r.kind === "component" && r.uuid === uuid,
  );
  return found?.kind === "component" ? found : undefined;
}

// Attachments upload after the save, so a save that could not upload them
// is refused before anything is written.
function assertAttachable(files: File[], connected: boolean) {
  for (const file of files)
    validateInventoryFile(file.name, file.type, file.size);
  if (files.length && !connected)
    throw new Error("Reconnect before saving a component with attachments.");
}

// Uploads in order and stops at the first failure: the component is already
// saved, so that file and the rest are offered for retry instead.
async function uploadAttachments(
  backend: Backend,
  uuid: string,
  files: File[],
) {
  for (const [index, file] of files.entries()) {
    try {
      await backend.attachInventoryFile(uuid, file);
    } catch (error) {
      const message = errorText(error, "Upload failed.");
      return { remaining: files.slice(index), error: message };
    }
  }
  return undefined;
}

function componentSaveCommand(
  r: Component,
  { record, initialAircraftUuid }: ComponentFormProps,
): ManagementCommand {
  return {
    action: "record.save",
    record: r,
    requestUuid: crypto.randomUUID(),
    initialAircraftSetup: !record && !!initialAircraftUuid,
    reason: componentSaveReason(record, initialAircraftUuid),
  };
}

function componentSaveReason(record?: Component, initialAircraftUuid?: string) {
  if (record) return "Component details updated.";
  return initialAircraftUuid
    ? "Initial aircraft setup: existing installed component recorded."
    : "Component created.";
}

interface ComponentDraft {
  record?: Component;
  defaults?: Partial<Component>;
  parentComponent?: Component;
  installed: boolean;
  aircraftId: string;
  track: Tracking;
  s: Snapshot;
}

// The form's fields over the stored record. Editing keeps the stored
// readings: they change only through a baseline or a movement.
function componentFromForm(d: FormData, draft: ComponentDraft): Component {
  return {
    ...draft.record,
    ...identityFromForm(d, draft),
    ...placementFromForm(d, draft),
    ...readingsFromForm(d, draft),
  };
}

function identityFromForm(d: FormData, draft: ComponentDraft) {
  const { record, defaults } = draft;
  return {
    model: value(d, "model"),
    faaSearchModel: value(d, "faaSearchModel"),
    manualReference: record?.manualReference ?? defaults?.manualReference,
    uuid: record?.uuid ?? defaults?.uuid ?? crypto.randomUUID(),
    parentComponentUuid:
      record?.parentComponentUuid ?? draft.parentComponent?.uuid,
    version: record?.version ?? 0,
    kind: "component" as const,
    aircraftUuid: record?.aircraftUuid ?? ownerAircraft(draft),
    componentType: value(d, "componentType"),
    ataChapter: ataChapterSchema
      .optional()
      .parse(value(d, "ataChapter") || undefined),
    partNumber: value(d, "partNumber"),
    serial: value(d, "serial"),
    expirationDate: value(d, "expirationDate") || undefined,
    manufacturer: value(d, "manufacturer"),
    incomingTag: incomingTagFromForm(d),
    notes: value(d, "notes"),
  };
}

// Inventory belongs to the Flight Program for a program-wide maintainer;
// anyone else keeps it in an aircraft's access group.
function ownerAircraft({ installed, aircraftId, s }: ComponentDraft) {
  return !installed && programPermission(s, "maintenance") ? "" : aircraftId;
}

function incomingTagFromForm(d: FormData) {
  return Object.fromEntries(
    Object.keys(tagFieldLabels).map((k) => [k, value(d, `incomingTag_${k}`)]),
  );
}

function placementFromForm(d: FormData, draft: ComponentDraft) {
  const { installed, track } = draft;
  return {
    trackTime: track.time,
    trackCycles: track.cycles,
    trackCalendar: track.calendar,
    installed,
    installPosition: installed
      ? (draft.parentComponent?.installPosition ??
        (value(d, "installPosition") as Component["installPosition"]))
      : undefined,
    partsLocation: installed ? undefined : value(d, "partsLocation"),
    locationUuid: installed ? undefined : value(d, "locationUuid") || undefined,
  };
}

function readingsFromForm(d: FormData, draft: ComponentDraft) {
  const { record, installed, track } = draft;
  const days = (name: string) =>
    track.calendar ? daysFromMonths(d, name) : undefined;
  return {
    installedDate:
      record?.installedDate ??
      (installed ? value(d, "installedDate") : undefined),
    installedSeconds:
      record?.installedSeconds ??
      (installed && track.time ? secs(d, "installedSeconds")! : 0),
    installedCycles:
      record?.installedCycles ??
      (installed && track.cycles ? num(d, "installedCycles")! : 0),
    timeSinceNew: record?.timeSinceNew ?? secs(d, "timeSinceNew") ?? 0,
    timeSinceOverhaul: record
      ? record.timeSinceOverhaul
      : (secs(d, "timeSinceOverhaul") ?? null),
    timeSinceRepair: record
      ? record.timeSinceRepair
      : (secs(d, "timeSinceRepair") ?? null),
    cyclesSinceNew: record?.cyclesSinceNew ?? num(d, "cyclesSinceNew") ?? 0,
    serviceDaysBase: record
      ? record.serviceDaysBase
      : (days("serviceMonthsBase") ?? 0),
    calendarSinceNewUnknown: record
      ? record.calendarSinceNewUnknown
      : !value(d, "serviceMonthsBase"),
    calendarOverhaulDaysBase: record
      ? record.calendarOverhaulDaysBase
      : (days("calendarOverhaulMonths") ?? null),
    calendarOverhaulDate: record?.calendarOverhaulDate,
  };
}

function daysFromMonths(d: FormData, name: string) {
  const months = value(d, name);
  return months ? serviceDaysFromMonths(months) : undefined;
}

function ComponentFields({
  form,
  props,
}: {
  form: ComponentFormState;
  props: ComponentFormProps;
}) {
  const { record, defaults } = props;
  return (
    <>
      <ComponentIdentityFields
        record={record}
        defaults={defaults}
        inventoryOnly={props.inventoryOnly}
      />
      <TrackChoices
        choices={COMPONENT_TRACKING}
        track={form.track}
        onChange={form.setTrack}
      />
      {!record && <NewComponentNotice setup={!!props.initialAircraftUuid} />}
      <PlacementFields form={form} props={props} />
      {record ? (
        <MovementHint />
      ) : (
        <OpeningBaseline form={form} verified={!!defaults} />
      )}
      {!record && programPermission(form.s, "admin") && (
        <AttachmentSection files={form.files} onChange={form.setFiles} />
      )}
      <IncomingTagFields record={record} />
      <NotesField label="Notes" initial={record?.notes ?? defaults?.notes} />
    </>
  );
}

function NotesField({ label, initial }: { label: string; initial?: string }) {
  return (
    <Field label={label}>
      <textarea
        name="notes"
        defaultValue={initial}
        maxLength={COMPONENT_NOTES_MAX_LENGTH}
      />
    </Field>
  );
}

function UploadRetry({
  component,
  files,
  error,
  onDone,
}: {
  component: Component;
  files: File[];
  error: string;
  onDone: ComponentFormProps["onDone"];
}) {
  return (
    <>
      <p role="alert">
        The component was saved, but some attachments could not be uploaded.
        Retry the remaining files below. {error}
      </p>
      <InventoryAttachments
        stockUuid={component.uuid}
        initialFiles={files}
        onUploaded={() => {
          void onDone(component.uuid, component);
        }}
      />
    </>
  );
}

type ComponentSource = {
  record?: Component;
  defaults?: Partial<Component>;
};

function ComponentIdentityFields({
  record,
  defaults,
  inventoryOnly,
}: ComponentSource & { inventoryOnly?: boolean }) {
  return (
    <div className="form-grid">
      <ComponentTypeField
        initial={record?.componentType ?? defaults?.componentType}
      />
      <AtaChapterField initial={record?.ataChapter ?? defaults?.ataChapter} />
      <Field label="Part number">
        <input
          name="partNumber"
          defaultValue={record?.partNumber ?? defaults?.partNumber}
          required={inventoryOnly}
          maxLength={COMPONENT_PART_ID_MAX_LENGTH}
        />
      </Field>
      <ModelFields record={record} defaults={defaults} />
      <SerialFields
        record={record}
        defaults={defaults}
        inventoryOnly={inventoryOnly}
      />
    </div>
  );
}

// A stored type outside the list stays selectable, marked as existing.
function ComponentTypeField({ initial }: { initial?: string }) {
  return (
    <Field label="Component type">
      <select name="componentType" defaultValue={initial ?? ""} required>
        <option value="">Select component type</option>
        {COMPONENT_TYPES.map((type) => (
          <option key={type}>{type}</option>
        ))}
        {initial && !COMPONENT_TYPES.includes(initial) && (
          <option value={initial}>{initial} (existing type)</option>
        )}
      </select>
    </Field>
  );
}

function ModelFields({ record, defaults }: ComponentSource) {
  return (
    <>
      <Field label="Component Name">
        <DrsComboBox
          name="model"
          kind="models"
          defaultValue={record?.model ?? defaults?.model}
        />
      </Field>
      <Field
        label="FAA search model (optional)"
        hint="Leave blank to use the component model for AD searches."
      >
        <DrsComboBox
          name="faaSearchModel"
          kind="models"
          defaultValue={record?.faaSearchModel ?? defaults?.faaSearchModel}
        />
      </Field>
    </>
  );
}

function SerialFields({
  record,
  defaults,
  inventoryOnly,
}: ComponentSource & { inventoryOnly?: boolean }) {
  return (
    <>
      <Field
        label="Expiration date"
        hint="Optional; leave blank if not applicable."
      >
        <input
          type="date"
          name="expirationDate"
          defaultValue={record?.expirationDate}
        />
      </Field>
      <Field label="Serial number">
        <input
          name="serial"
          defaultValue={record?.serial}
          maxLength={COMPONENT_PART_ID_MAX_LENGTH}
          required={inventoryOnly}
        />
      </Field>
      <Field label="Manufacturer">
        <DrsComboBox
          name="manufacturer"
          kind="makes"
          defaultValue={record?.manufacturer ?? defaults?.manufacturer}
        />
      </Field>
    </>
  );
}

function NewComponentNotice({ setup }: { setup: boolean }) {
  if (setup)
    return (
      <label>
        <input type="checkbox" required /> This component is already installed
        on this aircraft. I am recording its verified opening baseline for
        initial setup.
      </label>
    );
  return (
    <p>
      New components are received into inventory. Use Install / service to add
      an installation to a work order.
    </p>
  );
}

function PlacementFields({
  form,
  props,
}: {
  form: ComponentFormState;
  props: ComponentFormProps;
}) {
  const { record, parentComponent, defaults } = props;
  const onAircraft = form.location === "aircraft";
  const choose =
    !record && (onAircraft || !programPermission(form.s, "maintenance"));
  return (
    <>
      {choose && (
        <AircraftField
          label={onAircraft ? "Aircraft" : "Aircraft access group"}
          form={form}
          locked={!!props.initialAircraftUuid}
        />
      )}
      {onAircraft ? (
        <Position
          initial={
            record?.installPosition ??
            parentComponent?.installPosition ??
            defaults?.installPosition
          }
        />
      ) : (
        <ComponentStorageFields initial={record} />
      )}
    </>
  );
}

function AircraftField({
  label,
  form,
  locked,
}: {
  label: string;
  form: ComponentFormState;
  locked: boolean;
}) {
  return (
    <Field label={label}>
      <select
        value={form.aircraftId}
        disabled={locked}
        onChange={(e) => form.setAircraftId(e.target.value)}
        required
      >
        {form.editable.map((a) => (
          <option key={a.uuid} value={a.uuid}>
            {a.registration}
          </option>
        ))}
      </select>
    </Field>
  );
}

function MovementHint() {
  return (
    <p className="muted">
      Use Move for aircraft/inventory changes and Set baseline for verified
      installation readings.
    </p>
  );
}

function OpeningBaseline({
  form,
  verified,
}: {
  form: ComponentFormState;
  verified: boolean;
}) {
  const { track, aircraft } = form;
  return (
    <>
      <h3>Installation / opening baseline</h3>
      <BaselineFields
        key={form.aircraftId}
        time={track.time}
        cycles={track.cycles}
        calendar={track.calendar}
        installed={form.location === "aircraft"}
        verifiedEntry={verified}
        aircraftSeconds={
          !verified && aircraft ? totalSeconds(aircraft) : undefined
        }
        aircraftCycles={!verified ? aircraft?.cycles : undefined}
      />
    </>
  );
}

function AttachmentSection({
  files,
  onChange,
}: {
  files: File[];
  onChange: (files: File[]) => void;
}) {
  return (
    <section aria-label="8130 / supporting attachments">
      <h3>8130 / supporting attachments</h3>
      <p>
        Choose an 8130 certificate or supporting documents to upload when you
        save the component. PDF, JPEG, PNG or WebP, up to 7 MB per file.
      </p>
      <InventoryFilePicker files={files} onChange={onChange} />
    </section>
  );
}

// The tag's manufacturer and description are labelled as the tag's, apart
// from the component's own.
function IncomingTagFields({ record }: { record?: Component }) {
  return (
    <details>
      <summary>Incoming component tag / 8130 details</summary>
      <p>
        For components received into inventory, enter the known source aircraft
        and removal details. The 8130 document can be attached when creating the
        component or added to its attachments later. Document contents are not
        copied automatically.
      </p>
      {Object.entries(tagFieldLabels).map(([key, label]) => (
        <Field
          key={key}
          label={
            key === "manufacturer" || key === "description"
              ? `Tag ${label.toLowerCase()}`
              : label
          }
        >
          <input
            name={`incomingTag_${key}`}
            defaultValue={record?.incomingTag?.[key] ?? ""}
            maxLength={INCOMING_TAG_FIELD_MAX_LENGTH}
          />
        </Field>
      ))}
    </details>
  );
}

function BaselineForm({ c, onDone }: { c: Component; onDone: () => void }) {
  const { writable, execute } = useManagement();
  const track = tracking(c);
  return (
    <AsyncForm
      disabled={!writable}
      submitLabel="Save verified baseline"
      onSubmit={async (d) => {
        await execute(baselineCommand(d, c, track));
        onDone();
      }}
    >
      <BaselineFields c={c} {...track} installed={c.installed} />
    </AsyncForm>
  );
}

// Only the dimensions the component tracks (and, in inventory, not the
// installation readings) are read from the form; the rest stay as stored.
function baselineCommand(
  d: FormData,
  c: Component,
  track: Tracking,
): BaselineCommand {
  return {
    action: "component.baseline",
    uuid: c.uuid,
    version: c.version,
    requestUuid: crypto.randomUUID(),
    reason: "Component baseline updated.",
    ...installReadings(d, c, track),
    ...usageReadings(d, c, track),
  };
}

function installReadings(d: FormData, c: Component, track: Tracking) {
  return {
    installedDate: c.installed ? value(d, "installedDate") : c.installedDate,
    installedSeconds:
      c.installed && track.time
        ? secs(d, "installedSeconds")!
        : c.installedSeconds,
    installedCycles:
      c.installed && track.cycles
        ? num(d, "installedCycles")!
        : c.installedCycles,
  };
}

function usageReadings(d: FormData, c: Component, track: Tracking) {
  const { time, cycles, calendar } = track;
  return {
    timeSinceNew: time ? secs(d, "timeSinceNew")! : c.timeSinceNew,
    timeSinceOverhaul: time
      ? (secs(d, "timeSinceOverhaul") ?? null)
      : c.timeSinceOverhaul,
    timeSinceRepair: time
      ? (secs(d, "timeSinceRepair") ?? null)
      : c.timeSinceRepair,
    cyclesSinceNew: cycles ? num(d, "cyclesSinceNew")! : c.cyclesSinceNew,
    serviceDaysBase: calendar
      ? (daysFromMonths(d, "serviceMonthsBase") ?? 0)
      : c.serviceDaysBase,
    calendarSinceNewUnknown: calendar
      ? !value(d, "serviceMonthsBase")
      : c.calendarSinceNewUnknown,
    calendarOverhaulDaysBase: calendar
      ? (daysFromMonths(d, "calendarOverhaulMonths") ?? null)
      : c.calendarOverhaulDaysBase,
  };
}

function PlannedMovement({
  c,
  operation,
  onChange,
  children,
}: {
  c: Component;
  operation: ServiceOperation;
  onChange: (operation: ServiceOperation) => void;
  children: ReactNode;
}) {
  return (
    <>
      {!c.installed && (
        <Field label="Service action">
          <select
            value={operation}
            onChange={(e) => onChange(e.target.value as ServiceOperation)}
          >
            <option value="install">Install through work order</option>
            <option value="overhaul">Record overhaul</option>
            <option value="repair">Record repair</option>
          </select>
        </Field>
      )}
      {children}
    </>
  );
}

function ServiceActionField({
  c,
  operation,
  onChange,
}: {
  c: Component;
  operation: ServiceOperation;
  onChange: (operation: ServiceOperation) => void;
}) {
  return (
    <Field label="Service action">
      <select
        value={operation}
        onChange={(e) => onChange(e.target.value as ServiceOperation)}
      >
        {c.installed ? (
          <option value="remove">Move to inventory</option>
        ) : (
          <>
            <option value="install">Install on aircraft</option>
            <option value="overhaul">Record overhaul</option>
            <option value="repair">Record repair</option>
          </>
        )}
      </select>
    </Field>
  );
}

function serviceCommand(
  c: Component,
  operation: ServiceOperation,
  reason: string,
): ManagementCommand {
  return {
    action: "component.service",
    uuid: c.uuid,
    version: c.version,
    requestUuid: crypto.randomUUID(),
    reason,
    operation,
    date: today(),
  };
}

// A new requirement opens on every dimension the component tracks except
// landings; one being edited (or pre-filled) on the dimensions it limits.
function initialTrack(
  available: Track<Dimension>,
  record?: RequirementInput,
): Track<Dimension> {
  const limits = (interval: number | undefined) => (record ? !!interval : true);
  return {
    time: available.time && limits(record?.intervalSeconds),
    calendar: available.calendar && limits(record?.calendarIntervalValue),
    cycles: available.cycles && limits(record?.intervalCycles),
    landings: !!record?.intervalLandings,
  };
}

// The preview runs on every keystroke, so a form that cannot be computed yet
// shows a prompt; saving reports the actual error.
function previewDue(s: Snapshot, build: () => ComponentRequirement) {
  try {
    return dueSummary(saveRequirement(s, build(), Date.now()));
  } catch {
    return "Complete the limits and verified compliance history to calculate due values.";
  }
}

function dueSummary(r: ComponentRequirement) {
  const limits = [
    r.dueSeconds === undefined
      ? ""
      : `${r.dueSeconds / SECONDS_PER_HOUR} ${r.timeBasis} hours`,
    r.dueCycles === undefined ? "" : `${r.dueCycles} cycles`,
    r.dueLandings === undefined ? "" : `${r.dueLandings} aircraft landings`,
    r.dueDate ?? "",
  ];
  return `Next due: ${limits.filter(Boolean).join(" or ")} (first reached).`;
}

function requirementSaveCommand(
  r: ComponentRequirement,
  editing: boolean,
): ManagementCommand {
  return {
    action: "record.save",
    record: r,
    requestUuid: crypto.randomUUID(),
    reason: editing
      ? "Service requirement updated."
      : "Service requirement added.",
  };
}

function requirementFromForm(
  d: FormData,
  c: Component,
  record: RequirementInput | undefined,
  track: Track<Dimension>,
): ComponentRequirement {
  return {
    kind: "componentRequirement",
    requiredParts: requiredPartsFromForm(d),
    sourceKey: record?.sourceKey,
    manualReference: manualReferenceFromForm(d),
    uuid: record?.uuid ?? crypto.randomUUID(),
    version: record?.version ?? 0,
    componentUuid: c.uuid,
    aircraftUuid: c.aircraftUuid,
    requirementType: value(
      d,
      "requirementType",
    ) as ComponentRequirement["requirementType"],
    description: value(d, "description"),
    notes: value(d, "notes"),
    ...complianceFromForm(d, c, record, track),
    ...intervalsFromForm(d),
  };
}

function complianceFromForm(
  d: FormData,
  c: Component,
  record: RequirementInput | undefined,
  track: Track<Dimension>,
) {
  return {
    lastDate: value(d, "lastDate") || undefined,
    lastSeconds: signedSeconds(d, "lastSeconds"),
    timeResetSeconds: track.time ? record?.timeResetSeconds : undefined,
    lastCycles: num(d, "lastCycles"),
    lastLandings: num(d, "lastLandings"),
    intervalLandings: num(d, "intervalLandings"),
    landingLimitMode: (value(d, "landingLimitMode") ||
      "FROM_LAST_COMPLIED") as ComponentRequirement["landingLimitMode"],
    landingReferenceAircraftUuid: track.landings ? c.aircraftUuid : undefined,
    warningLandings:
      num(d, "warningLandings") ?? REQUIREMENT_WARNING_DEFAULTS.warningLandings,
  };
}

// Compliance before a repair or overhaul reset is kept rebased: negative
// hours on the new counter. parseHours takes positive hours only.
function signedSeconds(d: FormData, name: string) {
  const hours = value(d, name);
  return hours.startsWith("-") ? -parseHours(hours.slice(1))! : secs(d, name);
}

function intervalsFromForm(d: FormData) {
  return {
    calendarIntervalValue: num(d, "calendarIntervalValue"),
    calendarIntervalUnit: (value(d, "calendarIntervalUnit") ||
      "MONTHS") as ComponentRequirement["calendarIntervalUnit"],
    intervalSeconds: secs(d, "intervalSeconds"),
    timeBasis: (value(d, "timeBasis") ||
      "TSN") as ComponentRequirement["timeBasis"],
    timeLimitMode: (value(d, "timeLimitMode") ||
      "ABSOLUTE") as ComponentRequirement["timeLimitMode"],
    intervalCycles: num(d, "intervalCycles"),
    cycleLimitMode: (value(d, "cycleLimitMode") ||
      "ABSOLUTE") as ComponentRequirement["cycleLimitMode"],
    warningCalendarMonths: num(d, "warningCalendarMonths") ?? 0,
    warningSeconds: secs(d, "warningSeconds") ?? 0,
    warningCycles: num(d, "warningCycles") ?? 0,
  };
}

function RequirementBasics({ record }: { record?: RequirementInput }) {
  return (
    <>
      <RequiredPartsFields
        initial={record?.requiredParts}
        source={record?.uuid ? requirementSource(record.uuid) : undefined}
      />
      <Field label="Requirement type">
        <select
          name="requirementType"
          defaultValue={record?.requirementType ?? "Life Limits"}
        >
          {[
            "Life Limits",
            "Overhaul Requirement",
            "Inspection Requirement",
          ].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </Field>
      <Field label="Description">
        <input
          name="description"
          defaultValue={record?.description}
          maxLength={REQUIREMENT_DESCRIPTION_MAX_LENGTH}
          required
        />
      </Field>
      <ManualReferenceFields initial={record?.manualReference} />
    </>
  );
}

interface LimitProps {
  tracked: boolean;
  record?: RequirementInput;
}

function RequirementLimits({
  available,
  track,
  onTrack,
  record,
}: {
  available: Track<Dimension>;
  track: Track<Dimension>;
  onTrack: (track: Track<Dimension>) => void;
  record?: RequirementInput;
}) {
  return (
    <>
      <TrackChoices
        choices={REQUIREMENT_TRACKING}
        track={track}
        available={available}
        onChange={onTrack}
      />
      {Object.values(available).some((enabled) => !enabled) && (
        <p className="muted">
          Enable tracking on the component to use a disabled option.
        </p>
      )}
      {available.time && <TimeLimits tracked={track.time} record={record} />}
      {available.cycles && (
        <CycleLimits tracked={track.cycles} record={record} />
      )}
      <LandingLimits tracked={track.landings} record={record} />
      {available.calendar && (
        <CalendarLimits tracked={track.calendar} record={record} />
      )}
    </>
  );
}

// An untracked dimension's fieldset is disabled, so its fields read as
// blank, and hidden; it stays mounted, so entries survive toggling it back.
function TrackedFieldset({
  tracked,
  children,
}: {
  tracked: boolean;
  children: ReactNode;
}) {
  return (
    <fieldset disabled={!tracked} hidden={!tracked}>
      {children}
    </fieldset>
  );
}

function TimeLimits({ tracked, record }: LimitProps) {
  return (
    <TrackedFieldset tracked={tracked}>
      <h3>Component time</h3>
      <div className="form-grid">
        <TimeBasisFields record={record} />
        <NumberField
          name="intervalSeconds"
          label="Hour limit / interval"
          decimal
          initial={toHours(record?.intervalSeconds)}
        />
        <LastCompliedHours lastSeconds={record?.lastSeconds} />
        <NumberField
          name="warningSeconds"
          label="Due soon: component hours"
          decimal
          initial={
            (record?.warningSeconds ??
              REQUIREMENT_WARNING_DEFAULTS.warningSeconds) / SECONDS_PER_HOUR
          }
          required
        />
      </div>
    </TrackedFieldset>
  );
}

function TimeBasisFields({ record }: { record?: RequirementInput }) {
  return (
    <>
      <Field label="Time basis">
        <select name="timeBasis" defaultValue={record?.timeBasis ?? "TSN"}>
          {["TSN", "TSO", "TSR"].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </Field>
      <Field label="Hour limit basis">
        <select
          name="timeLimitMode"
          defaultValue={record?.timeLimitMode ?? "ABSOLUTE"}
        >
          <option value="ABSOLUTE">Absolute component hours</option>
          <option value="FROM_LAST_COMPLIED">
            Hours after last compliance
          </option>
        </select>
      </Field>
    </>
  );
}

function LastCompliedHours({ lastSeconds }: { lastSeconds?: number }) {
  return (
    <Field
      label="Last complied component hours"
      hint={
        lastSeconds !== undefined && lastSeconds < 0
          ? "Previous compliance predates the repair/overhaul counter reset; its rebased reading preserves the remaining interval."
          : undefined
      }
    >
      <input
        name="lastSeconds"
        type="number"
        step="0.1"
        defaultValue={
          lastSeconds === undefined ? "" : lastSeconds / SECONDS_PER_HOUR
        }
      />
    </Field>
  );
}

function CycleLimits({ tracked, record }: LimitProps) {
  return (
    <TrackedFieldset tracked={tracked}>
      <h3>Component cycles</h3>
      <div className="form-grid">
        <Field label="Cycle limit basis">
          <select
            name="cycleLimitMode"
            defaultValue={record?.cycleLimitMode ?? "ABSOLUTE"}
          >
            <option value="ABSOLUTE">Absolute component cycles</option>
            <option value="FROM_LAST_COMPLIED">
              Cycles after last compliance
            </option>
          </select>
        </Field>
        <NumberField
          name="intervalCycles"
          label="Cycle limit / interval"
          initial={record?.intervalCycles}
        />
        <NumberField
          name="lastCycles"
          label="Last complied component cycles"
          initial={record?.lastCycles}
        />
        <NumberField
          name="warningCycles"
          label="Due soon: component cycles"
          initial={
            record?.warningCycles ?? REQUIREMENT_WARNING_DEFAULTS.warningCycles
          }
          required
        />
      </div>
    </TrackedFieldset>
  );
}

function LandingLimits({ tracked, record }: LimitProps) {
  return (
    <TrackedFieldset tracked={tracked}>
      <legend>Aircraft landings</legend>
      <p>
        Uses the installed aircraft’s total landing count. Review this baseline
        when moving the component to another aircraft.
      </p>
      <div className="form-grid">
        <Field label="Landing limit basis">
          <select
            name="landingLimitMode"
            defaultValue={record?.landingLimitMode ?? "FROM_LAST_COMPLIED"}
          >
            <option value="FROM_LAST_COMPLIED">
              Landings after last compliance
            </option>
            <option value="ABSOLUTE">Absolute aircraft landings</option>
          </select>
        </Field>
        <NumberField
          name="intervalLandings"
          label="Landing limit / interval"
          initial={record?.intervalLandings}
        />
        <NumberField
          name="lastLandings"
          label="Last complied at (aircraft total landings)"
          initial={record?.lastLandings}
        />
        <NumberField
          name="warningLandings"
          label="Due soon: landings"
          initial={
            record?.warningLandings ??
            REQUIREMENT_WARNING_DEFAULTS.warningLandings
          }
        />
      </div>
    </TrackedFieldset>
  );
}

function CalendarLimits({ tracked, record }: LimitProps) {
  return (
    <TrackedFieldset tracked={tracked}>
      <h3>Calendar</h3>
      <div className="form-grid">
        <Field label="Last complied date">
          <input
            name="lastDate"
            type="date"
            defaultValue={record?.lastDate}
            max={today()}
          />
        </Field>
        <NumberField
          name="calendarIntervalValue"
          label="Calendar interval"
          initial={record?.calendarIntervalValue}
        />
        <CalendarUnitField unit={record?.calendarIntervalUnit} />
        <NumberField
          name="warningCalendarMonths"
          label="Due soon: calendar months"
          initial={
            record?.warningCalendarMonths ??
            REQUIREMENT_WARNING_DEFAULTS.warningCalendarMonths
          }
          required
        />
      </div>
      <p className="muted">
        Month and year intervals fall due on the last day of the target month.
        Day intervals use exact dates.
      </p>
    </TrackedFieldset>
  );
}

function CalendarUnitField({ unit }: { unit?: string }) {
  return (
    <Field label="Calendar unit">
      <select name="calendarIntervalUnit" defaultValue={unit ?? "MONTHS"}>
        {["DAYS", "MONTHS", "YEARS"].map((u) => (
          <option key={u}>{u}</option>
        ))}
      </select>
    </Field>
  );
}

type EditRequirement = (r: ComponentRequirement) => void;

function Requirements({
  due,
  c,
  edit,
}: {
  due: RequirementDue[];
  c: Component;
  edit?: EditRequirement;
}) {
  const rows = duesOf(due, c).map((d) => ({
    r: d.requirement,
    remaining: measured(d),
    level: d.level,
  }));
  return (
    <section className="mx-dialog-section">
      <h3>Service requirements</h3>
      {rows.length ? (
        <RequirementsTable rows={rows} c={c} edit={edit} />
      ) : (
        <p className="mx-dialog-empty">
          No separate service requirements recorded.
        </p>
      )}
    </section>
  );
}

function RequirementsTable({
  rows,
  c,
  edit,
}: {
  rows: { r: ComponentRequirement; remaining: Remaining; level: DueLevel }[];
  c: Component;
  edit?: EditRequirement;
}) {
  return (
    <div className="table-wrap mx-table-card">
      <table className="mx-table">
        <RequirementsHead />
        <tbody>
          {rows.map(({ r, remaining, level }) => (
            <RequirementRow
              key={r.uuid}
              r={r}
              c={c}
              remaining={remaining}
              level={level}
              edit={edit}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RequirementsHead() {
  return (
    <thead>
      <tr>
        <th>Requirement</th>
        <th>Due date</th>
        <th>Due hours / basis</th>
        <th>Due cycles / landings</th>
        <th>Remaining</th>
        <th>Status</th>
        <th>
          <span className="sr-only">Actions</span>
        </th>
      </tr>
    </thead>
  );
}

function RequirementRow({
  r,
  c,
  remaining,
  level,
  edit,
}: {
  r: ComponentRequirement;
  c: Component;
  remaining: Remaining;
  level: DueLevel;
  edit?: EditRequirement;
}) {
  return (
    <tr>
      <RequirementCell r={r} />
      <td className="mx-num">{requirementDueDate(r) ?? "—"}</td>
      <td className="mx-num">
        {r.dueSeconds === undefined
          ? "—"
          : `${hours(r.dueSeconds)} ${r.timeBasis}`}
      </td>
      <td className="mx-num">
        <DueCounts r={r} />
      </td>
      <td className="mx-num">
        <RemainingLimits remaining={remaining} />
      </td>
      <td>
        <StatusPill tone={LEVEL_TONES[level]}>{remaining.status}</StatusPill>
      </td>
      <td>
        <RequirementActions r={r} c={c} edit={edit} />
      </td>
    </tr>
  );
}

function RequirementCell({ r }: { r: ComponentRequirement }) {
  return (
    <td>
      <span className="mx-table-kicker">{r.requirementType}</span>
      <strong className="mx-table-title">{r.description}</strong>
      <span className="mx-table-note">
        <ManualLink reference={r.manualReference} />
      </span>
      <PartsAvailability
        parts={r.requiredParts}
        source={requirementSource(r.uuid)}
      />
    </td>
  );
}

function DueCounts({ r }: { r: ComponentRequirement }) {
  return (
    <>
      {r.dueCycles !== undefined && <div>{r.dueCycles} cycles</div>}
      {r.dueLandings !== undefined && <div>{r.dueLandings} landings</div>}
      {r.dueCycles === undefined && r.dueLandings === undefined && "—"}
    </>
  );
}

function RemainingLimits({ remaining }: { remaining: Remaining }) {
  const { seconds, cycles, landings, days } = remaining;
  return (
    <>
      {seconds !== undefined && <div>{hours(seconds)} h</div>}
      {cycles !== undefined && <div>{cycles} cycles</div>}
      {landings !== undefined && <div>{landings} landings</div>}
      {days !== undefined && <div>≈ {formatMonths(days)} months</div>}
    </>
  );
}

function RequirementActions({
  r,
  c,
  edit,
}: {
  r: ComponentRequirement;
  c: Component;
  edit?: EditRequirement;
}) {
  const link = { kind: "componentRequirement" as const, uuid: r.uuid };
  return (
    <span className="mx-table-actions">
      <RequestPartsButton source={requirementSource(r.uuid)} />
      {c.installed && (
        <LinkedTaskCards aircraftUuid={c.aircraftUuid} link={link} />
      )}
      {c.installed && (
        <AddToWorkOrder aircraftUuid={c.aircraftUuid} source={link} />
      )}
      {edit && (
        <button className="button small" onClick={() => edit(r)}>
          <PencilSimple size={16} aria-hidden="true" />
          Edit requirement
        </button>
      )}
    </span>
  );
}

function Movements({ s, c }: { s: Snapshot; c: Component }) {
  const rows = (s.management ?? [])
    .filter(
      (r): r is ComponentMovement =>
        r.kind === "componentMovement" && r.componentUuid === c.uuid,
    )
    .sort((a, b) => b.at - a.at);
  return (
    <section className="mx-dialog-section">
      <h3>Movement and baseline history</h3>
      {rows.length ? (
        <div className="table-wrap mx-table-card">
          <table className="mx-table">
            <thead>
              <tr>
                <th>Date / action</th>
                <th>Aircraft / location</th>
                <th>TSN / TSO / TSR</th>
                <th>Cycles / months</th>
                <th>Recorded by / note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <MovementRow key={r.uuid} s={s} r={r} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mx-dialog-empty">
          No movement or baseline events recorded.
        </p>
      )}
    </section>
  );
}

function MovementRow({ s, r }: { s: Snapshot; r: ComponentMovement }) {
  return (
    <tr>
      <MovementActionCell r={r} />
      <td>
        {registrationOf(s, r.aircraftUuid) ?? "Inventory"}
        <span className="mx-table-note">
          {r.partsLocation ?? r.installPosition}
        </span>
      </td>
      <td className="mx-num">
        {displayHours(r.timeSinceNew)} / {displayHours(r.timeSinceOverhaul)} /{" "}
        {displayHours(r.timeSinceRepair)}
      </td>
      <MovementAgeCell r={r} />
      <td>
        {s.members.find((m) => m.id === r.actorId)?.name ?? "Recorded user"}
        <span className="mx-table-note">{r.note}</span>
      </td>
    </tr>
  );
}

function MovementActionCell({ r }: { r: ComponentMovement }) {
  return (
    <td>
      <span className="mx-table-kicker mx-num">{r.date}</span>
      <strong className="mx-table-title">{r.action}</strong>
      {r.supersededByCorrection && (
        <StatusPill tone="warn">Superseded by correction</StatusPill>
      )}
      {r.correctionUuid && !r.supersededByCorrection && (
        <span className="mx-table-note">Work-order correction</span>
      )}
    </td>
  );
}

function MovementAgeCell({ r }: { r: ComponentMovement }) {
  return (
    <td className="mx-num">
      {r.cycles} cycles
      <span className="mx-table-note">
        Calendar time since new:{" "}
        {r.calendarSinceNewUnknown
          ? "Unknown"
          : `≈ ${formatMonths(r.serviceDays)} months`}
      </span>
      {r.calendarOverhaulDays != null && (
        <span className="mx-table-note">
          Calendar time since overhaul: ≈ {formatMonths(r.calendarOverhaulDays)}{" "}
          months
        </span>
      )}
    </td>
  );
}

type ComponentsScreen = ReturnType<typeof useComponentsScreen>;

function useComponentsScreen() {
  const { s, writable } = useManagement();
  const items = (s.management ?? []).filter(
    (r): r is Component => r.kind === "component",
  );
  const selection = useSelection(items);
  const [requirement, setRequirement] = useState<ComponentRequirement>(),
    [search, setSearch] = useState(""),
    [location, setLocation] = useState("all");
  const editRequirement = (r?: ComponentRequirement) => {
    setRequirement(r);
    selection.setMode("requirement");
  };
  return {
    ...selection,
    s,
    writable,
    items,
    due: requirementDues(s),
    requirement,
    editRequirement,
    search,
    setSearch,
    location,
    setLocation,
  };
}

// Which component the dialog shows, and how. A ?item= link opens its details
// once, so a snapshot update cannot reset an open dialog to details; closing
// the dialog clears the link.
function useSelection(items: Component[]) {
  const [selected, setSelected] = useState<Component | "new" | null>(null),
    [mode, setMode] = useState<Mode>("details");
  const linked = useSearch({ from: "/components" });
  const navigate = useNavigate({ from: "/components" });
  const openedLink = useRef("");
  const linkedComponent = items.find((r) => r.uuid === linked.item);
  useEffect(() => {
    if (!linked.item) {
      openedLink.current = "";
      return;
    }
    if (!linkedComponent || openedLink.current === linked.item) return;
    openedLink.current = linked.item;
    setSelected(linkedComponent);
    setMode("details");
  }, [linked.item, linkedComponent]);
  const open = (next: Component | "new", nextMode: Mode) => {
    setSelected(next);
    setMode(nextMode);
  };
  const done = () => {
    setSelected(null);
    if (linked.item)
      void navigate({ to: "/components", search: {}, replace: true });
  };
  const linkMissing = !!linked.item && !linkedComponent;
  return { selected, setSelected, mode, setMode, open, done, linkMissing };
}

function filterComponents(
  s: Snapshot,
  items: Component[],
  search: string,
  location: string,
) {
  const query = search.toLowerCase();
  return items.filter(
    (c) =>
      (location === "all" || (location === "aircraft") === c.installed) &&
      searchText(s, c).includes(query),
  );
}

function searchText(s: Snapshot, c: Component) {
  const registration = registrationOf(s, c.aircraftUuid) ?? "";
  return `${c.componentType} ${c.model ?? ""} ${c.manufacturer} ${c.partNumber} ${c.serial} ${ataLabel(c.ataChapter)} ${registration}`.toLowerCase();
}

interface ComponentGroupItems {
  label: string;
  items: Component[];
}

// Installed components group under their aircraft, the rest under
// Inventory; groups sort by label.
function groupComponents(s: Snapshot, components: Component[]) {
  const groups = new Map<string, ComponentGroupItems>();
  for (const item of components) {
    const key = item.installed ? `aircraft:${item.aircraftUuid}` : "inventory";
    const group = groups.get(key) ?? { label: groupLabel(s, item), items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups].sort(([, a], [, b]) => a.label.localeCompare(b.label));
}

function groupLabel(s: Snapshot, item: Component) {
  if (!item.installed) return "Inventory";
  return registrationOf(s, item.aircraftUuid) ?? "Unknown aircraft";
}

function NoComponents({ hasComponents }: { hasComponents: boolean }) {
  return (
    <EmptyState
      title={hasComponents ? "No matching components" : "No tracked components"}
    >
      {hasComponents
        ? "Try another search or location."
        : "Add components in inventory or enter a verified aircraft installation."}
    </EmptyState>
  );
}

function ComponentsHeader({
  canAdd,
  onNew,
}: {
  canAdd: boolean;
  onNew: () => void;
}) {
  return (
    <PageHeader
      eyebrow="MAINTENANCE"
      title="Components"
      description="Component identity, installation baselines, service requirements, and movement history."
      actions={
        <>
          <Link className="button" to="/components/imported">
            <Copy size={18} aria-hidden="true" />
            Imported components
          </Link>
          <ScanButton />
          <button className="button primary" disabled={!canAdd} onClick={onNew}>
            <Plus size={18} weight="bold" aria-hidden="true" />
            New component
          </button>
        </>
      }
    />
  );
}

function ComponentFilters({ screen }: { screen: ComponentsScreen }) {
  const { items } = screen;
  const installed = items.filter((c) => c.installed).length;
  return (
    <Toolbar
      className="mx-filters"
      end={
        <Segmented
          label="Component location"
          value={screen.location}
          onChange={screen.setLocation}
          options={[
            { value: "all", label: "All locations", count: items.length },
            { value: "aircraft", label: "Installed", count: installed },
            {
              value: "inventory",
              label: "In inventory",
              count: items.filter((c) => !c.installed).length,
            },
          ]}
        />
      }
    >
      <SearchField
        className="mx-search"
        label="Search components"
        placeholder="Type, manufacturer, part, serial, or ATA"
        value={screen.search}
        onChange={screen.setSearch}
      />
    </Toolbar>
  );
}

function ComponentGroup({
  id,
  group,
  screen,
}: {
  id: string;
  group: ComponentGroupItems;
  screen: ComponentsScreen;
}) {
  const count = group.items.length;
  return (
    <details className="component-group mx-comp-group" open>
      <summary className="mx-group-summary">
        <IconTile
          icon={id === "inventory" ? Warehouse : AirplaneTilt}
          tone="blue"
          size="md"
        />
        <span className="mx-group-title">{group.label}</span>
        <span className="mx-group-count">
          {count} component{count === 1 ? "" : "s"}
        </span>
        <CaretDown className="mx-group-caret" size={18} aria-hidden="true" />
      </summary>
      <table
        className="mx-records mx-comp-table"
        role="table"
        aria-label={`${group.label} components`}
      >
        <ComponentsHead />
        <tbody role="rowgroup">
          {group.items.map((c) => (
            <ComponentRow key={c.uuid} c={c} screen={screen} />
          ))}
        </tbody>
      </table>
    </details>
  );
}

function ComponentsHead() {
  return (
    <thead className="sr-only" role="rowgroup">
      <tr role="row">
        {[
          "Component / part / serial",
          "Position / location",
          "Readings",
          "Nearest service remaining",
          "Actions",
        ].map((h) => (
          <th role="columnheader" scope="col" key={h}>
            {h}
          </th>
        ))}
      </tr>
    </thead>
  );
}

function ComponentRow({
  c,
  screen,
}: {
  c: Component;
  screen: ComponentsScreen;
}) {
  const { s } = screen;
  const a = s.aircraft.find((a) => a.uuid === c.aircraftUuid);
  const t = componentTotals(c, a);
  const parent = screen.items.find((p) => p.uuid === c.parentComponentUuid);
  const dues = duesOf(screen.due, c);
  const statuses = dues.map(measured);
  const pastDue = dues.some((d) => d.level === "overdue");
  return (
    <tr role="row" className="mx-comp-row">
      <ComponentMainCell c={c} parent={parent} pastDue={pastDue} />
      <PlacementCell s={s} c={c} a={a} />
      <ReadingsCell c={c} t={t} />
      <RemainingCell statuses={statuses} pastDue={pastDue} />
      <ComponentActionsCell c={c} screen={screen} />
    </tr>
  );
}

function ComponentMainCell({
  c,
  parent,
  pastDue,
}: {
  c: Component;
  parent?: Component;
  pastDue: boolean;
}) {
  return (
    <td role="cell" className="mx-cell-main">
      <IconTile
        icon={componentIcon(c.componentType)}
        tone={componentTone(c, pastDue)}
      />
      <span className="mx-main-text">
        <strong className="mx-main-title">{c.model || c.componentType}</strong>
        <span className="mx-main-sub">
          {c.componentType} · {c.manufacturer || "—"} · {ataLabel(c.ataChapter)}
        </span>
        <span className="mx-main-note mx-num">
          P/N {c.partNumber || "—"} · S/N {c.serial || "—"}
        </span>
        {parent && (
          <span className="mx-main-note">
            Part of {parent.model || parent.componentType}
          </span>
        )}
      </span>
    </td>
  );
}

function componentTone(c: Component, pastDue: boolean): Tone {
  if (pastDue) return "danger";
  if (c.installed) return "good";
  return c.outForRepair ? "warn" : "blue";
}

function PlacementCell({
  s,
  c,
  a,
}: {
  s: Snapshot;
  c: Component;
  a?: Aircraft;
}) {
  const pill = placementPill(c);
  return (
    <td role="cell" className="mx-fact">
      <FactLabel>Position / location</FactLabel>
      {c.installed && (
        <span className="mx-fact-value">
          {a?.registration ?? "Unknown aircraft"}
        </span>
      )}
      <span className={c.installed ? "mx-fact-note" : "mx-fact-value"}>
        {c.installed
          ? (c.installPosition ?? "Not recorded")
          : componentStorage(s, c)}
      </span>
      <StatusPill className="mx-fact-pill" dot={false} tone={pill.tone}>
        {pill.label}
      </StatusPill>
    </td>
  );
}

function placementPill(c: Component): { tone: Tone; label: string } {
  if (c.installed) return { tone: "good", label: "Installed" };
  return c.outForRepair
    ? { tone: "warn", label: "Out for repair" }
    : { tone: "neutral", label: "In storage" };
}

function ReadingsCell({ c, t }: { c: Component; t: Totals }) {
  const track = tracking(c);
  return (
    <td role="cell" className="mx-fact">
      <FactLabel>Readings</FactLabel>
      {track.time && (
        <>
          <span className="mx-fact-value mx-num">
            TSN {displayHours(t.timeSinceNew)}
          </span>
          <span className="mx-fact-note mx-num">
            TSO {displayHours(t.timeSinceOverhaul)} · TSR{" "}
            {displayHours(t.timeSinceRepair)}
          </span>
        </>
      )}
      {(track.cycles || track.calendar) && (
        <span className="mx-fact-note">{usageSummary(c, t, track)}</span>
      )}
      {track.calendar && (
        <span className="mx-fact-note">
          Calendar time since overhaul:{" "}
          {t.calendarOverhaulDays == null
            ? "Unknown"
            : `${formatMonths(t.calendarOverhaulDays)} months`}
        </span>
      )}
      {!track.time && !track.cycles && !track.calendar && (
        <span className="mx-fact-value">—</span>
      )}
    </td>
  );
}

function usageSummary(c: Component, t: Totals, track: Tracking) {
  const age = c.calendarSinceNewUnknown
    ? "Unknown"
    : `${formatMonths(t.serviceDays)} months`;
  return [
    track.cycles ? `${t.cyclesSinceNew} cycles` : "",
    track.calendar ? `Calendar time since new: ${age}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function RemainingCell({
  statuses,
  pastDue,
}: {
  statuses: Remaining[];
  pastDue: boolean;
}) {
  return (
    <td role="cell" className="mx-fact mx-comp-remaining">
      <FactLabel>Nearest service remaining</FactLabel>
      {statuses.length ? (
        <NearestRemaining statuses={statuses} pastDue={pastDue} />
      ) : (
        <span className="mx-fact-note">No service requirements</span>
      )}
    </td>
  );
}

function NearestRemaining({
  statuses,
  pastDue,
}: {
  statuses: Remaining[];
  pastDue: boolean;
}) {
  const seconds = nearest(statuses, "seconds"),
    days = nearest(statuses, "days"),
    cycles = nearest(statuses, "cycles");
  return (
    <>
      {seconds !== undefined && (
        <div className="mx-fact-value mx-num">{hours(seconds)} h</div>
      )}
      {days !== undefined && (
        <div className="mx-fact-value mx-num">
          ≈ {formatMonths(days)} months
        </div>
      )}
      {cycles !== undefined && (
        <div className="mx-fact-value mx-num">{cycles} cycles</div>
      )}
      {pastDue && (
        <StatusPill className="mx-fact-pill" tone="danger" dot={false}>
          Past due
        </StatusPill>
      )}
      {seconds === undefined && days === undefined && cycles === undefined && (
        <span className="mx-fact-value">—</span>
      )}
    </>
  );
}

function nearest(statuses: Remaining[], key: "seconds" | "days" | "cycles") {
  const values = statuses
    .map((r) => r[key])
    .filter((n): n is number => n !== undefined);
  return values.length ? Math.min(...values) : undefined;
}

function ComponentActionsCell({
  c,
  screen,
}: {
  c: Component;
  screen: ComponentsScreen;
}) {
  return (
    <td role="cell" className="mx-cell-actions">
      <button
        className="button small"
        onClick={() => screen.open(c, "details")}
      >
        Details
      </button>
      {canMaintain(screen.s, c) && (
        <button
          className="button soft small"
          disabled={!screen.writable}
          onClick={() => screen.open(c, "service")}
        >
          <Wrench size={16} weight="bold" aria-hidden="true" />
          Add Service/Inspections
        </button>
      )}
      <RequestPartsButton
        source={{ kind: "component", uuid: c.uuid, workOrderUuid: "" }}
      />
    </td>
  );
}

function ComponentDialog({
  screen,
  selected,
}: {
  screen: ComponentsScreen;
  selected: Component | "new";
}) {
  const c = selected === "new" ? undefined : selected;
  return (
    <Modal
      key={screen.mode}
      title={dialogTitle(selected, screen.mode)}
      onClose={screen.done}
    >
      <DialogBody screen={screen} c={c} />
    </Modal>
  );
}

function dialogTitle(selected: Component | "new", mode: Mode) {
  if (selected === "new") return "New component";
  return mode === "details" ? selected.componentType : DIALOG_TITLES[mode];
}

function DialogBody({
  screen,
  c,
}: {
  screen: ComponentsScreen;
  c?: Component;
}) {
  const { mode, done } = screen;
  if (mode === "edit")
    return (
      <ComponentForm
        key={c?.version}
        record={c}
        onDone={done}
        onReload={screen.setSelected}
      />
    );
  if (!c) return null;
  if (mode === "child")
    return (
      <ComponentForm
        parentComponent={c}
        initialAircraftUuid={c.installed ? c.aircraftUuid : undefined}
        onDone={(_uuid, child) => {
          screen.setSelected(child);
          screen.editRequirement(undefined);
        }}
      />
    );
  if (mode === "baseline") return <BaselineForm c={c} onDone={done} />;
  if (mode === "service") return <ServiceForm c={c} onDone={done} />;
  if (mode === "requirement")
    return <RequirementForm c={c} record={screen.requirement} onDone={done} />;
  return <ComponentDetails screen={screen} c={c} />;
}

function ComponentDetails({
  screen,
  c,
}: {
  screen: ComponentsScreen;
  c: Component;
}) {
  const { s, writable } = screen;
  const editable = canMaintain(s, c);
  return (
    <>
      <ComponentFacts s={s} c={c} />
      {editable && <DetailActions c={c} screen={screen} />}
      {programPermission(s, "admin") && (
        <section className="mx-dialog-section">
          <div className="mx-dialog-actions">
            <InventoryPrintButtons item={c} />
          </div>
          <InventoryAttachments stockUuid={c.uuid} />
        </section>
      )}
      <Requirements
        due={screen.due}
        c={c}
        edit={editable && writable ? screen.editRequirement : undefined}
      />
      <Movements s={s} c={c} />
      <History uuid={c.uuid} />
    </>
  );
}

function ComponentFacts({ s, c }: { s: Snapshot; c: Component }) {
  return (
    <dl className="mx-detail-list">
      <dt>ATA Chapter</dt>
      <dd>{ataLabel(c.ataChapter)}</dd>
      <dt>Model</dt>
      <dd>{c.model || "Not recorded"}</dd>
      <dt>Manual</dt>
      <dd>
        <ManualLink reference={c.manualReference} />
      </dd>
      <dt>Manufacturer</dt>
      <dd>{c.manufacturer || "Not recorded"}</dd>
      <dt>Part / serial</dt>
      <dd>
        {c.partNumber || "—"} / {c.serial || "—"}
      </dd>
      <dt>Location</dt>
      <dd>
        {c.installed ? registrationOf(s, c.aircraftUuid) : "Inventory"} ·{" "}
        {c.installed ? c.installPosition : componentStorage(s, c)}
      </dd>
      <dt>Installed / removed</dt>
      <dd>
        {c.installedDate ?? "—"} / {c.removedDate ?? "—"}
      </dd>
      <dt>Notes</dt>
      <dd>{c.notes || "—"}</dd>
    </dl>
  );
}

function DetailActions({
  c,
  screen,
}: {
  c: Component;
  screen: ComponentsScreen;
}) {
  const disabled = !screen.writable;
  return (
    <div className="mx-dialog-actions">
      {c.installed && (
        <button
          className="button"
          disabled={disabled}
          onClick={() => screen.setMode("child")}
        >
          Add trackable parts
        </button>
      )}
      {DETAIL_MODES.map(([mode, label]) => (
        <button
          key={mode}
          className="button"
          disabled={disabled}
          onClick={() => screen.setMode(mode)}
        >
          {label}
        </button>
      ))}
      <button
        className="button primary"
        disabled={disabled}
        onClick={() => screen.editRequirement(undefined)}
      >
        <Plus size={18} weight="bold" aria-hidden="true" />
        Add service requirement
      </button>
    </div>
  );
}
