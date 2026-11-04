/**
 * Responsibility: Pins the dispatch gate on submitted flights (a grounded
 *   aircraft refused, an administrator's override recorded) and discrepancy
 *   grounding flags and deferrals.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/operations.ts (submit, deferDiscrepancy),
 *   convex/schema.ts, src/domain/model.ts, src/data/demo.ts (fixture).
 */
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { demoSnapshot } from "../src/data/demo";
import type { FlightInput } from "../src/domain/model";
import { localDate } from "../src/domain/model";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const DAY_MS = 86_400_000;
const HOUR_SECONDS = 3600;

/**
 * Seeds the demo program and a second one, an aircraft in each, a pilot and a
 * program administrator, with builders for a one-hour flight and a grounding
 * report.
 */
async function fixture() {
  const t = convexTest(schema, modules);
  const a = demoSnapshot().aircraft[0];
  const other = {
    ...a,
    uuid: "other-aircraft",
    registration: "N999OT",
    programUuid: "other-program",
  };
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("programs", demoSnapshot().programs![0]);
    await ctx.db.insert("programs", {
      ...demoSnapshot().programs![0],
      uuid: "other-program",
      name: "Other program",
    });
    const pilots = await ctx.db.insert("groups", {
      programUuid: "demo-program",
      name: "Pilots",
      aircraftIds: [],
      permissions: ["read", "flight", "discrepancy"],
    });
    const admins = await ctx.db.insert("groups", {
      programUuid: "demo-program",
      name: "Program admins",
      programAdmin: true,
      aircraftIds: [],
      permissions: ["read"],
    });
    const pilot = await ctx.db.insert("users", {
      name: "Pilot",
      email: "pilot@example.test",
      active: true,
      isAdmin: false,
      groupIds: [pilots],
    });
    const admin = await ctx.db.insert("users", {
      name: "Program Admin",
      email: "admin@example.test",
      active: true,
      isAdmin: false,
      groupIds: [admins],
    });
    await ctx.db.insert("aircraft", a);
    await ctx.db.insert("aircraft", other);
    const session = (userId: typeof pilot) =>
      ctx.db.insert("authSessions", {
        userId,
        expirationTime: Date.now() + DAY_MS,
      });
    return {
      pilot,
      admin,
      pilotSession: await session(pilot),
      adminSession: await session(admin),
    };
  });
  const pilot = t.withIdentity({
    subject: ids.pilot + "|" + ids.pilotSession,
  });
  const admin = t.withIdentity({
    subject: ids.admin + "|" + ids.adminSession,
  });
  const input = (pilotId: string): FlightInput => ({
    aircraftUuid: a.uuid,
    pilotId,
    startTime: "2026-01-01T10:00:00Z",
    hobbsOn: a.currentHobbs + HOUR_SECONDS,
    landings: 1,
    cycles: 1,
    origin: "AAA",
    destination: "BBB",
    operation: "Mission",
    flightRules: "VFR",
    remarks: "",
    discrepancy: "",
  });
  const flight = (authorId: string, dispatchOverrideReason?: string) => ({
    programUuid: "demo-program",
    kind: "flight" as const,
    uuid: crypto.randomUUID(),
    authorId,
    baseVersion: 0,
    input: input(authorId),
    dispatchOverrideReason,
  });
  const report = (aircraftUuid = a.uuid) => ({
    uuid: crypto.randomUUID(),
    aircraftUuid,
    description: "Alternator inoperative",
    status: "open" as const,
    grounding: true,
    authorId: ids.pilot,
    createdAt: Date.now(),
  });
  return { t, pilot, admin, ids, a, other, flight, report };
}

describe("dispatch gate at submission", () => {
  it("rejects a grounded aircraft permanently with the reasons", async () => {
    const { t, pilot, ids, flight, report } = await fixture();
    await t.run((ctx) => ctx.db.insert("discrepancies", report()));
    const error = await pilot
      .mutation(api.operations.submit, { operation: flight(ids.pilot) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConvexError);
    expect((error as ConvexError<string>).data).toContain(
      "N206MA is grounded: Open discrepancy: Alternator inoperative",
    );
    expect(await t.run((ctx) => ctx.db.query("flights").collect())).toEqual([]);
  });
  it("grounds on an overdue inspection loaded per aircraft", async () => {
    const { t, pilot, ids, a, flight } = await fixture();
    await t.run((ctx) =>
      ctx.db.insert("inspections", {
        uuid: "annual",
        aircraftUuid: a.uuid,
        reference: "Annual inspection",
        description: "",
        dueDate: localDate(Date.now() - 3 * DAY_MS),
      }),
    );
    await expect(
      pilot.mutation(api.operations.submit, { operation: flight(ids.pilot) }),
    ).rejects.toThrow("Annual inspection overdue");
  });
  it("rejects overrides from non-administrators", async () => {
    const { t, pilot, ids, flight, report } = await fixture();
    await t.run((ctx) => ctx.db.insert("discrepancies", report()));
    await expect(
      pilot.mutation(api.operations.submit, {
        operation: flight(ids.pilot, "Ferry flight to the repair shop"),
      }),
    ).rejects.toThrow("Only a Flight Program administrator");
  });
  it("stores a program administrator override on the flight and in the audit log", async () => {
    const { t, admin, ids, flight, report } = await fixture();
    await t.run((ctx) => ctx.db.insert("discrepancies", report()));
    await expect(
      admin.mutation(api.operations.submit, {
        operation: flight(ids.admin, "too short"),
      }),
    ).rejects.toThrow("10–1000 characters");
    const operation = flight(ids.admin, "Ferry flight to the repair shop");
    expect(await admin.mutation(api.operations.submit, { operation })).toEqual({
      status: "accepted",
    });
    const state = await t.run(async (ctx) => ({
      flight: await ctx.db
        .query("flights")
        .withIndex("uuid", (q) => q.eq("uuid", operation.uuid))
        .unique(),
      audit: await ctx.db.query("audit").collect(),
    }));
    expect(state.flight!.dispatchOverride).toMatchObject({
      by: ids.admin,
      name: "Program Admin",
      reason: "Ferry flight to the repair shop",
    });
    expect(
      state.audit.find((e) => e.action === "flight.dispatch_override"),
    ).toMatchObject({
      entityUuid: operation.uuid,
      reason: "Ferry flight to the repair shop",
    });
  });
  it("ignores grounding findings on another program's aircraft", async () => {
    const { t, pilot, ids, other, flight, report } = await fixture();
    await t.run((ctx) => ctx.db.insert("discrepancies", report(other.uuid)));
    expect(
      await pilot.mutation(api.operations.submit, {
        operation: flight(ids.pilot),
      }),
    ).toEqual({ status: "accepted" });
  });
});

describe("discrepancy grounding flag and deferrals", () => {
  it("stores the grounding flag and defaults to not grounding", async () => {
    const { t, pilot, ids, a } = await fixture();
    const base = {
      programUuid: "demo-program",
      kind: "discrepancy" as const,
      authorId: ids.pilot,
      aircraftUuid: a.uuid,
      description: "Seat cushion torn",
    };
    await pilot.mutation(api.operations.submit, {
      operation: { ...base, uuid: crypto.randomUUID() },
    });
    await pilot.mutation(api.operations.submit, {
      operation: { ...base, uuid: crypto.randomUUID(), grounding: true },
    });
    const reports = await t.run((ctx) =>
      ctx.db.query("discrepancies").collect(),
    );
    expect(reports.map((r) => r.grounding)).toEqual([undefined, true]);
  });
  it("lets an authorized user defer a grounding report so the aircraft can fly until expiry", async () => {
    const { t, pilot, admin, ids, flight, report } = await fixture();
    const d = report();
    await t.run((ctx) => ctx.db.insert("discrepancies", d));
    const payload = JSON.stringify({
      uuid: d.uuid,
      deferredOn: localDate(),
      deferral: {
        type: "mel",
        melItem: "24-1",
        category: "B",
        placard: "ALT INOP",
      },
    });
    await expect(
      pilot.mutation(api.operations.deferDiscrepancy, {
        payload,
        programUuid: "demo-program",
      }),
    ).rejects.toThrow("permission");
    await admin.mutation(api.operations.deferDiscrepancy, {
      payload,
      programUuid: "demo-program",
    });
    const stored = await t.run((ctx) =>
      ctx.db
        .query("discrepancies")
        .withIndex("uuid", (q) => q.eq("uuid", d.uuid))
        .unique(),
    );
    expect(stored!.deferral).toMatchObject({
      type: "mel",
      category: "B",
      deferredBy: ids.admin,
      deferredByName: "Program Admin",
    });
    await expect(
      admin.mutation(api.operations.deferDiscrepancy, {
        payload,
        programUuid: "demo-program",
      }),
    ).rejects.toThrow("already deferred");
    expect(
      await pilot.mutation(api.operations.submit, {
        operation: flight(ids.pilot),
      }),
    ).toEqual({ status: "accepted" });
    // Once expired, the deferral grounds the aircraft again.
    await t.run((ctx) =>
      ctx.db.patch(stored!._id, {
        deferral: { ...stored!.deferral!, expiresOn: "2020-01-01" },
      }),
    );
    await expect(
      pilot.mutation(api.operations.submit, {
        operation: { ...flight(ids.pilot), baseVersion: 1 },
      }),
    ).rejects.toThrow("deferral expired 2020-01-01");
  });
  it("cannot defer another program's report", async () => {
    const { t, admin, other, report } = await fixture();
    const d = report(other.uuid);
    await t.run((ctx) => ctx.db.insert("discrepancies", d));
    await expect(
      admin.mutation(api.operations.deferDiscrepancy, {
        payload: JSON.stringify({
          uuid: d.uuid,
          deferredOn: localDate(),
          deferral: { type: "91.213d", placard: "INOP", notHazard: true },
        }),
        programUuid: "demo-program",
      }),
    ).rejects.toThrow("permission");
    const stored = await t.run((ctx) =>
      ctx.db
        .query("discrepancies")
        .withIndex("uuid", (q) => q.eq("uuid", d.uuid))
        .unique(),
    );
    expect(stored!.deferral).toBeUndefined();
  });
});
