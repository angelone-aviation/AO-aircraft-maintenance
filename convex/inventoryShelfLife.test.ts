/**
 * Responsibility: Pins stock shelf life on the server (expired stock cannot be
 *   issued, linked to a job card or reserved) and the exchange core returns a
 *   purchase-order receipt creates.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex (management, taskCards, partsRequests, purchaseOrders,
 *   schema), src/domain (purchaseOrders, partsRequests), src/data/demo.ts,
 *   tests/fixtures/taskCards.ts.
 */
import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import { poDraftSchema } from "../src/domain/purchaseOrders";
import { requestDraftSchema } from "../src/domain/partsRequests";
import { taskCardCommand } from "../tests/fixtures/taskCards";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const DAY_MS = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Seeds the demo program and another, a store holding sealant that expired on
 * 2020-01-01, and signs in a system administrator (the buyer) and a
 * technician.
 */
async function setup() {
  const t = convexTest(schema, modules);
  const demo = demoSnapshot();
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("programs", demo.programs![0]);
    await ctx.db.insert("programs", {
      ...demo.programs![0],
      uuid: "other-program",
      name: "Other",
    });
    const group = await ctx.db.insert("groups", {
      programUuid: "demo-program",
      name: "Techs",
      aircraftIds: [],
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
        expirationTime: Date.now() + DAY_MS,
      });
      return { subject: `${userId}|${sessionId}` };
    };
    const record = (
      r: Record<string, unknown> & { uuid: string; kind: "location" | "stock" },
    ) =>
      ctx.db.insert("management", {
        uuid: r.uuid,
        programUuid: "demo-program",
        kind: r.kind,
        payload: JSON.stringify({
          version: 1,
          programUuid: "demo-program",
          ...r,
        }),
      });
    await record({
      uuid: "store",
      kind: "location",
      name: "Store",
      address: "",
      contact: "",
    });
    await record({
      uuid: "old-sealant",
      kind: "stock",
      partNumber: "SEALANT",
      description: "Sealant",
      category: "supply",
      condition: "new",
      locationUuid: "store",
      quantity: 3,
      minimum: 0,
      alternates: "",
      expirationDate: "2020-01-01",
    });
    return { admin: await identity(true), tech: await identity(false) };
  });
  return {
    t,
    admin: t.withIdentity(ids.admin),
    tech: t.withIdentity(ids.tech),
  };
}
it("blocks issuing expired stock on the server", async () => {
  const { t, admin } = await setup();
  const move = (operation: string, version: number) =>
    admin.mutation(api.management.execute, {
      programUuid: "demo-program",
      payload: JSON.stringify({
        action: "stock.move",
        requestUuid: crypto.randomUUID(),
        reason: "Test",
        uuid: "old-sealant",
        version,
        operation,
        quantity: 1,
      }),
    });
  await expect(move("issue", 1)).rejects.toThrow("expired on 2020-01-01");
  await move("receive", 1);
  const stock = await t.run(async (ctx) =>
    JSON.parse(
      (await ctx.db
        .query("management")
        .withIndex("uuid", (q) => q.eq("uuid", "old-sealant"))
        .unique())!.payload,
    ),
  );
  expect(stock.quantity).toBe(4);
});
it("refuses expired stock from a job card on the server", async () => {
  const { t, admin } = await setup();
  const demo = demoSnapshot();
  await t.run(async (ctx) => {
    for (const a of demo.aircraft) await ctx.db.insert("aircraft", a);
  });
  const card = taskCardCommand();
  const save = (fields: object) =>
    admin.mutation(api.taskCards.save, {
      programUuid: "demo-program",
      payload: JSON.stringify({
        ...card,
        fields: { ...card.fields, ...fields },
      }),
    });
  const sealant = {
    uuid: crypto.randomUUID(),
    source: "stock",
    stockUuid: "old-sealant",
    locationUuid: "store",
    partNumber: "SEALANT",
    description: "Sealant",
    quantity: 1,
    serialLot: "",
    removedComponent: "",
    installedComponent: "",
  };
  // The stock picker cannot choose an expired lot, nor can a direct request.
  await expect(save({ partsUsed: [sealant] })).rejects.toThrow(
    "SEALANT expired on 2020-01-01. Expired stock cannot be linked",
  );
  await save({});
  // Parts for the card are issued through a parts request raised from it,
  // which cannot reserve (and so cannot issue) the expired lot either.
  const request = (c: object) =>
    admin.mutation(api.partsRequests.execute, {
      programUuid: "demo-program",
      payload: JSON.stringify(c),
    });
  await request({
    kind: "save",
    requestUuid: crypto.randomUUID(),
    draft: requestDraftSchema.parse({
      uuid: "card-request",
      version: 0,
      source: { kind: "jobCard", uuid: card.uuid },
      mode: "parts",
      date: today(),
      engineer: "Tech",
      priority: "P2 Routine",
      requiredBy: "",
      vendor: "Vendor",
      currency: "USD",
      shipTo: "Hangar",
      lines: [
        { uuid: "line", partNumber: "SEALANT", description: "S", quantity: 1 },
      ],
    }),
  });
  await expect(
    request({
      kind: "reserve",
      requestUuid: crypto.randomUUID(),
      uuid: "card-request",
      version: 1,
      lineUuid: "line",
      stockUuid: "old-sealant",
      quantity: 1,
      alternateConfirmed: false,
    }),
  ).rejects.toThrow("SEALANT expired on 2020-01-01");
});
it("creates core returns on exchange receipts and limits updates to program admins", async () => {
  const { t, admin, tech } = await setup();
  const command = (client: typeof admin, c: unknown) =>
    client.mutation(api.purchaseOrders.execute, {
      programUuid: "demo-program",
      payload: JSON.stringify(c),
    });
  const d = poDraftSchema.parse({
    uuid: "po-exchange",
    version: 0,
    vendor: "Overhaul shop",
    vendorContact: "",
    shipTo: "Hangar",
    expectedDate: "",
    currency: "USD",
    shippingCents: 0,
    notes: "",
    lines: [
      {
        uuid: "line",
        locationUuid: "store",
        partNumber: "STARTER",
        description: "Exchange starter",
        quantity: 1,
        unitCents: 90000,
        kind: "part",
        exchange: true,
        coreDueDays: 15,
      },
    ],
  });
  await command(admin, { kind: "save", requestUuid: "s", drafts: [d] });
  await command(admin, {
    kind: "issue",
    requestUuid: "i",
    uuid: d.uuid,
    version: 1,
    reason: "",
  });
  await command(admin, {
    kind: "receive",
    requestUuid: "r",
    uuid: d.uuid,
    version: 2,
    date: today(),
    invoice: "INV",
    notes: "",
    lines: [{ lineUuid: "line", quantity: 1, condition: "new", serials: [] }],
  });
  const stored = async (uuid = d.uuid) =>
    t.run(async (ctx) =>
      JSON.parse(
        (await ctx.db
          .query("purchaseOrders")
          .withIndex("uuid", (q) => q.eq("uuid", uuid))
          .unique())!.payload,
      ),
    );
  const po = await stored();
  expect(po.coreReturns).toEqual([
    expect.objectContaining({
      partNumber: "STARTER",
      status: "pending",
      dueDate: new Date(Date.parse(today()) + 15 * DAY_MS)
        .toISOString()
        .slice(0, 10),
    }),
  ]);
  const ship = {
    kind: "core",
    requestUuid: "core-ship",
    uuid: d.uuid,
    version: po.version,
    coreUuid: po.coreReturns[0].uuid,
    status: "shipped",
    date: today(),
    tracking: "1Z999",
    notes: "",
  };
  await expect(command(tech, ship)).rejects.toThrow("administrator");
  await t.run(async (ctx) => {
    await ctx.db.insert("purchaseOrders", {
      uuid: "po-foreign",
      programUuid: "other-program",
      payload: JSON.stringify({
        ...po,
        uuid: "po-foreign",
        programUuid: "other-program",
      }),
    });
  });
  await expect(
    command(admin, { ...ship, uuid: "po-foreign", requestUuid: "x" }),
  ).rejects.toThrow("Purchase order not found");
  expect((await stored("po-foreign")).coreReturns[0].status).toBe("pending");
  await command(admin, ship);
  expect((await stored()).coreReturns[0]).toMatchObject({
    status: "shipped",
    tracking: "1Z999",
  });
});
