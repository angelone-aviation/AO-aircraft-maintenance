/**
 * Responsibility: Parts requests: parts asked for against a maintenance item
 *   or for stock, reserving, issuing and cancelling stock for them, and the
 *   occurrences recurring lists owe open work-order tasks.
 * Layer: Domain. Zod schemas and an applier over a working snapshot; no I/O,
 *   no React.
 * Dependencies: zod; ./model, ./programs, ./addresses, ./aircraftSpruce,
 *   ./adOwnership, ./adCompliance, ./shelfLife, ./changeLog, ./rejection;
 *   types from ./purchaseOrders, ./management, ./components, ./workOrders.
 */
import { adAircraftUuid } from "./adOwnership";
import { lastCompliance } from "./adCompliance";
import { sprucePartSchema } from "./aircraftSpruce";
import { addressSchema, formatAddress } from "./addresses";
import { z } from "zod";
import {
  can,
  latestLocalDate,
  localDate,
  type Inspection,
  type Snapshot,
} from "./model";
import { activeProgram, programPermission, recordProgram } from "./programs";
import { assertNotExpired } from "./shelfLife";
import { auditEntry, type AuditChange } from "./changeLog";
import { Rejection } from "./rejection";
import type { PurchaseOrder } from "./purchaseOrders";
import type { Stock } from "./management";
import type { Component, ComponentRequirement } from "./components";
import type { WorkOrder, WorkTask } from "./workOrders";

const TEXT_MAX_LENGTH = 4000;
const MAX_QUANTITY = 1_000_000;
const MAX_QUOTED_CENTS = 100_000_000_000;
const MAX_REQUEST_LINES = 100;
const REQUEST_NUMBER_PREFIX = "PR-";
const REQUEST_NUMBER_DIGITS = 5;
const SERVICEABLE_CONDITIONS: readonly string[] = ["new", "overhauled"];
const CLOSED_WORK_STATUSES: readonly string[] = ["completed", "cancelled"];
const TRACKED_APPLICABILITY: readonly string[] = [
  "Applicable",
  "Previously Complied With (PCW)",
];
const ADDRESS_FIELDS = [
  ["vendorAddress", "vendorAddressDetails"],
  ["shipTo", "shipToDetails"],
  ["shipFrom", "shipFromDetails"],
  ["billTo", "billToDetails"],
] as const;

const text = z.string().trim().max(TEXT_MAX_LENGTH);
const id = z.string().min(1).max(200);
const count = z.number().int().nonnegative().max(MAX_QUANTITY);

/**
 * What a request is for: a maintenance item, a component, or stock. `uuid` is
 * empty for a plain stock request; `workOrderUuid` names a task's work order.
 *
 * @throws {z.ZodError} From `parse()` on an unknown kind.
 */
export const requestSourceSchema = z.object({
  kind: z.enum([
    "stock",
    "discrepancy",
    "inspection",
    "airworthiness",
    "workTask",
    "jobCard",
    "componentRequirement",
    "component",
  ]),
  uuid: z.string().default(""),
  workOrderUuid: z.string().default(""),
});
/** A parsed request source. */
export type RequestSource = z.infer<typeof requestSourceSchema>;

/**
 * One requested part. A repair line names its serialized component, whose
 * serial, TSN and TSO are stamped on the line when the request is saved.
 *
 * @throws {z.ZodError} From `parse()` on an invalid field.
 */
export const requestLineSchema = z.object({
  sprucePart: sprucePartSchema.optional(),
  uuid: id,
  partNumber: text.min(1),
  alternateNumber: text.default(""),
  description: text.min(1),
  quantity: count.positive(),
  ipcReference: text.default(""),
  componentUuid: z.string().default(""),
  componentSerial: text.optional(),
  componentTSN: z.number().int().nonnegative().optional(),
  componentTSO: z.number().int().nonnegative().nullable().optional(),
  service: z.enum(["repair", "overhaul", "inspection"]).default("repair"),
  defect: text.default(""),
  workRequested: text.default(""),
  quotedCents: z.number().int().nonnegative().max(MAX_QUOTED_CENTS).default(0),
});

/**
 * A parts request as its form submits it. Structured address details, when
 * given, replace their free-text copies on save.
 *
 * @throws {z.ZodError} From `parse()` on an invalid field.
 */
export const requestDraftSchema = z.object({
  uuid: id,
  version: count,
  source: requestSourceSchema,
  recurring: z.boolean().optional(),
  mode: z.enum(["parts", "repair"]),
  date: z.iso.date(),
  engineer: text.min(1),
  base: text.default(""),
  priority: z.enum(["P1 AOG", "P2 Routine", "P3 Stock"]),
  requiredBy: z.union([z.iso.date(), z.literal("")]),
  timeframe: text.default(""),
  vendor: text.default(""),
  vendorAddressDetails: addressSchema.optional(),
  shipToDetails: addressSchema.optional(),
  shipFromDetails: addressSchema.optional(),
  billToDetails: addressSchema.optional(),
  vendorAddress: text.default(""),
  currency: z.string().regex(/^[A-Z]{3}$/),
  shipTo: text.default(""),
  billTo: text.default(""),
  shipFrom: text.default(""),
  aircraftYear: text.default(""),
  notes: text.default(""),
  shippingInstructions: text.default(""),
  returnInstructions: text.default(""),
  lines: z.array(requestLineSchema).min(1).max(MAX_REQUEST_LINES),
});

/**
 * A stored parts request: the draft plus its program, aircraft, source label,
 * `PR-NNNNN` number, stock reservations and issues, and every command applied.
 *
 * @throws {z.ZodError} From `parse()` on an invalid field.
 */
export const partsRequestSchema = requestDraftSchema.extend({
  templateUuid: z.string().optional(),
  programUuid: id,
  aircraftUuid: z.string(),
  sourceLabel: text,
  aircraftRegistration: text,
  aircraftSerial: text,
  aircraftModel: text,
  number: id,
  requesterId: id,
  createdAt: z.number(),
  updatedAt: z.number(),
  cancelled: z.boolean(),
  reservations: z.array(
    z.object({ lineUuid: id, stockUuid: id, quantity: count.positive() }),
  ),
  issues: z.array(
    z.object({
      lineUuid: id,
      stockUuid: id,
      quantity: count.positive(),
      at: z.number(),
      actorId: id,
    }),
  ),
  history: z.array(
    z.object({
      requestUuid: id,
      at: z.number(),
      actorId: id,
      action: text,
      detail: z.string().max(200000),
    }),
  ),
});
/** A parsed parts request. */
export type PartsRequest = z.infer<typeof partsRequestSchema>;
/** A parsed parts-request draft. */
export type RequestDraft = z.infer<typeof requestDraftSchema>;
/** A parsed request line. */
export type RequestLine = z.infer<typeof requestLineSchema>;

/**
 * A parts-request command: save a draft; reserve, release or issue stock for
 * one line; or cancel the request.
 *
 * @throws {z.ZodError} From `parse()` on an invalid command.
 */
export const requestCommandSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("save"),
    requestUuid: id,
    draft: requestDraftSchema,
  }),
  z.object({
    kind: z.enum(["reserve", "release", "issue"]),
    requestUuid: id,
    uuid: id,
    version: count,
    lineUuid: id,
    stockUuid: id,
    quantity: count.positive(),
    alternateConfirmed: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("cancel"),
    requestUuid: id,
    uuid: id,
    version: count,
    reason: text.min(1),
  }),
]);
/** A parsed parts-request command. */
export type RequestCommand = z.infer<typeof requestCommandSchema>;

/**
 * The aircraft, label and component a request source points to, checked
 * against the active Flight Program.
 *
 * @returns `aircraftUuid` ("" for stock), a label ("WO number: task", "AD
 *   number: task", "part · S/N serial", the record's title or description, or
 *   "Inventory: part"), the linked `componentUuid` ("" if none), and the
 *   aircraft.
 * @throws {Rejection} "Save the work-order task before requesting parts.",
 *   "AD task is unavailable.", "Linked item is unavailable.", "Linked item is
 *   outside this Flight Program.", "Stock item is unavailable." or "Aircraft
 *   is outside this Flight Program."
 */
export function resolveRequestSource(s: Snapshot, source: RequestSource) {
  const linked = linkedSource(s, source);
  const aircraft = s.aircraft.find((a) => a.uuid === linked.aircraftUuid);
  if (
    linked.aircraftUuid &&
    (!aircraft || aircraft.programUuid !== activeProgram(s))
  )
    throw new Rejection("Aircraft is outside this Flight Program.");
  return { ...linked, aircraft };
}

/** A request line's share of one purchase-order line, in units. */
export interface RequestPurchase {
  requestUuid: string;
  lineUuid: string;
  poUuid: string;
  number: string;
  phase: string;
  quantity: number;
  received: number;
  shipped: number;
  expectedDate: string;
  purchasedDate: string;
  purchasedBy: string;
}

/**
 * Splits each purchase-order line among the request lines allocated to it,
 * in allocation order: cancelled units come off the last allocations, and
 * received and shipped units fill the first.
 *
 * @returns One entry per allocation; `purchasedDate` is the UTC date the PO
 *   was issued and `purchasedBy` its issuer, both "" before issue.
 */
export function requestPurchases(orders: PurchaseOrder[]): RequestPurchase[] {
  return orders.flatMap((p) =>
    p.lines.flatMap((l) => {
      let remaining = l.quantity - l.cancelled;
      let received = sumLineQuantity(p.receipts, l.uuid);
      let shipped = sumLineQuantity(p.shipments, l.uuid);
      return (l.requestAllocations ?? []).map((a) => {
        const quantity = Math.min(a.quantity, Math.max(0, remaining));
        remaining -= quantity;
        const rec = Math.min(quantity, received);
        received -= rec;
        const ship = Math.min(quantity, shipped);
        shipped -= ship;
        return {
          requestUuid: a.requestUuid,
          lineUuid: a.lineUuid,
          poUuid: p.uuid,
          number: p.number,
          phase: p.phase,
          quantity,
          received: rec,
          shipped: ship,
          expectedDate: p.expectedDate,
          purchasedDate: p.issuedAt
            ? new Date(p.issuedAt).toISOString().slice(0, 10)
            : "",
          purchasedBy:
            p.history.find((h) => h.action === "issue")?.actorId ?? "",
        };
      });
    }),
  );
}

/**
 * How far one request line has got, from its PO allocations and its own
 * reservations and issues.
 *
 * @returns The allocations and units ordered, received, issued and reserved;
 *   `toOrder`, the shortfall still to buy; and `remaining`, the units neither
 *   issued nor reserved. Neither is ever negative.
 */
export function requestLineProgress(
  s: Snapshot,
  r: PartsRequest,
  lineUuid: string,
) {
  const purchases = (
    s.partsRequestPurchases ?? requestPurchases(s.purchaseOrders ?? [])
  ).filter((a) => a.requestUuid === r.uuid && a.lineUuid === lineUuid);
  const ordered = purchases.reduce((n, a) => n + a.quantity, 0);
  const received = purchases.reduce((n, a) => n + a.received, 0);
  const issued = r.issues
    .filter((a) => a.lineUuid === lineUuid)
    .reduce((n, a) => n + a.quantity, 0);
  const reserved = r.reservations
    .filter((a) => a.lineUuid === lineUuid)
    .reduce((n, a) => n + a.quantity, 0);
  const line = r.lines.find((l) => l.uuid === lineUuid)!;
  return {
    purchases,
    ordered,
    received,
    issued,
    reserved,
    // Received parts go to stock and count again once reserved or issued; a
    // repaired component comes back to its owner, not to stock.
    toOrder: Math.max(
      0,
      line.quantity -
        issued -
        reserved -
        ordered +
        (r.mode === "repair" ? 0 : received),
    ),
    remaining: Math.max(0, line.quantity - issued - reserved),
  };
}

/**
 * Where a request stands.
 *
 * @returns The first that applies: "Cancelled", "Recurring", "Fulfilled"
 *   (every line issued, or received back for a repair), "Out for repair",
 *   "Received / awaiting issue", "Partially issued", "On purchase order",
 *   "Reserved" or "Requested".
 */
export function requestStatus(s: Snapshot, r: PartsRequest) {
  if (r.cancelled) return "Cancelled";
  if (r.recurring) return "Recurring";
  const p = r.lines.map((l) => ({ l, ...requestLineProgress(s, r, l.uuid) }));
  if (
    p.every(
      (x) => (r.mode === "repair" ? x.received : x.issued) >= x.l.quantity,
    )
  )
    return "Fulfilled";
  if (
    p.some((x) => x.purchases.some((a) => a.shipped > a.received)) &&
    r.mode === "repair"
  )
    return "Out for repair";
  // Received parts await issue while they are still held for the request:
  // received but not yet issued, and still reserved. Line totals cannot say
  // which units were issued, so issues count against received units first.
  // A repair is complete on receipt, so any returned unit counts.
  if (
    p.some((x) =>
      r.mode === "repair"
        ? x.received
        : Math.min(x.reserved, x.received - x.issued) > 0,
    )
  )
    return "Received / awaiting issue";
  if (p.some((x) => x.issued)) return "Partially issued";
  if (p.some((x) => x.ordered)) return "On purchase order";
  if (p.some((x) => x.reserved)) return "Reserved";
  return "Requested";
}

/**
 * Records a parts-request reservation, release or issue in the stock item's
 * own history, next to its stock.move entries ("Quantity changes are saved in
 * history"). The request keeps its own partsRequest.* entry as well.
 *
 * @param before - The stock item as JSON before the change.
 * @param reason - The entry's reason, shown in History.
 */
export function auditStockChange(
  s: Snapshot,
  before: string,
  stock: { uuid: string },
  action: "reserve" | "release" | "issue",
  reason: string,
  now: number,
) {
  recordPartsChange(
    s,
    {
      action: `stock.${action}`,
      entityUuid: stock.uuid,
      reason,
      before: JSON.parse(before),
      after: stock,
    },
    now,
  );
}

/**
 * Applies one parts-request command, all or nothing.
 *
 * @returns The saved request. A request id already applied returns the
 *   stored request unchanged, if the same user sends the same command.
 * @throws {Rejection} For a refused command: no active program, a reused
 *   request id, a stale version, missing access, a cancelled or locked
 *   request, or a repair or stock rule; also as {@link resolveRequestSource}
 *   and `assertNotExpired`.
 * @throws {z.ZodError} For an invalid command or result.
 *
 * Side effects: on success, replaces `original`'s partsRequests, management
 * and audit, adding a `partsRequest.<kind>` entry and any `stock.*` entries.
 * When the result is an active recurring list, saved or replayed, the open
 * work orders on its aircraft also gain what its lists owe them
 * ({@link generateRecurringRequests}), dated `now`.
 */
export function applyRequestCommand(
  original: Snapshot,
  raw: RequestCommand,
  now = Date.now(),
) {
  const s = structuredClone(original),
    c = requestCommandSchema.parse(raw),
    program = activeProgram(s);
  if (!program) throw new Rejection("Choose a Flight Program.");
  if (c.kind === "save") normalizeDraft(s, c.draft);
  const requests = s.partsRequests ?? [];
  const previous = requests.find(
    (r) => r.uuid === (c.kind === "save" ? c.draft.uuid : c.uuid),
  );
  const replay = findReplay(requests, c.requestUuid);
  if (replay) {
    const stored = replayed(replay, c, program, s.user.id);
    return finishCommand(original, s, stored, now);
  }
  assertCurrent(previous, c, program);
  const source =
    c.kind === "save" ? resolveRequestSource(s, c.draft.source) : null;
  const aircraftUuid = source?.aircraftUuid ?? previous?.aircraftUuid ?? "";
  assertMayChange(s, aircraftUuid, previous);
  const ctx: RequestContext = { s, program, requests, previous, now };
  const r =
    c.kind === "save"
      ? buildRequest(ctx, c.draft, source!, aircraftUuid)
      : changeRequest(ctx, c);
  return finishCommand(original, s, commitRequest(original, ctx, c, r), now);
}

/**
 * The schedule a recurring parts list follows, so that it never becomes a
 * second maintenance schedule: a recurring inspection, a repeating component
 * service limit, or a recurring AD action. A work-order task or job card
 * resolves to the item it performs.
 *
 * @returns That item as a source with no work order, or undefined if it does
 *   not recur.
 */
export function recurringRequestSource(
  s: Snapshot,
  source: RequestSource,
): RequestSource | undefined {
  if (source.kind === "workTask") return recurringTaskSource(s, source);
  if (source.kind === "jobCard") return recurringCardSource(s, source.uuid);
  if (!isRecurringSchedule(s, source)) return undefined;
  return { ...source, workOrderUuid: "" };
}

/**
 * Whether a request was raised for a maintenance item: directly, through the
 * recurring list it was generated from, or through the work-order task that
 * performs the item.
 */
export function requestMatchesSource(
  s: Snapshot,
  r: PartsRequest,
  source: RequestSource,
): boolean {
  if (
    r.source.kind === source.kind &&
    r.source.uuid === source.uuid &&
    r.source.workOrderUuid === source.workOrderUuid
  )
    return true;
  const template =
    r.templateUuid && s.partsRequests?.find((t) => t.uuid === r.templateUuid);
  if (
    template &&
    template.source.kind === source.kind &&
    template.source.uuid === source.uuid
  )
    return true;
  if (r.source.kind !== "workTask") return false;
  const task = s.workOrders
    ?.find((w) => w.uuid === r.source.workOrderUuid)
    ?.tasks.find((t) => t.uuid === r.source.uuid);
  return task?.source.kind === source.kind && task.source.uuid === source.uuid;
}

/**
 * Creates the parts requests a work order's open tasks need from the
 * recurring lists of its aircraft: one occurrence per list and task, copied
 * from the list as it is now. An occurrence is created once, even if later
 * cancelled, so cancelling never silently reorders parts.
 *
 * @param s - The working snapshot; gains the requests, each with one
 *   "partsRequest.recurring" change-log row.
 * @param order - The saved work order; a completed or cancelled one gets none.
 * @param now - The creation time.
 * @returns The new requests, numbered on from the program's highest PR number.
 * @throws {z.ZodError} When a copied request fails partsRequestSchema.
 */
export function generateRecurringRequests(
  s: Snapshot,
  order: WorkOrder,
  now = Date.now(),
) {
  if (isClosed(order)) return [];
  const requests = (s.partsRequests ??= []);
  const program = s.aircraft.find(
    (a) => a.uuid === order.aircraftUuid,
  )?.programUuid;
  const templates = requests.filter(
    (r) =>
      r.recurring &&
      !r.cancelled &&
      r.programUuid === program &&
      r.aircraftUuid === order.aircraftUuid,
  );
  const run: OccurrenceRun = { s, requests, order, program, now };
  const created: PartsRequest[] = [];
  for (const template of templates) {
    const source = recurringRequestSource(s, template.source);
    if (!source) continue;
    const tasks = order.tasks.filter(
      (t) =>
        !isClosed(t) &&
        t.source.kind === source.kind &&
        t.source.uuid === source.uuid,
    );
    created.push(...addOccurrences(run, template, tasks));
  }
  return created;
}

/**
 * What must be loaded before {@link generateRecurringRequests} can serve a
 * work order: the sources of its open tasks that an active recurring list on
 * its aircraft covers and has not served yet.
 *
 * @param order - The work order as it will be saved.
 * @param requests - The Flight Program's parts requests, lists included.
 * @returns The inspection and component-requirement uuids those tasks
 *   perform, each once, in task order, and whether any performs an AD task;
 *   none for a completed or cancelled work order.
 */
export function recurringPartsNeeds(
  order: WorkOrder,
  requests: PartsRequest[],
) {
  const owed = isClosed(order)
    ? []
    : order.tasks.filter((task) => isOwed(requests, order, task));
  const sources = (kind: WorkTask["source"]["kind"]) => [
    ...new Set(
      owed.filter((t) => t.source.kind === kind).map((t) => t.source.uuid),
    ),
  ];
  return {
    inspections: sources("inspection"),
    requirements: sources("componentRequirement"),
    airworthiness: owed.some((t) => t.source.kind === "airworthiness"),
  };
}

type StockCommand = Extract<
  RequestCommand,
  { kind: "reserve" | "release" | "issue" }
>;
type CancelCommand = Extract<RequestCommand, { kind: "cancel" }>;
type LinkedSource = {
  aircraftUuid: string;
  label: string;
  componentUuid: string;
};
type LinkedRecord = NonNullable<ReturnType<typeof findLinkedRecord>>;
type Replay = NonNullable<ReturnType<typeof findReplay>>;
interface RequestContext {
  s: Snapshot;
  program: string;
  requests: PartsRequest[];
  previous: PartsRequest | undefined;
  now: number;
}
interface StockTarget {
  line: RequestLine;
  stock: Stock;
  reservation: PartsRequest["reservations"][number] | undefined;
}
// One generation pass over a work order.
interface OccurrenceRun {
  s: Snapshot;
  requests: PartsRequest[];
  order: WorkOrder;
  program: string | undefined;
  now: number;
}

function linkedSource(s: Snapshot, source: RequestSource): LinkedSource {
  if (source.kind === "stock") return stockSource(s, source.uuid);
  if (source.kind === "workTask") return workTaskSource(s, source);
  if (source.kind === "airworthiness") return adTaskSource(s, source.uuid);
  return recordSource(s, source);
}

function stockSource(s: Snapshot, uuid: string): LinkedSource {
  const label = "Inventory stock request";
  if (!uuid) return { aircraftUuid: "", label, componentUuid: "" };
  const stock = findStock(s, uuid);
  if (!stock || recordProgram(s, stock) !== activeProgram(s))
    throw new Rejection("Stock item is unavailable.");
  const stockLabel = `Inventory: ${stock.partNumber}`;
  return { aircraftUuid: "", label: stockLabel, componentUuid: "" };
}

function workTaskSource(s: Snapshot, source: RequestSource): LinkedSource {
  const w = s.workOrders?.find((w) => w.uuid === source.workOrderUuid);
  const task = w?.tasks.find((t) => t.uuid === source.uuid);
  if (!w || !task)
    throw new Rejection("Save the work-order task before requesting parts.");
  const label = `${w.number}: ${task.description}`;
  return { aircraftUuid: w.aircraftUuid, label, componentUuid: "" };
}

function adTaskSource(s: Snapshot, uuid: string): LinkedSource {
  const ad = s.airworthiness?.find((r) => r.tasks.some((t) => t.uuid === uuid));
  const task = ad?.tasks.find((t) => t.uuid === uuid);
  if (!ad || !task) throw new Rejection("AD task is unavailable.");
  return {
    aircraftUuid: adAircraftUuid(s, ad),
    label: `AD ${ad.source.number}: ${task.description}`,
    componentUuid: ad.componentUuid,
  };
}

function recordSource(s: Snapshot, source: RequestSource): LinkedSource {
  const record = findLinkedRecord(s, source);
  if (!record || !("aircraftUuid" in record))
    throw new Rejection("Linked item is unavailable.");
  if ("kind" in record && recordProgram(s, record) !== activeProgram(s))
    throw new Rejection("Linked item is outside this Flight Program.");
  return {
    aircraftUuid: record.aircraftUuid,
    label: recordLabel(record, source.kind),
    componentUuid: linkedComponentUuid(record, source.kind),
  };
}

function findLinkedRecord(s: Snapshot, { kind, uuid }: RequestSource) {
  if (kind === "discrepancy")
    return s.discrepancies.find((r) => r.uuid === uuid);
  if (kind === "inspection") return s.inspections.find((r) => r.uuid === uuid);
  if (kind === "jobCard") return s.taskCards?.find((r) => r.uuid === uuid);
  return s.management?.find((r) => r.uuid === uuid && r.kind === kind);
}

function recordLabel(record: LinkedRecord, kind: RequestSource["kind"]) {
  if (isLinkedComponent(record, kind))
    return `${record.partNumber} · S/N ${record.serial}`;
  if ("title" in record) return String(record.title);
  if ("description" in record) return String(record.description);
  return kind;
}

// A record's own component link wins over the component it is.
function linkedComponentUuid(
  record: LinkedRecord,
  kind: RequestSource["kind"],
) {
  if ("componentUuid" in record) return record.componentUuid ?? "";
  return isLinkedComponent(record, kind) ? record.uuid : "";
}

function isLinkedComponent(
  record: LinkedRecord,
  kind: RequestSource["kind"],
): record is Extract<LinkedRecord, { partNumber: string; serial: string }> {
  return kind === "component" && "partNumber" in record && "serial" in record;
}

function findStock(s: Snapshot, uuid: string) {
  return s.management?.find(
    (x): x is Stock => x.kind === "stock" && x.uuid === uuid,
  );
}

function sumLineQuantity(
  entries: { lines: { lineUuid: string; quantity: number }[] }[],
  lineUuid: string,
) {
  return entries
    .flatMap((e) => e.lines)
    .filter((l) => l.lineUuid === lineUuid)
    .reduce((n, l) => n + l.quantity, 0);
}

function normalizeDraft(s: Snapshot, d: RequestDraft) {
  for (const [field, details] of ADDRESS_FIELDS)
    if (d[details]) d[field] = formatAddress(d[details]);
  if (!d.recurring) return;
  const recurringSource = recurringRequestSource(s, d.source);
  if (!recurringSource || d.mode !== "parts")
    throw new Rejection(
      "Recurring parts require a recurring inspection, service or AD task.",
    );
  d.source = recurringSource;
}

function findReplay(requests: PartsRequest[], requestUuid: string) {
  return requests
    .flatMap((r) => r.history.map((h) => ({ r, h })))
    .find((x) => x.h.requestUuid === requestUuid);
}

// A request id applies once: the same user resending the same command gets
// the stored request back.
function replayed(
  { r, h }: Replay,
  c: RequestCommand,
  program: string,
  actorId: string,
) {
  if (
    r.programUuid !== program ||
    h.actorId !== actorId ||
    h.detail !== JSON.stringify(c)
  )
    throw new Rejection("Request identifier already used.");
  return r;
}

function assertCurrent(
  previous: PartsRequest | undefined,
  c: RequestCommand,
  program: string,
) {
  if (previous && previous.programUuid !== program)
    throw new Rejection("Request is outside this Flight Program.");
  const version = c.kind === "save" ? c.draft.version : c.version;
  if ((previous?.version ?? 0) !== version)
    throw new Rejection("Request changed. Reopen it before saving.");
}

// Stock requests belong to the program, so they need a program administrator.
function assertMayChange(
  s: Snapshot,
  aircraftUuid: string,
  previous: PartsRequest | undefined,
) {
  const allowed = aircraftUuid
    ? can(s, aircraftUuid, "maintenance")
    : programPermission(s, "admin");
  if (!allowed) throw new Rejection("Maintenance access is required.");
  if (previous?.cancelled)
    throw new Rejection("Cancelled requests are read-only.");
}

function buildRequest(
  ctx: RequestContext,
  d: RequestDraft,
  source: ReturnType<typeof resolveRequestSource>,
  aircraftUuid: string,
): PartsRequest {
  const { s, program, requests, previous, now } = ctx;
  assertDraft(ctx, d);
  const lines = d.lines.map((l) => prepareLine(ctx, d, l, aircraftUuid));
  const { aircraft } = source;
  return {
    ...d,
    lines,
    templateUuid: previous?.templateUuid,
    programUuid: program,
    aircraftUuid,
    sourceLabel: source.label.slice(0, TEXT_MAX_LENGTH),
    aircraftRegistration: aircraft?.registration ?? "",
    aircraftSerial: aircraft?.serial ?? "",
    aircraftModel: aircraft ? `${aircraft.make} ${aircraft.model}` : "",
    number: previous?.number ?? nextRequestNumber(requests, program),
    requesterId: previous?.requesterId ?? s.user.id,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    cancelled: false,
    reservations: previous?.reservations ?? [],
    issues: previous?.issues ?? [],
    history: previous?.history ?? [],
  };
}

function assertDraft({ s, previous, now }: RequestContext, d: RequestDraft) {
  if (previous && !!previous.recurring !== !!d.recurring)
    throw new Rejection(
      "Create a separate recurring parts list; an existing request cannot change its recurrence type.",
    );
  if (d.date > latestLocalDate(now))
    throw new Rejection("Request date cannot be in the future.");
  if (new Set(d.lines.map((l) => l.uuid)).size !== d.lines.length)
    throw new Rejection("Duplicate request lines.");
  if (!previous) return;
  if (JSON.stringify(previous.source) !== JSON.stringify(d.source))
    throw new Rejection("Request source cannot change.");
  if (isCommitted(s, previous) && changesPurchasing(previous, d))
    throw new Rejection(
      "Release reservations and remove draft PO allocations before changing lines or purchasing details. Fulfilled lines are retained for traceability.",
    );
}

function isCommitted(s: Snapshot, r: PartsRequest) {
  return (
    r.reservations.length > 0 ||
    r.issues.length > 0 ||
    requestPurchases(s.purchaseOrders ?? []).some(
      (a) => a.requestUuid === r.uuid,
    )
  );
}

function changesPurchasing(previous: PartsRequest, d: RequestDraft) {
  return (
    JSON.stringify(previous.lines) !== JSON.stringify(d.lines) ||
    previous.mode !== d.mode ||
    previous.vendor !== d.vendor ||
    previous.currency !== d.currency ||
    previous.shipTo !== d.shipTo
  );
}

// The serial, TSN and TSO go on a copy of the line, never the command: the
// command is the request id's record (findReplay), so stamping it would
// refuse an identical resend.
function prepareLine(
  ctx: RequestContext,
  d: RequestDraft,
  line: RequestLine,
  aircraftUuid: string,
): RequestLine {
  if (d.mode !== "repair") {
    if (line.componentUuid)
      throw new Rejection(
        "Use a repair request for an existing serialized component.",
      );
    return line;
  }
  const component = findRepairable(ctx, line, aircraftUuid);
  if (hasOpenRepair(ctx, d.uuid, component.uuid))
    throw new Rejection("This component already has an open repair request.");
  if (!line.defect || !line.workRequested)
    throw new Rejection("Enter the defect and work requested for repair.");
  return {
    ...line,
    componentSerial: component.serial,
    componentTSN: component.timeSinceNew,
    componentTSO: component.timeSinceOverhaul,
  };
}

// A repair ships one serialized component of the program, held loose in
// inventory, and stays on the request's aircraft when both name one.
function findRepairable(
  { s, program }: RequestContext,
  line: RequestLine,
  aircraftUuid: string,
): Component {
  const component = s.management?.find(
    (x): x is Component =>
      x.kind === "component" && x.uuid === line.componentUuid,
  );
  if (
    !component ||
    recordProgram(s, component) !== program ||
    component.installed ||
    component.parentComponentUuid ||
    component.outForRepair ||
    (aircraftUuid &&
      component.aircraftUuid &&
      component.aircraftUuid !== aircraftUuid) ||
    component.partNumber !== line.partNumber ||
    line.quantity !== 1 ||
    !component.serial
  )
    throw new Rejection(
      "Choose an uninstalled serialized component in this Flight Program; repair quantity must be one.",
    );
  return component;
}

function hasOpenRepair(
  { s, requests }: RequestContext,
  requestUuid: string,
  componentUuid: string,
) {
  return requests.some(
    (x) =>
      x.uuid !== requestUuid &&
      !x.cancelled &&
      requestStatus(s, x) !== "Fulfilled" &&
      x.lines.some((l) => l.componentUuid === componentUuid),
  );
}

function nextRequestNumber(requests: PartsRequest[], program: string) {
  const used = requests
    .filter((x) => x.programUuid === program)
    .map((x) => Number(x.number.slice(REQUEST_NUMBER_PREFIX.length)) || 0);
  const next = String(1 + Math.max(0, ...used));
  return REQUEST_NUMBER_PREFIX + next.padStart(REQUEST_NUMBER_DIGITS, "0");
}

function changeRequest(ctx: RequestContext, c: StockCommand | CancelCommand) {
  const r = ctx.previous;
  if (!r) throw new Rejection("Request not found.");
  if (r.recurring && c.kind !== "cancel")
    throw new Rejection(
      "Reserve or issue parts against an occurrence request, not the recurring list.",
    );
  if (!programPermission(ctx.s, "admin"))
    throw new Rejection(
      "Inventory administrator access is required to reserve, issue or cancel requests.",
    );
  if (c.kind === "cancel") cancelRequest(ctx, r, c.reason);
  else changeStock(ctx, r, c);
  return r;
}

function cancelRequest(
  { s, now }: RequestContext,
  r: PartsRequest,
  reason: string,
) {
  const outstanding = requestPurchases(s.purchaseOrders ?? []).some(
    (a) => a.requestUuid === r.uuid && a.quantity > a.received,
  );
  if (outstanding)
    throw new Rejection(
      "Remove draft allocations or cancel outstanding PO quantities first.",
    );
  for (const reservation of r.reservations) {
    const stock = findStock(s, reservation.stockUuid);
    if (!stock) throw new Rejection("Reserved stock is unavailable.");
    const before = JSON.stringify(stock);
    stock.reservedQuantity =
      (stock.reservedQuantity ?? 0) - reservation.quantity;
    stock.version++;
    const note = `Released ${reservation.quantity} from ${r.number}: request cancelled (${reason})`;
    auditStockChange(s, before, stock, "release", note, now);
  }
  r.reservations = [];
  r.cancelled = true;
}

function changeStock(
  { s, program, now }: RequestContext,
  r: PartsRequest,
  c: StockCommand,
) {
  if (r.mode === "repair")
    throw new Rejection(
      "Repair components are shipped and received through their purchase order.",
    );
  const line = r.lines.find((l) => l.uuid === c.lineUuid);
  const stock = findStock(s, c.stockUuid);
  if (!line || !stock || recordProgram(s, stock) !== program)
    throw new Rejection("Select a stock item in this Flight Program.");
  const reservation = r.reservations.find(
    (a) => a.lineUuid === line.uuid && a.stockUuid === stock.uuid,
  );
  const before = JSON.stringify(stock);
  if (c.kind !== "release") assertNotExpired(stock, now);
  const target = { line, stock, reservation };
  if (c.kind === "reserve") reserveStock(s, r, c, target);
  else releaseStock(s, r, c, target, now);
  stock.version++;
  auditStockChange(s, before, stock, c.kind, stockNote(c, r.number), now);
}

function reserveStock(
  s: Snapshot,
  r: PartsRequest,
  c: StockCommand,
  { line, stock, reservation }: StockTarget,
) {
  const alternate =
    c.alternateConfirmed &&
    line.alternateNumber &&
    stock.partNumber === line.alternateNumber;
  if (stock.partNumber !== line.partNumber && !alternate)
    throw new Rejection(
      "Select the requested part or explicitly confirm its listed alternate.",
    );
  if (!SERVICEABLE_CONDITIONS.includes(stock.condition))
    throw new Rejection("Only serviceable stock can be reserved.");
  const available = stock.quantity - (stock.reservedQuantity ?? 0);
  const demand = requestLineProgress(s, r, line.uuid).toOrder;
  if (c.quantity > Math.min(demand, available))
    throw new Rejection(
      "Quantity exceeds uncommitted demand or available stock.",
    );
  stock.reservedQuantity = (stock.reservedQuantity ?? 0) + c.quantity;
  if (reservation) reservation.quantity += c.quantity;
  else
    r.reservations.push({
      lineUuid: line.uuid,
      stockUuid: stock.uuid,
      quantity: c.quantity,
    });
}

// Releasing and issuing both take units off the reservation; issuing also
// takes them out of stock.
function releaseStock(
  s: Snapshot,
  r: PartsRequest,
  c: StockCommand,
  { line, stock, reservation }: StockTarget,
  now: number,
) {
  if (!reservation || reservation.quantity < c.quantity)
    throw new Rejection("Quantity exceeds this request’s reservation.");
  stock.reservedQuantity = (stock.reservedQuantity ?? 0) - c.quantity;
  reservation.quantity -= c.quantity;
  r.reservations = r.reservations.filter((a) => a.quantity > 0);
  if (c.kind !== "issue") return;
  stock.quantity -= c.quantity;
  r.issues.push({
    lineUuid: line.uuid,
    stockUuid: stock.uuid,
    quantity: c.quantity,
    at: now,
    actorId: s.user.id,
  });
}

function stockNote({ kind, quantity }: StockCommand, number: string) {
  if (kind === "reserve") return `Reserved ${quantity} for ${number}`;
  if (kind === "release") return `Released ${quantity} from ${number}`;
  return `Issued ${quantity} for ${number}`;
}

// The request's history doubles as its request-id record (findReplay), and
// the change-log entry keeps the stored request before and after.
function commitRequest(
  original: Snapshot,
  { s, requests, previous, now }: RequestContext,
  c: RequestCommand,
  r: PartsRequest,
) {
  r.version++;
  r.updatedAt = now;
  r.history.push({
    requestUuid: c.requestUuid,
    at: now,
    actorId: s.user.id,
    action: c.kind,
    detail: JSON.stringify(c),
  });
  const saved = partsRequestSchema.parse(r);
  s.partsRequests = [...requests.filter((x) => x.uuid !== saved.uuid), saved];
  recordPartsChange(
    s,
    {
      uuid: c.requestUuid,
      action: `partsRequest.${c.kind}`,
      entityUuid: saved.uuid,
      aircraftUuid: saved.aircraftUuid || undefined,
      before: previous
        ? original.partsRequests?.find((x) => x.uuid === saved.uuid)
        : undefined,
      after: saved,
    },
    now,
  );
  return saved;
}

// Parts rows name no program of their own: the server stamps the command's
// program as it writes them, and the demo keeps them without.
function recordPartsChange(s: Snapshot, change: AuditChange, now: number) {
  s.audit.unshift(auditEntry(s, { programUuid: undefined, ...change }, now));
}

// Saving a list serves the open work orders on its aircraft at once, so none
// waits for its own next save. A resend does too, creating only what is still
// owed.
function finishCommand(
  original: Snapshot,
  s: Snapshot,
  r: PartsRequest,
  now: number,
) {
  if (r.recurring && !r.cancelled) serveOpenOrders(s, r, now);
  original.partsRequests = s.partsRequests;
  original.management = s.management;
  original.audit = s.audit;
  return r;
}

function recurringTaskSource(s: Snapshot, source: RequestSource) {
  const task = s.workOrders
    ?.find((w) => w.uuid === source.workOrderUuid)
    ?.tasks.find((t) => t.uuid === source.uuid);
  if (!task || task.source.kind === "manual") return undefined;
  return recurringRequestSource(s, {
    kind: task.source.kind,
    uuid: task.source.uuid,
    workOrderUuid: "",
  });
}

function recurringCardSource(s: Snapshot, uuid: string) {
  const card = s.taskCards?.find((c) => c.uuid === uuid);
  if (card?.inspectionUuid)
    return recurringRequestSource(s, {
      kind: "inspection",
      uuid: card.inspectionUuid,
      workOrderUuid: "",
    });
  if (card?.requirementUuid)
    return recurringRequestSource(s, {
      kind: "componentRequirement",
      uuid: card.requirementUuid,
      workOrderUuid: "",
    });
  return undefined;
}

function isRecurringSchedule(s: Snapshot, { kind, uuid }: RequestSource) {
  if (kind === "inspection")
    return isRecurringInspection(s.inspections.find((i) => i.uuid === uuid));
  if (kind === "componentRequirement")
    return isRecurringRequirement(
      s.management?.find(
        (r): r is ComponentRequirement =>
          r.kind === "componentRequirement" && r.uuid === uuid,
      ),
    );
  if (kind === "airworthiness") return isRecurringADTask(s, uuid);
  return false;
}

function isRecurringInspection(i: Inspection | undefined) {
  return (
    !!i &&
    !i.archived &&
    !!(
      i.intervalSeconds ||
      i.intervalCycles ||
      i.intervalLandings ||
      i.intervalMonths
    )
  );
}

// Life limits never repeat, and an absolute limit on time since new, cycles
// or landings falls due once; one on time since overhaul or repair repeats
// with each reset.
function isRecurringRequirement(r: ComponentRequirement | undefined) {
  if (!r || r.requirementType === "Life Limits") return false;
  return !!(
    r.calendarIntervalValue ||
    (r.intervalSeconds &&
      (r.timeLimitMode === "FROM_LAST_COMPLIED" || r.timeBasis !== "TSN")) ||
    (r.intervalCycles && r.cycleLimitMode === "FROM_LAST_COMPLIED") ||
    (r.intervalLandings && r.landingLimitMode !== "ABSOLUTE")
  );
}

function isRecurringADTask(s: Snapshot, uuid: string) {
  const ad = s.airworthiness?.find((r) => r.tasks.some((t) => t.uuid === uuid));
  const t = ad?.tasks.find((t) => t.uuid === uuid);
  if (!ad || !t || ad.reviewRequired) return false;
  if (!TRACKED_APPLICABILITY.includes(ad.applicability)) return false;
  if (t.recurrence === "One-time" || lastCompliance(ad, t.uuid)?.terminatedBy)
    return false;
  return (
    t.recurrence === "Recurring" ||
    !!(
      t.intervalDays ||
      t.intervalHours ||
      t.intervalCycles ||
      t.intervalLandings
    )
  );
}

function serveOpenOrders(s: Snapshot, list: PartsRequest, now: number) {
  for (const order of s.workOrders ?? [])
    if (order.aircraftUuid === list.aircraftUuid)
      generateRecurringRequests(s, order, now);
}

function addOccurrences(
  run: OccurrenceRun,
  template: PartsRequest,
  tasks: WorkTask[],
): PartsRequest[] {
  const { s, requests, order, program, now } = run;
  const created: PartsRequest[] = [];
  for (const task of tasks) {
    if (hasOccurrence(requests, template, order, task)) continue;
    const r = copyTemplate(run, template, task);
    requests.push(r);
    created.push(r);
    s.audit.unshift(
      auditEntry(
        s,
        {
          uuid: r.uuid,
          programUuid: program,
          action: "partsRequest.recurring",
          entityUuid: r.uuid,
          aircraftUuid: order.aircraftUuid,
          after: r,
        },
        now,
      ),
    );
  }
  return created;
}

// Numbered from the requests as they stand, so each copy follows the last.
function copyTemplate(
  { s, requests, order, now }: OccurrenceRun,
  template: PartsRequest,
  task: WorkTask,
): PartsRequest {
  const uuid = crypto.randomUUID();
  return partsRequestSchema.parse({
    ...structuredClone(template),
    uuid,
    version: 1,
    recurring: false,
    templateUuid: template.uuid,
    source: { kind: "workTask", uuid: task.uuid, workOrderUuid: order.uuid },
    sourceLabel: `${order.number}: ${task.description}`.slice(
      0,
      TEXT_MAX_LENGTH,
    ),
    number: nextRequestNumber(requests, template.programUuid),
    date: localDate(now),
    requiredBy: "",
    requesterId: s.user.id,
    createdAt: now,
    updatedAt: now,
    reservations: [],
    issues: [],
    cancelled: false,
    history: [
      {
        requestUuid: uuid,
        at: now,
        actorId: s.user.id,
        action: "recurring occurrence",
        detail: `Created from ${template.number} for ${order.number}`,
      },
    ],
  });
}

// A list's stored source is the recurring item itself (normalizeDraft), so it
// is matched here without loading that item.
function isOwed(requests: PartsRequest[], order: WorkOrder, task: WorkTask) {
  if (isClosed(task)) return false;
  return requests.some(
    (r) =>
      r.recurring &&
      !r.cancelled &&
      r.aircraftUuid === order.aircraftUuid &&
      r.source.kind === task.source.kind &&
      r.source.uuid === task.source.uuid &&
      !hasOccurrence(requests, r, order, task),
  );
}

// Cancelled occurrences count too: cancellation must never silently reorder
// parts.
function hasOccurrence(
  requests: PartsRequest[],
  template: PartsRequest,
  order: WorkOrder,
  task: WorkTask,
) {
  return requests.some(
    (r) =>
      r.templateUuid === template.uuid &&
      r.source.uuid === task.uuid &&
      r.source.workOrderUuid === order.uuid,
  );
}

function isClosed({ status }: { status: string }) {
  return CLOSED_WORK_STATUSES.includes(status);
}
