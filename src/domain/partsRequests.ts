import { adAircraftUuid } from "./adOwnership";
import { lastCompliance } from "./adCompliance";
import { sprucePartSchema } from "./aircraftSpruce";
import { addressSchema, formatAddress } from "./addresses";
import { z } from "zod";
import { can, latestLocalDate, type Snapshot } from "./model";
import { activeProgram, programPermission, recordProgram } from "./programs";
import { assertNotExpired } from "./shelfLife";
import type { PurchaseOrder } from "./purchaseOrders";
const text = z.string().trim().max(4000);
const id = z.string().min(1).max(200);
const count = z.number().int().nonnegative().max(1000000);
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
export type RequestSource = z.infer<typeof requestSourceSchema>;
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
  quotedCents: z.number().int().nonnegative().max(100000000000).default(0),
});
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
  lines: z.array(requestLineSchema).min(1).max(100),
});
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
export type PartsRequest = z.infer<typeof partsRequestSchema>;
export type RequestDraft = z.infer<typeof requestDraftSchema>;
export type RequestLine = z.infer<typeof requestLineSchema>;
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
export type RequestCommand = z.infer<typeof requestCommandSchema>;
export function resolveRequestSource(s: Snapshot, source: RequestSource) {
  let aircraftUuid = "",
    label = "Inventory stock request",
    componentUuid = "";
  if (source.kind !== "stock") {
    if (source.kind === "workTask") {
      const w = s.workOrders?.find((w) => w.uuid === source.workOrderUuid);
      const task = w?.tasks.find((t) => t.uuid === source.uuid);
      if (!w || !task)
        throw Error("Save the work-order task before requesting parts.");
      aircraftUuid = w.aircraftUuid;
      label = `${w.number}: ${task.description}`;
    } else if (source.kind === "airworthiness") {
      const ad = s.airworthiness?.find((r) =>
        r.tasks.some((t) => t.uuid === source.uuid),
      );
      const task = ad?.tasks.find((t) => t.uuid === source.uuid);
      if (!ad || !task) throw Error("AD task is unavailable.");
      aircraftUuid = adAircraftUuid(s, ad);
      componentUuid = ad.componentUuid;
      label = `AD ${ad.source.number}: ${task.description}`;
    } else {
      const record =
        source.kind === "discrepancy"
          ? s.discrepancies.find((r) => r.uuid === source.uuid)
          : source.kind === "inspection"
            ? s.inspections.find((r) => r.uuid === source.uuid)
            : source.kind === "jobCard"
              ? s.taskCards?.find((r) => r.uuid === source.uuid)
              : s.management?.find(
                  (r) => r.uuid === source.uuid && r.kind === source.kind,
                );
      if (!record || !("aircraftUuid" in record))
        throw Error("Linked item is unavailable.");
      if ("kind" in record && recordProgram(s, record) !== activeProgram(s))
        throw Error("Linked item is outside this Flight Program.");
      aircraftUuid = record.aircraftUuid;
      label =
        "title" in record
          ? String(record.title)
          : "description" in record
            ? String(record.description)
            : source.kind;
      if (
        source.kind === "component" &&
        "partNumber" in record &&
        "serial" in record
      ) {
        componentUuid = record.uuid;
        label = `${record.partNumber} · S/N ${record.serial}`;
      }
      if ("componentUuid" in record) componentUuid = record.componentUuid ?? "";
    }
  } else if (source.uuid) {
    const stock = s.management?.find(
      (r) => r.uuid === source.uuid && r.kind === "stock",
    );
    if (!stock || recordProgram(s, stock) !== activeProgram(s))
      throw Error("Stock item is unavailable.");
    label = `Inventory: ${stock.kind === "stock" ? stock.partNumber : ""}`;
  }
  const aircraft = s.aircraft.find((a) => a.uuid === aircraftUuid);
  if (aircraftUuid && (!aircraft || aircraft.programUuid !== activeProgram(s)))
    throw Error("Aircraft is outside this Flight Program.");
  return { aircraftUuid, label, componentUuid, aircraft };
}
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
export function requestPurchases(orders: PurchaseOrder[]): RequestPurchase[] {
  return orders.flatMap((p) =>
    p.lines.flatMap((l) => {
      let remaining = l.quantity - l.cancelled;
      let received = p.receipts
        .flatMap((r) => r.lines)
        .filter((r) => r.lineUuid === l.uuid)
        .reduce((n, r) => n + r.quantity, 0);
      let shipped = p.shipments
        .flatMap((r) => r.lines)
        .filter((r) => r.lineUuid === l.uuid)
        .reduce((n, r) => n + r.quantity, 0);
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
 */
export function auditStockChange(
  s: Snapshot,
  before: string,
  stock: { uuid: string },
  action: "reserve" | "release" | "issue",
  reason: string,
  now: number,
) {
  s.audit.unshift({
    uuid: crypto.randomUUID(),
    at: now,
    actorId: s.user.id,
    action: `stock.${action}`,
    entityUuid: stock.uuid,
    reason,
    before,
    after: JSON.stringify(stock),
  });
}
export function applyRequestCommand(
  original: Snapshot,
  raw: RequestCommand,
  now = Date.now(),
) {
  const s = structuredClone(original),
    c = requestCommandSchema.parse(raw),
    program = activeProgram(s);
  if (!program) throw Error("Choose a Flight Program.");
  if (c.kind === "save") {
    const d = c.draft;
    for (const [field, details] of [
      ["vendorAddress", "vendorAddressDetails"],
      ["shipTo", "shipToDetails"],
      ["shipFrom", "shipFromDetails"],
      ["billTo", "billToDetails"],
    ] as const) {
      if (d[details]) d[field] = formatAddress(d[details]);
    }
  }
  const requests = s.partsRequests ?? [];
  const previous = requests.find(
    (r) => r.uuid === (c.kind === "save" ? c.draft.uuid : c.uuid),
  );
  if (c.kind === "save" && c.draft.recurring) {
    const recurringSource = recurringRequestSource(s, c.draft.source);
    if (!recurringSource || c.draft.mode !== "parts")
      throw Error(
        "Recurring parts require a recurring inspection, service or AD task.",
      );
    c.draft.source = recurringSource;
  }
  const replay = requests
    .flatMap((r) => r.history.map((h) => ({ r, h })))
    .find((x) => x.h.requestUuid === c.requestUuid);
  if (replay) {
    if (
      replay.r.programUuid !== program ||
      replay.h.actorId !== s.user.id ||
      replay.h.detail !== JSON.stringify(c)
    )
      throw Error("Request identifier already used.");
    return replay.r;
  }
  if (previous && previous.programUuid !== program)
    throw Error("Request is outside this Flight Program.");
  if (
    (previous?.version ?? 0) !==
    (c.kind === "save" ? c.draft.version : c.version)
  )
    throw Error("Request changed. Reopen it before saving.");
  const source =
    c.kind === "save" ? resolveRequestSource(s, c.draft.source) : null;
  const aircraftUuid = source?.aircraftUuid ?? previous?.aircraftUuid ?? "";
  if (
    !(aircraftUuid
      ? can(s, aircraftUuid, "maintenance")
      : programPermission(s, "admin"))
  )
    throw Error("Maintenance access is required.");
  if (previous?.cancelled) throw Error("Cancelled requests are read-only.");
  let r: PartsRequest;
  if (c.kind === "save") {
    const d = c.draft;
    if (previous && !!previous.recurring !== !!d.recurring)
      throw Error(
        "Create a separate recurring parts list; an existing request cannot change its recurrence type.",
      );

    if (d.date > latestLocalDate(now))
      throw Error("Request date cannot be in the future.");
    if (new Set(d.lines.map((l) => l.uuid)).size !== d.lines.length)
      throw Error("Duplicate request lines.");
    if (
      previous &&
      JSON.stringify(previous.source) !== JSON.stringify(d.source)
    )
      throw Error("Request source cannot change.");
    if (
      previous &&
      (previous.reservations.length ||
        previous.issues.length ||
        requestPurchases(s.purchaseOrders ?? []).some(
          (a) => a.requestUuid === previous.uuid,
        ))
    ) {
      if (
        JSON.stringify(previous.lines) !== JSON.stringify(d.lines) ||
        previous.mode !== d.mode ||
        previous.vendor !== d.vendor ||
        previous.currency !== d.currency ||
        previous.shipTo !== d.shipTo
      )
        throw Error(
          "Release reservations and remove draft PO allocations before changing lines or purchasing details. Fulfilled lines are retained for traceability.",
        );
    }
    for (const line of d.lines) {
      if (d.mode === "repair") {
        const component = s.management?.find(
          (x) => x.kind === "component" && x.uuid === line.componentUuid,
        );
        if (
          !component ||
          component.kind !== "component" ||
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
          throw Error(
            "Choose an uninstalled serialized component in this Flight Program; repair quantity must be one.",
          );
        if (
          requests.some(
            (x) =>
              x.uuid !== d.uuid &&
              !x.cancelled &&
              requestStatus(s, x) !== "Fulfilled" &&
              x.lines.some((l) => l.componentUuid === component.uuid),
          )
        )
          throw Error("This component already has an open repair request.");
        line.componentSerial = component.serial;
        line.componentTSN = component.timeSinceNew;
        line.componentTSO = component.timeSinceOverhaul;
        if (!line.defect || !line.workRequested)
          throw Error("Enter the defect and work requested for repair.");
      } else if (line.componentUuid)
        throw Error(
          "Use a repair request for an existing serialized component.",
        );
    }
    r = {
      ...d,
      templateUuid: previous?.templateUuid,
      programUuid: program,
      aircraftUuid,
      sourceLabel: source!.label.slice(0, 4000),
      aircraftRegistration: source!.aircraft?.registration ?? "",
      aircraftSerial: source!.aircraft?.serial ?? "",
      aircraftModel: source!.aircraft
        ? `${source!.aircraft.make} ${source!.aircraft.model}`
        : "",
      number:
        previous?.number ??
        `PR-${String(1 + Math.max(0, ...requests.filter((x) => x.programUuid === program).map((x) => Number(x.number.slice(3)) || 0))).padStart(5, "0")}`,
      requesterId: previous?.requesterId ?? s.user.id,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      cancelled: false,
      reservations: previous?.reservations ?? [],
      issues: previous?.issues ?? [],
      history: previous?.history ?? [],
    };
  } else {
    if (!previous) throw Error("Request not found.");
    r = previous;
    if (r.recurring && c.kind !== "cancel")
      throw Error(
        "Reserve or issue parts against an occurrence request, not the recurring list.",
      );
    if (!programPermission(s, "admin"))
      throw Error(
        "Inventory administrator access is required to reserve, issue or cancel requests.",
      );
    if (c.kind === "cancel") {
      if (
        requestPurchases(s.purchaseOrders ?? []).some(
          (a) => a.requestUuid === r.uuid && a.quantity > a.received,
        )
      )
        throw Error(
          "Remove draft allocations or cancel outstanding PO quantities first.",
        );
      for (const reservation of r.reservations) {
        const stock = s.management?.find(
          (x) => x.kind === "stock" && x.uuid === reservation.stockUuid,
        );
        if (!stock || stock.kind !== "stock")
          throw Error("Reserved stock is unavailable.");
        const before = JSON.stringify(stock);
        stock.reservedQuantity =
          (stock.reservedQuantity ?? 0) - reservation.quantity;
        stock.version++;
        auditStockChange(
          s,
          before,
          stock,
          "release",
          `Released ${reservation.quantity} from ${r.number}: request cancelled (${c.reason})`,
          now,
        );
      }
      r.reservations = [];
      r.cancelled = true;
    } else {
      if (r.mode === "repair")
        throw Error(
          "Repair components are shipped and received through their purchase order.",
        );
      const line = r.lines.find((l) => l.uuid === c.lineUuid);
      const stock = s.management?.find(
        (x) => x.kind === "stock" && x.uuid === c.stockUuid,
      );
      if (
        !line ||
        !stock ||
        stock.kind !== "stock" ||
        recordProgram(s, stock) !== program
      )
        throw Error("Select a stock item in this Flight Program.");
      const reservation = r.reservations.find(
        (a) => a.lineUuid === line.uuid && a.stockUuid === stock.uuid,
      );
      const progress = requestLineProgress(s, r, line.uuid);
      const before = JSON.stringify(stock);
      if (c.kind !== "release") assertNotExpired(stock, now);
      if (c.kind === "reserve") {
        if (
          stock.partNumber !== line.partNumber &&
          !(
            c.alternateConfirmed &&
            line.alternateNumber &&
            stock.partNumber === line.alternateNumber
          )
        )
          throw Error(
            "Select the requested part or explicitly confirm its listed alternate.",
          );
        if (!["new", "overhauled"].includes(stock.condition))
          throw Error("Only serviceable stock can be reserved.");
        if (
          c.quantity >
          Math.min(
            progress.toOrder,
            stock.quantity - (stock.reservedQuantity ?? 0),
          )
        )
          throw Error(
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
      } else {
        if (!reservation || reservation.quantity < c.quantity)
          throw Error("Quantity exceeds this request’s reservation.");
        stock.reservedQuantity = (stock.reservedQuantity ?? 0) - c.quantity;
        reservation.quantity -= c.quantity;
        r.reservations = r.reservations.filter((a) => a.quantity > 0);
        if (c.kind === "issue") {
          stock.quantity -= c.quantity;
          r.issues.push({
            lineUuid: line.uuid,
            stockUuid: stock.uuid,
            quantity: c.quantity,
            at: now,
            actorId: s.user.id,
          });
        }
      }
      stock.version++;
      auditStockChange(
        s,
        before,
        stock,
        c.kind,
        c.kind === "reserve"
          ? `Reserved ${c.quantity} for ${r.number}`
          : c.kind === "release"
            ? `Released ${c.quantity} from ${r.number}`
            : `Issued ${c.quantity} for ${r.number}`,
        now,
      );
    }
  }
  r.version++;
  r.updatedAt = now;
  r.history.push({
    requestUuid: c.requestUuid,
    at: now,
    actorId: s.user.id,
    action: c.kind,
    detail: JSON.stringify(c),
  });
  r = partsRequestSchema.parse(r);
  s.partsRequests = [...requests.filter((x) => x.uuid !== r.uuid), r];
  s.audit.unshift({
    uuid: c.requestUuid,
    at: now,
    actorId: s.user.id,
    action: `partsRequest.${c.kind}`,
    entityUuid: r.uuid,
    aircraftUuid: r.aircraftUuid || undefined,
    before: previous
      ? JSON.stringify(original.partsRequests?.find((x) => x.uuid === r.uuid))
      : undefined,
    after: JSON.stringify(r),
  });
  original.partsRequests = s.partsRequests;
  original.management = s.management;
  original.audit = s.audit;
  return r;
}

// Resolve scheduling ownership without inventing a second maintenance schedule.
export function recurringRequestSource(
  s: Snapshot,
  source: RequestSource,
): RequestSource | undefined {
  if (source.kind === "workTask") {
    const task = s.workOrders
      ?.find((w) => w.uuid === source.workOrderUuid)
      ?.tasks.find((t) => t.uuid === source.uuid);
    if (!task || task.source.kind === "manual") return;
    return recurringRequestSource(s, {
      kind: task.source.kind,
      uuid: task.source.uuid,
      workOrderUuid: "",
    });
  }
  if (source.kind === "jobCard") {
    const card = s.taskCards?.find((c) => c.uuid === source.uuid);
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
    return;
  }
  if (source.kind === "inspection") {
    const i = s.inspections.find((i) => i.uuid === source.uuid);
    if (
      !i ||
      i.archived ||
      !(
        i.intervalSeconds ||
        i.intervalCycles ||
        i.intervalLandings ||
        i.intervalMonths
      )
    )
      return;
    return { ...source, workOrderUuid: "" };
  }
  if (source.kind === "componentRequirement") {
    const r = s.management?.find(
      (r) => r.kind === "componentRequirement" && r.uuid === source.uuid,
    );
    if (
      !r ||
      r.kind !== "componentRequirement" ||
      r.requirementType === "Life Limits" ||
      !(
        r.calendarIntervalValue ||
        (r.intervalSeconds &&
          (r.timeLimitMode === "FROM_LAST_COMPLIED" ||
            r.timeBasis !== "TSN")) ||
        (r.intervalCycles && r.cycleLimitMode === "FROM_LAST_COMPLIED") ||
        (r.intervalLandings && r.landingLimitMode !== "ABSOLUTE")
      )
    )
      return;
    return { ...source, workOrderUuid: "" };
  }
  if (source.kind === "airworthiness") {
    const ad = s.airworthiness?.find((r) =>
      r.tasks.some((t) => t.uuid === source.uuid),
    );
    const t = ad?.tasks.find((t) => t.uuid === source.uuid);
    if (
      !ad ||
      !t ||
      ad.reviewRequired ||
      !["Applicable", "Previously Complied With (PCW)"].includes(
        ad.applicability,
      ) ||
      t.recurrence === "One-time" ||
      !(
        t.recurrence === "Recurring" ||
        t.intervalDays ||
        t.intervalHours ||
        t.intervalCycles ||
        t.intervalLandings
      ) ||
      lastCompliance(ad, t.uuid)?.terminatedBy
    )
      return;
    return { ...source, workOrderUuid: "" };
  }
}

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
  if (r.templateUuid) {
    const template = s.partsRequests?.find((t) => t.uuid === r.templateUuid);
    if (
      template &&
      template.source.kind === source.kind &&
      template.source.uuid === source.uuid
    )
      return true;
  }
  if (r.source.kind === "workTask") {
    const task = s.workOrders
      ?.find((w) => w.uuid === r.source.workOrderUuid)
      ?.tasks.find((t) => t.uuid === r.source.uuid);
    return (
      task?.source.kind === source.kind && task.source.uuid === source.uuid
    );
  }
  return false;
}
