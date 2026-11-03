/* Record lists keep real <table> markup restyled as CSS-grid cards, so the
 * explicit table/row/cell roles below are deliberate: some browsers drop
 * table semantics when display changes on table elements. */
/* eslint-disable jsx-a11y/no-redundant-roles, jsx-a11y/no-interactive-element-to-noninteractive-role */
import { ScheduleTracking } from "./ScheduleTracking";
import { CalendarExemptionFields } from "./CalendarExemptionFields";
import { AddressFields } from "./AddressFields";
import { addressFromForm } from "../domain/addresses";
import { RequestPartsButton } from "./PartsRequests";
import { InspectionPOButton } from "./PurchaseOrders";
import { InventoryPrintButtons } from "./InventoryPrinting";
import { ScanButton } from "./InventoryScanner";
import {
  shelfLifeLabels,
  shelfLifeStatus,
  usableQuantity,
  type ShelfLife,
} from "../domain/shelfLife";
import { Link, useSearch, useNavigate } from "@tanstack/react-router";
import { ComponentForm, ServiceForm } from "./Components";
import { componentStorage } from "../domain/componentInventory";
import { validateInventoryFile } from "../domain/inventoryAttachments";
import { useWorkspace } from "../data/store";
import {
  InventoryAttachments,
  InventoryFilePicker,
} from "./InventoryAttachments";
import { maintenancePartsPlans } from "../domain/partsPlanning";
import { PartsAvailability, requiredPartsFromForm } from "./RequiredParts";
import { TaskCsvImportButton } from "./TaskCsvImport";
import {
  ManualLink,
  ManualReferenceFields,
  manualReferenceFromForm,
} from "./Manuals";
import { LinkedTaskCards } from "./TaskCards";
import { AddToWorkOrder } from "./WorkOrders";
import { programPermission } from "../domain/programs";
import { ataChapterSchema } from "../domain/ata";
import { AtaChapterField } from "./AtaChapterField";
import { useState, useEffect, useRef } from "react";
import {
  can,
  hours,
  aircraftMeterLabels,
  type Inspection,
} from "../domain/model";
import {
  inspectionCounters,
  type Component,
  type ManagedRecord,
  type Stock,
  type Location,
} from "../domain/management";
import {
  inspectionDueDate,
  inspectionStatus,
  inspectionStatusLabels,
} from "../domain/maintenance";
import { inspectionProjections } from "../domain/forecast";
import { daysPerServiceMonth } from "../domain/componentCalendar";
import { AsyncForm, Field, Modal, value } from "./ui";
import {
  EmptyState,
  IconTile,
  ListCard,
  NoticeBar,
  PageHeader,
  ProgressTrack,
  SearchField,
  StatTile,
  StatsStrip,
  StatusPill,
  Switch,
  Toolbar,
  type IconType,
  type Tone,
} from "./design";
import {
  Airplane,
  Archive,
  ArrowsDownUp,
  CalendarBlank,
  CalendarCheck,
  Check,
  ClipboardText,
  Clock,
  Drop,
  Engine,
  Hourglass,
  MapPin,
  PencilSimple,
  Plus,
  SortAscending,
  SortDescending,
  Stack,
  Warehouse,
  Warning,
  WifiSlash,
} from "@phosphor-icons/react";
import type { CSSProperties } from "react";
import { FactLabel, IconSelect } from "./MaintenanceUi";
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
export { Components } from "./Components";

type Basis = "h" | "cycles" | "landings" | "days";
const units: Record<Basis, [string, string]> = {
  h: ["h", "h"],
  cycles: ["cycle", "cycles"],
  landings: ["landing", "landings"],
  days: ["day", "days"],
};
/** "8.8 h remaining", "3 landings overdue", "due today". */
function remainingLabel(value: number, basis: Basis) {
  if (value === 0) return basis === "days" ? "Due today" : "Due now";
  const amount = Math.abs(value);
  const [one, many] = units[basis];
  const text =
    basis === "h"
      ? `${hours(amount * 3600)} h`
      : `${amount} ${amount === 1 ? one : many}`;
  return `${text} ${value < 0 ? "overdue" : "remaining"}`;
}
/** Share of the current interval already used (0–1), when it is knowable. */
function usedShare(remaining?: number, span?: number) {
  if (remaining === undefined || !span || span <= 0) return undefined;
  return Math.min(1, Math.max(0, 1 - remaining / span));
}
const daysBetween = (from: string, to: string) =>
  (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000;
function inspectionLook(
  status: ReturnType<typeof inspectionStatus>["status"],
  archived?: boolean,
): { label: string; tone: Tone; tile: Tone; icon: IconType } {
  if (archived)
    return {
      label: "Archived",
      tone: "neutral",
      tile: "neutral",
      icon: Archive,
    };
  const label = inspectionStatusLabels[status];
  if (status === "overdue")
    return { label, tone: "danger", tile: "danger", icon: Warning };
  if (status === "due-soon")
    return { label, tone: "warn", tile: "warn", icon: Clock };
  if (status === "scheduled")
    return {
      label,
      tone: "neutral",
      tile: "neutral",
      icon: CalendarCheck,
    };
  return {
    label,
    tone: "neutral",
    tile: "neutral",
    icon: CalendarBlank,
  };
}

export function Inspections() {
  const { s, writable, execute } = useManagement();
  const [requestInspectionUuid, setRequestInspectionUuid] = useState("");
  const [filter, setFilter] = useState(""),
    [selected, setSelected] = useState<Inspection | "new" | null>(null),
    [complete, setComplete] = useState(false),
    [showArchived, setShowArchived] = useState(false),
    [sortBy, setSortBy] = useState("phase"),
    [sortDescending, setSortDescending] = useState(false);
  const editable = s.aircraft.filter((a) => can(s, a.uuid, "maintenance"));
  const projected = inspectionProjections(s);
  const record = selected && selected !== "new" ? selected : undefined;
  const phaseCompare = (a: Inspection, b: Inspection) => {
    const phase = (i: Inspection) =>
      i.reference.match(/\bphase\s+([\da-z]+)/i)?.[1] ?? i.reference;
    return (
      phase(a).localeCompare(phase(b), undefined, {
        numeric: true,
        sensitivity: "base",
      }) || a.reference.localeCompare(b.reference, undefined, { numeric: true })
    );
  };
  const list = s.inspections
    .filter(
      (i) =>
        (!filter || i.aircraftUuid === filter) && (showArchived || !i.archived),
    )
    .sort((a, b) => {
      const direction = sortDescending ? -1 : 1;
      if (sortBy === "phase") return direction * phaseCompare(a, b);
      const dueValue = (i: Inspection) =>
        sortBy === "date"
          ? inspectionDueDate(i) || undefined
          : sortBy === "hours"
            ? i.dueSeconds
            : sortBy === "landings"
              ? i.dueLandings
              : i.dueCycles;
      const av = dueValue(a),
        bv = dueValue(b);
      // Missing deadlines stay last in either direction. Never compare unlike units.
      if (av === undefined) return bv === undefined ? phaseCompare(a, b) : 1;
      if (bv === undefined) return -1;
      return direction * (av < bv ? -1 : av > bv ? 1 : 0) || phaseCompare(a, b);
    });
  return (
    <>
      <PageHeader
        eyebrow="MAINTENANCE"
        title="Inspections"
        description="Recurring schedules, compliance records, and required materials."
        actions={
          <>
            <TaskCsvImportButton initialKind="inspection" />
            <Link to="/inspection-templates" className="button">
              <ClipboardText size={18} aria-hidden="true" />
              Templates
            </Link>
            <button
              className="button primary"
              disabled={!writable || !editable.length}
              onClick={() => {
                setSelected("new");
                setComplete(false);
              }}
            >
              <Plus size={18} weight="bold" aria-hidden="true" />
              New inspection
            </button>
          </>
        }
      />
      <Toolbar
        className="mx-filters"
        end={
          <Switch
            label="Show archived"
            checked={showArchived}
            onChange={setShowArchived}
          />
        }
      >
        <IconSelect
          icon={Airplane}
          label="Aircraft"
          value={filter}
          onChange={setFilter}
        >
          <option value="">All aircraft</option>
          {s.aircraft.map((a) => (
            <option key={a.uuid} value={a.uuid}>
              {a.registration}
            </option>
          ))}
        </IconSelect>
        <IconSelect
          icon={ArrowsDownUp}
          label="Sort inspections by"
          value={sortBy}
          onChange={setSortBy}
        >
          <option value="phase">Phase</option>
          <option value="date">Next due date</option>
          <option value="hours">Next due hours</option>
          <option value="cycles">Next due cycles</option>
          <option value="landings">Next due landings</option>
        </IconSelect>
        <IconSelect
          icon={sortDescending ? SortDescending : SortAscending}
          label="Sort order"
          value={sortDescending ? "descending" : "ascending"}
          onChange={(v) => setSortDescending(v === "descending")}
        >
          <option value="ascending">Ascending</option>
          <option value="descending">Descending</option>
        </IconSelect>
      </Toolbar>
      {!writable && (
        <NoticeBar tone="neutral" icon={WifiSlash}>
          Cached schedules are available. Reconnect to make changes.
        </NoticeBar>
      )}
      {list.length ? (
        <table className="mx-insp-table" role="table" aria-label="Inspections">
          <thead className="sr-only" role="rowgroup">
            <tr role="row">
              <th role="columnheader" scope="col">
                Inspection
              </th>
              <th role="columnheader" scope="col">
                Next due
              </th>
              <th role="columnheader" scope="col">
                Status and actions
              </th>
              <th role="columnheader" scope="col">
                Parts and work
              </th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {list.map((i, index) => {
              const a = s.aircraft.find((a) => a.uuid === i.aircraftUuid)!;
              const counters = inspectionCounters(i, a, s.management);
              const status = inspectionStatus(i, a, undefined, counters);
              const look = inspectionLook(status.status, i.archived);
              const dueDate = inspectionDueDate(i);
              const lines: {
                key: string;
                due: string;
                basis?: string;
                remaining?: number;
                unit?: Basis;
                used?: number;
              }[] = [];
              if (i.dueSeconds !== undefined)
                lines.push({
                  key: "hours",
                  due: `Due ${hours(i.dueSeconds)} h`,
                  basis: i.componentUuid
                    ? "Component TSN"
                    : i.usageMeter === "collective"
                      ? "Collective hourmeter"
                      : aircraftMeterLabels[a.meter],
                  remaining: status.hoursRemaining,
                  unit: "h",
                  used: usedShare(
                    status.hoursRemaining,
                    (i.intervalSeconds ??
                      (i.lastSeconds !== undefined
                        ? i.dueSeconds - i.lastSeconds
                        : 0)) / 3600,
                  ),
                });
              if (i.dueLandings !== undefined)
                lines.push({
                  key: "landings",
                  due: `Due ${i.dueLandings} landings`,
                  remaining: status.landingsRemaining,
                  unit: "landings",
                  used: usedShare(
                    status.landingsRemaining,
                    i.intervalLandings ??
                      (i.lastLandings !== undefined
                        ? i.dueLandings - i.lastLandings
                        : 0),
                  ),
                });
              if (i.dueCycles !== undefined)
                lines.push({
                  key: "cycles",
                  due: `Due ${i.dueCycles} cycles`,
                  remaining: status.cyclesRemaining,
                  unit: "cycles",
                  used: usedShare(
                    status.cyclesRemaining,
                    i.intervalCycles ??
                      (i.lastCycles !== undefined
                        ? i.dueCycles - i.lastCycles
                        : 0),
                  ),
                });
              if (i.calendarExempt)
                lines.push({ key: "calendar", due: "Calendar exempt" });
              else if (dueDate)
                lines.push({
                  key: "calendar",
                  due: `Due ${dueDate}`,
                  remaining: status.daysRemaining,
                  unit: "days",
                  used: usedShare(
                    status.daysRemaining,
                    i.lastDate
                      ? daysBetween(i.lastDate, dueDate)
                      : (i.intervalMonths ?? 0) * daysPerServiceMonth,
                  ),
                });
              const shares = lines
                .map((l) => l.used)
                .filter((n): n is number => n !== undefined);
              const progress =
                status.status === "overdue"
                  ? 1
                  : shares.length
                    ? Math.max(...shares)
                    : undefined;
              // The basis that drives the status: the most-used interval, or
              // the first one past due when no interval is known.
              const lead =
                lines.find(
                  (l) => l.remaining !== undefined && l.remaining <= 0,
                ) ??
                (shares.length
                  ? lines.find((l) => l.used === Math.max(...shares))
                  : lines.find((l) => l.remaining !== undefined));
              const leadTone =
                i.archived || status.status === "scheduled"
                  ? "neutral"
                  : look.tone;
              return (
                <tr
                  role="row"
                  key={i.uuid}
                  className="mx-insp-row"
                  style={{ "--i": Math.min(index, 8) } as CSSProperties}
                >
                  <td role="cell" className="mx-insp-main">
                    <IconTile icon={look.icon} tone={look.tile} />
                    <span className="mx-insp-text">
                      <strong className="mx-insp-title">
                        {i.reference || i.description}
                      </strong>
                      <span className="mx-insp-sub">
                        {a.registration}
                        {i.reference ? ` · ${i.description}` : ""}
                      </span>
                      {i.usageMeter === "collective" && (
                        <span className="mx-insp-note">Collective time</span>
                      )}
                      {i.materials && (
                        <span className="mx-insp-note">{i.materials}</span>
                      )}
                      <span className="mx-insp-note">
                        <ManualLink reference={i.manualReference} />
                      </span>
                    </span>
                  </td>
                  <td role="cell" className="mx-insp-due">
                    {lines.map((l) => (
                      <span className="mx-due-line" key={l.key}>
                        <span className="mx-due-what">
                          {l.due}
                          {l.basis && (
                            <>
                              {" "}
                              <span className="mx-due-basis">{l.basis}</span>
                            </>
                          )}
                        </span>
                        {l.remaining !== undefined && l.unit && (
                          <strong
                            className={
                              "mx-due-left" +
                              (l === lead ? " lead mx-tone-" + leadTone : "")
                            }
                          >
                            {remainingLabel(l.remaining, l.unit)}
                          </strong>
                        )}
                      </span>
                    ))}
                    {!lines.length && (
                      <span className="mx-due-what">No due limit recorded</span>
                    )}
                    {progress !== undefined && !i.archived && (
                      <ProgressTrack
                        value={progress}
                        tone={look.tone === "neutral" ? "blue" : look.tone}
                        className="mx-insp-progress"
                      />
                    )}
                    {projected.has(i.uuid) && (
                      <span className="mx-insp-note">
                        Projected ~{projected.get(i.uuid)}
                      </span>
                    )}
                  </td>
                  <td role="cell" className="mx-insp-actions">
                    <StatusPill tone={look.tone} dot={false}>
                      {look.label}
                    </StatusPill>
                    <button
                      className="button small"
                      onClick={() => {
                        setSelected(i);
                        setComplete(false);
                      }}
                    >
                      Details
                    </button>
                    {!i.archived && can(s, a.uuid, "maintenance") && (
                      <button
                        className="button soft small"
                        disabled={!writable}
                        onClick={() => {
                          setSelected(i);
                          setComplete(true);
                        }}
                      >
                        <Check size={16} weight="bold" aria-hidden="true" />
                        Complete
                      </button>
                    )}
                  </td>
                  <td role="cell" className="mx-insp-tools">
                    <PartsAvailability
                      parts={i.requiredParts}
                      source={{
                        kind: "inspection",
                        uuid: i.uuid,
                        workOrderUuid: "",
                      }}
                    />
                    <InspectionPOButton inspection={i} />
                    <RequestPartsButton
                      source={{
                        kind: "inspection",
                        uuid: i.uuid,
                        workOrderUuid: "",
                      }}
                    />
                    <LinkedTaskCards
                      aircraftUuid={a.uuid}
                      link={{ kind: "inspection", uuid: i.uuid }}
                    />
                    {!i.archived && (
                      <AddToWorkOrder
                        aircraftUuid={a.uuid}
                        source={{ kind: "inspection", uuid: i.uuid }}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <EmptyState title="No inspection schedules">
          Create a schedule after an aircraft is configured.
        </EmptyState>
      )}
      {requestInspectionUuid && (
        <RequestPartsButton
          key={requestInspectionUuid}
          initialOpen
          label="Add parts / repair request"
          source={{
            kind: "inspection",
            uuid: requestInspectionUuid,
            workOrderUuid: "",
          }}
          onClose={() => setRequestInspectionUuid("")}
        />
      )}
      {selected && (
        <Modal
          title={
            complete
              ? "Record inspection completion"
              : record
                ? "Inspection details"
                : "New inspection"
          }
          onClose={() => setSelected(null)}
        >
          <AsyncForm
            disabled={
              !writable ||
              !(record
                ? can(s, record.aircraftUuid, "maintenance")
                : editable.length)
            }
            submitLabel={complete ? "Record completion" : "Save inspection"}
            onSubmit={async (d) => {
              const inspectionUuid = record?.uuid ?? crypto.randomUUID();
              const common = {
                requestUuid: crypto.randomUUID(),
                reason: complete
                  ? value(d, "reason")
                  : record
                    ? "Inspection details updated."
                    : "Inspection created.",
              };
              if (complete && record)
                await execute({
                  ...common,
                  action: "inspection.complete",
                  uuid: record.uuid,
                  version: record.version ?? 0,
                  date: value(d, "date"),
                  seconds: secs(d, "seconds")!,
                  cycles: num(d, "cycles")!,
                  landings: num(d, "landings"),
                });
              else
                await execute({
                  ...common,
                  action: "inspection.save",
                  record: {
                    sourceKey: record?.sourceKey,
                    usageMeter: record
                      ? record.usageMeter
                      : (value(d, "usageMeter") as Inspection["usageMeter"]),
                    uuid: inspectionUuid,
                    version: record?.version ?? 0,
                    aircraftUuid: record?.aircraftUuid ?? value(d, "aircraft"),
                    componentUuid:
                      record?.componentUuid ??
                      (value(d, "component") || undefined),
                    ataChapter: ataChapterSchema
                      .optional()
                      .parse(value(d, "ataChapter") || undefined),
                    manualReference: manualReferenceFromForm(d),
                    reference: value(d, "reference"),
                    description: value(d, "description"),
                    materials: record?.materials ?? "",
                    requiredParts: requiredPartsFromForm(d),
                    archived: d.get("archived") === "on",
                    intervalSeconds: secs(d, "intervalSeconds"),
                    intervalCycles: num(d, "intervalCycles"),
                    intervalLandings: num(d, "intervalLandings"),
                    intervalMonths: num(d, "intervalMonths"),
                    calendarExempt: d.get("calendarExempt") === "on",
                    calendarExemptReason: value(d, "calendarExemptReason"),
                    lastSeconds: secs(d, "lastSeconds"),
                    lastCycles: num(d, "lastCycles"),
                    lastLandings: num(d, "lastLandings"),
                    lastDate: value(d, "lastDate") || undefined,
                    dueSeconds: secs(d, "dueSeconds"),
                    dueCycles: num(d, "dueCycles"),
                    dueLandings: num(d, "dueLandings"),
                    dueDate: value(d, "dueDate") || undefined,
                  },
                });
              if (!complete && value(d, "inspectionIntent") === "request")
                setRequestInspectionUuid(inspectionUuid);
              setSelected(null);
            }}
          >
            {complete && record ? (
              <>
                <p>
                  Record the tracked aircraft or component total time, cycles,
                  and aircraft total landings when the work was completed.
                  Recurring due limits are recalculated; one-time schedules are
                  archived.
                </p>
                <Field label="Completion date">
                  <input
                    name="date"
                    type="date"
                    defaultValue={today()}
                    max={today()}
                    required
                  />
                </Field>
                <NumberField
                  name="seconds"
                  label="Tracked total at completion (hours)"
                  decimal
                  required
                  initial={
                    inspectionCounters(
                      record,
                      s.aircraft.find((a) => a.uuid === record.aircraftUuid)!,
                      s.management,
                    ).seconds / 3600
                  }
                />
                <NumberField
                  name="cycles"
                  label="Tracked cycles at completion"
                  required
                  initial={
                    inspectionCounters(
                      record,
                      s.aircraft.find((a) => a.uuid === record.aircraftUuid)!,
                      s.management,
                    ).cycles
                  }
                />
                {(record.intervalLandings ||
                  record.dueLandings !== undefined) && (
                  <NumberField
                    name="landings"
                    label="Aircraft total landings at completion"
                    initial={
                      s.aircraft.find((a) => a.uuid === record.aircraftUuid)!
                        .landings
                    }
                    required
                  />
                )}
              </>
            ) : (
              <>
                <Field label="Aircraft">
                  <select
                    name="aircraft"
                    defaultValue={record?.aircraftUuid}
                    disabled={!!record}
                  >
                    {(record ? s.aircraft : editable).map((a) => (
                      <option key={a.uuid} value={a.uuid}>
                        {a.registration}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Aircraft inspection time source (component inspections use the component source)">
                  <select
                    name="usageMeter"
                    defaultValue={record?.usageMeter ?? "aircraft"}
                    disabled={!!record}
                  >
                    <option value="aircraft">Aircraft total time</option>
                    <option value="collective">
                      Helicopter collective hourmeter
                    </option>
                  </select>
                </Field>
                <Field label="Track usage on">
                  <select
                    name="component"
                    defaultValue={record?.componentUuid ?? ""}
                    disabled={!!record}
                  >
                    <option value="">Aircraft</option>
                    {(s.management ?? [])
                      .filter((r): r is Component => r.kind === "component")
                      .map((c) => (
                        <option key={c.uuid} value={c.uuid}>
                          {
                            s.aircraft.find((a) => a.uuid === c.aircraftUuid)
                              ?.registration
                          }{" "}
                          · {c.partNumber} / {c.serial}
                        </option>
                      ))}
                  </select>
                </Field>
                <AtaChapterField initial={record?.ataChapter} />
                <ManualReferenceFields initial={record?.manualReference} />
                <Field label="Reference" hint="Optional">
                  <input
                    name="reference"
                    defaultValue={record?.reference}
                    maxLength={2000}
                  />
                </Field>
                <Field label="Description">
                  <textarea
                    name="description"
                    defaultValue={record?.description}
                    required
                  />
                </Field>
                <ScheduleTracking
                  key={record?.uuid ?? "new"}
                  initial={{
                    hours: record
                      ? record.intervalSeconds !== undefined ||
                        record.dueSeconds !== undefined
                      : false,
                    cycles: record
                      ? record.intervalCycles !== undefined ||
                        record.dueCycles !== undefined
                      : false,
                    calendar: record
                      ? record.intervalMonths !== undefined ||
                        record.dueDate !== undefined
                      : false,
                    landings: record
                      ? record.intervalLandings !== undefined ||
                        record.dueLandings !== undefined
                      : false,
                  }}
                >
                  {{
                    hours: (
                      <>
                        <NumberField
                          name="intervalSeconds"
                          label="Repeat every (hours)"
                          decimal
                          initial={
                            record?.intervalSeconds === undefined
                              ? undefined
                              : record.intervalSeconds / 3600
                          }
                        />
                        <NumberField
                          name="lastSeconds"
                          label="Last complied at (tracked hours)"
                          decimal
                          initial={
                            record?.lastSeconds === undefined
                              ? undefined
                              : record.lastSeconds / 3600
                          }
                        />
                        <NumberField
                          name="dueSeconds"
                          label="One-time due (tracked hours)"
                          decimal
                          initial={
                            record?.intervalSeconds
                              ? undefined
                              : record?.dueSeconds === undefined
                                ? undefined
                                : record.dueSeconds / 3600
                          }
                        />
                      </>
                    ),
                    cycles: (
                      <>
                        <NumberField
                          name="intervalCycles"
                          label="Repeat every (cycles)"
                          initial={record?.intervalCycles}
                        />
                        <NumberField
                          name="lastCycles"
                          label="Last complied at (cycles)"
                          initial={record?.lastCycles}
                        />
                        <NumberField
                          name="dueCycles"
                          label="One-time due (cycles)"
                          initial={
                            record?.intervalCycles
                              ? undefined
                              : record?.dueCycles
                          }
                        />
                      </>
                    ),
                    calendar: (
                      <>
                        <NumberField
                          name="intervalMonths"
                          label="Repeat every (months)"
                          initial={record?.intervalMonths}
                        />
                        <Field label="Last compliance date">
                          <input
                            name="lastDate"
                            type="date"
                            max={today()}
                            defaultValue={record?.lastDate}
                          />
                        </Field>
                        <Field label="One-time due date">
                          <input
                            name="dueDate"
                            type="date"
                            defaultValue={
                              record?.intervalMonths
                                ? undefined
                                : record?.dueDate
                            }
                          />
                        </Field>
                        <p>
                          Calendar intervals expire at the end of the due month.
                        </p>
                      </>
                    ),
                    landings: (
                      <>
                        <p>Uses the aircraft total landings counter.</p>
                        <NumberField
                          name="intervalLandings"
                          label="Repeat every (landings)"
                          initial={record?.intervalLandings}
                        />
                        <NumberField
                          name="lastLandings"
                          label="Last complied at (aircraft total landings)"
                          initial={record?.lastLandings}
                        />
                        <NumberField
                          name="dueLandings"
                          label="One-time due (aircraft total landings)"
                          initial={
                            record?.intervalLandings
                              ? undefined
                              : record?.dueLandings
                          }
                        />
                      </>
                    ),
                  }}
                </ScheduleTracking>
                <p className="muted">
                  For a one-time limit, leave its repeat interval blank and
                  enter the due value.
                </p>
                <CalendarExemptionFields
                  record={record ?? undefined}
                  members={s.members}
                />
                <section aria-label="Parts requests">
                  <h3>Parts requests</h3>
                  <input
                    type="hidden"
                    name="requiredParts"
                    value={JSON.stringify(record?.requiredParts ?? [])}
                  />
                  {record ? (
                    <RequestPartsButton
                      label="Add parts / repair request"
                      source={{
                        kind: "inspection",
                        uuid: record.uuid,
                        workOrderUuid: "",
                      }}
                    />
                  ) : (
                    <>
                      <button
                        type="submit"
                        className="button"
                        name="inspectionIntent"
                        value="request"
                      >
                        Add parts / repair request
                      </button>
                      <p className="muted">
                        Saves this inspection, then opens its parts / repair
                        requests.
                      </p>
                    </>
                  )}
                  <PartsAvailability
                    parts={record?.requiredParts}
                    source={
                      record
                        ? {
                            kind: "inspection",
                            uuid: record.uuid,
                            workOrderUuid: "",
                          }
                        : undefined
                    }
                  />
                </section>
                <label>
                  <input
                    name="archived"
                    type="checkbox"
                    defaultChecked={record?.archived}
                  />{" "}
                  Archived
                </label>
              </>
            )}
            {complete && <Reason />}
          </AsyncForm>
          {record && <History uuid={record.uuid} />}
        </Modal>
      )}
    </>
  );
}
export function Inventory() {
  const backend = useWorkspace((state) => state.backend);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploadIssue, setUploadIssue] = useState("");
  const [newCategory, setNewCategory] = useState("part");
  const { s, writable, execute } = useManagement();
  const [selected, setSelected] = useState<
      ManagedRecord | "stock" | "location" | null
    >(null),
    [move, setMove] = useState(false),
    [search, setSearch] = useState(""),
    [shelfLife, setShelfLife] = useState<"" | ShelfLife>("");
  const records = s.management ?? [];
  const day = today();
  const shelfLifeMatches = (expirationDate?: string) =>
    !shelfLife ||
    shelfLifeStatus(expirationDate, day) === shelfLife ||
    (shelfLife === "soon" &&
      shelfLifeStatus(expirationDate, day) === "expired");
  const stock = records.filter((r): r is Stock => r.kind === "stock");
  const storedComponents = records.filter(
    (r): r is Component => r.kind === "component" && !r.installed,
  );
  const locations = records.filter((r): r is Location => r.kind === "location");
  const record =
    typeof selected === "object" && selected ? selected : undefined;
  const kind = record?.kind ?? selected;
  const linked = useSearch({ from: "/inventory" });
  const navigate = useNavigate({ from: "/inventory" });
  const openedLink = useRef("");
  const linkedRecord = records.find(
    (r) =>
      r.uuid === linked.item && (r.kind === "stock" || r.kind === "component"),
  );
  useEffect(() => {
    if (!linked.item) {
      openedLink.current = "";
      return;
    }
    if (
      !linkedRecord ||
      openedLink.current === linked.item ||
      !programPermission(s, "admin")
    )
      return;
    openedLink.current = linked.item;
    setSelected(linkedRecord);
    setMove(false);
    setPendingFiles([]);
    setUploadIssue("");
  }, [linked.item, linkedRecord, s]);

  if (!programPermission(s, "admin"))
    return (
      <EmptyState title="Administrator access required">
        Inventory belongs to the active Flight Program.
      </EmptyState>
    );
  const query = search.toLowerCase();
  const locationName = (uuid: string) =>
    locations.find((l) => l.uuid === uuid)?.name;
  const stockRows = stock
    .filter((r) => shelfLifeMatches(r.expirationDate))
    .filter((r) =>
      `${r.partNumber} ${r.alternates} ${r.description} ${r.vendor ?? ""} ${r.invoiceNumber ?? ""} ${r.poRef ?? ""} ${locationName(r.locationUuid)}`
        .toLowerCase()
        .includes(query),
    );
  const componentRows = storedComponents
    .filter((c) => shelfLifeMatches(c.expirationDate))
    .filter((c) =>
      `${c.partNumber} ${c.serial} ${c.componentType} ${componentStorage(s, c)} trackable aircraft component`
        .toLowerCase()
        .includes(query),
    );
  const ordered = (uuid: string) =>
    (s.partsOnOrder ?? []).filter((x) => x.stockUuid === uuid);
  const plans = maintenancePartsPlans(s);
  const costed = stock.filter((r) => r.cost !== undefined);
  const recordedValue = costed.reduce(
    (n, r) => n + (r.cost ?? 0) * r.quantity,
    0,
  );
  const openRecord = (r: Stock | Component, moving: boolean) => {
    if (!moving) {
      setPendingFiles([]);
      setUploadIssue("");
    }
    setSelected(r);
    setMove(moving);
  };
  return (
    <>
      <PageHeader
        eyebrow="INVENTORY"
        title="Inventory"
        description="Parts, consumables, storage locations, and an audited stock ledger."
        actions={
          <>
            <ScanButton />
            <RequestPartsButton
              source={{ kind: "stock", uuid: "", workOrderUuid: "" }}
              label="Request parts"
            />
            <button
              className="button"
              disabled={!writable}
              onClick={() => {
                setSelected("location");
                setMove(false);
              }}
            >
              <MapPin size={18} aria-hidden="true" />
              New location
            </button>
            <button
              className="button primary"
              disabled={!writable || !locations.length}
              onClick={() => {
                setPendingFiles([]);
                setUploadIssue("");
                setNewCategory("part");
                setSelected("stock");
                setMove(false);
              }}
            >
              <Plus size={18} weight="bold" aria-hidden="true" />
              New stock item
            </button>
          </>
        }
      />
      {linked.item && !linkedRecord && (
        <NoticeBar tone="warn" icon={Warning} role="status">
          <p>
            This inventory item is not available in the active Flight Program.
            Select its Flight Program or check your access.
          </p>
          {linked.program &&
            linked.program !== s.activeProgramUuid &&
            s.programs?.some((p) => p.uuid === linked.program) && (
              <button
                className="button small mx-notice-action"
                disabled={!writable}
                onClick={async () => {
                  try {
                    await backend!.selectProgram(linked.program!);
                  } catch (error) {
                    useWorkspace.setState({
                      error:
                        error instanceof Error
                          ? error.message
                          : "Unable to switch Flight Program.",
                    });
                  }
                }}
              >
                Open item’s Flight Program
              </button>
            )}
        </NoticeBar>
      )}
      <StatsStrip className="mx-stats">
        <StatTile label="Stock items" value={stock.length} />
        <StatTile
          label="At or below reorder"
          value={stock.filter((r) => r.quantity <= r.minimum).length}
        />
        <StatTile
          label="Expired or expiring"
          value={
            [...stock, ...storedComponents].filter((r) =>
              shelfLifeStatus(r.expirationDate, day),
            ).length
          }
        />
        <StatTile
          label="Recorded stock value"
          value={
            costed.length
              ? recordedValue.toLocaleString("en-US", {
                  style: "currency",
                  currency: "USD",
                })
              : "—"
          }
        />
      </StatsStrip>
      <Toolbar className="mx-filters">
        <SearchField
          className="mx-search"
          label="Search inventory"
          placeholder="Part, serial number, description, location, vendor, invoice, or PO"
          value={search}
          onChange={setSearch}
        />
        <IconSelect
          icon={Hourglass}
          label="Shelf life"
          value={shelfLife}
          onChange={(v) => setShelfLife(v as "" | ShelfLife)}
        >
          <option value="">All items</option>
          <option value="soon">Expired or expiring within 30 days</option>
          <option value="expired">Expired</option>
        </IconSelect>
      </Toolbar>
      {stockRows.length || componentRows.length ? (
        <ListCard className="mx-records-card">
          <table
            className="mx-records mx-inv-table"
            role="table"
            aria-label="Inventory items"
          >
            <thead className="sr-only" role="rowgroup">
              <tr role="row">
                {[
                  "Part / supply / component",
                  "Location",
                  "Condition",
                  "Qty",
                  "Vendor",
                  "Invoice #",
                  "PO Ref",
                  "Cost",
                  "Actions",
                ].map((h) => (
                  <th role="columnheader" scope="col" key={h}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody role="rowgroup">
              {stockRows.map((r) => {
                const reorder = r.quantity <= r.minimum;
                const orders = ordered(r.uuid);
                return (
                  <tr role="row" className="mx-inv-row" key={r.uuid}>
                    <td role="cell" className="mx-cell-main">
                      <IconTile
                        icon={r.oil ? Drop : Stack}
                        tone={reorder ? "warn" : "good"}
                      />
                      <span className="mx-main-text">
                        <strong className="mx-main-title">
                          {r.partNumber}
                        </strong>
                        <span className="mx-main-sub">{r.description}</span>
                        <span className="mx-main-note mx-capitalize">
                          {r.category} · Alternates: {r.alternates || "—"}
                        </span>
                      </span>
                    </td>
                    <td role="cell" className="mx-fact">
                      <FactLabel>Location</FactLabel>
                      <span className="mx-fact-value">
                        {locationName(r.locationUuid)}
                      </span>
                    </td>
                    <td role="cell" className="mx-fact">
                      <FactLabel>Condition</FactLabel>
                      <span className="mx-fact-value mx-capitalize">
                        {r.condition}
                      </span>
                      <span className="mx-fact-note">
                        Exp. date:{"\u00a0"}
                        <span className="mx-nowrap">
                          {r.expirationDate || "—"}
                        </span>{" "}
                        <ShelfLifeBadge date={r.expirationDate} today={day} />
                      </span>
                      <span className="mx-fact-note">
                        Reserved{"\u00a0"}
                        {r.reservedQuantity ?? 0} · Available{"\u00a0"}
                        {usableQuantity(r)}
                      </span>
                    </td>
                    <td role="cell" className="mx-cell-qty">
                      <FactLabel>Qty</FactLabel>
                      <span className="mx-qty">
                        <strong>{r.quantity}</strong>
                        <StatusPill
                          tone={reorder ? "warn" : "good"}
                          dot={false}
                        >
                          {reorder ? "Reorder" : "In stock"}
                        </StatusPill>
                      </span>
                      <span className="mx-fact-note">Minimum {r.minimum}</span>
                      <span className="mx-fact-note">
                        On order {orders.reduce((n, x) => n + x.quantity, 0)} ·
                        Shipped {orders.reduce((n, x) => n + x.shipped, 0)}
                      </span>
                      {plans
                        .filter((p) =>
                          p.parts.some(
                            (part) =>
                              part.stockUuid === r.uuid ||
                              part.partNumber === r.partNumber,
                          ),
                        )
                        .map((p) => (
                          <span className="mx-fact-note" key={p.uuid}>
                            {p.label}: needs{" "}
                            {
                              p.parts.find(
                                (part) =>
                                  part.stockUuid === r.uuid ||
                                  part.partNumber === r.partNumber,
                              )!.quantity
                            }
                            {p.upcoming ? " · Due / open" : " · Scheduled"}
                          </span>
                        ))}
                    </td>
                    <td role="cell" className="mx-fact">
                      <FactLabel>Vendor</FactLabel>
                      <span className="mx-fact-value">{r.vendor || "—"}</span>
                    </td>
                    <td role="cell" className="mx-fact">
                      <FactLabel>Invoice #</FactLabel>
                      <span className="mx-fact-value">
                        {r.invoiceNumber || "—"}
                      </span>
                    </td>
                    <td role="cell" className="mx-fact">
                      <FactLabel>PO Ref</FactLabel>
                      <span className="mx-fact-value">{r.poRef || "—"}</span>
                    </td>
                    <td role="cell" className="mx-fact">
                      <FactLabel>Cost</FactLabel>
                      <span className="mx-fact-value mx-num">
                        {r.cost === undefined ? "—" : r.cost.toFixed(2)}
                      </span>
                    </td>
                    <td role="cell" className="mx-cell-actions">
                      <button
                        className="button small"
                        onClick={() => openRecord(r, false)}
                      >
                        Details
                      </button>
                      <InventoryPrintButtons item={r} />
                      <button
                        className="button small"
                        disabled={!writable}
                        onClick={() => openRecord(r, true)}
                      >
                        Move stock
                      </button>
                      <RequestPartsButton
                        source={{
                          kind: "stock",
                          uuid: r.uuid,
                          workOrderUuid: "",
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
              {componentRows.map((c) => (
                <tr role="row" className="mx-inv-row" key={c.uuid}>
                  <td role="cell" className="mx-cell-main">
                    <IconTile
                      icon={Engine}
                      tone={c.outForRepair ? "warn" : "blue"}
                    />
                    <span className="mx-main-text">
                      <strong className="mx-main-title">
                        {c.partNumber || c.componentType}
                      </strong>
                      <span className="mx-main-sub">{c.componentType}</span>
                      <span className="mx-main-note">
                        Trackable Aircraft Component · Serial{" "}
                        {c.serial || "Not recorded"}
                      </span>
                    </span>
                  </td>
                  <td role="cell" className="mx-fact">
                    <FactLabel>Location</FactLabel>
                    <span className="mx-fact-value">
                      {componentStorage(s, c)}
                    </span>
                  </td>
                  <td role="cell" className="mx-fact">
                    <FactLabel>Condition</FactLabel>
                    <span className="mx-fact-value">
                      {c.outForRepair ? "Out for repair" : "In storage"}
                    </span>
                    <span className="mx-fact-note">
                      Exp. date:{"\u00a0"}
                      <span className="mx-nowrap">
                        {c.expirationDate || "—"}
                      </span>{" "}
                      <ShelfLifeBadge date={c.expirationDate} today={day} />
                    </span>
                  </td>
                  <td role="cell" className="mx-cell-qty">
                    <FactLabel>Qty</FactLabel>
                    <span className="mx-qty">
                      <strong>1</strong>
                    </span>
                    <span className="mx-fact-note">Tracked individually</span>
                  </td>
                  {(["Vendor", "Invoice #", "PO Ref", "Cost"] as const).map(
                    (label) => (
                      <td role="cell" className="mx-fact" key={label}>
                        <FactLabel>{label}</FactLabel>
                        <span className="mx-fact-value">—</span>
                      </td>
                    ),
                  )}
                  <td role="cell" className="mx-cell-actions">
                    <button
                      className="button small"
                      onClick={() => openRecord(c, false)}
                    >
                      Details
                    </button>
                    <InventoryPrintButtons item={c} />
                    {can(s, c.aircraftUuid, "maintenance") ||
                    (!c.aircraftUuid && programPermission(s, "maintenance")) ? (
                      <button
                        className="button small"
                        disabled={!writable}
                        onClick={() => openRecord(c, true)}
                      >
                        Install / service
                      </button>
                    ) : null}
                    <RequestPartsButton
                      source={{
                        kind: "component",
                        uuid: c.uuid,
                        workOrderUuid: "",
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ListCard>
      ) : stock.length || storedComponents.length ? (
        <EmptyState title="No matching items">
          Try another search or shelf-life filter.
        </EmptyState>
      ) : (
        <EmptyState title="No stock items">
          Create a location, add a part or supply, then receive stock.
        </EmptyState>
      )}
      <section className="mx-locations" aria-labelledby="mx-locations-title">
        <h2 className="mx-section-title" id="mx-locations-title">
          Storage locations
        </h2>
        {locations.length ? (
          <div className="mx-location-grid">
            {locations.map((l) => (
              <article className="mx-location-card" key={l.uuid}>
                <IconTile icon={Warehouse} tone="blue" size="md" />
                <div className="mx-location-text">
                  <h3>{l.name}</h3>
                  {l.address && (
                    <p className="mx-location-address">{l.address}</p>
                  )}
                  {!l.addressDetails && l.contact && <p>{l.contact}</p>}
                </div>
                <button
                  className="button small"
                  onClick={() => {
                    setSelected(l);
                    setMove(false);
                  }}
                >
                  <PencilSimple size={16} aria-hidden="true" />
                  Edit location
                </button>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState title="No storage locations">
            Add a location before receiving stock.
          </EmptyState>
        )}
      </section>
      {selected && (
        <Modal
          title={
            move
              ? "Stock movement"
              : kind === "location"
                ? "Storage location"
                : "Stock item"
          }
          onClose={() => {
            setSelected(null);
            if (linked.item)
              void navigate({
                to: "/inventory",
                search: { item: undefined, program: undefined },
                replace: true,
              });
          }}
        >
          <p>
            Flight Program:{" "}
            {s.programs?.find((p) => p.uuid === s.activeProgramUuid)?.name ??
              "Unassigned"}
          </p>
          {record &&
            (record.kind === "stock" || record.kind === "component") &&
            !move && <InventoryPrintButtons item={record} />}
          {!record && kind === "stock" && (
            <Field label="Category">
              <select
                disabled={!writable}
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
              >
                <option value="part">Part</option>
                <option value="supply">Supply / consumable</option>
                <option value="component">Trackable Aircraft Component</option>
              </select>
            </Field>
          )}
          {record?.kind === "component" ? (
            move ? (
              <ServiceForm c={record} onDone={() => setSelected(null)} />
            ) : (
              <ComponentForm record={record} onDone={() => setSelected(null)} />
            )
          ) : !record && kind === "stock" && newCategory === "component" ? (
            <ComponentForm
              inventoryOnly
              review={
                <>
                  <p>
                    Each component is tracked individually by serial number,
                    hours, cycles and maintenance history.
                  </p>
                </>
              }
              onDone={() => setSelected(null)}
            />
          ) : (
            <AsyncForm
              disabled={!writable}
              onSubmit={async (d) => {
                const common = {
                  requestUuid: crypto.randomUUID(),
                  reason: move
                    ? `Stock movement recorded: ${value(d, "operation")}.`
                    : kind === "location"
                      ? record
                        ? "Storage location updated."
                        : "Storage location created."
                      : record
                        ? "Stock item updated."
                        : "Stock item created.",
                };
                if (move && record)
                  await execute({
                    ...common,
                    action: "stock.move",
                    uuid: record.uuid,
                    version: record.version,
                    operation: value(d, "operation") as
                      "receive" | "issue" | "adjust",
                    quantity: num(d, "quantity")!,
                  });
                else if (kind === "location")
                  await execute({
                    ...common,
                    action: "record.save",
                    record: {
                      kind: "location",
                      uuid: record?.uuid ?? crypto.randomUUID(),
                      version: record?.version ?? 0,
                      name: value(d, "name"),
                      addressDetails: addressFromForm(d),
                      address:
                        record?.kind === "location" ? record.address : "",
                      contact:
                        record?.kind === "location" ? record.contact : "",
                    },
                  });
                else {
                  if (!record)
                    for (const file of pendingFiles)
                      validateInventoryFile(file.name, file.type, file.size);
                  const stockRecord: Stock = {
                    kind: "stock",
                    uuid: record?.uuid ?? crypto.randomUUID(),
                    version: record?.version ?? 0,
                    partNumber: value(d, "partNumber"),
                    description: value(d, "description"),
                    alternates: value(d, "alternates"),
                    category: value(d, "category") as Stock["category"],
                    oil: d.get("oil") === "on" || undefined,
                    condition: value(d, "condition") as Stock["condition"],
                    locationUuid:
                      record?.kind === "stock"
                        ? record.locationUuid
                        : value(d, "location"),
                    quantity: num(d, "quantity") ?? 0,
                    minimum: num(d, "minimum") ?? 0,
                    vendor: value(d, "vendor") || undefined,
                    invoiceNumber: value(d, "invoiceNumber") || undefined,
                    poRef: value(d, "poRef") || undefined,
                    cost: num(d, "cost"),
                    expirationDate: value(d, "expirationDate") || undefined,
                  };
                  await execute({
                    ...common,
                    action: "record.save",
                    record: stockRecord,
                  });
                  if (!record) {
                    for (let index = 0; index < pendingFiles.length; index++) {
                      try {
                        await backend!.attachInventoryFile(
                          stockRecord.uuid,
                          pendingFiles[index],
                        );
                      } catch {
                        setPendingFiles(pendingFiles.slice(index));
                        setSelected({
                          ...stockRecord,
                          version: stockRecord.version + 1,
                        });
                        setUploadIssue(
                          "The stock item was saved. Some attachments could not be uploaded. Retry the remaining files below.",
                        );
                        return;
                      }
                    }
                    setPendingFiles([]);
                  }
                }
                setSelected(null);
              }}
            >
              {move && record?.kind === "stock" ? (
                <>
                  <p>
                    {record.partNumber} · Current stock:{" "}
                    <strong>{record.quantity}</strong>
                  </p>
                  <Field label="Movement type">
                    <select name="operation">
                      <option value="receive">Receive stock</option>
                      <option value="issue">Issue stock</option>
                      <option value="adjust">Set counted balance</option>
                    </select>
                  </Field>
                  <NumberField
                    name="quantity"
                    label="Quantity (counted balance for adjustment)"
                    required
                  />
                </>
              ) : kind === "location" ? (
                <>
                  <Field label="Location name">
                    <input
                      name="name"
                      defaultValue={
                        record?.kind === "location" ? record.name : ""
                      }
                      required
                    />
                  </Field>
                  <AddressFields
                    label="Location address"
                    name="addressDetails"
                    value={
                      record?.kind === "location"
                        ? record.addressDetails
                        : undefined
                    }
                    legacy={record?.kind === "location" ? record.address : ""}
                    contactName={
                      record?.kind === "location" ? record.contact : ""
                    }
                  />
                </>
              ) : (
                <>
                  {(["partNumber", "description", "alternates"] as const).map(
                    (k, i) => (
                      <Field
                        key={k}
                        label={
                          [
                            "Part number",
                            "Description",
                            "Alternate part numbers",
                          ][i]
                        }
                      >
                        <input
                          name={k}
                          defaultValue={
                            record?.kind === "stock" ? record[k] : undefined
                          }
                          required={k !== "alternates"}
                        />
                      </Field>
                    ),
                  )}
                  {record ? (
                    <Field label="Category">
                      <select
                        name="category"
                        defaultValue={
                          record?.kind === "stock" ? record.category : "part"
                        }
                      >
                        <option value="part">Part</option>
                        <option value="supply">Supply / consumable</option>
                      </select>
                    </Field>
                  ) : (
                    <input type="hidden" name="category" value={newCategory} />
                  )}
                  <label>
                    <input
                      type="checkbox"
                      name="oil"
                      defaultChecked={record?.kind === "stock" && !!record.oil}
                    />{" "}
                    Engine oil (flight users can draw it down when logging oil
                    added)
                  </label>
                  <Field label="Condition">
                    <select
                      name="condition"
                      defaultValue={
                        record?.kind === "stock" ? record.condition : "new"
                      }
                    >
                      {["new", "overhauled", "as removed", "core"].map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Location">
                    <select
                      name="location"
                      disabled={!!record}
                      defaultValue={
                        record?.kind === "stock"
                          ? record.locationUuid
                          : undefined
                      }
                    >
                      {locations.map((l) => (
                        <option key={l.uuid} value={l.uuid}>
                          {l.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <NumberField
                    name="quantity"
                    label="Qty"
                    initial={record?.kind === "stock" ? record.quantity : 0}
                    required
                  />
                  <Field
                    label="Expiration date"
                    hint="Optional; leave blank if not applicable."
                  >
                    <input
                      type="date"
                      name="expirationDate"
                      defaultValue={
                        record?.kind === "stock"
                          ? record.expirationDate
                          : undefined
                      }
                    />
                  </Field>
                  <NumberField
                    name="minimum"
                    label="Reorder at or below"
                    initial={record?.kind === "stock" ? record.minimum : 0}
                  />
                  <div className="form-grid">
                    {(
                      [
                        ["vendor", "Vendor", 200],
                        ["invoiceNumber", "Invoice #", 100],
                        ["poRef", "PO Ref", 100],
                      ] as const
                    ).map(([name, label, maxLength]) => (
                      <Field key={name} label={label}>
                        <input
                          name={name}
                          maxLength={maxLength}
                          defaultValue={
                            record?.kind === "stock" ? record[name] : undefined
                          }
                        />
                      </Field>
                    ))}
                    <Field label="Cost">
                      <input
                        name="cost"
                        type="number"
                        min="0"
                        step="0.01"
                        defaultValue={
                          record?.kind === "stock" ? record.cost : undefined
                        }
                      />
                    </Field>
                  </div>
                  {!record && (
                    <section aria-label="New stock attachments">
                      <h3>Attachments</h3>
                      <p>
                        Choose images and PDFs to upload when you save this
                        item. Up to 7 MB per file.
                      </p>
                      <InventoryFilePicker
                        files={pendingFiles}
                        onChange={setPendingFiles}
                      />
                    </section>
                  )}
                  <p className="muted">
                    Qty is the current counted balance. Use Move stock to record
                    receipts or issues. Quantity changes are saved in history.
                  </p>
                </>
              )}
            </AsyncForm>
          )}
          {(kind === "stock" || kind === "component") && !move && record && (
            <>
              {uploadIssue && <p role="alert">{uploadIssue}</p>}
              <InventoryAttachments
                key={record.uuid}
                stockUuid={record.uuid}
                initialFiles={pendingFiles}
                onUploaded={() => {
                  setPendingFiles([]);
                  setUploadIssue("");
                }}
              />
            </>
          )}
          {record && <History uuid={record.uuid} />}
        </Modal>
      )}
    </>
  );
}
function ShelfLifeBadge({ date, today }: { date?: string; today: string }) {
  const status = shelfLifeStatus(date, today);
  return status ? (
    <StatusPill tone={status === "expired" ? "danger" : "warn"} dot={false}>
      {shelfLifeLabels[status]}
    </StatusPill>
  ) : null;
}
