import type { Snapshot, FlightInput } from "./model";
import { checklistReadable } from "./checklists";
import { checklistFlightSchema } from "./flightChecklistSchema";
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
    throw new Error(
      "Checklist is unavailable for this aircraft or Flight Program.",
    );
}

export function preserveChecklistLink(before: FlightInput, after: FlightInput) {
  const normalize = (input: FlightInput) =>
    input.checklistRun
      ? JSON.stringify(checklistFlightSchema.parse(input.checklistRun))
      : undefined;
  if (normalize(before) !== normalize(after))
    throw new Error("A review cannot change the recorded checklist run.");
}
