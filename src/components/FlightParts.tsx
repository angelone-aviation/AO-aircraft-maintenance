/**
 * Flight form building blocks (UI redesign v2), shared by the flight form,
 * fuel/oil fields, guided flight and the start/end flight session.
 *
 * <FlightSection title hint? hintId? label?> uppercase 12px section label with
 *   an optional right-aligned hint; `label` names the section as a region.
 * <FlightField label hint? wide? className?> a `.field` whose label may hold
 *   markup (icons, visually hidden units). Clones its single child with the
 *   label's id and the hint's aria-describedby, like ui.tsx `Field`.
 * <MeterBox …> one meter: read-only start → ending input (or start only).
 * <FlightTimeStrip …> live "Flight time" difference with neutral / good /
 *   danger states.
 * Candidates for promotion to design.tsx: FlightSection (form section label),
 * MeterBox and FlightTimeStrip.
 */
import {
  cloneElement,
  isValidElement,
  useId,
  type ReactElement,
  type ReactNode,
} from "react";
import { ArrowRight, Info, Timer } from "@phosphor-icons/react";
import "../styles/screens/flight.css";

const cx = (...c: (string | false | null | undefined)[]) =>
  c.filter(Boolean).join(" ");

type Labelled = { id?: string; "aria-describedby"?: string };

export function FlightSection({
  title,
  hint,
  hintId,
  label,
  className,
  children,
}: {
  title: ReactNode;
  hint?: ReactNode;
  hintId?: string;
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cx("flight-section", className)} aria-label={label}>
      <div className="flight-section-head">
        <h3 className="flight-section-title">{title}</h3>
        {hint && (
          <span className="flight-section-hint" id={hintId}>
            <Info size={15} aria-hidden="true" />
            {hint}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

export function FlightField({
  label,
  hint,
  wide = false,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  wide?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className={cx("field flight-field", wide && "flight-wide", className)}>
      <label htmlFor={id}>{label}</label>
      {isValidElement<Labelled>(children)
        ? cloneElement(children, {
            id,
            "aria-describedby": hint ? id + "-hint" : undefined,
          })
        : children}
      {hint && <small id={id + "-hint"}>{hint}</small>}
    </div>
  );
}

/** Visible text plus a suffix only screen readers hear (e.g. " (hours)"). */
function LabelText({ text, srSuffix }: { text: string; srSuffix?: string }) {
  return (
    <>
      {text}
      {srSuffix && <span className="flight-sr-only">{srSuffix}</span>}
    </>
  );
}

export function MeterBox({
  startLabel,
  startSrSuffix,
  startValue,
  startInput = true,
  describedBy,
  endLabel,
  endSrSuffix,
  endInput,
  hint,
}: {
  startLabel: string;
  startSrSuffix?: string;
  /** Hours with one decimal, or "Unknown". */
  startValue: string;
  /** Render the start as a read-only input (labelled) or as plain text. */
  startInput?: boolean;
  describedBy?: string;
  endLabel?: string;
  endSrSuffix?: string;
  endInput?: ReactElement<Labelled>;
  hint?: ReactNode;
}) {
  const id = useId();
  const known = startValue !== "Unknown";
  return (
    <div className={cx("flight-meter", !endInput && "start-only")}>
      <div className="flight-meter-start">
        {startInput ? (
          <>
            <label htmlFor={id + "-start"} className="flight-meter-label">
              <LabelText text={startLabel} srSuffix={startSrSuffix} />
            </label>
            <span className="flight-meter-readout">
              <input
                id={id + "-start"}
                readOnly
                value={startValue}
                size={Math.max(startValue.length, 3)}
                aria-describedby={describedBy}
              />
              {known && (
                <span className="flight-meter-unit" aria-hidden="true">
                  h
                </span>
              )}
            </span>
          </>
        ) : (
          <>
            <span className="flight-meter-label">{startLabel}</span>
            <span className="flight-meter-readout">
              <strong>{startValue}</strong>
              {known && <span className="flight-meter-unit">h</span>}
            </span>
          </>
        )}
      </div>
      {endInput && (
        <>
          <span className="flight-meter-arrow" aria-hidden="true">
            <ArrowRight size={18} />
          </span>
          <div className="flight-meter-end">
            <label htmlFor={id + "-end"} className="flight-meter-label">
              <LabelText text={endLabel ?? ""} srSuffix={endSrSuffix} />
            </label>
            {cloneElement(endInput, {
              id: id + "-end",
              "aria-describedby": hint ? id + "-hint" : undefined,
            })}
          </div>
        </>
      )}
      {hint && (
        <small className="flight-meter-hint" id={id + "-hint"}>
          {hint}
        </small>
      )}
    </div>
  );
}

/**
 * Live difference between a starting reading (seconds) and the ending hours
 * typed so far. Display only: the record's validation is unchanged.
 */
export function FlightTimeStrip({
  meterLabel,
  entryName,
  startSeconds,
  endHours,
}: {
  /** Meter the difference is measured on, e.g. "Hobbs". */
  meterLabel: string;
  /** Lower-case name used in the prompt: "Enter ending Hobbs". */
  entryName: string;
  startSeconds: number | undefined;
  endHours: string;
}) {
  const typed = endHours.trim() !== "" && Number.isFinite(Number(endHours));
  const delta =
    typed && startSeconds !== undefined
      ? Math.round(Number(endHours) * 3600) - startSeconds
      : undefined;
  const state = delta === undefined ? "neutral" : delta < 0 ? "danger" : "good";
  const text = !typed
    ? `Enter ending ${entryName}`
    : startSeconds === undefined
      ? "Starting reading unknown"
      : delta! < 0
        ? "Ending is before start"
        : `${(delta! / 3600).toFixed(1)} h`;
  return (
    <div className={"flight-delta " + state} aria-live="polite">
      <span className="flight-delta-label">
        <Timer size={16} aria-hidden="true" />
        Flight time
        <span className="flight-delta-meter">· {meterLabel}</span>
      </span>
      <strong>{text}</strong>
    </div>
  );
}
