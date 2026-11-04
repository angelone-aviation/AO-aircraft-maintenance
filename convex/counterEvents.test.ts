/**
 * Responsibility: Pins the counter-event migration: what it records for each
 *   legacy event, the rebuilt totals and flights, its audit entries, the
 *   aircraft it leaves for review, and that a rerun changes nothing.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/counterEvents, src/data/demo, src/domain/fleet,
 *   src/domain/model.
 */
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

it("records the changes without recalculating when the totals already agree", async () => {
  const { t, opening, legacy, stored, state } = await legacyFleet();
  // The first flight as the totals counted it, so nothing was dropped.
  await t.run(async (ctx) => {
    const first = (await ctx.db.query("flights").first())!;
    await ctx.db.patch(first._id, {
      hobbsOn: opening.currentHobbs + h(1),
      landings: 1,
    });
  });
  const report = await t.mutation(internal.counterEvents.recordChanges, {});
  expect(report).toMatchObject({ recorded: 1, recalculated: 0 });
  const after = await state();
  expect(after.aircraft).toMatchObject({
    currentHobbs: stored.currentHobbs,
    landings: stored.landings,
    version: stored.version,
  });
  const row = after.audit.find((a) => a.action !== "aircraft.updated")!;
  expect(row).toMatchObject({
    action: "aircraft.counter_changes_recorded",
    actorId: "system",
    entityUuid: opening.uuid,
    reason:
      "Migration: recorded which counters each earlier counter change set.",
  });
  expect(JSON.parse(row.before!).counterEvents).toEqual([legacy]);
  expect(JSON.parse(row.after!).counterEvents).toEqual(
    after.aircraft.counterEvents,
  );
});

it("keeps each changed counter's earlier value and audits the rebuild", async () => {
  const { t, opening, state } = await legacyFleet();
  await t.run(async (ctx) => {
    const aircraft = (await ctx.db.query("aircraft").first())!;
    const [event] = aircraft.counterEvents!;
    await ctx.db.patch(aircraft._id, {
      counterEvents: [{ ...event, cycles: opening.cycles + 5 }],
    });
  });
  await t.mutation(internal.counterEvents.recordChanges, {});
  const after = await state();
  expect(after.aircraft.counterEvents).toMatchObject([
    {
      changed: ["currentFlightTimeLog", "cycles"],
      previous: { cycles: opening.cycles },
    },
  ]);
  const reasons = Object.fromEntries(
    after.audit.map((a) => [a.action, a.reason]),
  );
  expect(reasons).toMatchObject({
    "aircraft.counters_recalculated":
      "Migration: a counter change now overrides only the counters an administrator changed, so totals were rebuilt from the flight log.",
    "flight.resequenced":
      "Migration: starting readings recalculated after rebuilding the aircraft's counter history.",
  });
});

it("works out an event whose save is not in the change log from the flight log", async () => {
  const { t, state } = await legacyFleet();
  await t.run(async (ctx) => {
    for (const row of await ctx.db.query("audit").collect())
      await ctx.db.delete(row._id);
  });
  const report = await t.mutation(internal.counterEvents.recordChanges, {});
  expect(report).toMatchObject({ recorded: 1, derivedFromFlights: 1 });
  // Characterizes current behaviour: the corrected first flight no longer
  // leads to the event's Hobbs and landings, so they count as changed too.
  expect((await state()).aircraft.counterEvents).toMatchObject([
    { changed: ["currentHobbs", "currentFlightTimeLog", "landings"] },
  ]);
});

it("leaves an aircraft for review when a component was installed past its rebuilt totals", async () => {
  const { t, opening, stored, state } = await legacyFleet();
  const component = {
    kind: "component" as const,
    uuid: "pump",
    version: 1,
    programUuid: opening.programUuid,
    aircraftUuid: opening.uuid,
    componentType: "Pump",
    partNumber: "P",
    serial: "S",
    manufacturer: "",
    notes: "",
    trackTime: false,
    trackCycles: true,
    trackCalendar: false,
    installed: true,
    installedDate: "2026-01-01",
    installedSeconds: 0,
    installedCycles: opening.cycles + 1,
    timeSinceNew: 0,
    timeSinceOverhaul: null,
    timeSinceRepair: null,
    cyclesSinceNew: 0,
    serviceDaysBase: 0,
  };
  await t.run((ctx) =>
    ctx.db.insert("management", {
      uuid: component.uuid,
      kind: component.kind,
      programUuid: component.programUuid,
      aircraftUuid: component.aircraftUuid,
      payload: JSON.stringify(component),
    }),
  );
  const before = await state();
  const report = await t.mutation(internal.counterEvents.recordChanges, {});
  expect(report.needsReview).toEqual([
    {
      registration: stored.registration,
      reason:
        "Correction would move aircraft totals before a component installation.",
    },
  ]);
  expect(await state()).toEqual(before);
});

it("reads an event's changes from the save that added it, not a later one", async () => {
  const { t, opening, state } = await legacyFleet();
  // A later edit that already held the event, listed ahead of its save.
  await t.run(async (ctx) => {
    const save = (await ctx.db.query("audit").first())!;
    const { _id, _creationTime, ...row } = save;
    await ctx.db.delete(_id);
    const saved = JSON.parse(save.after!);
    await ctx.db.insert("audit", {
      ...row,
      uuid: crypto.randomUUID(),
      before: JSON.stringify({ ...saved, landings: opening.landings + 50 }),
    });
    await ctx.db.insert("audit", row);
  });
  await t.mutation(internal.counterEvents.recordChanges, {});
  expect((await state()).aircraft.counterEvents).toMatchObject([
    { changed: ["currentFlightTimeLog"] },
  ]);
});
