/**
 * Responsibility: Pins how the server takes a pilot's legs logged offline on
 *   one aircraft and chained on the device: accepted in order, and every
 *   later leg held when an earlier one is held or refused.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/operations.ts (submit), convex/schema.ts,
 *   src/domain (flightSubmission, model), src/data/demo.ts (fixture).
 *
 * The server's checks are unchanged (decision D7): the legs carry the
 * versions the device works out with aircraftAfterPendingFlights.
 */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { demoSnapshot } from "../src/data/demo";
import { aircraftAfterPendingFlights } from "../src/domain/flightSubmission";
import type { FlightOperation } from "../src/domain/flightSubmission";
import type { Aircraft } from "../src/domain/model";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const DAY_MS = 86_400_000;
const HOUR_SECONDS = 3600;
const TOTALS_CHANGED = "Aircraft totals changed after this entry was started.";

/** Seeds the demo program, its first aircraft and a line pilot. */
async function fixture() {
  const t = convexTest(schema, modules);
  const a = demoSnapshot().aircraft[0];
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("programs", demoSnapshot().programs![0]);
    const pilots = await ctx.db.insert("groups", {
      programUuid: "demo-program",
      name: "Pilots",
      aircraftIds: [],
      permissions: ["read", "flight", "discrepancy"],
    });
    const pilot = await ctx.db.insert("users", {
      name: "Pilot",
      email: "pilot@example.test",
      active: true,
      isAdmin: false,
      groupIds: [pilots],
    });
    await ctx.db.insert("aircraft", a);
    const session = await ctx.db.insert("authSessions", {
      userId: pilot,
      expirationTime: Date.now() + DAY_MS,
    });
    return { pilot, session };
  });
  const pilot = t.withIdentity({ subject: ids.pilot + "|" + ids.session });
  const stored = () =>
    t.run(async (ctx) => {
      const doc = await ctx.db
        .query("aircraft")
        .withIndex("uuid", (q) => q.eq("uuid", a.uuid))
        .unique();
      return doc as unknown as Aircraft;
    });
  const flights = () => t.run((ctx) => ctx.db.query("flights").collect());
  return { t, pilot, pilotId: ids.pilot, a, stored, flights };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

// Builds the legs offline as the device does: each queued against the
// cached aircraft, taking the version its earlier legs will leave.
function offlineLegs(f: Fixture, endHours: number[]): FlightOperation[] {
  const device = { ...demoSnapshot(), aircraft: [f.a], flights: [] };
  device.user = { ...device.user, id: f.pilotId };
  const legs: FlightOperation[] = [];
  for (const [i, hours] of endHours.entries()) {
    const version = aircraftAfterPendingFlights(device, f.a.uuid, legs)!;
    legs.push({
      programUuid: "demo-program",
      kind: "flight",
      uuid: crypto.randomUUID(),
      authorId: f.pilotId,
      baseVersion: version.version,
      input: {
        aircraftUuid: f.a.uuid,
        pilotId: f.pilotId,
        startTime: new Date(Date.now() - (3 - i) * 3_600_000).toISOString(),
        hobbsOn: f.a.currentHobbs + hours * HOUR_SECONDS,
        landings: 1,
        cycles: 0,
        origin: "AAA",
        destination: "BBB",
        operation: "Mission",
        flightRules: "VFR",
        remarks: "",
        discrepancy: "",
      },
    });
  }
  return legs;
}

async function sync(f: Fixture, legs: FlightOperation[]) {
  const results: unknown[] = [];
  for (const operation of legs)
    results.push(
      await f.pilot
        .mutation(api.operations.submit, { operation })
        .catch((e: unknown) => e),
    );
  return results;
}

describe("a pilot's offline legs on one aircraft", () => {
  it("are accepted in order, each starting where the last ended", async () => {
    const f = await fixture();
    const legs = offlineLegs(f, [1, 2, 3]);
    expect(await sync(f, legs)).toEqual([
      { status: "accepted" },
      { status: "accepted" },
      { status: "accepted" },
    ]);
    const stored = await f.flights();
    expect(stored.map((x) => x.hobbsOff)).toEqual([
      f.a.currentHobbs,
      f.a.currentHobbs + HOUR_SECONDS,
      f.a.currentHobbs + 2 * HOUR_SECONDS,
    ]);
    const after = await f.stored();
    expect(after.currentHobbs).toBe(f.a.currentHobbs + 3 * HOUR_SECONDS);
    expect(after.version).toBe(f.a.version + 3);
  });

  it("are all held when the first is held, and totals stay unchanged", async () => {
    const f = await fixture();
    // 30 hours is longer than any single flight, so the first leg is held.
    const legs = offlineLegs(f, [30, 31, 32]);
    expect(await sync(f, legs)).toEqual([
      { status: "review" },
      { status: "review" },
      { status: "review" },
    ]);
    const stored = await f.flights();
    expect(stored.slice(1).map((x) => x.reviewReason)).toEqual([
      TOTALS_CHANGED,
      TOTALS_CHANGED,
    ]);
    expect((await f.stored()).currentHobbs).toBe(f.a.currentHobbs);
  });

  it("are held after the first is refused", async () => {
    const f = await fixture();
    const legs = offlineLegs(f, [1, 2, 3]);
    legs[0].input.copilotId = "not-a-member";
    const [refused, ...rest] = await sync(f, legs);
    expect(refused).toBeInstanceOf(Error);
    expect(rest).toEqual([{ status: "review" }, { status: "review" }]);
    const stored = await f.flights();
    expect(stored.map((x) => x.reviewReason)).toEqual([
      TOTALS_CHANGED,
      TOTALS_CHANGED,
    ]);
    expect((await f.stored()).version).toBe(f.a.version);
  });
});
