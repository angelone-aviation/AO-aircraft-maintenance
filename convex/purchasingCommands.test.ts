/**
 * Responsibility: Pins what each parts-request and purchase-order command
 *   returns, and its exact refusal, where the rule reads a request or order
 *   other than the one the command names: request ids, numbering, purchase
 *   allocations, open repairs and recurring lists.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex (schema, api, migrations), src/data/demo, src/domain
 *   (partsRequests, purchaseOrders, airworthiness, workOrders, rejection),
 *   tests/fixtures/workOrders.
 *
 * Characterizes current behaviour, so a save that reads less (H5) is held
 * to it. Related records are written by the app's own commands, or stored
 * directly and then filled by migrations:backfillHistoryColumns, as rows
 * written before a derived index are.
 */
import { convexTest, type TestConvex } from "convex-test";
import { expect, it } from "vitest";
import schema from "./schema";
import type { MutationCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import {
  partsRequestSchema,
  requestDraftSchema,
} from "../src/domain/partsRequests";
import { poDraftSchema, poSchema } from "../src/domain/purchaseOrders";
import { blankAD, blankADTask } from "../src/domain/airworthiness";
import { newWorkTask } from "../src/domain/workOrders";
import { STALE_RECORD_MESSAGE } from "../src/domain/rejection";
import { workOrderCommand } from "../tests/fixtures/workOrders";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const PROGRAM = "demo-program";
const OTHER_PROGRAM = "other-program";
const DAY_MS = 86_400_000;
const TODAY = new Date().toISOString().slice(0, 10);
const AIRCRAFT = demoSnapshot().aircraft[0].uuid;
const INSPECTION = demoSnapshot().inspections.find(
  (i) => i.aircraftUuid === AIRCRAFT,
)!.uuid;
const ID_TAKEN = "Request identifier already used.";
const OPEN_REPAIR = "This component already has an open repair request.";
const BALANCE = "PO quantity exceeds the uncommitted request balance.";
const REPAIR_PO = "Component already has an outstanding repair PO.";
const DEMAND = "Quantity exceeds uncommitted demand or available stock.";
const UNSERVED_ORDER = "11111111-1111-4111-8111-111111111111";
const UNSERVED_TASK = "22222222-2222-4222-8222-222222222222";

type Command = Record<string, unknown>;
type Line = Record<string, unknown>;

it("replays a resent request save, and refuses its request id on another request", async () => {
  const { request, stored } = await purchasing();
  const save = { kind: "save", requestUuid: "r1-save", draft: draft("r1") };
  expect(await request(save)).toBe("r1");
  const first = await stored();
  expect(await request(save)).toBe("r1");
  expect(await stored()).toEqual(first);
  await expectRefusal(request({ ...save, draft: draft("r2") }), ID_TAKEN);
  await expectRefusal(
    request({ ...save, draft: { ...draft("r1"), engineer: "Other" } }),
    ID_TAKEN,
  );
  expect(await stored()).toEqual(first);
});

it("numbers requests on from the highest, and refuses a stale, reshaped or changed save", async () => {
  const { request, record } = await purchasing();
  await request(save("r1", draft("r1")));
  await request(save("r2", draft("r2", { source: stockSource() })));
  expect([(await record("r1")).number, (await record("r2")).number]).toEqual([
    "PR-00001",
    "PR-00002",
  ]);
  await expectRefusal(
    request(save("r1-stale", draft("r1"))),
    "Request changed. Reopen it before saving.",
  );
  await expectRefusal(
    request(save("r1-move", { ...draft("r1"), version: 1, ...stockOnly() })),
    "Request source cannot change.",
  );
  const twice = {
    uuid: "same",
    partNumber: "P",
    description: "P",
    quantity: 1,
  };
  await expectRefusal(
    request(save("r3", draft("r3", { lines: [twice, twice] }))),
    "Duplicate request lines.",
  );
  expect(await request(save("r1-edit", { ...draft("r1"), version: 1 }))).toBe(
    "r1",
  );
});

it("reserves, releases and issues a line's stock within its demand, then cancels once", async () => {
  const { request, record } = await purchasing();
  await request(save("r2", draft("r2", stockOnly())));
  const stock = (kind: string, quantity: number, version: number) =>
    request(stockCommand("r2", kind, quantity, version));
  await expectRefusal(stock("reserve", 3, 1), DEMAND);
  expect(await stock("reserve", 2, 1)).toBe("r2");
  await expectRefusal(
    stock("release", 3, 2),
    "Quantity exceeds this request’s reservation.",
  );
  expect(await stock("issue", 2, 2)).toBe("r2");
  expect(await request(cancel("r2", 3))).toBe("r2");
  expect(await record("r2")).toMatchObject({
    version: 4,
    cancelled: true,
    reservations: [],
    issues: [{ lineUuid: "r2-line", stockUuid: "filter", quantity: 2 }],
  });
  await expectRefusal(
    request(save("r2-again", { ...draft("r2", stockOnly()), version: 4 })),
    "Cancelled requests are read-only.",
  );
});

it("replays a resent order save with every draft in it, and refuses its request id with another command", async () => {
  const { request, order } = await purchasing();
  await request(save("r1", draft("r1")));
  const drafts = [
    orderDraft("po1", [partLine("pl1", [allocation("r1", 3)])]),
    orderDraft("po2", [partLine("pl2", [])]),
  ];
  const multi = { kind: "save", requestUuid: "multi", drafts };
  expect(await order(multi)).toEqual(["po1", "po2"]);
  expect(await order(multi)).toEqual(["po1", "po2"]);
  await expectRefusal(order({ ...multi, drafts: [drafts[1]] }), ID_TAKEN);
  await expectRefusal(order(orderAction("issue", "po1", 0, "multi")), ID_TAKEN);
});

it("holds a request line to what every order allocates it", async () => {
  const { request, order, record } = await purchasing();
  await request(save("r1", draft("r1")));
  await order(orderSave("po1", [partLine("pl1", [allocation("r1", 3)])]));
  await expectRefusal(
    order(orderSave("po2", [partLine("pl2", [allocation("r1", 2)])])),
    `PO-00002, line FILTER-1: ${BALANCE}`,
  );
  expect(
    await order(orderSave("po2", [partLine("pl2", [allocation("r1", 1)])])),
  ).toEqual(["po2"]);
  expect((await record("po2", "purchaseOrders")).number).toBe("PO-00002");
  const wrong = partLine("pl3", [allocation("r1", 1)], {
    stockUuid: "",
    partNumber: "OTHER-1",
  });
  await expectRefusal(
    order(orderSave("po3", [wrong])),
    "PO-00003, line OTHER-1: PO allocation does not match the parts request.",
  );
  await expectRefusal(
    request(save("r1-grow", { ...draft("r1"), version: 1, lines: [line(5)] })),
    "Release reservations and remove draft PO allocations before changing lines or purchasing details. Fulfilled lines are retained for traceability.",
  );
  await expectRefusal(request(stockCommand("r1", "reserve", 1, 1)), DEMAND);
  await expectRefusal(
    request(cancel("r1", 1)),
    "Remove draft allocations or cancel outstanding PO quantities first.",
  );
});

it("reserves what an order receives for its requests, whose request ids it then holds", async () => {
  const { request, order, record } = await purchasing();
  await request(save("r1", draft("r1")));
  await order(orderSave("po1", [partLine("pl1", [allocation("r1", 3)])]));
  expect(await order(orderAction("issue", "po1", 1))).toEqual(["po1"]);
  await expectRefusal(
    order(orderAction("issue", "po1", 1, "late")),
    STALE_RECORD_MESSAGE,
  );
  expect(await order(receive("po1", 2, "pl1", 2))).toEqual(["po1"]);
  expect((await record("r1")).reservations).toEqual([
    { lineUuid: "r1-line", stockUuid: "filter", quantity: 2 },
  ]);
  await expectRefusal(
    request(save("receive-po1-2", draft("r9", stockOnly()))),
    ID_TAKEN,
  );
  expect(await request(stockCommand("r1", "issue", 2, 2))).toBe("r1");
  await expectRefusal(
    order(orderAction("close", "po1", 3)),
    "Receive or cancel all outstanding quantities before closing.",
  );
  expect(await order(receive("po1", 3, "pl1", 1))).toEqual(["po1"]);
  expect((await record("r1")).reservations).toEqual([
    { lineUuid: "r1-line", stockUuid: "filter", quantity: 1 },
  ]);
  expect(await order(orderAction("close", "po1", 4))).toEqual(["po1"]);
  expect(await request(cancel("r1", 4))).toBe("r1");
});

it("tracks an exchange core from receipt to credit, and cancels an order once", async () => {
  const { order, record } = await purchasing();
  const exchange = partLine("pl1", [], { exchange: true, quantity: 1 });
  await order(orderSave("po1", [exchange]));
  await order(orderAction("issue", "po1", 1));
  await order(receive("po1", 2, "pl1", 1));
  const core = (status: string, version: number, tracking: string) =>
    order(coreCommand("po1", version, status, tracking));
  await expectRefusal(
    core("shipped", 3, ""),
    "Enter the core shipment tracking number.",
  );
  await expectRefusal(
    core("credited", 3, ""),
    "Ship the core before marking it credited.",
  );
  expect(await core("shipped", 3, "1Z999")).toEqual(["po1"]);
  expect(await core("credited", 4, "")).toEqual(["po1"]);
  expect((await record("po1", "purchaseOrders")).coreReturns).toMatchObject([
    { uuid: "receive-po1-2-pl1", status: "credited", tracking: "1Z999" },
  ]);
  await order(orderSave("po2", [partLine("pl2", [])]));
  expect(await order(orderAction("cancel", "po2", 1))).toEqual(["po2"]);
  await expectRefusal(
    order(orderAction("cancel", "po2", 2, "again")),
    "Order is already closed or cancelled.",
  );
});

it("refuses a second open repair of a component, by request and by order, until it is back", async () => {
  const { request, order } = await purchasing();
  expect(await request(save("rp1", repairDraft("rp1", "pump")))).toBe("rp1");
  await expectRefusal(
    request(save("rp2", repairDraft("rp2", "pump"))),
    OPEN_REPAIR,
  );
  const po = (uuid: string) =>
    orderSave(uuid, [repairOrderLine(`${uuid}-line`, "rp1", "pump")]);
  expect(await order(po("po5"))).toEqual(["po5"]);
  await expectRefusal(order(po("po6")), `PO-00002, line PUMP: ${REPAIR_PO}`);
  await order(orderAction("issue", "po5", 1));
  await order(ship("po5", 2, "po5-line"));
  await expectRefusal(
    request(save("rp2", repairDraft("rp2", "pump"))),
    "Choose an uninstalled serialized component in this Flight Program; repair quantity must be one.",
  );
  expect(await order(repairReturn("po5", 3, "po5-line"))).toEqual(["po5"]);
  expect(await request(save("rp3", repairDraft("rp3", "pump")))).toBe("rp3");
});

it("reads rows stored before their keys once the backfill has run, and only the Flight Program's", async () => {
  const { t, request, order, record } = await purchasing();
  await t.run(storeOlderRows);
  await t.action(internal.migrations.backfillHistoryColumns, {});
  expect(await request(save("foreign", draft("r1"), "foreign-id"))).toBe("r1");
  expect((await record("r1")).number).toBe("PR-00006");
  const fresh = orderSave("po1", [partLine("pl1", [])], "foreign-po-id");
  expect(await order(fresh)).toEqual(["po1"]);
  expect((await record("po1", "purchaseOrders")).number).toBe("PO-00008");
  await expectRefusal(
    request(save("legacy", draft("r2"), "legacy-id")),
    ID_TAKEN,
  );
  await expectRefusal(
    request(save("rv", repairDraft("rv", "valve"))),
    OPEN_REPAIR,
  );
  expect(await request(save("rp", repairDraft("rp", "pump")))).toBe("rp");
  const valve = repairOrderLine("vl", "legacy-request", "valve");
  await expectRefusal(
    order(orderSave("po2", [valve])),
    `PO-00009, line VALVE: ${REPAIR_PO}`,
  );
  await expectRefusal(
    order(orderSave("po3", [partLine("pl3", [])], "legacy-po-id")),
    ID_TAKEN,
  );
});

it("serves every active list on the aircraft when one is saved, in list order", async () => {
  const { t, user, request, ad } = await purchasing();
  const source = { kind: "airworthiness" as const, uuid: ad };
  await request(save("list-a", listDraft("list-a", source)));
  const served = workOrderCommand();
  served.tasks = [newWorkTask(source, "AD inspection")];
  await user.mutation(api.workOrders.save, {
    programUuid: PROGRAM,
    payload: JSON.stringify(served),
  });
  const unserved = await t.run((ctx) => storeCopyOf(ctx, served.uuid));
  await request(save("list-b", listDraft("list-b", source)));
  const occurrences = (await rows(t, "partsRequests"))
    .filter((r) => r.templateUuid)
    .map((r) => [r.number, r.templateUuid, r.source.workOrderUuid]);
  expect(occurrences).toEqual([
    ["PR-00002", "list-a", served.uuid],
    ["PR-00004", "list-b", served.uuid],
    ["PR-00005", "list-a", unserved],
    ["PR-00006", "list-b", unserved],
  ]);
});

// A Flight Program with a store, a filter in stock, two loose serialized
// components, the demo's aircraft and inspections, a recurring AD task, and
// an administrator, with helpers that run commands as them.
async function purchasing() {
  const t = convexTest(schema, modules);
  const ad = recurringAD();
  const subject = await t.run(async (ctx) => {
    const demo = demoSnapshot();
    await ctx.db.insert("programs", demo.programs![0]);
    for (const a of demo.aircraft) await ctx.db.insert("aircraft", a);
    for (const i of demo.inspections) await ctx.db.insert("inspections", i);
    for (const record of INVENTORY)
      await ctx.db.insert("management", {
        uuid: record.uuid,
        programUuid: PROGRAM,
        kind: record.kind,
        payload: JSON.stringify({
          ...record,
          version: 1,
          programUuid: PROGRAM,
        }),
      });
    await ctx.db.insert("airworthiness", {
      uuid: ad.uuid,
      aircraftUuid: AIRCRAFT,
      payload: JSON.stringify(ad),
    });
    return administrator(ctx);
  });
  return helpers(t, subject, ad.tasks[0].uuid);
}

function helpers(t: TestConvex<typeof schema>, subject: string, ad: string) {
  const user = t.withIdentity({ subject });
  const run = (fn: Execute, c: Command) =>
    user.mutation(fn, { programUuid: PROGRAM, payload: JSON.stringify(c) });
  return {
    t,
    user,
    ad,
    request: (c: Command) => run(api.partsRequests.execute, c),
    order: (c: Command) => run(api.purchaseOrders.execute, c),
    record: async (uuid: string, table: Table = "partsRequests") =>
      (await rows(t, table)).find((r) => r.uuid === uuid)!,
    stored: async () => ({
      requests: await rows(t, "partsRequests"),
      orders: await rows(t, "purchaseOrders"),
      audit: await t.run((ctx) => ctx.db.query("audit").collect()),
    }),
  };
}

type Table = "partsRequests" | "purchaseOrders";
type Execute =
  typeof api.partsRequests.execute | typeof api.purchaseOrders.execute;

const INVENTORY = [
  {
    uuid: "store",
    kind: "location",
    name: "Store",
    address: "Hangar",
    contact: "",
  },
  {
    uuid: "filter",
    kind: "stock",
    partNumber: "FILTER-1",
    description: "Oil filter",
    category: "part",
    condition: "new",
    locationUuid: "store",
    quantity: 10,
    minimum: 0,
    alternates: "",
  },
  looseComponent("pump", "PUMP"),
  looseComponent("valve", "VALVE"),
] as const;

function looseComponent(uuid: string, partNumber: string) {
  return {
    uuid,
    kind: "component",
    aircraftUuid: "",
    componentType: "Appliance",
    partNumber,
    serial: `${partNumber}-SN1`,
    manufacturer: "Maker",
    notes: "",
    trackTime: true,
    trackCycles: true,
    trackCalendar: false,
    installed: false,
    locationUuid: "store",
    installedSeconds: 0,
    installedCycles: 0,
    timeSinceNew: 360000,
    timeSinceOverhaul: null,
    timeSinceRepair: null,
    cyclesSinceNew: 10,
    serviceDaysBase: 0,
  } as const;
}

function recurringAD() {
  const ad = blankAD(AIRCRAFT);
  ad.source.number = "2026-01-01";
  ad.applicability = "Applicable";
  ad.reviewRequired = false;
  ad.tasks = [
    {
      ...blankADTask(),
      description: "AD inspection",
      recurrence: "Recurring",
      intervalHours: 100,
    },
  ];
  return ad;
}

async function administrator(ctx: MutationCtx) {
  const userId = await ctx.db.insert("users", {
    name: "Buyer",
    active: true,
    isAdmin: true,
    groupIds: [],
  });
  const sessionId = await ctx.db.insert("authSessions", {
    userId,
    expirationTime: Date.now() + DAY_MS,
  });
  return `${userId}|${sessionId}`;
}

async function rows(t: TestConvex<typeof schema>, table: Table) {
  const docs = await t.run((ctx) => ctx.db.query(table).collect());
  return docs.map((d) => JSON.parse(d.payload));
}

async function expectRefusal(call: Promise<unknown>, message: string) {
  await expect(call).rejects.toMatchObject({
    name: "ConvexError",
    data: message,
  });
}

// A request for four filters on the first aircraft's first inspection.
function draft(uuid: string, fields: Command = {}) {
  return requestDraftSchema.parse({
    uuid,
    version: 0,
    source: { kind: "inspection", uuid: INSPECTION },
    mode: "parts",
    date: TODAY,
    engineer: "Tech",
    priority: "P2 Routine",
    requiredBy: "",
    vendor: "Vendor",
    currency: "USD",
    shipTo: "Hangar",
    lines: [{ ...line(4), uuid: `${uuid}-line` }],
    ...fields,
  });
}

function line(quantity: number) {
  return {
    uuid: "r1-line",
    partNumber: "FILTER-1",
    description: "Oil filter",
    quantity,
  };
}

function stockSource() {
  return { kind: "stock", uuid: "filter" };
}

// A restock of the filter: no aircraft, so its order lines name none.
function stockOnly() {
  return { source: stockSource(), lines: [{ ...line(2), uuid: "r2-line" }] };
}

function repairDraft(uuid: string, component: string) {
  const partNumber = component.toUpperCase();
  return draft(uuid, {
    source: { kind: "stock" },
    mode: "repair",
    vendor: "",
    shipTo: "",
    lines: [
      {
        uuid: `${uuid}-line`,
        partNumber,
        description: "Repair",
        quantity: 1,
        componentUuid: component,
        defect: "Leak",
        workRequested: "Repair leak",
      },
    ],
  });
}

function listDraft(uuid: string, source: Command) {
  return draft(uuid, { source, recurring: true, lines: [line(2)] });
}

function save(requestUuid: string, d: Command, id = requestUuid) {
  return { kind: "save", requestUuid: id, draft: d };
}

function stockCommand(
  uuid: string,
  kind: string,
  quantity: number,
  version: number,
) {
  return {
    kind,
    requestUuid: `${kind}-${uuid}-${version}`,
    uuid,
    version,
    lineUuid: `${uuid}-line`,
    stockUuid: "filter",
    quantity,
    alternateConfirmed: false,
  };
}

function cancel(uuid: string, version: number) {
  const requestUuid = `cancel-${uuid}-${version}`;
  return { kind: "cancel", requestUuid, uuid, version, reason: "Not needed" };
}

function orderDraft(uuid: string, lines: Line[]) {
  return poDraftSchema.parse({
    uuid,
    version: 0,
    vendor: "Vendor",
    vendorContact: "",
    shipTo: "Hangar",
    expectedDate: "",
    currency: "USD",
    shippingCents: 0,
    notes: "",
    lines,
  });
}

function orderSave(uuid: string, lines: Line[], id = `${uuid}-save`) {
  return { kind: "save", requestUuid: id, drafts: [orderDraft(uuid, lines)] };
}

function partLine(uuid: string, requestAllocations: Line[], more: Line = {}) {
  return {
    uuid,
    stockUuid: "filter",
    locationUuid: "store",
    partNumber: "FILTER-1",
    description: "Oil filter",
    quantity: 3,
    unitCents: 1200,
    kind: "part",
    aircraftUuid: AIRCRAFT,
    requestAllocations,
    ...more,
  };
}

function allocation(requestUuid: string, quantity: number) {
  return { requestUuid, lineUuid: `${requestUuid}-line`, quantity };
}

function repairOrderLine(uuid: string, request: string, component: string) {
  return {
    uuid,
    locationUuid: "store",
    partNumber: component.toUpperCase(),
    description: "Repair",
    quantity: 1,
    unitCents: 50000,
    kind: "component",
    repairComponentUuid: component,
    repairWork: "repair",
    requestAllocations: [allocation(request, 1)],
  };
}

function orderAction(kind: string, uuid: string, version: number, id = "") {
  const requestUuid = id || `${kind}-${uuid}-${version}`;
  return { kind, requestUuid, uuid, version, reason: "Reason" };
}

function receive(uuid: string, version: number, lineUuid: string, n: number) {
  return {
    kind: "receive",
    requestUuid: `receive-${uuid}-${version}`,
    uuid,
    version,
    date: TODAY,
    invoice: "INV-1",
    notes: "",
    lines: [{ lineUuid, quantity: n, condition: "new", serials: [] }],
  };
}

function repairReturn(uuid: string, version: number, lineUuid: string) {
  const serial = { serial: "PUMP-SN1", hours: 101, cycles: 12 };
  return {
    ...receive(uuid, version, lineUuid, 1),
    lines: [
      { lineUuid, quantity: 1, condition: "overhauled", serials: [serial] },
    ],
  };
}

function ship(uuid: string, version: number, lineUuid: string) {
  return {
    kind: "ship",
    requestUuid: `ship-${uuid}-${version}`,
    uuid,
    version,
    date: TODAY,
    carrier: "Freight",
    tracking: "TRK-1",
    lines: [{ lineUuid, quantity: 1 }],
  };
}

function coreCommand(
  uuid: string,
  version: number,
  status: string,
  tracking: string,
) {
  return {
    kind: "core",
    requestUuid: `core-${uuid}-${version}-${status}`,
    uuid,
    version,
    coreUuid: `receive-${uuid}-2-pl1`,
    status,
    date: TODAY,
    tracking,
    notes: "",
  };
}

// Rows written before the lookup keys existed: a repair request and its
// draft order for the valve, and another program's request and order that
// name the pump and their own request ids.
async function storeOlderRows(ctx: MutationCtx) {
  const legacy = storedRequest("legacy-request", PROGRAM, "valve", "PR-00005");
  const foreign = storedRequest(
    "foreign-request",
    OTHER_PROGRAM,
    "pump",
    "PR-00009",
  );
  for (const r of [legacy, foreign])
    await ctx.db.insert("partsRequests", {
      uuid: r.uuid,
      programUuid: r.programUuid,
      payload: JSON.stringify(r),
    });
  const orders = [
    storedOrder("legacy-po", PROGRAM, "valve", "legacy-request", "PO-00007"),
    storedOrder(
      "foreign-po",
      OTHER_PROGRAM,
      "pump",
      "foreign-request",
      "PO-00011",
    ),
  ];
  for (const p of orders)
    await ctx.db.insert("purchaseOrders", {
      uuid: p.uuid,
      programUuid: p.programUuid,
      payload: JSON.stringify(p),
    });
}

function storedRequest(
  uuid: string,
  programUuid: string,
  component: string,
  number: string,
) {
  const d = repairDraft(uuid, component);
  return partsRequestSchema.parse({
    ...d,
    version: 1,
    programUuid,
    aircraftUuid: "",
    sourceLabel: "Inventory stock request",
    aircraftRegistration: "",
    aircraftSerial: "",
    aircraftModel: "",
    number,
    requesterId: "buyer",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    cancelled: false,
    reservations: [],
    issues: [],
    history: [history(uuid === "legacy-request" ? "legacy-id" : "foreign-id")],
  });
}

function storedOrder(
  uuid: string,
  programUuid: string,
  component: string,
  request: string,
  number: string,
) {
  const d = orderDraft(uuid, [
    repairOrderLine(`${uuid}-line`, request, component),
  ]);
  return poSchema.parse({
    ...d,
    version: 1,
    programUuid,
    number,
    phase: "draft",
    revision: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    shipments: [],
    receipts: [],
    history: [
      {
        ...history(uuid === "legacy-po" ? "legacy-po-id" : "foreign-po-id"),
        reason: "",
      },
    ],
  });
}

function history(requestUuid: string) {
  return {
    requestUuid,
    at: Date.now(),
    actorId: "buyer",
    action: "save",
    detail: "{}",
  };
}

// An open order the saved one's copy, with a new task, written straight to
// its table so no save has served it.
async function storeCopyOf(ctx: MutationCtx, uuid: string) {
  const doc = await ctx.db
    .query("workOrders")
    .withIndex("uuid", (q) => q.eq("uuid", uuid))
    .unique();
  const copy = JSON.parse(doc!.payload);
  copy.uuid = UNSERVED_ORDER;
  copy.number = "WO-UNSERVED";
  copy.tasks[0].uuid = UNSERVED_TASK;
  await ctx.db.insert("workOrders", {
    uuid: copy.uuid,
    aircraftUuid: copy.aircraftUuid,
    payload: JSON.stringify(copy),
  });
  return copy.uuid as string;
}
