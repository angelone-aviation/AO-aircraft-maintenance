/**
 * Responsibility: Builds the readable records copy (ADR-0011), one formatted
 *   Excel workbook, from the nightly Convex export.
 * Layer: Script. Node only: reads the export ZIP, writes one .xlsx file.
 * Dependencies: ./convexExport, ./xlsxWriter, convex/collections (decoding),
 *   src/domain (statuses, labels and rules).
 *
 * It is a convenience copy for administrators, inspectors and board members;
 * the aircraft logbooks and the encrypted R2 backup (ADR-0008) are the
 * records. Every status and label comes from src/domain, so the workbook says
 * what the app says. Only allow-listed tables are read: sign-in data,
 * credentials, stored files and request bookkeeping never reach the workbook.
 */
import { parseArgs } from "node:util";
import { exportContents, readDocuments } from "./convexExport";
import {
  decodeLenient,
  type PayloadCollection,
  type StoredRecord,
} from "../../convex/collections";
import {
  aircraftStatus,
  aircraftStatusLabels,
  DEFERRAL_WARNING_DAYS,
} from "../../src/domain/aircraftStatus";
import {
  adAircraftUuid,
  adCounters,
  adStatus,
  adTaskStatus,
  effectiveCompliance,
} from "../../src/domain/airworthiness";
import { auditActionLabel } from "../../src/domain/auditHistory";
import {
  componentTotals,
  requirementDueDate,
  requirementStatus,
  type Component,
  type ComponentRequirement,
} from "../../src/domain/components";
import { flightSeconds, workOrderCosts } from "../../src/domain/costs";
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
  inspectionStatus,
  inspectionStatusLabels,
} from "../../src/domain/maintenance";
import { inspectionCounters, type Stock } from "../../src/domain/management";
import {
  hours,
  totalSeconds,
  type Aircraft,
  type AuditEntry,
  type Discrepancy,
  type Flight,
  type Group,
  type Inspection,
  type Member,
  type Snapshot,
} from "../../src/domain/model";
import { groupCoversAircraft, recordProgram } from "../../src/domain/programs";
import {
  outstanding,
  poStatus,
  poTotal,
  received,
} from "../../src/domain/purchaseOrders";
import { shelfLifeLabels, shelfLifeStatus } from "../../src/domain/shelfLife";
import type { TaskCard } from "../../src/domain/taskCards";
import { logbookPerformers } from "../../src/domain/workOrderCloseout";
import {
  MAX_DATA_ROWS,
  writeWorkbook,
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

// ---------------------------------------------------------------- reading --

type Doc = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const payloadOf = (d: Doc) => JSON.parse(String(d.payload)) as unknown;
// Tables read from the export, with the fields kept from each document.
// Anything not listed here (sign-in tables, credentials, stored-file tables,
// upload staging, request and job bookkeeping) is never decompressed.
const TABLES: Record<string, (d: Doc) => Doc> = {
  programs: (d) => ({ uuid: d.uuid, name: d.name }),
  users: (d) => ({
    _id: d._id,
    name: d.name,
    email: d.email,
    active: d.active,
    isAdmin: d.isAdmin,
    groupIds: d.groupIds,
  }),
  groups: (d) => d,
  aircraft: (d) => d,
  flights: (d) => d,
  discrepancies: (d) => d,
  inspections: (d) => d,
  management: (d) => ({ payload: d.payload }),
  airworthiness: (d) => ({ payload: d.payload }),
  workOrders: (d) => ({ payload: d.payload }),
  taskCards: (d) => ({ payload: d.payload }),
  costs: (d) => ({ payload: d.payload }),
  purchaseOrders: (d) => ({ payload: d.payload }),
  partsRequests: (d) => ({ payload: d.payload }),
  audit: (d) => d,
  transferredAudit: (d) => ({ programUuid: d.programUuid, auditId: d.auditId }),
  // Names only, for the Record column of Change history.
  manuals: (d) => ({ uuid: d.uuid, label: `Manual: ${str(d.title) ?? ""}` }),
  checklists: (d) => {
    const p = payloadOf(d) as {
      document?: { payload?: { metadata?: { name?: string } } };
    };
    return {
      uuid: d.uuid,
      label: `Checklist: ${p.document?.payload?.metadata?.name ?? ""}`,
    };
  },
  inspectionTemplates: (d) => ({
    uuid: d.uuid,
    label: `Inspection template: ${(payloadOf(d) as { name?: string }).name ?? ""}`,
  }),
  flightPlans: (d) => {
    const p = payloadOf(d) as { origin?: string; destination?: string };
    return {
      uuid: d.uuid,
      label: `Flight plan ${p.origin ?? ""} → ${p.destination ?? ""}`,
    };
  },
};

async function loadExport(zipPath: string) {
  const contents = await exportContents(zipPath);
  const tables = new Map<string, Doc[]>();
  for (const [table, pick] of Object.entries(TABLES)) {
    const rows: Doc[] = [];
    const entry = contents.tables.get(table);
    if (entry) await readDocuments(zipPath, entry, (d) => rows.push(pick(d)));
    tables.set(table, rows);
  }
  // Storage IDs only, to scrub any that appear in change-log values.
  const storageIds = new Set<string>();
  if (contents.storageIndex)
    await readDocuments(zipPath, contents.storageIndex, (d) => {
      if (typeof d._id === "string") storageIds.add(d._id);
    });
  return { tables, storageIds, storageFiles: contents.storageFiles };
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
  const fields = (epoch: number) =>
    Object.fromEntries(
      parts
        .formatToParts(new Date(epoch))
        .map((p) => [p.type, Number(p.value)]),
    ) as Record<string, number>;
  const wall = (epoch: number) => {
    const p = fields(epoch);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  };
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longGeneric" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value ?? timeZone;
  const textDate = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const ymd = (text?: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text ?? "");
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : undefined;
  };
  return {
    zone: timeZone,
    name,
    /** Excel keeps wall-clock time; exceljs writes a Date's UTC fields. */
    dateTime(epoch?: number | string) {
      const ms = typeof epoch === "string" ? Date.parse(epoch) : epoch;
      if (ms === undefined || !Number.isFinite(ms)) return undefined;
      return new Date(wall(ms) + (ms % 1000));
    },
    date(text?: string) {
      const ms = ymd(text);
      return ms === undefined ? undefined : new Date(ms);
    },
    today(epoch: number) {
      return new Date(wall(epoch)).toISOString().slice(0, 10);
    },
    dateText(value?: number | string) {
      const ms =
        typeof value === "number" ? wall(value) : (ymd(value) ?? undefined);
      return ms === undefined ? "" : textDate.format(new Date(ms));
    },
    dateTimeText(epoch: number) {
      const w = new Date(wall(epoch));
      return `${textDate.format(w)} ${w.toISOString().slice(11, 16)}`;
    },
  };
}
type Clock = ReturnType<typeof zoneClock>;

// ------------------------------------------------------------ the records --

type Level = "overdue" | "due-soon" | "unknown" | "ok";
const levelTone: Record<Level, Tone | undefined> = {
  overdue: "bad",
  "due-soon": "warn",
  unknown: undefined,
  ok: "good",
};
const levelRank: Record<Level, number> = {
  overdue: 0,
  "due-soon": 1,
  unknown: 2,
  ok: 3,
};
interface DueItem {
  level: Level;
  status: string;
  aircraft: Aircraft;
  kind: "Inspection" | "Component" | "AD";
  item: string;
  detail: string;
  dueDate?: string;
  dueAt: string;
  daysLeft?: number;
  hoursLeft?: number;
  cyclesLeft?: number;
  landingsLeft?: number;
  urgency: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Convex document IDs: 31–37 lowercase base-32 characters.
const CONVEX_ID = /^[0-9a-z]{31,37}$/;
const idLike = (s: string) => UUID.test(s) || CONVEX_ID.test(s);
const lines = (...xs: (string | false | null | undefined)[]) =>
  xs.filter(Boolean).join("\n");
const sentence = (s: string) =>
  s ? s.charAt(0).toUpperCase() + s.slice(1).replaceAll("-", " ") : "";
const secondsToHours = (s: number | null | undefined) =>
  s === null || s === undefined ? undefined : s / 3600;
const permissionLabels: Record<string, string> = {
  read: "read",
  flight: "add flights",
  discrepancy: "report discrepancies",
  resolve: "resolve discrepancies",
  maintenance: "manage maintenance",
};

// A system administrator's view of every program, aircraft and record. Payload
// rows decode through the app's codec; one that no longer matches its schema
// is shown as stored, with a note on Read me.
function decode(tables: Map<string, Doc[]>, now: number) {
  const warnings: string[] = [];
  const t = (name: string) => tables.get(name) ?? [];
  const programs = new Map(
    t("programs").map((p) => [String(p.uuid), String(p.name ?? "")]),
  );
  const snapshot: Snapshot = {
    ...recordsCopyView(programs, now),
    groups: t("groups").map(decodeGroup),
    members: t("users").map(decodeMember),
    aircraft: t("aircraft").map((a) => decodeAircraft(a, programs)),
    flights: t("flights") as unknown as Flight[],
    discrepancies: t("discrepancies") as unknown as Discrepancy[],
    inspections: t("inspections") as unknown as Inspection[],
    audit: [],
    ...decodeRecords(t, warnings),
  };
  const audit = t("audit") as unknown as (AuditEntry & { _id?: string })[];
  const transferred = new Map<string, string[]>();
  for (const x of t("transferredAudit")) {
    const id = String(x.auditId);
    transferred.set(id, [
      ...(transferred.get(id) ?? []),
      String(x.programUuid),
    ]);
  }
  const labels = ["manuals", "checklists", "inspectionTemplates", "flightPlans"]
    .flatMap((name) => t(name))
    .map((d) => [String(d.uuid), String(d.label)] as const);
  return { snapshot, programs, audit, transferred, labels, warnings };
}

function recordsCopyView(programs: Map<string, string>, now: number) {
  return {
    user: {
      id: "records-copy",
      name: "Records copy",
      email: "",
      active: true,
      isAdmin: true,
      groupIds: [],
    },
    authenticatedAt: now,
    syncedAt: now,
    programs: [...programs].map(([uuid, name]) => ({
      uuid,
      name,
      version: 0,
      address: "",
      email: "",
      contactName: "",
      website: "",
    })),
  };
}

function decodeMember(u: Doc): Member {
  return {
    id: String(u._id),
    name: str(u.name)?.trim() || "Unnamed user",
    email: str(u.email) ?? "",
    active: u.active === true,
    isAdmin: u.isAdmin === true,
    groupIds: (u.groupIds as string[] | undefined) ?? [],
  };
}

function decodeGroup(g: Doc): Group {
  return {
    id: String(g._id),
    programUuid: str(g.programUuid),
    programAdmin: g.programAdmin as boolean | undefined,
    owner: g.owner as boolean | undefined,
    name: String(g.name ?? ""),
    aircraftIds: (g.aircraftIds as string[] | undefined) ?? [],
    permissions: (g.permissions as Group["permissions"] | undefined) ?? [],
  };
}

// The program's current name, which the aircraft's stored copy may predate.
function decodeAircraft(a: Doc, programs: Map<string, string>): Aircraft {
  const programUuid = str(a.programUuid);
  return {
    ...(a as unknown as Aircraft),
    program:
      (programUuid && programs.get(programUuid)) || String(a.program ?? ""),
  };
}

// Warnings come in this order on Read me.
function decodeRecords(t: (name: string) => Doc[], warnings: string[]) {
  return {
    management: parsed(
      "management",
      t("management"),
      "inventory and component",
      warnings,
    ),
    airworthiness: parsed("airworthiness", t("airworthiness"), "AD", warnings),
    workOrders: parsed("workOrders", t("workOrders"), "work order", warnings),
    taskCards: parsed("taskCards", t("taskCards"), "job card", warnings),
    archivedTaskCards: [],
    costs: parsed("costs", t("costs"), "cost", warnings),
    purchaseOrders: parsed(
      "purchaseOrders",
      t("purchaseOrders"),
      "purchase order",
      warnings,
    ),
    partsRequests: parsed(
      "partsRequests",
      t("partsRequests"),
      "parts request",
      warnings,
    ),
  };
}

function parsed<N extends PayloadCollection>(
  collection: N,
  docs: Doc[],
  label: string,
  warnings: string[],
): StoredRecord<N>[] {
  let failed = 0;
  const out = docs.map((d) => {
    const value = d.payload === undefined ? d : payloadOf(d);
    const result = decodeLenient(collection, value);
    if (result.valid) return result.record;
    failed++;
    return result.stored as StoredRecord<N>;
  });
  if (failed)
    warnings.push(
      `${failed} ${label} record${failed === 1 ? "" : "s"} did not match the app's current format; shown as stored, and their status may be missing.`,
    );
  return out;
}

// Names people recognise in place of IDs.
function namer(
  s: Snapshot,
  programs: Map<string, string>,
  extra: readonly (readonly [string, string])[],
  clock: Clock,
) {
  const aircraft = new Map(s.aircraft.map((a) => [a.uuid, a]));
  const members = new Map(s.members.map((m) => [m.id, m]));
  const sameName = new Map<string, number>();
  for (const m of s.members)
    sameName.set(m.name, (sameName.get(m.name) ?? 0) + 1);
  const records = s.management ?? [];
  const component = (uuid?: string) =>
    records.find(
      (r): r is Component => r.kind === "component" && r.uuid === uuid,
    );
  const componentName = (c: Component) =>
    [
      c.componentType,
      c.partNumber && `P/N ${c.partNumber}`,
      c.serial && `S/N ${c.serial}`,
    ]
      .filter(Boolean)
      .join(" ");
  const location = (uuid?: string) => {
    const r = records.find((x) => x.kind === "location" && x.uuid === uuid);
    return r?.kind === "location" ? r.name : undefined;
  };
  const tail = (uuid?: string) =>
    uuid ? (aircraft.get(uuid)?.registration ?? "(unknown aircraft)") : "";
  const person = (id?: string) => {
    if (!id) return "";
    if (id === "system") return "The system (automatic)";
    const m = members.get(id);
    if (!m) return "(unknown person)";
    return (sameName.get(m.name) ?? 0) > 1 && m.email
      ? `${m.name} (${m.email})`
      : m.name;
  };
  const program = (uuid?: string) =>
    uuid ? (programs.get(uuid) ?? "(unknown Flight Program)") : "";
  const short = (text: string, n = 60) =>
    text.length > n ? text.slice(0, n - 1).trimEnd() + "…" : text;
  const entities = new Map<string, string>(extra);
  const set = (id: string | undefined, label: string) => {
    if (id) entities.set(id, label);
  };
  for (const [uuid, name] of programs) set(uuid, `Flight Program ${name}`);
  for (const g of s.groups)
    set(g.id, `Group ${g.name} (${program(g.programUuid) || "no program"})`);
  for (const f of s.flights)
    set(
      f.uuid,
      `Flight ${tail(f.aircraftUuid)} ${clock.dateText(Date.parse(f.startTime))}`,
    );
  for (const d of s.discrepancies)
    set(d.uuid, `Discrepancy: ${short(d.description)}`);
  for (const i of s.inspections)
    set(i.uuid, `Inspection: ${i.reference || short(i.description)}`);
  for (const r of records) {
    if (r.kind === "component") set(r.uuid, `Component ${componentName(r)}`);
    else if (r.kind === "componentRequirement") {
      const c = component(r.componentUuid);
      set(
        r.uuid,
        `Component limit: ${r.description}${c ? ` (${componentName(c)})` : ""}`,
      );
    } else if (r.kind === "componentMovement") {
      const c = component(r.componentUuid);
      set(
        r.uuid,
        `Component ${sentence(r.action.toLowerCase())}${c ? ` (${componentName(c)})` : ""}`,
      );
    } else if (r.kind === "stock")
      set(r.uuid, `Stock ${r.partNumber} ${r.description}`);
    else if (r.kind === "location") set(r.uuid, `Location ${r.name}`);
    else set(r.uuid, `Vendor ${r.name}`);
  }
  for (const r of s.airworthiness ?? []) {
    set(r.uuid, `AD ${r.source.number}`);
    for (const t of r.tasks)
      set(t.uuid, `AD ${r.source.number} action: ${short(t.description)}`);
    for (const h of r.history)
      set(h.uuid, `AD ${r.source.number} compliance of ${h.date}`);
  }
  for (const w of s.workOrders ?? []) {
    const number = w.number || "(no number)";
    set(w.uuid, `Work order ${number}`);
    for (const t of w.tasks)
      set(t.uuid, `Work order ${number} item: ${short(t.description)}`);
  }
  for (const c of s.taskCards ?? []) {
    set(c.uuid, `Job card ${c.cardNumber} ${short(c.title)}`.trim());
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
  for (const c of s.costs ?? [])
    set(
      c.uuid,
      c.kind === "workOrder"
        ? `Costs of ${entities.get(c.workOrderUuid) ?? "a work order"}`
        : c.kind === "budget"
          ? `Budget ${c.year} ${tail(c.aircraftUuid)}`
          : `Labour rate (${program(c.programUuid)})`,
    );
  // Aircraft, people and programs last: their own names win.
  for (const m of s.members) set(m.id, person(m.id));
  for (const a of s.aircraft) set(a.uuid, a.registration);
  for (const [uuid, name] of programs) set(uuid, name);
  const entity = (id: string) =>
    entities.get(id) ?? (idLike(id) ? "(unknown record)" : id);
  return {
    tail,
    person,
    program,
    entity,
    entities,
    component,
    componentName,
    location,
  };
}
type Namer = ReturnType<typeof namer>;

// ------------------------------------------------------------- the sheets --

function dueItems(s: Snapshot, today: string, names: Namer): DueItem[] {
  const items: DueItem[] = [];
  const urgency = (r: {
    daysLeft?: number;
    hoursLeft?: number;
    cyclesLeft?: number;
    landingsLeft?: number;
  }) =>
    inspectionDueLimit({
      daysRemaining: r.daysLeft,
      hoursRemaining: r.hoursLeft,
      cyclesRemaining: r.cyclesLeft,
      landingsRemaining: r.landingsLeft,
    })?.urgency ?? Number.POSITIVE_INFINITY;
  const dueAt = (
    h: number | null | undefined,
    basis: string,
    cycles?: number | null,
    landings?: number | null,
  ) =>
    [
      h !== null && h !== undefined && `${hours(h * 3600)} h${basis}`,
      cycles !== null && cycles !== undefined && `${cycles} cycles`,
      landings !== null && landings !== undefined && `${landings} landings`,
    ]
      .filter(Boolean)
      .join(" · ");
  const aircraft = new Map(s.aircraft.map((a) => [a.uuid, a]));
  for (const i of s.inspections) {
    const a = aircraft.get(i.aircraftUuid);
    if (i.archived || !a) continue;
    const c = names.component(i.componentUuid);
    const base = {
      aircraft: a,
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
    try {
      const st = inspectionStatus(
        i,
        a,
        today,
        inspectionCounters(i, a, s.management),
      );
      const left = {
        daysLeft: st.daysRemaining,
        hoursLeft: st.hoursRemaining,
        cyclesLeft: st.cyclesRemaining,
        landingsLeft: st.landingsRemaining,
      };
      items.push({
        ...base,
        ...left,
        level:
          st.status === "overdue"
            ? "overdue"
            : st.status === "due-soon"
              ? "due-soon"
              : st.status === "scheduled"
                ? "ok"
                : "unknown",
        status: inspectionStatusLabels[st.status],
        urgency: urgency(left),
      });
    } catch (e) {
      items.push({
        ...base,
        detail: lines(base.detail, e instanceof Error && e.message),
        level: "unknown",
        status: inspectionStatusLabels.unknown,
        urgency: Number.POSITIVE_INFINITY,
      });
    }
  }
  for (const r of s.management ?? []) {
    if (r.kind !== "componentRequirement") continue;
    const c = names.component(r.componentUuid);
    const a = c?.installed ? aircraft.get(c.aircraftUuid) : undefined;
    if (!c || !a) continue;
    const base = {
      aircraft: a,
      kind: "Component" as const,
      item: names.componentName(c),
      detail: `${r.requirementType}: ${r.description}`,
      dueDate: requirementDueDate(r),
      dueAt: dueAt(
        secondsToHours(r.dueSeconds),
        ` ${r.timeBasis}`,
        r.dueCycles,
        r.dueLandings,
      ),
    };
    try {
      const q = requirementStatus(r, c, a, today);
      const left = {
        daysLeft: q.days,
        hoursLeft: secondsToHours(q.seconds),
        cyclesLeft: q.cycles,
        landingsLeft: q.landings,
      };
      items.push({
        ...base,
        ...left,
        level:
          q.status === "Past due" || q.status === "Due now"
            ? "overdue"
            : q.status === "Due soon"
              ? "due-soon"
              : q.status === "Tracked"
                ? "ok"
                : "unknown",
        status: q.status,
        urgency: urgency(left),
      });
    } catch (e) {
      items.push({
        ...base,
        detail: lines(base.detail, e instanceof Error && e.message),
        level: "unknown",
        status: "Unknown",
        urgency: Number.POSITIVE_INFINITY,
      });
    }
  }
  for (const r of s.airworthiness ?? []) {
    if (["Not applicable", "Superseded"].includes(r.applicability)) continue;
    const a = aircraft.get(adAircraftUuid(s, r));
    const c = names.component(r.componentUuid);
    if (!a || (c && !c.installed)) continue;
    const counters = adCounters(s, r);
    for (const task of r.tasks) {
      const status = adTaskStatus(s, r, task, today);
      if (status === "Complied") continue;
      const hoursOk = counters && task.dueHours !== null && (!c || c.trackTime);
      const cyclesOk =
        counters && task.dueCycles !== null && (!c || c.trackCycles);
      const left = {
        daysLeft: task.dueDate
          ? Math.round((Date.parse(task.dueDate) - Date.parse(today)) / 864e5)
          : undefined,
        hoursLeft: hoursOk
          ? Math.round((task.dueHours! - counters.hours) * 3600) / 3600
          : undefined,
        cyclesLeft: cyclesOk ? task.dueCycles! - counters.cycles : undefined,
        landingsLeft:
          counters && task.dueLandings != null
            ? task.dueLandings - counters.landings
            : undefined,
      };
      items.push({
        aircraft: a,
        kind: "AD",
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
        level:
          status === "Overdue"
            ? "overdue"
            : status === "Due soon"
              ? "due-soon"
              : status === "Scheduled"
                ? "ok"
                : "unknown",
        status,
        urgency: urgency(left),
      });
    }
  }
  return items.sort(
    (x, y) =>
      levelRank[x.level] - levelRank[y.level] ||
      x.urgency - y.urgency ||
      (x.dueDate ?? "9999").localeCompare(y.dueDate ?? "9999") ||
      x.aircraft.registration.localeCompare(y.aircraft.registration) ||
      x.item.localeCompare(y.item),
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

function aircraftSheet({ s, clock, today, due }: Context): SheetSpec {
  const fleet = [...s.aircraft].sort(
    (a, b) =>
      a.program.localeCompare(b.program) ||
      a.registration.localeCompare(b.registration),
  );
  const rows = fleet.map((a): Row => {
    let status;
    try {
      status = aircraftStatus(s, a.uuid, today);
    } catch {
      status = undefined;
    }
    let total;
    try {
      total = totalSeconds(a) / 3600;
    } catch {
      total = undefined;
    }
    const next = due.find((d) => d.aircraft.uuid === a.uuid);
    return {
      cells: [
        a.registration,
        `${a.make} ${a.model}`.trim(),
        a.serial,
        a.program || "(no Flight Program)",
        total,
        a.currentHobbs / 3600,
        a.currentTach / 3600,
        a.cycles,
        a.landings,
        status ? aircraftStatusLabels[status.level] : "Unknown",
        status?.reasons.map((r) => r.label).join("\n"),
        next &&
          lines(
            `${next.kind === "AD" ? "" : `${next.kind}: `}${next.item} (${next.status})`,
            remainingText(next),
          ),
        clock.dateTime(a.latestFlightAt),
      ],
      tone:
        status?.level === "grounded"
          ? "bad"
          : status?.level === "due-soon"
            ? "warn"
            : status
              ? "good"
              : undefined,
      statusColumn: 9,
    };
  });
  return {
    name: "Aircraft",
    title: "Aircraft",
    about:
      "Each aircraft with its totals and its status worked out with the app's rules.",
    freezeFirstColumn: true,
    columns: [
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
    ],
    rows,
    count: rows.length,
  };
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
    tone: levelTone[d.level],
    statusColumn: 0,
  }));
  return {
    name: "Due list",
    title: "Due list",
    about:
      "Inspections, component limits and AD actions across the fleet, most urgent first. Negative numbers are overdue.",
    columns: [
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
    ],
    rows,
    count: rows.length,
  };
}

function flightSheet({ s, names, clock }: Context): SheetSpec {
  const aircraft = new Map(s.aircraft.map((a) => [a.uuid, a]));
  const flights = [...s.flights].sort(
    (a, b) => Date.parse(b.startTime) - Date.parse(a.startTime),
  );
  const engine = { single: "", left: "Left ", right: "Right " };
  const rows = flights.map((f): Row => {
    const a = aircraft.get(f.aircraftUuid);
    let flown;
    try {
      flown = a && f.status === "accepted" ? flightSeconds(a, f) / 3600 : null;
    } catch {
      flown = null;
    }
    const oil = (f.oil ?? [])
      .filter((o) => o.added)
      .map((o) =>
        `${engine[o.engine] ?? ""}${o.added} ${o.unit === "range" ? (o.addedUnit ?? "") : o.unit}`.trim(),
      )
      .join("\n");
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
        lines(
          f.remarks && `Remarks: ${f.remarks}`,
          f.reviewReason && `Review: ${f.reviewReason}`,
          f.discrepancy && `Discrepancy reported: ${f.discrepancy}`,
          f.dispatchOverride &&
            `Flown despite grounding, approved by ${f.dispatchOverride.name}: ${f.dispatchOverride.reason}`,
        ),
      ],
      tone:
        f.status === "review"
          ? "warn"
          : f.status === "accepted"
            ? "good"
            : undefined,
      statusColumn: 13,
    };
  });
  return {
    name: "Flight log",
    title: "Flight log",
    about:
      "Every logged flight, newest first. Hours count only once a flight is accepted.",
    columns: [
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
    ],
    rows,
    count: rows.length,
  };
}

function discrepancySheet({ s, names, clock, today }: Context): SheetSpec {
  const list = [...s.discrepancies].sort(
    (a, b) =>
      (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) ||
      b.createdAt - a.createdAt,
  );
  const rows = list.map((d): Row => {
    const deferral = d.deferral as Deferral | undefined;
    const days = deferral && deferralDaysRemaining(deferral, today);
    const open = d.status === "open";
    const tone: Tone | undefined = !open
      ? "good"
      : deferral
        ? days !== undefined && days < 0
          ? "bad"
          : days !== undefined && days <= DEFERRAL_WARNING_DAYS
            ? "warn"
            : undefined
        : d.grounding
          ? "bad"
          : undefined;
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
  });
  return {
    name: "Discrepancies",
    title: "Discrepancies",
    about:
      "Reported defects, open ones first. Red: grounding or an expired deferral; amber: deferral about to expire.",
    columns: [
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
    ],
    rows,
    count: rows.length,
  };
}

function workOrderSheet({ s, names, clock }: Context): SheetSpec {
  const orders = [...(s.workOrders ?? [])].sort(
    (a, b) =>
      b.dateOpened.localeCompare(a.dateOpened) ||
      b.number.localeCompare(a.number),
  );
  const signed = (label: string, sig: TaskCard["technicianSignoff"]) =>
    sig
      ? `${label} signed by ${sig.name}, ${clock.dateText(sig.at)}`
      : `${label} not signed`;
  const rows = orders.map((w): Row => {
    const cards = (s.taskCards ?? [])
      .filter((c) => c.workOrderUuid === w.uuid)
      .sort((a, b) => a.cardNumber.localeCompare(b.cardNumber));
    let performers: { name: string }[] = [];
    try {
      performers =
        w.closeout?.performers ??
        logbookPerformers(s, w, w.status !== "completed");
    } catch {
      performers = [];
    }
    let labour;
    try {
      const costs = workOrderCosts(s, w);
      labour = costs.labor.length ? costs.laborSeconds / 3600 : undefined;
    } catch {
      labour = undefined;
    }
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
        cards
          .map((c) =>
            lines(
              `${c.cardNumber} ${c.title} (${sentence(c.status)})`,
              `  ${signed("Work", c.technicianSignoff)}`,
              (c.inspectionSignoffRequired || c.inspectionSignoff) &&
                `  ${signed("Inspection", c.inspectionSignoff)}`,
              c.actualLabor !== null &&
                `  Actual labour ${c.actualLabor.toFixed(1)} h`,
            ),
          )
          .join("\n"),
        performers.map((p) => p.name).join(", "),
        cards
          .flatMap((c) => c.partsUsed)
          .map((p) =>
            `${p.quantity} × ${p.partNumber} ${p.description}${p.serialLot ? `, S/N or lot ${p.serialLot}` : ""}`.trim(),
          )
          .join("\n"),
        labour,
      ],
      tone: w.status === "completed" ? "good" : undefined,
      statusColumn: 4,
    };
  });
  return {
    name: "Work orders",
    title: "Work orders",
    about:
      "Work orders with their requested work, job cards, sign-offs, parts and labour, newest first.",
    freezeFirstColumn: true,
    columns: [
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
    ],
    rows,
    count: rows.length,
  };
}

function adSheet({ s, names, clock, today }: Context): SheetSpec {
  const list = [...(s.airworthiness ?? [])].sort(
    (a, b) =>
      names
        .tail(adAircraftUuid(s, a))
        .localeCompare(names.tail(adAircraftUuid(s, b))) ||
      a.source.number.localeCompare(b.source.number),
  );
  const every = (n: number | null | undefined, unit: string, digits = 0) =>
    n ? `every ${n.toFixed(digits)} ${unit}` : "";
  const rows = list.map((r): Row => {
    const c = names.component(r.componentUuid);
    let status: string;
    try {
      status = adStatus(s, r);
    } catch {
      status = "Unknown";
    }
    const history = effectiveCompliance(r).sort((a, b) =>
      a.date.localeCompare(b.date),
    );
    const last = history.at(-1);
    const open = r.tasks.filter((t) => {
      try {
        return adTaskStatus(s, r, t, today) !== "Complied";
      } catch {
        return true;
      }
    });
    const dates = open
      .map((t) => t.dueDate)
      .filter(Boolean)
      .sort();
    const dueHours = open
      .map((t) => t.dueHours)
      .filter((h): h is number => h !== null);
    const intervals = r.tasks
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
    return {
      cells: [
        `AD ${r.source.number}`,
        names.tail(adAircraftUuid(s, r)),
        c ? names.componentName(c) : r.source.section,
        r.source.subject,
        lines(r.applicability, r.reason),
        status,
        last &&
          lines(
            last.method,
            last.serviceBulletin && `Service bulletin: ${last.serviceBulletin}`,
            last.terminatedBy && `Terminated by: ${last.terminatedBy}`,
          ),
        clock.date(last?.date),
        last?.hours ?? undefined,
        last && [last.mechanic, last.certificate].filter(Boolean).join(", "),
        clock.date(dates[0]),
        dueHours.length ? Math.min(...dueHours) : undefined,
        lines(r.source.recurring, ...intervals),
      ],
      tone:
        status === "Overdue"
          ? "bad"
          : status === "Due soon"
            ? "warn"
            : [
                  "Scheduled",
                  "Complied",
                  "Previously Complied With (PCW)",
                ].includes(status)
              ? "good"
              : undefined,
      statusColumn: 5,
    };
  });
  return {
    name: "Airworthiness directives",
    title: "Airworthiness directives",
    about:
      "Each AD tracked on an aircraft or component, with its latest compliance and next due.",
    freezeFirstColumn: true,
    columns: [
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
    ],
    rows,
    count: rows.length,
  };
}

function componentSheet({ s, names, clock, today }: Context): SheetSpec {
  const records = s.management ?? [];
  const aircraft = new Map(s.aircraft.map((a) => [a.uuid, a]));
  const components = records
    .filter((r): r is Component => r.kind === "component")
    .map((c) => ({
      c,
      a: c.installed ? aircraft.get(c.aircraftUuid) : undefined,
    }))
    .sort(
      (x, y) =>
        (x.a ? 0 : 1) - (y.a ? 0 : 1) ||
        (x.a?.registration ?? "").localeCompare(y.a?.registration ?? "") ||
        x.c.componentType.localeCompare(y.c.componentType) ||
        x.c.serial.localeCompare(y.c.serial),
    );
  const rows: Row[] = [];
  for (const { c, a } of components) {
    let totals;
    try {
      totals = componentTotals(c, a, today);
    } catch {
      totals = undefined;
    }
    const where = a
      ? a.registration
      : c.installed
        ? "(unknown aircraft)"
        : `In inventory${names.location(c.locationUuid) ? `: ${names.location(c.locationUuid)}` : ""}`;
    const base = [
      where,
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
    if (!limits.length) rows.push({ cells: [...base] });
    for (const r of limits) {
      let q;
      try {
        q = requirementStatus(r, c, a, today);
      } catch {
        q = undefined;
      }
      const level: Level = !q
        ? "unknown"
        : q.status === "Past due" || q.status === "Due now"
          ? "overdue"
          : q.status === "Due soon"
            ? "due-soon"
            : q.status === "Tracked"
              ? "ok"
              : "unknown";
      const dueDate = requirementDueDate(r);
      rows.push({
        cells: [
          ...base,
          `${r.requirementType}: ${r.description}`,
          [
            r.dueSeconds !== undefined &&
              `${hours(r.dueSeconds)} h ${r.timeBasis}`,
            r.dueCycles !== undefined && `${r.dueCycles} cycles`,
            r.dueLandings !== undefined && `${r.dueLandings} landings`,
            dueDate && clock.dateText(dueDate),
          ]
            .filter(Boolean)
            .join(" · "),
          secondsToHours(q?.seconds),
          q?.cycles,
          q?.days,
          q?.status ?? "Unknown",
        ],
        tone: levelTone[level],
        statusColumn: 13,
      });
    }
  }
  return {
    name: "Components",
    title: "Components",
    about:
      "Tracked components on each aircraft and in inventory, one row per life limit or overhaul requirement.",
    freezeFirstColumn: true,
    columns: [
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
    ],
    rows,
    count: rows.length,
  };
}

function inventorySheet({ s, names, clock, today }: Context): SheetSpec {
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
  const rows = stock.map(({ r, program, location }): Row => {
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
        life ? shelfLifeLabels[life] : r.expirationDate ? "In date" : "",
        r.cost,
        r.cost === undefined ? undefined : r.cost * r.quantity,
        r.vendor,
        [
          r.invoiceNumber && `Invoice ${r.invoiceNumber}`,
          r.poRef && `PO ${r.poRef}`,
        ]
          .filter(Boolean)
          .join("\n"),
        program,
      ],
      tone:
        life === "expired"
          ? "bad"
          : life === "soon"
            ? "warn"
            : r.expirationDate
              ? "good"
              : undefined,
      statusColumn: 9,
    };
  });
  return {
    name: "Inventory",
    title: "Inventory",
    about:
      "Stock on hand by location, with shelf life and cost. Red: expired; amber: expires within 30 days.",
    freezeFirstColumn: true,
    columns: [
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
    ],
    rows,
    count: rows.length,
  };
}

function purchaseOrderSheet({ s, names, clock }: Context): SheetSpec {
  const orders = [...(s.purchaseOrders ?? [])].sort(
    (a, b) => b.createdAt - a.createdAt,
  );
  const rows = orders.map((p): Row => {
    const status = poStatus(p) ?? sentence(p.phase);
    const money = (cents: number) =>
      (cents / 100).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    return {
      cells: [
        p.number,
        p.vendor,
        status,
        clock.dateTime(p.createdAt),
        clock.dateTime(p.issuedAt),
        clock.date(p.expectedDate),
        p.lines
          .map(
            (l) =>
              `${l.quantity} × ${l.partNumber} ${l.description} at ${money(l.unitCents)} each` +
              (p.phase === "issued" || p.phase === "closed"
                ? ` (received ${received(p, l)}${outstanding(p, l) > 0 ? `, ${outstanding(p, l)} outstanding` : ""})`
                : ""),
          )
          .join("\n"),
        poTotal(p) / 100,
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
  });
  return {
    name: "Purchase orders",
    title: "Purchase orders",
    about: "Orders to vendors with their status and amounts, newest first.",
    freezeFirstColumn: true,
    columns: [
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
    ],
    rows,
    count: rows.length,
  };
}

function costSheet({ s, names, clock }: Context): SheetSpec {
  const orders = [...(s.workOrders ?? [])].sort((a, b) =>
    b.dateOpened.localeCompare(a.dateOpened),
  );
  const rows: Row[] = [];
  for (const w of orders) {
    let c;
    try {
      c = workOrderCosts(s, w);
    } catch {
      continue;
    }
    if (!c.labor.length && !c.other.length && !c.parts.length) continue;
    rows.push({
      cells: [
        w.number || "(no number)",
        names.tail(w.aircraftUuid),
        sentence(w.status),
        clock.date(w.dateOpened),
        c.laborSeconds / 3600,
        c.laborCents / 100,
        c.partsCents / 100,
        c.otherCents / 100,
        c.totalCents / 100,
        lines(
          ...c.other.map(
            (o) => `${o.description}: $${(o.amountCents / 100).toFixed(2)}`,
          ),
          c.missingPartCosts > 0 &&
            `${c.missingPartCosts} part${c.missingPartCosts === 1 ? " has" : "s have"} no cost recorded`,
        ),
      ],
    });
  }
  return {
    name: "Maintenance costs",
    title: "Maintenance costs",
    about:
      "Labour, parts and other costs recorded against each work order, in US dollars.",
    freezeFirstColumn: true,
    columns: [
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
    ],
    rows,
    count: rows.length,
  };
}

function peopleSheet({ s, names }: Context): SheetSpec {
  const groups = new Map(s.groups.map((g) => [g.id, g]));
  const fleet = (g: Group) => {
    if (g.programAdmin || listsAllAircraft(g)) return "all program aircraft";
    const tails = s.aircraft
      .filter(
        (a) =>
          a.programUuid === g.programUuid && groupCoversAircraft(g, a.uuid),
      )
      .map((a) => a.registration)
      .sort();
    return tails.length ? tails.join(", ") : "no aircraft";
  };
  const people = [...s.members].sort((a, b) => a.name.localeCompare(b.name));
  const rows = people.map((m): Row => {
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
    return {
      cells: [
        m.name,
        m.email,
        m.active ? "Active" : "Disabled",
        m.isAdmin ? "Yes" : "No",
        [
          ...new Set(
            own.map((g) => names.program(g.programUuid)).filter(Boolean),
          ),
        ].join("\n"),
        own
          .map(
            (g) =>
              `${names.program(g.programUuid) || "No Flight Program"}: ${g.name}` +
              (g.programAdmin ? " (Flight Program administrator)" : "") +
              (g.owner ? " (aircraft owner)" : "") +
              ` · ${g.permissions.map((p) => permissionLabels[p] ?? p).join(", ")}` +
              ` · ${fleet(g)}`,
          )
          .join("\n"),
      ],
    };
  });
  return {
    name: "People and access",
    title: "People and access",
    about:
      "Every account, whether it can sign in, and what its permission groups allow on which aircraft.",
    freezeFirstColumn: true,
    columns: [
      { header: "Name", width: 22, fmt: "wrap" },
      { header: "Email", width: 28, fmt: "wrap" },
      { header: "Account", width: 10 },
      { header: "System administrator", width: 13 },
      { header: "Flight Programs", width: 24, fmt: "wrap" },
      { header: "Groups, permissions and aircraft", width: 70, fmt: "wrap" },
    ],
    rows,
    count: rows.length,
  };
}

// ----------------------------------------------------- change history --

const SECRET_KEY =
  /pass(word)?|secret|token|api_?key|credential|^key$|private|hash|sha256|storage_?id|catalogId|url$|^image$/i;
const SECONDS_KEY =
  /seconds$|^(current|baseline)?(hobbs|tach|cyclicHobbs|flightTimeLog)(On|Off)?$|^timeSince(New|Overhaul|Repair)$/i;
const EPOCH_KEY = /(^at$|At$|Time$)/;
const SKIP_IN_SUMMARY = new Set(["version", "updatedAt", "recordedAt"]);

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

function changeWriter(names: Namer, clock: Clock, storageIds: Set<string>) {
  const scrubText = (v: string) => {
    if (v.startsWith("enc:") || /^\$(argon2|2[aby]\$|scrypt)/.test(v))
      return "[hidden]";
    if (storageIds.has(v)) return "[file]";
    if (/convex\.(cloud|site)|\/api\/storage\//i.test(v))
      return "[link removed]";
    return names.entities.get(v) ?? v;
  };
  // Removes secret fields and replaces IDs with names, recursively.
  const scrub = (v: unknown): unknown => {
    if (typeof v === "string") return scrubText(v);
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([k]) => !SECRET_KEY.test(k))
          .map(([k, x]) => [k, scrub(x)]),
      );
    return v;
  };
  const leaf = (key: string, v: unknown): string => {
    if (v === null || v === undefined || v === "") return "(blank)";
    if (typeof v === "boolean") return v ? "Yes" : "No";
    if (typeof v === "number") {
      if (SECONDS_KEY.test(key)) return `${hours(v)} h`;
      if (/Cents$/.test(key)) return `$${(v / 100).toFixed(2)}`;
      if (EPOCH_KEY.test(key) && v > 1e11 && v < 1e14)
        return clock.dateTimeText(v);
      return String(v);
    }
    if (typeof v === "string")
      return /^\d{4}-\d{2}-\d{2}$/.test(v) ? clock.dateText(v) : v;
    if (Array.isArray(v))
      return v.every((x) => x === null || typeof x !== "object")
        ? v.map((x) => leaf(key, x)).join(", ") || "(none)"
        : `${v.length} item${v.length === 1 ? "" : "s"}`;
    return "(details)";
  };
  const flatten = (
    v: unknown,
    path: string[] = [],
    out = new Map<string, [string, unknown]>(),
  ) => {
    if (v && typeof v === "object" && !Array.isArray(v))
      for (const [k, x] of Object.entries(v as Record<string, unknown>))
        flatten(x, [...path, k], out);
    else if (path.length) out.set(path.join("."), [path.at(-1)!, v]);
    return out;
  };
  const label = (path: string) => path.split(".").map(fieldName).join(" › ");
  const parse = (text?: string) => {
    if (text === undefined) return undefined;
    try {
      return scrub(JSON.parse(text));
    } catch {
      return scrubText(text);
    }
  };
  const summary = (before: unknown, after: unknown) => {
    const a = flatten(before),
      b = flatten(after);
    const changes: string[] = [];
    if (before === undefined && after === undefined) return "";
    const plain = (v: unknown) =>
      v !== undefined && (!v || typeof v !== "object" || Array.isArray(v));
    if (plain(before) || plain(after)) {
      if (before === undefined) return `Set: ${leaf("", after)}`;
      if (after === undefined) return `Removed: ${leaf("", before)}`;
      return `${leaf("", before)} → ${leaf("", after)}`;
    }
    // A raw ID tells a reader nothing; the detail column keeps it.
    const named = (key: string, v: unknown) => {
      const s = leaf(key, v);
      return idLike(s) ? "(unknown record)" : s;
    };
    for (const path of new Set([...a.keys(), ...b.keys()])) {
      const [key, x] = a.get(path) ?? b.get(path)!;
      if (SKIP_IN_SUMMARY.has(key)) continue;
      const y = b.get(path)?.[1];
      const old = a.get(path)?.[1];
      if (JSON.stringify(old) === JSON.stringify(y)) continue;
      changes.push(
        before === undefined
          ? `${label(path)}: ${named(key, x)}`
          : after === undefined
            ? `${label(path)}: ${named(key, old)} (removed)`
            : `${label(path)}: ${named(key, old)} → ${named(key, y)}`,
      );
    }
    const shown = changes
      .slice(0, 8)
      .map((c) => (c.length > 200 ? c.slice(0, 199) + "…" : c));
    if (changes.length > shown.length)
      shown.push(`… and ${changes.length - shown.length} more`);
    return shown.join("\n");
  };
  const render = (v: unknown, key = "", indent = ""): string[] => {
    if (Array.isArray(v) && v.some((x) => x && typeof x === "object"))
      return v.flatMap((x, i) => [
        `${indent}${i + 1}.`,
        ...render(x, key, indent + "  "),
      ]);
    if (v && typeof v === "object" && !Array.isArray(v))
      return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) =>
        x &&
        typeof x === "object" &&
        !(Array.isArray(x) && !x.some((y) => y && typeof y === "object"))
          ? [`${indent}${fieldName(k)}:`, ...render(x, k, indent + "  ")]
          : [`${indent}${fieldName(k)}: ${leaf(k, x)}`],
      );
    return [`${indent}${leaf(key, v)}`];
  };
  const detail = (before: unknown, after: unknown) =>
    [
      before !== undefined &&
        ["Before:", ...render(before, "", "  ")].join("\n"),
      after !== undefined && ["After:", ...render(after, "", "  ")].join("\n"),
    ]
      .filter(Boolean)
      .join("\n");
  return { scrub, parse, summary, detail };
}

function* historyRows(
  ctx: Context,
  writer: ReturnType<typeof changeWriter>,
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

const historyColumns: Column[] = [
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

/**
 * Builds the records workbook from a Convex export ZIP and writes it to
 * `options.out`.
 *
 * @param zipPath - The Convex snapshot export.
 * @returns Rows per sheet, and the notes shown on Read me.
 * @throws {Error} From ./convexExport, when the ZIP is not a readable export.
 */
export async function buildRecordsWorkbook(
  zipPath: string,
  options: WorkbookOptions,
): Promise<WorkbookSummary> {
  const now = options.now ?? Date.now();
  const clock = zoneClock(options.timeZone);
  const today = clock.today(now);
  const { tables, storageIds, storageFiles } = await loadExport(zipPath);
  const decoded = decode(tables, now);
  const { snapshot: s, programs, transferred, warnings } = decoded;
  const names = namer(s, programs, decoded.labels, clock);
  // Newest first; the export order is by document ID, not by time.
  const audit = decoded.audit.sort((a, b) => b.at - a.at);
  const writer = changeWriter(names, clock, storageIds);
  const ctx: Context = {
    s,
    names,
    clock,
    today,
    due: dueItems(s, today, names),
    audit,
    transferred,
  };
  const max = Math.max(1, options.maxRowsPerSheet ?? MAX_DATA_ROWS);
  const parts = Math.max(1, Math.ceil(audit.length / max));
  const sheets: SheetSpec[] = [
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
    ...Array.from({ length: parts }, (_, i): SheetSpec => {
      const from = i * max,
        to = Math.min(audit.length, from + max);
      const name =
        parts === 1 ? "Change history" : `Change history ${i + 1} of ${parts}`;
      return {
        name,
        title: name,
        about:
          parts === 1
            ? "Every change the app recorded, newest first: who, when, what and why."
            : `Every change the app recorded, newest first (part ${i + 1} of ${parts}).`,
        columns: historyColumns,
        rows: historyRows(ctx, writer, from, to),
        count: to - from,
      };
    }),
  ];
  const made = clock.dateTimeText(now);
  const zone = `${clock.name} (${clock.zone})`;
  const newest = audit[0]?.at;
  const facts: [string, string][] = [
    [
      "What this file is",
      "A readable copy of the Angel One maintenance-records system, made automatically every night from the same export as the encrypted backup. It opens in Excel, Numbers or Google Sheets.",
    ],
    [
      "Official records",
      "This copy is for reading only. The official records are the aircraft logbooks and the encrypted backup kept in Cloudflare R2. If this file disagrees with them, they are right. Changes made here are not saved anywhere else.",
    ],
    ["Made", `${made} ${clock.name}`],
    ["From deployment", options.deployment],
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
    [
      "Not in this copy",
      `Passwords, sign-in records, saved credentials and file links are never included. ${storageFiles} uploaded file${storageFiles === 1 ? " (manual, photo or attachment) is" : "s (manuals, photos and attachments) are"} kept only in the encrypted backup.`,
    ],
    [
      "Using the tables",
      "Every sheet has filter buttons on its header row. Hours are shown to one decimal place; negative numbers in the 'left' columns are overdue.",
    ],
    ...(parts > 1
      ? [
          [
            "Change history",
            `Change history is split across ${parts} sheets because one Excel sheet holds at most ${MAX_DATA_ROWS.toLocaleString("en-US")} rows.`,
          ] as [string, string],
        ]
      : []),
    ...warnings.map((w): [string, string] => ["Note", w]),
  ];
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
