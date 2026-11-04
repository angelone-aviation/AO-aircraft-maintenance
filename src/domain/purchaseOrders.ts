/**
 * Responsibility: Purchase orders to vendors: their stored shape, balances
 *   and status, and the one command that saves, issues, ships, receives,
 *   closes or cancels them and tracks exchange cores.
 * Layer: Domain. Pure functions and zod schemas; no I/O, no React (a `now`
 *   left to its default reads the clock).
 * Dependencies: zod; ./aircraftSpruce, ./addresses, ./partsRequests, ./model,
 *   ./programs, ./management, ./components, ./shelfLife, ./changeLog,
 *   ./rejection.
 */
import { sprucePartSchema } from "./aircraftSpruce";
import {
  addressSchema,
  formatAddress,
  assertConfirmedAddress,
} from "./addresses";
import {
  auditStockChange,
  requestPurchases,
  requestLineProgress,
  type PartsRequest,
  type RequestPurchase,
} from "./partsRequests";
import { z } from "zod";
import { latestLocalDate, type Snapshot } from "./model";
import { activeProgram, programPermission, recordProgram } from "./programs";
import { applyManagement, type Stock } from "./management";
import {
  componentSchema,
  movement,
  rebaseServicedRequirements,
  type Component,
} from "./components";
import { addDays, assertNotExpired } from "./shelfLife";
import { auditEntry } from "./changeLog";
import { Rejection } from "./rejection";

const text = z.string().trim().max(2000);
const id = z.string().min(1).max(200);
const qty = z.number().int().positive().max(1000000);
const money = z.number().int().nonnegative().max(100000000000);

const MAX_ORDER_CENTS = 10_000_000_000_000;
const HOUR_SECONDS = 3600;
const SERVICEABLE_CONDITIONS = ["new", "overhauled"];
const STALE_ORDER = "Purchase order changed. Reopen it before saving.";

/**
 * One line of an order: a part, supply or component delivered to a location
 * at `unitCents` each, optionally allocated to parts requests or returning a
 * component sent for repair. `cancelled` counts units no longer expected.
 *
 * @throws {z.ZodError} From `parse()` on a missing or invalid field.
 */
export const poLineSchema = z.object({
  sprucePart: sprucePartSchema.optional(),
  requestAllocations: z
    .array(z.object({ requestUuid: id, lineUuid: id, quantity: qty }))
    .max(100)
    .optional(),
  repairComponentUuid: z.string().optional(),
  repairWork: z.enum(["repair", "overhaul", "inspection"]).optional(),
  uuid: id,
  stockUuid: z.string().default(""),
  locationUuid: id,
  partNumber: text.min(1),
  description: text.min(1),
  quantity: qty,
  unitCents: money,
  kind: z.enum(["part", "supply", "component"]),
  componentType: z
    .enum(["Appliance", "Engine", "Propeller"])
    .default("Appliance"),
  manufacturer: text.default(""),
  model: text.default(""),
  inspectionUuid: z.string().default(""),
  aircraftUuid: z.string().default(""),
  workOrderUuid: z.string().default(""),
  cancelled: z.number().int().nonnegative().default(0),
  exchange: z.boolean().optional(),
  coreDueDays: z.number().int().min(1).max(365).optional(),
});

/** Days to return an exchange core when the line does not set its own. */
export const DEFAULT_CORE_DUE_DAYS = 30;

/**
 * A core owed back to the vendor for an exchange unit received: pending,
 * then shipped, then credited.
 *
 * @throws {z.ZodError} From `parse()` on a missing or invalid field.
 */
export const coreReturnSchema = z.object({
  uuid: id,
  lineUuid: id,
  receiptUuid: id,
  partNumber: text.min(1),
  serial: text,
  quantity: qty,
  dueDate: z.iso.date(),
  status: z.enum(["pending", "shipped", "credited"]),
  tracking: text.max(100),
  notes: text,
  shippedDate: z.iso.date().optional(),
  creditedDate: z.iso.date().optional(),
});
/** A parsed core return. */
export type CoreReturn = z.infer<typeof coreReturnSchema>;

/**
 * The fields of an order a buyer edits while it is a draft.
 *
 * @throws {z.ZodError} From `parse()` on a missing or invalid field.
 */
export const poDraftSchema = z.object({
  uuid: id,
  version: z.number().int().nonnegative(),
  vendor: text.min(1),
  vendorUuid: id.optional(),
  vendorAddressDetails: addressSchema.optional(),
  shippingAddress: addressSchema.optional(),
  vendorContact: text,
  shipTo: text.min(1),
  expectedDate: z.union([z.iso.date(), z.literal("")]),
  currency: z.string().regex(/^[A-Z]{3}$/),
  shippingCents: money,
  notes: text,
  lines: z.array(poLineSchema).min(1).max(100),
});
const movementLine = z.object({ lineUuid: id, quantity: qty });
const serialSchema = z.object({
  serial: text.min(1).max(100),
  hours: z.number().nonnegative().max(1000000),
  cycles: z.number().int().nonnegative().max(100000000),
});

/**
 * A stored order: its draft fields, its number, phase and revision, and the
 * shipments, receipts, core returns and history recorded against it.
 *
 * @throws {z.ZodError} From `parse()` on a missing or invalid field.
 */
export const poSchema = poDraftSchema.extend({
  programUuid: id,
  number: id,
  phase: z.enum(["draft", "issued", "closed", "cancelled"]),
  revision: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number(),
  issuedAt: z.number().optional(),
  shipments: z.array(
    z.object({
      uuid: id,
      date: z.iso.date(),
      carrier: text,
      tracking: text,
      lines: z.array(movementLine),
    }),
  ),
  receipts: z.array(
    z.object({
      uuid: id,
      date: z.iso.date(),
      invoice: text,
      notes: text,
      actorId: id,
      lines: z.array(
        movementLine.extend({
          condition: z.enum(["new", "overhauled", "as removed", "core"]),
          itemUuids: z.array(id),
          serials: z.array(serialSchema),
          expirationDate: z.iso.date().optional(),
        }),
      ),
    }),
  ),
  coreReturns: z.array(coreReturnSchema).max(1000).optional(),
  history: z.array(
    z.object({
      at: z.number(),
      actorId: id,
      action: text,
      reason: text,
      requestUuid: id,
      detail: text.max(100000),
    }),
  ),
});
/** A parsed purchase order. */
export type PurchaseOrder = z.infer<typeof poSchema>;
/** A parsed draft order. */
export type PODraft = z.infer<typeof poDraftSchema>;

/**
 * Whether an order's attachments may be removed: only while it is a draft,
 * because an issued order is a record sent to the vendor.
 */
export const poAttachmentRemovable = (po: Pick<PurchaseOrder, "phase">) =>
  po.phase === "draft";
/** A parsed order line. */
export type POLine = z.infer<typeof poLineSchema>;

/**
 * The commands {@link applyPOCommand} runs, by `kind`: save drafts; issue,
 * revise, close or cancel; ship; receive; and mark a core shipped or
 * credited. Each carries a request id that makes a retry safe.
 *
 * @throws {z.ZodError} From `parse()` on an unknown kind or invalid field.
 */
export const poCommandSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("save"),
    requestUuid: id,
    drafts: z.array(poDraftSchema).min(1).max(30),
  }),
  z.object({
    kind: z.enum(["issue", "revise", "close", "cancel"]),
    requestUuid: id,
    uuid: id,
    version: z.number(),
    reason: text,
  }),
  z.object({
    kind: z.literal("ship"),
    requestUuid: id,
    uuid: id,
    version: z.number(),
    date: z.iso.date(),
    carrier: text,
    tracking: text,
    lines: z.array(movementLine).min(1),
  }),
  z.object({
    kind: z.literal("receive"),
    requestUuid: id,
    uuid: id,
    version: z.number(),
    date: z.iso.date(),
    invoice: text,
    notes: text,
    lines: z
      .array(
        movementLine.extend({
          condition: z.enum(["new", "overhauled", "as removed", "core"]),
          serials: z.array(serialSchema).default([]),
          expirationDate: z.iso.date().optional(),
        }),
      )
      .min(1),
  }),
  z.object({
    kind: z.literal("core"),
    requestUuid: id,
    uuid: id,
    version: z.number(),
    coreUuid: id,
    status: z.enum(["shipped", "credited"]),
    date: z.iso.date(),
    tracking: text.max(100),
    notes: text,
  }),
]);
/** A parsed purchase order command. */
export type POCommand = z.infer<typeof poCommandSchema>;

/** How many units of a line all receipts have received. */
export function received(po: PurchaseOrder, line: POLine) {
  return po.receipts
    .flatMap((r) => r.lines)
    .filter((l) => l.lineUuid === line.uuid)
    .reduce((n, l) => n + l.quantity, 0);
}

/** How many units of a line all shipments have shipped. */
export function shipped(po: PurchaseOrder, line: POLine) {
  return po.shipments
    .flatMap((r) => r.lines)
    .filter((l) => l.lineUuid === line.uuid)
    .reduce((n, l) => n + l.quantity, 0);
}

/**
 * How many units of a line are still to receive: those ordered, less those
 * cancelled and received.
 */
export function outstanding(po: PurchaseOrder, line: POLine) {
  return line.quantity - line.cancelled - received(po, line);
}

/**
 * The status shown for an order.
 *
 * @returns The phase for a draft, closed or cancelled order. For an issued
 *   one: "Received" with nothing outstanding, else "Partially received"
 *   after any receipt, else "Shipped" or "Partially shipped" after any
 *   shipment, else "Issued".
 */
export function poStatus(po: PurchaseOrder) {
  if (po.phase !== "issued")
    return { draft: "Draft", closed: "Closed", cancelled: "Cancelled" }[
      po.phase
    ];
  if (po.lines.every((l) => outstanding(po, l) === 0)) return "Received";
  if (po.receipts.length) return "Partially received";
  if (po.shipments.length)
    return po.lines.every((l) => shipped(po, l) >= l.quantity - l.cancelled)
      ? "Shipped"
      : "Partially shipped";
  return "Issued";
}

/**
 * How many units of a stock lot are on order: outstanding on issued orders.
 *
 * @param inspectionUuid - Counts only lines for this inspection, if given.
 */
export function onOrder(
  s: Pick<Snapshot, "purchaseOrders">,
  stockUuid: string,
  inspectionUuid?: string,
) {
  return (s.purchaseOrders ?? [])
    .filter((p) => p.phase === "issued")
    .flatMap((p) => p.lines.map((l) => ({ p, l })))
    .filter(
      ({ l }) =>
        l.stockUuid === stockUuid &&
        (!inspectionUuid || l.inspectionUuid === inspectionUuid),
    )
    .reduce((n, { p, l }) => n + outstanding(p, l), 0);
}

/** An order's total in cents: each line at its unit price, plus shipping. */
export function poTotal(po: PODraft) {
  return (
    po.shippingCents +
    po.lines.reduce((n, l) => n + l.quantity * l.unitCents, 0)
  );
}

/**
 * Applies one purchase-order command in the active Flight Program, as an
 * inventory administrator. Receipts add stock and components and reserve
 * them for parts requests; repair shipments and returns move the component,
 * with movement entries. A replayed request id changes nothing.
 *
 * @param original - The snapshot; its orders, parts requests, records and
 *   change log are replaced on success and untouched on a refusal.
 * @param now - The time to record; the clock by default.
 * @returns The orders saved or changed, each one version on with a history
 *   entry and a `po.<kind>` change-log entry; on a replay, the orders as the
 *   request left them.
 * @throws {Rejection} Every refusal of the command, checked in a fixed order;
 *   as {@link validateRequestAllocations} and the stock rules it applies, and
 *   as {@link assertConfirmedAddress} when issuing.
 * @throws {z.ZodError} On an invalid command.
 */
export function applyPOCommand(
  original: Snapshot,
  raw: POCommand,
  now = Date.now(),
) {
  const s = structuredClone(original),
    c = poCommandSchema.parse(raw),
    program = activeProgram(s);
  if (!program || !programPermission(s, "admin", program))
    throw new Rejection(
      "Inventory administrator access is required for purchase orders.",
    );
  if (c.kind === "save") formatDraftAddresses(c.drafts);
  const orders = s.purchaseOrders ?? [];
  const replay = replayedOrders(s, orders, c, program);
  if (replay) return replay;
  const ctx = { s, program, now };
  const scope = orders.filter((p) => p.programUuid === program);
  const changes =
    c.kind === "save"
      ? saveDrafts(ctx, c, orders, scope)
      : [changeOrder(ctx, c, scope)];
  s.purchaseOrders = [
    ...orders.filter((p) => !changes.some((n) => n.uuid === p.uuid)),
    ...changes,
  ];
  validateRequestAllocations(s);
  auditChanges(s, c, changes, now);
  original.partsRequests = s.partsRequests;
  original.purchaseOrders = s.purchaseOrders;
  original.management = s.management;
  original.audit = s.audit;
  return changes;
}

/** One core return on an order, with the order it belongs to. */
export interface CoreReturnRow extends CoreReturn {
  poUuid: string;
  poNumber: string;
  poVersion: number;
  vendor: string;
  overdue: boolean;
}

/**
 * Every core return on the given orders, for the core-return list.
 *
 * @param today - A local date; a pending core due before it is overdue.
 * @returns The rows, earliest due date first.
 */
export function coreReturnRows(
  orders: PurchaseOrder[],
  today: string,
): CoreReturnRow[] {
  return orders
    .flatMap((p) =>
      (p.coreReturns ?? []).map((r) => ({
        ...r,
        poUuid: p.uuid,
        poNumber: p.number,
        poVersion: p.version,
        vendor: p.vendor,
        overdue: r.status === "pending" && r.dueDate < today,
      })),
    )
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

/**
 * Checks every order line's parts-request allocations and repair link, then
 * that no request line is ordered beyond what it still needs.
 *
 * @param s - The snapshot with its orders and parts requests.
 * @throws {Rejection} In order, for each line: "Request allocations exceed PO
 *   quantity."; for a live repair line, "Component already has an
 *   outstanding repair PO." or "Repair PO lines must reference one existing
 *   component and its repair request."; for each allocation, a mismatched
 *   request, parts mode for a component, a live order's vendor, currency or
 *   ship-to, or a mismatched repair; then, for each request line, "PO
 *   quantity exceeds the uncommitted request balance." or "This repair
 *   request is already ordered or fulfilled.".
 */
export function validateRequestAllocations(s: Snapshot) {
  const commitments = requestPurchases(s.purchaseOrders ?? []);
  const seenRepair = new Set<string>();
  for (const p of s.purchaseOrders ?? [])
    for (const l of p.lines) checkOrderLine(s, p, l, seenRepair);
  for (const r of s.partsRequests ?? [])
    for (const line of r.lines)
      checkRequestBalance(s, commitments, r, line.uuid, line.quantity);
}

interface Context {
  s: Snapshot;
  program: string;
  now: number;
}
type SaveCommand = Extract<POCommand, { kind: "save" }>;
type OrderCommand = Exclude<POCommand, { kind: "save" }>;
type ShipCommand = Extract<POCommand, { kind: "ship" }>;
type ReceiveCommand = Extract<POCommand, { kind: "receive" }>;
type ReceiptLine = ReceiveCommand["lines"][number];
type Serial = ReceiptLine["serials"][number];
type Allocation = NonNullable<POLine["requestAllocations"]>[number];
/** One receipt line, with its order, command and order line. */
interface Delivery {
  p: PurchaseOrder;
  c: ReceiveCommand;
  l: POLine;
  x: ReceiptLine;
}

function assertUnique(ids: string[]) {
  if (new Set(ids).size !== ids.length)
    throw new Rejection("Duplicate lines are not allowed.");
}

function formatDraftAddresses(drafts: PODraft[]) {
  for (const d of drafts) {
    if (d.shippingAddress) d.shipTo = formatAddress(d.shippingAddress);
    if (d.vendorAddressDetails)
      d.vendorContact = formatAddress(d.vendorAddressDetails);
  }
}

// A retried request returns what it did; its id may not carry another command.
function replayedOrders(
  s: Snapshot,
  orders: PurchaseOrder[],
  c: POCommand,
  program: string,
) {
  const replay = orders.flatMap((p) =>
    p.history
      .filter((h) => h.requestUuid === c.requestUuid)
      .map((h) => ({ p, h })),
  );
  if (!replay.length) return undefined;
  const reused = replay.some(
    ({ p, h }) =>
      p.programUuid !== program ||
      h.actorId !== s.user.id ||
      h.detail !== JSON.stringify(c),
  );
  if (reused) throw new Rejection("Request identifier already used.");
  return replay.map(({ p }) => p);
}

function validateLines(ctx: Context, d: PODraft) {
  const { s, program } = ctx;
  if (d.vendorUuid && !hasVendor(s, d.vendorUuid, program))
    throw new Rejection("Choose a vendor in this Flight Program.");
  if (!Number.isSafeInteger(poTotal(d)) || poTotal(d) > MAX_ORDER_CENTS)
    throw new Rejection("Order total exceeds the supported amount.");
  assertUnique(d.lines.map((l) => l.uuid));
  for (const l of d.lines) validateLine(s, program, l);
}

function hasVendor(s: Snapshot, uuid: string, program: string) {
  return !!s.management?.some(
    (r) =>
      r.kind === "vendor" && r.uuid === uuid && recordProgram(s, r) === program,
  );
}

function validateLine(s: Snapshot, program: string, l: POLine) {
  const location = s.management?.find(
    (r) => r.kind === "location" && r.uuid === l.locationUuid,
  );
  if (!location || recordProgram(s, location) !== program)
    throw new Rejection(
      "Choose a delivery inventory location in this Flight Program.",
    );
  if (l.stockUuid && !matchesStock(s, program, l))
    throw new Rejection(
      "Selected stock must match the part, category and location.",
    );
  if (
    l.aircraftUuid &&
    !s.aircraft.some(
      (a) => a.uuid === l.aircraftUuid && a.programUuid === program,
    )
  )
    throw new Rejection("Aircraft is outside this Flight Program.");
  if (
    l.inspectionUuid &&
    !s.inspections.some(
      (i) => i.uuid === l.inspectionUuid && i.aircraftUuid === l.aircraftUuid,
    )
  )
    throw new Rejection("Inspection does not match the aircraft.");
  if (
    l.workOrderUuid &&
    !s.workOrders?.some(
      (w) => w.uuid === l.workOrderUuid && w.aircraftUuid === l.aircraftUuid,
    )
  )
    throw new Rejection("Work order does not match the aircraft.");
  if (l.exchange && l.repairComponentUuid)
    throw new Rejection(
      "Repair returns cannot be exchange lines. Order the exchange unit on its own line.",
    );
}

function matchesStock(s: Snapshot, program: string, l: POLine) {
  const stock = s.management?.find(
    (r): r is Stock => r.kind === "stock" && r.uuid === l.stockUuid,
  );
  return (
    !!stock &&
    recordProgram(s, stock) === program &&
    stock.locationUuid === l.locationUuid &&
    stock.partNumber === l.partNumber &&
    stock.category === l.kind
  );
}

function saveDrafts(
  ctx: Context,
  c: SaveCommand,
  orders: PurchaseOrder[],
  scope: PurchaseOrder[],
) {
  assertUnique(c.drafts.map((d) => d.uuid));
  let seq = Math.max(
    0,
    ...scope.map((p) => Number(p.number.replace(/^PO-/, "")) || 0),
  );
  const saved: PurchaseOrder[] = [];
  for (const d of c.drafts) {
    const previous = orders.find((p) => p.uuid === d.uuid);
    assertEditableDraft(ctx, d, previous);
    const number = previous?.number ?? `PO-${String(++seq).padStart(5, "0")}`;
    saved.push(draftOrder(ctx, c, d, previous, number));
  }
  return saved;
}

function assertEditableDraft(
  ctx: Context,
  d: PODraft,
  previous: PurchaseOrder | undefined,
) {
  if (
    previous &&
    (previous.programUuid !== ctx.program || previous.phase !== "draft")
  )
    throw new Rejection(
      "Only draft purchase orders in this program can be edited.",
    );
  if ((previous?.version ?? 0) !== d.version) throw new Rejection(STALE_ORDER);
  if (d.lines.some((l) => l.cancelled))
    throw new Rejection("Draft lines cannot contain cancelled quantities.");
  validateLines(ctx, d);
}

function draftOrder(
  { s, program, now }: Context,
  c: SaveCommand,
  d: PODraft,
  previous: PurchaseOrder | undefined,
  number: string,
): PurchaseOrder {
  const p: PurchaseOrder = {
    ...d,
    programUuid: program,
    number,
    phase: "draft",
    version: d.version + 1,
    revision: previous?.revision ?? 1,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    shipments: [],
    receipts: [],
    history: previous?.history ?? [],
  };
  p.history.push({
    at: now,
    actorId: s.user.id,
    action: "Draft saved",
    reason: "",
    requestUuid: c.requestUuid,
    detail: JSON.stringify(c),
  });
  return p;
}

function changeOrder(ctx: Context, c: OrderCommand, scope: PurchaseOrder[]) {
  const found = scope.find((p) => p.uuid === c.uuid);
  if (!found) throw new Rejection("Purchase order not found.");
  const p = structuredClone(found);
  if (p.version !== c.version) throw new Rejection(STALE_ORDER);
  runAction(ctx, p, c);
  p.version++;
  p.updatedAt = ctx.now;
  p.history.push({
    at: ctx.now,
    actorId: ctx.s.user.id,
    action: c.kind,
    requestUuid: c.requestUuid,
    reason: "reason" in c ? c.reason : "",
    detail: JSON.stringify(c),
  });
  return p;
}

function runAction(ctx: Context, p: PurchaseOrder, c: OrderCommand) {
  if (c.kind === "core") return updateCoreReturn(p, c, ctx.now);
  if (c.kind === "ship" || c.kind === "receive") return moveOrder(ctx, p, c);
  if (c.kind === "issue") return issueOrder(ctx, p);
  if (c.kind === "revise") return reviseOrder(p, c.reason);
  if (c.kind === "close") return closeOrder(p);
  cancelOrder(ctx.s, p, c.reason);
}

function issueOrder(ctx: Context, p: PurchaseOrder) {
  if (p.phase !== "draft") throw new Rejection("Only drafts can be issued.");
  validateLines(ctx, p);
  if (p.shippingAddress) assertConfirmedAddress(p.shippingAddress);
  p.phase = "issued";
  p.issuedAt = ctx.now;
}

function reviseOrder(p: PurchaseOrder, reason: string) {
  if (p.phase !== "issued" || p.shipments.length || p.receipts.length)
    throw new Rejection(
      "Only unshipped, unreceived orders can return to draft for revision.",
    );
  if (!reason) throw new Rejection("Enter the revision reason.");
  p.phase = "draft";
  p.revision++;
}

function closeOrder(p: PurchaseOrder) {
  if (p.phase !== "issued" || p.lines.some((l) => outstanding(p, l) > 0))
    throw new Rejection(
      "Receive or cancel all outstanding quantities before closing.",
    );
  p.phase = "closed";
}

// Cancelling keeps what was received: the order closes if anything was.
function cancelOrder(s: Snapshot, p: PurchaseOrder, reason: string) {
  if (
    s.management?.some(
      (r) => r.kind === "component" && r.outForRepair?.poUuid === p.uuid,
    )
  )
    throw new Rejection(
      "Receive all components back from repair before cancelling the order.",
    );
  if (!["draft", "issued"].includes(p.phase))
    throw new Rejection("Order is already closed or cancelled.");
  if (!reason) throw new Rejection("Enter a cancellation reason.");
  p.lines = p.lines.map((l) => ({
    ...l,
    cancelled: l.quantity - received(p, l),
  }));
  p.phase = p.receipts.length ? "closed" : "cancelled";
}

function updateCoreReturn(
  p: PurchaseOrder,
  c: Extract<POCommand, { kind: "core" }>,
  now: number,
) {
  const core = p.coreReturns?.find((r) => r.uuid === c.coreUuid);
  if (!core) throw new Rejection("Core return not found.");
  if (c.date > latestLocalDate(now))
    throw new Rejection(
      "Core shipment and credit dates cannot be in the future.",
    );
  let next: CoreReturn;
  if (c.status === "shipped") {
    if (core.status !== "pending")
      throw new Rejection("Only pending cores can be marked shipped.");
    if (!c.tracking)
      throw new Rejection("Enter the core shipment tracking number.");
    next = {
      ...core,
      status: "shipped",
      shippedDate: c.date,
      tracking: c.tracking,
    };
  } else {
    if (core.status !== "shipped")
      throw new Rejection("Ship the core before marking it credited.");
    if (c.date < core.shippedDate!)
      throw new Rejection("Credit date cannot precede the core shipment.");
    next = { ...core, status: "credited", creditedDate: c.date };
  }
  if (c.notes) next.notes = c.notes;
  p.coreReturns = p.coreReturns!.map((r) => (r.uuid === core.uuid ? next : r));
}

function moveOrder(
  ctx: Context,
  p: PurchaseOrder,
  c: ShipCommand | ReceiveCommand,
) {
  if (p.phase !== "issued")
    throw new Rejection("Issue the order before shipping or receiving.");
  validateLines(ctx, p);
  if (c.date > latestLocalDate(ctx.now))
    throw new Rejection("Shipment and receipt dates cannot be in the future.");
  assertUnique(c.lines.map((l) => l.lineUuid));
  for (const x of c.lines) checkBalance(p, c.kind, x);
  if (c.kind === "ship") shipOrder(ctx, p, c);
  else receiveOrder(ctx, p, c);
}

// A line ships at most what is neither cancelled nor already shipped or
// received; it receives at most what is outstanding.
function checkBalance(
  p: PurchaseOrder,
  kind: "ship" | "receive",
  x: { lineUuid: string; quantity: number },
) {
  const l = p.lines.find((l) => l.uuid === x.lineUuid);
  if (!l) throw new Rejection("PO line not found.");
  const remaining =
    kind === "ship"
      ? l.quantity - l.cancelled - Math.max(shipped(p, l), received(p, l))
      : outstanding(p, l);
  if (x.quantity > remaining)
    throw new Rejection("Quantity exceeds the outstanding balance.");
}

function shipOrder(ctx: Context, p: PurchaseOrder, c: ShipCommand) {
  for (const x of c.lines) {
    const l = p.lines.find((l) => l.uuid === x.lineUuid)!;
    if (l.repairComponentUuid)
      shipForRepair(ctx, p, l, l.repairComponentUuid, c);
  }
  p.shipments.push({
    uuid: c.requestUuid,
    date: c.date,
    carrier: c.carrier,
    tracking: c.tracking,
    lines: c.lines,
  });
}

function shipForRepair(
  { s, program, now }: Context,
  p: PurchaseOrder,
  l: POLine,
  componentUuid: string,
  c: ShipCommand,
) {
  const component = findComponent(s, componentUuid);
  if (
    !component ||
    component.installed ||
    component.outForRepair ||
    recordProgram(s, component) !== program
  )
    throw new Rejection(
      "Repair component must be in inventory and available before shipment.",
    );
  const requests = (l.requestAllocations ?? []).map((a) =>
    s.partsRequests?.find((r) => r.uuid === a.requestUuid),
  );
  if (requests.some((r) => r && c.date < r.date))
    throw new Rejection(
      "Repair shipment date cannot precede the request date.",
    );
  component.outForRepair = { poUuid: p.uuid, date: c.date };
  component.version++;
  const note = `Sent for ${l.repairWork} on ${p.number}; ${c.carrier} ${c.tracking}`;
  s.management!.push({
    ...movement(
      component,
      "REPAIR_SHIP",
      s,
      `${c.requestUuid}-${l.uuid}`,
      note,
      now,
    ),
    date: c.date,
  });
}

function findComponent(s: Snapshot, uuid: string | undefined) {
  return s.management?.find(
    (r): r is Component => r.kind === "component" && r.uuid === uuid,
  );
}

function receiveOrder(ctx: Context, p: PurchaseOrder, c: ReceiveCommand) {
  const lines: PurchaseOrder["receipts"][number]["lines"] = [];
  for (const x of c.lines) {
    const l = p.lines.find((l) => l.uuid === x.lineUuid)!;
    lines.push(receiveLine(ctx, { p, c, l, x }));
  }
  p.receipts.push({
    uuid: c.requestUuid,
    date: c.date,
    invoice: c.invoice,
    notes: c.notes,
    actorId: ctx.s.user.id,
    lines,
  });
}

function receiveLine(ctx: Context, d: Delivery) {
  const { l, x } = d;
  const itemUuids = receiveItems(ctx, d);
  const allocations = l.requestAllocations ?? [];
  if (!l.repairComponentUuid && l.kind !== "component" && allocations.length)
    reserveReceived(ctx, d, itemUuids[0]);
  if (l.exchange) addCoreReturn(d);
  return { ...x, itemUuids };
}

function receiveItems(ctx: Context, d: Delivery) {
  const { l, x } = d;
  if (l.repairComponentUuid) return [receiveRepairReturn(ctx, d)];
  if (l.kind !== "component") return [receiveStock(ctx, d, l.kind)];
  if (x.serials.length !== x.quantity)
    throw new Rejection(
      "Enter one serial number and verified time/cycles for each component received.",
    );
  return x.serials.map((serial) => receiveComponent(ctx, d, serial));
}

function receiveRepairReturn(ctx: Context, d: Delivery) {
  const { s, now } = ctx;
  const { p, c, l, x } = d;
  const component = shippedComponent(s, d);
  const serial = x.serials[0];
  if (
    Math.round(serial.hours * HOUR_SECONDS) < component.timeSinceNew ||
    serial.cycles < component.cyclesSinceNew
  )
    throw new Rejection(
      "Verified total time and cycles cannot decrease on a repair return.",
    );
  if (c.date < component.outForRepair!.date)
    throw new Rejection("Return date cannot precede repair shipment.");
  accrueShopUsage(component, serial);
  resetServicedLimits(ctx, component, d);
  component.locationUuid = l.locationUuid;
  component.incomingTag = {
    ...component.incomingTag,
    reference: p.number,
    condition: x.condition,
    invoice: c.invoice,
    receivedDate: c.date,
  };
  delete component.outForRepair;
  component.version++;
  const note = `Returned from ${l.repairWork} on ${p.number}; invoice ${c.invoice}; condition ${x.condition}; ${c.notes}`;
  s.management!.push({
    ...movement(
      component,
      "REPAIR_RETURN",
      s,
      `${c.requestUuid}-${l.uuid}`,
      note,
      now,
    ),
    date: c.date,
  });
  return component.uuid;
}

function shippedComponent(s: Snapshot, { p, l, x }: Delivery) {
  const component = findComponent(s, l.repairComponentUuid);
  if (
    !component ||
    component.outForRepair?.poUuid !== p.uuid ||
    component.installed ||
    x.quantity !== 1 ||
    x.serials.length !== 1 ||
    x.serials[0].serial !== component.serial
  )
    throw new Rejection(
      "Receive the original shipped component using its existing serial number.",
    );
  return component;
}

// The shop's verified totals replace the component's; time since overhaul
// and since repair grow by the same time.
function accrueShopUsage(component: Component, serial: Serial) {
  const elapsed =
    Math.round(serial.hours * HOUR_SECONDS) - component.timeSinceNew;
  component.timeSinceNew += elapsed;
  component.cyclesSinceNew = serial.cycles;
  if (component.timeSinceOverhaul !== null)
    component.timeSinceOverhaul += elapsed;
  if (component.timeSinceRepair !== null) component.timeSinceRepair += elapsed;
}

// Only the work ordered, returned in a serviceable condition, restarts the
// limits counted from it.
function resetServicedLimits(
  { s, now }: Context,
  component: Component,
  { c, l, x }: Delivery,
) {
  const before = { ...component };
  const overhaul = l.repairWork === "overhaul" && x.condition === "overhauled";
  const repair =
    l.repairWork === "repair" && SERVICEABLE_CONDITIONS.includes(x.condition);
  if (overhaul) {
    component.timeSinceOverhaul = 0;
    component.calendarOverhaulDaysBase = 0;
    component.calendarOverhaulDate = c.date;
  }
  if (repair) component.timeSinceRepair = 0;
  if (!overhaul && !repair) return;
  const work = { overhaul, repair, date: c.date };
  const updated = rebaseServicedRequirements(s, component, before, work, now);
  s.management = s.management!.map(
    (r) => updated.find((u) => u.uuid === r.uuid) ?? r,
  );
}

function receiveComponent(
  { s, program, now }: Context,
  d: Delivery,
  serial: Serial,
) {
  const { p, l } = d;
  const taken = s.management?.some(
    (r) =>
      r.kind === "component" &&
      recordProgram(s, r) === program &&
      r.partNumber.toUpperCase() === l.partNumber.toUpperCase() &&
      r.serial.toUpperCase() === serial.serial.toUpperCase(),
  );
  if (taken)
    throw new Rejection(
      "This part and serial number already exist in inventory or on an aircraft.",
    );
  const uuid = crypto.randomUUID();
  applyManagement(
    s,
    {
      action: "record.save",
      requestUuid: crypto.randomUUID(),
      record: receivedComponent(uuid, program, d, serial),
      reason: `Receipt ${p.number}`,
    },
    now,
  );
  return uuid;
}

function receivedComponent(
  uuid: string,
  program: string,
  { p, c, l, x }: Delivery,
  serial: Serial,
) {
  return componentSchema.parse({
    uuid,
    version: 0,
    programUuid: program,
    kind: "component",
    aircraftUuid: "",
    componentType: l.componentType,
    partNumber: l.partNumber,
    serial: serial.serial,
    manufacturer: l.manufacturer,
    model: l.model,
    notes: `Received on ${p.number}; invoice ${c.invoice}; condition ${x.condition}`,
    trackTime: true,
    trackCycles: true,
    trackCalendar: false,
    installed: false,
    locationUuid: l.locationUuid,
    installedSeconds: 0,
    installedCycles: 0,
    timeSinceNew: Math.round(serial.hours * HOUR_SECONDS),
    timeSinceOverhaul: null,
    timeSinceRepair: null,
    cyclesSinceNew: serial.cycles,
    serviceDaysBase: 0,
    incomingTag: { reference: p.number, condition: x.condition },
    expirationDate: x.expirationDate,
  });
}

function receiveStock(ctx: Context, d: Delivery, category: Stock["category"]) {
  const { p, c, x } = d;
  if (x.serials.length)
    throw new Rejection("Serial numbers are only for trackable components.");
  const stock = matchingLot(ctx.s, d);
  if (!stock) return addLot(ctx, d, category);
  applyManagement(
    ctx.s,
    {
      action: "stock.move",
      requestUuid: crypto.randomUUID(),
      uuid: stock.uuid,
      version: stock.version,
      operation: "receive",
      quantity: x.quantity,
      reason: `Receipt ${p.number}; invoice ${c.invoice}`,
    },
    ctx.now,
  );
  return stock.uuid;
}

// A delivery in another condition or with another shelf life keeps its lot
// identity: it goes into a stock lot of its own.
function matchingLot(s: Snapshot, { l, x }: Delivery) {
  const stock = s.management?.find(
    (r): r is Stock => r.uuid === l.stockUuid && r.kind === "stock",
  );
  if (
    stock?.condition !== x.condition ||
    stock.expirationDate !== x.expirationDate
  )
    return undefined;
  return stock;
}

function addLot(
  { s, program, now }: Context,
  { p, c, l, x }: Delivery,
  category: Stock["category"],
) {
  const uuid = crypto.randomUUID();
  const record: Stock = {
    uuid,
    version: 0,
    programUuid: program,
    kind: "stock",
    partNumber: l.partNumber,
    description: l.description,
    category,
    condition: x.condition,
    locationUuid: l.locationUuid,
    quantity: x.quantity,
    minimum: 0,
    alternates: "",
    vendor: p.vendor,
    poRef: p.number,
    invoiceNumber: c.invoice,
    cost: l.unitCents / 100,
    expirationDate: x.expirationDate,
  };
  applyManagement(
    s,
    {
      action: "record.save",
      requestUuid: crypto.randomUUID(),
      record,
      reason: `Receipt ${p.number}`,
    },
    now,
  );
  if (!l.stockUuid) l.stockUuid = uuid;
  return uuid;
}

// Received parts fill the line's allocations in order, after what earlier
// receipts already filled.
function reserveReceived(ctx: Context, d: Delivery, stockUuid: string) {
  const { p, l, x } = d;
  if (!SERVICEABLE_CONDITIONS.includes(x.condition))
    throw new Rejection(
      "Requested parts must be received in serviceable condition before being reserved.",
    );
  let offset = received(p, l),
    available = x.quantity;
  const stock = ctx.s.management?.find(
    (r): r is Stock => r.kind === "stock" && r.uuid === stockUuid,
  );
  if (!stock) throw Error("Received stock not found.");
  assertNotExpired(stock, ctx.now);
  for (const a of l.requestAllocations ?? []) {
    const skip = Math.min(a.quantity, offset);
    offset -= skip;
    const quantity = Math.min(a.quantity - skip, available);
    available -= quantity;
    if (quantity) reserveAllocation(ctx, d, a, stock, quantity);
  }
}

function reserveAllocation(
  { s, now }: Context,
  { p, c }: Delivery,
  a: Allocation,
  stock: Stock,
  quantity: number,
) {
  const request = s.partsRequests?.find((r) => r.uuid === a.requestUuid);
  if (!request || request.cancelled)
    throw new Rejection("Receiving allocation is unavailable.");
  const reservation = request.reservations.find(
    (r) => r.lineUuid === a.lineUuid && r.stockUuid === stock.uuid,
  );
  if (reservation) reservation.quantity += quantity;
  else
    request.reservations.push({
      lineUuid: a.lineUuid,
      stockUuid: stock.uuid,
      quantity,
    });
  const before = JSON.stringify(stock);
  stock.reservedQuantity = (stock.reservedQuantity ?? 0) + quantity;
  stock.version++;
  const note = `Received and reserved ${quantity} for ${request.number} from ${p.number}`;
  auditStockChange(s, before, stock, "reserve", note, now);
  request.version++;
  request.updatedAt = now;
  request.history.push({
    requestUuid: c.requestUuid,
    at: now,
    actorId: s.user.id,
    action: `Received and reserved from ${p.number}`,
    detail: JSON.stringify(c),
  });
}

function addCoreReturn({ p, c, l, x }: Delivery) {
  p.coreReturns = [
    ...(p.coreReturns ?? []),
    {
      uuid: `${c.requestUuid}-${l.uuid}`,
      lineUuid: l.uuid,
      receiptUuid: c.requestUuid,
      partNumber: l.partNumber,
      serial: x.serials.map((s) => s.serial).join(", "),
      quantity: x.quantity,
      dueDate: addDays(c.date, l.coreDueDays ?? DEFAULT_CORE_DUE_DAYS),
      status: "pending",
      tracking: "",
      notes: "",
    },
  ];
}

function auditChanges(
  s: Snapshot,
  c: POCommand,
  changes: PurchaseOrder[],
  now: number,
) {
  for (const p of changes)
    s.audit.unshift(
      auditEntry(
        s,
        {
          uuid: `${c.requestUuid}-${p.uuid}`,
          programUuid: activeProgram(s),
          action: `po.${c.kind}`,
          entityUuid: p.uuid,
          after: p,
        },
        now,
      ),
    );
}

function checkOrderLine(
  s: Snapshot,
  p: PurchaseOrder,
  l: POLine,
  seenRepair: Set<string>,
) {
  const allocations = l.requestAllocations ?? [];
  if (allocations.reduce((n, a) => n + a.quantity, 0) > l.quantity)
    throw new Rejection("Request allocations exceed PO quantity.");
  if (l.repairComponentUuid && p.phase !== "cancelled" && outstanding(p, l) > 0)
    checkRepairLine(s, p, l, l.repairComponentUuid, seenRepair);
  for (const a of allocations) checkAllocation(s, p, l, a);
}

// A component is out for repair on one order at a time, and a repair line
// sends exactly that component for the work its repair request asked for.
function checkRepairLine(
  s: Snapshot,
  p: PurchaseOrder,
  l: POLine,
  componentUuid: string,
  seenRepair: Set<string>,
) {
  if (seenRepair.has(componentUuid))
    throw new Rejection("Component already has an outstanding repair PO.");
  seenRepair.add(componentUuid);
  const component = findComponent(s, componentUuid);
  if (
    !component ||
    component.installed ||
    component.parentComponentUuid ||
    (component.outForRepair && component.outForRepair.poUuid !== p.uuid) ||
    recordProgram(s, component) !== p.programUuid ||
    component.partNumber !== l.partNumber ||
    l.kind !== "component" ||
    l.quantity !== 1 ||
    !l.repairWork ||
    l.requestAllocations?.length !== 1
  )
    throw new Rejection(
      "Repair PO lines must reference one existing component and its repair request.",
    );
}

function checkAllocation(
  s: Snapshot,
  p: PurchaseOrder,
  l: POLine,
  a: Allocation,
) {
  const r = s.partsRequests?.find((r) => r.uuid === a.requestUuid);
  const line = r?.lines.find((x) => x.uuid === a.lineUuid);
  if (
    !r ||
    r.recurring ||
    !line ||
    r.programUuid !== p.programUuid ||
    line.partNumber !== l.partNumber ||
    r.aircraftUuid !== l.aircraftUuid
  )
    throw new Rejection("PO allocation does not match the parts request.");
  if (r.mode === "parts" && l.kind === "component")
    throw new Rejection(
      "Use stock parts for parts requests; use a repair request for an existing serialized component.",
    );
  const live = p.phase !== "cancelled" && outstanding(p, l) > 0;
  if (live && conflictsWithOrder(r, p))
    throw new Rejection(
      "Request vendor, currency and ship-to must match the PO.",
    );
  if (
    (r.mode === "repair") !== Boolean(l.repairComponentUuid) ||
    (r.mode === "repair" &&
      (line.componentUuid !== l.repairComponentUuid ||
        line.service !== l.repairWork))
  )
    throw new Rejection(
      "Repair allocation does not match the original component and work requested.",
    );
}

function conflictsWithOrder(r: PartsRequest, p: PurchaseOrder) {
  return (
    r.cancelled ||
    (!!r.vendor && r.vendor.toLowerCase() !== p.vendor.toLowerCase()) ||
    r.currency !== p.currency ||
    (!!r.shipTo && r.shipTo.trim() !== p.shipTo.trim())
  );
}

// Open orders, reservations and issues together may not exceed a request
// line; a repair request is ordered once.
function checkRequestBalance(
  s: Snapshot,
  commitments: RequestPurchase[],
  r: PartsRequest,
  lineUuid: string,
  lineQuantity: number,
) {
  const allocations = commitments.filter(
    (a) => a.requestUuid === r.uuid && a.lineUuid === lineUuid,
  );
  const ordered = allocations.reduce((n, a) => n + a.quantity - a.received, 0);
  const progress = requestLineProgress(
    { ...s, partsRequestPurchases: undefined },
    r,
    lineUuid,
  );
  if (ordered + progress.reserved + progress.issued > lineQuantity)
    throw new Rejection("PO quantity exceeds the uncommitted request balance.");
  if (
    r.mode === "repair" &&
    allocations.reduce((n, a) => n + a.quantity, 0) > 1
  )
    throw new Rejection("This repair request is already ordered or fulfilled.");
}
