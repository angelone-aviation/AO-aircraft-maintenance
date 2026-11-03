import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { partsFixture } from "../tests/fixtures/requiredParts";
import {
  workOrderCommand,
  workOrderComponent,
} from "../tests/fixtures/workOrders";
import type { WorkOrder } from "../src/domain/workOrders";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const owned = "demo-206";
function completedOrder(): WorkOrder {
  const command = workOrderCommand();
  return {
    ...command.fields,
    number: "WO-1",
    status: "completed",
    completionDate: "2026-02-01",
    supervisor: "Chief inspector",
    finalReview: "Internal review note",
    uuid: crypto.randomUUID(),
    version: 1,
    recordedAt: 1,
    createdBy: "someone",
    aircraft: {
      registration: "N206MA",
      make: "Cessna",
      model: "206",
      serial: "1",
      totalSeconds: 0,
      hobbs: 0,
      tach: 0,
      meter: "hobbs",
      cycles: 0,
    },
    componentReadings: [],
    tasks: [],
  };
}
async function fixture() {
  const t = convexTest(schema, modules);
  const s = partsFixture();
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("programs", s.programs![0]);
    for (const a of s.aircraft) await ctx.db.insert("aircraft", a);
    for (const i of s.inspections) await ctx.db.insert("inspections", i);
    for (const r of [
      ...s.management!,
      { ...workOrderComponent(), notes: "Internal component note" },
    ])
      await ctx.db.insert("management", {
        uuid: r.uuid,
        kind: r.kind,
        programUuid: "demo-program",
        aircraftUuid: "aircraftUuid" in r ? r.aircraftUuid : undefined,
        payload: JSON.stringify({ ...r, programUuid: "demo-program" }),
      });
    for (const [uuid, aircraftUuid, status] of [
      ["open-206", owned, "open"],
      ["resolved-206", owned, "resolved"],
      ["open-208", "demo-208", "open"],
    ] as const)
      await ctx.db.insert("discrepancies", {
        uuid,
        aircraftUuid,
        description: "Report " + uuid,
        status,
        authorId: "someone",
        createdAt: 1,
        resolution: status === "resolved" ? "Internal resolution" : undefined,
      });
    const order = completedOrder();
    await ctx.db.insert("workOrders", {
      uuid: order.uuid,
      aircraftUuid: owned,
      payload: JSON.stringify(order),
    });
    await ctx.db.insert("audit", {
      uuid: crypto.randomUUID(),
      programUuid: "demo-program",
      aircraftUuid: owned,
      actorId: "someone",
      at: 1,
      action: "flight.created",
      entityUuid: "x",
    });
    const owners = await ctx.db.insert("groups", {
      programUuid: "demo-program",
      name: "Aircraft owners",
      owner: true,
      aircraftIds: [owned],
      permissions: ["read"],
    });
    const pilots = await ctx.db.insert("groups", {
      programUuid: "demo-program",
      name: "Pilots",
      aircraftIds: [],
      permissions: ["read", "flight", "discrepancy"],
    });
    const user = async (name: string, groupIds: (typeof owners)[]) => {
      const id = await ctx.db.insert("users", {
        name,
        email: name + "@example.test",
        active: true,
        isAdmin: false,
        groupIds,
      });
      const session = await ctx.db.insert("authSessions", {
        userId: id,
        expirationTime: Date.now() + 86400000,
      });
      return { id, subject: `${id}|${session}` };
    };
    return {
      owner: await user("owner", [owners]),
      pilot: await user("pilot", [pilots]),
      owners,
    };
  });
  // Accounts inserted directly predate the memberships index; backfill it.
  await t.mutation(internal.memberships.backfill, {});
  return {
    t,
    ids,
    owner: t.withIdentity({ subject: ids.owner.subject }),
    pilot: t.withIdentity({ subject: ids.pilot.subject }),
  };
}

describe("owner portal isolation", () => {
  it("limits an owner snapshot to owned aircraft and owner-safe fields", async () => {
    const { owner, ids } = await fixture();
    const s = (await owner.query(api.operations.snapshot, {}))!;
    expect(s.aircraft.map((a) => a.uuid)).toEqual([owned]);
    expect(s.discrepancies.map((d) => d.uuid)).toEqual(["open-206"]);
    expect(s.discrepancies[0].authorId).toBe("");
    expect(s.management?.map((r) => r.kind)).toEqual(["component"]);
    expect(s.workOrders?.map((w) => [w.number, w.tasks.length])).toEqual([
      ["WO-1", 0],
    ]);
    expect(s.workOrderAttachments).toBeUndefined();
    expect(s.audit).toEqual([]);
    expect(s.flights).toEqual([]);
    expect(s.members.map((m) => m.id)).toEqual([ids.owner.id]);
    for (const key of [
      "purchaseOrders",
      "partsRequests",
      "partsInventory",
      "partsOnOrder",
      "savedAddresses",
      "faaCredential",
      "checklists",
      "flightPlans",
      "taskCards",
      "inventoryAttachments",
    ] as const)
      expect(s[key], key).toBeUndefined();
    expect(JSON.stringify(s)).not.toMatch(
      /Internal|Chief|Private vendor|Main hangar|demo-208/,
    );
  });

  it("leaves a normal user's snapshot unchanged", async () => {
    const { pilot } = await fixture();
    const s = (await pilot.query(api.operations.snapshot, {}))!;
    expect(s.aircraft).toHaveLength(3);
    expect(s.discrepancies).toHaveLength(3);
    expect(s.audit.length).toBeGreaterThan(0);
    expect(s.members.length).toBeGreaterThan(1);
    expect(s.workOrders?.[0].supervisor).toBe("Chief inspector");
    expect(s.partsInventory).toBeDefined();
  });

  it("rejects owner writes", async () => {
    const { owner, ids } = await fixture();
    const programUuid = "demo-program";
    await expect(
      owner.mutation(api.operations.submit, {
        operation: {
          programUuid,
          kind: "discrepancy",
          uuid: crypto.randomUUID(),
          authorId: ids.owner.id,
          aircraftUuid: owned,
          description: "Owner report",
        },
      }),
    ).rejects.toThrow("read-only");
    await expect(
      owner.mutation(api.operations.resolveDiscrepancy, {
        uuid: "open-206",
        resolution: "Fixed",
        programUuid,
      }),
    ).rejects.toThrow("read-only");
    await expect(
      owner.mutation(api.operations.saveDiscrepancyParts, {
        uuid: "open-206",
        version: 0,
        payload: "[]",
        programUuid,
      }),
    ).rejects.toThrow("read-only");
    await expect(
      owner.mutation(api.workOrders.save, {
        programUuid,
        payload: JSON.stringify(workOrderCommand()),
      }),
    ).rejects.toThrow("read-only");
    await expect(
      owner.mutation(api.admin.saveGroup, {
        id: ids.owners,
        programUuid,
        owner: false,
        name: "Aircraft owners",
        aircraftIds: [],
        permissions: ["read", "maintenance"],
      }),
    ).rejects.toThrow("Administrator");
    await expect(
      owner.query(api.savedAddresses.list, { programUuid }),
    ).rejects.toThrow("read-only");
  });

  it("only saves owner groups as read-only", async () => {
    const { t, ids } = await fixture();
    const subject = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {
        name: "Admin",
        active: true,
        isAdmin: true,
        groupIds: [],
      });
      const session = await ctx.db.insert("authSessions", {
        userId: id,
        expirationTime: Date.now() + 86400000,
      });
      return `${id}|${session}`;
    });
    const admin = t.withIdentity({ subject });
    const group = {
      id: ids.owners,
      programUuid: "demo-program",
      owner: true,
      name: "Aircraft owners",
      aircraftIds: [owned],
    };
    await expect(
      admin.mutation(api.admin.saveGroup, {
        ...group,
        permissions: ["read", "maintenance"],
      }),
    ).rejects.toThrow("read-only");
    await expect(
      admin.mutation(api.admin.saveGroup, {
        ...group,
        programAdmin: true,
        permissions: ["read"],
      }),
    ).rejects.toThrow("read-only");
    await admin.mutation(api.admin.saveGroup, {
      ...group,
      permissions: ["read"],
    });
    expect((await t.run((ctx) => ctx.db.get(ids.owners)))?.owner).toBe(true);
  });
});
