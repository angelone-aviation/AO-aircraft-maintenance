/**
 * Responsibility: One-off migration (#35) that records which counters each
 *   legacy counter event changed, then rebuilds totals from the flight log.
 * Layer: Server. One internal mutation, run by hand with the deployment key;
 *   it audits every aircraft and flight it changes as "system".
 * Dependencies: convex/access, convex/programContext, src/domain/fleet,
 *   src/domain/flights, src/domain/management, src/domain/model.
 *
 * Events saved before the fix hold every counter, and flight reviews replayed
 * each as a full snapshot, dropping corrections, accepted held flights and
 * rejections of earlier flights from the totals.
 */
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { audit } from "./access";
import { managementDocs } from "./programContext";
import { counterFields, type AircraftCounterEvent } from "../src/domain/fleet";
import { rebuildFlights, resequencedFlights } from "../src/domain/flights";
import {
  recordSchema,
  validateMaintenanceTotals,
} from "../src/domain/management";
import type { Aircraft, Flight } from "../src/domain/model";

const TOTAL_FIELDS = [
  "currentHobbs",
  "currentTach",
  "currentCyclicHobbs",
  "currentFlightTimeLog",
  "cycles",
  "landings",
  "latestFlightAt",
] as const;

type Report = {
  scanned: number;
  recorded: number;
  recalculated: number;
  resequencedFlights: number;
  derivedFromFlights: number;
  needsReview: { registration: string; reason: string }[];
};
type Save = { before: Aircraft; after: Aircraft };

/**
 * Records the counters each legacy event changed, from the aircraft's values
 * in the `aircraft.updated` entry that saved it (or, without one, from the
 * flight log as a review would), then rebuilds the totals. Run once after
 * deploying: `npx convex run counterEvents:recordChanges`. Safe to rerun:
 * aircraft whose events all record their changes are skipped.
 *
 * @returns Counts of aircraft scanned, recorded and recalculated, flights
 *   resequenced and events derived from flights; `needsReview` lists the
 *   aircraft whose rebuild was refused, left untouched, with the reason.
 */
export const recordChanges = internalMutation({
  args: {},
  handler: async (ctx) => {
    const report: Report = {
      scanned: 0,
      recorded: 0,
      recalculated: 0,
      resequencedFlights: 0,
      derivedFromFlights: 0,
      needsReview: [],
    };
    for (const aircraft of await ctx.db.query("aircraft").collect()) {
      report.scanned++;
      await migrateAircraft(ctx, aircraft, report);
    }
    return report;
  },
});

async function migrateAircraft(
  ctx: MutationCtx,
  aircraft: Doc<"aircraft">,
  report: Report,
): Promise<void> {
  const events = aircraft.counterEvents ?? [];
  if (!events.some((e) => !e.changed)) return;
  const saves = await findAircraftSaves(ctx, aircraft.uuid);
  const { explicit, derived } = explainEvents(events, saves);
  const flights = await ctx.db
    .query("flights")
    .withIndex("aircraft", (q) => q.eq("aircraftUuid", aircraft.uuid))
    .collect();
  let rebuilt: ReturnType<typeof rebuildFlights>;
  try {
    rebuilt = await rebuildValidated(ctx, aircraft, explicit, flights);
  } catch (error) {
    // A refused rebuild (an inconsistent chronology or maintenance baseline)
    // leaves the aircraft as it is, for an administrator to review.
    report.needsReview.push({
      registration: aircraft.registration,
      reason: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  const changed = await saveRebuiltAircraft(ctx, aircraft, rebuilt.aircraft);
  await auditRebuild(ctx, aircraft, events, rebuilt.aircraft, changed);
  report.resequencedFlights += await saveResequencedFlights(
    ctx,
    aircraft,
    flights,
    rebuilt.flights,
  );
  report.recorded++;
  if (changed) report.recalculated++;
  report.derivedFromFlights += derived;
}

async function findAircraftSaves(
  ctx: MutationCtx,
  aircraftUuid: string,
): Promise<Save[]> {
  return (
    await ctx.db
      .query("audit")
      .withIndex("entity", (q) => q.eq("entityUuid", aircraftUuid))
      .collect()
  )
    .filter((a) => a.action === "aircraft.updated" && a.before && a.after)
    .map((a) => ({
      before: JSON.parse(a.before!) as Aircraft,
      after: JSON.parse(a.after!) as Aircraft,
    }));
}

// An event's save is the one whose aircraft gained it. Events without one
// are left for rebuildFlights to work out, and counted as derived.
function explainEvents(events: AircraftCounterEvent[], saves: Save[]) {
  let derived = 0;
  const explicit = events.map((e): AircraftCounterEvent => {
    if (e.changed) return e;
    const save = saves.find(
      (s) => holdsEvent(s.after, e.at) && !holdsEvent(s.before, e.at),
    );
    if (save) return recordChangedCounters(e, save.before);
    derived++;
    return e;
  });
  return { explicit, derived };
}

function holdsEvent(aircraft: Aircraft, at: string): boolean {
  return !!aircraft.counterEvents?.some((e) => e.at === at);
}

function recordChangedCounters(
  event: AircraftCounterEvent,
  before: Aircraft,
): AircraftCounterEvent {
  const changed = counterFields.filter((k) => event[k] !== before[k]);
  return {
    ...event,
    changed,
    previous: Object.fromEntries(
      changed.filter((k) => before[k] !== undefined).map((k) => [k, before[k]]),
    ),
  };
}

async function rebuildValidated(
  ctx: MutationCtx,
  aircraft: Doc<"aircraft">,
  counterEvents: AircraftCounterEvent[],
  flights: Doc<"flights">[],
): Promise<ReturnType<typeof rebuildFlights>> {
  const rebuilt = rebuildFlights({ ...aircraft, counterEvents }, flights);
  validateMaintenanceTotals(
    rebuilt.aircraft,
    (await managementDocs(ctx, aircraft.programUuid)).map((d) =>
      recordSchema.parse(JSON.parse(d.payload)),
    ),
    await ctx.db
      .query("inspections")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", aircraft.uuid))
      .collect(),
  );
  return rebuilt;
}

async function saveRebuiltAircraft(
  ctx: MutationCtx,
  aircraft: Doc<"aircraft">,
  rebuilt: Aircraft,
): Promise<boolean> {
  const changed = TOTAL_FIELDS.some((k) => rebuilt[k] !== aircraft[k]);
  await ctx.db.patch(aircraft._id, {
    counterEvents: rebuilt.counterEvents,
    ...(changed && {
      currentHobbs: rebuilt.currentHobbs,
      currentTach: rebuilt.currentTach,
      currentCyclicHobbs: rebuilt.currentCyclicHobbs,
      currentFlightTimeLog: rebuilt.currentFlightTimeLog,
      cycles: rebuilt.cycles,
      landings: rebuilt.landings,
      latestFlightAt: rebuilt.latestFlightAt,
      // Entries started against the old totals are held for review.
      version: aircraft.version + 1,
    }),
  });
  return changed;
}

async function auditRebuild(
  ctx: MutationCtx,
  aircraft: Doc<"aircraft">,
  events: AircraftCounterEvent[],
  rebuilt: Aircraft,
  changed: boolean,
): Promise<void> {
  await audit(
    ctx,
    "system",
    changed
      ? "aircraft.counters_recalculated"
      : "aircraft.counter_changes_recorded",
    aircraft.uuid,
    {
      programUuid: aircraft.programUuid,
      aircraftUuid: aircraft.uuid,
      reason: changed
        ? "Migration: a counter change now overrides only the counters an administrator changed, so totals were rebuilt from the flight log."
        : "Migration: recorded which counters each earlier counter change set.",
      before: { ...readTotals(aircraft), counterEvents: events },
      after: { ...readTotals(rebuilt), counterEvents: rebuilt.counterEvents },
    },
  );
}

function readTotals(aircraft: Aircraft) {
  return Object.fromEntries(TOTAL_FIELDS.map((k) => [k, aircraft[k] ?? null]));
}

async function saveResequencedFlights(
  ctx: MutationCtx,
  aircraft: Doc<"aircraft">,
  flights: Doc<"flights">[],
  rebuilt: Flight[],
): Promise<number> {
  const changes = resequencedFlights(flights, rebuilt);
  for (const change of changes) {
    const doc = flights.find((f) => f.uuid === change.flight.uuid)!;
    await ctx.db.patch(doc._id, {
      hobbsOff: change.flight.hobbsOff,
      tachOff: change.flight.tachOff,
      cyclicHobbsOff: change.flight.cyclicHobbsOff,
      flightTimeLogOff: change.flight.flightTimeLogOff,
    });
    await audit(ctx, "system", "flight.resequenced", doc.uuid, {
      programUuid: aircraft.programUuid,
      aircraftUuid: aircraft.uuid,
      reason:
        "Migration: starting readings recalculated after rebuilding the aircraft's counter history.",
      before: change.before,
      after: change.after,
    });
  }
  return changes.length;
}
