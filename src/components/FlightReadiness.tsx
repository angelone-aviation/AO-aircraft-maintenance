/**
 * Responsibility: The OK-to-fly line on an aircraft card or detail: the
 *   verdict, an icon and the one reason that matters most.
 * Layer: UI. Presentational React component; the verdict comes from the
 *   domain.
 * Dependencies: src/domain/aircraftStatus.ts, src/domain/flightReadiness.ts,
 *   ./AircraftStatus.tsx (status tones and icons).
 */
import type { ShownAircraftStatus } from "../domain/aircraftStatus";
import { flightReadiness } from "../domain/flightReadiness";
import { STATUS_ICON, STATUS_TONE } from "./AircraftStatus";
import "../styles/screens/readiness.css";

const ICON_SIZE = 18;

/**
 * Shows whether the aircraft is OK to fly, in words and an icon as well as
 * colour, with its most important reason and how many others there are.
 *
 * @param props.status - The aircraft's status from `shownAircraftStatus`.
 * @param props.stacked - Puts the reason on its own line under the verdict,
 *   for a narrow card.
 */
export function FlightReadinessLine({
  status,
  stacked = false,
}: {
  status: ShownAircraftStatus;
  stacked?: boolean;
}) {
  const r = flightReadiness(status);
  const Icon = STATUS_ICON[r.level];
  const layout = stacked ? " readiness-stacked" : "";
  return (
    <p className={`readiness readiness-${STATUS_TONE[r.level]}${layout}`}>
      <Icon size={ICON_SIZE} aria-hidden="true" />
      <strong className="readiness-verdict">
        {r.ok ? "OK to fly" : "Not OK to fly"}
      </strong>
      {r.reason && <span className="readiness-reason">{r.reason}</span>}
      {r.more > 0 && <span className="readiness-more">+{r.more} more</span>}
    </p>
  );
}
