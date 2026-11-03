// Submitting a flight-line entry (a flight or a problem report) from the
// outbox. The Convex `operations.submit` mutation and the demo adapter both run
// this; each loads the state it reads and stores the changes it returns.
import type {
  Aircraft,
  Discrepancy,
  Flight,
  FlightInput,
  Operation,
  Snapshot,
} from "./model";
import type { Stock } from "./management";
import { applyFlight, conflictReason, validateFlight } from "./flights";
import { validateChecklistFlight } from "./flightChecklistLink";
import { validatePlanFlight } from "./flightPlans";
import { dispatchGate } from "./aircraftStatus";
import { oilInventoryDeductions, oilUsageAudit } from "./oilInventory";
import { programIds } from "./programs";

/**
 * A refusal the Sync center shows as written: the server keeps its message
 * through production error redaction.
 */
export class FlightRejection extends Error {}

export type FlightOperation = Extract<Operation, { kind: "flight" }>;
export type DiscrepancyOperation = Extract<Operation, { kind: "discrepancy" }>;

/** A change-log entry to write with the submission; values are not yet JSON. */
export interface SubmissionAudit {
  action: string;
  entityUuid: string;
  programUuid?: string;
  aircraftUuid?: string;
  reason?: string;
  before?: unknown;
  after?: unknown;
}
/** What a submission stores, in this order, followed by its audit entries. */
export interface SubmissionChanges {
  /** Oil stock drawn down on the flight line. */
  stock: { before: Stock; after: Stock }[];
  flight?: Flight;
  /** The aircraft with the flight's counters; absent while held for review. */
  aircraft?: Aircraft;
  discrepancy?: Discrepancy;
  audit: SubmissionAudit[];
}
export interface Submission {
  /** For an entry submitted before, the status it already has. */
  status: Flight["status"];
  /** Absent for an entry submitted before: nothing is stored again. */
  changes?: SubmissionChanges;
}
export interface SubmitOptions {
  now: number;
  /** The date the dispatch gate checks: the device's on the device; on the
   * server, the earliest time zone's, so it never rejects what a device
   * accepted. */
  today: string;
}

/**
 * Reads from `s`: the aircraft; the flights, discrepancies, checklist and
 * flight plan the entry refers to; the pilot and copilot in `members`; and the
 * aircraft's airworthiness state (management, inspections, airworthiness,
 * discrepancies) for the dispatch gate. Throws when the entry is refused.
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

// A resubmitted entry (a retry after a lost reply) reports its status again.
// Its id is never reusable by another author.
function resubmitted(existing: { authorId: string }, authorId: string) {
  if (existing.authorId !== authorId) throw new Error("Entry ID already used.");
}

export function submitFlight(
  s: Snapshot,
  op: FlightOperation,
  { now, today }: SubmitOptions,
): Submission {
  const existing = s.flights.find((f) => f.uuid === op.uuid);
  if (existing) {
    resubmitted(existing, op.authorId);
    return { status: existing.status };
  }
  const { input } = op;
  const aircraft = s.aircraft.find((a) => a.uuid === input.aircraftUuid);
  if (!aircraft) throw new Error("Aircraft not found.");
  validateChecklistFlight(s, input);
  validatePlanFlight(s, input);
  assertCrewInProgram(s, input, aircraft);
  validateFlight(aircraft, input);
  assertActiveCrew(s, input);
  let dispatchOverride;
  try {
    // Re-checked at sync: offline entries were gated on a local snapshot.
    dispatchOverride = dispatchGate(
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
  const reviewReason = conflictReason(aircraft, input, op.baseVersion);
  const flight: Flight = {
    ...input,
    dispatchOverride,
    uuid: op.uuid,
    authorId: op.authorId,
    submittedAt: now,
    status: reviewReason ? "review" : "accepted",
    reviewReason,
    hobbsOff: aircraft.currentHobbs,
    tachOff: aircraft.currentTach,
    cyclicHobbsOff: aircraft.currentCyclicHobbs,
    flightTimeLogOff: aircraft.currentFlightTimeLog,
  };
  const stock = oilDrawdown(s, input, now);
  const description = input.discrepancy.trim();
  return {
    status: flight.status,
    changes: {
      stock,
      flight,
      // A held flight changes no totals until an administrator accepts it.
      aircraft: reviewReason ? undefined : applyFlight(aircraft, input),
      discrepancy: description
        ? {
            uuid: op.uuid + "-discrepancy",
            aircraftUuid: aircraft.uuid,
            flightUuid: op.uuid,
            description,
            status: "open",
            authorId: op.authorId,
            createdAt: now,
          }
        : undefined,
      audit: [
        ...stock.map((change) => ({
          action: "stock.oil_used",
          entityUuid: change.before.uuid,
          programUuid: op.programUuid,
          aircraftUuid: aircraft.uuid,
          reason: `Oil added for flight ${op.uuid}`,
          ...oilUsageAudit(change),
        })),
        {
          action: reviewReason ? "flight.held" : "flight.created",
          entityUuid: op.uuid,
          aircraftUuid: aircraft.uuid,
          after: flight,
        },
        ...(dispatchOverride
          ? [
              {
                action: "flight.dispatch_override",
                entityUuid: op.uuid,
                programUuid: op.programUuid,
                aircraftUuid: aircraft.uuid,
                reason: dispatchOverride.reason,
                after: dispatchOverride,
              },
            ]
          : []),
      ],
    },
  };
}

export function submitDiscrepancy(
  s: Snapshot,
  op: DiscrepancyOperation,
  { now }: SubmitOptions,
): Submission {
  const existing = s.discrepancies.find((d) => d.uuid === op.uuid);
  if (existing) {
    resubmitted(existing, op.authorId);
    return { status: "accepted" };
  }
  if (op.flightUuid) {
    const flight = s.flights.find((f) => f.uuid === op.flightUuid);
    if (!flight || flight.aircraftUuid !== op.aircraftUuid)
      throw new Error("Linked flight does not belong to this aircraft.");
  }
  const report: Discrepancy = {
    uuid: op.uuid,
    aircraftUuid: op.aircraftUuid,
    flightUuid: op.flightUuid,
    description: op.description,
    grounding: op.grounding,
    status: "open",
    authorId: op.authorId,
    createdAt: now,
  };
  return {
    status: "accepted",
    changes: {
      stock: [],
      discrepancy: report,
      audit: [
        {
          action: "discrepancy.created",
          entityUuid: op.uuid,
          aircraftUuid: op.aircraftUuid,
          after: report,
        },
      ],
    },
  };
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
      throw new Error("Pilot must belong to this Flight Program.");
  }
}
function assertActiveCrew(s: Snapshot, input: FlightInput) {
  const active = (id: string) => s.members.find((m) => m.id === id)?.active;
  if (!active(input.pilotId)) throw new Error("Select an active pilot.");
  if (input.copilotId && !active(input.copilotId))
    throw new Error("Select an active copilot.");
}
// Oil added from inventory. Expired, insufficient or non-oil stock refuses the
// whole entry with a message the Sync center can show.
function oilDrawdown(s: Snapshot, input: FlightInput, now: number) {
  if (!input.oil?.some((o) => o.inventory)) return [];
  try {
    return oilInventoryDeductions(s, input, now);
  } catch (error) {
    if (error instanceof Error && error.constructor === Error)
      throw new FlightRejection(error.message);
    throw error;
  }
}
