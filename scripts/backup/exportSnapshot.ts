/**
 * Responsibility: Reads a Convex export into the records copy's snapshot: a
 *   system administrator's view of every program, aircraft and record.
 * Layer: Script. Node only; reads the export ZIP and writes nothing.
 * Dependencies: ./convexExport, convex/collections (decoding),
 *   src/domain/model (types).
 */
import { exportContents, readDocuments } from "./convexExport";
import {
  decodeLenient,
  type DecodeIssue,
  type StoredRecord,
} from "../../convex/collections";
import type {
  Aircraft,
  AuditEntry,
  Discrepancy,
  Flight,
  Group,
  Inspection,
  Member,
  Snapshot,
} from "../../src/domain/model";

/** The payload collections the records copy decodes, in the order it lists
 * their damaged records. */
export type RecordCollection =
  | "management"
  | "airworthiness"
  | "workOrders"
  | "taskCards"
  | "costs"
  | "purchaseOrders"
  | "partsRequests";

/** A stored payload: JSON, text that is not JSON, or none at all. */
export type StoredPayload =
  | { kind: "json"; value: unknown }
  | { kind: "text"; text: string }
  | { kind: "missing" };

/** A payload row that no longer decodes into its collection. */
export interface DamagedRecord {
  collection: RecordCollection;
  payload: StoredPayload;
  /** Where JSON breaks the collection's schema; empty for other payloads. */
  issues: DecodeIssue[];
}

/** An export, decoded for the records copy. */
export interface ExportSnapshot {
  snapshot: Snapshot;
  /** Flight Program names by uuid. */
  programs: Map<string, string>;
  /** Change-log rows, in export order. */
  audit: (AuditEntry & { _id?: string })[];
  /** By change-log row id: the programs a transfer also lists it in. */
  transferred: Map<string, string[]>;
  /** Names for manuals, checklists, inspection templates and flight plans,
   * by uuid. */
  labels: (readonly [string, string])[];
  /** Rows left out of the snapshot because they no longer decode, in
   * collection order, then row order. */
  damaged: DamagedRecord[];
  /** Stored-file ids, so a change-log value that names one can hide it. */
  storageIds: Set<string>;
  /** How many stored files the export holds. */
  storageFiles: number;
}

/**
 * Reads the export's allow-listed tables and decodes them as a system
 * administrator sees them.
 *
 * @param zipPath - The Convex snapshot export.
 * @param now - When the copy is made: the view's sign-in and sync time.
 * @returns The snapshot. A payload row that is not JSON, has no payload or no
 *   longer matches its schema is left out and listed in `damaged`, so the
 *   records the snapshot holds always match the app's types.
 * @throws {Error} From ./convexExport, when the ZIP is not a readable export.
 */
export async function readExportSnapshot(
  zipPath: string,
  now: number,
): Promise<ExportSnapshot> {
  const { tables, storageIds, storageFiles } = await loadExport(zipPath);
  return { ...decode(tables, now), storageIds, storageFiles };
}

type Doc = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
// A label row's payload, or {} when it is damaged: it only names a record.
const labelPayload = (d: Doc) => {
  const p = storedPayload(d);
  return p.kind === "json" && p.value && typeof p.value === "object"
    ? (p.value as Doc)
    : {};
};
// The tables read from the export, with the fields kept from each document.
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
    const p = labelPayload(d) as {
      document?: { payload?: { metadata?: { name?: string } } };
    };
    return {
      uuid: d.uuid,
      label: `Checklist: ${p.document?.payload?.metadata?.name ?? ""}`,
    };
  },
  inspectionTemplates: (d) => ({
    uuid: d.uuid,
    label: `Inspection template: ${(labelPayload(d) as { name?: string }).name ?? ""}`,
  }),
  flightPlans: (d) => {
    const p = labelPayload(d) as { origin?: string; destination?: string };
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

function decode(tables: Map<string, Doc[]>, now: number) {
  const damaged: DamagedRecord[] = [];
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
    ...decodeRecords(t, damaged),
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
  return { snapshot, programs, audit, transferred, labels, damaged };
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

// Damaged rows are listed in this order.
function decodeRecords(t: (name: string) => Doc[], damaged: DamagedRecord[]) {
  const records = <N extends RecordCollection>(collection: N) =>
    decodeRows(collection, t(collection), damaged);
  return {
    management: records("management"),
    airworthiness: records("airworthiness"),
    workOrders: records("workOrders"),
    taskCards: records("taskCards"),
    archivedTaskCards: [],
    costs: records("costs"),
    purchaseOrders: records("purchaseOrders"),
    partsRequests: records("partsRequests"),
  };
}

// The sheets assume the app's types, so a row that does not decode is listed
// as stored instead of reaching them (finding 48).
function decodeRows<N extends RecordCollection>(
  collection: N,
  docs: Doc[],
  damaged: DamagedRecord[],
): StoredRecord<N>[] {
  return docs.flatMap((d) => {
    const payload = storedPayload(d);
    const result =
      payload.kind === "json"
        ? decodeLenient(collection, payload.value)
        : undefined;
    if (result?.valid) return [result.record];
    damaged.push({ collection, payload, issues: result?.issues ?? [] });
    return [];
  });
}

function storedPayload(d: Doc): StoredPayload {
  if (typeof d.payload !== "string") return { kind: "missing" };
  try {
    return { kind: "json", value: JSON.parse(d.payload) };
  } catch (error) {
    // JSON.parse throws SyntaxError only: the payload is not JSON.
    if (!(error instanceof SyntaxError)) throw error;
    return { kind: "text", text: d.payload };
  }
}
