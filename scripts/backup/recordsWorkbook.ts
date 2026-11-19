/**
 * Responsibility: Builds the readable records copy (ADR-0011), one formatted
 *   Excel workbook, from the nightly Convex export.
 * Layer: Script. Node only: reads the export ZIP, writes one .xlsx file.
 * Dependencies: ./exportSnapshot, ./xlsxWriter, src/domain (statuses,
 *   labels and rules).
 *
 * A copy for reading; the logbooks and the encrypted R2 backup (ADR-0008) are
 * the records. Every status and label comes from src/domain, so the workbook
 * says what the app says.
 */
import { parseArgs } from "node:util";
import {
  readExportSnapshot,
  type DamagedRecord,
  type ExportSnapshot,
  type RecordCollection,
  type StoredPayload,
} from "./exportSnapshot";
import {
  aircraftStatus,
  aircraftStatusLabels,
  DEFERRAL_WARNING_DAYS,
  type AircraftStatus,
} from "../../src/domain/aircraftStatus";
import {
  adAircraftUuid,
  adCounters,
  adStatus,
  adTaskStatus,
  CLOSED_APPLICABILITY,
  effectiveCompliance,
  type AD,
  type ADCompliance,
  type ADTask,
} from "../../src/domain/airworthiness";
import { auditActionLabel } from "../../src/domain/auditHistory";
import {
  componentTotals,
  requirementDueDate,
  requirementStatus,
  type Component,
  type ComponentRequirement,
} from "../../src/domain/components";
import {
  flightSeconds,
  workOrderCosts,
  type CostRecord,
} from "../../src/domain/costs";
import {
  adLevel,
  dueItems,
  requirementLevel,
  type AdDue,
  type DueLevel,
  type InspectionDue,
  type MaintenanceDue,
  type RequirementDue,
} from "../../src/domain/dueItems";
import {
  deferralDaysRemaining,
  deferralLabel,
  type Deferral,
} from "../../src/domain/deferrals";
import { flightStatusLabels } from "../../src/domain/flights";
import { listsAllAircraft } from "../../src/domain/groupAircraft";
import {
  inspectionDueDate,
  inspectionDueLimit,
  inspectionStatusLabels,
} from "../../src/domain/maintenance";
import type { ManagedRecord, Stock } from "../../src/domain/management";
import {
  hours,
  totalSeconds,
  type Aircraft,
  type AuditEntry,
  type Discrepancy,
  type Flight,
  type Group,
  type Member,
  type Snapshot,
} from "../../src/domain/model";
import { groupCoversAircraft, recordProgram } from "../../src/domain/programs";
import {
  outstanding,
  poStatus,
  poTotal,
  received,
  type PurchaseOrder,
} from "../../src/domain/purchaseOrders";
import { shelfLifeLabels, shelfLifeStatus } from "../../src/domain/shelfLife";
import type { TaskCard } from "../../src/domain/taskCards";
import { logbookPerformers } from "../../src/domain/workOrderCloseout";
import type { WorkOrder } from "../../src/domain/workOrders";
import {
  MAX_DATA_ROWS,
  writeWorkbook,
  type Cell,
  type Column,
  type Row,
  type SheetSpec,
  type Tone,
} from "./xlsxWriter";

export { MAX_DATA_ROWS };

/** How to build the workbook. */
export interface WorkbookOptions {
  /** The .xlsx file to write. */
  out: string;
  /** The IANA time zone for every date, time and "today". */
  timeZone: string;
  /** Which deployment the export came from, as shown on Read me. */
  deployment: string;
  /** When the copy is made; defaults to now. */
  now?: number;
  /** Data rows per Change history sheet; tests lower it. */
  maxRowsPerSheet?: number;
}
/** What the build wrote: rows per sheet, and the notes shown on Read me. */
export interface WorkbookSummary {
  sheets: { name: string; rows: number }[];
  warnings: string[];
}

// ------------------------------------------------------------------ time --

/**
 * Dates and times in one IANA time zone, as the workbook shows them.
 *
 * @param timeZone - An IANA name, such as "America/New_York".
 * @returns The zone's formatters.
 * @throws {RangeError} For a time zone Intl does not know.
 */
export function zoneClock(timeZone: string) {
  const wall = wallTime(timeZone);
  return {
    zone: timeZone,
    name: zoneName(timeZone),
    /** Excel keeps wall-clock time; exceljs writes a Date's UTC fields. */
    dateTime(epoch?: number | string) {
      const ms = typeof epoch === "string" ? Date.parse(epoch) : epoch;
      if (ms === undefined || !Number.isFinite(ms)) return undefined;
      return new Date(wall(ms) + (ms % MS_PER_SECOND));
    },
    date(text?: string) {
      const ms = utcDay(text);
      return ms === undefined ? undefined : new Date(ms);
    },
    today(epoch: number) {
      return new Date(wall(epoch)).toISOString().slice(0, 10);
    },
    dateText(value?: number | string) {
      const ms = typeof value === "number" ? wall(value) : utcDay(value);
      return ms === undefined ? "" : TEXT_DATE.format(new Date(ms));
    },
    dateTimeText(epoch: number) {
      const w = new Date(wall(epoch));
      return `${TEXT_DATE.format(w)} ${w.toISOString().slice(11, 16)}`;
    },
  };
}
type Clock = ReturnType<typeof zoneClock>;

const MS_PER_SECOND = 1000;
// Formats a wall-clock or stored date that is already in UTC fields.
const TEXT_DATE = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
});

// An epoch's wall-clock reading in the zone, as the UTC epoch with the same
// fields.
function wallTime(timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return (epoch: number) => {
    const p = Object.fromEntries(
      parts
        .formatToParts(new Date(epoch))
        .map((x) => [x.type, Number(x.value)]),
    ) as Record<string, number>;
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  };
}

function zoneName(timeZone: string) {
  return (
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longGeneric" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value ?? timeZone
  );
}

// A stored "YYYY-MM-DD" date at midnight UTC, so it shows the day written.
function utcDay(text?: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text ?? "");
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : undefined;
}

// ------------------------------------------------------------ the records --

const MS_PER_DAY = 86_400_000;
const SECONDS_PER_HOUR = 3600;
const CENTS_PER_DOLLAR = 100;
const LEVEL_TONE: Record<DueLevel, Tone | undefined> = {
  overdue: "bad",
  "due-soon": "warn",
  unknown: undefined,
  ok: "good",
};
const LEVEL_RANK: Record<DueLevel, number> = {
  overdue: 0,
  "due-soon": 1,
  unknown: 2,
  ok: 3,
};
interface Remaining {
  daysLeft?: number;
  hoursLeft?: number;
  cyclesLeft?: number;
  landingsLeft?: number;
}
interface DueItem extends Remaining {
  level: DueLevel;
  status: string;
  aircraft: Aircraft;
  kind: "Inspection" | "Component" | "AD";
  item: string;
  detail: string;
  dueDate?: string;
  dueAt: string;
  urgency: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Convex document IDs: 31–37 lowercase base-32 characters.
const CONVEX_ID = /^[0-9a-z]{31,37}$/;
// Record names past this many characters are cut, with an ellipsis.
const NAME_MAX_LENGTH = 60;
const idLike = (s: string) => UUID.test(s) || CONVEX_ID.test(s);
const lines = (...xs: (string | false | null | undefined)[]) =>
  xs.filter(Boolean).join("\n");
const sentence = (s: string) =>
  s ? s.charAt(0).toUpperCase() + s.slice(1).replaceAll("-", " ") : "";
const secondsToHours = (s: number | null | undefined) =>
  s === null || s === undefined ? undefined : s / SECONDS_PER_HOUR;
const PERMISSION_LABELS: Record<string, string> = {
  read: "read",
  flight: "add flights",
  discrepancy: "report discrepancies",
  resolve: "resolve discrepancies",
  maintenance: "manage maintenance",
};

// A value the app's rules cannot work out for a damaged record (an aircraft
// without a reading, say) shows the fallback, so the copy is still made.
function valueOr<T, F>(compute: () => T, fallback: F): T | F {
  try {
    return compute();
  } catch {
    return fallback;
  }
}

// Names people recognise in place of IDs.
function namer(
  s: Snapshot,
  programs: Map<string, string>,
  extra: readonly (readonly [string, string])[],
  clock: Clock,
) {
  const lookups = nameLookups(s, programs);
  const entities = entityNames(s, programs, extra, clock, lookups);
  const entity = (id: string) =>
    entities.get(id) ?? (idLike(id) ? "(unknown record)" : id);
  return { ...lookups, entity, entities, componentName };
}
type Namer = ReturnType<typeof namer>;
type Lookups = ReturnType<typeof nameLookups>;
type NameSetter = (id: string | undefined, label: string) => void;

function nameLookups(s: Snapshot, programs: Map<string, string>) {
  const aircraft = new Map(s.aircraft.map((a) => [a.uuid, a]));
  const records = s.management ?? [];
  const location = (uuid?: string) => {
    const r = records.find((x) => x.kind === "location" && x.uuid === uuid);
    return r?.kind === "location" ? r.name : undefined;
  };
  return {
    tail: (uuid?: string) =>
      uuid ? (aircraft.get(uuid)?.registration ?? "(unknown aircraft)") : "",
    person: personNamer(s.members),
    program: (uuid?: string) =>
      uuid ? (programs.get(uuid) ?? "(unknown Flight Program)") : "",
    component: (uuid?: string) =>
      records.find(
        (r): r is Component => r.kind === "component" && r.uuid === uuid,
      ),
    location,
  };
}

// Two people with the same name are told apart by email.
function personNamer(members: Member[]) {
  const byId = new Map(members.map((m) => [m.id, m]));
  const sameName = new Map<string, number>();
  for (const m of members)
    sameName.set(m.name, (sameName.get(m.name) ?? 0) + 1);
  return (id?: string) => {
    if (!id) return "";
    if (id === "system") return "The system (automatic)";
    const m = byId.get(id);
    if (!m) return "(unknown person)";
    return (sameName.get(m.name) ?? 0) > 1 && m.email
      ? `${m.name} (${m.email})`
      : m.name;
  };
}

function componentName(c: Component) {
  return [
    c.componentType,
    c.partNumber && `P/N ${c.partNumber}`,
    c.serial && `S/N ${c.serial}`,
  ]
    .filter(Boolean)
    .join(" ");
}

function shorten(text: string) {
  return text.length > NAME_MAX_LENGTH
    ? text.slice(0, NAME_MAX_LENGTH - 1).trimEnd() + "…"
    : text;
}

// Every record's name by ID. A later name replaces an earlier one, so
// aircraft, people and programs come last: their own names win.
function entityNames(
  s: Snapshot,
  programs: Map<string, string>,
  extra: readonly (readonly [string, string])[],
  clock: Clock,
  n: Lookups,
) {
  const entities = new Map<string, string>(extra);
  const set: NameSetter = (id, label) => {
    if (id) entities.set(id, label);
  };
  for (const [uuid, name] of programs) set(uuid, `Flight Program ${name}`);
  for (const g of s.groups)
    set(g.id, `Group ${g.name} (${n.program(g.programUuid) || "no program"})`);
  for (const f of s.flights)
    set(
      f.uuid,
      `Flight ${n.tail(f.aircraftUuid)} ${clock.dateText(Date.parse(f.startTime))}`,
    );
  for (const d of s.discrepancies)
    set(d.uuid, `Discrepancy: ${shorten(d.description)}`);
  for (const i of s.inspections)
    set(i.uuid, `Inspection: ${i.reference || shorten(i.description)}`);
  for (const r of s.management ?? []) set(r.uuid, managedName(r, n.component));
  nameWorkRecords(s, set);
  for (const c of s.costs ?? []) set(c.uuid, costName(c, entities, n));
  for (const m of s.members) set(m.id, n.person(m.id));
  for (const a of s.aircraft) set(a.uuid, a.registration);
  for (const [uuid, name] of programs) set(uuid, name);
  return entities;
}

function managedName(r: ManagedRecord, component: Lookups["component"]) {
  if (r.kind === "component") return `Component ${componentName(r)}`;
  if (r.kind === "componentRequirement")
    return `Component limit: ${r.description}${onComponent(component(r.componentUuid))}`;
  if (r.kind === "componentMovement")
    return `Component ${sentence(r.action.toLowerCase())}${onComponent(component(r.componentUuid))}`;
  if (r.kind === "stock") return `Stock ${r.partNumber} ${r.description}`;
  if (r.kind === "location") return `Location ${r.name}`;
  return `Vendor ${r.name}`;
}

function onComponent(c: Component | undefined) {
  return c ? ` (${componentName(c)})` : "";
}

function nameWorkRecords(s: Snapshot, set: NameSetter) {
  for (const r of s.airworthiness ?? []) {
    const ad = `AD ${r.source.number}`;
    set(r.uuid, ad);
    for (const t of r.tasks)
      set(t.uuid, `${ad} action: ${shorten(t.description)}`);
    for (const h of r.history) set(h.uuid, `${ad} compliance of ${h.date}`);
  }
  for (const w of s.workOrders ?? []) {
    const number = w.number || "(no number)";
    set(w.uuid, `Work order ${number}`);
    for (const t of w.tasks)
      set(t.uuid, `Work order ${number} item: ${shorten(t.description)}`);
  }
  for (const c of s.taskCards ?? []) {
    set(c.uuid, `Job card ${c.cardNumber} ${shorten(c.title)}`.trim());
    for (const p of c.partsUsed)
      set(p.uuid, `Part ${p.partNumber} on job card ${c.cardNumber}`);
  }
  for (const p of s.purchaseOrders ?? []) {
    set(p.uuid, `Purchase order ${p.number}`);
    for (const l of p.lines)
      set(l.uuid, `Purchase order ${p.number} line ${l.partNumber}`);
  }
  for (const r of s.partsRequests ?? [])
    set(r.uuid, `Parts request ${r.number}`);
}

function costName(c: CostRecord, entities: Map<string, string>, n: Lookups) {
  if (c.kind === "workOrder")
    return `Costs of ${entities.get(c.workOrderUuid) ?? "a work order"}`;
  if (c.kind === "budget") return `Budget ${c.year} ${n.tail(c.aircraftUuid)}`;
  return `Labour rate (${n.program(c.programUuid)})`;
}

// ------------------------------------------------------------- the sheets --

// The fleet's due list, most urgent first.
function dueList(s: Snapshot, today: string, names: Namer): DueItem[] {
  return dueItems(s, undefined, today)
    .flatMap((d) => dueRows(s, d, today, names))
    .sort(compareDue);
}

// Component limits in inventory, ADs that no longer apply (the domain lists
// them and judges their actions as if they applied), and AD actions on an
// aircraft the export does not hold or on a removed component, are not on
// the due list.
function dueRows(
  s: Snapshot,
  d: MaintenanceDue,
  today: string,
  names: Namer,
): DueItem[] {
  if (d.kind === "inspection") return [inspectionRow(d, names)];
  if (d.kind === "componentRequirement")
    return d.aircraft ? [requirementRow(d, d.aircraft, names)] : [];
  if (CLOSED_APPLICABILITY.includes(d.ad.applicability)) return [];
  if (!d.aircraft || d.component?.installed === false) return [];
  return adRows(s, d, d.aircraft, today, names);
}

function inspectionRow(d: InspectionDue, names: Namer): DueItem {
  const { inspection: i, due } = d;
  const c = names.component(i.componentUuid);
  const base = {
    aircraft: d.aircraft,
    kind: "Inspection" as const,
    item: i.reference || i.description,
    detail: lines(
      i.reference && i.description,
      c && `On ${names.componentName(c)}`,
    ),
    dueDate: inspectionDueDate(i),
    dueAt: dueAt(
      secondsToHours(i.dueSeconds),
      c ? " (component time)" : "",
      i.dueCycles,
      i.dueLandings,
    ),
  };
  if (!due) return unknownRow(base, d.error, inspectionStatusLabels.unknown);
  const left = {
    daysLeft: due.daysRemaining,
    hoursLeft: due.hoursRemaining,
    cyclesLeft: due.cyclesRemaining,
    landingsLeft: due.landingsRemaining,
  };
  const status = inspectionStatusLabels[due.status];
  return { ...base, ...left, level: d.level, status, urgency: urgency(left) };
}

function requirementRow(
  d: RequirementDue,
  aircraft: Aircraft,
  names: Namer,
): DueItem {
  const { requirement: r, due } = d;
  const base = {
    aircraft,
    kind: "Component" as const,
    item: names.componentName(d.component),
    detail: `${r.requirementType}: ${r.description}`,
    dueDate: requirementDueDate(r),
    dueAt: dueAt(
      secondsToHours(r.dueSeconds),
      ` ${r.timeBasis}`,
      r.dueCycles,
      r.dueLandings,
    ),
  };
  if (!due) return unknownRow(base, d.error, "Unknown");
  const left = {
    daysLeft: due.days,
    hoursLeft: secondsToHours(due.seconds),
    cyclesLeft: due.cycles,
    landingsLeft: due.landings,
  };
  const { status } = due;
  return { ...base, ...left, level: d.level, status, urgency: urgency(left) };
}

// A status that could not be worked out is listed with what went wrong, so
// one damaged record never hides the rest of the list.
function unknownRow(
  base: Omit<DueItem, "level" | "status" | "urgency">,
  error: unknown,
  status: string,
): DueItem {
  const message = error instanceof Error && error.message;
  return {
    ...base,
    detail: lines(base.detail, message),
    level: "unknown",
    status,
    urgency: Number.POSITIVE_INFINITY,
  };
}

// One row per action not yet complied with.
function adRows(
  s: Snapshot,
  d: AdDue,
  aircraft: Aircraft,
  today: string,
  names: Namer,
): DueItem[] {
  const { ad: r, component: c } = d;
  const counters = adCounters(s, r, today);
  return d.tasks
    .filter(({ status }) => status !== "Complied")
    .map(({ task, status, level }) => {
      const left = adTaskRemaining(task, counters, c, today);
      return {
        aircraft,
        kind: "AD" as const,
        item: `AD ${r.source.number}`,
        detail: lines(task.description, c && `On ${names.componentName(c)}`),
        dueDate: task.dueDate || undefined,
        dueAt: dueAt(
          task.dueHours,
          c ? " (component time)" : "",
          task.dueCycles,
          task.dueLandings,
        ),
        ...left,
        level,
        status,
        urgency: urgency(left),
      };
    });
}

// Hours and cycles count only on a dimension the component tracks.
function adTaskRemaining(
  task: ADTask,
  counters: ReturnType<typeof adCounters>,
  c: Component | undefined,
  today: string,
): Remaining {
  const hoursOk = counters && task.dueHours !== null && (!c || c.trackTime);
  const cyclesOk = counters && task.dueCycles !== null && (!c || c.trackCycles);
  return {
    daysLeft: task.dueDate
      ? Math.round((Date.parse(task.dueDate) - Date.parse(today)) / MS_PER_DAY)
      : undefined,
    hoursLeft: hoursOk
      ? Math.round((task.dueHours! - counters.hours) * SECONDS_PER_HOUR) /
        SECONDS_PER_HOUR
      : undefined,
    cyclesLeft: cyclesOk ? task.dueCycles! - counters.cycles : undefined,
    landingsLeft:
      counters && task.dueLandings != null
        ? task.dueLandings - counters.landings
        : undefined,
  };
}

// The nearest limit, by the inspections' rule; none sorts last.
function urgency(left: Remaining) {
  return (
    inspectionDueLimit({
      daysRemaining: left.daysLeft,
      hoursRemaining: left.hoursLeft,
      cyclesRemaining: left.cyclesLeft,
      landingsRemaining: left.landingsLeft,
    })?.urgency ?? Number.POSITIVE_INFINITY
  );
}

function dueAt(
  h: number | null | undefined,
  basis: string,
  cycles?: number | null,
  landings?: number | null,
) {
  return [
    h !== null && h !== undefined && `${hours(h * SECONDS_PER_HOUR)} h${basis}`,
    cycles !== null && cycles !== undefined && `${cycles} cycles`,
    landings !== null && landings !== undefined && `${landings} landings`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function compareDue(x: DueItem, y: DueItem) {
  return (
    LEVEL_RANK[x.level] - LEVEL_RANK[y.level] ||
    x.urgency - y.urgency ||
    (x.dueDate ?? "9999").localeCompare(y.dueDate ?? "9999") ||
    x.aircraft.registration.localeCompare(y.aircraft.registration) ||
    x.item.localeCompare(y.item)
  );
}

function remainingText(d: DueItem) {
  const amount = (n: number, unit: string, digits = 0) =>
    n < 0
      ? `${Math.abs(n).toFixed(digits)} ${unit} over`
      : `${n.toFixed(digits)} ${unit} left`;
  return [
    d.hoursLeft !== undefined && amount(d.hoursLeft, "h", 1),
    d.cyclesLeft !== undefined && amount(d.cyclesLeft, "cycles"),
    d.landingsLeft !== undefined && amount(d.landingsLeft, "landings"),
    d.daysLeft !== undefined && amount(d.daysLeft, "days"),
  ]
    .filter(Boolean)
    .join(", ");
}

interface Context {
  s: Snapshot;
  names: Namer;
  clock: Clock;
  today: string;
  due: DueItem[];
  audit: (AuditEntry & { _id?: string })[];
  transferred: Map<string, string[]>;
}

function aircraftSheet(ctx: Context): SheetSpec {
  const fleet = [...ctx.s.aircraft].sort(
    (a, b) =>
      a.program.localeCompare(b.program) ||
      a.registration.localeCompare(b.registration),
  );
  const rows = fleet.map((a) => aircraftRow(a, ctx));
  return {
    name: "Aircraft",
    title: "Aircraft",
    about:
      "Each aircraft with its totals and its status worked out with the app's rules.",
    freezeFirstColumn: true,
    columns: AIRCRAFT_COLUMNS,
    rows,
    count: rows.length,
  };
}

const AIRCRAFT_COLUMNS: Column[] = [
  { header: "Tail number", width: 11 },
  { header: "Make and model", width: 20, fmt: "wrap" },
  { header: "Serial number", width: 14 },
  { header: "Flight Program", width: 20, fmt: "wrap" },
  { header: "Total time (h)", width: 11, fmt: "hours" },
  { header: "Hobbs (h)", width: 10, fmt: "hours" },
  { header: "Tach (h)", width: 10, fmt: "hours" },
  { header: "Cycles", width: 9, fmt: "count" },
  { header: "Landings", width: 9, fmt: "count" },
  { header: "Status", width: 11 },
  { header: "Why", width: 34, fmt: "wrap" },
  { header: "Next item due", width: 38, fmt: "wrap" },
  { header: "Last flight", width: 17, fmt: "datetime" },
];

function aircraftRow(a: Aircraft, { s, clock, today, due }: Context): Row {
  const status = valueOr(() => aircraftStatus(s, a.uuid, today), undefined);
  const total = valueOr(() => totalSeconds(a) / SECONDS_PER_HOUR, undefined);
  const next = due.find((d) => d.aircraft.uuid === a.uuid);
  return {
    cells: [
      a.registration,
      `${a.make} ${a.model}`.trim(),
      a.serial,
      a.program || "(no Flight Program)",
      total,
      a.currentHobbs / SECONDS_PER_HOUR,
      a.currentTach / SECONDS_PER_HOUR,
      a.cycles,
      a.landings,
      status ? aircraftStatusLabels[status.level] : "Unknown",
      status?.reasons.map((r) => r.label).join("\n"),
      next && lines(nextDueLabel(next), remainingText(next)),
      clock.dateTime(a.latestFlightAt),
    ],
    tone: aircraftTone(status),
    statusColumn: 9,
  };
}

function aircraftTone(status: AircraftStatus | undefined): Tone | undefined {
  if (status?.level === "grounded") return "bad";
  if (status?.level === "due-soon") return "warn";
  return status ? "good" : undefined;
}

// "AD 2024-03-01" says what it is; other items get their type in front.
function nextDueLabel(next: DueItem) {
  const kind = next.kind === "AD" ? "" : `${next.kind}: `;
  return `${kind}${next.item} (${next.status})`;
}

function dueSheet({ clock, due }: Context): SheetSpec {
  const rows = due.map((d): Row => ({
    cells: [
      d.status,
      d.aircraft.registration,
      d.kind,
      d.item,
      d.detail,
      clock.date(d.dueDate),
      d.dueAt,
      d.daysLeft,
      d.hoursLeft,
      d.cyclesLeft,
      d.landingsLeft,
    ],
    tone: LEVEL_TONE[d.level],
    statusColumn: 0,
  }));
  return {
    name: "Due list",
    title: "Due list",
    about:
      "Inspections, component limits and AD actions across the fleet, most urgent first. Negative numbers are overdue.",
    columns: DUE_COLUMNS,
    rows,
    count: rows.length,
  };
}

const DUE_COLUMNS: Column[] = [
  { header: "Status", width: 13 },
  { header: "Aircraft", width: 10 },
  { header: "Type", width: 11 },
  { header: "Item", width: 28, fmt: "wrap" },
  { header: "Detail", width: 38, fmt: "wrap" },
  { header: "Due date", width: 12, fmt: "date" },
  { header: "Due at", width: 22, fmt: "wrap" },
  { header: "Days left", width: 8, fmt: "count" },
  { header: "Hours left", width: 8, fmt: "hours" },
  { header: "Cycles left", width: 8, fmt: "count" },
  { header: "Landings left", width: 9, fmt: "count" },
];

function flightSheet({ s, names, clock }: Context): SheetSpec {
  const aircraft = new Map(s.aircraft.map((a) => [a.uuid, a]));
  const flights = [...s.flights].sort(
    (a, b) => Date.parse(b.startTime) - Date.parse(a.startTime),
  );
  const rows = flights.map((f) =>
    flightRow(f, aircraft.get(f.aircraftUuid), names, clock),
  );
  return {
    name: "Flight log",
    title: "Flight log",
    about:
      "Every logged flight, newest first. Hours count only once a flight is accepted.",
    columns: FLIGHT_COLUMNS,
    rows,
    count: rows.length,
  };
}

const FLIGHT_COLUMNS: Column[] = [
  { header: "Date and time", width: 17, fmt: "datetime" },
  { header: "Aircraft", width: 10 },
  { header: "Pilot", width: 17, fmt: "wrap" },
  { header: "Copilot", width: 17, fmt: "wrap" },
  { header: "Route", width: 14, fmt: "wrap" },
  { header: "Hobbs start", width: 10, fmt: "hours" },
  { header: "Hobbs end", width: 10, fmt: "hours" },
  { header: "Tach start", width: 10, fmt: "hours" },
  { header: "Tach end", width: 10, fmt: "hours" },
  { header: "Hours", width: 7, fmt: "hours" },
  { header: "Landings", width: 8, fmt: "count" },
  { header: "Cycles", width: 7, fmt: "count" },
  { header: "Oil added", width: 11, fmt: "wrap" },
  { header: "Review status", width: 12 },
  { header: "Notes", width: 40, fmt: "wrap" },
];
const ENGINE_PREFIX = { single: "", left: "Left ", right: "Right " };

function flightRow(
  f: Flight,
  a: Aircraft | undefined,
  names: Namer,
  clock: Clock,
): Row {
  const flown = valueOr(
    () =>
      a && f.status === "accepted"
        ? flightSeconds(a, f) / SECONDS_PER_HOUR
        : null,
    null,
  );
  const oil = oilAdded(f);
  return {
    cells: [
      clock.dateTime(f.startTime),
      names.tail(f.aircraftUuid),
      names.person(f.pilotId),
      names.person(f.copilotId),
      [f.origin, f.destination].filter(Boolean).join(" → "),
      secondsToHours(f.hobbsOff),
      secondsToHours(f.hobbsOn),
      secondsToHours(f.tachOff),
      secondsToHours(f.tachOn),
      flown,
      f.landings,
      f.cycles,
      oil,
      sentence(flightStatusLabels[f.status] ?? f.status),
      flightNotes(f),
    ],
    tone: flightTone(f.status),
    statusColumn: 13,
  };
}

function oilAdded(f: Flight) {
  return (f.oil ?? [])
    .filter((o) => o.added)
    .map((o) =>
      `${ENGINE_PREFIX[o.engine] ?? ""}${o.added} ${o.unit === "range" ? (o.addedUnit ?? "") : o.unit}`.trim(),
    )
    .join("\n");
}

function flightNotes(f: Flight) {
  return lines(
    f.remarks && `Remarks: ${f.remarks}`,
    f.reviewReason && `Review: ${f.reviewReason}`,
    f.discrepancy && `Discrepancy reported: ${f.discrepancy}`,
    f.dispatchOverride &&
      `Flown despite grounding, approved by ${f.dispatchOverride.name}: ${f.dispatchOverride.reason}`,
  );
}

function flightTone(status: Flight["status"]): Tone | undefined {
  if (status === "review") return "warn";
  return status === "accepted" ? "good" : undefined;
}

function discrepancySheet(ctx: Context): SheetSpec {
  const list = [...ctx.s.discrepancies].sort(
    (a, b) =>
      (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) ||
      b.createdAt - a.createdAt,
  );
  const rows = list.map((d) => discrepancyRow(d, ctx));
  return {
    name: "Discrepancies",
    title: "Discrepancies",
    about:
      "Reported defects, open ones first. Red: grounding or an expired deferral; amber: deferral about to expire.",
    columns: DISCREPANCY_COLUMNS,
    rows,
    count: rows.length,
  };
}

const DISCREPANCY_COLUMNS: Column[] = [
  { header: "Reported", width: 17, fmt: "datetime" },
  { header: "Reported by", width: 17, fmt: "wrap" },
  { header: "Aircraft", width: 10 },
  { header: "Description", width: 42, fmt: "wrap" },
  { header: "Grounding", width: 10 },
  { header: "Deferral", width: 30, fmt: "wrap" },
  { header: "Deferral expires", width: 12, fmt: "date" },
  { header: "Status", width: 13 },
  { header: "Resolved by", width: 17, fmt: "wrap" },
  { header: "Resolved", width: 17, fmt: "datetime" },
  { header: "Resolution", width: 40, fmt: "wrap" },
];

function discrepancyRow(d: Discrepancy, { names, clock, today }: Context): Row {
  const deferral = d.deferral as Deferral | undefined;
  const days = deferral && deferralDaysRemaining(deferral, today);
  const open = d.status === "open";
  const tone = discrepancyTone(d, deferral, days);
  return {
    cells: [
      clock.dateTime(d.createdAt),
      names.person(d.authorId),
      names.tail(d.aircraftUuid),
      d.description,
      d.grounding ? "Yes" : "No",
      deferral &&
        lines(
          deferralLabel(deferral),
          `Placard: ${deferral.placard}`,
          `Deferred by ${deferral.deferredByName} on ${clock.dateText(deferral.deferredOn)}`,
        ),
      clock.date(deferral?.expiresOn),
      open ? (deferral ? "Open, deferred" : "Open") : "Resolved",
      names.person(d.resolvedBy),
      clock.dateTime(d.resolvedAt),
      d.resolution,
    ],
    tone,
    statusColumn: 7,
  };
}

// A deferral turns red once expired and amber within its warning days.
function discrepancyTone(
  d: Discrepancy,
  deferral: Deferral | undefined,
  days: number | undefined,
): Tone | undefined {
  if (d.status !== "open") return "good";
  if (!deferral) return d.grounding ? "bad" : undefined;
  if (days !== undefined && days < 0) return "bad";
  return days !== undefined && days <= DEFERRAL_WARNING_DAYS
    ? "warn"
    : undefined;
}

function workOrderSheet(ctx: Context): SheetSpec {
  const orders = [...(ctx.s.workOrders ?? [])].sort(
    (a, b) =>
      b.dateOpened.localeCompare(a.dateOpened) ||
      b.number.localeCompare(a.number),
  );
  const rows = orders.map((w) => workOrderRow(w, ctx));
  return {
    name: "Work orders",
    title: "Work orders",
    about:
      "Work orders with their requested work, job cards, sign-offs, parts and labour, newest first.",
    freezeFirstColumn: true,
    columns: WORK_ORDER_COLUMNS,
    rows,
    count: rows.length,
  };
}

const WORK_ORDER_COLUMNS: Column[] = [
  { header: "Work order", width: 13 },
  { header: "Aircraft", width: 10 },
  { header: "Opened", width: 12, fmt: "date" },
  { header: "Closed", width: 12, fmt: "date" },
  { header: "Status", width: 12 },
  { header: "Priority", width: 9 },
  { header: "Summary", width: 34, fmt: "wrap" },
  { header: "Requested work", width: 34, fmt: "wrap" },
  { header: "Job cards and sign-offs", width: 44, fmt: "wrap" },
  { header: "Performed by", width: 18, fmt: "wrap" },
  { header: "Parts used", width: 30, fmt: "wrap" },
  { header: "Labour hours", width: 9, fmt: "hours" },
];

function workOrderRow(w: WorkOrder, { s, names, clock }: Context): Row {
  const cards = (s.taskCards ?? [])
    .filter((c) => c.workOrderUuid === w.uuid)
    .sort((a, b) => a.cardNumber.localeCompare(b.cardNumber));
  const performers = valueOr(
    () =>
      w.closeout?.performers ??
      logbookPerformers(s, w, w.status !== "completed"),
    [],
  );
  const labour = valueOr(() => labourHours(s, w), undefined);
  return {
    cells: [
      w.number || "(no number)",
      names.tail(w.aircraftUuid),
      clock.date(w.dateOpened),
      clock.date(w.completionDate),
      sentence(w.status),
      sentence(w.priority),
      lines(
        w.scope,
        w.supervisor && `Supervisor: ${w.supervisor}`,
        w.releaseOutcome && `Release: ${w.releaseOutcome}`,
      ),
      w.tasks
        .map((t, i) => `${i + 1}. ${t.description} (${sentence(t.status)})`)
        .join("\n"),
      cards.map((c) => jobCardText(c, clock)).join("\n"),
      performers.map((p) => p.name).join(", "),
      partsUsedText(cards),
      labour,
    ],
    tone: w.status === "completed" ? "good" : undefined,
    statusColumn: 4,
  };
}

function labourHours(s: Snapshot, w: WorkOrder) {
  const costs = workOrderCosts(s, w);
  return costs.labor.length ? costs.laborSeconds / SECONDS_PER_HOUR : undefined;
}

function jobCardText(c: TaskCard, clock: Clock) {
  return lines(
    `${c.cardNumber} ${c.title} (${sentence(c.status)})`,
    `  ${signoffText("Work", c.technicianSignoff, clock)}`,
    (c.inspectionSignoffRequired || c.inspectionSignoff) &&
      `  ${signoffText("Inspection", c.inspectionSignoff, clock)}`,
    c.actualLabor !== null && `  Actual labour ${c.actualLabor.toFixed(1)} h`,
  );
}

function signoffText(
  label: string,
  sig: TaskCard["technicianSignoff"],
  clock: Clock,
) {
  return sig
    ? `${label} signed by ${sig.name}, ${clock.dateText(sig.at)}`
    : `${label} not signed`;
}

function partsUsedText(cards: TaskCard[]) {
  return cards
    .flatMap((c) => c.partsUsed)
    .map((p) =>
      `${p.quantity} × ${p.partNumber} ${p.description}${p.serialLot ? `, S/N or lot ${p.serialLot}` : ""}`.trim(),
    )
    .join("\n");
}

function adSheet(ctx: Context): SheetSpec {
  const { s, names } = ctx;
  const list = [...(s.airworthiness ?? [])].sort(
    (a, b) =>
      names
        .tail(adAircraftUuid(s, a))
        .localeCompare(names.tail(adAircraftUuid(s, b))) ||
      a.source.number.localeCompare(b.source.number),
  );
  const rows = list.map((r) => adRow(r, ctx));
  return {
    name: "Airworthiness directives",
    title: "Airworthiness directives",
    about:
      "Each AD tracked on an aircraft or component, with its latest compliance and next due.",
    freezeFirstColumn: true,
    columns: AD_COLUMNS,
    rows,
    count: rows.length,
  };
}

const AD_COLUMNS: Column[] = [
  { header: "AD number", width: 16 },
  { header: "Aircraft", width: 10 },
  { header: "Applies to", width: 20, fmt: "wrap" },
  { header: "Subject", width: 30, fmt: "wrap" },
  { header: "Applicability", width: 22, fmt: "wrap" },
  { header: "Status", width: 13, fmt: "wrap" },
  { header: "Method of compliance", width: 32, fmt: "wrap" },
  { header: "Last complied", width: 12, fmt: "date" },
  { header: "Last complied at (h)", width: 11, fmt: "hours" },
  { header: "Complied by", width: 18, fmt: "wrap" },
  { header: "Next due", width: 12, fmt: "date" },
  { header: "Next due at (h)", width: 11, fmt: "hours" },
  { header: "Recurring", width: 18, fmt: "wrap" },
];
function adRow(r: AD, { s, names, clock, today }: Context): Row {
  const c = names.component(r.componentUuid);
  const status = valueOr(() => adStatus(s, r, today), "Unknown");
  const last = effectiveCompliance(r)
    .sort((a, b) => a.date.localeCompare(b.date))
    .at(-1);
  const open = r.tasks.filter((t) =>
    valueOr(() => adTaskStatus(s, r, t, today) !== "Complied", true),
  );
  const dates = open
    .map((t) => t.dueDate)
    .filter(Boolean)
    .sort();
  const dueHours = open
    .map((t) => t.dueHours)
    .filter((h): h is number => h !== null);
  const intervals = adIntervals(r);
  return {
    cells: [
      `AD ${r.source.number}`,
      names.tail(adAircraftUuid(s, r)),
      c ? names.componentName(c) : r.source.section,
      r.source.subject,
      lines(r.applicability, r.reason),
      status,
      ...complianceCells(last, clock),
      clock.date(dates[0]),
      dueHours.length ? Math.min(...dueHours) : undefined,
      lines(r.source.recurring, ...intervals),
    ],
    tone: LEVEL_TONE[adLevel(status)],
    statusColumn: 5,
  };
}

// Method, date, hours and who signed, of the latest compliance.
function complianceCells(last: ADCompliance | undefined, clock: Clock) {
  return [
    last &&
      lines(
        last.method,
        last.serviceBulletin && `Service bulletin: ${last.serviceBulletin}`,
        last.terminatedBy && `Terminated by: ${last.terminatedBy}`,
      ),
    clock.date(last?.date),
    last?.hours ?? undefined,
    last && [last.mechanic, last.certificate].filter(Boolean).join(", "),
  ];
}

function adIntervals(r: AD) {
  return r.tasks
    .map((t) =>
      [
        every(t.intervalHours, "h", 1),
        every(t.intervalDays, "days"),
        every(t.intervalCycles, "cycles"),
        every(t.intervalLandings, "landings"),
      ]
        .filter(Boolean)
        .join(", "),
    )
    .filter(Boolean);
}

function every(n: number | null | undefined, unit: string, digits = 0) {
  return n ? `every ${n.toFixed(digits)} ${unit}` : "";
}

function componentSheet(ctx: Context): SheetSpec {
  const { s } = ctx;
  const records = s.management ?? [];
  const aircraft = new Map(s.aircraft.map((a) => [a.uuid, a]));
  const rows = records
    .filter((r): r is Component => r.kind === "component")
    .map((c) => ({
      c,
      a: c.installed ? aircraft.get(c.aircraftUuid) : undefined,
    }))
    .sort(compareComponentPlaces)
    .flatMap(({ c, a }) => componentRows(c, a, records, ctx));
  return {
    name: "Components",
    title: "Components",
    about:
      "Tracked components on each aircraft and in inventory, one row per life limit or overhaul requirement.",
    freezeFirstColumn: true,
    columns: COMPONENT_COLUMNS,
    rows,
    count: rows.length,
  };
}

const COMPONENT_COLUMNS: Column[] = [
  { header: "Aircraft or location", width: 14, fmt: "wrap" },
  { header: "Component", width: 22, fmt: "wrap" },
  { header: "Part number", width: 14, fmt: "wrap" },
  { header: "Serial number", width: 13, fmt: "wrap" },
  { header: "Position", width: 9 },
  { header: "Time since new (h)", width: 10, fmt: "hours" },
  { header: "Time since overhaul (h)", width: 10, fmt: "hours" },
  { header: "Cycles since new", width: 9, fmt: "count" },
  { header: "Limit", width: 30, fmt: "wrap" },
  { header: "Due at", width: 20, fmt: "wrap" },
  { header: "Hours left", width: 9, fmt: "hours" },
  { header: "Cycles left", width: 8, fmt: "count" },
  { header: "Days left", width: 8, fmt: "count" },
  { header: "Status", width: 12 },
];

// Components on an aircraft the export holds first, by tail number; then by
// type and serial.
function compareComponentPlaces(
  x: { c: Component; a?: Aircraft },
  y: { c: Component; a?: Aircraft },
) {
  return (
    (x.a ? 0 : 1) - (y.a ? 0 : 1) ||
    (x.a?.registration ?? "").localeCompare(y.a?.registration ?? "") ||
    x.c.componentType.localeCompare(y.c.componentType) ||
    x.c.serial.localeCompare(y.c.serial)
  );
}

// One row per limit; a component without limits still gets one row.
function componentRows(
  c: Component,
  a: Aircraft | undefined,
  records: ManagedRecord[],
  ctx: Context,
): Row[] {
  const totals = valueOr(() => componentTotals(c, a, ctx.today), undefined);
  const base = [
    componentPlace(c, a, ctx.names),
    [c.componentType, c.manufacturer, c.model].filter(Boolean).join(", "),
    c.partNumber,
    c.serial,
    c.outForRepair
      ? "Out for repair"
      : sentence((c.installPosition ?? "").toLowerCase()),
    // Untracked dimensions stay blank rather than showing 0.
    c.trackTime ? secondsToHours(totals?.timeSinceNew) : undefined,
    c.trackTime ? secondsToHours(totals?.timeSinceOverhaul) : undefined,
    c.trackCycles ? totals?.cyclesSinceNew : undefined,
  ];
  const limits = records.filter(
    (r): r is ComponentRequirement =>
      r.kind === "componentRequirement" && r.componentUuid === c.uuid,
  );
  if (!limits.length) return [{ cells: [...base] }];
  return limits.map((r) => limitRow(base, r, c, a, ctx));
}

function componentPlace(c: Component, a: Aircraft | undefined, names: Namer) {
  if (a) return a.registration;
  if (c.installed) return "(unknown aircraft)";
  const location = names.location(c.locationUuid);
  return `In inventory${location ? `: ${location}` : ""}`;
}

function limitRow(
  base: Cell[],
  r: ComponentRequirement,
  c: Component,
  a: Aircraft | undefined,
  { clock, today }: Context,
): Row {
  const q = valueOr(() => requirementStatus(r, c, a, today), undefined);
  const dueDate = requirementDueDate(r);
  return {
    cells: [
      ...base,
      `${r.requirementType}: ${r.description}`,
      limitText(r, dueDate, clock),
      secondsToHours(q?.seconds),
      q?.cycles,
      q?.days,
      q?.status ?? "Unknown",
    ],
    tone: q && LEVEL_TONE[requirementLevel(q.status)],
    statusColumn: 13,
  };
}

function limitText(
  r: ComponentRequirement,
  dueDate: string | undefined,
  clock: Clock,
) {
  return [
    r.dueSeconds !== undefined && `${hours(r.dueSeconds)} h ${r.timeBasis}`,
    r.dueCycles !== undefined && `${r.dueCycles} cycles`,
    r.dueLandings !== undefined && `${r.dueLandings} landings`,
    dueDate && clock.dateText(dueDate),
  ]
    .filter(Boolean)
    .join(" · ");
}

function inventorySheet(ctx: Context): SheetSpec {
  const { s, names } = ctx;
  const stock = (s.management ?? [])
    .filter((r): r is Stock => r.kind === "stock")
    .map((r) => ({
      r,
      program: names.program(recordProgram(s, r)),
      location: names.location(r.locationUuid) ?? "(unknown location)",
    }))
    .sort(
      (a, b) =>
        a.program.localeCompare(b.program) ||
        a.location.localeCompare(b.location) ||
        a.r.partNumber.localeCompare(b.r.partNumber),
    );
  const rows = stock.map((x) => stockRow(x.r, x.location, x.program, ctx));
  return {
    name: "Inventory",
    title: "Inventory",
    about:
      "Stock on hand by location, with shelf life and cost. Red: expired; amber: expires within 30 days.",
    freezeFirstColumn: true,
    columns: INVENTORY_COLUMNS,
    rows,
    count: rows.length,
  };
}

const INVENTORY_COLUMNS: Column[] = [
  { header: "Part number", width: 15, fmt: "wrap" },
  { header: "Description", width: 28, fmt: "wrap" },
  { header: "Category", width: 9 },
  { header: "Condition", width: 11 },
  { header: "Location", width: 18, fmt: "wrap" },
  { header: "Quantity", width: 8, fmt: "count" },
  { header: "Reserved", width: 8, fmt: "count" },
  { header: "Minimum", width: 8, fmt: "count" },
  { header: "Expires", width: 12, fmt: "date" },
  { header: "Shelf life", width: 11 },
  { header: "Unit cost (USD)", width: 10, fmt: "money" },
  { header: "Value (USD)", width: 11, fmt: "money" },
  { header: "Vendor", width: 16, fmt: "wrap" },
  { header: "Invoice or PO", width: 14, fmt: "wrap" },
  { header: "Flight Program", width: 18, fmt: "wrap" },
];

function stockRow(
  r: Stock,
  location: string,
  program: string,
  { clock, today }: Context,
): Row {
  const life = shelfLifeStatus(r.expirationDate, today);
  return {
    cells: [
      r.partNumber,
      r.description,
      sentence(r.category),
      sentence(r.condition),
      location,
      r.quantity,
      r.reservedQuantity ?? 0,
      r.minimum,
      clock.date(r.expirationDate),
      shelfLifeText(life, r.expirationDate),
      r.cost,
      r.cost === undefined ? undefined : r.cost * r.quantity,
      r.vendor,
      lines(
        r.invoiceNumber && `Invoice ${r.invoiceNumber}`,
        r.poRef && `PO ${r.poRef}`,
      ),
      program,
    ],
    tone: shelfLifeTone(life, r.expirationDate),
    statusColumn: 9,
  };
}

type ShelfLife = ReturnType<typeof shelfLifeStatus>;

function shelfLifeText(life: ShelfLife, expirationDate?: string) {
  if (life) return shelfLifeLabels[life];
  return expirationDate ? "In date" : "";
}

function shelfLifeTone(
  life: ShelfLife,
  expirationDate?: string,
): Tone | undefined {
  if (life === "expired") return "bad";
  if (life === "soon") return "warn";
  return expirationDate ? "good" : undefined;
}

function purchaseOrderSheet({ s, names, clock }: Context): SheetSpec {
  const orders = [...(s.purchaseOrders ?? [])].sort(
    (a, b) => b.createdAt - a.createdAt,
  );
  const rows = orders.map((p) => purchaseOrderRow(p, names, clock));
  return {
    name: "Purchase orders",
    title: "Purchase orders",
    about: "Orders to vendors with their status and amounts, newest first.",
    freezeFirstColumn: true,
    columns: PURCHASE_ORDER_COLUMNS,
    rows,
    count: rows.length,
  };
}

const PURCHASE_ORDER_COLUMNS: Column[] = [
  { header: "Number", width: 14 },
  { header: "Vendor", width: 20, fmt: "wrap" },
  { header: "Status", width: 14, fmt: "wrap" },
  { header: "Created", width: 17, fmt: "datetime" },
  { header: "Issued", width: 17, fmt: "datetime" },
  { header: "Expected", width: 12, fmt: "date" },
  { header: "Items", width: 46, fmt: "wrap" },
  { header: "Total", width: 12, fmt: "amount" },
  { header: "Currency", width: 9 },
  { header: "For aircraft", width: 12, fmt: "wrap" },
  { header: "Flight Program", width: 18, fmt: "wrap" },
];

function purchaseOrderRow(p: PurchaseOrder, names: Namer, clock: Clock): Row {
  const status = poStatus(p) ?? sentence(p.phase);
  return {
    cells: [
      p.number,
      p.vendor,
      status,
      clock.dateTime(p.createdAt),
      clock.dateTime(p.issuedAt),
      clock.date(p.expectedDate),
      p.lines.map((l) => poLineText(p, l)).join("\n"),
      poTotal(p) / CENTS_PER_DOLLAR,
      p.currency,
      [
        ...new Set(
          p.lines.map((l) => names.tail(l.aircraftUuid)).filter(Boolean),
        ),
      ].join(", "),
      names.program(p.programUuid),
    ],
    tone: ["Received", "Closed"].includes(status) ? "good" : undefined,
    statusColumn: 2,
  };
}

// Receipts show once the order is issued, and stay once it is closed.
function poLineText(p: PurchaseOrder, l: PurchaseOrder["lines"][number]) {
  const text = `${l.quantity} × ${l.partNumber} ${l.description} at ${dollars(l.unitCents)} each`;
  if (p.phase !== "issued" && p.phase !== "closed") return text;
  const got = received(p, l);
  const left = outstanding(p, l);
  return `${text} (received ${got}${left > 0 ? `, ${left} outstanding` : ""})`;
}

function dollars(cents: number) {
  return (cents / CENTS_PER_DOLLAR).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function costSheet(ctx: Context): SheetSpec {
  const orders = [...(ctx.s.workOrders ?? [])].sort((a, b) =>
    b.dateOpened.localeCompare(a.dateOpened),
  );
  const rows = orders.flatMap((w) => costRows(w, ctx));
  return {
    name: "Maintenance costs",
    title: "Maintenance costs",
    about:
      "Labour, parts and other costs recorded against each work order, in US dollars.",
    freezeFirstColumn: true,
    columns: COST_COLUMNS,
    rows,
    count: rows.length,
  };
}

const COST_COLUMNS: Column[] = [
  { header: "Work order", width: 13 },
  { header: "Aircraft", width: 10 },
  { header: "Status", width: 12 },
  { header: "Opened", width: 12, fmt: "date" },
  { header: "Labour hours", width: 9, fmt: "hours" },
  { header: "Labour (USD)", width: 11, fmt: "money" },
  { header: "Parts (USD)", width: 11, fmt: "money" },
  { header: "Other (USD)", width: 11, fmt: "money" },
  { header: "Total (USD)", width: 12, fmt: "money" },
  { header: "Notes", width: 36, fmt: "wrap" },
];

// A work order without costs, or whose costs cannot be worked out, has no row.
function costRows(w: WorkOrder, { s, names, clock }: Context): Row[] {
  const c = valueOr(() => workOrderCosts(s, w), undefined);
  if (!c || (!c.labor.length && !c.other.length && !c.parts.length)) return [];
  const missing = c.missingPartCosts;
  const cells = [
    w.number || "(no number)",
    names.tail(w.aircraftUuid),
    sentence(w.status),
    clock.date(w.dateOpened),
    c.laborSeconds / SECONDS_PER_HOUR,
    c.laborCents / CENTS_PER_DOLLAR,
    c.partsCents / CENTS_PER_DOLLAR,
    c.otherCents / CENTS_PER_DOLLAR,
    c.totalCents / CENTS_PER_DOLLAR,
    lines(
      ...c.other.map(
        (o) =>
          `${o.description}: $${(o.amountCents / CENTS_PER_DOLLAR).toFixed(2)}`,
      ),
      missing > 0 &&
        `${missing} part${missing === 1 ? " has" : "s have"} no cost recorded`,
    ),
  ];
  return [{ cells }];
}

function peopleSheet({ s, names }: Context): SheetSpec {
  const groups = new Map(s.groups.map((g) => [g.id, g]));
  const people = [...s.members].sort((a, b) => a.name.localeCompare(b.name));
  const rows = people.map((m) => personRow(m, groups, s.aircraft, names));
  return {
    name: "People and access",
    title: "People and access",
    about:
      "Every account, whether it can sign in, and what its permission groups allow on which aircraft.",
    freezeFirstColumn: true,
    columns: PEOPLE_COLUMNS,
    rows,
    count: rows.length,
  };
}

const PEOPLE_COLUMNS: Column[] = [
  { header: "Name", width: 22, fmt: "wrap" },
  { header: "Email", width: 28, fmt: "wrap" },
  { header: "Account", width: 10 },
  { header: "System administrator", width: 13 },
  { header: "Flight Programs", width: 24, fmt: "wrap" },
  { header: "Groups, permissions and aircraft", width: 70, fmt: "wrap" },
];

function personRow(
  m: Member,
  groups: Map<string, Group>,
  aircraft: Aircraft[],
  names: Namer,
): Row {
  const own = m.groupIds
    .map((id) => groups.get(id))
    .filter((g): g is Group => !!g)
    .sort(
      (a, b) =>
        names
          .program(a.programUuid)
          .localeCompare(names.program(b.programUuid)) ||
        a.name.localeCompare(b.name),
    );
  const programs = own.map((g) => names.program(g.programUuid));
  return {
    cells: [
      m.name,
      m.email,
      m.active ? "Active" : "Disabled",
      m.isAdmin ? "Yes" : "No",
      [...new Set(programs.filter(Boolean))].join("\n"),
      own.map((g) => groupText(g, aircraft, names)).join("\n"),
    ],
  };
}

function groupText(g: Group, aircraft: Aircraft[], names: Namer) {
  const permissions = g.permissions.map((p) => PERMISSION_LABELS[p] ?? p);
  return (
    `${names.program(g.programUuid) || "No Flight Program"}: ${g.name}` +
    (g.programAdmin ? " (Flight Program administrator)" : "") +
    (g.owner ? " (aircraft owner)" : "") +
    ` · ${permissions.join(", ")}` +
    ` · ${groupFleet(g, aircraft)}`
  );
}

function groupFleet(g: Group, aircraft: Aircraft[]) {
  if (g.programAdmin || listsAllAircraft(g)) return "all program aircraft";
  const tails = aircraft
    .filter(
      (a) => a.programUuid === g.programUuid && groupCoversAircraft(g, a.uuid),
    )
    .map((a) => a.registration)
    .sort();
  return tails.length ? tails.join(", ") : "no aircraft";
}

// ----------------------------------------------------- change history --

// Personal licence and account numbers stay out too, as on every sheet.
const SECRET_KEY =
  /pass(word)?|secret|token|api_?key|credential|^key$|private|hash|sha256|storage_?id|catalogId|url$|^image$|licen[cs]eNumber|accountNumber/i;
const SECONDS_KEY =
  /seconds$|^(current|baseline)?(hobbs|tach|cyclicHobbs|flightTimeLog)(On|Off)?$|^timeSince(New|Overhaul|Repair)$/i;
const EPOCH_KEY = /(^at$|At$|Time$)/;
// An "…At" or "…Time" number reads as a time only as epoch milliseconds
// (1973 to 5138); seconds and counts stay numbers.
const MIN_EPOCH_MS = 1e11;
const MAX_EPOCH_MS = 1e14;
const SKIP_IN_SUMMARY = new Set(["version", "updatedAt", "recordedAt"]);
// What changed shows this many fields, each cut to this many characters;
// the full before and after are in the next column.
const SUMMARY_MAX_CHANGES = 8;
const SUMMARY_MAX_LENGTH = 200;

type Leaf = (key: string, v: unknown) => string;
type ChangeWriter = ReturnType<typeof changeWriter>;

function fieldName(key: string) {
  const base = key
    .replace(/(Uuids?|Ids?)$/, "")
    .replace(/Seconds$/, "")
    .replace(/Cents$/, "");
  const words = base
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .toLowerCase()
    .trim();
  const name = words.charAt(0).toUpperCase() + words.slice(1);
  return SECONDS_KEY.test(key) ? `${name} (h)` : name;
}

// Change-log values as people read them: secrets removed, IDs named, numbers
// and dates in the workbook's units and zone.
function changeWriter(names: Namer, clock: Clock, storageIds: Set<string>) {
  const scrubText = (v: string) => scrubString(v, names, storageIds);
  const scrub = (v: unknown) => scrubValue(v, scrubText);
  const leaf: Leaf = (key, v) => leafText(key, v, clock);
  return {
    parse: (text?: string) => parseChange(text, scrub, scrubText),
    summary: (before: unknown, after: unknown) =>
      changeSummary(before, after, leaf),
    detail: (before: unknown, after: unknown) =>
      changeDetail(before, after, leaf),
    // Text that is not JSON keeps its punctuation; each quoted piece is
    // hidden or named as a change-log value would be.
    stored(payload: StoredPayload) {
      if (payload.kind === "missing") return "(no payload)";
      if (payload.kind === "text")
        return payload.text.split('"').map(scrubText).join('"');
      return renderValue(scrub(payload.value), leaf).join("\n");
    },
  };
}

// Encrypted values and password hashes are hidden, stored files and Convex
// links are not shown, and an ID becomes its record's name.
function scrubString(v: string, names: Namer, storageIds: Set<string>) {
  if (v.startsWith("enc:") || /^\$(argon2|2[aby]\$|scrypt)/.test(v))
    return "[hidden]";
  if (storageIds.has(v)) return "[file]";
  if (/convex\.(cloud|site)|\/api\/storage\//i.test(v)) return "[link removed]";
  return names.entities.get(v) ?? v;
}

// Removes secret fields and replaces IDs with names, recursively.
function scrubValue(v: unknown, scrubText: (v: string) => string): unknown {
  if (typeof v === "string") return scrubText(v);
  if (Array.isArray(v)) return v.map((x) => scrubValue(x, scrubText));
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>)
      .filter(([k]) => !SECRET_KEY.test(k))
      .map(([k, x]) => [k, scrubValue(x, scrubText)]),
  );
}

// A value that is not JSON is shown as scrubbed text.
function parseChange(
  text: string | undefined,
  scrub: (v: unknown) => unknown,
  scrubText: (v: string) => string,
) {
  if (text === undefined) return undefined;
  try {
    return scrub(JSON.parse(text));
  } catch {
    return scrubText(text);
  }
}

function leafText(key: string, v: unknown, clock: Clock): string {
  if (v === null || v === undefined || v === "") return "(blank)";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return numberText(key, v, clock);
  if (typeof v === "string")
    return /^\d{4}-\d{2}-\d{2}$/.test(v) ? clock.dateText(v) : v;
  if (!Array.isArray(v)) return "(details)";
  return v.every((x) => x === null || typeof x !== "object")
    ? v.map((x) => leafText(key, x, clock)).join(", ") || "(none)"
    : `${v.length} item${v.length === 1 ? "" : "s"}`;
}

function numberText(key: string, v: number, clock: Clock) {
  if (SECONDS_KEY.test(key)) return `${hours(v)} h`;
  if (/Cents$/.test(key)) return `$${(v / CENTS_PER_DOLLAR).toFixed(2)}`;
  if (EPOCH_KEY.test(key) && v > MIN_EPOCH_MS && v < MAX_EPOCH_MS)
    return clock.dateTimeText(v);
  return String(v);
}

function changeSummary(before: unknown, after: unknown, leaf: Leaf) {
  if (before === undefined && after === undefined) return "";
  if (isPlain(before) || isPlain(after)) {
    if (before === undefined) return `Set: ${leaf("", after)}`;
    if (after === undefined) return `Removed: ${leaf("", before)}`;
    return `${leaf("", before)} → ${leaf("", after)}`;
  }
  const changes = fieldChanges(before, after, leaf);
  const shown = changes
    .slice(0, SUMMARY_MAX_CHANGES)
    .map((c) =>
      c.length > SUMMARY_MAX_LENGTH
        ? c.slice(0, SUMMARY_MAX_LENGTH - 1) + "…"
        : c,
    );
  if (changes.length > shown.length)
    shown.push(`… and ${changes.length - shown.length} more`);
  return shown.join("\n");
}

function isPlain(v: unknown) {
  return v !== undefined && (!v || typeof v !== "object" || Array.isArray(v));
}

// One line per field whose value changed, in field order.
function fieldChanges(before: unknown, after: unknown, leaf: Leaf) {
  const a = flattenFields(before);
  const b = flattenFields(after);
  const changes: string[] = [];
  for (const path of new Set([...a.keys(), ...b.keys()])) {
    const [key, x] = a.get(path) ?? b.get(path)!;
    const old = a.get(path)?.[1];
    const y = b.get(path)?.[1];
    if (SKIP_IN_SUMMARY.has(key) || JSON.stringify(old) === JSON.stringify(y))
      continue;
    const label = path.split(".").map(fieldName).join(" › ");
    const named = (v: unknown) => namedLeaf(key, v, leaf);
    if (before === undefined) changes.push(`${label}: ${named(x)}`);
    else if (after === undefined)
      changes.push(`${label}: ${named(old)} (removed)`);
    else changes.push(`${label}: ${named(old)} → ${named(y)}`);
  }
  return changes;
}

// A raw ID tells a reader nothing; the detail column keeps it.
function namedLeaf(key: string, v: unknown, leaf: Leaf) {
  const s = leaf(key, v);
  return idLike(s) ? "(unknown record)" : s;
}

// Leaf values by dotted path, with the last key; a list is one leaf.
function flattenFields(
  v: unknown,
  path: string[] = [],
  out = new Map<string, [string, unknown]>(),
) {
  if (v && typeof v === "object" && !Array.isArray(v))
    for (const [k, x] of Object.entries(v as Record<string, unknown>))
      flattenFields(x, [...path, k], out);
  else if (path.length) out.set(path.join("."), [path.at(-1)!, v]);
  return out;
}

function changeDetail(before: unknown, after: unknown, leaf: Leaf) {
  return [
    before !== undefined &&
      ["Before:", ...renderValue(before, leaf, "", "  ")].join("\n"),
    after !== undefined &&
      ["After:", ...renderValue(after, leaf, "", "  ")].join("\n"),
  ]
    .filter(Boolean)
    .join("\n");
}

// Objects, and lists of objects, go on indented lines of their own.
function renderValue(v: unknown, leaf: Leaf, key = "", indent = ""): string[] {
  if (Array.isArray(v) && v.some(isObject))
    return v.flatMap((x, i) => [
      `${indent}${i + 1}.`,
      ...renderValue(x, leaf, key, indent + "  "),
    ]);
  if (!isObject(v) || Array.isArray(v)) return [`${indent}${leaf(key, v)}`];
  return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) =>
    isNested(x)
      ? [`${indent}${fieldName(k)}:`, ...renderValue(x, leaf, k, indent + "  ")]
      : [`${indent}${fieldName(k)}: ${leaf(k, x)}`],
  );
}

function isObject(x: unknown) {
  return !!x && typeof x === "object";
}

function isNested(x: unknown) {
  return isObject(x) && (!Array.isArray(x) || x.some(isObject));
}

function* historyRows(
  ctx: Context,
  writer: ChangeWriter,
  from: number,
  to: number,
): Generator<Row> {
  const { names, clock, audit, transferred, s } = ctx;
  const aircraft = new Map(s.aircraft.map((a) => [a.uuid, a]));
  for (let i = from; i < to; i++) {
    const e = audit[i];
    const before = writer.parse(e.before);
    const after = writer.parse(e.after);
    const program =
      names.program(e.programUuid) ||
      names.program(aircraft.get(e.aircraftUuid ?? "")?.programUuid);
    const also = (e._id ? (transferred.get(e._id) ?? []) : [])
      .map((p) => names.program(p))
      .filter((p) => p && p !== program);
    yield {
      cells: [
        clock.dateTime(e.at),
        names.person(e.actorId),
        lines(
          program,
          also.length > 0 &&
            `Also listed in ${also.join(", ")} after a transfer`,
        ),
        names.tail(e.aircraftUuid),
        names.entity(e.entityUuid),
        auditActionLabel(e.action),
        e.reason,
        writer.summary(before, after),
        writer.detail(before, after),
      ],
    };
  }
}

const HISTORY_COLUMNS: Column[] = [
  { header: "When", width: 17, fmt: "datetime" },
  { header: "Who", width: 17, fmt: "wrap" },
  { header: "Flight Program", width: 16, fmt: "wrap" },
  { header: "Aircraft", width: 10 },
  { header: "Record", width: 26, fmt: "wrap" },
  { header: "Action", width: 22, fmt: "wrap" },
  { header: "Reason", width: 28, fmt: "wrap" },
  { header: "What changed", width: 44, fmt: "wrap" },
  { header: "Full before and after", width: 60, fmt: "wrap" },
];

// --------------------------------------------------------- damaged records --

const RECORD_LABELS: Record<RecordCollection, string> = {
  management: "inventory and component",
  airworthiness: "AD",
  workOrders: "work order",
  taskCards: "job card",
  costs: "cost",
  purchaseOrders: "purchase order",
  partsRequests: "parts request",
};
const DAMAGE_NOTES: Record<StoredPayload["kind"], string> = {
  json: "Does not match the app's current format.",
  text: "Not JSON; shown as the stored text.",
  missing: "The row has no payload.",
};

// One note per record type, in the order the records are listed.
function damageWarnings(damaged: DamagedRecord[]) {
  const counts = new Map<RecordCollection, number>();
  for (const d of damaged)
    counts.set(d.collection, (counts.get(d.collection) ?? 0) + 1);
  return [...counts].map(
    ([collection, n]) =>
      `${n} ${RECORD_LABELS[collection]} record${n === 1 ? "" : "s"} did not match the app's current format; shown as stored on the Damaged records sheet.`,
  );
}

function damagedSheet(
  damaged: DamagedRecord[],
  writer: ChangeWriter,
): SheetSpec {
  return {
    name: "Damaged records",
    title: "Damaged records",
    about:
      "Records that no longer match the app's format, as stored, so no other sheet shows them.",
    columns: [
      { header: "Record type", width: 22, fmt: "wrap" },
      { header: "Note", width: 30, fmt: "wrap" },
      { header: "As stored", width: 80, fmt: "wrap" },
    ],
    rows: damaged.map((d) => ({
      cells: [
        sentence(RECORD_LABELS[d.collection]),
        DAMAGE_NOTES[d.payload.kind],
        writer.stored(d.payload),
      ],
    })),
    count: damaged.length,
  };
}

// ----------------------------------------------------------------- build --

// What the colours mean, for Read me.
const COLOUR_LEGEND: [Tone, string, string][] = [
  ["bad", "Overdue, grounded or expired", "Red rows need action now."],
  [
    "warn",
    "Due soon",
    "Amber rows come due soon (for example within 10 hours or 30 days).",
  ],
  ["good", "OK", "Green marks a status that is in order."],
];
const INTRO_FACTS: [string, string][] = [
  [
    "What this file is",
    "A readable copy of the Angel One maintenance-records system, made automatically every night from the same export as the encrypted backup. It opens in Excel, Numbers or Google Sheets.",
  ],
  [
    "Official records",
    "This copy is for reading only. The official records are the aircraft logbooks and the encrypted backup kept in Cloudflare R2. If this file disagrees with them, they are right. Changes made here are not saved anywhere else.",
  ],
];
const TABLES_FACT: [string, string] = [
  "Using the tables",
  "Every sheet has filter buttons on its header row. Hours are shown to one decimal place; negative numbers in the 'left' columns are overdue.",
];

/**
 * Builds the records workbook from a Convex export ZIP and writes it to
 * `options.out`.
 *
 * @param zipPath - The Convex snapshot export.
 * @param options - Where to write, the time zone, and what Read me shows.
 * @returns Rows per sheet, and the notes shown on Read me.
 * @throws {RangeError} For a time zone Intl does not know.
 * @throws {Error} From ./convexExport, when the ZIP is not a readable export.
 */
export async function buildRecordsWorkbook(
  zipPath: string,
  options: WorkbookOptions,
): Promise<WorkbookSummary> {
  const now = options.now ?? Date.now();
  const clock = zoneClock(options.timeZone);
  const today = clock.today(now);
  const decoded = await readExportSnapshot(zipPath, now);
  const { damaged } = decoded;
  const warnings = damageWarnings(damaged);
  const { ctx, writer } = recordsContext(decoded, clock, today);
  const history = historySheets(ctx, writer, options.maxRowsPerSheet);
  const sheets: SheetSpec[] = [
    ...recordSheets(ctx),
    ...history,
    ...(damaged.length ? [damagedSheet(damaged, writer)] : []),
  ];
  const made = clock.dateTimeText(now);
  const facts = readMeFacts(ctx, options.deployment, made, {
    storageFiles: decoded.storageFiles,
    parts: history.length,
    warnings,
  });
  const written = await writeWorkbook({
    out: options.out,
    now,
    made,
    subtitle: `Times in ${clock.name} · status as of ${clock.dateText(today)} · copy for reading; the logbooks and encrypted backup are the records`,
    readMe: {
      title: "Angel One records: readable copy",
      facts,
      legend: COLOUR_LEGEND,
    },
    sheets,
  });
  return { sheets: written, warnings };
}

// What every sheet reads: the snapshot with names, the due list, and the
// change history newest first (the export orders it by document ID).
function recordsContext(decoded: ExportSnapshot, clock: Clock, today: string) {
  const { snapshot: s, programs, transferred } = decoded;
  const names = namer(s, programs, decoded.labels, clock);
  const audit = decoded.audit.sort((a, b) => b.at - a.at);
  const writer = changeWriter(names, clock, decoded.storageIds);
  const due = dueList(s, today, names);
  const ctx: Context = { s, names, clock, today, due, audit, transferred };
  return { ctx, writer };
}

function recordSheets(ctx: Context): SheetSpec[] {
  return [
    aircraftSheet(ctx),
    dueSheet(ctx),
    flightSheet(ctx),
    discrepancySheet(ctx),
    workOrderSheet(ctx),
    adSheet(ctx),
    componentSheet(ctx),
    inventorySheet(ctx),
    purchaseOrderSheet(ctx),
    costSheet(ctx),
    peopleSheet(ctx),
  ];
}

// One Excel sheet holds at most MAX_DATA_ROWS rows, so a long change history
// is split across sheets; there is always at least one.
function historySheets(
  ctx: Context,
  writer: ChangeWriter,
  maxRowsPerSheet: number | undefined,
): SheetSpec[] {
  const max = Math.max(1, maxRowsPerSheet ?? MAX_DATA_ROWS);
  const parts = Math.max(1, Math.ceil(ctx.audit.length / max));
  return Array.from({ length: parts }, (_, i): SheetSpec => {
    const from = i * max;
    const to = Math.min(ctx.audit.length, from + max);
    const name =
      parts === 1 ? "Change history" : `Change history ${i + 1} of ${parts}`;
    return {
      name,
      title: name,
      about:
        parts === 1
          ? "Every change the app recorded, newest first: who, when, what and why."
          : `Every change the app recorded, newest first (part ${i + 1} of ${parts}).`,
      columns: HISTORY_COLUMNS,
      rows: historyRows(ctx, writer, from, to),
      count: to - from,
    };
  });
}

function readMeFacts(
  { clock, today, audit }: Context,
  deployment: string,
  made: string,
  copy: { storageFiles: number; parts: number; warnings: string[] },
): [string, string][] {
  const zone = `${clock.name} (${clock.zone})`;
  const newest = audit[0]?.at;
  return [
    ...INTRO_FACTS,
    ["Made", `${made} ${clock.name}`],
    ["From deployment", deployment],
    [
      "Time zone",
      `All dates and times are ${zone}. Statuses (overdue, due soon) were worked out on ${clock.dateText(today)} with the app's own rules.`,
    ],
    [
      "Newest change recorded",
      newest
        ? `${clock.dateTimeText(newest)} ${clock.name}`
        : "No changes recorded",
    ],
    ["Not in this copy", notInCopyText(copy.storageFiles)],
    TABLES_FACT,
    ...(copy.parts > 1 ? [historySplitFact(copy.parts)] : []),
    ...copy.warnings.map((w): [string, string] => ["Note", w]),
  ];
}

function notInCopyText(storageFiles: number) {
  const files =
    storageFiles === 1
      ? " (manual, photo or attachment) is"
      : "s (manuals, photos and attachments) are";
  return `Passwords, sign-in records, saved credentials and file links are never included. ${storageFiles} uploaded file${files} kept only in the encrypted backup.`;
}

function historySplitFact(parts: number): [string, string] {
  return [
    "Change history",
    `Change history is split across ${parts} sheets because one Excel sheet holds at most ${MAX_DATA_ROWS.toLocaleString("en-US")} rows.`,
  ];
}

/**
 * The command line: `--zip <export> --out <file.xlsx> [--tz <IANA zone>]
 * [--deployment <name>]`. Sets the process time zone to `--tz`, then prints
 * the sheets written and any notes.
 *
 * @param argv - The arguments after the script name.
 * @throws {Error} The usage line when --zip or --out is missing; 'Unknown
 *   time zone "<tz>". Use an IANA name such as America/New_York.'
 */
export async function main(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      zip: { type: "string" },
      out: { type: "string" },
      tz: { type: "string", default: "America/New_York" },
      deployment: { type: "string", default: "production" },
    },
  });
  if (!values.zip || !values.out)
    throw new Error(
      "Usage: node scripts/backup/records-workbook.mjs --zip <convex export zip> --out <file.xlsx> [--tz America/New_York] [--deployment <name>]",
    );
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: values.tz });
  } catch {
    throw new Error(
      `Unknown time zone "${values.tz}". Use an IANA name such as America/New_York.`,
    );
  }
  // The domain's "today" is the local date; make local mean the chosen zone.
  process.env.TZ = values.tz;
  const summary = await buildRecordsWorkbook(values.zip, {
    out: values.out,
    timeZone: values.tz!,
    deployment: values.deployment!,
  });
  console.log(
    `Wrote ${values.out}: ${summary.sheets.map((s) => `${s.name} ${s.rows}`).join(", ")}.`,
  );
  for (const w of summary.warnings) console.log(`Note: ${w}`);
}
