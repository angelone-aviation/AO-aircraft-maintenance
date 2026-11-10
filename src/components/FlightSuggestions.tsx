/**
 * Responsibility: The flight form's history-based helpers: the "Same as last
 *   flight" button and the place suggestions for the route fields.
 * Layer: UI. React components over the form's own fields; the picks come
 *   from the domain.
 * Dependencies: react, @phosphor-icons/react, src/domain/flightSuggestions.ts,
 *   src/domain/model.ts, ./design.tsx,
 *   src/styles/screens/flight-suggestions.css.
 *
 * The flight form's fields are uncontrolled, so the button writes the picked
 * values into the named fields of its own form, as typing would.
 */
import { useId, useState, type MouseEvent } from "react";
import { ArrowCounterClockwise } from "@phosphor-icons/react";
import {
  frequentPlaces,
  lastFlightFill,
  type LastFlightFill,
} from "../domain/flightSuggestions";
import type { Snapshot } from "../domain/model";
import { markFormFilled } from "./design";
import "../styles/screens/flight-suggestions.css";

/**
 * Fills pilot, copilot, origin and destination from the aircraft's most
 * recent visible flight. Readings, times, fuel and remarks are never touched.
 *
 * @param props.s - Snapshot holding the flights and members.
 * @param props.aircraftUuid - The aircraft chosen on the form.
 * @param props.registration - Its registration, for the description.
 * @returns Nothing when the aircraft has no previous flight.
 */
export function SameAsLastFlight({
  s,
  aircraftUuid,
  registration,
}: {
  s: Snapshot;
  aircraftUuid: string;
  registration: string;
}) {
  const hintId = useId();
  const [done, setDone] = useState(false);
  const fill = lastFlightFill(s, aircraftUuid);
  if (!fill) return null;
  const apply = (e: MouseEvent<HTMLButtonElement>) => {
    const form = e.currentTarget.form;
    if (form) fillFields(form, fill);
    // Written values fire no trusted input, so the dialog is told directly.
    markFormFilled(e.currentTarget);
    setDone(true);
  };
  return (
    <div className="flight-repeat">
      <button
        type="button"
        className="button small"
        aria-describedby={hintId}
        onClick={apply}
      >
        <ArrowCounterClockwise size={16} aria-hidden="true" /> Same as last
        flight
      </button>
      <small id={hintId} role="status">
        {done
          ? `Pilot, copilot and route filled from ${registration}'s last flight. Check them before saving.`
          : `Fills pilot, copilot and route from ${registration}'s last flight.`}
      </small>
    </div>
  );
}

/**
 * The program's most-used places as suggestions for any field naming this
 * list; free text is still accepted.
 *
 * @param props.id - The id the fields name in their `list` attribute.
 * @param props.flights - The program's visible flights.
 */
export function PlaceSuggestions({
  id,
  flights,
}: {
  id: string;
  flights: Snapshot["flights"];
}) {
  return (
    <datalist id={id}>
      {frequentPlaces(flights).map((place) => (
        <option key={place} value={place}>
          {place}
        </option>
      ))}
    </datalist>
  );
}

// A pilot who can no longer be chosen is left as the form had it; no
// copilot (or one who can no longer be chosen) selects "No copilot".
function fillFields(form: HTMLFormElement, fill: LastFlightFill) {
  if (fill.pilotId) setField(form, "pilot", fill.pilotId);
  setField(form, "copilot", fill.copilotId ?? "");
  setField(form, "origin", fill.origin);
  setField(form, "destination", fill.destination);
}

function setField(form: HTMLFormElement, name: string, value: string) {
  const field = form.elements.namedItem(name);
  if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement)
    field.value = value;
}
