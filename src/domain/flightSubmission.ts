/**
 * Responsibility: Submits a flight-line entry (a flight or a problem report)
 *   from the offline outbox: its checks, its records and its change log.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ./model, ./management, ./flights, ./flightChecklistLink,
 *   ./flightPlans, ./aircraftStatus, ./oilInventory, ./programs, ./rejection,
 *   ./changeLog, ./fieldDiff (sameValue, for a resent entry).
 *
 * The server and the demo adapter run this one sequence; each loads the state
 * it reads and stores the changes it returns.
 */
import {
  flightInputSchema,
  type Aircraft,
  type AuditEntry,
  type Discrepancy,
  type Flight,
  type FlightInput,
  type Operation,
  type Snapshot,
} from "./model";
import type { Stock } from "./management";
import { applyFlight, heldReason, validateFlight } from "./flights";
import { validateChecklistFlight } from "./flightChecklistLink";
import { validatePlanFlight } from "./flightPlans";
import {
  dispatchGate,
  GROUNDED_DURING_FLIGHT,
  groundedDuringFlight,
} from "./aircraftStatus";
import { oilInventoryDeductions, oilUsageAudit } from "./oilInventory";
import { programIds } from "./programs";
import { Rejection } from "./rejection";
import { auditEntry, type AuditChange } from "./changeLog";
import { sameValue } from "./fieldDiff";

/** A refused entry, with a message the Sync center shows as written. */
export class FlightRejection extends Rejection {}

/** An outbox entry that logs a flight. */
export type FlightOperation = Extract<Operation, { kind: "flight" }>;
/** An outbox entry that files a problem report. */
export type DiscrepancyOperation = Extract<Operation, { kind: "discrepancy" }>;

/**
 * What a submission stores, in this order, followed by its change-log entries,
 * oldest first, stamped by auditEntry (so each names the aircraft's program).
 */
export interface SubmissionChanges {
  /** Oil stock drawn down on the flight line. */
  stock: { before: Stock; after: Stock }[];
  flight?: Flight;
  /** The aircraft with the flight's counters; absent while held for review. */
  aircraft?: Aircraft;
  discrepancy?: Discrepancy;
  audit: AuditEntry[];
}
/** The outcome of submitting one outbox entry. */
export interface Submission {
  /** For an entry submitted before, the status it already has. */
  status: Flight["status"];
  /** Absent for an entry submitted before: nothing is stored again. */
  changes?: SubmissionChanges;
}
/** The clock a submission is checked against. */
export interface SubmitOptions {
  now: number;
  /** The date the dispatch gate checks: the device's on the device; on the
   * server, the earliest time zone's, so it never rejects what a device
   * accepted. */
  today: string;
}

/**
 * Checks an outbox entry against the current records and returns what to
 * store. Resubmitting an entry (a retry after a lost reply) stores nothing.
 *
 * @param s - The aircraft; the flights, discrepancies, checklist and flight
 *   plan the entry refers to; the crew in `members`; and the aircraft's
 *   management, inspections, airworthiness and discrepancies for the gate.
 * @returns The entry's status, with the changes to store unless resubmitted.
 * @throws {Rejection} Every refusal a user can act on, so the server shows
 *   its reason in the Sync center: a FlightRejection for the crew, an unknown
 *   aircraft, a reused entry id, a bad flight link, the dispatch gate or the
 *   oil stock; a Rejection from the readings, checklist and flight plan
 *   checks.
 */
export function submitOperation(
  s: Snapshot,
  op: Operation,
  options: SubmitOptions,
): Submission {
  return op.kind === "flight"
    ? submitFlight(s, op, options)
    : submitDiscrepancy(s, op, options);
}

/**
 * Submits a flight. One that conflicts with the aircraft's counters, or whose
 * aircraft was grounded only by problems reported after it began, is held
 * for review (`status: "review"`, audited `flight.held`).
 *
 * @returns As {@link submitOperation}; stock, then the flight, its problem
 *   report and the audit: oil used, the flight, its problem report, then any
 *   dispatch override.
 * @throws As {@link submitOperation}, checking the checklist, the plan, the
 *   crew's program, the readings, active crew, the gate, then the oil stock.
 */
export function submitFlight(
  s: Snapshot,
  op: FlightOperation,
  { now, today }: SubmitOptions,
): Submission {
  const existing = s.flights.find((f) => f.uuid === op.uuid);
  if (existing)
    return resubmitted(existing, op, sameFlight(existing, op.input), {
      status: existing.status,
    });
  const { input } = op;
  const aircraft = s.aircraft.find((a) => a.uuid === input.aircraftUuid);
  if (!aircraft) throw new FlightRejection("Aircraft not found.");
  validateEntry(s, input, aircraft);
  const inFlight =
    op.dispatchOverrideReason === undefined &&
    groundedDuringFlight(s, aircraft.uuid, input.startTime, today);
  const dispatchOverride = inFlight
    ? undefined
    : gateDispatch(s, op, aircraft, today, now);
  const reviewReason = inFlight
    ? GROUNDED_DURING_FLIGHT
    : heldReason(aircraft, input, op.baseVersion);
  const flight = flightRecord(op, aircraft, now, {
    dispatchOverride,
    reviewReason,
  });
  const stock = drawDownOil(s, input, now);
  const report = fileFlightReport(op, aircraft, now);
  return {
    status: flight.status,
    changes: {
      stock,
      flight,
      // A held flight changes no totals until an administrator accepts it.
      aircraft: reviewReason ? undefined : applyFlight(aircraft, input),
      discrepancy: report,
      audit: listFlightAudit(op, flight, { stock, report }).map((change) =>
        auditEntry(s, change, now),
      ),
    },
  };
}

/**
 * The aircraft as the server will hold it once the user's own unsynced
 * flights on it are accepted in outbox order. A later leg logged offline
 * starts from it, so it carries the version and starting readings its
 * earlier legs will produce and is accepted after them (decision D7). An
 * earlier leg the server holds or refuses leaves the aircraft a version
 * short, so every leg chained after it is held too.
 *
 * @param s - Snapshot holding the aircraft, the signed-in user and the
 *   flights the server already has.
 * @param aircraftUuid - The aircraft.
 * @param pending - The device's outbox operations, oldest first; failed
 *   entries count, as they may still be retried.
 * @returns The stored aircraft advanced by each of the user's pending
 *   flights on it that the snapshot does not hold yet; undefined for an
 *   unknown aircraft.
 */
export function aircraftAfterPendingFlights(
  s: Snapshot,
  aircraftUuid: string,
  pending: readonly Operation[],
): Aircraft | undefined {
  const aircraft = s.aircraft.find((a) => a.uuid === aircraftUuid);
  if (!aircraft) return undefined;
  const synced = new Set(s.flights.map((f) => f.uuid));
  return pending
    .filter(
      (op): op is FlightOperation =>
        op.kind === "flight" &&
        op.authorId === s.user.id &&
        op.input.aircraftUuid === aircraftUuid &&
        !synced.has(op.uuid),
    )
    .reduce((current, op) => applyFlight(current, op.input), aircraft);
}

/**
 * Submits a problem report, optionally linked to a flight.
 *
 * @returns As {@link submitOperation}; always `status: "accepted"`.
 * @throws {FlightRejection} "Entry ID already used." for another author's
 *   id; "Linked flight does not belong to this aircraft." for a bad link.
 */
export function submitDiscrepancy(
  s: Snapshot,
  op: DiscrepancyOperation,
  { now }: SubmitOptions,
): Submission {
  const existing = s.discrepancies.find((d) => d.uuid === op.uuid);
  if (existing)
    return resubmitted(existing, op, sameReport(existing, op), {
      status: "accepted",
    });
  assertLinkedFlight(s, op);
  const report = reportRecord(op, now);
  return {
    status: "accepted",
    changes: {
      stock: [],
      discrepancy: report,
      audit: [
        auditEntry(
          s,
          {
            action: "discrepancy.created",
            entityUuid: op.uuid,
            aircraftUuid: op.aircraftUuid,
            after: report,
          },
          now,
        ),
      ],
    },
  };
}

// The `*Off` readings are where the flight started: the aircraft's current
// counters before it.
function flightRecord(
  op: FlightOperation,
  aircraft: Aircraft,
  now: number,
  outcome: Pick<Flight, "dispatchOverride" | "reviewReason">,
): Flight {
  return {
    ...op.input,
    dispatchOverride: outcome.dispatchOverride,
    uuid: op.uuid,
    authorId: op.authorId,
    submittedAt: now,
    status: outcome.reviewReason ? "review" : "accepted",
    reviewReason: outcome.reviewReason,
    hobbsOff: aircraft.currentHobbs,
    tachOff: aircraft.currentTach,
    cyclicHobbsOff: aircraft.currentCyclicHobbs,
    flightTimeLogOff: aircraft.currentFlightTimeLog,
  };
}

function reportRecord(op: DiscrepancyOperation, now: number): Discrepancy {
  return {
    uuid: op.uuid,
    aircraftUuid: op.aircraftUuid,
    flightUuid: op.flightUuid,
    description: op.description,
    grounding: op.grounding,
    status: "open",
    authorId: op.authorId,
    createdAt: now,
  };
}

// A retry after a lost reply resends the same entry, which is answered
// with its stored status. An id is never reusable by another author, and
// never with other contents: answering "accepted" would let the device drop
// an entry the server did not store.
function resubmitted(
  existing: { authorId: string },
  op: Operation,
  same: boolean,
  answer: { status: Flight["status"] },
): Submission {
  if (existing.authorId !== op.authorId)
    throw new FlightRejection("Entry ID already used.");
  if (!same)
    throw new FlightRejection(
      op.kind === "flight" ? RESENT_FLIGHT_MESSAGE : RESENT_REPORT_MESSAGE,
    );
  return answer;
}

const RESENT_FLIGHT_MESSAGE =
  "This entry was already received with different readings, which were not saved. Check the flight log, then discard this copy or log the flight again.";
const RESENT_REPORT_MESSAGE =
  "This report was already received with different details, which were not saved. Check Discrepancies, then discard this copy or report it again.";

// Compared as entered: a later correction by an administrator also makes a
// resent copy differ, and the device then shows why it was not saved.
function sameFlight(existing: Flight, input: FlightInput) {
  const keys = Object.keys(flightInputSchema.shape) as (keyof FlightInput)[];
  return keys.every((key) => sameValue(existing[key], input[key]));
}

function sameReport(existing: Discrepancy, op: DiscrepancyOperation) {
  return (
    existing.aircraftUuid === op.aircraftUuid &&
    existing.description === op.description &&
    sameValue(existing.grounding, op.grounding) &&
    sameValue(existing.flightUuid, op.flightUuid)
  );
}

function assertLinkedFlight(s: Snapshot, op: DiscrepancyOperation) {
  if (!op.flightUuid) return;
  const flight = s.flights.find((f) => f.uuid === op.flightUuid);
  if (!flight || flight.aircraftUuid !== op.aircraftUuid)
    throw new FlightRejection(
      "Linked flight does not belong to this aircraft.",
    );
}

function validateEntry(s: Snapshot, input: FlightInput, aircraft: Aircraft) {
  validateChecklistFlight(s, input);
  validatePlanFlight(s, input);
  assertCrewInProgram(s, input, aircraft);
  validateFlight(aircraft, input);
  assertActiveCrew(s, input);
}

// Re-checked at sync: offline entries were gated on a local snapshot.
function gateDispatch(
  s: Snapshot,
  op: FlightOperation,
  aircraft: Aircraft,
  today: string,
  now: number,
) {
  try {
    return dispatchGate(
      s,
      aircraft.uuid,
      op.dispatchOverrideReason,
      today,
      now,
    );
  } catch (error) {
    throw new FlightRejection(
      error instanceof Error ? error.message : "Flight dispatch rejected.",
    );
  }
}

// The pilot and copilot belong to the aircraft's Flight Program (a system
// administrator always does).
function assertCrewInProgram(s: Snapshot, input: FlightInput, a: Aircraft) {
  for (const id of [input.pilotId, input.copilotId].filter(Boolean)) {
    const pilot = s.members.find((m) => m.id === id);
    if (
      !pilot ||
      (!pilot.isAdmin &&
        !programIds(pilot, s.groups).includes(a.programUuid ?? ""))
    )
      throw new FlightRejection("Pilot must belong to this Flight Program.");
  }
}

function assertActiveCrew(s: Snapshot, input: FlightInput) {
  const active = (id: string) => s.members.find((m) => m.id === id)?.active;
  if (!active(input.pilotId))
    throw new FlightRejection("Select an active pilot.");
  if (input.copilotId && !active(input.copilotId))
    throw new FlightRejection("Select an active copilot.");
}

// Oil added from inventory. Expired, insufficient or non-oil stock refuses the
// whole entry with a message the Sync center can show. Parser and runtime
// errors (other Error subclasses) stay faults.
function drawDownOil(s: Snapshot, input: FlightInput, now: number) {
  if (!input.oil?.some((o) => o.inventory)) return [];
  try {
    return oilInventoryDeductions(s, input, now);
  } catch (error) {
    if (isStockRefusal(error)) throw new FlightRejection(error.message);
    throw error;
  }
}

function isStockRefusal(error: unknown): error is Error {
  return (
    error instanceof Rejection ||
    (error instanceof Error && error.constructor === Error)
  );
}

function fileFlightReport(
  op: FlightOperation,
  aircraft: Aircraft,
  now: number,
): Discrepancy | undefined {
  const description = op.input.discrepancy.trim();
  if (!description) return undefined;
  return {
    uuid: op.uuid + "-discrepancy",
    aircraftUuid: aircraft.uuid,
    flightUuid: op.uuid,
    description,
    status: "open",
    authorId: op.authorId,
    createdAt: now,
  };
}

// The report a flight files gets its own creation row, as one filed from
// Report a problem does, so its history starts with it.
function listFlightAudit(
  op: FlightOperation,
  flight: Flight,
  filed: { stock: SubmissionChanges["stock"]; report?: Discrepancy },
): AuditChange[] {
  const { aircraftUuid } = flight;
  return [
    ...filed.stock.map((change) => ({
      action: "stock.oil_used",
      entityUuid: change.before.uuid,
      aircraftUuid,
      reason: `Oil added for flight ${op.uuid}`,
      ...oilUsageAudit(change),
    })),
    {
      action: flight.status === "review" ? "flight.held" : "flight.created",
      entityUuid: op.uuid,
      aircraftUuid,
      after: flight,
    },
    ...optionalRows(op, flight, filed.report),
  ];
}

function optionalRows(
  op: FlightOperation,
  flight: Flight,
  report: Discrepancy | undefined,
): AuditChange[] {
  const { aircraftUuid, dispatchOverride: override } = flight;
  const rows: AuditChange[] = [];
  if (report)
    rows.push({
      action: "discrepancy.created",
      entityUuid: report.uuid,
      aircraftUuid,
      after: report,
    });
  if (override)
    rows.push({
      action: "flight.dispatch_override",
      entityUuid: op.uuid,
      aircraftUuid,
      reason: override.reason,
      after: override,
    });
  return rows;
}
