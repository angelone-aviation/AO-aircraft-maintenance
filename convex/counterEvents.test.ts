import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { demoSnapshot } from "../src/data/demo";
import type { AircraftCounterEvent } from "../src/domain/fleet";
import type { Aircraft, Flight } from "../src/domain/model";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const h = (hours: number) => Math.round(hours * 3600);
// N206MA as saved before the fix: a flight, then the Flight time log enabled
// (a legacy event holding every counter), then a correction of that flight
// that the old rebuild dropped from the totals.
async function legacyFleet(options: { replacedHobbs?: boolean } = {}) {
  const t = convexTest(schema, modules);
  const opening = demoSnapshot().aircraft[0];
  const flight: Flight = {
    uuid: "flight-1",
    aircraftUuid: opening.uuid,
    authorId: "admin",
    pilotId: "admin",
    submittedAt: 0,
    status: "accepted",
    startTime: "2026-10-03T09:00:00Z",
    hobbsOff: opening.currentHobbs,
    tachOff: opening.currentTach,
    hobbsOn: opening.currentHobbs + h(1.4),
    landings: 3,
    cycles: 0,
    origin: "",
    destination: "",
    operation: "Mission",
    flightRules: "VFR",
    remarks: "Corrected from 1.0 h and 1 landing",
    discrepancy: "",
  };
  const later: Flight = {
    ...flight,
    uuid: "flight-2",
    startTime: "2026-10-04T09:00:00Z",
    hobbsOff: opening.currentHobbs + h(1),
    hobbsOn: opening.currentHobbs + h(2),
    landings: 1,
    remarks: "",
  };
  // What the aircraft held when the administrator saved the change.
  const before: Aircraft = {
    ...opening,
    currentHobbs: opening.currentHobbs + h(1),
    landings: opening.landings + 1,
    latestFlightAt: flight.startTime,
    version: 1,
  };
  const legacy: AircraftCounterEvent = {
    at: "2026-10-03T12:00:00.000Z",
    meter: "hobbs",
    adjustmentSeconds: 0,
    currentHobbs: options.replacedHobbs ? 0 : before.currentHobbs,
    currentTach: before.currentTach,
    currentFlightTimeLog: h(100),
    cycles: before.cycles,
    landings: before.landings,
  };
  const saved: Aircraft = {
    ...before,
    flightTimeLog: true,
    currentFlightTimeLog: h(100),
    currentHobbs: legacy.currentHobbs,
    counterEvents: [legacy],
    version: 2,
  };
  // Stored totals: the legacy event, then the later flight; the correction of
  // the first flight never reached them.
  const stored: Aircraft = {
    ...saved,
    currentHobbs: options.replacedHobbs ? h(1) : opening.currentHobbs + h(2),
    landings: opening.landings + 2,
    latestFlightAt: later.startTime,
    version: 4,
  };
  if (options.replacedHobbs) {
    later.hobbsOff = 0;
    later.hobbsOn = h(1);
  }
  await t.run(async (ctx) => {
    await ctx.db.insert("programs", demoSnapshot().programs![0]);
    await ctx.db.insert("aircraft", stored);
    await ctx.db.insert("flights", flight);
    await ctx.db.insert("flights", later);
    await ctx.db.insert("audit", {
      uuid: crypto.randomUUID(),
      actorId: "admin",
      at: Date.parse(legacy.at),
      action: "aircraft.updated",
      entityUuid: opening.uuid,
      aircraftUuid: opening.uuid,
      reason: "Aircraft details updated.",
      before: JSON.stringify(before),
      after: JSON.stringify(saved),
    });
  });
  const state = () =>
    t.run(async (ctx) => ({
      aircraft: (await ctx.db.query("aircraft").first())!,
      flights: await ctx.db.query("flights").collect(),
      audit: await ctx.db.query("audit").collect(),
    }));
  return { t, opening, legacy, stored, state };
}
it("records what legacy counter events changed and rebuilds the totals they dropped", async () => {
  const { t, opening, legacy, state } = await legacyFleet();
  const report = await t.mutation(internal.counterEvents.recordChanges, {});
  expect(report).toMatchObject({
    scanned: 1,
    recorded: 1,
    recalculated: 1,
    resequencedFlights: 1,
    derivedFromFlights: 0,
    needsReview: [],
  });
  const after = await state();
  expect(after.aircraft).toMatchObject({
    currentHobbs: opening.currentHobbs + h(2),
    landings: opening.landings + 4,
    currentFlightTimeLog: h(100),
    version: 5,
    counterEvents: [
      { ...legacy, changed: ["currentFlightTimeLog"], previous: {} },
    ],
  });
  expect(after.flights.find((f) => f.uuid === "flight-2")?.hobbsOff).toBe(
    opening.currentHobbs + h(1.4),
  );
  expect(after.audit.map((a) => a.action).sort()).toEqual([
    "aircraft.counters_recalculated",
    "aircraft.updated",
    "flight.resequenced",
  ]);
  // Safe to rerun: nothing left to record.
  expect(
    await t.mutation(internal.counterEvents.recordChanges, {}),
  ).toMatchObject({ scanned: 1, recorded: 0, recalculated: 0 });
  expect((await state()).audit).toHaveLength(3);
});
it("leaves an aircraft whose counter history is inconsistent untouched for review", async () => {
  const { t, stored, state } = await legacyFleet({ replacedHobbs: true });
  const before = await state();
  const report = await t.mutation(internal.counterEvents.recordChanges, {});
  expect(report.recorded).toBe(0);
  expect(report.needsReview).toEqual([
    {
      registration: stored.registration,
      reason: expect.stringMatching(/Cannot accept this chronology/),
    },
  ]);
  expect(await state()).toEqual(before);
});
