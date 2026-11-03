import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import { workOrderCommand } from "../tests/fixtures/workOrders";
import { laborCents, parseLaborHours } from "../src/domain/costs";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
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
        expirationTime: Date.now() + 86400000,
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
