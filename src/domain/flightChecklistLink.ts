/**
 * Responsibility: Checks the checklist run a flight entry links to.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: src/domain/checklists.ts, flightChecklistSchema.ts,
 *   rejection.ts; model.ts (types).
 */
import type { Snapshot, FlightInput } from "./model";
import { checklistReadable } from "./checklists";
import { checklistFlightSchema } from "./flightChecklistSchema";
import { Rejection } from "./rejection";

/**
 * Checks that a flight's linked checklist run used a checklist the user can
 * read, for this aircraft or for all aircraft, in the aircraft's Flight
 * Program, at a version no newer than the stored one. An unlinked flight
 * passes.
 *
 * @param s - The snapshot holding the checklists and aircraft.
 * @param input - The flight entry.
 * @throws {z.ZodError} When the linked run is malformed.
 * @throws {Error} "Checklist is unavailable for this aircraft or Flight
 *   Program." when any other condition fails.
 */
export function validateChecklistFlight(s: Snapshot, input: FlightInput) {
  if (!input.checklistRun) return;
  const link = checklistFlightSchema.parse(input.checklistRun);
  const record = s.checklists?.find((c) => c.uuid === link.checklistUuid);
  if (
    !record ||
    !checklistReadable(s, record) ||
    (record.aircraftUuid && record.aircraftUuid !== input.aircraftUuid) ||
    record.programUuid !==
      s.aircraft.find((a) => a.uuid === input.aircraftUuid)?.programUuid ||
    link.checklistVersion > record.version
  )
    // Not a Rejection: on the outbox path that would turn a retried failure
    // into a permanent one (CONTEXT.md §4), a change for the outbox review.
    throw new Error(
      "Checklist is unavailable for this aircraft or Flight Program.",
    );
}

/**
 * Refuses a flight review that would change the recorded checklist run: the
 * run is evidence of what the crew checked, so a correction keeps it.
 *
 * @param before - The flight as stored.
 * @param after - The flight as reviewed.
 * @throws {z.ZodError} When either run is malformed.
 * @throws {Rejection} "A review cannot change the recorded checklist run."
 *   when the parsed runs differ.
 */
export function preserveChecklistLink(before: FlightInput, after: FlightInput) {
  const normalize = (input: FlightInput) =>
    input.checklistRun
      ? JSON.stringify(checklistFlightSchema.parse(input.checklistRun))
      : undefined;
  if (normalize(before) !== normalize(after))
    throw new Rejection("A review cannot change the recorded checklist run.");
}
