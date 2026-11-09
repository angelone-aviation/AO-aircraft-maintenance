/**
 * Responsibility: The inspections screen (schedules, due limits, completion)
 *   and the inventory screen (stock, stored components, storage locations,
 *   stock movements and attachments).
 * Layer: UI. React components; schedule and stock rules live in src/domain.
 * Dependencies: react, @tanstack/react-router, @phosphor-icons/react,
 *   src/data/store.ts, src/domain (model, management, maintenance, forecast,
 *   shelfLife, componentInventory, partsPlanning, ata, programs, addresses,
 *   inventoryAttachments, componentCalendar, rejection), ./ManagementShared
 *   and sibling screens' parts (Components, PartsRequests, PurchaseOrders,
 *   TaskCards, WorkOrders, Manuals, RequiredParts, Inventory*), ./ui,
 *   ./design.
 *
 * Record lists keep real <table> markup restyled as CSS-grid cards, with
 * explicit table roles because some browsers drop table semantics when display
 * changes; .oxlintrc.json turns off the two jsx-a11y rules those roles trip.
 */
import { ScheduleTracking } from "./ScheduleTracking";
import { CalendarExemptionFields } from "./CalendarExemptionFields";
import { AddressFields } from "./AddressFields";
import { addressFromForm } from "../domain/addresses";
import { RequestPartsButton } from "./PartsRequests";
import { InspectionPOButton } from "./PurchaseOrders";
import { InventoryPrintButtons } from "./InventoryPrinting";
import { ScanButton } from "./InventoryScanner";
import {
  EXPIRING_SOON_DAYS,
  matchesShelfLife,
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
import type { Backend } from "../data/backend";
import {
  InventoryAttachments,
  InventoryFilePicker,
} from "./InventoryAttachments";
import {
  maintenancePartsPlans,
  plannedNeedsFor,
} from "../domain/partsPlanning";
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
import { useState, useEffect, useRef, type ReactNode } from "react";
import {
  can,
  hours,
  aircraftMeterLabels,
  recordedTotalSeconds,
  type Aircraft,
  type Inspection,
  type Snapshot,
} from "../domain/model";
import { Rejection } from "../domain/rejection";
import {
  INSPECTION_REFERENCE_MAX_LENGTH,
  PURCHASE_REFERENCE_MAX_LENGTH,
  STOCK_VENDOR_MAX_LENGTH,
  inspectionCounters,
  inventoryCounts,
  mayMaintain,
  needsReorder,
  stockSchema,
  tracksLandings,
  type Component,
  type ManagedRecord,
  type ManagementCommand,
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
import { AsyncForm, Field, Modal, errorText, value } from "./ui";
import { useStaleSave, type StaleSaveOptions } from "./StaleSave";
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

const HOUR_SECONDS = 3600;
const DAY_MS = 86400000;
// Rows after the eighth share one entrance-animation delay.
const MAX_STAGGERED_ROWS = 8;
const UNMEASURED: ReturnType<typeof inspectionStatus> = {
  hoursRemaining: undefined,
  cyclesRemaining: undefined,
  landingsRemaining: undefined,
  daysRemaining: undefined,
  status: "unknown",
};

type Basis = "h" | "cycles" | "landings" | "days";
const units: Record<Basis, [string, string]> = {
  h: ["h", "h"],
  cycles: ["cycle", "cycles"],
  landings: ["landing", "landings"],
  days: ["day", "days"],
};

/**
 * The inspections screen: every schedule of one or all aircraft, sorted by
 * phase or by a due limit, with how much of each interval is used, and the
 * dialogs to create, edit and record completion of a schedule.
 *
 * @returns The screen. Saving and completing call `backend.manage`
 *   (`inspection.save`, `inspection.complete`), which the server audits; every
 *   change needs a connection and maintenance permission on the aircraft.
 */
export function Inspections() {
  const { s, writable, execute } = useManagement();
  const screen = useInspectionScreen();
  const editable = s.aircraft.filter((a) => can(s, a.uuid, "maintenance"));
  const list = sortedInspections(s, screen);
  const props = { s, writable, screen, editable };
  return (
    <>
      <InspectionsHeader {...props} />
      <InspectionFilters s={s} screen={screen} />
      {!writable && <CachedNotice />}
      {list.length ? (
        <InspectionTable {...props} list={list} />
      ) : (
        <EmptyState title="No inspection schedules">
          Create a schedule after an aircraft is configured.
        </EmptyState>
      )}
      {screen.requestInspectionUuid && (
        <RequestPartsButton
          key={screen.requestInspectionUuid}
          initialOpen
          label="Add parts / repair request"
          source={inspectionSource(screen.requestInspectionUuid)}
          onClose={() => screen.setRequestInspectionUuid("")}
        />
      )}
      {screen.selected && (
        <InspectionDialog
          {...props}
          selected={screen.selected}
          execute={execute}
        />
      )}
    </>
  );
}

/**
 * The inventory screen for Flight Program administrators: stock and stored
 * components with shelf life, reorder and planned needs, storage locations,
 * and the dialogs to create, move and attach files to them. A link to one
 * item (`?item=`) opens it.
 *
 * @returns The screen, or a notice for anyone else. Saving and moving call
 *   `backend.manage` (`record.save`, `stock.move`) and attachments
 *   `backend.attachInventoryFile`; every change needs a connection.
 */
export function Inventory() {
  const backend = useWorkspace((state) => state.backend);
  const files = useInventoryFiles();
  const { s, writable, execute } = useManagement();
  const view = useInventoryView();
  const link = useLinkedItem(s, view, files);
  if (!programPermission(s, "admin"))
    return (
      <EmptyState title="Administrator access required">
        Inventory belongs to the active Flight Program.
      </EmptyState>
    );
  const stock = inventoryStock(s);
  const props = { s, writable, execute, backend: backend!, files, view, link };
  return (
    <>
      <InventoryHeader {...props} stock={stock} />
      {link.linked.item && !link.linkedRecord && (
        <LinkedItemNotice {...props} />
      )}
      <InventoryStats stock={stock} />
      <InventoryFilters view={view} />
      <InventoryList {...props} stock={stock} />
      <StorageLocations locations={stock.locations} view={view} />
      {view.selected && <InventoryDialog {...props} stock={stock} />}
    </>
  );
}

function CachedNotice() {
  return (
    <NoticeBar tone="neutral" icon={WifiSlash}>
      Cached schedules are available. Reconnect to make changes.
    </NoticeBar>
  );
}

/** "8.8 h remaining", "3 landings overdue", "due today". */
function remainingLabel(value: number, basis: Basis) {
  if (value === 0) return basis === "days" ? "Due today" : "Due now";
  const amount = Math.abs(value);
  const [one, many] = units[basis];
  const text =
    basis === "h"
      ? `${hours(amount * HOUR_SECONDS)} h`
      : `${amount} ${amount === 1 ? one : many}`;
  return `${text} ${value < 0 ? "overdue" : "remaining"}`;
}

/** Share of the current interval already used (0–1), when it is knowable. */
function usedShare(remaining?: number, span?: number) {
  if (remaining === undefined || !span || span <= 0) return undefined;
  return Math.min(1, Math.max(0, 1 - remaining / span));
}

const daysBetween = (from: string, to: string) =>
  (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / DAY_MS;

type Look = { label: string; tone: Tone; tile: Tone; icon: IconType };

function inspectionLook(
  status: ReturnType<typeof inspectionStatus>["status"],
  archived?: boolean,
): Look {
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
  const icon = status === "scheduled" ? CalendarCheck : CalendarBlank;
  return { label, tone: "neutral", tile: "neutral", icon };
}

const inspectionSource = (uuid: string) => ({
  kind: "inspection" as const,
  uuid,
  workOrderUuid: "",
});

type InspectionScreen = ReturnType<typeof useInspectionScreen>;
type InspectionProps = {
  s: Snapshot;
  writable: boolean;
  screen: InspectionScreen;
  editable: Aircraft[];
};

function useInspectionScreen() {
  const [requestInspectionUuid, setRequestInspectionUuid] = useState("");
  const [filter, setFilter] = useState(""),
    [selected, setSelected] = useState<Inspection | "new" | null>(null),
    [complete, setComplete] = useState(false),
    [showArchived, setShowArchived] = useState(false),
    [sortBy, setSortBy] = useState("phase"),
    [sortDescending, setSortDescending] = useState(false);
  const open = (inspection: Inspection | "new", completing: boolean) => {
    setSelected(inspection);
    setComplete(completing);
  };
  return {
    ...{ requestInspectionUuid, setRequestInspectionUuid, filter, setFilter },
    ...{ selected, setSelected, complete, setComplete, open },
    ...{ showArchived, setShowArchived, sortBy, setSortBy },
    ...{ sortDescending, setSortDescending },
  };
}

function sortedInspections(
  s: Snapshot,
  { filter, showArchived, sortBy, sortDescending }: InspectionScreen,
) {
  const direction = sortDescending ? -1 : 1;
  return s.inspections
    .filter(
      (i) =>
        (!filter || i.aircraftUuid === filter) && (showArchived || !i.archived),
    )
    .sort((a, b) =>
      sortBy === "phase"
        ? direction * phaseCompare(a, b)
        : compareDue(a, b, sortBy, direction),
    );
}

// "Phase 2" sorts by its phase number; other references sort by themselves.
function phaseCompare(a: Inspection, b: Inspection) {
  const phase = (i: Inspection) =>
    i.reference.match(/\bphase\s+([\da-z]+)/i)?.[1] ?? i.reference;
  return (
    phase(a).localeCompare(phase(b), undefined, {
      numeric: true,
      sensitivity: "base",
    }) || a.reference.localeCompare(b.reference, undefined, { numeric: true })
  );
}

// Missing deadlines stay last in either direction. Never compare unlike units.
function compareDue(
  a: Inspection,
  b: Inspection,
  sortBy: string,
  direction: number,
) {
  const av = dueValue(a, sortBy),
    bv = dueValue(b, sortBy);
  if (av === undefined) return bv === undefined ? phaseCompare(a, b) : 1;
  if (bv === undefined) return -1;
  return direction * (av < bv ? -1 : av > bv ? 1 : 0) || phaseCompare(a, b);
}

function dueValue(i: Inspection, sortBy: string) {
  if (sortBy === "date") return inspectionDueDate(i) || undefined;
  if (sortBy === "hours") return i.dueSeconds;
  if (sortBy === "landings") return i.dueLandings;
  return i.dueCycles;
}

function InspectionsHeader({ writable, screen, editable }: InspectionProps) {
  return (
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
            onClick={() => screen.open("new", false)}
          >
            <Plus size={18} weight="bold" aria-hidden="true" />
            New inspection
          </button>
        </>
      }
    />
  );
}

function InspectionFilters({
  s,
  screen,
}: Pick<InspectionProps, "s" | "screen">) {
  return (
    <Toolbar
      className="mx-filters"
      end={
        <Switch
          label="Show archived"
          checked={screen.showArchived}
          onChange={screen.setShowArchived}
        />
      }
    >
      <IconSelect
        icon={Airplane}
        label="Aircraft"
        value={screen.filter}
        onChange={screen.setFilter}
      >
        <option value="">All aircraft</option>
        {s.aircraft.map((a) => (
          <option key={a.uuid} value={a.uuid}>
            {a.registration}
          </option>
        ))}
      </IconSelect>
      <SortSelect screen={screen} />
      <SortOrderSelect screen={screen} />
    </Toolbar>
  );
}

function SortOrderSelect({ screen }: { screen: InspectionScreen }) {
  const { sortDescending } = screen;
  return (
    <IconSelect
      icon={sortDescending ? SortDescending : SortAscending}
      label="Sort order"
      value={sortDescending ? "descending" : "ascending"}
      onChange={(v) => screen.setSortDescending(v === "descending")}
    >
      <option value="ascending">Ascending</option>
      <option value="descending">Descending</option>
    </IconSelect>
  );
}

function SortSelect({ screen }: { screen: InspectionScreen }) {
  return (
    <IconSelect
      icon={ArrowsDownUp}
      label="Sort inspections by"
      value={screen.sortBy}
      onChange={screen.setSortBy}
    >
      <option value="phase">Phase</option>
      <option value="date">Next due date</option>
      <option value="hours">Next due hours</option>
      <option value="cycles">Next due cycles</option>
      <option value="landings">Next due landings</option>
    </IconSelect>
  );
}

function InspectionTable(props: InspectionProps & { list: Inspection[] }) {
  const projected = inspectionProjections(props.s);
  return (
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
        {props.list.map((i, index) => (
          <InspectionRow
            key={i.uuid}
            {...props}
            inspection={i}
            index={index}
            projected={projected}
          />
        ))}
      </tbody>
    </table>
  );
}

type DueLine = {
  key: string;
  due: string;
  basis?: string;
  remaining?: number;
  unit?: Basis;
  used?: number;
};
type Projections = ReturnType<typeof inspectionProjections>;
type RowProps = InspectionProps & {
  inspection: Inspection;
  aircraft: Aircraft;
  look: Look;
};

function InspectionRow({
  index,
  projected,
  ...props
}: InspectionProps & {
  inspection: Inspection;
  index: number;
  projected: Projections;
}) {
  const { s, inspection: i } = props;
  const a = s.aircraft.find((a) => a.uuid === i.aircraftUuid)!;
  const counters = readCounters(i, a, s.management);
  const status = counters
    ? inspectionStatus(i, a, undefined, counters)
    : UNMEASURED;
  const look = inspectionLook(status.status, i.archived);
  const row = { ...props, aircraft: a, look };
  return (
    <tr
      role="row"
      className="mx-insp-row"
      style={{ "--i": Math.min(index, MAX_STAGGERED_ROWS) } as CSSProperties}
    >
      <InspectionMainCell inspection={i} aircraft={a} look={look} />
      <DueCell {...row} status={status} projected={projected} />
      <InspectionActionsCell {...row} />
      <InspectionToolsCell inspection={i} aircraft={a} />
    </tr>
  );
}

// An aircraft whose meter has no reading (only damaged data: the aircraft
// form requires one) has no usage to measure. Its schedules show an unknown
// status, as in the due list, and completion opens blank; the command is
// still refused.
function readCounters(
  i: Inspection,
  a: Aircraft,
  records: Snapshot["management"],
) {
  try {
    return inspectionCounters(i, a, records);
  } catch (error) {
    if (error instanceof Rejection && recordedTotalSeconds(a) === undefined)
      return undefined;
    throw error;
  }
}

function InspectionMainCell({
  inspection: i,
  aircraft: a,
  look,
}: Pick<RowProps, "inspection" | "aircraft" | "look">) {
  return (
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
        {i.materials && <span className="mx-insp-note">{i.materials}</span>}
        <span className="mx-insp-note">
          <ManualLink reference={i.manualReference} />
        </span>
      </span>
    </td>
  );
}

// An overdue schedule shows a full track; otherwise the most-used interval.
function DueCell({
  inspection: i,
  aircraft: a,
  look,
  status,
  projected,
}: RowProps & {
  status: ReturnType<typeof inspectionStatus>;
  projected: Projections;
}) {
  const lines = dueLines(i, a, status);
  const shares = usedShares(lines);
  const progress = status.status === "overdue" ? 1 : maxShare(shares);
  const lead = leadLine(lines, shares);
  const leadTone =
    i.archived || status.status === "scheduled" ? "neutral" : look.tone;
  return (
    <td role="cell" className="mx-insp-due">
      {lines.map((l) => (
        <DueLineView key={l.key} line={l} lead={l === lead} tone={leadTone} />
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
        <span className="mx-insp-note">Projected ~{projected.get(i.uuid)}</span>
      )}
    </td>
  );
}

function maxShare(shares: number[]) {
  return shares.length ? Math.max(...shares) : undefined;
}

function usedShares(lines: DueLine[]) {
  return lines.map((l) => l.used).filter((n): n is number => n !== undefined);
}

// The basis that drives the status: the first one past due, else the
// most-used interval, else the first with a known remainder.
function leadLine(lines: DueLine[], shares: number[]) {
  return (
    lines.find((l) => l.remaining !== undefined && l.remaining <= 0) ??
    (shares.length
      ? lines.find((l) => l.used === Math.max(...shares))
      : lines.find((l) => l.remaining !== undefined))
  );
}

function DueLineView({
  line: l,
  lead,
  tone,
}: {
  line: DueLine;
  lead: boolean;
  tone: Tone;
}) {
  return (
    <span className="mx-due-line">
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
          className={"mx-due-left" + (lead ? " lead mx-tone-" + tone : "")}
        >
          {remainingLabel(l.remaining, l.unit)}
        </strong>
      )}
    </span>
  );
}

// A used share needs the interval, or the span from the last compliance to a
// one-time limit; without either the line has no share.
function dueLines(
  i: Inspection,
  a: Aircraft,
  status: ReturnType<typeof inspectionStatus>,
): DueLine[] {
  const span = (interval?: number, due?: number, last?: number) =>
    interval ?? (last !== undefined ? due! - last : 0);
  const lines: DueLine[] = [];
  if (i.dueSeconds !== undefined)
    lines.push({
      key: "hours",
      due: `Due ${hours(i.dueSeconds)} h`,
      basis: hourBasis(i, a),
      remaining: status.hoursRemaining,
      unit: "h",
      used: usedShare(
        status.hoursRemaining,
        span(i.intervalSeconds, i.dueSeconds, i.lastSeconds) / HOUR_SECONDS,
      ),
    });
  if (i.dueLandings !== undefined)
    lines.push(countLine(i, "landings", status.landingsRemaining, span));
  if (i.dueCycles !== undefined)
    lines.push(countLine(i, "cycles", status.cyclesRemaining, span));
  const calendar = calendarLine(i, status);
  if (calendar) lines.push(calendar);
  return lines;
}

function hourBasis(i: Inspection, a: Aircraft) {
  if (i.componentUuid) return "Component TSN";
  if (i.usageMeter === "collective") return "Collective hourmeter";
  return aircraftMeterLabels[a.meter];
}

function countLine(
  i: Inspection,
  unit: "landings" | "cycles",
  remaining: number | undefined,
  span: (interval?: number, due?: number, last?: number) => number,
): DueLine {
  const [due, interval, last] =
    unit === "landings"
      ? [i.dueLandings!, i.intervalLandings, i.lastLandings]
      : [i.dueCycles!, i.intervalCycles, i.lastCycles];
  return {
    key: unit,
    due: `Due ${due} ${unit}`,
    remaining,
    unit,
    used: usedShare(remaining, span(interval, due, last)),
  };
}

function calendarLine(
  i: Inspection,
  status: ReturnType<typeof inspectionStatus>,
): DueLine | undefined {
  if (i.calendarExempt) return { key: "calendar", due: "Calendar exempt" };
  const dueDate = inspectionDueDate(i);
  if (!dueDate) return undefined;
  const span = i.lastDate
    ? daysBetween(i.lastDate, dueDate)
    : (i.intervalMonths ?? 0) * daysPerServiceMonth;
  return {
    key: "calendar",
    due: `Due ${dueDate}`,
    remaining: status.daysRemaining,
    unit: "days",
    used: usedShare(status.daysRemaining, span),
  };
}

function InspectionActionsCell({
  s,
  writable,
  screen,
  inspection: i,
  aircraft: a,
  look,
}: RowProps) {
  return (
    <td role="cell" className="mx-insp-actions">
      <StatusPill tone={look.tone} dot={false}>
        {look.label}
      </StatusPill>
      <button className="button small" onClick={() => screen.open(i, false)}>
        Details
      </button>
      {!i.archived && can(s, a.uuid, "maintenance") && (
        <button
          className="button soft small"
          disabled={!writable}
          onClick={() => screen.open(i, true)}
        >
          <Check size={16} weight="bold" aria-hidden="true" />
          Complete
        </button>
      )}
    </td>
  );
}

function InspectionToolsCell({
  inspection: i,
  aircraft: a,
}: Pick<RowProps, "inspection" | "aircraft">) {
  return (
    <td role="cell" className="mx-insp-tools">
      <PartsAvailability
        parts={i.requiredParts}
        source={inspectionSource(i.uuid)}
      />
      <InspectionPOButton inspection={i} />
      <RequestPartsButton source={inspectionSource(i.uuid)} />
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
  );
}

type Execute = (command: ManagementCommand) => Promise<void>;

// How the stale-save review names and formats an inspection's fields.
const INSPECTION_STALE_SAVE: StaleSaveOptions<Inspection> = {
  label: "inspection",
  entityUuid: (i) => i.uuid,
  specs: {
    reference: "Reference",
    description: "Description",
    ataChapter: "ATA chapter",
    intervalSeconds: { label: "Repeat every (hours)", format: formatHours },
    intervalCycles: "Repeat every (cycles)",
    intervalLandings: "Repeat every (landings)",
    intervalMonths: "Repeat every (months)",
    lastSeconds: { label: "Last complied at (hours)", format: formatHours },
    lastCycles: "Last complied at (cycles)",
    lastLandings: "Last complied at (landings)",
    lastDate: "Last compliance date",
    dueSeconds: { label: "Due at (hours)", format: formatHours },
    dueDate: "Due date",
    archived: "Archived",
    requiredParts: "Required parts",
    manualReference: "Manual reference",
    calendarExempt: "Calendar exempt",
    calendarExemptReason: "Calendar exemption reason",
  },
};

function formatHours(value: unknown) {
  return hours(Number(value));
}

function InspectionDialog(
  props: InspectionProps & {
    selected: Inspection | "new";
    execute: Execute;
  },
) {
  const { s, writable, screen, editable, selected } = props;
  const record = selected !== "new" ? selected : undefined;
  const { complete } = screen;
  const stale = useStaleSave(INSPECTION_STALE_SAVE);
  const allowed = record
    ? can(s, record.aircraftUuid, "maintenance")
    : editable.length;
  return (
    <Modal
      title={
        complete
          ? "Record inspection completion"
          : record
            ? "Inspection details"
            : "New inspection"
      }
      onClose={() => screen.setSelected(null)}
    >
      <AsyncForm
        key={stale.formKey}
        disabled={!writable || !allowed}
        submitLabel={complete ? "Record completion" : "Save inspection"}
        onSubmit={(d) =>
          stale.run({
            // A completion changes no field of its own: the review shows what
            // the other person changed on the record.
            draft:
              record && !complete
                ? inspectionFromForm(d, record, record.uuid)
                : record,
            loaded: record,
            find: (live) =>
              live.inspections.find((i) => i.uuid === record?.uuid),
            save: (version) =>
              saveInspection(props.execute, screen, record, d, version),
            useTheirs: (current) => screen.setSelected(current ?? null),
          })
        }
      >
        {complete && record ? (
          <CompletionFields s={s} record={record} />
        ) : (
          <InspectionFields s={s} record={record} editable={editable} />
        )}
        {complete && <Reason />}
      </AsyncForm>
      {record && <History uuid={record.uuid} />}
      {stale.dialog}
    </Modal>
  );
}

// "Add parts / repair request" on a new schedule saves it, then opens the
// request for it. `version` is the one the save is checked against: the
// record's, or the current one when the user keeps a stale draft.
async function saveInspection(
  execute: Execute,
  screen: InspectionScreen,
  record: Inspection | undefined,
  d: FormData,
  version: number,
) {
  const { complete } = screen;
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
      version,
      date: value(d, "date"),
      seconds: secs(d, "seconds")!,
      cycles: num(d, "cycles")!,
      landings: num(d, "landings"),
    });
  else
    await execute({
      ...common,
      action: "inspection.save",
      record: { ...inspectionFromForm(d, record, inspectionUuid), version },
    });
  if (!complete && value(d, "inspectionIntent") === "request")
    screen.setRequestInspectionUuid(inspectionUuid);
  screen.setSelected(null);
}

// A saved schedule keeps its aircraft, component, time source and materials;
// the form disables the first three and never edits materials.
function inspectionFromForm(
  d: FormData,
  record: Inspection | undefined,
  uuid: string,
) {
  return {
    sourceKey: record?.sourceKey,
    usageMeter: record
      ? record.usageMeter
      : (value(d, "usageMeter") as Inspection["usageMeter"]),
    uuid,
    version: record?.version ?? 0,
    aircraftUuid: record?.aircraftUuid ?? value(d, "aircraft"),
    componentUuid:
      record?.componentUuid ?? (value(d, "component") || undefined),
    ataChapter: ataChapterSchema
      .optional()
      .parse(value(d, "ataChapter") || undefined),
    manualReference: manualReferenceFromForm(d),
    reference: value(d, "reference"),
    description: value(d, "description"),
    materials: record?.materials ?? "",
    requiredParts: requiredPartsFromForm(d),
    archived: d.get("archived") === "on",
    ...limitsFromForm(d),
  };
}

function limitsFromForm(d: FormData) {
  return {
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
  };
}

function CompletionFields({ s, record }: { s: Snapshot; record: Inspection }) {
  const aircraft = () =>
    s.aircraft.find((a) => a.uuid === record.aircraftUuid)!;
  const counters = readCounters(record, aircraft(), s.management);
  return (
    <>
      <p>
        Record the tracked aircraft or component total time, cycles, and
        aircraft total landings when the work was completed. Recurring due
        limits are recalculated; one-time schedules are archived.
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
        initial={counters && counters.seconds / HOUR_SECONDS}
      />
      <NumberField
        name="cycles"
        label="Tracked cycles at completion"
        required
        initial={counters?.cycles}
      />
      {tracksLandings(record) && (
        <LandingsAtCompletion landings={aircraft().landings} />
      )}
    </>
  );
}

function LandingsAtCompletion({ landings }: { landings: number }) {
  return (
    <NumberField
      name="landings"
      label="Aircraft total landings at completion"
      initial={landings}
      required
    />
  );
}

function InspectionFields({
  s,
  record,
  editable,
}: {
  s: Snapshot;
  record: Inspection | undefined;
  editable: Aircraft[];
}) {
  return (
    <>
      <InspectionTargetFields s={s} record={record} editable={editable} />
      <AtaChapterField initial={record?.ataChapter} />
      <ManualReferenceFields initial={record?.manualReference} />
      <InspectionTextFields record={record} />
      <InspectionSchedule record={record} />
      <p className="muted">
        For a one-time limit, leave its repeat interval blank and enter the due
        value.
      </p>
      <CalendarExemptionFields
        record={record ?? undefined}
        members={s.members}
      />
      <InspectionParts record={record} />
      <label>
        <input
          name="archived"
          type="checkbox"
          defaultChecked={record?.archived}
        />{" "}
        Archived
      </label>
    </>
  );
}

function InspectionTextFields({ record }: { record: Inspection | undefined }) {
  return (
    <>
      <Field label="Reference" hint="Optional">
        <input
          name="reference"
          defaultValue={record?.reference}
          maxLength={INSPECTION_REFERENCE_MAX_LENGTH}
        />
      </Field>
      <Field label="Description">
        <textarea
          name="description"
          defaultValue={record?.description}
          required
        />
      </Field>
    </>
  );
}

// What a schedule tracks is fixed once it is saved.
function InspectionTargetFields({
  s,
  record,
  editable,
}: {
  s: Snapshot;
  record: Inspection | undefined;
  editable: Aircraft[];
}) {
  return (
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
          <option value="collective">Helicopter collective hourmeter</option>
        </select>
      </Field>
      <TrackedComponentField s={s} record={record} />
    </>
  );
}

function TrackedComponentField({
  s,
  record,
}: {
  s: Snapshot;
  record: Inspection | undefined;
}) {
  const components = (s.management ?? []).filter(
    (r): r is Component => r.kind === "component",
  );
  return (
    <Field label="Track usage on">
      <select
        name="component"
        defaultValue={record?.componentUuid ?? ""}
        disabled={!!record}
      >
        <option value="">Aircraft</option>
        {components.map((c) => (
          <option key={c.uuid} value={c.uuid}>
            {s.aircraft.find((a) => a.uuid === c.aircraftUuid)?.registration} ·{" "}
            {c.partNumber} / {c.serial}
          </option>
        ))}
      </select>
    </Field>
  );
}

// A recurring schedule shows its interval and last compliance; its derived
// due value is left blank, as only a one-time limit enters one.
function InspectionSchedule({ record }: { record: Inspection | undefined }) {
  const tracked = (interval: unknown, due: unknown) =>
    record ? interval !== undefined || due !== undefined : false;
  return (
    <ScheduleTracking
      key={record?.uuid ?? "new"}
      initial={{
        hours: tracked(record?.intervalSeconds, record?.dueSeconds),
        cycles: tracked(record?.intervalCycles, record?.dueCycles),
        calendar: tracked(record?.intervalMonths, record?.dueDate),
        landings: tracked(record?.intervalLandings, record?.dueLandings),
      }}
    >
      {{
        hours: <HourLimits record={record} />,
        cycles: <CycleLimits record={record} />,
        calendar: <CalendarLimits record={record} />,
        landings: <LandingLimits record={record} />,
      }}
    </ScheduleTracking>
  );
}

type LimitProps = { record: Inspection | undefined };

const inHours = (seconds: number | undefined) =>
  seconds === undefined ? undefined : seconds / HOUR_SECONDS;

function HourLimits({ record }: LimitProps) {
  return (
    <>
      <NumberField
        name="intervalSeconds"
        label="Repeat every (hours)"
        decimal
        initial={inHours(record?.intervalSeconds)}
      />
      <NumberField
        name="lastSeconds"
        label="Last complied at (tracked hours)"
        decimal
        initial={inHours(record?.lastSeconds)}
      />
      <NumberField
        name="dueSeconds"
        label="One-time due (tracked hours)"
        decimal
        initial={
          record?.intervalSeconds ? undefined : inHours(record?.dueSeconds)
        }
      />
    </>
  );
}

function CycleLimits({ record }: LimitProps) {
  return (
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
        initial={record?.intervalCycles ? undefined : record?.dueCycles}
      />
    </>
  );
}

function CalendarLimits({ record }: LimitProps) {
  return (
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
          defaultValue={record?.intervalMonths ? undefined : record?.dueDate}
        />
      </Field>
      <p>Calendar intervals expire at the end of the due month.</p>
    </>
  );
}

function LandingLimits({ record }: LimitProps) {
  return (
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
        initial={record?.intervalLandings ? undefined : record?.dueLandings}
      />
    </>
  );
}

function InspectionParts({ record }: { record: Inspection | undefined }) {
  return (
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
          source={inspectionSource(record.uuid)}
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
            Saves this inspection, then opens its parts / repair requests.
          </p>
        </>
      )}
      <PartsAvailability
        parts={record?.requiredParts}
        source={record ? inspectionSource(record.uuid) : undefined}
      />
    </section>
  );
}

type Files = ReturnType<typeof useInventoryFiles>;
type View = ReturnType<typeof useInventoryView>;
type LinkedItem = ReturnType<typeof useLinkedItem>;
type InventoryStock = ReturnType<typeof inventoryStock>;
type InventoryProps = {
  s: Snapshot;
  writable: boolean;
  execute: Execute;
  backend: Backend;
  files: Files;
  view: View;
  link: LinkedItem;
};

// Files chosen for a new stock item upload after it is saved.
function useInventoryFiles() {
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploadIssue, setUploadIssue] = useState("");
  const [newCategory, setNewCategory] = useState("part");
  const reset = () => {
    setPendingFiles([]);
    setUploadIssue("");
  };
  return {
    ...{ pendingFiles, setPendingFiles, uploadIssue, setUploadIssue },
    ...{ newCategory, setNewCategory, reset },
  };
}

function useInventoryView() {
  const [selected, setSelected] = useState<
      ManagedRecord | "stock" | "location" | null
    >(null),
    [move, setMove] = useState(false),
    [search, setSearch] = useState(""),
    [shelfLife, setShelfLife] = useState<"" | ShelfLife>("");
  const record =
    typeof selected === "object" && selected ? selected : undefined;
  return {
    ...{ selected, setSelected, move, setMove, search, setSearch },
    ...{ shelfLife, setShelfLife, record, kind: record?.kind ?? selected },
  };
}

// A scanned or shared link (?item=) opens that stock item or component once,
// for an administrator of its program.
function useLinkedItem(s: Snapshot, view: View, files: Files) {
  const { setSelected, setMove } = view;
  const { setPendingFiles, setUploadIssue } = files;
  const linked = useSearch({ from: "/inventory" });
  const navigate = useNavigate({ from: "/inventory" });
  const openedLink = useRef("");
  const linkedRecord = (s.management ?? []).find(
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
  }, [
    linked.item,
    linkedRecord,
    s,
    setSelected,
    setMove,
    setPendingFiles,
    setUploadIssue,
  ]);
  return { linked, navigate, linkedRecord };
}

function inventoryStock(s: Snapshot) {
  const records = s.management ?? [];
  const locations = records.filter((r): r is Location => r.kind === "location");
  return {
    stock: records.filter((r): r is Stock => r.kind === "stock"),
    storedComponents: records.filter(
      (r): r is Component => r.kind === "component" && !r.installed,
    ),
    locations,
    locationName: (uuid: string) =>
      locations.find((l) => l.uuid === uuid)?.name,
  };
}

function inventoryRows(s: Snapshot, view: View, stock: InventoryStock) {
  const day = today();
  const query = view.search.toLowerCase();
  const shown = (date?: string) => matchesShelfLife(view.shelfLife, date, day);
  return {
    stockRows: stock.stock
      .filter((r) => shown(r.expirationDate))
      .filter((r) =>
        `${r.partNumber} ${r.alternates} ${r.description} ${r.vendor ?? ""} ${r.invoiceNumber ?? ""} ${r.poRef ?? ""} ${stock.locationName(r.locationUuid)}`
          .toLowerCase()
          .includes(query),
      ),
    componentRows: stock.storedComponents
      .filter((c) => shown(c.expirationDate))
      .filter((c) =>
        `${c.partNumber} ${c.serial} ${c.componentType} ${componentStorage(s, c)} trackable aircraft component`
          .toLowerCase()
          .includes(query),
      ),
  };
}

function InventoryHeader(props: InventoryProps & { stock: InventoryStock }) {
  return (
    <PageHeader
      eyebrow="INVENTORY"
      title="Inventory"
      description="Parts, consumables, storage locations, and an audited stock ledger."
      actions={<InventoryActions {...props} />}
    />
  );
}

function InventoryActions({
  writable,
  files,
  view,
  stock,
}: InventoryProps & { stock: InventoryStock }) {
  const newLocation = () => {
    view.setSelected("location");
    view.setMove(false);
  };
  const newStock = () => {
    files.reset();
    files.setNewCategory("part");
    view.setSelected("stock");
    view.setMove(false);
  };
  return (
    <>
      <ScanButton />
      <RequestPartsButton
        source={{ kind: "stock", uuid: "", workOrderUuid: "" }}
        label="Request parts"
      />
      <button className="button" disabled={!writable} onClick={newLocation}>
        <MapPin size={18} aria-hidden="true" />
        New location
      </button>
      <button
        className="button primary"
        disabled={!writable || !stock.locations.length}
        onClick={newStock}
      >
        <Plus size={18} weight="bold" aria-hidden="true" />
        New stock item
      </button>
    </>
  );
}

// The item may belong to another program the user can open.
function LinkedItemNotice({ s, writable, backend, link }: InventoryProps) {
  const program = link.linked.program;
  const switchProgram = async () => {
    try {
      await backend.selectProgram(program!);
    } catch (error) {
      useWorkspace.setState({
        error: errorText(error, "Unable to switch Flight Program."),
      });
    }
  };
  return (
    <NoticeBar tone="warn" icon={Warning} role="status">
      <p>
        This inventory item is not available in the active Flight Program.
        Select its Flight Program or check your access.
      </p>
      {program &&
        program !== s.activeProgramUuid &&
        s.programs?.some((p) => p.uuid === program) && (
          <button
            className="button small mx-notice-action"
            disabled={!writable}
            onClick={switchProgram}
          >
            Open item’s Flight Program
          </button>
        )}
    </NoticeBar>
  );
}

function InventoryStats({ stock: inventory }: { stock: InventoryStock }) {
  const counts = inventoryCounts(
    inventory.stock,
    inventory.storedComponents,
    today(),
  );
  return (
    <StatsStrip className="mx-stats">
      <StatTile label="Stock items" value={counts.stockItems} />
      <StatTile label="At or below reorder" value={counts.atOrBelowReorder} />
      <StatTile label="Expired or expiring" value={counts.expiredOrExpiring} />
      <StatTile
        label="Recorded stock value"
        value={
          counts.recordedValue === undefined
            ? "—"
            : counts.recordedValue.toLocaleString("en-US", {
                style: "currency",
                currency: "USD",
              })
        }
      />
    </StatsStrip>
  );
}

function InventoryFilters({ view }: { view: View }) {
  return (
    <Toolbar className="mx-filters">
      <SearchField
        className="mx-search"
        label="Search inventory"
        placeholder="Part, serial number, description, location, vendor, invoice, or PO"
        value={view.search}
        onChange={view.setSearch}
      />
      <IconSelect
        icon={Hourglass}
        label="Shelf life"
        value={view.shelfLife}
        onChange={(v) => view.setShelfLife(v as "" | ShelfLife)}
      >
        <option value="">All items</option>
        <option value="soon">
          {`Expired or expiring within ${EXPIRING_SOON_DAYS} days`}
        </option>
        <option value="expired">Expired</option>
      </IconSelect>
    </Toolbar>
  );
}

function InventoryList(props: InventoryProps & { stock: InventoryStock }) {
  const { stockRows, componentRows } = inventoryRows(
    props.s,
    props.view,
    props.stock,
  );
  if (stockRows.length || componentRows.length)
    return <InventoryTable {...props} rows={{ stockRows, componentRows }} />;
  if (props.stock.stock.length || props.stock.storedComponents.length)
    return (
      <EmptyState title="No matching items">
        Try another search or shelf-life filter.
      </EmptyState>
    );
  return (
    <EmptyState title="No stock items">
      Create a location, add a part or supply, then receive stock.
    </EmptyState>
  );
}

const INVENTORY_COLUMNS = [
  "Part / supply / component",
  "Location",
  "Condition",
  "Qty",
  "Vendor",
  "Invoice #",
  "PO Ref",
  "Cost",
  "Actions",
];

function InventoryTable(
  props: InventoryProps & {
    stock: InventoryStock;
    rows: ReturnType<typeof inventoryRows>;
  },
) {
  const plans = maintenancePartsPlans(props.s);
  return (
    <ListCard className="mx-records-card">
      <table
        className="mx-records mx-inv-table"
        role="table"
        aria-label="Inventory items"
      >
        <thead className="sr-only" role="rowgroup">
          <tr role="row">
            {INVENTORY_COLUMNS.map((h) => (
              <th role="columnheader" scope="col" key={h}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup">
          {props.rows.stockRows.map((r) => (
            <StockRow key={r.uuid} {...props} item={r} plans={plans} />
          ))}
          {props.rows.componentRows.map((c) => (
            <ComponentRow key={c.uuid} {...props} component={c} />
          ))}
        </tbody>
      </table>
    </ListCard>
  );
}

// Opening an item to view it, not to move it, drops files left from another.
function openRecord(
  { files, view }: Pick<InventoryProps, "files" | "view">,
  record: Stock | Component,
  moving: boolean,
) {
  if (!moving) files.reset();
  view.setSelected(record);
  view.setMove(moving);
}

type Plans = ReturnType<typeof maintenancePartsPlans>;

function StockRow(
  props: InventoryProps & { stock: InventoryStock; item: Stock; plans: Plans },
) {
  const { item: r } = props;
  const reorder = needsReorder(r);
  return (
    <tr role="row" className="mx-inv-row">
      <StockMainCell item={r} reorder={reorder} />
      <FactCell label="Location">
        {props.stock.locationName(r.locationUuid)}
      </FactCell>
      <StockConditionCell item={r} />
      <StockQtyCell
        s={props.s}
        item={r}
        reorder={reorder}
        plans={props.plans}
      />
      <FactCell label="Vendor">{r.vendor || "—"}</FactCell>
      <FactCell label="Invoice #">{r.invoiceNumber || "—"}</FactCell>
      <FactCell label="PO Ref">{r.poRef || "—"}</FactCell>
      <FactCell label="Cost" numeric>
        {r.cost === undefined ? "—" : r.cost.toFixed(2)}
      </FactCell>
      <StockActionsCell {...props} />
    </tr>
  );
}

function StockActionsCell(props: InventoryProps & { item: Stock }) {
  const { item: r, writable } = props;
  return (
    <td role="cell" className="mx-cell-actions">
      <button
        className="button small"
        onClick={() => openRecord(props, r, false)}
      >
        Details
      </button>
      <InventoryPrintButtons item={r} />
      <button
        className="button small"
        disabled={!writable}
        onClick={() => openRecord(props, r, true)}
      >
        Move stock
      </button>
      <RequestPartsButton
        source={{ kind: "stock", uuid: r.uuid, workOrderUuid: "" }}
      />
    </td>
  );
}

function StockMainCell({
  item: r,
  reorder,
}: {
  item: Stock;
  reorder: boolean;
}) {
  return (
    <td role="cell" className="mx-cell-main">
      <IconTile icon={r.oil ? Drop : Stack} tone={reorder ? "warn" : "good"} />
      <span className="mx-main-text">
        <strong className="mx-main-title">{r.partNumber}</strong>
        <span className="mx-main-sub">{r.description}</span>
        <span className="mx-main-note mx-capitalize">
          {r.category} · Alternates: {r.alternates || "—"}
        </span>
      </span>
    </td>
  );
}

function FactCell({
  label,
  numeric = false,
  children,
}: {
  label: string;
  numeric?: boolean;
  children: ReactNode;
}) {
  return (
    <td role="cell" className="mx-fact">
      <FactLabel>{label}</FactLabel>
      <span className={"mx-fact-value" + (numeric ? " mx-num" : "")}>
        {children}
      </span>
    </td>
  );
}

function StockConditionCell({ item: r }: { item: Stock }) {
  return (
    <td role="cell" className="mx-fact">
      <FactLabel>Condition</FactLabel>
      <span className="mx-fact-value mx-capitalize">{r.condition}</span>
      <ExpirationNote date={r.expirationDate} />
      <span className="mx-fact-note">
        Reserved{" "}
        {r.reservedQuantity ?? 0} · Available{" "}
        {usableQuantity(r)}
      </span>
    </td>
  );
}

function ExpirationNote({ date }: { date?: string }) {
  return (
    <span className="mx-fact-note">
      Exp. date:{" "}
      <span className="mx-nowrap">{date || "—"}</span>{" "}
      <ShelfLifeBadge date={date} today={today()} />
    </span>
  );
}

function StockQtyCell({
  s,
  item: r,
  reorder,
  plans,
}: {
  s: Snapshot;
  item: Stock;
  reorder: boolean;
  plans: Plans;
}) {
  const orders = (s.partsOnOrder ?? []).filter((x) => x.stockUuid === r.uuid);
  return (
    <td role="cell" className="mx-cell-qty">
      <FactLabel>Qty</FactLabel>
      <span className="mx-qty">
        <strong>{r.quantity}</strong>
        <StatusPill tone={reorder ? "warn" : "good"} dot={false}>
          {reorder ? "Reorder" : "In stock"}
        </StatusPill>
      </span>
      <span className="mx-fact-note">Minimum {r.minimum}</span>
      <span className="mx-fact-note">
        On order {orders.reduce((n, x) => n + x.quantity, 0)} · Shipped{" "}
        {orders.reduce((n, x) => n + x.shipped, 0)}
      </span>
      <PlannedNeeds item={r} plans={plans} />
    </td>
  );
}

function PlannedNeeds({ item: r, plans }: { item: Stock; plans: Plans }) {
  return plannedNeedsFor(plans, r).map(({ plan: p, quantity }) => (
    <span className="mx-fact-note" key={p.uuid}>
      {p.label}: needs {quantity}
      {p.upcoming ? " · Due / open" : " · Scheduled"}
    </span>
  ));
}

function ComponentRow(props: InventoryProps & { component: Component }) {
  const { s, component: c } = props;
  return (
    <tr role="row" className="mx-inv-row">
      <ComponentMainCell component={c} />
      <FactCell label="Location">{componentStorage(s, c)}</FactCell>
      <td role="cell" className="mx-fact">
        <FactLabel>Condition</FactLabel>
        <span className="mx-fact-value">
          {c.outForRepair ? "Out for repair" : "In storage"}
        </span>
        <ExpirationNote date={c.expirationDate} />
      </td>
      <td role="cell" className="mx-cell-qty">
        <FactLabel>Qty</FactLabel>
        <span className="mx-qty">
          <strong>1</strong>
        </span>
        <span className="mx-fact-note">Tracked individually</span>
      </td>
      {(["Vendor", "Invoice #", "PO Ref", "Cost"] as const).map((label) => (
        <FactCell key={label} label={label}>
          —
        </FactCell>
      ))}
      <ComponentActionsCell {...props} />
    </tr>
  );
}

function ComponentActionsCell(
  props: InventoryProps & { component: Component },
) {
  const { s, writable, component: c } = props;
  const movable = mayMaintain(s, c.aircraftUuid);
  return (
    <td role="cell" className="mx-cell-actions">
      <button
        className="button small"
        onClick={() => openRecord(props, c, false)}
      >
        Details
      </button>
      <InventoryPrintButtons item={c} />
      {movable ? (
        <button
          className="button small"
          disabled={!writable}
          onClick={() => openRecord(props, c, true)}
        >
          Install / service
        </button>
      ) : null}
      <RequestPartsButton
        source={{ kind: "component", uuid: c.uuid, workOrderUuid: "" }}
      />
    </td>
  );
}

function ComponentMainCell({ component: c }: { component: Component }) {
  return (
    <td role="cell" className="mx-cell-main">
      <IconTile icon={Engine} tone={c.outForRepair ? "warn" : "blue"} />
      <span className="mx-main-text">
        <strong className="mx-main-title">
          {c.partNumber || c.componentType}
        </strong>
        <span className="mx-main-sub">{c.componentType}</span>
        <span className="mx-main-note">
          Trackable Aircraft Component · Serial {c.serial || "Not recorded"}
        </span>
      </span>
    </td>
  );
}

function StorageLocations({
  locations,
  view,
}: {
  locations: Location[];
  view: View;
}) {
  return (
    <section className="mx-locations" aria-labelledby="mx-locations-title">
      <h2 className="mx-section-title" id="mx-locations-title">
        Storage locations
      </h2>
      {locations.length ? (
        <div className="mx-location-grid">
          {locations.map((l) => (
            <LocationCard key={l.uuid} location={l} view={view} />
          ))}
        </div>
      ) : (
        <EmptyState title="No storage locations">
          Add a location before receiving stock.
        </EmptyState>
      )}
    </section>
  );
}

// A structured address replaces the legacy contact line.
function LocationCard({
  location: l,
  view,
}: {
  location: Location;
  view: View;
}) {
  const edit = () => {
    view.setSelected(l);
    view.setMove(false);
  };
  return (
    <article className="mx-location-card">
      <IconTile icon={Warehouse} tone="blue" size="md" />
      <div className="mx-location-text">
        <h3>{l.name}</h3>
        {l.address && <p className="mx-location-address">{l.address}</p>}
        {!l.addressDetails && l.contact && <p>{l.contact}</p>}
      </div>
      <button className="button small" onClick={edit}>
        <PencilSimple size={16} aria-hidden="true" />
        Edit location
      </button>
    </article>
  );
}

type DialogProps = InventoryProps & { stock: InventoryStock };

// Closing an item opened from a link also clears the link.
function InventoryDialog(props: DialogProps) {
  const { s, writable, files, view, link } = props;
  const { record, kind, move } = view;
  const close = () => {
    view.setSelected(null);
    if (link.linked.item)
      void link.navigate({
        to: "/inventory",
        search: { item: undefined, program: undefined },
        replace: true,
      });
  };
  return (
    <Modal title={dialogTitle(move, kind)} onClose={close}>
      <p>
        Flight Program:{" "}
        {s.programs?.find((p) => p.uuid === s.activeProgramUuid)?.name ??
          "Unassigned"}
      </p>
      {record &&
        (record.kind === "stock" || record.kind === "component") &&
        !move && <InventoryPrintButtons item={record} />}
      {!record && kind === "stock" && (
        <NewItemCategory writable={writable} files={files} />
      )}
      <InventoryDialogBody {...props} />
      <SavedItemAttachments files={files} view={view} />
      {record && <History uuid={record.uuid} />}
    </Modal>
  );
}

function NewItemCategory({
  writable,
  files,
}: {
  writable: boolean;
  files: Files;
}) {
  return (
    <Field label="Category">
      <select
        disabled={!writable}
        value={files.newCategory}
        onChange={(e) => files.setNewCategory(e.target.value)}
      >
        <option value="part">Part</option>
        <option value="supply">Supply / consumable</option>
        <option value="component">Trackable Aircraft Component</option>
      </select>
    </Field>
  );
}

function dialogTitle(move: boolean, kind: View["kind"]) {
  if (move) return "Stock movement";
  return kind === "location" ? "Storage location" : "Stock item";
}

// A component is edited, installed and serviced with the component forms; a
// new one can be created here as inventory.
function InventoryDialogBody(props: DialogProps) {
  const { view, files } = props;
  const { record, move } = view;
  const done = () => view.setSelected(null);
  if (record?.kind === "component")
    return move ? (
      <ServiceForm c={record} onDone={done} />
    ) : (
      <ComponentForm record={record} onDone={done} />
    );
  if (!record && view.kind === "stock" && files.newCategory === "component")
    return (
      <ComponentForm
        inventoryOnly
        review={
          <>
            <p>
              Each component is tracked individually by serial number, hours,
              cycles and maintenance history.
            </p>
          </>
        }
        onDone={done}
      />
    );
  return <InventoryRecordForm {...props} />;
}

function InventoryRecordForm(props: DialogProps) {
  const { writable, view } = props;
  const { record, kind, move } = view;
  return (
    <AsyncForm
      disabled={!writable}
      onSubmit={(d) => saveInventoryRecord(props, d)}
    >
      {move && record?.kind === "stock" ? (
        <MovementFields item={record} />
      ) : kind === "location" ? (
        <LocationFields record={record} />
      ) : (
        <StockFields {...props} />
      )}
    </AsyncForm>
  );
}

function inventoryReason(view: View, d: FormData) {
  const { move, kind, record } = view;
  if (move) return `Stock movement recorded: ${value(d, "operation")}.`;
  if (kind === "location")
    return record ? "Storage location updated." : "Storage location created.";
  return record ? "Stock item updated." : "Stock item created.";
}

async function saveInventoryRecord(props: DialogProps, d: FormData) {
  const { execute, view } = props;
  const { move, kind, record } = view;
  const common = {
    requestUuid: crypto.randomUUID(),
    reason: inventoryReason(view, d),
  };
  if (move && record)
    await execute({
      ...common,
      action: "stock.move",
      uuid: record.uuid,
      version: record.version,
      operation: value(d, "operation") as "receive" | "issue" | "adjust",
      quantity: num(d, "quantity")!,
    });
  else if (kind === "location")
    await execute({
      ...common,
      action: "record.save",
      record: locationFromForm(d, record),
    });
  else if (!(await saveStock(props, d, common))) return;
  view.setSelected(null);
}

function locationFromForm(d: FormData, record: ManagedRecord | undefined) {
  const prior = record?.kind === "location" ? record : undefined;
  return {
    kind: "location" as const,
    uuid: record?.uuid ?? crypto.randomUUID(),
    version: record?.version ?? 0,
    name: value(d, "name"),
    addressDetails: addressFromForm(d),
    address: prior ? prior.address : "",
    contact: prior ? prior.contact : "",
  };
}

// Files are checked before the item is saved, and uploaded after it.
async function saveStock(
  { execute, backend, files, view }: DialogProps,
  d: FormData,
  common: { requestUuid: string; reason: string },
) {
  const { record } = view;
  if (!record)
    for (const file of files.pendingFiles)
      validateInventoryFile(file.name, file.type, file.size);
  const stockRecord = stockFromForm(d, record);
  await execute({ ...common, action: "record.save", record: stockRecord });
  if (record) return true;
  return uploadPendingFiles(backend, files, view, stockRecord);
}

function stockFromForm(d: FormData, record: ManagedRecord | undefined): Stock {
  return {
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
      record?.kind === "stock" ? record.locationUuid : value(d, "location"),
    quantity: num(d, "quantity") ?? 0,
    minimum: num(d, "minimum") ?? 0,
    vendor: value(d, "vendor") || undefined,
    invoiceNumber: value(d, "invoiceNumber") || undefined,
    poRef: value(d, "poRef") || undefined,
    cost: num(d, "cost"),
    expirationDate: value(d, "expirationDate") || undefined,
  };
}

// The item is already saved, so a failed upload keeps the dialog open on it
// with the files still to upload, rather than failing the save.
async function uploadPendingFiles(
  backend: Backend,
  files: Files,
  view: View,
  stockRecord: Stock,
) {
  const { pendingFiles } = files;
  for (let index = 0; index < pendingFiles.length; index++) {
    try {
      await backend.attachInventoryFile(stockRecord.uuid, pendingFiles[index]);
    } catch {
      files.setPendingFiles(pendingFiles.slice(index));
      view.setSelected({ ...stockRecord, version: stockRecord.version + 1 });
      files.setUploadIssue(
        "The stock item was saved. Some attachments could not be uploaded. Retry the remaining files below.",
      );
      return false;
    }
  }
  files.setPendingFiles([]);
  return true;
}

function MovementFields({ item }: { item: Stock }) {
  return (
    <>
      <p>
        {item.partNumber} · Current stock: <strong>{item.quantity}</strong>
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
  );
}

function LocationFields({ record }: { record: ManagedRecord | undefined }) {
  const location = record?.kind === "location" ? record : undefined;
  return (
    <>
      <Field label="Location name">
        <input
          name="name"
          defaultValue={location ? location.name : ""}
          required
        />
      </Field>
      <AddressFields
        label="Location address"
        name="addressDetails"
        value={location ? location.addressDetails : undefined}
        legacy={location ? location.address : ""}
        contactName={location ? location.contact : ""}
      />
    </>
  );
}

function StockFields({ stock, files, view }: DialogProps) {
  const { record } = view;
  const item = record?.kind === "stock" ? record : undefined;
  return (
    <>
      <StockIdentityFields record={record} />
      <StockCategoryFields record={record} newCategory={files.newCategory} />
      <StockConditionFields record={record} locations={stock.locations} />
      <NumberField
        name="quantity"
        label="Qty"
        initial={item ? item.quantity : 0}
        required
      />
      <Field
        label="Expiration date"
        hint="Optional; leave blank if not applicable."
      >
        <input
          type="date"
          name="expirationDate"
          defaultValue={item ? item.expirationDate : undefined}
        />
      </Field>
      <NumberField
        name="minimum"
        label="Reorder at or below"
        initial={item ? item.minimum : 0}
      />
      <PurchaseFields item={item} />
      {!record && <NewStockAttachments files={files} />}
      <p className="muted">
        Qty is the current counted balance. Use Move stock to record receipts or
        issues. Quantity changes are saved in history.
      </p>
    </>
  );
}

const STOCK_TEXT_FIELDS = [
  ["partNumber", "Part number"],
  ["description", "Description"],
  ["alternates", "Alternate part numbers"],
] as const;

function StockIdentityFields({
  record,
}: {
  record: ManagedRecord | undefined;
}) {
  return STOCK_TEXT_FIELDS.map(([k, label]) => (
    <Field key={k} label={label}>
      <input
        name={k}
        defaultValue={record?.kind === "stock" ? record[k] : undefined}
        required={k !== "alternates"}
      />
    </Field>
  ));
}

// A saved item's category can change between part and supply; a new item's
// category was chosen above the form.
function StockCategoryFields({
  record,
  newCategory,
}: {
  record: ManagedRecord | undefined;
  newCategory: string;
}) {
  return (
    <>
      {record ? (
        <Field label="Category">
          <select
            name="category"
            defaultValue={record?.kind === "stock" ? record.category : "part"}
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
        Engine oil (flight users can draw it down when logging oil added)
      </label>
    </>
  );
}

// A saved item's location cannot change here.
function StockConditionFields({
  record,
  locations,
}: {
  record: ManagedRecord | undefined;
  locations: Location[];
}) {
  return (
    <>
      <Field label="Condition">
        <select
          name="condition"
          defaultValue={record?.kind === "stock" ? record.condition : "new"}
        >
          {stockSchema.shape.condition.options.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </Field>
      <Field label="Location">
        <select
          name="location"
          disabled={!!record}
          defaultValue={
            record?.kind === "stock" ? record.locationUuid : undefined
          }
        >
          {locations.map((l) => (
            <option key={l.uuid} value={l.uuid}>
              {l.name}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}

const PURCHASE_FIELDS = [
  ["vendor", "Vendor", STOCK_VENDOR_MAX_LENGTH],
  ["invoiceNumber", "Invoice #", PURCHASE_REFERENCE_MAX_LENGTH],
  ["poRef", "PO Ref", PURCHASE_REFERENCE_MAX_LENGTH],
] as const;

function PurchaseFields({ item }: { item: Stock | undefined }) {
  return (
    <div className="form-grid">
      {PURCHASE_FIELDS.map(([name, label, maxLength]) => (
        <Field key={name} label={label}>
          <input
            name={name}
            maxLength={maxLength}
            defaultValue={item ? item[name] : undefined}
          />
        </Field>
      ))}
      <Field label="Cost">
        <input
          name="cost"
          type="number"
          min="0"
          step="0.01"
          defaultValue={item ? item.cost : undefined}
        />
      </Field>
    </div>
  );
}

function NewStockAttachments({ files }: { files: Files }) {
  return (
    <section aria-label="New stock attachments">
      <h3>Attachments</h3>
      <p>
        Choose images and PDFs to upload when you save this item. Up to 7 MB per
        file.
      </p>
      <InventoryFilePicker
        files={files.pendingFiles}
        onChange={files.setPendingFiles}
      />
    </section>
  );
}

// Files left from a failed upload are offered again on the saved item.
function SavedItemAttachments({ files, view }: { files: Files; view: View }) {
  const { record, kind, move } = view;
  if (!((kind === "stock" || kind === "component") && !move && record))
    return null;
  return (
    <>
      {files.uploadIssue && <p role="alert">{files.uploadIssue}</p>}
      <InventoryAttachments
        key={record.uuid}
        stockUuid={record.uuid}
        initialFiles={files.pendingFiles}
        onUploaded={files.reset}
      />
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
