import { useWorkspace } from "../data/store";
import {
  aircraftStatus,
  canOverrideDispatch,
  MIN_OVERRIDE_REASON,
  type AircraftStatus,
} from "../domain/aircraftStatus";
import type { Snapshot } from "../domain/model";
import { Field } from "./ui";
import { StatusPill } from "./design";
import "../styles/screens/dashboard.css";

const tones = {
  airworthy: "good",
  "due-soon": "warn",
  grounded: "danger",
} as const;
const labels = {
  airworthy: "Airworthy",
  "due-soon": "Due soon",
  grounded: "Grounded",
};
export function AircraftStatusBadge({ status }: { status: AircraftStatus }) {
  return (
    <StatusPill tone={tones[status.level]}>{labels[status.level]}</StatusPill>
  );
}
export function AircraftStatusReasons({
  status,
  label,
}: {
  status: AircraftStatus;
  label: string;
}) {
  if (!status.reasons.length) return null;
  return (
    <ul className="dash-status-reasons" aria-label={label}>
      {status.reasons.map((r) => (
        <li key={r.kind + r.entityUuid}>{r.label}</li>
      ))}
    </ul>
  );
}
/** Badge plus reason list, for cards, tables and details. */
export function AircraftStatusSummary({
  aircraftUuid,
  registration,
}: {
  aircraftUuid: string;
  registration: string;
}) {
  const s = useWorkspace().snapshot!;
  const status = aircraftStatus(s, aircraftUuid);
  return (
    <div className="dash-status-summary">
      <AircraftStatusBadge status={status} />
      <AircraftStatusReasons
        status={status}
        label={`${registration} status reasons`}
      />
    </div>
  );
}
export function dispatchBlocked(
  s: Snapshot,
  aircraftUuid: string,
  overrideReason: string,
) {
  return (
    aircraftStatus(s, aircraftUuid).level === "grounded" &&
    (!canOverrideDispatch(s) ||
      overrideReason.trim().length < MIN_OVERRIDE_REASON)
  );
}
/** Explains a grounded aircraft and collects an administrator override. */
export function DispatchGate({
  aircraftUuid,
  reason,
  onReason,
}: {
  aircraftUuid: string;
  reason: string;
  onReason: (reason: string) => void;
}) {
  const s = useWorkspace().snapshot!;
  const status = aircraftStatus(s, aircraftUuid);
  if (status.level !== "grounded") return null;
  const registration =
    s.aircraft.find((a) => a.uuid === aircraftUuid)?.registration ??
    "This aircraft";
  return (
    <div className="error dispatch-gate dash-dispatch-gate" role="alert">
      <p>
        <strong>{registration} is grounded.</strong> Flights cannot be logged
        until these items are resolved or deferred:
      </p>
      <AircraftStatusReasons
        status={status}
        label={`${registration} grounding reasons`}
      />
      {canOverrideDispatch(s) ? (
        <Field
          label="Administrator dispatch override reason"
          hint={`At least ${MIN_OVERRIDE_REASON} characters. Recorded on the flight and in the audit history.`}
        >
          <textarea
            rows={2}
            value={reason}
            onChange={(e) => onReason(e.target.value)}
            minLength={MIN_OVERRIDE_REASON}
            maxLength={1000}
            required
          />
        </Field>
      ) : (
        <p>
          Ask a Flight Program administrator to resolve or defer these items, or
          to record a dispatch override.
        </p>
      )}
    </div>
  );
}
