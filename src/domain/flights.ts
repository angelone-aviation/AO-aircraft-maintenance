/**
 * Responsibility: Flight rules on an aircraft's counters: the reading a flight
 *   needs, when it is held for review, how it advances the counters, and the
 *   replay of the flight history after a correction.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: src/domain/model.ts, src/domain/fleet.ts,
 *   src/domain/rejection.ts.
 */
import {
  flightInputSchema,
  aircraftMeterLabels,
  hours,
  type Aircraft,
  type Flight,
  type FlightInput,
  type EngineStart,
} from "./model";
import {
  counterFields,
  type AircraftCounterEvent,
  type CounterField,
} from "./fleet";
import { Rejection } from "./rejection";

// Device clocks run a little fast; a start this far ahead is still accepted.
const FUTURE_START_TOLERANCE_MS = 5 * 60_000;

const ISO_MINUTE_LENGTH = "YYYY-MM-DDTHH:MM".length;

const METER_INPUT_FIELD = {
  hobbs: "hobbsOn",
  tach: "tachOn",
  cyclic: "cyclicHobbsOn",
  flightTimeLog: "flightTimeLogOn",
} as const;

const METER_READING_FIELD = {
  hobbs: "currentHobbs",
  tach: "currentTach",
  cyclic: "currentCyclicHobbs",
  flightTimeLog: "currentFlightTimeLog",
} as const;

const READING_LABELS = {
  currentHobbs: "Hobbs",
  currentTach: "Tach",
  currentCyclicHobbs: aircraftMeterLabels.cyclic,
  currentFlightTimeLog: aircraftMeterLabels.flightTimeLog,
  cycles: "Cycles",
  landings: "Landings",
} as const;
type ReadingField = keyof typeof READING_LABELS;

const STARTING_READINGS = [
  "hobbsOff",
  "tachOff",
  "cyclicHobbsOff",
  "flightTimeLogOff",
] as const;
type StartingReadings = Partial<
  Record<(typeof STARTING_READINGS)[number], number | null>
>;

type ExplicitEvent = AircraftCounterEvent & { changed: CounterField[] };

/**
 * A flight's review status as Flight records writes it; the screen shows it
 * with a capital first letter.
 */
export const flightStatusLabels: Record<Flight["status"], string> = {
  accepted: "accepted",
  review: "Needs review",
  rejected: "rejected",
};

/**
 * The engine positions a flight logs starts for. Starts already recorded
 * decide, so an old log stays editable after the aircraft's profile changes;
 * otherwise a turbine twin has left and right, a turbine single one engine,
 * and any other aircraft none.
 *
 * @param aircraft - The aircraft's engine profile.
 * @param flight - The flight being edited, if any.
 * @returns ["left", "right"], ["single"] or [].
 */
export function flightEnginePositions(
  aircraft: Pick<Aircraft, "turbine" | "twin">,
  flight?: Pick<FlightInput, "engineStarts">,
): EngineStart["engine"][] {
  if (flight?.engineStarts?.length)
    return flight.engineStarts.some((s) => s.engine !== "single")
      ? ["left", "right"]
      : ["single"];
  if (!aircraft.turbine) return [];
  return aircraft.twin ? ["left", "right"] : ["single"];
}

/**
 * The meter an aircraft's hours were read from at a time: that of the latest
 * counter change at or before it; before the first change, the baseline meter
 * if one is recorded; with no changes at all, the current meter.
 *
 * @param aircraft - The aircraft, with its counter changes in time order.
 * @param time - An ISO timestamp, such as a flight's start.
 * @returns The meter.
 */
export function meterAtFlight(aircraft: Aircraft, time: string) {
  if (!aircraft.counterEvents?.length) return aircraft.meter;
  return (
    [...aircraft.counterEvents]
      .reverse()
      .find((e) => Date.parse(e.at) <= Date.parse(time))?.meter ??
    aircraft.baselineMeter ??
    aircraft.meter
  );
}

/**
 * Checks that a flight can be applied to the aircraft, against the clock.
 *
 * @param aircraft - The aircraft before the flight.
 * @param input - The flight as logged.
 * @throws {z.ZodError} When the input does not parse.
 * @throws {Error} "The <meter> reading is required for this aircraft." when
 *   it lacks the reading of the meter in use at its start ("hobbs", "tach",
 *   "Collective hourmeter" or "Flight time log"); "Flight time cannot be in the
 *   future." when it starts more than five minutes from now.
 */
export function validateFlight(aircraft: Aircraft, input: FlightInput): void {
  flightInputSchema.parse(input);
  const meter = meterAtFlight(aircraft, input.startTime);
  // Plain Errors, not Rejections: on the outbox path a Rejection would turn a
  // retried failure into a permanent one (CONTEXT.md §4).
  if (input[METER_INPUT_FIELD[meter]] === undefined)
    throw new Error(
      `The ${meter === "hobbs" || meter === "tach" ? meter : aircraftMeterLabels[meter]} reading is required for this aircraft.`,
    );
  if (Date.parse(input.startTime) > Date.now() + FUTURE_START_TOLERANCE_MS)
    throw new Error("Flight time cannot be in the future.");
}

/**
 * Why a flight cannot simply be applied and must be reviewed, checked in this
 * order: the aircraft changed since the entry began; the flight starts at or
 * before a counter change, or the latest flight; or a reading (Hobbs,
 * collective hourmeter, flight time log, tach) is below the current counter.
 *
 * @param aircraft - The aircraft as it stands.
 * @param input - The flight as logged.
 * @param baseVersion - The aircraft version the entry was started against.
 * @returns The first reason, as a sentence for the user, or undefined.
 */
export function conflictReason(
  aircraft: Aircraft,
  input: FlightInput,
  baseVersion: number,
): string | undefined {
  if (aircraft.version !== baseVersion)
    return "Aircraft totals changed after this entry was started.";
  if (
    aircraft.counterEvents?.some(
      (e) => Date.parse(input.startTime) <= Date.parse(e.at),
    )
  )
    return "Flight predates an aircraft counter change and requires chronology review.";
  if (
    aircraft.latestFlightAt &&
    Date.parse(input.startTime) <= Date.parse(aircraft.latestFlightAt)
  )
    return "Backdated or duplicate-time flight requires a chronology review.";
  if (input.hobbsOn !== undefined && input.hobbsOn < aircraft.currentHobbs)
    return "Hobbs reading is lower than the current counter.";
  if (
    input.cyclicHobbsOn !== undefined &&
    input.cyclicHobbsOn < (aircraft.currentCyclicHobbs ?? 0)
  )
    return "Collective hourmeter reading is lower than the current counter.";
  if (
    input.flightTimeLogOn !== undefined &&
    input.flightTimeLogOn < (aircraft.currentFlightTimeLog ?? 0)
  )
    return "Flight time log reading is lower than the current counter.";
  if (input.tachOn !== undefined && input.tachOn < aircraft.currentTach)
    return "Tach reading is lower than the current counter.";
}

/**
 * Advances the aircraft's counters by a flight: its readings replace the
 * current ones, its landings and cycles add on, the version goes up by one,
 * and the latest flight time becomes its start.
 *
 * @param aircraft - The aircraft before the flight.
 * @param input - The flight as logged.
 * @returns A new aircraft; the one passed in is not changed.
 */
export function applyFlight(aircraft: Aircraft, input: FlightInput): Aircraft {
  return {
    ...aircraft,
    currentHobbs: input.hobbsOn ?? aircraft.currentHobbs,
    currentTach: input.tachOn ?? aircraft.currentTach,
    currentCyclicHobbs: input.cyclicHobbsOn ?? aircraft.currentCyclicHobbs,
    currentFlightTimeLog:
      input.flightTimeLogOn ?? aircraft.currentFlightTimeLog,
    landings: aircraft.landings + input.landings,
    cycles: aircraft.cycles + input.cycles,
    version: aircraft.version + 1,
    latestFlightAt: input.startTime,
  };
}

/**
 * Rebuild all accepted flights after a correction; never silently change their
 * end readings. Flights and counter changes replay in time order from the
 * baseline, and each flight's starting readings are recalculated.
 *
 * @param aircraft - The aircraft, with its baseline and counter changes.
 * @param flights - The flight list after the correction.
 * @param stored - The list as saved before this change, used to work out what
 *   older counter events changed; the returned aircraft records that on its
 *   events, so save its `counterEvents` with the totals.
 * @returns The aircraft after the replay, one version on, and the accepted
 *   flights in time order with their starting readings.
 * @throws {Rejection} "Cannot accept this chronology: " and the reason, when
 *   a flight conflicts or the flights no longer lead to a counter change's
 *   readings.
 * @throws As {@link validateFlight}.
 */
export function rebuildFlights(
  aircraft: Aircraft,
  flights: Flight[],
  stored: Flight[] = flights,
): { aircraft: Aircraft; flights: Flight[] } {
  const events = resolveExplicitEvents(aircraft, stored);
  let current = restoreBaseline(aircraft);
  const rebuilt: Flight[] = [];
  for (const entry of orderChronologically(flights, events ?? [])) {
    if ("event" in entry) {
      current = applyCounterEvent(current, entry.event);
      continue;
    }
    const f = entry.flight;
    validateFlight(current, f);
    const conflict = conflictReason(current, f, current.version);
    if (conflict)
      throw new Rejection(`Cannot accept this chronology: ${conflict}`);
    rebuilt.push({
      ...f,
      hobbsOff: current.currentHobbs,
      tachOff: current.currentTach,
      cyclicHobbsOff: current.currentCyclicHobbs,
      flightTimeLogOff: current.currentFlightTimeLog,
    });
    current = applyFlight(current, f);
  }
  return {
    aircraft: {
      ...current,
      counterEvents: events,
      version: aircraft.version + 1,
    },
    flights: rebuilt,
  };
}

/**
 * Accepted flights other than `except` whose starting readings a rebuild
 * changed, with those readings before and after (null when unset), so each
 * change can be audited.
 *
 * @param before - The flights as stored before the rebuild.
 * @param rebuilt - The flights {@link rebuildFlights} returned.
 * @param except - A flight to leave out, such as the one being reviewed.
 * @returns The changed flights in rebuilt order, each with only the changed
 *   readings; flights missing from `before` are left out.
 */
export function resequencedFlights(
  before: Flight[],
  rebuilt: Flight[],
  except?: string,
): { flight: Flight; before: StartingReadings; after: StartingReadings }[] {
  return rebuilt.flatMap((flight) => {
    const prior = before.find((f) => f.uuid === flight.uuid);
    if (!prior || flight.uuid === except) return [];
    const changed = STARTING_READINGS.filter((k) => prior[k] !== flight[k]);
    const pick = (f: Flight) =>
      Object.fromEntries(changed.map((k) => [k, f[k] ?? null]));
    return changed.length
      ? [{ flight, before: pick(prior), after: pick(flight) }]
      : [];
  });
}

/**
 * Change-history reason for a flight resequenced by reviewing another one.
 *
 * @param before - The reviewed flight as it was.
 * @param after - The reviewed flight now.
 * @returns "Starting readings recalculated after the flight of <YYYY-MM-DD
 *   HH:MM> UTC was rejected.", or "corrected" when it had been accepted, or
 *   "accepted".
 */
export function resequenceReason(
  before: Pick<Flight, "status">,
  after: Pick<Flight, "status" | "startTime">,
): string {
  const verb =
    after.status === "rejected"
      ? "rejected"
      : before.status === "accepted"
        ? "corrected"
        : "accepted";
  return `Starting readings recalculated after the flight of ${formatUtcMinute(after.startTime)} UTC was ${verb}.`;
}

function restoreBaseline(aircraft: Aircraft): Aircraft {
  return {
    ...aircraft,
    meter: aircraft.baselineMeter ?? aircraft.meter,
    adjustmentSeconds:
      aircraft.baselineAdjustmentSeconds ?? aircraft.adjustmentSeconds,
    counterEvents: [],
    currentHobbs: aircraft.baselineHobbs,
    currentTach: aircraft.baselineTach,
    currentCyclicHobbs: aircraft.baselineCyclicHobbs,
    currentFlightTimeLog: aircraft.baselineFlightTimeLog,
    cycles: aircraft.baselineCycles,
    landings: aircraft.baselineLandings,
    latestFlightAt: undefined,
  };
}

// Accepted flights and counter events in time order; a flight at the same
// instant as an event predates it.
function orderChronologically<E extends AircraftCounterEvent>(
  flights: Flight[],
  events: E[],
) {
  return [
    ...flights
      .filter((f) => f.status === "accepted")
      .map((f) => ({ at: f.startTime, flight: f })),
    ...events.map((event) => ({ at: event.at, event })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function copyCounters(
  aircraft: Aircraft,
  event: AircraftCounterEvent,
  fields: readonly CounterField[],
): Aircraft {
  const next: Aircraft = { ...aircraft };
  for (const k of fields) Object.assign(next, { [k]: event[k] });
  return next;
}

// Events recorded before 2026-11-03 hold every counter without saying which
// ones the administrator changed. Replaying the flights as they were stored
// when the review began reproduces the counters each event replaced, so the
// differences are exactly what the administrator changed.
function resolveExplicitEvents(
  aircraft: Aircraft,
  stored: Flight[],
): ExplicitEvent[] | undefined {
  const events = aircraft.counterEvents;
  if (!events || events.every(isExplicitEvent)) return events;
  const explicit = new Map<AircraftCounterEvent, ExplicitEvent>();
  let current = restoreBaseline(aircraft);
  for (const entry of orderChronologically(stored, events)) {
    if ("flight" in entry) {
      current = applyFlight(current, entry.flight);
      continue;
    }
    const e = entry.event;
    const changed =
      e.changed ?? counterFields.filter((k) => e[k] !== current[k]);
    const previous = Object.fromEntries(
      changed
        .filter((k) => current[k] !== undefined)
        .map((k) => [k, current[k]]),
    );
    explicit.set(
      e,
      e.changed ? { ...e, changed } : { ...e, changed, previous },
    );
    current = copyCounters(current, e, changed);
  }
  return events.map((e) => explicit.get(e)!);
}

function isExplicitEvent(event: AircraftCounterEvent): event is ExplicitEvent {
  return Boolean(event.changed);
}

// An event overrides only the counters it changed, on top of the flights
// before it. Each override was based on the readings at the time, so if the
// flights before it now produce different readings, the chronology is
// inconsistent: refuse rather than drop either the flights or the override.
function applyCounterEvent(aircraft: Aircraft, event: ExplicitEvent): Aircraft {
  for (const k of listDependentReadings(event))
    if (aircraft[k] !== readRecorded(event, k))
      throw new Rejection(describeInconsistency(aircraft, event, k));
  return copyCounters(aircraft, event, event.changed);
}

// The readings the event's overrides were based on: those it changed and,
// when it changed the meter or the adjustment, the readings of the meters in
// use before and after it.
function listDependentReadings(event: ExplicitEvent): Set<ReadingField> {
  const { changed } = event;
  const depends = new Set<ReadingField>(
    changed.filter((k): k is ReadingField => k in READING_LABELS),
  );
  if (changed.includes("meter") || changed.includes("adjustmentSeconds")) {
    depends.add(
      METER_READING_FIELD[readRecorded(event, "meter") ?? event.meter],
    );
    depends.add(METER_READING_FIELD[event.meter]);
  }
  return depends;
}

// What the counter read when the event was recorded: the value it replaced if
// it changed this counter, otherwise the value it carried.
function readRecorded<K extends CounterField>(event: ExplicitEvent, k: K) {
  return event.changed.includes(k) ? event.previous?.[k] : event[k];
}

function describeInconsistency(
  aircraft: Aircraft,
  event: ExplicitEvent,
  k: ReadingField,
): string {
  const label = READING_LABELS[k];
  const recorded = formatReading(k, readRecorded(event, k));
  const what = event.changed.includes(k)
    ? `set ${label} from ${recorded} to ${formatReading(k, event[k])}`
    : `changed the time source or total time adjustment when ${label} read ${recorded}`;
  return `Cannot accept this chronology: it is inconsistent with the aircraft counter change of ${formatUtcMinute(event.at)} UTC, which ${what}; with this review the flights before that change bring ${label} to ${formatReading(k, aircraft[k])} instead. Record any correction to the counters as a new counter change on the aircraft.`;
}

function formatReading(k: ReadingField, v: number | undefined): string {
  if (v === undefined) return "unset";
  return k === "cycles" || k === "landings"
    ? v.toLocaleString("en-US")
    : hours(v);
}

function formatUtcMinute(iso: string): string {
  return iso.slice(0, ISO_MINUTE_LENGTH).replace("T", " ");
}
