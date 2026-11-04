/**
 * Responsibility: Pins cost records: who may see and set money, how labor
 *   is stored, program isolation, closed work orders, part unit costs, a
 *   replayed labor entry or request id, and a record uuid another Flight
 *   Program holds.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/costs, convex/workOrders, convex/operations,
 *   src/data/demo, src/domain/costs, tests/fixtures/workOrders.
 */
import { convexTest } from "convex-test";
import { it, expect, vi, afterEach } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import { demoSnapshot } from "../src/data/demo";
import { workOrderCommand } from "../tests/fixtures/workOrders";
import { laborCents, parseLaborHours } from "../src/domain/costs";
import { taskCardDefaults } from "../src/domain/taskCards";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const DAY_MS = 86_400_000;

/**
 * Seeds the demo program and a second one, "other", with a maintenance
 * technician and a program administrator in the demo program and an
 * administrator of the other.
 */
async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const s = demoSnapshot();
    for (const a of s.aircraft) await ctx.db.insert("aircraft", a);
    await ctx.db.insert("programs", s.programs![0]);
    await ctx.db.insert("programs", {
      ...s.programs![0],
      uuid: "other",
      name: "Other operations",
    });
    const makeUser = async (
      programUuid: string,
      permissions: ("read" | "maintenance")[],
      programAdmin = false,
    ) => {
      const group = await ctx.db.insert("groups", {
        programUuid,
        programAdmin,
        name: `${programUuid}:${permissions.join(",")}`,
        aircraftIds: [],
        permissions,
      });
      const user = await ctx.db.insert("users", {
        name: "User",
        active: true,
        isAdmin: false,
        activeProgramUuid: programUuid,
        groupIds: [group],
      });
      const session = await ctx.db.insert("authSessions", {
        userId: user,
        expirationTime: Date.now() + DAY_MS,
      });
      return { subject: `${user}|${session}` };
    };
    return {
      tech: await makeUser("demo-program", ["read", "maintenance"]),
      admin: await makeUser("demo-program", ["read"], true),
      outsider: await makeUser("other", ["read", "maintenance"], true),
    };
  });
  return {
    t,
    tech: t.withIdentity(ids.tech),
    admin: t.withIdentity(ids.admin),
    outsider: t.withIdentity(ids.outsider),
  };
}
const today = new Date().toISOString().slice(0, 10);
type Client = ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;
const run = (client: Client, command: unknown, programUuid = "demo-program") =>
  client.mutation(api.costs.execute, {
    programUuid,
    payload: JSON.stringify(command),
  });
it("keeps rates and money admin-only while maintenance records hours", async () => {
  const { tech, admin } = await fixture();
  const order = workOrderCommand();
  await tech.mutation(api.workOrders.save, {
    programUuid: "demo-program",
    payload: JSON.stringify(order),
  });
  const aircraftUuid = order.fields.aircraftUuid;
  await run(admin, { action: "settings.laborRate", laborRateCents: 9500 });
  await run(admin, {
    action: "budget.set",
    aircraftUuid,
    year: 2026,
    amountCents: 500000,
  });
  await run(admin, {
    action: "other.add",
    workOrderUuid: order.uuid,
    entry: {
      uuid: crypto.randomUUID(),
      date: today,
      description: "Ferry fuel",
      amountCents: 12345,
    },
  });
  await run(tech, {
    action: "labor.add",
    workOrderUuid: order.uuid,
    entry: {
      uuid: crypto.randomUUID(),
      date: today,
      technician: "Tech",
      minutes: 90,
    },
  });
  await expect(
    run(tech, {
      action: "other.add",
      workOrderUuid: order.uuid,
      entry: {
        uuid: crypto.randomUUID(),
        date: today,
        description: "x",
        amountCents: 1,
      },
    }),
  ).rejects.toThrow("administrator");
  await expect(
    run(tech, { action: "settings.laborRate", laborRateCents: 1 }),
  ).rejects.toThrow("administrator");

  const techView = await tech.query(api.operations.snapshot, {});
  expect(techView?.costs).toHaveLength(1);
  const techRecord = techView!.costs![0];
  expect(techRecord.kind).toBe("workOrder");
  if (techRecord.kind !== "workOrder") return;
  expect(techRecord.labor).toHaveLength(1);
  expect(techRecord.labor[0].minutes).toBe(90);
  expect(techRecord.labor[0]).not.toHaveProperty("rateCents");
  expect(techRecord.other).toEqual([]);
  expect(techView!.audit.some((a) => a.action.startsWith("cost."))).toBe(false);
  expect(JSON.stringify(techView)).not.toContain("Ferry fuel");

  const adminView = await admin.query(api.operations.snapshot, {});
  expect(adminView?.costs?.map((r) => r.kind).sort()).toEqual([
    "budget",
    "settings",
    "workOrder",
  ]);
  const adminRecord = adminView!.costs!.find((r) => r.kind === "workOrder");
  expect(adminRecord?.kind === "workOrder" && adminRecord.labor[0]).toEqual(
    expect.objectContaining({ minutes: 90, rateCents: 9500 }),
  );
  expect(adminView!.audit.some((a) => a.action === "cost.other.add")).toBe(
    true,
  );
});
it("stores labor hours exactly and keeps whole-minute entries from older apps (#46)", async () => {
  const { tech, admin } = await fixture();
  const order = workOrderCommand();
  await tech.mutation(api.workOrders.save, {
    programUuid: "demo-program",
    payload: JSON.stringify(order),
  });
  await run(admin, { action: "settings.laborRate", laborRateCents: 10000 });
  const labor = (time: { seconds: number } | { minutes: number }) =>
    run(tech, {
      action: "labor.add",
      workOrderUuid: order.uuid,
      entry: {
        uuid: crypto.randomUUID(),
        date: today,
        technician: "Tech",
        ...time,
      },
    });
  await labor({ seconds: parseLaborHours("1.33") });
  await labor({ minutes: 80 });
  const view = await admin.query(api.operations.snapshot, {});
  const record = view!.costs!.find((r) => r.kind === "workOrder");
  if (record?.kind !== "workOrder") throw Error("Cost record missing");
  expect(record.labor).toEqual([
    expect.objectContaining({ seconds: 4788, minutes: 80, rateCents: 10000 }),
    expect.not.objectContaining({ seconds: expect.anything() }),
  ]);
  expect(record.labor.map(laborCents)).toEqual([13300, 13333]);
  await expect(
    run(tech, {
      action: "labor.add",
      workOrderUuid: order.uuid,
      entry: {
        uuid: crypto.randomUUID(),
        date: today,
        technician: "Tech",
      },
    }),
  ).rejects.toThrow();
});
it("isolates cost records between Flight Programs", async () => {
  const { tech, admin, outsider } = await fixture();
  const order = workOrderCommand();
  await tech.mutation(api.workOrders.save, {
    programUuid: "demo-program",
    payload: JSON.stringify(order),
  });
  await run(admin, { action: "settings.laborRate", laborRateCents: 9500 });
  await run(admin, {
    action: "budget.set",
    aircraftUuid: order.fields.aircraftUuid,
    year: 2026,
    amountCents: 1,
  });
  await expect(
    run(
      outsider,
      {
        action: "labor.add",
        workOrderUuid: order.uuid,
        entry: {
          uuid: crypto.randomUUID(),
          date: today,
          technician: "Intruder",
          minutes: 60,
        },
      },
      "other",
    ),
  ).rejects.toThrow("Work order not found");
  await expect(
    run(
      outsider,
      {
        action: "budget.set",
        aircraftUuid: order.fields.aircraftUuid,
        year: 2026,
        amountCents: 2,
      },
      "other",
    ),
  ).rejects.toThrow("Aircraft not found");
  await expect(
    run(outsider, { action: "settings.laborRate", laborRateCents: 1 }),
  ).rejects.toThrow("Program changed");
  // The outsider's own settings row never touches the other program's.
  await run(
    outsider,
    { action: "settings.laborRate", laborRateCents: 1 },
    "other",
  );
  const outsiderView = await outsider.query(api.operations.snapshot, {});
  expect(outsiderView?.costs).toEqual([
    expect.objectContaining({ kind: "settings", programUuid: "other" }),
  ]);
  const adminView = await admin.query(api.operations.snapshot, {});
  expect(adminView?.costs?.find((r) => r.kind === "settings")).toMatchObject({
    programUuid: "demo-program",
    laborRateCents: 9500,
  });
});
it("makes a closed work order's costs read-only", async () => {
  const { tech, admin } = await fixture();
  const order = workOrderCommand();
  await tech.mutation(api.workOrders.save, {
    programUuid: "demo-program",
    payload: JSON.stringify(order),
  });
  await tech.mutation(api.workOrders.save, {
    programUuid: "demo-program",
    payload: JSON.stringify({
      ...order,
      version: 1,
      fields: { ...order.fields, status: "cancelled" },
    }),
  });
  await expect(
    run(admin, {
      action: "labor.add",
      workOrderUuid: order.uuid,
      entry: {
        uuid: crypto.randomUUID(),
        date: today,
        technician: "Late",
        minutes: 60,
      },
    }),
  ).rejects.toThrow("read-only");
});
it("sets and clears a part's unit cost for parts issued to the work order or its job cards", async () => {
  const { t, tech, admin } = await fixture();
  const order = workOrderCommand();
  await tech.mutation(api.workOrders.save, {
    programUuid: "demo-program",
    payload: JSON.stringify(order),
  });
  await t.run((ctx) => seedIssuedParts(ctx, order));
  const unitCost = (stockUuid: string, unitCents: number | null) =>
    run(admin, {
      action: "part.unitCost",
      workOrderUuid: order.uuid,
      stockUuid,
      unitCents,
    });
  await unitCost("stock-0", 1250);
  await unitCost("stock-1", 900);
  await unitCost("stock-0", null);
  await expect(unitCost("stock-9", 1)).rejects.toThrow(
    "That part was not issued to this work order.",
  );
  const view = await admin.query(api.operations.snapshot, {});
  const record = view!.costs!.find((r) => r.kind === "workOrder");
  expect(record).toMatchObject({
    version: 3,
    partUnitCosts: [{ stockUuid: "stock-1", unitCents: 900 }],
  });
  expect(
    view!.audit.filter((a) => a.action === "cost.part.unitCost"),
  ).toHaveLength(3);
});

afterEach(() => vi.restoreAllMocks());

it("refuses a new cost record whose uuid another Flight Program holds, and writes nothing", async () => {
  const { t, admin, outsider } = await fixture();
  await run(
    outsider,
    { action: "settings.laborRate", laborRateCents: 1 },
    "other",
  );
  const stored = () =>
    t.run(async (ctx) => ({
      costs: await ctx.db.query("costs").collect(),
      audit: await ctx.db.query("audit").collect(),
    }));
  const before = await stored();
  vi.spyOn(crypto, "randomUUID").mockReturnValue(
    before.costs[0].uuid as ReturnType<typeof crypto.randomUUID>,
  );
  await expect(
    run(admin, { action: "settings.laborRate", laborRateCents: 9500 }),
  ).rejects.toMatchObject({
    name: "ConvexError",
    data: "Record belongs to another Flight Program.",
  });
  expect(await stored()).toEqual(before);
});

it("leaves the record and the change log as they were for a replayed labor entry", async () => {
  const { t, tech } = await fixture();
  const order = workOrderCommand();
  await tech.mutation(api.workOrders.save, {
    programUuid: "demo-program",
    payload: JSON.stringify(order),
  });
  const labor = {
    action: "labor.add",
    workOrderUuid: order.uuid,
    entry: {
      uuid: crypto.randomUUID(),
      date: today,
      technician: "Tech",
      minutes: 30,
    },
  };
  await run(tech, labor);
  const stored = () =>
    t.run(async (ctx) => ({
      costs: await ctx.db.query("costs").collect(),
      audit: await ctx.db.query("audit").collect(),
    }));
  const before = await stored();
  await run(tech, labor);
  expect(await stored()).toEqual(before);
  expect(
    before.audit.filter((a) => a.action === "cost.labor.add"),
  ).toHaveLength(1);
});

// Issues stock-0 to a task of the order, and stock-1 to a job card the order
// archived.
async function seedIssuedParts(
  ctx: MutationCtx,
  order: ReturnType<typeof workOrderCommand>,
) {
  const aircraftUuid = order.fields.aircraftUuid;
  const card = {
    ...taskCardDefaults(aircraftUuid),
    uuid: crypto.randomUUID(),
    version: 1,
    cardNumber: "JC-1",
    title: "Oil change",
    description: "Change oil and filter",
    workOrderUuid: order.uuid,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    createdBy: "tech",
    technicianSignoff: null,
    inspectionSignoff: null,
    stepSignoffs: {},
  };
  await ctx.db.insert("archivedTaskCards", {
    uuid: card.uuid,
    aircraftUuid,
    payload: JSON.stringify(card),
  });
  const issued = [
    { kind: "workTask", uuid: "task-1", workOrderUuid: order.uuid },
    { kind: "jobCard", uuid: card.uuid },
  ].map((source, n) => issuedRequest(`request-${n}`, source, `stock-${n}`));
  for (const r of issued)
    await ctx.db.insert("partsRequests", {
      uuid: r.uuid,
      programUuid: "demo-program",
      payload: JSON.stringify(r),
    });
}

// A parts request that issued one unit of `stockUuid`, stored with the
// fields the app writes.
function issuedRequest(uuid: string, source: object, stockUuid: string) {
  const now = Date.now();
  return {
    uuid,
    version: 1,
    source,
    mode: "parts",
    date: today,
    engineer: "Mechanic",
    priority: "P2 Routine",
    requiredBy: "",
    currency: "USD",
    lines: [
      { uuid: "line-1", partNumber: "P-1", description: "Part", quantity: 1 },
    ],
    programUuid: "demo-program",
    aircraftUuid: demoSnapshot().aircraft[0].uuid,
    sourceLabel: "Work order",
    aircraftRegistration: "N206MA",
    aircraftSerial: "1",
    aircraftModel: "206",
    number: "PR-1",
    requesterId: "tech",
    createdAt: now,
    updatedAt: now,
    cancelled: false,
    reservations: [],
    issues: [
      { lineUuid: "line-1", stockUuid, quantity: 1, at: now, actorId: "tech" },
    ],
    history: [],
  };
}

it("applies a cost command once per request id: a replay returns nothing and writes nothing", async () => {
  const { t, admin } = await fixture();
  const requestUuid = crypto.randomUUID();
  const rate = (laborRateCents: number) => ({
    action: "settings.laborRate",
    laborRateCents,
    requestUuid,
  });
  const stored = () =>
    t.run(async (ctx) => ({
      costs: await ctx.db.query("costs").collect(),
      audit: await ctx.db.query("audit").collect(),
      commandRequests: await ctx.db.query("commandRequests").collect(),
      managementRequests: await ctx.db.query("managementRequests").collect(),
    }));
  const uuid = await run(admin, rate(9500));
  const saved = await stored();
  expect(saved.costs.map((c) => c.uuid)).toEqual([uuid]);
  expect(saved.commandRequests).toMatchObject([
    { uuid: requestUuid, payload: JSON.stringify(rate(9500)) },
  ]);
  // ADR-0003: a replay succeeds with no payload.
  await expect(run(admin, rate(9500))).resolves.toBeNull();
  expect(await stored()).toEqual(saved);
  await expect(run(admin, rate(9600))).rejects.toMatchObject({
    data: "Request identifier already used.",
  });
  expect(await stored()).toEqual(saved);
});
