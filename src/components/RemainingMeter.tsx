/**
 * Responsibility: The small "hours left" meter beside a due item's remaining
 *   amount: the share of the interval still to run, coloured by level.
 * Layer: UI. Presentational; shares and levels come from
 *   src/domain/remainingMeters.ts.
 * Dependencies: react, src/domain/remainingMeters.ts, ./remainingMeter.css.
 */
import type { ReactNode } from "react";
import type { RemainingMeter as Meter } from "../domain/remainingMeters";
import "./remainingMeter.css";

const LIMIT_NAMES: Record<Meter["dimension"], string> = {
  hours: "Hours",
  days: "Days",
  cycles: "Cycles",
  landings: "Landings",
};

/**
 * The remaining amount as text, then a meter of the share of the interval
 * left, then the word "Overdue" when the limit is overdue, so the status
 * never rests on colour. With no known interval only the text shows.
 *
 * @param props.meter - The limit, its share and level.
 * @param props.item - Names the item in the meter's accessible name, such as
 *   "100-hour inspection".
 * @param props.children - The remaining amount as the screen words it.
 */
export function RemainingMeter({
  meter,
  item,
  children,
}: {
  meter: Meter;
  item: string;
  children?: ReactNode;
}) {
  const overdue = meter.level === "overdue";
  return (
    <span className={"remaining-meter remaining-" + meter.level}>
      {children}
      {meter.share !== undefined && (
        <MeterBar meter={meter} share={meter.share} item={item} />
      )}
      {overdue && <strong className="remaining-meter-word">Overdue</strong>}
    </span>
  );
}

function MeterBar({
  meter,
  share,
  item,
}: {
  meter: Meter;
  share: number;
  item: string;
}) {
  const pct = Math.round(share * 100);
  const limit = LIMIT_NAMES[meter.dimension];
  return (
    <span
      className="remaining-meter-track"
      role="meter"
      aria-label={`${item}: ${limit.toLowerCase()} left`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={`${pct}% of the interval left`}
    >
      <span className="remaining-meter-fill" style={{ width: pct + "%" }} />
    </span>
  );
}
