import { internalMutation } from "./_generated/server";
import { audit } from "./access";
import { managementDocs } from "./programContext";
import { counterFields, type AircraftCounterEvent } from "../src/domain/fleet";
import { rebuildFlights, resequencedFlights } from "../src/domain/flights";
import {
  recordSchema,
  validateMaintenanceTotals,
} from "../src/domain/management";
import type { Aircraft } from "../src/domain/model";
const totals = [
  "currentHobbs",
  "currentTach",
  "currentCyclicHobbs",
  "currentFlightTimeLog",
  "cycles",
  "landings",
  "latestFlightAt",
] as const;
const counters = (a: Aircraft) =>
  Object.fromEntries(totals.map((k) => [k, a[k] ?? null]));
// `npx convex run counterEvents:recordChanges`, once after deploying the fix
// for #35. Counter events saved before it hold every counter, and flight
// reviews replayed each one as a full snapshot, dropping corrections, accepted
// held flights and rejections of earlier flights from the totals. For each
// such event this records which counters the administrator changed, taken
// from the aircraft's values in the `aircraft.updated` change-log entry that
// saved it (an event without one is worked out from the flight log, as a
// review would). Totals are then rebuilt from the flight log. Aircraft whose
// rebuild is refused (an inconsistent chronology or maintenance baseline) are
// left untouched and listed under `needsReview`. Existing change-log rows are
// never modified; every aircraft and flight it changes gets a new entry. Safe
// to rerun: aircraft whose events already record their changes are skipped.
export const recordChanges = internalMutation({
  args: {},
  handler: async (ctx) => {
    const report = {
      scanned: 0,
      recorded: 0,
      recalculated: 0,
      resequencedFlights: 0,
      derivedFromFlights: 0,
      needsReview: [] as { registration: string; reason: string }[],
    };
    for (const aircraft of await ctx.db.query("aircraft").collect()) {
      report.scanned++;
      const events = aircraft.counterEvents ?? [];
      if (!events.some((e) => !e.changed)) continue;
      const saves = (
        await ctx.db
          .query("audit")
          .withIndex("entity", (q) => q.eq("entityUuid", aircraft.uuid))
          .collect()
      )
        .filter((a) => a.action === "aircraft.updated" && a.before && a.after)
        .map((a) => ({
          before: JSON.parse(a.before!) as Aircraft,
          after: JSON.parse(a.after!) as Aircraft,
        }));
      const has = (a: Aircraft, at: string) =>
        !!a.counterEvents?.some((e) => e.at === at);
      let derived = 0;
      const explicit = events.map((e): AircraftCounterEvent => {
        if (e.changed) return e;
        const save = saves.find(
          (s) => has(s.after, e.at) && !has(s.before, e.at),
        );
        if (!save) {
          derived++;
          return e;
        }
        const changed = counterFields.filter((k) => e[k] !== save.before[k]);
        return {
          ...e,
          changed,
          previous: Object.fromEntries(
            changed
              .filter((k) => save.before[k] !== undefined)
              .map((k) => [k, save.before[k]]),
          ),
        };
      });
      const flights = await ctx.db
        .query("flights")
        .withIndex("aircraft", (q) => q.eq("aircraftUuid", aircraft.uuid))
        .collect();
      let rebuilt: ReturnType<typeof rebuildFlights>;
      try {
        rebuilt = rebuildFlights(
          { ...aircraft, counterEvents: explicit },
          flights,
        );
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
      } catch (error) {
        report.needsReview.push({
          registration: aircraft.registration,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const a = rebuilt.aircraft;
      const changed = totals.some((k) => a[k] !== aircraft[k]);
      await ctx.db.patch(aircraft._id, {
        counterEvents: a.counterEvents,
        ...(changed && {
          currentHobbs: a.currentHobbs,
          currentTach: a.currentTach,
          currentCyclicHobbs: a.currentCyclicHobbs,
          currentFlightTimeLog: a.currentFlightTimeLog,
          cycles: a.cycles,
          landings: a.landings,
          latestFlightAt: a.latestFlightAt,
          // Entries started against the old totals are held for review.
          version: aircraft.version + 1,
        }),
      });
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
          before: { ...counters(aircraft), counterEvents: events },
          after: { ...counters(a), counterEvents: a.counterEvents },
        },
      );
      for (const change of resequencedFlights(flights, rebuilt.flights)) {
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
        report.resequencedFlights++;
      }
      report.recorded++;
      if (changed) report.recalculated++;
      report.derivedFromFlights += derived;
    }
    return report;
  },
});
