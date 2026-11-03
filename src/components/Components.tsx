/* Component record lists keep real <table> markup restyled as CSS-grid cards,
 * so the explicit table/row/cell roles are deliberate: some browsers drop
 * table semantics when display changes on table elements. */
/* eslint-disable jsx-a11y/no-redundant-roles, jsx-a11y/no-interactive-element-to-noninteractive-role */
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
import { componentStorage } from "../domain/componentInventory";
import { partsInventory } from "../domain/requiredParts";
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
  type Snapshot,
} from "../domain/model";
import { ataChapterSchema, ataLabel } from "../domain/ata";
import {
  componentTotals,
  saveRequirement,
  tracking,
  requirementStatus,
  requirementDueDate,
  POSITIONS,
  type Component,
  type ComponentRequirement,
  type ComponentMovement,
} from "../domain/components";
import { AtaChapterField } from "./AtaChapterField";
import { AsyncForm, Field, Modal, value } from "./ui";
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
const displayHours = (n: number | null | undefined) =>
  n == null ? "Unknown" : hours(n) + " h";
const componentIcon = (type: string): IconType =>
  type === "Engine"
    ? Engine
    : /propeller|rotor/i.test(type)
      ? Fan
      : type === "Appliance"
        ? GearSix
        : Cube;
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
function BaselineFields({
  c,
  time,
  cycles,
  calendar,
  installed,
  aircraftSeconds,
  aircraftCycles,
  verifiedEntry = false,
}: {
  c?: Component;
  time: boolean;
  cycles: boolean;
  calendar: boolean;
  installed: boolean;
  aircraftSeconds?: number;
  aircraftCycles?: number;
  verifiedEntry?: boolean;
}) {
  return (
    <>
      <p className="muted">
        Enter verified readings at installation, or stored readings for an
        inventory component. Blank TSO and TSR mean unknown / not applicable.
      </p>
      <div className="form-grid">
        {installed && (
          <Field label="Installation date">
            <input
              type="date"
              name="installedDate"
              defaultValue={c?.installedDate ?? (verifiedEntry ? "" : today())}
              max={today()}
              required
            />
          </Field>
        )}
        {installed && time && (
          <NumberField
            name="installedSeconds"
            label="Aircraft total time at install (hours)"
            decimal
            initial={
              c
                ? c.installedSeconds / 3600
                : aircraftSeconds === undefined
                  ? undefined
                  : aircraftSeconds / 3600
            }
            required
          />
        )}
        {installed && cycles && (
          <NumberField
            name="installedCycles"
            label="Aircraft cycles at install"
            initial={c?.installedCycles ?? aircraftCycles}
            required
          />
        )}
        {time && (
          <>
            <NumberField
              name="timeSinceNew"
              label="Time Since New (TSN) at install (hours)"
              decimal
              initial={
                c ? c.timeSinceNew / 3600 : verifiedEntry ? undefined : 0
              }
              required
            />
            <NumberField
              name="timeSinceOverhaul"
              label="Time Since Overhaul (TSO) at install (hours)"
              decimal
              initial={
                c?.timeSinceOverhaul == null
                  ? undefined
                  : c.timeSinceOverhaul / 3600
              }
            />
            <NumberField
              name="timeSinceRepair"
              label="Time Since Repair (TSR) at install (hours)"
              decimal
              initial={
                c?.timeSinceRepair == null
                  ? undefined
                  : c.timeSinceRepair / 3600
              }
            />
          </>
        )}
        {cycles && (
          <NumberField
            name="cyclesSinceNew"
            label="Component cycles at install"
            initial={c?.cyclesSinceNew ?? (verifiedEntry ? undefined : 0)}
            required
          />
        )}
        {calendar && (
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
        )}
      </div>
    </>
  );
}
function ComponentStorageFields({ initial }: { initial?: Component }) {
  const { s } = useManagement();
  const locations = partsInventory(s).locations;
  return (
    <>
      <Field label="Inventory location">
        <select
          name="locationUuid"
          defaultValue={initial?.locationUuid ?? ""}
          required={locations.length > 0}
        >
          <option value="">
            {locations.length
              ? "Select inventory location"
              : "No locations configured"}
          </option>
          {initial?.locationUuid &&
            !locations.some((l) => l.uuid === initial.locationUuid) && (
              <option value={initial.locationUuid}>
                Previous location unavailable
              </option>
            )}
          {locations.map((l) => (
            <option key={l.uuid} value={l.uuid}>
              {l.name}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="Parts location"
        hint="Optional shelf, bin or room within the inventory location."
      >
        <input
          name="partsLocation"
          defaultValue={initial?.partsLocation}
          maxLength={150}
          placeholder="Shelf / bin / room"
          required={!locations.length}
        />
      </Field>
    </>
  );
}
export function ComponentForm({
  initialAircraftUuid,
  parentComponent,
  record,
  defaults,
  aircraftUuids,
  review,
  inventoryOnly = false,
  onDone,
}: {
  initialAircraftUuid?: string;
  parentComponent?: Component;
  inventoryOnly?: boolean;
  record?: Component;
  defaults?: Partial<Component>;
  aircraftUuids?: string[];
  review?: ReactNode;
  onDone: (uuid: string, component: Component) => void | Promise<void>;
}) {
  const { s, writable, execute } = useManagement();
  const { backend, online, connected } = useWorkspace();
  const [files, setFiles] = useState<File[]>([]);
  const [savedComponent, setSavedComponent] = useState<Component>();
  const [uploadError, setUploadError] = useState("");
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
  const a = s.aircraft.find((a) => a.uuid === aircraftId);
  if (savedComponent)
    return (
      <>
        <p role="alert">
          The component was saved, but some attachments could not be uploaded.
          Retry the remaining files below. {uploadError}
        </p>
        <InventoryAttachments
          stockUuid={savedComponent.uuid}
          initialFiles={files}
          onUploaded={() => {
            void onDone(savedComponent.uuid, savedComponent);
          }}
        />
      </>
    );
  return (
    <AsyncForm
      disabled={!writable}
      submitLabel={record ? "Save component details" : "Save component"}
      onSubmit={async (d) => {
        for (const file of files)
          validateInventoryFile(file.name, file.type, file.size);
        if (files.length && (!backend || !online || !connected))
          throw new Error(
            "Reconnect before saving a component with attachments.",
          );
        const installed = record?.installed ?? location === "aircraft";
        const componentType = value(d, "componentType");
        const r: Component = {
          ...record,
          model: value(d, "model"),
          faaSearchModel: value(d, "faaSearchModel"),
          manualReference: record?.manualReference ?? defaults?.manualReference,
          uuid: record?.uuid ?? defaults?.uuid ?? crypto.randomUUID(),
          parentComponentUuid:
            record?.parentComponentUuid ?? parentComponent?.uuid,
          version: record?.version ?? 0,
          kind: "component",
          aircraftUuid:
            record?.aircraftUuid ??
            (installed
              ? aircraftId
              : programPermission(s, "maintenance")
                ? ""
                : aircraftId),
          componentType,
          ataChapter: ataChapterSchema
            .optional()
            .parse(value(d, "ataChapter") || undefined),
          partNumber: value(d, "partNumber"),
          serial: value(d, "serial"),
          expirationDate: value(d, "expirationDate") || undefined,
          manufacturer: value(d, "manufacturer"),
          incomingTag: Object.fromEntries(
            Object.keys(tagFieldLabels).map((k) => [
              k,
              value(d, `incomingTag_${k}`),
            ]),
          ),
          notes: value(d, "notes"),
          trackTime: track.time,
          trackCycles: track.cycles,
          trackCalendar: track.calendar,
          installed,
          installPosition: installed
            ? (parentComponent?.installPosition ??
              (value(d, "installPosition") as Component["installPosition"]))
            : undefined,
          partsLocation: installed ? undefined : value(d, "partsLocation"),
          locationUuid: installed
            ? undefined
            : value(d, "locationUuid") || undefined,
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
          cyclesSinceNew:
            record?.cyclesSinceNew ?? num(d, "cyclesSinceNew") ?? 0,
          serviceDaysBase: record
            ? record.serviceDaysBase
            : track.calendar && value(d, "serviceMonthsBase")
              ? serviceDaysFromMonths(value(d, "serviceMonthsBase"))
              : 0,
          calendarSinceNewUnknown: record
            ? record.calendarSinceNewUnknown
            : !value(d, "serviceMonthsBase"),
          calendarOverhaulDaysBase: record
            ? record.calendarOverhaulDaysBase
            : track.calendar && value(d, "calendarOverhaulMonths")
              ? serviceDaysFromMonths(value(d, "calendarOverhaulMonths"))
              : null,
          calendarOverhaulDate: record?.calendarOverhaulDate,
        };
        await execute({
          action: "record.save",
          record: r,
          requestUuid: crypto.randomUUID(),
          initialAircraftSetup: !record && !!initialAircraftUuid,
          reason: record
            ? "Component details updated."
            : initialAircraftUuid
              ? "Initial aircraft setup: existing installed component recorded."
              : "Component created.",
        });
        const saved = { ...r, version: r.version + 1 };
        for (let index = 0; index < files.length; index++) {
          try {
            await backend!.attachInventoryFile(r.uuid, files[index]);
          } catch (error) {
            setFiles(files.slice(index));
            setUploadError(
              error instanceof Error ? error.message : "Upload failed.",
            );
            setSavedComponent(saved);
            return;
          }
        }
        await onDone(r.uuid, saved);
      }}
    >
      {review}
      <div className="form-grid">
        <Field label="Component type">
          <select
            name="componentType"
            defaultValue={
              record?.componentType ?? defaults?.componentType ?? ""
            }
            required
          >
            <option value="">Select component type</option>
            {[
              "Appliance",
              "Engine",
              "Propeller",
              "Main Rotor",
              "Tail Rotor",
            ].map((type) => (
              <option key={type}>{type}</option>
            ))}
            {(record?.componentType ?? defaults?.componentType) &&
              ![
                "Appliance",
                "Engine",
                "Propeller",
                "Main Rotor",
                "Tail Rotor",
              ].includes(
                record?.componentType ?? defaults?.componentType ?? "",
              ) && (
                <option
                  value={record?.componentType ?? defaults?.componentType}
                >
                  {record?.componentType ?? defaults?.componentType} (existing
                  type)
                </option>
              )}
          </select>
        </Field>
        <AtaChapterField initial={record?.ataChapter ?? defaults?.ataChapter} />
        <Field label="Part number">
          <input
            name="partNumber"
            defaultValue={record?.partNumber ?? defaults?.partNumber}
            required={inventoryOnly}
            maxLength={100}
          />
        </Field>
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
            maxLength={100}
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
      </div>
      <h3>Track by</h3>
      <div className="management-actions">
        {(["calendar", "time", "cycles"] as const).map((k) => (
          <label className="checkbox" key={k}>
            <input
              type="checkbox"
              checked={track[k]}
              onChange={(e) => setTrack({ ...track, [k]: e.target.checked })}
            />
            {k === "calendar" ? "Calendar" : k === "time" ? "Time" : "Cycles"}
          </label>
        ))}
      </div>
      {!record && initialAircraftUuid && (
        <label>
          <input type="checkbox" required /> This component is already installed
          on this aircraft. I am recording its verified opening baseline for
          initial setup.
        </label>
      )}
      {!record && !initialAircraftUuid && (
        <p>
          New components are received into inventory. Use Install / service to
          add an installation to a work order.
        </p>
      )}
      {!record &&
        (location === "aircraft" || !programPermission(s, "maintenance")) && (
          <Field
            label={
              location === "aircraft" ? "Aircraft" : "Aircraft access group"
            }
          >
            <select
              value={aircraftId}
              disabled={!!initialAircraftUuid}
              onChange={(e) => setAircraftId(e.target.value)}
              required
            >
              {editable.map((a) => (
                <option key={a.uuid} value={a.uuid}>
                  {a.registration}
                </option>
              ))}
            </select>
          </Field>
        )}
      {location === "aircraft" ? (
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
      {!record && (
        <>
          <h3>Installation / opening baseline</h3>
          <BaselineFields
            key={aircraftId}
            time={track.time}
            cycles={track.cycles}
            calendar={track.calendar}
            installed={location === "aircraft"}
            verifiedEntry={!!defaults}
            aircraftSeconds={!defaults && a ? totalSeconds(a) : undefined}
            aircraftCycles={!defaults ? a?.cycles : undefined}
          />
        </>
      )}
      {record && (
        <p className="muted">
          Use Move for aircraft/inventory changes and Set baseline for verified
          installation readings.
        </p>
      )}
      {!record && programPermission(s, "admin") && (
        <section aria-label="8130 / supporting attachments">
          <h3>8130 / supporting attachments</h3>
          <p>
            Choose an 8130 certificate or supporting documents to upload when
            you save the component. PDF, JPEG, PNG or WebP, up to 7 MB per file.
          </p>
          <InventoryFilePicker files={files} onChange={setFiles} />
        </section>
      )}
      <details>
        <summary>Incoming component tag / 8130 details</summary>
        <p>
          For components received into inventory, enter the known source
          aircraft and removal details. The 8130 document can be attached when
          creating the component or added to its attachments later. Document
          contents are not copied automatically.
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
              maxLength={2000}
            />
          </Field>
        ))}
      </details>
      <Field label="Notes">
        <textarea
          name="notes"
          defaultValue={record?.notes ?? defaults?.notes}
          maxLength={10000}
        />
      </Field>
    </AsyncForm>
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
        await execute({
          action: "component.baseline",
          uuid: c.uuid,
          version: c.version,
          requestUuid: crypto.randomUUID(),
          reason: "Component baseline updated.",
          installedDate: c.installed
            ? value(d, "installedDate")
            : c.installedDate,
          installedSeconds:
            c.installed && track.time
              ? secs(d, "installedSeconds")!
              : c.installedSeconds,
          installedCycles:
            c.installed && track.cycles
              ? num(d, "installedCycles")!
              : c.installedCycles,
          timeSinceNew: track.time ? secs(d, "timeSinceNew")! : c.timeSinceNew,
          timeSinceOverhaul: track.time
            ? (secs(d, "timeSinceOverhaul") ?? null)
            : c.timeSinceOverhaul,
          timeSinceRepair: track.time
            ? (secs(d, "timeSinceRepair") ?? null)
            : c.timeSinceRepair,
          cyclesSinceNew: track.cycles
            ? num(d, "cyclesSinceNew")!
            : c.cyclesSinceNew,
          serviceDaysBase: track.calendar
            ? value(d, "serviceMonthsBase")
              ? serviceDaysFromMonths(value(d, "serviceMonthsBase"))
              : 0
            : c.serviceDaysBase,
          calendarSinceNewUnknown: track.calendar
            ? !value(d, "serviceMonthsBase")
            : c.calendarSinceNewUnknown,
          calendarOverhaulDaysBase: track.calendar
            ? value(d, "calendarOverhaulMonths")
              ? serviceDaysFromMonths(value(d, "calendarOverhaulMonths"))
              : null
            : c.calendarOverhaulDaysBase,
        });
        onDone();
      }}
    >
      <BaselineFields c={c} {...track} installed={c.installed} />
    </AsyncForm>
  );
}
export function ServiceForm({
  c,
  onDone,
}: {
  c: Component;
  onDone: () => void;
}) {
  const { s, writable, execute } = useManagement();
  const [operation, setOperation] = useState<
    "install" | "remove" | "overhaul" | "repair"
  >(c.installed ? "remove" : "install");
  if (operation === "install" || operation === "remove")
    return (
      <>
        {!c.installed && (
          <Field label="Service action">
            <select
              value={operation}
              onChange={(e) => setOperation(e.target.value as typeof operation)}
            >
              <option value="install">Install through work order</option>
              <option value="overhaul">Record overhaul</option>
              <option value="repair">Record repair</option>
            </select>
          </Field>
        )}
        <PlanComponentMovement c={c} onDone={onDone} />
      </>
    );
  return (
    <AsyncForm
      disabled={!writable}
      submitLabel="Save service event"
      onSubmit={async (d) => {
        await execute({
          action: "component.service",
          uuid: c.uuid,
          version: c.version,
          requestUuid: crypto.randomUUID(),
          reason: value(d, "reason"),
          operation,
          date: today(),
        });
        onDone();
      }}
    >
      <p>
        Record workshop service for this stored component. Installation and
        removal must be recorded through a work order.
      </p>
      <Field label="Service action">
        <select
          value={operation}
          onChange={(e) => setOperation(e.target.value as typeof operation)}
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
      <Field label="Movement / service date">
        <input type="date" value={today()} readOnly />
      </Field>
      <Reason />
    </AsyncForm>
  );
}
export function RequirementForm({
  c,
  record: existing,
  defaults,
  review,
  onDone,
}: {
  c: Component;
  record?: ComponentRequirement;
  defaults?: Partial<ComponentRequirement>;
  review?: ReactNode;
  onDone: () => void;
}) {
  const record = existing ?? defaults;
  const { s, writable, execute } = useManagement(),
    available = { ...tracking(c), landings: c.installed };
  const [track, setTrack] = useState(() => ({
    time: available.time && (record ? !!record.intervalSeconds : true),
    calendar:
      available.calendar && (record ? !!record.calendarIntervalValue : true),
    cycles: available.cycles && (record ? !!record.intervalCycles : true),
    landings: !!record?.intervalLandings,
  }));
  const [preview, setPreview] = useState(
    "Enter the limits and verified compliance history to preview due values.",
  );
  const buildRecord = (d: FormData): ComponentRequirement => ({
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
    lastDate: value(d, "lastDate") || undefined,
    lastSeconds: value(d, "lastSeconds").startsWith("-")
      ? -parseHours(value(d, "lastSeconds").slice(1))!
      : secs(d, "lastSeconds"),
    timeResetSeconds: track.time ? record?.timeResetSeconds : undefined,
    lastCycles: num(d, "lastCycles"),
    lastLandings: num(d, "lastLandings"),
    intervalLandings: num(d, "intervalLandings"),
    landingLimitMode: (value(d, "landingLimitMode") ||
      "FROM_LAST_COMPLIED") as ComponentRequirement["landingLimitMode"],
    landingReferenceAircraftUuid: track.landings ? c.aircraftUuid : undefined,
    warningLandings: num(d, "warningLandings") ?? 10,
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
  });
  return (
    <AsyncForm
      disabled={!writable}
      submitLabel="Calculate and save"
      onChange={(d) => {
        try {
          const r = saveRequirement(s, buildRecord(d), Date.now());
          setPreview(
            `Next due: ${[
              r.dueSeconds === undefined
                ? ""
                : `${r.dueSeconds / 3600} ${r.timeBasis} hours`,
              r.dueCycles === undefined ? "" : `${r.dueCycles} cycles`,
              r.dueLandings === undefined
                ? ""
                : `${r.dueLandings} aircraft landings`,
              r.dueDate ?? "",
            ]
              .filter(Boolean)
              .join(" or ")} (first reached).`,
          );
        } catch {
          setPreview(
            "Complete the limits and verified compliance history to calculate due values.",
          );
        }
      }}
      onSubmit={async (d) => {
        const r = buildRecord(d);
        await execute({
          action: "record.save",
          record: r,
          requestUuid: crypto.randomUUID(),
          reason: existing
            ? "Service requirement updated."
            : "Service requirement added.",
        });
        onDone();
      }}
    >
      {review}
      <RequiredPartsFields
        initial={record?.requiredParts}
        source={
          record?.uuid
            ? {
                kind: "componentRequirement",
                uuid: record.uuid,
                workOrderUuid: "",
              }
            : undefined
        }
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
          maxLength={255}
          required
        />
      </Field>
      <ManualReferenceFields initial={record?.manualReference} />
      <h3>Track by</h3>
      <div className="management-actions">
        {(["time", "calendar", "cycles", "landings"] as const).map((key) => (
          <label className="checkbox" key={key}>
            <input
              type="checkbox"
              checked={track[key]}
              disabled={!available[key]}
              onChange={(event) =>
                setTrack({ ...track, [key]: event.target.checked })
              }
            />
            {key === "time"
              ? "Hours"
              : key === "landings"
                ? "Landings"
                : key === "calendar"
                  ? "Calendar"
                  : "Cycles"}
          </label>
        ))}
      </div>
      {Object.values(available).some((enabled) => !enabled) && (
        <p className="muted">
          Enable tracking on the component to use a disabled option.
        </p>
      )}
      {available.time && (
        <fieldset disabled={!track.time} hidden={!track.time}>
          <h3>Component time</h3>
          <div className="form-grid">
            <Field label="Time basis">
              <select
                name="timeBasis"
                defaultValue={record?.timeBasis ?? "TSN"}
              >
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
            <NumberField
              name="intervalSeconds"
              label="Hour limit / interval"
              decimal
              initial={
                record?.intervalSeconds === undefined
                  ? undefined
                  : record.intervalSeconds / 3600
              }
            />
            <Field
              label="Last complied component hours"
              hint={
                record?.lastSeconds !== undefined && record.lastSeconds < 0
                  ? "Previous compliance predates the repair/overhaul counter reset; its rebased reading preserves the remaining interval."
                  : undefined
              }
            >
              <input
                name="lastSeconds"
                type="number"
                step="0.1"
                defaultValue={
                  record?.lastSeconds === undefined
                    ? ""
                    : record.lastSeconds / 3600
                }
              />
            </Field>
            <NumberField
              name="warningSeconds"
              label="Due soon: component hours"
              decimal
              initial={(record?.warningSeconds ?? 90000) / 3600}
              required
            />
          </div>
        </fieldset>
      )}
      {available.cycles && (
        <fieldset disabled={!track.cycles} hidden={!track.cycles}>
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
              initial={record?.warningCycles ?? 10}
              required
            />
          </div>
        </fieldset>
      )}
      <fieldset disabled={!track.landings} hidden={!track.landings}>
        <legend>Aircraft landings</legend>
        <p>
          Uses the installed aircraft’s total landing count. Review this
          baseline when moving the component to another aircraft.
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
            initial={record?.warningLandings ?? 10}
          />
        </div>
      </fieldset>
      {available.calendar && (
        <fieldset disabled={!track.calendar} hidden={!track.calendar}>
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
            <Field label="Calendar unit">
              <select
                name="calendarIntervalUnit"
                defaultValue={record?.calendarIntervalUnit ?? "MONTHS"}
              >
                {["DAYS", "MONTHS", "YEARS"].map((u) => (
                  <option key={u}>{u}</option>
                ))}
              </select>
            </Field>
            <NumberField
              name="warningCalendarMonths"
              label="Due soon: calendar months"
              initial={record?.warningCalendarMonths ?? 1}
              required
            />
          </div>
          <p className="muted">
            Month and year intervals fall due on the last day of the target
            month. Day intervals use exact dates.
          </p>
        </fieldset>
      )}
      <Field label="Service notes">
        <textarea name="notes" defaultValue={record?.notes} maxLength={10000} />
      </Field>
      {defaults && <p role="status">{preview}</p>}
      {existing && <History uuid={existing.uuid} />}
    </AsyncForm>
  );
}
function Requirements({
  s,
  c,
  edit,
}: {
  s: Snapshot;
  c: Component;
  edit?: (r: ComponentRequirement) => void;
}) {
  const rows = (s.management ?? []).filter(
    (r): r is ComponentRequirement =>
      r.kind === "componentRequirement" && r.componentUuid === c.uuid,
  );
  const a = s.aircraft.find((a) => a.uuid === c.aircraftUuid);
  return (
    <section className="mx-dialog-section">
      <h3>Service requirements</h3>
      {rows.length ? (
        <div className="table-wrap mx-table-card">
          <table className="mx-table">
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
            <tbody>
              {rows.map((r) => {
                const remaining = requirementStatus(r, c, a);
                return (
                  <tr key={r.uuid}>
                    <td>
                      <span className="mx-table-kicker">
                        {r.requirementType}
                      </span>
                      <strong className="mx-table-title">
                        {r.description}
                      </strong>
                      <span className="mx-table-note">
                        <ManualLink reference={r.manualReference} />
                      </span>
                      <PartsAvailability
                        parts={r.requiredParts}
                        source={{
                          kind: "componentRequirement",
                          uuid: r.uuid,
                          workOrderUuid: "",
                        }}
                      />
                    </td>
                    <td className="mx-num">{requirementDueDate(r) ?? "—"}</td>
                    <td className="mx-num">
                      {r.dueSeconds === undefined
                        ? "—"
                        : `${hours(r.dueSeconds)} ${r.timeBasis}`}
                    </td>
                    <td className="mx-num">
                      {r.dueCycles !== undefined && (
                        <div>{r.dueCycles} cycles</div>
                      )}
                      {r.dueLandings !== undefined && (
                        <div>{r.dueLandings} landings</div>
                      )}
                      {r.dueCycles === undefined &&
                        r.dueLandings === undefined &&
                        "—"}
                    </td>
                    <td className="mx-num">
                      {remaining.seconds !== undefined && (
                        <div>{hours(remaining.seconds)} h</div>
                      )}
                      {remaining.cycles !== undefined && (
                        <div>{remaining.cycles} cycles</div>
                      )}
                      {remaining.landings !== undefined && (
                        <div>{remaining.landings} landings</div>
                      )}
                      {remaining.days !== undefined && (
                        <div>
                          ≈ {(remaining.days / daysPerServiceMonth).toFixed(1)}{" "}
                          months
                        </div>
                      )}
                    </td>
                    <td>
                      <StatusPill
                        tone={
                          // "Due now" is a reached usage limit and grounds
                          // the aircraft, like "Past due".
                          remaining.status === "Past due" ||
                          remaining.status === "Due now"
                            ? "danger"
                            : remaining.status === "Tracked"
                              ? "good"
                              : "warn"
                        }
                      >
                        {remaining.status}
                      </StatusPill>
                    </td>
                    <td>
                      <span className="mx-table-actions">
                        <RequestPartsButton
                          source={{
                            kind: "componentRequirement",
                            uuid: r.uuid,
                            workOrderUuid: "",
                          }}
                        />
                        {c.installed && (
                          <LinkedTaskCards
                            aircraftUuid={c.aircraftUuid}
                            link={{
                              kind: "componentRequirement",
                              uuid: r.uuid,
                            }}
                          />
                        )}
                        {c.installed && (
                          <AddToWorkOrder
                            aircraftUuid={c.aircraftUuid}
                            source={{
                              kind: "componentRequirement",
                              uuid: r.uuid,
                            }}
                          />
                        )}
                        {edit && (
                          <button
                            className="button small"
                            onClick={() => edit(r)}
                          >
                            <PencilSimple size={16} aria-hidden="true" />
                            Edit requirement
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mx-dialog-empty">
          No separate service requirements recorded.
        </p>
      )}
    </section>
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
                <tr key={r.uuid}>
                  <td>
                    <span className="mx-table-kicker mx-num">{r.date}</span>
                    <strong className="mx-table-title">{r.action}</strong>
                    {r.supersededByCorrection && (
                      <StatusPill tone="warn">
                        Superseded by correction
                      </StatusPill>
                    )}
                    {r.correctionUuid && !r.supersededByCorrection && (
                      <span className="mx-table-note">
                        Work-order correction
                      </span>
                    )}
                  </td>
                  <td>
                    {s.aircraft.find((a) => a.uuid === r.aircraftUuid)
                      ?.registration ?? "Inventory"}
                    <span className="mx-table-note">
                      {r.partsLocation ?? r.installPosition}
                    </span>
                  </td>
                  <td className="mx-num">
                    {displayHours(r.timeSinceNew)} /{" "}
                    {displayHours(r.timeSinceOverhaul)} /{" "}
                    {displayHours(r.timeSinceRepair)}
                  </td>
                  <td className="mx-num">
                    {r.cycles} cycles
                    <span className="mx-table-note">
                      Calendar time since new:{" "}
                      {r.calendarSinceNewUnknown
                        ? "Unknown"
                        : `≈ ${(r.serviceDays / daysPerServiceMonth).toFixed(1)} months`}
                    </span>
                    {r.calendarOverhaulDays != null && (
                      <span className="mx-table-note">
                        Calendar time since overhaul: ≈{" "}
                        {(r.calendarOverhaulDays / daysPerServiceMonth).toFixed(
                          1,
                        )}{" "}
                        months
                      </span>
                    )}
                  </td>
                  <td>
                    {s.members.find((m) => m.id === r.actorId)?.name ??
                      "Recorded user"}
                    <span className="mx-table-note">{r.note}</span>
                  </td>
                </tr>
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
export function Components() {
  const { s, writable } = useManagement();
  const [selected, setSelected] = useState<Component | "new" | null>(null),
    [mode, setMode] = useState<
      "details" | "edit" | "baseline" | "service" | "requirement" | "child"
    >("details"),
    [requirement, setRequirement] = useState<
      ComponentRequirement | undefined
    >(),
    [search, setSearch] = useState(""),
    [location, setLocation] = useState("all");
  const items = (s.management ?? []).filter(
    (r): r is Component => r.kind === "component",
  );
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
  const c = selected && selected !== "new" ? selected : undefined;
  const editable = c
    ? c.aircraftUuid
      ? can(s, c.aircraftUuid, "maintenance")
      : programPermission(s, "maintenance")
    : programPermission(s, "maintenance") ||
      s.aircraft.some((a) => can(s, a.uuid, "maintenance"));
  const filtered = items.filter(
    (c) =>
      (location === "all" || (location === "aircraft") === c.installed) &&
      `${c.componentType} ${c.model ?? ""} ${c.manufacturer} ${c.partNumber} ${c.serial} ${ataLabel(c.ataChapter)} ${s.aircraft.find((a) => a.uuid === c.aircraftUuid)?.registration ?? ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const groups = new Map<string, { label: string; items: Component[] }>();
  for (const item of filtered) {
    const aircraft = item.installed
      ? s.aircraft.find((a) => a.uuid === item.aircraftUuid)
      : undefined;
    const key = item.installed ? `aircraft:${item.aircraftUuid}` : "inventory";
    const group = groups.get(key) ?? {
      label: item.installed
        ? (aircraft?.registration ?? "Unknown aircraft")
        : "Inventory",
      items: [],
    };
    group.items.push(item);
    groups.set(key, group);
  }
  const done = () => {
    setSelected(null);
    if (linked.item)
      void navigate({ to: "/components", search: {}, replace: true });
  };
  return (
    <>
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
            <button
              className="button primary"
              disabled={
                !writable ||
                !(
                  programPermission(s, "maintenance") ||
                  s.aircraft.some((a) => can(s, a.uuid, "maintenance"))
                )
              }
              onClick={() => {
                setSelected("new");
                setMode("edit");
              }}
            >
              <Plus size={18} weight="bold" aria-hidden="true" />
              New component
            </button>
          </>
        }
      />
      {linked.item && !linkedComponent && (
        <NoticeBar tone="warn" icon={Warning} role="status">
          This component is not available in the active Flight Program. Select
          its Flight Program or check your access.
        </NoticeBar>
      )}
      <Toolbar
        className="mx-filters"
        end={
          <Segmented
            label="Component location"
            value={location}
            onChange={setLocation}
            options={[
              { value: "all", label: "All locations", count: items.length },
              {
                value: "aircraft",
                label: "Installed",
                count: items.filter((c) => c.installed).length,
              },
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
          value={search}
          onChange={setSearch}
        />
      </Toolbar>
      {!writable && (
        <NoticeBar tone="neutral" icon={WifiSlash}>
          Cached components are available. Reconnect to make changes.
        </NoticeBar>
      )}
      {[...groups]
        .sort(([, a], [, b]) => a.label.localeCompare(b.label))
        .map(([key, group]) => (
          <details className="component-group mx-comp-group" key={key} open>
            <summary className="mx-group-summary">
              <IconTile
                icon={key === "inventory" ? Warehouse : AirplaneTilt}
                tone="blue"
                size="md"
              />
              <span className="mx-group-title">{group.label}</span>
              <span className="mx-group-count">
                {group.items.length} component
                {group.items.length === 1 ? "" : "s"}
              </span>
              <CaretDown
                className="mx-group-caret"
                size={18}
                aria-hidden="true"
              />
            </summary>
            <table
              className="mx-records mx-comp-table"
              role="table"
              aria-label={`${group.label} components`}
            >
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
              <tbody role="rowgroup">
                {group.items.map((c) => {
                  const a = s.aircraft.find((a) => a.uuid === c.aircraftUuid);
                  const t = componentTotals(c, a),
                    track = tracking(c);
                  const parent = items.find(
                    (p) => p.uuid === c.parentComponentUuid,
                  );
                  const statuses = (s.management ?? [])
                    .filter(
                      (r): r is ComponentRequirement =>
                        r.kind === "componentRequirement" &&
                        r.componentUuid === c.uuid,
                    )
                    .map((r) => requirementStatus(r, c, a));
                  const nearest = (key: "seconds" | "days" | "cycles") => {
                    const values = statuses
                      .map((r) => r[key])
                      .filter((n): n is number => n !== undefined);
                    return values.length ? Math.min(...values) : undefined;
                  };
                  const seconds = nearest("seconds"),
                    days = nearest("days"),
                    cycles = nearest("cycles");
                  const pastDue = statuses.some(
                    (r) => r.status === "Past due" || r.status === "Due now",
                  );
                  return (
                    <tr role="row" className="mx-comp-row" key={c.uuid}>
                      <td role="cell" className="mx-cell-main">
                        <IconTile
                          icon={componentIcon(c.componentType)}
                          tone={
                            pastDue
                              ? "danger"
                              : c.installed
                                ? "good"
                                : c.outForRepair
                                  ? "warn"
                                  : "blue"
                          }
                        />
                        <span className="mx-main-text">
                          <strong className="mx-main-title">
                            {c.model || c.componentType}
                          </strong>
                          <span className="mx-main-sub">
                            {c.componentType} · {c.manufacturer || "—"} ·{" "}
                            {ataLabel(c.ataChapter)}
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
                      <td role="cell" className="mx-fact">
                        <FactLabel>Position / location</FactLabel>
                        {c.installed && (
                          <span className="mx-fact-value">
                            {a?.registration ?? "Unknown aircraft"}
                          </span>
                        )}
                        <span
                          className={
                            c.installed ? "mx-fact-note" : "mx-fact-value"
                          }
                        >
                          {c.installed
                            ? (c.installPosition ?? "Not recorded")
                            : componentStorage(s, c)}
                        </span>
                        <StatusPill
                          className="mx-fact-pill"
                          dot={false}
                          tone={
                            c.installed
                              ? "good"
                              : c.outForRepair
                                ? "warn"
                                : "neutral"
                          }
                        >
                          {c.installed
                            ? "Installed"
                            : c.outForRepair
                              ? "Out for repair"
                              : "In storage"}
                        </StatusPill>
                      </td>
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
                          <span className="mx-fact-note">
                            {[
                              track.cycles ? `${t.cyclesSinceNew} cycles` : "",
                              track.calendar
                                ? `Calendar time since new: ${c.calendarSinceNewUnknown ? "Unknown" : `${(t.serviceDays / daysPerServiceMonth).toFixed(1)} months`}`
                                : "",
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        )}
                        {track.calendar && (
                          <span className="mx-fact-note">
                            Calendar time since overhaul:{" "}
                            {t.calendarOverhaulDays == null
                              ? "Unknown"
                              : `${(t.calendarOverhaulDays / daysPerServiceMonth).toFixed(1)} months`}
                          </span>
                        )}
                        {!track.time && !track.cycles && !track.calendar && (
                          <span className="mx-fact-value">—</span>
                        )}
                      </td>
                      <td role="cell" className="mx-fact mx-comp-remaining">
                        <FactLabel>Nearest service remaining</FactLabel>
                        {statuses.length ? (
                          <>
                            {seconds !== undefined && (
                              <div className="mx-fact-value mx-num">
                                {hours(seconds)} h
                              </div>
                            )}
                            {days !== undefined && (
                              <div className="mx-fact-value mx-num">
                                ≈ {(days / daysPerServiceMonth).toFixed(1)}{" "}
                                months
                              </div>
                            )}
                            {cycles !== undefined && (
                              <div className="mx-fact-value mx-num">
                                {cycles} cycles
                              </div>
                            )}
                            {pastDue && (
                              <StatusPill
                                className="mx-fact-pill"
                                tone="danger"
                                dot={false}
                              >
                                Past due
                              </StatusPill>
                            )}
                            {seconds === undefined &&
                              days === undefined &&
                              cycles === undefined && (
                                <span className="mx-fact-value">—</span>
                              )}
                          </>
                        ) : (
                          <span className="mx-fact-note">
                            No service requirements
                          </span>
                        )}
                      </td>
                      <td role="cell" className="mx-cell-actions">
                        <button
                          className="button small"
                          onClick={() => {
                            setSelected(c);
                            setMode("details");
                          }}
                        >
                          Details
                        </button>
                        {(c.aircraftUuid
                          ? can(s, c.aircraftUuid, "maintenance")
                          : programPermission(s, "maintenance")) && (
                          <button
                            className="button soft small"
                            disabled={!writable}
                            onClick={() => {
                              setSelected(c);
                              setMode("service");
                            }}
                          >
                            <Wrench
                              size={16}
                              weight="bold"
                              aria-hidden="true"
                            />
                            Add Service/Inspections
                          </button>
                        )}
                        <RequestPartsButton
                          source={{
                            kind: "component",
                            uuid: c.uuid,
                            workOrderUuid: "",
                          }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </details>
        ))}
      {!filtered.length && (
        <EmptyState
          title={
            items.length ? "No matching components" : "No tracked components"
          }
        >
          {items.length
            ? "Try another search or location."
            : "Add components in inventory or enter a verified aircraft installation."}
        </EmptyState>
      )}
      {selected && (
        <Modal
          key={mode}
          title={
            selected === "new"
              ? "New component"
              : mode === "child"
                ? "Add trackable parts"
                : mode === "edit"
                  ? "Edit component"
                  : mode === "baseline"
                    ? "Set installation baseline"
                    : mode === "service"
                      ? "Component service"
                      : mode === "requirement"
                        ? "Component service requirement"
                        : c!.componentType
          }
          onClose={done}
        >
          {mode === "child" && c ? (
            <ComponentForm
              parentComponent={c}
              initialAircraftUuid={c.installed ? c.aircraftUuid : undefined}
              onDone={(_uuid, child) => {
                setSelected(child);
                setRequirement(undefined);
                setMode("requirement");
              }}
            />
          ) : mode === "edit" ? (
            <ComponentForm record={c} onDone={done} />
          ) : mode === "baseline" && c ? (
            <BaselineForm c={c} onDone={done} />
          ) : mode === "service" && c ? (
            <ServiceForm c={c} onDone={done} />
          ) : mode === "requirement" && c ? (
            <RequirementForm c={c} record={requirement} onDone={done} />
          ) : (
            c && (
              <>
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
                    {c.installed
                      ? s.aircraft.find((a) => a.uuid === c.aircraftUuid)
                          ?.registration
                      : "Inventory"}{" "}
                    · {c.installed ? c.installPosition : componentStorage(s, c)}
                  </dd>
                  <dt>Installed / removed</dt>
                  <dd>
                    {c.installedDate ?? "—"} / {c.removedDate ?? "—"}
                  </dd>
                  <dt>Notes</dt>
                  <dd>{c.notes || "—"}</dd>
                </dl>
                {editable && (
                  <div className="mx-dialog-actions">
                    {c.installed && (
                      <button
                        className="button"
                        disabled={!writable}
                        onClick={() => setMode("child")}
                      >
                        Add trackable parts
                      </button>
                    )}
                    <button
                      className="button"
                      disabled={!writable}
                      onClick={() => setMode("edit")}
                    >
                      Edit component
                    </button>
                    <button
                      className="button"
                      disabled={!writable}
                      onClick={() => setMode("baseline")}
                    >
                      Set baseline
                    </button>
                    <button
                      className="button"
                      disabled={!writable}
                      onClick={() => setMode("service")}
                    >
                      Move / service
                    </button>
                    <button
                      className="button primary"
                      disabled={!writable}
                      onClick={() => {
                        setRequirement(undefined);
                        setMode("requirement");
                      }}
                    >
                      <Plus size={18} weight="bold" aria-hidden="true" />
                      Add service requirement
                    </button>
                  </div>
                )}
                {programPermission(s, "admin") && (
                  <section className="mx-dialog-section">
                    <div className="mx-dialog-actions">
                      <InventoryPrintButtons item={c} />
                    </div>
                    <InventoryAttachments stockUuid={c.uuid} />
                  </section>
                )}
                <Requirements
                  s={s}
                  c={c}
                  edit={
                    editable && writable
                      ? (r) => {
                          setRequirement(r);
                          setMode("requirement");
                        }
                      : undefined
                  }
                />
                <Movements s={s} c={c} />
                <History uuid={c.uuid} />
              </>
            )
          )}
        </Modal>
      )}
    </>
  );
}
