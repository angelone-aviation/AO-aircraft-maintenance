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
} from "./partsRequests";
import { z } from "zod";
import { latestLocalDate, type Snapshot } from "./model";
import { activeProgram, programPermission, recordProgram } from "./programs";
import { applyManagement, type Stock } from "./management";
import {
  componentSchema,
  movement,
  rebaseServicedRequirements,
} from "./components";
import { addDays, assertNotExpired } from "./shelfLife";
const text = z.string().trim().max(2000);
const id = z.string().min(1).max(200);
const qty = z.number().int().positive().max(1000000);
const money = z.number().int().nonnegative().max(100000000000);
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
export const DEFAULT_CORE_DUE_DAYS = 30;
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
export type CoreReturn = z.infer<typeof coreReturnSchema>;
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
export type PurchaseOrder = z.infer<typeof poSchema>;
export type PODraft = z.infer<typeof poDraftSchema>;
// Issued orders are records sent to a vendor; their attachments stay.
export const poAttachmentRemovable = (po: Pick<PurchaseOrder, "phase">) =>
  po.phase === "draft";
export type POLine = z.infer<typeof poLineSchema>;
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
export type POCommand = z.infer<typeof poCommandSchema>;
export function received(po: PurchaseOrder, line: POLine) {
  return po.receipts
    .flatMap((r) => r.lines)
    .filter((l) => l.lineUuid === line.uuid)
    .reduce((n, l) => n + l.quantity, 0);
}
export function shipped(po: PurchaseOrder, line: POLine) {
  return po.shipments
    .flatMap((r) => r.lines)
    .filter((l) => l.lineUuid === line.uuid)
    .reduce((n, l) => n + l.quantity, 0);
}
export function outstanding(po: PurchaseOrder, line: POLine) {
  return line.quantity - line.cancelled - received(po, line);
}
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
export function poTotal(po: PODraft) {
  return (
    po.shippingCents +
    po.lines.reduce((n, l) => n + l.quantity * l.unitCents, 0)
  );
}
function unique(ids: string[]) {
  if (new Set(ids).size !== ids.length)
    throw Error("Duplicate lines are not allowed.");
}
export function applyPOCommand(
  original: Snapshot,
  raw: POCommand,
  now = Date.now(),
) {
  const s = structuredClone(original),
    c = poCommandSchema.parse(raw),
    program = activeProgram(s);
  if (!program || !programPermission(s, "admin", program))
    throw Error(
      "Inventory administrator access is required for purchase orders.",
    );
  if (c.kind === "save")
    for (const d of c.drafts) {
      if (d.shippingAddress) d.shipTo = formatAddress(d.shippingAddress);
      if (d.vendorAddressDetails)
        d.vendorContact = formatAddress(d.vendorAddressDetails);
    }
  const orders = s.purchaseOrders ?? [];
  const replay = orders.flatMap((p) =>
    p.history
      .filter((h) => h.requestUuid === c.requestUuid)
      .map((h) => ({ p, h })),
  );
  if (replay.length) {
    if (
      replay.some(
        ({ p, h }) =>
          p.programUuid !== program ||
          h.actorId !== s.user.id ||
          h.detail !== JSON.stringify(c),
      )
    )
      throw Error("Request identifier already used.");
    return replay.map(({ p }) => p);
  }
  const scope = orders.filter((p) => p.programUuid === program);
  const changes: PurchaseOrder[] = [];
  const validateLines = (d: PODraft) => {
    if (
      d.vendorUuid &&
      !s.management?.some(
        (r) =>
          r.kind === "vendor" &&
          r.uuid === d.vendorUuid &&
          recordProgram(s, r) === program,
      )
    )
      throw Error("Choose a vendor in this Flight Program.");
    if (!Number.isSafeInteger(poTotal(d)) || poTotal(d) > 10000000000000)
      throw Error("Order total exceeds the supported amount.");
    unique(d.lines.map((l) => l.uuid));
    for (const l of d.lines) {
      const location = s.management?.find(
        (r) => r.kind === "location" && r.uuid === l.locationUuid,
      );
      if (!location || recordProgram(s, location) !== program)
        throw Error(
          "Choose a delivery inventory location in this Flight Program.",
        );
      if (l.stockUuid) {
        const stock = s.management?.find(
          (r) => r.kind === "stock" && r.uuid === l.stockUuid,
        );
        if (
          !stock ||
          stock.kind !== "stock" ||
          recordProgram(s, stock) !== program ||
          stock.locationUuid !== l.locationUuid ||
          stock.partNumber !== l.partNumber ||
          stock.category !== l.kind
        )
          throw Error(
            "Selected stock must match the part, category and location.",
          );
      }
      if (
        l.aircraftUuid &&
        !s.aircraft.some(
          (a) => a.uuid === l.aircraftUuid && a.programUuid === program,
        )
      )
        throw Error("Aircraft is outside this Flight Program.");
      if (
        l.inspectionUuid &&
        !s.inspections.some(
          (i) =>
            i.uuid === l.inspectionUuid && i.aircraftUuid === l.aircraftUuid,
        )
      )
        throw Error("Inspection does not match the aircraft.");
      if (
        l.workOrderUuid &&
        !s.workOrders?.some(
          (w) =>
            w.uuid === l.workOrderUuid && w.aircraftUuid === l.aircraftUuid,
        )
      )
        throw Error("Work order does not match the aircraft.");
      if (l.exchange && l.repairComponentUuid)
        throw Error(
          "Repair returns cannot be exchange lines. Order the exchange unit on its own line.",
        );
    }
  };
  if (c.kind === "save") {
    unique(c.drafts.map((d) => d.uuid));
    let seq = Math.max(
      0,
      ...scope.map((p) => Number(p.number.replace(/^PO-/, "")) || 0),
    );
    for (const d of c.drafts) {
      const previous = orders.find((p) => p.uuid === d.uuid);
      if (
        previous &&
        (previous.programUuid !== program || previous.phase !== "draft")
      )
        throw Error(
          "Only draft purchase orders in this program can be edited.",
        );
      if ((previous?.version ?? 0) !== d.version)
        throw Error("Purchase order changed. Reopen it before saving.");
      if (d.lines.some((l) => l.cancelled))
        throw Error("Draft lines cannot contain cancelled quantities.");
      validateLines(d);
      const p: PurchaseOrder = {
        ...d,
        programUuid: program,
        number: previous?.number ?? `PO-${String(++seq).padStart(5, "0")}`,
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
      changes.push(p);
    }
  } else {
    const found = scope.find((p) => p.uuid === c.uuid);
    if (!found) throw Error("Purchase order not found.");
    const p = structuredClone(found);
    if (p.version !== c.version)
      throw Error("Purchase order changed. Reopen it before saving.");
    if (c.kind === "issue") {
      if (p.phase !== "draft") throw Error("Only drafts can be issued.");
      validateLines(p);
      if (p.shippingAddress) assertConfirmedAddress(p.shippingAddress);
      p.phase = "issued";
      p.issuedAt = now;
    } else if (c.kind === "revise") {
      if (p.phase !== "issued" || p.shipments.length || p.receipts.length)
        throw Error(
          "Only unshipped, unreceived orders can return to draft for revision.",
        );
      if (!c.reason) throw Error("Enter the revision reason.");
      p.phase = "draft";
      p.revision++;
    } else if (c.kind === "close") {
      if (p.phase !== "issued" || p.lines.some((l) => outstanding(p, l) > 0))
        throw Error(
          "Receive or cancel all outstanding quantities before closing.",
        );
      p.phase = "closed";
    } else if (c.kind === "cancel") {
      if (
        s.management?.some(
          (r) => r.kind === "component" && r.outForRepair?.poUuid === p.uuid,
        )
      )
        throw Error(
          "Receive all components back from repair before cancelling the order.",
        );
      if (!["draft", "issued"].includes(p.phase))
        throw Error("Order is already closed or cancelled.");
      if (!c.reason) throw Error("Enter a cancellation reason.");
      p.lines = p.lines.map((l) => ({
        ...l,
        cancelled: l.quantity - received(p, l),
      }));
      p.phase = p.receipts.length ? "closed" : "cancelled";
    } else if (c.kind === "core") {
      updateCoreReturn(p, c, now);
    } else if (c.kind === "ship" || c.kind === "receive") {
      if (p.phase !== "issued")
        throw Error("Issue the order before shipping or receiving.");
      validateLines(p);
      if (c.date > latestLocalDate(now))
        throw Error("Shipment and receipt dates cannot be in the future.");
      unique(c.lines.map((l) => l.lineUuid));
      for (const x of c.lines) {
        const l = p.lines.find((l) => l.uuid === x.lineUuid);
        if (!l) throw Error("PO line not found.");
        const remaining =
          c.kind === "ship"
            ? l.quantity - l.cancelled - Math.max(shipped(p, l), received(p, l))
            : outstanding(p, l);
        if (x.quantity > remaining)
          throw Error("Quantity exceeds the outstanding balance.");
      }
      if (c.kind === "ship") {
        for (const x of c.lines) {
          const l = p.lines.find((l) => l.uuid === x.lineUuid)!;
          if (!l.repairComponentUuid) continue;
          const component = s.management?.find(
            (r) => r.kind === "component" && r.uuid === l.repairComponentUuid,
          );
          if (
            !component ||
            component.kind !== "component" ||
            component.installed ||
            component.outForRepair ||
            recordProgram(s, component) !== program
          )
            throw Error(
              "Repair component must be in inventory and available before shipment.",
            );
          const requests = (l.requestAllocations ?? []).map((a) =>
            s.partsRequests?.find((r) => r.uuid === a.requestUuid),
          );
          if (requests.some((r) => r && c.date < r.date))
            throw Error(
              "Repair shipment date cannot precede the request date.",
            );
          component.outForRepair = { poUuid: p.uuid, date: c.date };
          component.version++;
          s.management!.push({
            ...movement(
              component,
              "REPAIR_SHIP",
              s,
              `${c.requestUuid}-${l.uuid}`,
              `Sent for ${l.repairWork} on ${p.number}; ${c.carrier} ${c.tracking}`,
              now,
            ),
            date: c.date,
          });
        }
        p.shipments.push({
          uuid: c.requestUuid,
          date: c.date,
          carrier: c.carrier,
          tracking: c.tracking,
          lines: c.lines,
        });
      } else {
        const lines: PurchaseOrder["receipts"][number]["lines"] = [];
        for (const x of c.lines) {
          const l = p.lines.find((l) => l.uuid === x.lineUuid)!;
          const itemUuids: string[] = [];
          if (l.repairComponentUuid) {
            const component = s.management?.find(
              (r) => r.kind === "component" && r.uuid === l.repairComponentUuid,
            );
            const serial = x.serials[0];
            if (
              !component ||
              component.kind !== "component" ||
              component.outForRepair?.poUuid !== p.uuid ||
              component.installed ||
              x.quantity !== 1 ||
              x.serials.length !== 1 ||
              serial.serial !== component.serial
            )
              throw Error(
                "Receive the original shipped component using its existing serial number.",
              );
            if (
              Math.round(serial.hours * 3600) < component.timeSinceNew ||
              serial.cycles < component.cyclesSinceNew
            )
              throw Error(
                "Verified total time and cycles cannot decrease on a repair return.",
              );
            if (c.date < component.outForRepair.date)
              throw Error("Return date cannot precede repair shipment.");
            const elapsed =
              Math.round(serial.hours * 3600) - component.timeSinceNew;
            component.timeSinceNew += elapsed;
            component.cyclesSinceNew = serial.cycles;
            if (component.timeSinceOverhaul !== null)
              component.timeSinceOverhaul += elapsed;
            if (component.timeSinceRepair !== null)
              component.timeSinceRepair += elapsed;
            const before = { ...component };
            const overhaul =
              l.repairWork === "overhaul" && x.condition === "overhauled";
            const repair =
              l.repairWork === "repair" &&
              ["new", "overhauled"].includes(x.condition);
            if (overhaul) {
              component.timeSinceOverhaul = 0;
              component.calendarOverhaulDaysBase = 0;
              component.calendarOverhaulDate = c.date;
            }
            if (repair) component.timeSinceRepair = 0;
            if (overhaul || repair) {
              const updated = rebaseServicedRequirements(
                s,
                component,
                before,
                { overhaul, repair, date: c.date },
                now,
              );
              s.management = s.management!.map(
                (r) => updated.find((u) => u.uuid === r.uuid) ?? r,
              );
            }
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
            s.management!.push({
              ...movement(
                component,
                "REPAIR_RETURN",
                s,
                `${c.requestUuid}-${l.uuid}`,
                `Returned from ${l.repairWork} on ${p.number}; invoice ${c.invoice}; condition ${x.condition}; ${c.notes}`,
                now,
              ),
              date: c.date,
            });
            itemUuids.push(component.uuid);
          } else if (l.kind === "component") {
            if (x.serials.length !== x.quantity)
              throw Error(
                "Enter one serial number and verified time/cycles for each component received.",
              );
            for (const serial of x.serials) {
              if (
                s.management?.some(
                  (r) =>
                    r.kind === "component" &&
                    recordProgram(s, r) === program &&
                    r.partNumber.toUpperCase() === l.partNumber.toUpperCase() &&
                    r.serial.toUpperCase() === serial.serial.toUpperCase(),
                )
              )
                throw Error(
                  "This part and serial number already exist in inventory or on an aircraft.",
                );
              const uuid = crypto.randomUUID();
              const record = componentSchema.parse({
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
                timeSinceNew: Math.round(serial.hours * 3600),
                timeSinceOverhaul: null,
                timeSinceRepair: null,
                cyclesSinceNew: serial.cycles,
                serviceDaysBase: 0,
                incomingTag: { reference: p.number, condition: x.condition },
                expirationDate: x.expirationDate,
              });
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
              itemUuids.push(uuid);
            }
          } else {
            if (x.serials.length)
              throw Error("Serial numbers are only for trackable components.");
            let stock = s.management?.find(
              (r) => r.uuid === l.stockUuid && r.kind === "stock",
            ) as Stock | undefined;
            // Preserve condition/lot identity: different-condition or shelf-life deliveries get a separate stock item.
            if (
              stock &&
              (stock.condition !== x.condition ||
                stock.expirationDate !== x.expirationDate)
            )
              stock = undefined;
            if (!stock) {
              const uuid = crypto.randomUUID();
              const record: Stock = {
                uuid,
                version: 0,
                programUuid: program,
                kind: "stock",
                partNumber: l.partNumber,
                description: l.description,
                category: l.kind,
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
              itemUuids.push(uuid);
              if (!l.stockUuid) l.stockUuid = uuid;
            } else {
              applyManagement(
                s,
                {
                  action: "stock.move",
                  requestUuid: crypto.randomUUID(),
                  uuid: stock.uuid,
                  version: stock.version,
                  operation: "receive",
                  quantity: x.quantity,
                  reason: `Receipt ${p.number}; invoice ${c.invoice}`,
                },
                now,
              );
              itemUuids.push(stock.uuid);
            }
          }
          if (
            !l.repairComponentUuid &&
            l.kind !== "component" &&
            l.requestAllocations?.length
          ) {
            if (!["new", "overhauled"].includes(x.condition))
              throw Error(
                "Requested parts must be received in serviceable condition before being reserved.",
              );
            let offset = received(p, l),
              available = x.quantity;
            const stock = s.management?.find(
              (r) => r.kind === "stock" && r.uuid === itemUuids[0],
            );
            if (!stock || stock.kind !== "stock")
              throw Error("Received stock not found.");
            assertNotExpired(stock, now);
            for (const a of l.requestAllocations) {
              const skip = Math.min(a.quantity, offset);
              offset -= skip;
              const quantity = Math.min(a.quantity - skip, available);
              available -= quantity;
              if (!quantity) continue;
              const request = s.partsRequests?.find(
                (r) => r.uuid === a.requestUuid,
              );
              if (!request || request.cancelled)
                throw Error("Receiving allocation is unavailable.");
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
              auditStockChange(
                s,
                before,
                stock,
                "reserve",
                `Received and reserved ${quantity} for ${request.number} from ${p.number}`,
                now,
              );
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
          }
          lines.push({ ...x, itemUuids });
          if (l.exchange)
            p.coreReturns = [
              ...(p.coreReturns ?? []),
              {
                uuid: `${c.requestUuid}-${l.uuid}`,
                lineUuid: l.uuid,
                receiptUuid: c.requestUuid,
                partNumber: l.partNumber,
                serial: x.serials.map((s) => s.serial).join(", "),
                quantity: x.quantity,
                dueDate: addDays(
                  c.date,
                  l.coreDueDays ?? DEFAULT_CORE_DUE_DAYS,
                ),
                status: "pending",
                tracking: "",
                notes: "",
              },
            ];
        }
        p.receipts.push({
          uuid: c.requestUuid,
          date: c.date,
          invoice: c.invoice,
          notes: c.notes,
          actorId: s.user.id,
          lines,
        });
      }
    }
    p.version++;
    p.updatedAt = now;
    p.history.push({
      at: now,
      actorId: s.user.id,
      action: c.kind,
      requestUuid: c.requestUuid,
      reason: "reason" in c ? c.reason : "",
      detail: JSON.stringify(c),
    });
    changes.push(p);
  }
  s.purchaseOrders = [
    ...orders.filter((p) => !changes.some((n) => n.uuid === p.uuid)),
    ...changes,
  ];
  validateRequestAllocations(s);
  for (const p of changes)
    s.audit.unshift({
      uuid: `${c.requestUuid}-${p.uuid}`,
      at: now,
      actorId: s.user.id,
      action: `po.${c.kind}`,
      entityUuid: p.uuid,
      after: JSON.stringify(p),
    });
  original.partsRequests = s.partsRequests;
  original.purchaseOrders = s.purchaseOrders;
  original.management = s.management;
  original.audit = s.audit;
  return changes;
}

function updateCoreReturn(
  p: PurchaseOrder,
  c: Extract<POCommand, { kind: "core" }>,
  now: number,
) {
  const core = p.coreReturns?.find((r) => r.uuid === c.coreUuid);
  if (!core) throw Error("Core return not found.");
  if (c.date > latestLocalDate(now))
    throw Error("Core shipment and credit dates cannot be in the future.");
  let next: CoreReturn;
  if (c.status === "shipped") {
    if (core.status !== "pending")
      throw Error("Only pending cores can be marked shipped.");
    if (!c.tracking) throw Error("Enter the core shipment tracking number.");
    next = {
      ...core,
      status: "shipped",
      shippedDate: c.date,
      tracking: c.tracking,
    };
  } else {
    if (core.status !== "shipped")
      throw Error("Ship the core before marking it credited.");
    if (c.date < core.shippedDate!)
      throw Error("Credit date cannot precede the core shipment.");
    next = { ...core, status: "credited", creditedDate: c.date };
  }
  if (c.notes) next.notes = c.notes;
  p.coreReturns = p.coreReturns!.map((r) => (r.uuid === core.uuid ? next : r));
}
export interface CoreReturnRow extends CoreReturn {
  poUuid: string;
  poNumber: string;
  poVersion: number;
  vendor: string;
  overdue: boolean;
}
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
export function validateRequestAllocations(s: Snapshot) {
  const commitments = requestPurchases(s.purchaseOrders ?? []);
  const seenRepair = new Set<string>();
  for (const p of s.purchaseOrders ?? []) {
    for (const l of p.lines) {
      if (
        (l.requestAllocations ?? []).reduce((n, a) => n + a.quantity, 0) >
        l.quantity
      )
        throw Error("Request allocations exceed PO quantity.");
      if (
        l.repairComponentUuid &&
        p.phase !== "cancelled" &&
        outstanding(p, l) > 0
      ) {
        if (seenRepair.has(l.repairComponentUuid))
          throw Error("Component already has an outstanding repair PO.");
        seenRepair.add(l.repairComponentUuid);
        const component = s.management?.find(
          (r) => r.kind === "component" && r.uuid === l.repairComponentUuid,
        );
        if (
          !component ||
          component.kind !== "component" ||
          component.installed ||
          component.parentComponentUuid ||
          (component.outForRepair &&
            component.outForRepair.poUuid !== p.uuid) ||
          recordProgram(s, component) !== p.programUuid ||
          component.partNumber !== l.partNumber ||
          l.kind !== "component" ||
          l.quantity !== 1 ||
          !l.repairWork ||
          l.requestAllocations?.length !== 1
        )
          throw Error(
            "Repair PO lines must reference one existing component and its repair request.",
          );
      }
      for (const a of l.requestAllocations ?? []) {
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
          throw Error("PO allocation does not match the parts request.");
        if (r.mode === "parts" && l.kind === "component")
          throw Error(
            "Use stock parts for parts requests; use a repair request for an existing serialized component.",
          );
        const live = p.phase !== "cancelled" && outstanding(p, l) > 0;
        if (
          live &&
          (r.cancelled ||
            (r.vendor && r.vendor.toLowerCase() !== p.vendor.toLowerCase()) ||
            r.currency !== p.currency ||
            (r.shipTo && r.shipTo.trim() !== p.shipTo.trim()))
        )
          throw Error(
            "Request vendor, currency and ship-to must match the PO.",
          );
        if (
          (r.mode === "repair") !== Boolean(l.repairComponentUuid) ||
          (r.mode === "repair" &&
            (line.componentUuid !== l.repairComponentUuid ||
              line.service !== l.repairWork))
        )
          throw Error(
            "Repair allocation does not match the original component and work requested.",
          );
      }
    }
  }
  for (const r of s.partsRequests ?? [])
    for (const line of r.lines) {
      const allocations = commitments.filter(
        (a) => a.requestUuid === r.uuid && a.lineUuid === line.uuid,
      );
      const ordered = allocations.reduce(
        (n, a) => n + a.quantity - a.received,
        0,
      );
      const progress = requestLineProgress(
        { ...s, partsRequestPurchases: undefined },
        r,
        line.uuid,
      );
      if (ordered + progress.reserved + progress.issued > line.quantity)
        throw Error("PO quantity exceeds the uncommitted request balance.");
      if (
        r.mode === "repair" &&
        allocations.reduce((n, a) => n + a.quantity, 0) > 1
      )
        throw Error("This repair request is already ordered or fulfilled.");
    }
}
