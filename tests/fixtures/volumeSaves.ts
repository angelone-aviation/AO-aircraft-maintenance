/**
 * Responsibility: The saves and history reads the history-paging suites run
 *   on a volume database, and the records they act on.
 * Layer: Test. Fixture for convex-test suites; never shipped in the build.
 * Dependencies: convex (workOrders, taskCards, partsRequests, costs,
 *   purchaseOrders, auditHistory, history, collections, recordNumbers),
 *   tests/fixtures/programVolume.ts, src/domain stored-record schemas.
 */
import type { MutationCtx } from "../../convex/_generated/server";
import { decode, encode } from "../../convex/collections";
import { syncRecordNumber } from "../../convex/recordNumbers";
import { save as saveWorkOrder } from "../../convex/workOrders";
import { save as saveTaskCard, checkUpload } from "../../convex/taskCards";
import { execute as executePartsRequest } from "../../convex/partsRequests";
import { execute as executeCost } from "../../convex/costs";
import { execute as executePurchaseOrder } from "../../convex/purchaseOrders";
import { summary } from "../../convex/auditHistory";
import { costReport } from "../../convex/history";
import { VOLUME_PROGRAM } from "./programVolume";
import {
  isOpenWorkOrder,
  workOrderFieldsSchema,
} from "../../src/domain/workOrders";
import { taskCardFieldsSchema } from "../../src/domain/taskCards";
import { requestDraftSchema } from "../../src/domain/partsRequests";
import { poDraftSchema } from "../../src/domain/purchaseOrders";

const MEASURED = "00000000-0000-4000-8000-0000000a0000";

/**
 * A uuid of the records and commands the saves create, distinct from the
 * fixture's.
 *
 * @param n - 0 to 99.
 */
export const measuredUuid = (n: number) =>
  MEASURED.slice(0, -2) + String(n).padStart(2, "0");

// The measured request and order, and their lines.
const REQUEST = measuredUuid(2);
const REQUEST_LINE = measuredUuid(3);
const ORDER = measuredUuid(5);
const ORDER_LINE = measuredUuid(6);
const MEASURED_DATE = "2026-11-03";

/** One call to a registered function: its handler and its arguments. */
export interface VolumeOperation {
  name: string;
  kind: "query" | "mutation";
  fn: unknown;
  args: object;
}

/** The records the saves act on, found in each seeded database. */
export interface VolumeTargets {
  order: { uuid: string; version: number; fields: object; tasks: unknown[] };
  card: { uuid: string; version: number; fields: object };
  stock: { uuid: string; locationUuid: string; partNumber: string };
  issuedStockUuid: string;
}

/**
 * Finds the open work order on the first aircraft and adds what the saves
 * need beside it: an open job card on it (the fixture completes every card),
 * and a parts request that issued stock to it, which a part's unit cost
 * reads. Every database the fixture seeds gets the same rows.
 *
 * @returns The order, the card, the first stock record and the issued stock.
 */
export async function findVolumeTargets(
  ctx: MutationCtx,
): Promise<VolumeTargets> {
  const docs = await ctx.db
    .query("workOrders")
    .withIndex("aircraft", (q) => q.eq("aircraftUuid", "volume-aircraft-1"))
    .collect();
  const order = decode("workOrders", docs).find(isOpenWorkOrder)!;
  const card = await openCardOn(ctx, order.uuid);
  const stock = decode(
    "management",
    await ctx.db.query("management").collect(),
  ).flatMap((r) => (r.kind === "stock" ? [r] : []))[0];
  return {
    order: {
      uuid: order.uuid,
      version: order.version,
      fields: workOrderFieldsSchema.parse(order),
      tasks: order.tasks,
    },
    card: {
      uuid: card.uuid,
      version: card.version,
      fields: taskCardFieldsSchema.parse(card),
    },
    stock: {
      uuid: stock.uuid,
      locationUuid: stock.locationUuid,
      partNumber: stock.partNumber,
    },
    issuedStockUuid: await issueToOrder(ctx, order.uuid),
  };
}

/**
 * The saves the history-paging plan measures, the Weekly summary and the
 * cost report, each as an administrator of the volume program runs it.
 *
 * @returns In the order the measurements run them.
 */
export function volumeOperations(targets: VolumeTargets): VolumeOperation[] {
  return [
    workOrderSave(targets),
    taskCardSave(targets),
    {
      name: "taskCard.evidence",
      kind: "query",
      fn: checkUpload,
      args: { programUuid: VOLUME_PROGRAM, taskCardUuid: targets.card.uuid },
    },
    partsRequestSave(targets),
    {
      name: "cost.partUnitCost",
      kind: "mutation",
      fn: executeCost,
      args: volumeCommand({
        action: "part.unitCost",
        workOrderUuid: targets.order.uuid,
        stockUuid: targets.issuedStockUuid,
        unitCents: 2600,
      }),
    },
    purchaseOrderSave(targets),
    {
      name: "auditHistory.weeklySummary",
      kind: "query",
      fn: summary,
      args: {
        programUuid: VOLUME_PROGRAM,
        from: "2026-10-27",
        to: "2026-11-02",
      },
    },
    {
      name: "history.costReport",
      kind: "query",
      fn: costReport,
      args: {
        programUuid: VOLUME_PROGRAM,
        aircraftUuid: "volume-aircraft-1",
        from: "2026-01-01",
        to: "2026-12-31",
      },
    },
    ...purchasingOperations(targets),
  ];
}

/**
 * A command's arguments in the volume program.
 *
 * @param payload - The command, sent as JSON.
 */
export function volumeCommand(payload: object) {
  return { programUuid: VOLUME_PROGRAM, payload: JSON.stringify(payload) };
}

// Card numbers repeat across the fixture's aircraft, so the open card has a
// number of its own and its save passes the program's uniqueness check.
async function openCardOn(ctx: MutationCtx, workOrderUuid: string) {
  const done = decode(
    "taskCards",
    (await ctx.db.query("taskCards").collect()).filter((d) =>
      d.payload.includes(workOrderUuid),
    ),
  ).find((c) => c.workOrderUuid === workOrderUuid)!;
  const card = {
    ...done,
    uuid: measuredUuid(8),
    cardNumber: "JC-MEASURED",
    status: "ready" as const,
    actualWork: "",
    steps: done.steps.map((step) => ({ ...step, result: "" })),
  };
  const row = encode("taskCards", card);
  await ctx.db.insert("taskCards", row);
  await syncRecordNumber(ctx, "taskCards", row);
  return card;
}

async function issueToOrder(ctx: MutationCtx, workOrderUuid: string) {
  const [request] = decode("partsRequests", [
    (await ctx.db.query("partsRequests").first())!,
  ]);
  await ctx.db.insert(
    "partsRequests",
    encode("partsRequests", {
      ...request,
      uuid: measuredUuid(9),
      number: "PR-MEASURED",
      source: { ...request.source, workOrderUuid },
    }),
  );
  return request.issues[0].stockUuid;
}

function workOrderSave({ order }: VolumeTargets): VolumeOperation {
  return {
    name: "workOrder.save",
    kind: "mutation",
    fn: saveWorkOrder,
    args: volumeCommand({
      action: "save",
      uuid: order.uuid,
      version: order.version,
      fields: { ...order.fields, scope: "100-hour inspection, measured." },
      componentUuids: [],
      tasks: order.tasks,
    }),
  };
}

function taskCardSave({ card }: VolumeTargets): VolumeOperation {
  return {
    name: "taskCard.save",
    kind: "mutation",
    fn: saveTaskCard,
    args: volumeCommand({
      action: "save",
      uuid: card.uuid,
      version: card.version,
      fields: { ...card.fields, findings: "No defects found; measured." },
    }),
  };
}

function partsRequestSave({ stock }: VolumeTargets): VolumeOperation {
  return requestOperation("partsRequest.save", {
    kind: "save",
    requestUuid: measuredUuid(1),
    draft: requestDraft(stock, 0, 1),
  });
}

function purchaseOrderSave({ stock }: VolumeTargets): VolumeOperation {
  return orderOperation("purchaseOrder.save", {
    kind: "save",
    requestUuid: measuredUuid(4),
    drafts: [orderDraft(stock, 0, orderLine(stock))],
  });
}

// Every later command on the measured request and order, each valid where
// it runs: the request grows to two filters, the order allocates one of its
// two to it as an exchange line, and is issued and received; the request
// reserves and issues the other from stock; the order's core ships and it
// closes; the request is cancelled.
function purchasingOperations({ stock }: VolumeTargets): VolumeOperation[] {
  const allocation = {
    requestUuid: REQUEST,
    lineUuid: REQUEST_LINE,
    quantity: 1,
  };
  const allocated = { ...orderLine(stock), exchange: true };
  return [
    requestOperation("partsRequest.edit", {
      kind: "save",
      requestUuid: measuredUuid(10),
      draft: { ...requestDraft(stock, 1, 2), notes: "Measured edit." },
    }),
    orderOperation("purchaseOrder.edit", {
      kind: "save",
      requestUuid: measuredUuid(11),
      drafts: [
        orderDraft(stock, 1, {
          ...allocated,
          requestAllocations: [allocation],
        }),
      ],
    }),
    orderOperation("purchaseOrder.issue", orderAction("issue", 12, 2)),
    orderOperation("purchaseOrder.receive", orderReceipt(13, 3)),
    requestOperation(
      "partsRequest.reserve",
      stockCommand(stock, "reserve", 14, 3),
    ),
    requestOperation("partsRequest.issue", stockCommand(stock, "issue", 15, 4)),
    orderOperation("purchaseOrder.core", coreShipment(16, 4)),
    orderOperation("purchaseOrder.close", orderAction("close", 17, 5)),
    requestOperation("partsRequest.cancel", {
      kind: "cancel",
      requestUuid: measuredUuid(18),
      uuid: REQUEST,
      version: 5,
      reason: "Measured cancel.",
    }),
  ];
}

function requestOperation(name: string, command: object): VolumeOperation {
  return {
    name,
    kind: "mutation",
    fn: executePartsRequest,
    args: volumeCommand(command),
  };
}

function orderOperation(name: string, command: object): VolumeOperation {
  return {
    name,
    kind: "mutation",
    fn: executePurchaseOrder,
    args: volumeCommand(command),
  };
}

function requestDraft(
  stock: VolumeTargets["stock"],
  version: number,
  quantity: number,
) {
  return requestDraftSchema.parse({
    uuid: REQUEST,
    version,
    source: { kind: "stock", uuid: stock.uuid, workOrderUuid: "" },
    mode: "parts",
    date: MEASURED_DATE,
    engineer: "Mechanic",
    priority: "P2 Routine",
    requiredBy: "",
    currency: "USD",
    lines: [{ ...partLine(stock), uuid: REQUEST_LINE, quantity }],
  });
}

function orderDraft(
  stock: VolumeTargets["stock"],
  version: number,
  line: object,
) {
  return poDraftSchema.parse({
    uuid: ORDER,
    version,
    vendor: "Example Aviation Supply",
    vendorContact: "",
    shipTo: "Hangar 4",
    expectedDate: "",
    currency: "USD",
    shippingCents: 0,
    notes: "",
    lines: [line],
  });
}

function orderLine(stock: VolumeTargets["stock"]) {
  return {
    ...partLine(stock),
    uuid: ORDER_LINE,
    stockUuid: stock.uuid,
    locationUuid: stock.locationUuid,
    quantity: 2,
    unitCents: 2495,
    kind: "part",
  };
}

function orderAction(kind: string, n: number, version: number) {
  const requestUuid = measuredUuid(n);
  return { kind, requestUuid, uuid: ORDER, version, reason: "" };
}

function orderReceipt(n: number, version: number) {
  return {
    kind: "receive",
    requestUuid: measuredUuid(n),
    uuid: ORDER,
    version,
    date: MEASURED_DATE,
    invoice: "INV-MEASURED",
    notes: "",
    lines: [{ lineUuid: ORDER_LINE, quantity: 2, condition: "new" }],
  };
}

// The exchange core the receipt (command 13) owes, named as receipts name
// their cores: the receipt's request id, then the line's uuid.
function coreShipment(n: number, version: number) {
  return {
    kind: "core",
    requestUuid: measuredUuid(n),
    uuid: ORDER,
    version,
    coreUuid: `${measuredUuid(13)}-${ORDER_LINE}`,
    status: "shipped",
    date: MEASURED_DATE,
    tracking: "1Z-MEASURED",
    notes: "",
  };
}

function stockCommand(
  stock: VolumeTargets["stock"],
  kind: string,
  n: number,
  version: number,
) {
  return {
    kind,
    requestUuid: measuredUuid(n),
    uuid: REQUEST,
    version,
    lineUuid: REQUEST_LINE,
    stockUuid: stock.uuid,
    quantity: 1,
  };
}

function partLine(stock: VolumeTargets["stock"]) {
  return { partNumber: stock.partNumber, description: "Oil filter" };
}
