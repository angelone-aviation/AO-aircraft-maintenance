/**
 * Responsibility: The saves and history reads the history-paging suites run
 *   on a volume database, and the records they act on.
 * Layer: Test. Fixture for convex-test suites; never shipped in the build.
 * Dependencies: convex (workOrders, taskCards, partsRequests, costs,
 *   purchaseOrders, auditHistory, collections, recordNumbers),
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
 * A uuid of the records the saves create, distinct from the fixture's.
 *
 * @param n - 0 to 9.
 */
export const measuredUuid = (n: number) => MEASURED.slice(0, -1) + n;

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
 * The saves the history-paging plan measures, and the Weekly summary, each
 * as an administrator of the volume program runs it.
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
  return {
    name: "partsRequest.save",
    kind: "mutation",
    fn: executePartsRequest,
    args: volumeCommand({
      kind: "save",
      requestUuid: measuredUuid(1),
      draft: requestDraftSchema.parse({
        uuid: measuredUuid(2),
        version: 0,
        source: { kind: "stock", uuid: stock.uuid, workOrderUuid: "" },
        mode: "parts",
        date: "2026-11-03",
        engineer: "Mechanic",
        priority: "P2 Routine",
        requiredBy: "",
        currency: "USD",
        lines: [{ ...partLine(stock), uuid: measuredUuid(3), quantity: 1 }],
      }),
    }),
  };
}

function purchaseOrderSave({ stock }: VolumeTargets): VolumeOperation {
  const draft = poDraftSchema.parse({
    uuid: measuredUuid(5),
    version: 0,
    vendor: "Example Aviation Supply",
    vendorContact: "",
    shipTo: "Hangar 4",
    expectedDate: "",
    currency: "USD",
    shippingCents: 0,
    notes: "",
    lines: [
      {
        ...partLine(stock),
        uuid: measuredUuid(6),
        stockUuid: stock.uuid,
        locationUuid: stock.locationUuid,
        quantity: 2,
        unitCents: 2495,
        kind: "part",
      },
    ],
  });
  return {
    name: "purchaseOrder.save",
    kind: "mutation",
    fn: executePurchaseOrder,
    args: volumeCommand({
      kind: "save",
      requestUuid: measuredUuid(4),
      drafts: [draft],
    }),
  };
}

function partLine(stock: VolumeTargets["stock"]) {
  return { partNumber: stock.partNumber, description: "Oil filter" };
}
