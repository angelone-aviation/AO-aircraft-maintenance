/**
 * Responsibility: Characterizes what the workspace snapshot and the saves
 *   that load whole history read at one, two and three fleet-years.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex (operations, workOrders, taskCards, partsRequests,
 *   costs, purchaseOrders, auditHistory, collections, schema),
 *   tests/fixtures/programVolume.ts, src/domain schemas.
 *
 * The counts are convex-test's transaction metrics: documents and bytes read
 * as Convex counts them against its 16 MiB limit, and index ranges against
 * its 4,096. They are the baseline for history paging (ADR-0013,
 * docs/history-paging.md): each stage that bounds a read turns its growth
 * into a flat line, and these tests flip with it.
 */
import { convexTest } from "convex-test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import schema from "./schema";
import { decode, encode } from "./collections";
import { snapshot } from "./operations";
import { save as saveWorkOrder } from "./workOrders";
import { save as saveTaskCard, checkUpload } from "./taskCards";
import { execute as executePartsRequest } from "./partsRequests";
import { execute as executeCost } from "./costs";
import { execute as executePurchaseOrder } from "./purchaseOrders";
import { summary } from "./auditHistory";
import {
  seedProgramVolume,
  VOLUME_PROGRAM,
} from "../tests/fixtures/programVolume";
import {
  isOpenWorkOrder,
  workOrderFieldsSchema,
} from "../src/domain/workOrders";
import { taskCardFieldsSchema } from "../src/domain/taskCards";
import { requestDraftSchema } from "../src/domain/partsRequests";
import { poDraftSchema } from "../src/domain/purchaseOrders";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const SEEDED_AT = Date.UTC(2026, 10, 3, 12);
const YEARS = [1, 2, 3] as const;
const ROLES = ["admin", "pilot", "owner", "board"] as const;
// Three databases of up to about 22,000 rows each on a shared machine.
const SEED_TIMEOUT_MS = 180_000;
const MEASURED = "00000000-0000-4000-8000-0000000a0000";
const ids = (n: number) => MEASURED.slice(0, -1) + n;

type Reads = { documents: number; bytes: number; indexRanges: number };
type Handler<C> = (ctx: C, args: object) => Promise<unknown>;

/** One measured call: a registered function's handler and its arguments. */
interface Operation {
  name: string;
  kind: "query" | "mutation";
  fn: unknown;
  args: object;
}

/** The records the saves act on, found in each seeded database. */
interface Targets {
  order: { uuid: string; version: number; fields: object; tasks: unknown[] };
  card: { uuid: string; version: number; fields: object };
  stock: { uuid: string; locationUuid: string; partNumber: string };
  issuedStockUuid: string;
}

const reads = new Map<string, Record<string, Reads>>();

beforeAll(async () => {
  vi.useFakeTimers({ now: SEEDED_AT });
  for (const years of YEARS) await measureYear(years);
}, SEED_TIMEOUT_MS);

afterAll(() => vi.useRealTimers());

it("matches the reads recorded before history paging", async () => {
  await expect(
    JSON.stringify(Object.fromEntries(reads), null, 1),
  ).toMatchFileSnapshot("./__golden__/historyCost.json");
});

describe("Characterizes current behaviour: reads grow with each year of history", () => {
  it.each(ROLES)("the %s's workspace snapshot", (role) =>
    expectGrowth(`snapshot.${role}`),
  );
  it.each([
    "workOrder.save",
    "taskCard.save",
    "taskCard.evidence",
    "partsRequest.save",
    "cost.partUnitCost",
    "purchaseOrder.save",
    "auditHistory.weeklySummary",
  ])("%s", (operation) => expectGrowth(operation));
});

// Documents and bytes rise every year. Index ranges do not: each loader
// reads one range per aircraft or program, however many rows it holds, so
// the 16 MiB read limit, not the range limit, is the one history reaches.
function expectGrowth(name: string) {
  const [one, two, three] = YEARS.map((years) => reads.get(name)![years]);
  expect(two.documents, name).toBeGreaterThan(one.documents);
  expect(three.documents, name).toBeGreaterThan(two.documents);
  expect(two.bytes, name).toBeGreaterThan(one.bytes);
  expect(three.bytes, name).toBeGreaterThan(two.bytes);
  expect([two.indexRanges, three.indexRanges], name).toEqual([
    one.indexRanges,
    one.indexRanges,
  ]);
}

async function measureYear(years: number) {
  const t = convexTest(schema, modules);
  const { accounts } = await t.run((ctx) =>
    seedProgramVolume(ctx, SEEDED_AT, years),
  );
  const targets = await t.run(findTargets);
  for (const role of ROLES)
    await measure(t, years, accounts[role], {
      name: `snapshot.${role}`,
      kind: "query",
      fn: snapshot,
      args: {},
    });
  for (const operation of operations(targets))
    await measure(t, years, accounts.admin, operation);
}

async function measure(
  t: ReturnType<typeof convexTest>,
  years: number,
  subject: string,
  operation: Operation,
) {
  const measured = await readsOf(t, subject, operation);
  reads.set(operation.name, {
    ...reads.get(operation.name),
    [years]: measured,
  });
}

// Runs a registered function's handler inside an inline transaction, so the
// transaction's metrics are its own.
function readsOf(
  t: ReturnType<typeof convexTest>,
  subject: string,
  { kind, fn, args }: Operation,
): Promise<Reads> {
  const as = t.withIdentity({ subject });
  return kind === "query"
    ? as.query((ctx) => measured(ctx, fn, args))
    : as.mutation((ctx) => measured(ctx, fn, args));
}

// Convex keeps a registered function's handler on `_handler`; calling it
// directly is the only way to read the metrics of its transaction after it.
async function measured<C extends Pick<QueryCtx, "meta">>(
  ctx: C,
  fn: unknown,
  args: object,
): Promise<Reads> {
  await (fn as { _handler: Handler<C> })._handler(ctx, args);
  const metrics = await ctx.meta.getTransactionMetrics();
  return {
    documents: metrics.documentsRead.used,
    bytes: metrics.bytesRead.used,
    indexRanges: metrics.databaseQueries.used,
  };
}

// The open work order on the first aircraft with an open job card added to
// it (the fixture completes every card), a stock record, and a parts request
// that issued that stock to the order, which a part's unit cost needs.
async function findTargets(ctx: MutationCtx): Promise<Targets> {
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
    uuid: ids(8),
    cardNumber: "JC-MEASURED",
    status: "ready" as const,
    actualWork: "",
    steps: done.steps.map((step) => ({ ...step, result: "" })),
  };
  await ctx.db.insert("taskCards", encode("taskCards", card));
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
      uuid: ids(9),
      number: "PR-MEASURED",
      source: { ...request.source, workOrderUuid },
    }),
  );
  return request.issues[0].stockUuid;
}

function operations(targets: Targets): Operation[] {
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
      args: command({
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

function command(payload: object) {
  return { programUuid: VOLUME_PROGRAM, payload: JSON.stringify(payload) };
}

function workOrderSave({ order }: Targets): Operation {
  return {
    name: "workOrder.save",
    kind: "mutation",
    fn: saveWorkOrder,
    args: command({
      action: "save",
      uuid: order.uuid,
      version: order.version,
      fields: { ...order.fields, scope: "100-hour inspection, measured." },
      componentUuids: [],
      tasks: order.tasks,
    }),
  };
}

function taskCardSave({ card }: Targets): Operation {
  return {
    name: "taskCard.save",
    kind: "mutation",
    fn: saveTaskCard,
    args: command({
      action: "save",
      uuid: card.uuid,
      version: card.version,
      fields: { ...card.fields, findings: "No defects found; measured." },
    }),
  };
}

function partsRequestSave({ stock }: Targets): Operation {
  return {
    name: "partsRequest.save",
    kind: "mutation",
    fn: executePartsRequest,
    args: command({
      kind: "save",
      requestUuid: ids(1),
      draft: requestDraftSchema.parse({
        uuid: ids(2),
        version: 0,
        source: { kind: "stock", uuid: stock.uuid, workOrderUuid: "" },
        mode: "parts",
        date: "2026-11-03",
        engineer: "Mechanic",
        priority: "P2 Routine",
        requiredBy: "",
        currency: "USD",
        lines: [{ ...partLine(stock), uuid: ids(3), quantity: 1 }],
      }),
    }),
  };
}

function purchaseOrderSave({ stock }: Targets): Operation {
  const draft = poDraftSchema.parse({
    uuid: ids(5),
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
        uuid: ids(6),
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
    args: command({ kind: "save", requestUuid: ids(4), drafts: [draft] }),
  };
}

function partLine(stock: Targets["stock"]) {
  return { partNumber: stock.partNumber, description: "Oil filter" };
}
