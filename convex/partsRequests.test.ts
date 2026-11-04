/**
 * Responsibility: Pins parts requests: linked requests, inventory access,
 *   reservations and issues in stock history, request-id replay, and a
 *   request uuid another Flight Program holds.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/partsRequests, convex/purchaseOrders, src/data/demo,
 *   src/domain (partsRequests, purchaseOrders).
 */
import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import { requestDraftSchema } from "../src/domain/partsRequests";
import { poDraftSchema } from "../src/domain/purchaseOrders";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
it("persists linked requests, authorizes inventory actions, and reserves PO receipts atomically", async () => {
  const t = convexTest(schema, modules),
    demo = demoSnapshot();
  const identities = await t.run(async (ctx) => {
    await ctx.db.insert("programs", demo.programs![0]);
    for (const a of demo.aircraft) await ctx.db.insert("aircraft", a);
    for (const i of demo.inspections) await ctx.db.insert("inspections", i);
    const group = await ctx.db.insert("groups", {
      programUuid: "demo-program",
      name: "Techs",
      aircraftIds: [demo.aircraft[0].uuid],
      permissions: ["read", "maintenance"],
    });
    const identity = async (admin: boolean) => {
      const userId = await ctx.db.insert("users", {
        name: admin ? "Buyer" : "Tech",
        active: true,
        isAdmin: admin,
        groupIds: admin ? [] : [group],
      });
      const sessionId = await ctx.db.insert("authSessions", {
        userId,
        expirationTime: Date.now() + 86400000,
      });
      return { subject: `${userId}|${sessionId}` };
    };
    await ctx.db.insert("management", {
      uuid: "store",
      programUuid: "demo-program",
      kind: "location",
      payload: JSON.stringify({
        uuid: "store",
        version: 1,
        programUuid: "demo-program",
        kind: "location",
        name: "Store",
        address: "Hangar",
        contact: "",
      }),
    });
    return { admin: await identity(true), tech: await identity(false) };
  });
  const tech = t.withIdentity(identities.tech),
    admin = t.withIdentity(identities.admin);
  const inspection = demo.inspections.find(
    (i) => i.aircraftUuid === demo.aircraft[0].uuid,
  )!;
  const draft = requestDraftSchema.parse({
    uuid: "r1",
    version: 0,
    source: { kind: "inspection", uuid: inspection.uuid },
    mode: "parts",
    date: new Date().toISOString().slice(0, 10),
    engineer: "Tech",
    priority: "P1 AOG",
    requiredBy: "",
    vendor: "Vendor",
    currency: "USD",
    shipTo: "Hangar",
    lines: [
      { uuid: "part", partNumber: "P1", description: "Test part", quantity: 2 },
    ],
  });
  const args = (c: unknown) => ({
    programUuid: "demo-program",
    payload: JSON.stringify(c),
  });
  await tech.mutation(
    api.partsRequests.execute,
    args({ kind: "save", requestUuid: "save", draft }),
  );
  await expect(
    tech.mutation(
      api.partsRequests.execute,
      args({
        kind: "cancel",
        requestUuid: "cancel",
        uuid: draft.uuid,
        version: 1,
        reason: "test",
      }),
    ),
  ).rejects.toThrow(/administrator/);
  const po = poDraftSchema.parse({
    uuid: "po",
    version: 0,
    vendor: "Vendor",
    vendorContact: "",
    shipTo: "Hangar",
    expectedDate: "",
    currency: "USD",
    shippingCents: 0,
    notes: "",
    lines: [
      {
        uuid: "poline",
        locationUuid: "store",
        partNumber: "P1",
        description: "Test part",
        quantity: 2,
        unitCents: 100,
        kind: "part",
        aircraftUuid: inspection.aircraftUuid,
        requestAllocations: [
          { requestUuid: "r1", lineUuid: "part", quantity: 2 },
        ],
      },
    ],
  });
  await admin.mutation(
    api.purchaseOrders.execute,
    args({ kind: "save", requestUuid: "posave", drafts: [po] }),
  );
  await admin.mutation(
    api.purchaseOrders.execute,
    args({
      kind: "issue",
      requestUuid: "poissue",
      uuid: "po",
      version: 1,
      reason: "",
    }),
  );
  const receipt = args({
    kind: "receive",
    requestUuid: "receipt",
    uuid: "po",
    version: 2,
    date: draft.date,
    invoice: "INV",
    notes: "",
    lines: [{ lineUuid: "poline", quantity: 2, condition: "new", serials: [] }],
  });
  await admin.mutation(api.purchaseOrders.execute, receipt);
  await admin.mutation(api.purchaseOrders.execute, receipt);
  const result = await t.run(async (ctx) => ({
    requests: (await ctx.db.query("partsRequests").collect()).map((d) =>
      JSON.parse(d.payload),
    ),
    stock: (await ctx.db.query("management").collect())
      .filter((d) => d.kind === "stock")
      .map((d) => JSON.parse(d.payload)),
  }));
  expect(result.stock).toHaveLength(1);
  expect(result.stock[0]).toMatchObject({ quantity: 2, reservedQuantity: 2 });
  expect(result.requests[0]).toMatchObject({
    version: 2,
    aircraftUuid: inspection.aircraftUuid,
    reservations: [
      { lineUuid: "part", stockUuid: result.stock[0].uuid, quantity: 2 },
    ],
  });
  const snapshot = await tech.query(api.operations.snapshot, {});
  if (!snapshot) throw Error("Snapshot missing");
  expect(snapshot.partsRequests).toHaveLength(1);
  expect(snapshot.purchaseOrders).toHaveLength(0);
  expect(snapshot.partsRequestPurchases?.[0]).toMatchObject({
    number: "PO-00001",
    received: 2,
  });
});
it("records request reservations and issues in the stock item's own history (#49)", async () => {
  const t = convexTest(schema, modules),
    demo = demoSnapshot();
  const identity = await t.run(async (ctx) => {
    await ctx.db.insert("programs", demo.programs![0]);
    for (const a of demo.aircraft) await ctx.db.insert("aircraft", a);
    for (const record of [
      {
        uuid: "store",
        version: 1,
        programUuid: "demo-program",
        kind: "location",
        name: "Store",
        address: "Hangar",
        contact: "",
      },
      {
        uuid: "filter",
        version: 1,
        programUuid: "demo-program",
        kind: "stock",
        partNumber: "FILTER-1",
        description: "Oil filter",
        category: "part",
        condition: "new",
        locationUuid: "store",
        quantity: 6,
        minimum: 0,
        alternates: "",
      },
    ] as const)
      await ctx.db.insert("management", {
        uuid: record.uuid,
        programUuid: "demo-program",
        kind: record.kind,
        payload: JSON.stringify(record),
      });
    const userId = await ctx.db.insert("users", {
      name: "Buyer",
      active: true,
      isAdmin: true,
      groupIds: [],
    });
    const sessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 86400000,
    });
    return { subject: `${userId}|${sessionId}` };
  });
  const admin = t.withIdentity(identity);
  const run = (c: unknown) =>
    admin.mutation(api.partsRequests.execute, {
      programUuid: "demo-program",
      payload: JSON.stringify(c),
    });
  await run({
    kind: "save",
    requestUuid: "save",
    draft: requestDraftSchema.parse({
      uuid: "r1",
      version: 0,
      source: { kind: "stock", uuid: "filter" },
      mode: "parts",
      date: new Date().toISOString().slice(0, 10),
      engineer: "Tech",
      priority: "P2 Routine",
      requiredBy: "",
      vendor: "Vendor",
      currency: "USD",
      shipTo: "Hangar",
      lines: [
        { uuid: "line", partNumber: "FILTER-1", description: "F", quantity: 2 },
      ],
    }),
  });
  const line = (kind: string, version: number) => ({
    kind,
    requestUuid: `${kind}-${version}`,
    uuid: "r1",
    version,
    lineUuid: "line",
    stockUuid: "filter",
    quantity: 2,
    alternateConfirmed: false,
  });
  await run(line("reserve", 1));
  await run(line("issue", 2));
  await run(line("issue", 2)); // replay records nothing more
  const history = await admin.query(api.auditHistory.page, {
    programUuid: "demo-program",
    entityUuid: "filter",
    cursor: null,
    numItems: 20,
  });
  expect(
    history.page.map((a) => ({
      action: a.action,
      reason: a.reason,
      quantity: JSON.parse(a.after!).quantity,
      reserved: JSON.parse(a.after!).reservedQuantity,
    })),
  ).toEqual([
    {
      action: "stock.issue",
      reason: "Issued 2 for PR-00001",
      quantity: 4,
      reserved: 0,
    },
    {
      action: "stock.reserve",
      reason: "Reserved 2 for PR-00001",
      quantity: 6,
      reserved: 2,
    },
  ]);
  expect(JSON.parse(history.page[0].before!)).toMatchObject({
    quantity: 6,
    reservedQuantity: 2,
  });
});

it("refuses a request uuid another Flight Program holds, and writes nothing", async () => {
  const t = convexTest(schema, modules);
  const subject = await t.run(async (ctx) => {
    await ctx.db.insert("programs", demoSnapshot().programs![0]);
    await ctx.db.insert("partsRequests", {
      uuid: "taken",
      programUuid: "other",
      payload: "{}",
    });
    const userId = await ctx.db.insert("users", {
      name: "Buyer",
      active: true,
      isAdmin: true,
      groupIds: [],
    });
    const sessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 86400000,
    });
    return `${userId}|${sessionId}`;
  });
  const draft = requestDraftSchema.parse({
    uuid: "taken",
    version: 0,
    source: { kind: "stock" },
    mode: "parts",
    date: new Date().toISOString().slice(0, 10),
    engineer: "Tech",
    priority: "P2 Routine",
    requiredBy: "",
    currency: "USD",
    lines: [{ uuid: "l", partNumber: "P", description: "Part", quantity: 1 }],
  });
  const stored = () =>
    t.run(async (ctx) => ({
      requests: await ctx.db.query("partsRequests").collect(),
      audit: await ctx.db.query("audit").collect(),
    }));
  const before = await stored();
  await expect(
    t.withIdentity({ subject }).mutation(api.partsRequests.execute, {
      programUuid: "demo-program",
      payload: JSON.stringify({ kind: "save", requestUuid: "taken", draft }),
    }),
  ).rejects.toMatchObject({
    name: "ConvexError",
    data: "Request identifier already used.",
  });
  expect(await stored()).toEqual(before);
});

it("replays an identical repair-request resend, and refuses a different command with its request id", async () => {
  const t = convexTest(schema, modules);
  const subject = await t.run(async (ctx) => {
    await ctx.db.insert("programs", demoSnapshot().programs![0]);
    const pump = {
      uuid: "pump",
      version: 1,
      programUuid: "demo-program",
      kind: "component",
      aircraftUuid: "",
      componentType: "Pump",
      partNumber: "PUMP",
      serial: "SN1",
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
      timeSinceOverhaul: 180000,
      timeSinceRepair: null,
      cyclesSinceNew: 0,
      serviceDaysBase: 0,
    } as const;
    const store = {
      uuid: "store",
      version: 1,
      programUuid: "demo-program",
      kind: "location",
      name: "Store",
      address: "Hangar",
      contact: "",
    } as const;
    for (const record of [store, pump])
      await ctx.db.insert("management", {
        uuid: record.uuid,
        programUuid: record.programUuid,
        kind: record.kind,
        payload: JSON.stringify(record),
      });
    const userId = await ctx.db.insert("users", {
      name: "Buyer",
      active: true,
      isAdmin: true,
      groupIds: [],
    });
    const sessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 86400000,
    });
    return `${userId}|${sessionId}`;
  });
  const draft = requestDraftSchema.parse({
    uuid: "repair",
    version: 0,
    source: { kind: "stock" },
    mode: "repair",
    date: new Date().toISOString().slice(0, 10),
    engineer: "Tech",
    priority: "P2 Routine",
    requiredBy: "",
    currency: "USD",
    lines: [
      {
        uuid: "l",
        partNumber: "PUMP",
        description: "Pump",
        quantity: 1,
        componentUuid: "pump",
        defect: "Leak",
        workRequested: "Repair leak",
      },
    ],
  });
  const run = (c: unknown) =>
    t.withIdentity({ subject }).mutation(api.partsRequests.execute, {
      programUuid: "demo-program",
      payload: JSON.stringify(c),
    });
  const save = { kind: "save", requestUuid: "send", draft };
  const stored = () =>
    t.run(async (ctx) => ({
      requests: await ctx.db.query("partsRequests").collect(),
      audit: await ctx.db.query("audit").collect(),
    }));
  expect(await run(save)).toBe("repair");
  const first = await stored();
  expect(JSON.parse(first.requests[0].payload).lines[0]).toMatchObject({
    componentSerial: "SN1",
    componentTSN: 360000,
    componentTSO: 180000,
  });
  expect(await run(save)).toBe("repair");
  expect(await stored()).toEqual(first);
  await expect(
    run({ ...save, draft: { ...draft, engineer: "Other" } }),
  ).rejects.toMatchObject({
    name: "ConvexError",
    data: "Request identifier already used.",
  });
  expect(await stored()).toEqual(first);
});
