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
export function flightEnginePositions(
  aircraft: Pick<Aircraft, "turbine" | "twin">,
  flight?: Pick<FlightInput, "engineStarts">,
): EngineStart["engine"][] {
  // Recorded engine positions keep historical logs editable after profile changes.
  if (flight?.engineStarts?.length)
    return flight.engineStarts.some((s) => s.engine !== "single")
      ? ["left", "right"]
      : ["single"];
  return aircraft.turbine
    ? aircraft.twin
      ? ["left", "right"]
      : ["single"]
    : [];
}
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
export function validateFlight(aircraft: Aircraft, input: FlightInput) {
  flightInputSchema.parse(input);
  const meter = meterAtFlight(aircraft, input.startTime);
  if (
    (meter === "flightTimeLog"
      ? input.flightTimeLogOn
      : meter === "cyclic"
        ? input.cyclicHobbsOn
        : meter === "hobbs"
          ? input.hobbsOn
          : input.tachOn) === undefined
  )
    throw new Error(
      `The ${meter === "hobbs" || meter === "tach" ? meter : aircraftMeterLabels[meter]} reading is required for this aircraft.`,
    );
  if (Date.parse(input.startTime) > Date.now() + 5 * 60_000)
    throw new Error("Flight time cannot be in the future.");
}
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
function opening(aircraft: Aircraft): Aircraft {
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
function chronology<E extends AircraftCounterEvent>(
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
type ExplicitEvent = AircraftCounterEvent & { changed: CounterField[] };
function withCounters(
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
function explicitEvents(
  aircraft: Aircraft,
  stored: Flight[],
): ExplicitEvent[] | undefined {
  const events = aircraft.counterEvents;
  if (!events?.some((e) => !e.changed)) return events as ExplicitEvent[];
  const explicit = new Map<AircraftCounterEvent, ExplicitEvent>();
  let current = opening(aircraft);
  for (const entry of chronology(stored, events)) {
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
    current = withCounters(current, e, changed);
  }
  return events.map((e) => explicit.get(e)!);
}
const meterReading = {
  hobbs: "currentHobbs",
  tach: "currentTach",
  cyclic: "currentCyclicHobbs",
  flightTimeLog: "currentFlightTimeLog",
} as const;
const readingLabels = {
  currentHobbs: "Hobbs",
  currentTach: "Tach",
  currentCyclicHobbs: aircraftMeterLabels.cyclic,
  currentFlightTimeLog: aircraftMeterLabels.flightTimeLog,
  cycles: "Cycles",
  landings: "Landings",
} as const;
type ReadingField = keyof typeof readingLabels;
const shownReading = (k: ReadingField, v: number | undefined) =>
  v === undefined
    ? "unset"
    : k === "cycles" || k === "landings"
      ? v.toLocaleString("en-US")
      : hours(v);
// An event overrides only the counters it changed, on top of the flights
// before it. Each override was based on the readings at the time, so if the
// flights before it now produce different readings, the chronology is
// inconsistent: refuse rather than drop either the flights or the override.
function applyCounterEvent(aircraft: Aircraft, event: ExplicitEvent): Aircraft {
  const { changed } = event;
  const recorded = <K extends CounterField>(k: K) =>
    changed.includes(k) ? event.previous?.[k] : event[k];
  const rebased =
    changed.includes("meter") || changed.includes("adjustmentSeconds");
  const depends = new Set<ReadingField>(
    changed.filter((k): k is ReadingField => k in readingLabels),
  );
  if (rebased) {
    depends.add(meterReading[recorded("meter") ?? event.meter]);
    depends.add(meterReading[event.meter]);
  }
  for (const k of depends)
    if (aircraft[k] !== recorded(k)) {
      const label = readingLabels[k],
        when = event.at.slice(0, 16).replace("T", " ") + " UTC";
      const what = changed.includes(k)
        ? `set ${label} from ${shownReading(k, recorded(k))} to ${shownReading(k, event[k])}`
        : `changed the time source or total time adjustment when ${label} read ${shownReading(k, recorded(k))}`;
      throw new Error(
        `Cannot accept this chronology: it is inconsistent with the aircraft counter change of ${when}, which ${what}; with this review the flights before that change bring ${label} to ${shownReading(k, aircraft[k])} instead. Record any correction to the counters as a new counter change on the aircraft.`,
      );
    }
  return withCounters(aircraft, event, changed);
}
/**
 * Rebuild all accepted flights after a correction; never silently change their
 * end readings. `stored` is the flight list as saved before this change, used
 * to work out what older counter events changed; the returned aircraft records
 * that on its events, so save its `counterEvents` with the totals.
 */
export function rebuildFlights(
  aircraft: Aircraft,
  flights: Flight[],
  stored: Flight[] = flights,
): { aircraft: Aircraft; flights: Flight[] } {
  const events = explicitEvents(aircraft, stored);
  let current = opening(aircraft);
  const rebuilt: Flight[] = [];
  for (const entry of chronology(flights, events ?? [])) {
    if ("event" in entry) {
      current = applyCounterEvent(current, entry.event);
      continue;
    }
    const f = entry.flight;
    validateFlight(current, f);
    const conflict = conflictReason(current, f, current.version);
    if (conflict) throw new Error(`Cannot accept this chronology: ${conflict}`);
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
const startingReadings = [
  "hobbsOff",
  "tachOff",
  "cyclicHobbsOff",
  "flightTimeLogOff",
] as const;
type StartingReadings = Partial<
  Record<(typeof startingReadings)[number], number | null>
>;
/**
 * Accepted flights other than `except` whose starting readings a rebuild
 * changed, with those readings before and after (null when unset), so each
 * change can be audited.
 */
export function resequencedFlights(
  before: Flight[],
  rebuilt: Flight[],
  except?: string,
): { flight: Flight; before: StartingReadings; after: StartingReadings }[] {
  return rebuilt.flatMap((flight) => {
    const prior = before.find((f) => f.uuid === flight.uuid);
    if (!prior || flight.uuid === except) return [];
    const changed = startingReadings.filter((k) => prior[k] !== flight[k]);
    const pick = (f: Flight) =>
      Object.fromEntries(changed.map((k) => [k, f[k] ?? null]));
    return changed.length
      ? [{ flight, before: pick(prior), after: pick(flight) }]
      : [];
  });
}
/** Change-history reason for a flight resequenced by reviewing another one. */
export function resequenceReason(
  before: Pick<Flight, "status">,
  after: Pick<Flight, "status" | "startTime">,
) {
  const verb =
    after.status === "rejected"
      ? "rejected"
      : before.status === "accepted"
        ? "corrected"
        : "accepted";
  const when = after.startTime.slice(0, 16).replace("T", " ");
  return `Starting readings recalculated after the flight of ${when} UTC was ${verb}.`;
}
