import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { demoSnapshot } from "../src/data/demo";
import { aircraftInputSchema } from "../src/domain/fleet";
import type { Aircraft, FlightInput } from "../src/domain/model";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const h = (hours: number) => Math.round(hours * 3600);
async function fixture() {
  const t = convexTest(schema, modules);
  const a = demoSnapshot().aircraft[0];
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("programs", demoSnapshot().programs![0]);
    const admin = await ctx.db.insert("users", {
      name: "Admin",
      email: "admin@example.test",
      active: true,
      isAdmin: true,
      groupIds: [],
    });
    const session = await ctx.db.insert("authSessions", {
      userId: admin,
      expirationTime: Date.now() + 86400000,
    });
    await ctx.db.insert("aircraft", a);
    return { admin, session };
  });
  const admin = t.withIdentity({ subject: ids.admin + "|" + ids.session });
  const input = (overrides: Partial<FlightInput> = {}): FlightInput => ({
    aircraftUuid: a.uuid,
    pilotId: ids.admin,
    startTime: "2026-10-03T09:00:00Z",
    hobbsOn: a.currentHobbs + h(1),
    landings: 1,
    cycles: 0,
    origin: "AAA",
    destination: "BBB",
    operation: "Mission",
    flightRules: "VFR",
    remarks: "",
    discrepancy: "",
    ...overrides,
  });
  const log = async (flight: FlightInput, baseVersion: number) => {
    const uuid = crypto.randomUUID();
    const result = await admin.mutation(api.operations.submit, {
      operation: {
        programUuid: "demo-program",
        kind: "flight",
        uuid,
        authorId: ids.admin,
        baseVersion,
        input: flight,
      },
    });
    return { uuid, input: flight, result };
  };
  const aircraft = () =>
    t.run(async (ctx) =>
      ctx.db
        .query("aircraft")
        .withIndex("uuid", (q) => q.eq("uuid", a.uuid))
        .unique(),
    );
  const saveAircraft = async (changes: Partial<Aircraft>) => {
    const current = (await aircraft())!;
    await admin.mutation(api.fleet.save, {
      programUuid: "demo-program",
      payload: JSON.stringify({
        requestUuid: crypto.randomUUID(),
        reason: "Verified aircraft records",
        action: "aircraft.save",
        aircraft: { ...aircraftInputSchema.parse(current), ...changes },
      }),
    });
  };
  const review = (
    uuid: string,
    flight: FlightInput,
    decision: "accept" | "reject" = "accept",
    reason = "Verified against the paper log",
  ) =>
    admin.mutation(api.operations.reviewFlight, {
      programUuid: "demo-program",
      uuid,
      decision,
      reason,
      input: flight,
    });
  const audit = () => t.run((ctx) => ctx.db.query("audit").collect());
  return { t, a, input, log, aircraft, saveAircraft, review, audit };
}
describe("flight review after aircraft counter changes", () => {
  it("applies a correction of an earlier flight after the Flight time log is enabled", async () => {
    const { a, input, log, aircraft, saveAircraft, review } = await fixture();
    const flight = await log(input(), 0);
    await saveAircraft({ flightTimeLog: true, currentFlightTimeLog: h(100) });
    expect((await aircraft())!.counterEvents![0]).toMatchObject({
      changed: ["currentFlightTimeLog"],
      previous: {},
    });
    await review(
      flight.uuid,
      input({ hobbsOn: a.currentHobbs + h(1.4), landings: 3 }),
    );
    expect(await aircraft()).toMatchObject({
      currentHobbs: a.currentHobbs + h(1.4),
      landings: a.landings + 3,
      currentFlightTimeLog: h(100),
    });
  });
  it("adds an accepted flight that predates a counter change", async () => {
    const { a, input, log, aircraft, saveAircraft, review } = await fixture();
    await saveAircraft({ flightTimeLog: true, currentFlightTimeLog: h(100) });
    const held = await log(
      input({ hobbsOn: a.currentHobbs + h(1.3), landings: 2 }),
      1,
    );
    expect(held.result).toEqual({ status: "review" });
    await review(held.uuid, held.input);
    expect(await aircraft()).toMatchObject({
      currentHobbs: a.currentHobbs + h(1.3),
      landings: a.landings + 2,
    });
  });
  it("derives and records what a legacy counter event changed", async () => {
    const { t, a, input, log, aircraft, review } = await fixture();
    const flight = await log(input(), 0);
    const flown = (await aircraft())!;
    // Stored before the fix: every counter, with no record of what changed.
    const legacy = {
      at: "2026-10-03T12:00:00.000Z",
      meter: "hobbs" as const,
      adjustmentSeconds: 0,
      currentHobbs: flown.currentHobbs,
      currentTach: flown.currentTach,
      currentFlightTimeLog: h(100),
      cycles: flown.cycles,
      landings: flown.landings,
    };
    await t.run((ctx) =>
      ctx.db.patch(flown._id, {
        flightTimeLog: true,
        currentFlightTimeLog: h(100),
        counterEvents: [legacy],
        version: flown.version + 1,
      }),
    );
    await review(
      flight.uuid,
      input({ hobbsOn: a.currentHobbs + h(1.4), landings: 3 }),
    );
    const after = (await aircraft())!;
    expect(after).toMatchObject({
      currentHobbs: a.currentHobbs + h(1.4),
      landings: a.landings + 3,
      currentFlightTimeLog: h(100),
    });
    expect(after.counterEvents).toEqual([
      { ...legacy, changed: ["currentFlightTimeLog"], previous: {} },
    ]);
    // Later reviews keep the correction because the change is now recorded.
    await review(
      flight.uuid,
      input({ hobbsOn: a.currentHobbs + h(1.4), landings: 3 }),
      "accept",
      "Confirmed again",
    );
    expect(await aircraft()).toMatchObject({
      currentHobbs: a.currentHobbs + h(1.4),
      landings: a.landings + 3,
    });
  });
  it("refuses a correction that is inconsistent with an absolute counter change", async () => {
    const { a, input, log, aircraft, saveAircraft, review } = await fixture();
    const flight = await log(input(), 0);
    // Hobbs meter replaced: the administrator sets the new meter to 0.0.
    await saveAircraft({ currentHobbs: 0 });
    const before = await aircraft();
    await expect(
      review(flight.uuid, input({ hobbsOn: a.currentHobbs + h(1.4) })),
    ).rejects.toThrow(/Cannot accept this chronology: it is inconsistent/);
    expect(await aircraft()).toEqual(before);
    await review(flight.uuid, input({ landings: 3 }));
    expect(await aircraft()).toMatchObject({
      currentHobbs: 0,
      landings: a.landings + 3,
    });
  });
});
describe("flight review change history", () => {
  it("records the rebuilt flight and every flight whose starting readings changed", async () => {
    const { a, input, log, review, audit } = await fixture();
    const later = await log(
      input({
        startTime: "2026-10-03T11:00:00Z",
        hobbsOn: a.currentHobbs + h(1),
      }),
      0,
    );
    const earlier = await log(
      input({ hobbsOn: a.currentHobbs + h(0.5), origin: "EARLIER" }),
      1,
    );
    expect(earlier.result).toEqual({ status: "review" });
    await review(earlier.uuid, earlier.input, "accept", "Late entry verified");
    const entries = await audit();
    const reviewed = entries.find((e) => e.action === "flight.reviewed")!;
    expect(JSON.parse(reviewed.after!)).toMatchObject({
      uuid: earlier.uuid,
      status: "accepted",
      hobbsOff: a.currentHobbs,
      hobbsOn: a.currentHobbs + h(0.5),
    });
    const resequenced = entries.filter(
      (e) => e.action === "flight.resequenced",
    );
    expect(resequenced).toHaveLength(1);
    expect(resequenced[0]).toMatchObject({
      entityUuid: later.uuid,
      aircraftUuid: a.uuid,
      reason: expect.stringContaining("was accepted"),
    });
    expect(JSON.parse(resequenced[0].before!)).toEqual({
      hobbsOff: a.currentHobbs,
    });
    expect(JSON.parse(resequenced[0].after!)).toEqual({
      hobbsOff: a.currentHobbs + h(0.5),
    });
  });
});
