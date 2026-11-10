/**
 * Responsibility: The OK-to-fly line at the top of an aircraft card or
 *   detail: the verdict, an icon and the one reason that matters most.
 * Layer: UI. Presentational React component; the verdict comes from the
 *   domain.
 * Dependencies: @phosphor-icons/react, src/domain/aircraftStatus.ts,
 *   src/domain/flightReadiness.ts, ./design.tsx.
 */
import { CheckCircle, WarningCircle, XCircle } from "@phosphor-icons/react";
import type { ShownAircraftStatus } from "../domain/aircraftStatus";
import { flightReadiness } from "../domain/flightReadiness";
import { NoticeBar } from "./design";
import "../styles/screens/readiness.css";

const LOOK = {
  airworthy: { tone: "good", icon: CheckCircle },
  "due-soon": { tone: "warn", icon: WarningCircle },
  "setup-incomplete": { tone: "warn", icon: WarningCircle },
  grounded: { tone: "danger", icon: XCircle },
} as const;

/**
 * Shows whether the aircraft is OK to fly, in words and an icon as well as
 * colour, with its most important reason and how many others there are.
 *
 * @param props.status - The aircraft's status from `shownAircraftStatus`.
 * @param props.className - Placement class from the screen.
 */
export function FlightReadinessLine({
  status,
  className,
}: {
  status: ShownAircraftStatus;
  className?: string;
}) {
  const r = flightReadiness(status);
  const look = LOOK[r.level];
  return (
    <NoticeBar
      tone={look.tone}
      icon={look.icon}
      className={"readiness " + (className ?? "")}
    >
      <strong className="readiness-verdict">
        {r.ok ? "OK to fly" : "Not OK to fly"}
      </strong>
      {r.reason && <span className="readiness-reason">{r.reason}</span>}
      {r.more > 0 && <span className="readiness-more">+{r.more} more</span>}
    </NoticeBar>
  );
}
