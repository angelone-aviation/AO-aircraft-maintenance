/**
 * Responsibility: Conflict review: an administrator accepts or rejects a
 *   flight, with corrections, and the aircraft's totals are rebuilt from its
 *   flights.
 * Layer: Domain. Pure functions; no I/O, no React (the change-log stamp
 *   reads the clock).
 * Dependencies: ./model, ./programs, ./flights, ./changeLog,
 *   ./flightChecklistLink, ./oilInventory, ./flightPlans, ./management,
 *   ./rejection, ./fieldDiff.
 *
 * The server and the demo adapter run this one sequence; each loads the state
 * it reads and stores the changes it returns.
 */
import {
  can,
  flightInputSchema,
  hours,
  type Aircraft,
  type AuditEntry,
  type Flight,
  type FlightInput,
  type Snapshot,
} from "./model";
import { programIds, programPermission } from "./programs";
import {
  rebuildFlights,
  resequenceReason,
  resequencedFlights,
  validateFlight,
} from "./flights";
import { auditEntry, type AuditChange } from "./changeLog";
import { Rejection } from "./rejection";
import { preserveChecklistLink } from "./flightChecklistLink";
import { preserveOilInventory } from "./oilInventory";
import { validatePlanFlight } from "./flightPlans";
import { validateMaintenanceTotals } from "./management";
import { fieldDiff, type FieldDifference, type FieldSpecs } from "./fieldDiff";

/** What a held flight's review compares with the aircraft. */
interface HeldFlightFields {
  hobbs?: number;
  tach?: number;
  cyclic?: number;
  flightTimeLog?: number;
  landings?: number;
  cycles?: number;
  startTime?: string;
}

const HELD_FLIGHT_FIELDS: FieldSpecs<HeldFlightFields> = {
  hobbs: { label: "Hobbs (hours)", format: formatHours },
  tach: { label: "Tach (hours)", format: formatHours },
  cyclic: { label: "Collective hourmeter (hours)", format: formatHours },
  flightTimeLog: { label: "Flight time log (hours)", format: formatHours },
  landings: { label: "Landings", format: formatCount },
  cycles: { label: "Cycles", format: formatCount },
  startTime: { label: "Flight time (UTC)", format: formatUtcMinute },
};

/**
 * A held flight beside the aircraft as it stands, for the review: each
 * meter's closing reading against the current counter, the flight's landings
 * and cycles against the aircraft totals, and its start against the latest
 * flight. Only fields that differ are listed, in that order.
 *
 * @param flight - The held flight.
 * @param aircraft - The aircraft now.
 * @returns The differences; `mine` is the flight's value, `theirs` the
 *   aircraft's. A meter the flight did not record is left out.
 */
export function heldFlightComparison(
  flight: Flight,
  aircraft: Aircraft,
): FieldDifference[] {
  const entry: HeldFlightFields = withoutUnset({
    hobbs: flight.hobbsOn,
    tach: flight.tachOn,
    cyclic: flight.cyclicHobbsOn,
    flightTimeLog: flight.flightTimeLogOn,
    landings: flight.landings,
    cycles: flight.cycles,
    startTime: flight.startTime,
  });
  const current: HeldFlightFields = {
    hobbs: aircraft.currentHobbs,
    tach: aircraft.currentTach,
    cyclic: aircraft.currentCyclicHobbs,
    flightTimeLog: aircraft.currentFlightTimeLog,
    landings: aircraft.landings,
    cycles: aircraft.cycles,
    startTime: aircraft.latestFlightAt,
  };
  return fieldDiff(entry, current, { specs: HELD_FLIGHT_FIELDS, ignore: [] });
}

function withoutUnset(fields: HeldFlightFields): HeldFlightFields {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
}

function formatHours(value: unknown) {
  return hours(Number(value));
}

function formatCount(value: unknown) {
  return Number(value).toLocaleString("en-US");
}

// "2026-01-02T10:00:00.000Z" reads "2026-01-02 10:00".
function formatUtcMinute(value: unknown) {
  return String(value).slice(0, 16).replace("T", " ");
}

/** The fewest characters a review explanation may hold once trimmed. */
export const REVIEW_REASON_MIN_LENGTH = 5;
/** The most characters a review explanation may hold as entered. */
export const REVIEW_REASON_MAX_LENGTH = 5000;
const FLIGHT_ENTRIES = Object.keys(flightInputSchema.shape) as Array<
  keyof FlightInput
>;

/** An administrator's decision on a flight, with its corrected entries. */
export interface FlightReview {
  uuid: string;
  decision: "accept" | "reject";
  /** Why, for the change log, within {@link REVIEW_REASON_MIN_LENGTH} and
   * {@link REVIEW_REASON_MAX_LENGTH}. */
  reason: string;
  /** All of the flight's entries: one left out or undefined is cleared. */
  input: FlightInput;
}

/** The fields a review sets on the reviewed flight, a cleared entry as
 * undefined; the rest stay stored. */
export type ReviewedFields = FlightInput &
  Pick<
    Flight,
    | "status"
    | "reviewReason"
    | "hobbsOff"
    | "tachOff"
    | "cyclicHobbsOff"
    | "flightTimeLogOff"
  >;

/** What a review stores, followed by its change-log entries. */
export interface ReviewChanges {
  /** Set on the reviewed flight: its entries, decision, reason, starts. */
  reviewed: ReviewedFields;
  /** The aircraft's accepted flights in time order, starts recalculated. */
  flights: Flight[];
  /** The aircraft's totals and counter changes after the replay. */
  aircraft: Aircraft;
  /** "flight.reviewed", then "flight.resequenced" per other flight moved,
   * stamped by auditEntry (so each names the aircraft's program). */
  audit: AuditEntry[];
}

/**
 * Refuses a caller who is not an administrator of the active Flight Program
 * (a system administrator always is).
 *
 * @param s - The caller's snapshot.
 * @throws {Rejection} "Flight Program administrator required."
 */
export function assertReviewer(s: Snapshot): void {
  if (!programPermission(s, "admin"))
    throw new Rejection("Flight Program administrator required.");
}

/**
 * Accepts or rejects a flight with corrections, replays the aircraft's
 * accepted flights, and returns what to store. Nothing in `s` is changed.
 *
 * @param s - The aircraft, its flights (the reviewed one among them), the
 *   flight's plan and that plan's flights, the crew in `members`, and the
 *   aircraft's management records and inspections.
 * @param review - The flight, the decision, the reason and the corrections.
 * @returns The changes; the change log's "before" is the flight as `s` holds
 *   it.
 * @throws {Rejection} Every refusal, checking in this order: the
 *   administrator, read access to the aircraft, the reason, the flight, its
 *   checklist run, oil inventory, plan link and (accepting a rejected flight)
 *   plan, aircraft and problem report, the crew, then validateFlight, the
 *   replay and the maintenance totals, with their messages.
 * @throws {z.ZodError} When the input or a checklist run does not parse.
 */
export function reviewFlight(s: Snapshot, review: FlightReview): ReviewChanges {
  const aircraft = findReviewedAircraft(s, review.input.aircraftUuid);
  assertReason(review.reason);
  const flight = findFlight(s, review.uuid);
  assertLinksKept(s, flight, review);
  assertCrew(s, aircraft, flight, review.input);
  refuseAs(() => validateFlight(aircraft, review.input));
  const entries = listCorrectedEntries(flight, review.input);
  const next: Flight = {
    ...flight,
    ...entries,
    status: review.decision === "accept" ? "accepted" : "rejected",
    reviewReason: review.reason,
  };
  const stored = s.flights.filter((f) => f.aircraftUuid === aircraft.uuid);
  const rebuilt = replayFlights(s, aircraft, stored, next);
  const reviewed = listReviewedFields(entries, next, flight, rebuilt.flights);
  const moved = resequencedFlights(stored, rebuilt.flights, review.uuid);
  return {
    reviewed,
    flights: rebuilt.flights,
    aircraft: rebuilt.aircraft,
    audit: listReviewAudit(review, flight, { ...next, ...reviewed }, moved).map(
      (change) => auditEntry(s, change),
    ),
  };
}

function findReviewedAircraft(s: Snapshot, aircraftUuid: string): Aircraft {
  assertReviewer(s);
  const aircraft = s.aircraft.find((a) => a.uuid === aircraftUuid);
  if (!aircraft || !can(s, aircraftUuid, "read"))
    throw new Rejection("You do not have permission for this aircraft.");
  return aircraft;
}

function assertReason(reason: string) {
  if (
    reason.trim().length < REVIEW_REASON_MIN_LENGTH ||
    reason.length > REVIEW_REASON_MAX_LENGTH
  )
    throw new Rejection("Provide a meaningful review explanation.");
}

function findFlight(s: Snapshot, uuid: string): Flight {
  const flight = s.flights.find((f) => f.uuid === uuid);
  if (!flight) throw new Rejection("Flight not found.");
  return flight;
}

// A review corrects the flight's own entries; what it links to stays.
function assertLinksKept(s: Snapshot, flight: Flight, review: FlightReview) {
  const { input } = review;
  preserveChecklistLink(flight, input);
  preserveOilInventory(flight, input);
  if (input.flightPlanUuid !== flight.flightPlanUuid)
    throw new Rejection("A review cannot change the linked flight plan.");
  // Rejecting freed the plan, so accepting again needs it still free.
  if (review.decision === "accept" && flight.status === "rejected")
    validatePlanFlight(s, input);
  if (input.aircraftUuid !== flight.aircraftUuid)
    throw new Rejection("A correction cannot change aircraft.");
  // A report is never silently removed by correcting flight text.
  if (input.discrepancy !== flight.discrepancy)
    throw new Rejection(
      "Use the discrepancy workflow to update problem reports.",
    );
}

// Both crew must exist; anyone newly named must belong to the aircraft's
// program unless they are a system administrator.
function assertCrew(
  s: Snapshot,
  aircraft: Aircraft,
  flight: Flight,
  input: FlightInput,
) {
  const crew = (id: string) => s.members.find((m) => m.id === id);
  if (!crew(input.pilotId)) throw new Rejection("Pilot not found.");
  if (input.copilotId && !crew(input.copilotId))
    throw new Rejection("Copilot not found.");
  const program = aircraft.programUuid ?? "";
  for (const id of listNewCrew(flight, input)) {
    const pilot = crew(id);
    if (
      !pilot ||
      (!pilot.isAdmin && !programIds(pilot, s.groups).includes(program))
    )
      throw new Rejection("Pilot must belong to this Flight Program.");
  }
}

function listNewCrew(flight: Flight, input: FlightInput): string[] {
  const kept = (id: string) =>
    (id === input.pilotId && id === flight.pilotId) ||
    (id === input.copilotId && id === flight.copilotId);
  return [input.pilotId, input.copilotId].filter(
    (id): id is string => !!id && !kept(id),
  );
}

// The aircraft's flights replayed with the reviewed one replaced; the
// maintenance totals must still hold afterwards.
function replayFlights(
  s: Snapshot,
  aircraft: Aircraft,
  stored: Flight[],
  next: Flight,
) {
  const flights = stored.map((f) => (f.uuid === next.uuid ? next : f));
  const rebuilt = refuseAs(() => rebuildFlights(aircraft, flights, stored));
  refuseAs(() =>
    validateMaintenanceTotals(
      rebuilt.aircraft,
      s.management ?? [],
      s.inspections,
    ),
  );
  return rebuilt;
}

// validateFlight, rebuildFlights and validateMaintenanceTotals refuse with a
// plain Error, a class their other callers keep (the outbox's submission
// among them); a review shows those refusals as written. Other errors, such
// as a ZodError, stay faults.
function refuseAs<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (error instanceof Error && error.constructor === Error)
      throw new Rejection(error.message);
    throw error;
  }
}

// Convex drops a field sent as undefined, which is how FlightForm clears the
// copilot or a reading, so the server receives a cleared entry absent. Each
// stored entry the input lacks is set undefined, which the server's patch
// removes, so a review replaces the entries rather than merging them.
function listCorrectedEntries(flight: Flight, input: FlightInput): FlightInput {
  const cleared = FLIGHT_ENTRIES.filter(
    (key) => input[key] === undefined && flight[key] !== undefined,
  );
  return {
    ...input,
    ...Object.fromEntries(cleared.map((key) => [key, undefined])),
  };
}

// Starting readings come from the replay; a rejected flight, which the replay
// leaves out, keeps those it had.
function listReviewedFields(
  entries: FlightInput,
  next: Flight,
  flight: Flight,
  rebuilt: Flight[],
): ReviewedFields {
  const corrected = rebuilt.find((f) => f.uuid === next.uuid);
  return {
    ...entries,
    status: next.status,
    reviewReason: next.reviewReason,
    hobbsOff: corrected?.hobbsOff ?? flight.hobbsOff,
    tachOff: corrected?.tachOff ?? flight.tachOff,
    cyclicHobbsOff: corrected?.cyclicHobbsOff ?? flight.cyclicHobbsOff,
    flightTimeLogOff: corrected?.flightTimeLogOff ?? flight.flightTimeLogOff,
  };
}

function listReviewAudit(
  review: FlightReview,
  before: Flight,
  after: Flight,
  moved: ReturnType<typeof resequencedFlights>,
): AuditChange[] {
  return [
    {
      action: "flight.reviewed",
      entityUuid: review.uuid,
      aircraftUuid: before.aircraftUuid,
      reason: review.reason,
      before,
      after,
    },
    ...moved.map((change) => ({
      action: "flight.resequenced",
      entityUuid: change.flight.uuid,
      aircraftUuid: before.aircraftUuid,
      reason: resequenceReason(before, after),
      before: change.before,
      after: change.after,
    })),
  ];
}
