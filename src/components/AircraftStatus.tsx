/**
 * Responsibility: Shows an aircraft's computed status (badge and reasons) and
 *   the dispatch gate that stops a flight on a grounded aircraft.
 * Layer: UI. React components; the status and the gate's rules come from the
 *   domain.
 * Dependencies: src/data/store.ts, src/domain/aircraftStatus.ts, ./ui.tsx,
 *   ./design.tsx.
 */
import { useWorkspace } from "../data/store";
import {
  aircraftStatus,
  aircraftStatusLabels,
  canOverrideDispatch,
  MIN_OVERRIDE_REASON,
  shownAircraftStatus,
  type ShownAircraftStatus,
  type ShownStatusLevel,
} from "../domain/aircraftStatus";
import type { Snapshot } from "../domain/model";
import { Field } from "./ui";
import { StatusPill } from "./design";
import "../styles/screens/dashboard.css";

// The same limit as dispatchGate's, which src/domain/aircraftStatus.ts does
// not export.
const OVERRIDE_REASON_MAX = 1000;

/**
 * The tone of each shown status level. Setup incomplete is never green: an
 * aircraft whose records are not all loaded must not look ready.
 */
export const STATUS_TONE = {
  airworthy: "good",
  "due-soon": "warn",
  "setup-incomplete": "warn",
  grounded: "danger",
} as const satisfies Record<ShownStatusLevel, string>;

/**
 * A pill naming the status level: Airworthy, Due soon, Setup incomplete or
 * Grounded.
 */
export function AircraftStatusBadge({
  status,
}: {
  status: ShownAircraftStatus;
}) {
  return (
    <StatusPill tone={STATUS_TONE[status.level]}>
      {aircraftStatusLabels[status.level]}
    </StatusPill>
  );
}

/**
 * The reasons behind a status, in the order the domain gives them.
 *
 * @param props.label - The list's accessible name.
 * @returns Nothing for a status without reasons.
 */
export function AircraftStatusReasons({
  status,
  label,
}: {
  status: ShownAircraftStatus;
  label: string;
}) {
  if (!status.reasons.length) return null;
  return (
    <ul className="dash-status-reasons" aria-label={label}>
      {status.reasons.map((r) => (
        <li key={r.kind + r.entityUuid + r.label}>{r.label}</li>
      ))}
    </ul>
  );
}

/**
 * Badge plus reason list, for cards, tables and details, showing the setup
 * gaps of an aircraft whose setup is incomplete.
 *
 * @throws {Error} "Aircraft not found." for an aircraft not in the snapshot.
 */
export function AircraftStatusSummary({
  aircraftUuid,
  registration,
}: {
  aircraftUuid: string;
  registration: string;
}) {
  const s = useWorkspace().snapshot!;
  const status = shownAircraftStatus(s, aircraftUuid);
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

/**
 * Tells a flight form whether the dispatch gate stops its submission.
 *
 * @param overrideReason - The administrator's reason; it counts after trimming.
 * @returns True for a grounded aircraft unless the user may override and the
 *   reason has at least {@link MIN_OVERRIDE_REASON} characters.
 * @throws {Error} "Aircraft not found." for an aircraft not in the snapshot.
 */
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

/**
 * Explains why an aircraft is grounded and, for an administrator, collects
 * the dispatch override reason; others are told to ask an administrator.
 *
 * @param props.reason - The override reason typed so far.
 * @returns Nothing unless the aircraft is grounded.
 * @throws {Error} "Aircraft not found." for an aircraft not in the snapshot.
 */
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
        <OverrideReasonField reason={reason} onReason={onReason} />
      ) : (
        <p>
          Ask a Flight Program administrator to resolve or defer these items, or
          to record a dispatch override.
        </p>
      )}
    </div>
  );
}

function OverrideReasonField({
  reason,
  onReason,
}: {
  reason: string;
  onReason: (reason: string) => void;
}) {
  return (
    <Field
      label="Administrator dispatch override reason"
      hint={`At least ${MIN_OVERRIDE_REASON} characters. Recorded on the flight and in the audit history.`}
    >
      <textarea
        rows={2}
        value={reason}
        onChange={(e) => onReason(e.target.value)}
        minLength={MIN_OVERRIDE_REASON}
        maxLength={OVERRIDE_REASON_MAX}
        required
      />
    </Field>
  );
}
