/**
 * Responsibility: The aircraft readings a work order is completed at: their
 *   checks against the order's opening and the aircraft's current readings,
 *   and the aircraft as it stood then.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ../model, ../workOrders (types), ../workOrderCloseoutSchema,
 *   ../rejection.
 */
import {
  aircraftMeterReading,
  isLocalToday,
  totalSeconds,
  type Aircraft,
  type Snapshot,
} from "../model";
import type { WorkOrder, WorkTask } from "../workOrders";
import {
  completionReadingsSchema,
  type CompletionReadings,
} from "../workOrderCloseoutSchema";
import { Rejection } from "../rejection";

const OPENING_READINGS = ["totalSeconds", "hobbs", "tach", "cycles"] as const;

/**
 * The readings a work order is completed at, checked.
 *
 * @param supplied - Required for a backdated order; the aircraft's current
 *   readings by default.
 * @throws {Rejection} In order: "Enter aircraft readings at completion for a
 *   backdated work order."; "Completion readings must be between the
 *   work-order opening readings and current aircraft readings."; a missing or
 *   out-of-range Collective hourmeter, then Flight time log; "Enter aircraft
 *   total landings at completion." for landing-limited work; "Completion
 *   landings must be between opening and current aircraft totals.".
 * @throws {Error} As {@link totalSeconds} when the aircraft lacks the
 *   reading its time comes from.
 * @throws {z.ZodError} On a negative or fractional reading.
 */
export function completionReadings(
  s: Snapshot,
  a: Aircraft,
  order: WorkOrder,
  supplied: CompletionReadings | undefined,
  now: number,
) {
  if (!isLocalToday(order.completionDate, now) && !supplied)
    throw new Rejection(
      "Enter aircraft readings at completion for a backdated work order.",
    );
  const readings = completionReadingsSchema.parse(
    supplied ?? {
      totalSeconds: totalSeconds(a),
      hobbs: a.currentHobbs,
      tach: a.currentTach,
      cyclicHobbs: a.currentCyclicHobbs,
      flightTimeLog: a.currentFlightTimeLog,
      cycles: a.cycles,
      landings: a.landings,
    },
  );
  assertMeterReadings(a, order, readings);
  assertLandingReadings(s, a, order, readings);
  return readings;
}

/** The aircraft with its meters and counters at the completion readings. */
export function atCompletion(
  a: Aircraft,
  readings: CompletionReadings,
): Aircraft {
  const meters = {
    currentHobbs: readings.hobbs,
    currentTach: readings.tach,
    currentCyclicHobbs: readings.cyclicHobbs,
    currentFlightTimeLog: readings.flightTimeLog,
  };
  return {
    ...a,
    ...meters,
    cycles: readings.cycles,
    landings: readings.landings ?? a.landings,
    adjustmentSeconds:
      readings.totalSeconds - aircraftMeterReading({ ...a, ...meters }),
  };
}

function assertMeterReadings(
  a: Aircraft,
  order: WorkOrder,
  readings: CompletionReadings,
) {
  const current = {
    totalSeconds: totalSeconds(a),
    hobbs: a.currentHobbs,
    tach: a.currentTach,
    cycles: a.cycles,
  };
  for (const key of OPENING_READINGS)
    if (outside(readings[key], order.aircraft[key], current[key]))
      throw new Rejection(
        "Completion readings must be between the work-order opening readings and current aircraft readings.",
      );
  assertOptionalMeters(a, order.aircraft, readings);
}

// The Collective hourmeter and Flight time log are required only when the
// aircraft's time comes from them, but are range-checked whenever entered.
function assertOptionalMeters(
  a: Aircraft,
  opening: WorkOrder["aircraft"],
  readings: CompletionReadings,
) {
  if (a.meter === "cyclic" && readings.cyclicHobbs === undefined)
    throw new Rejection(
      "Enter the Collective hourmeter reading at completion.",
    );
  if (
    readings.cyclicHobbs !== undefined &&
    outside(
      readings.cyclicHobbs,
      opening.cyclicHobbs ?? 0,
      a.currentCyclicHobbs,
    )
  )
    throw new Rejection(
      "Completion Collective hourmeter must be between opening and current readings.",
    );
  if (a.meter === "flightTimeLog" && readings.flightTimeLog === undefined)
    throw new Rejection("Enter the Flight time log reading at completion.");
  if (
    readings.flightTimeLog !== undefined &&
    outside(
      readings.flightTimeLog,
      opening.flightTimeLog ?? 0,
      a.currentFlightTimeLog,
    )
  )
    throw new Rejection(
      "Completion Flight time log must be between opening and current readings.",
    );
}

// A reading is refused below the order's opening reading, above the
// aircraft's current one, or when the aircraft has no current reading.
const outside = (value: number, opening: number, current?: number) =>
  value < opening || current === undefined || value > current;

function assertLandingReadings(
  s: Snapshot,
  a: Aircraft,
  order: WorkOrder,
  readings: CompletionReadings,
) {
  if (
    order.tasks.some((task) => hasLandingLimit(s, task)) &&
    readings.landings === undefined
  )
    throw new Rejection("Enter aircraft total landings at completion.");
  if (
    readings.landings !== undefined &&
    outside(readings.landings, order.aircraft.landings ?? 0, a.landings)
  )
    throw new Rejection(
      "Completion landings must be between opening and current aircraft totals.",
    );
}

function hasLandingLimit(s: Snapshot, task: WorkTask) {
  const r =
    task.source.kind === "inspection"
      ? s.inspections.find((i) => i.uuid === task.source.uuid)
      : s.management?.find(
          (i) =>
            i.kind === "componentRequirement" && i.uuid === task.source.uuid,
        );
  return r && "dueLandings" in r && r.dueLandings !== undefined;
}
