/**
 * Responsibility: Building blocks of the flight forms: section labels, fields
 *   whose label may hold markup, meter readings and the live flight time.
 * Layer: UI. Presentational React components; no store or backend access.
 * Dependencies: react, @phosphor-icons/react, src/styles/screens/flight.css.
 *
 * FlightSection, MeterBox and FlightTimeStrip are candidates for promotion to
 * design.tsx.
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

const SECONDS_PER_HOUR = 3600;
const READOUT_MIN_CHARS = 3;

const cx = (...c: (string | false | null | undefined)[]) =>
  c.filter(Boolean).join(" ");

type Labelled = { id?: string; "aria-describedby"?: string };

type MeterBoxProps = {
  startLabel: string;
  startSrSuffix?: string;
  startValue: string;
  startInput?: boolean;
  describedBy?: string;
  endLabel?: string;
  endSrSuffix?: string;
  endInput?: ReactElement<Labelled>;
  hint?: ReactNode;
};

type MeterStartProps = Pick<
  MeterBoxProps,
  "startLabel" | "startSrSuffix" | "startValue" | "describedBy"
>;

/**
 * A titled form section with an optional hint beside the title.
 *
 * @param props.hintId - Id of the hint, for inputs to name in aria-describedby.
 * @param props.label - Accessible name; when set, the section is a region.
 * @returns A `section.flight-section` headed by an h3.
 */
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

/**
 * A `.field` whose label may hold markup (icons, visually hidden units). Like
 * ui.tsx `Field`, it clones a single element child with the label's id and
 * points its aria-describedby at the hint; any other child renders as is.
 *
 * @param props.wide - Spans the full row of the flight grid.
 * @returns The field wrapper with its label, control and hint.
 */
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

/**
 * One meter's reading: the start, then an arrow and the ending input when
 * `endInput` is given, or the start alone.
 *
 * @param props.startValue - Hours with one decimal; "Unknown" drops the h unit.
 * @param props.startInput - A labelled read-only input (default) or plain text.
 * @param props.describedBy - Id the start input names in aria-describedby.
 * @param props.endInput - Cloned with its label's id and the hint's
 *   aria-describedby.
 * @returns A `.flight-meter`, with the `start-only` class when no end is given.
 */
export function MeterBox({
  startInput = true,
  endLabel,
  endSrSuffix,
  endInput,
  hint,
  ...start
}: MeterBoxProps) {
  const id = useId();
  const hintId = hint ? id + "-hint" : undefined;
  return (
    <div className={cx("flight-meter", !endInput && "start-only")}>
      <div className="flight-meter-start">
        {startInput ? (
          <MeterStartInput id={id + "-start"} {...start} />
        ) : (
          <MeterStartText {...start} />
        )}
      </div>
      {endInput && (
        <MeterEnd
          id={id + "-end"}
          label={<LabelText text={endLabel ?? ""} srSuffix={endSrSuffix} />}
          input={endInput}
          hintId={hintId}
        />
      )}
      {hint && (
        <small className="flight-meter-hint" id={hintId}>
          {hint}
        </small>
      )}
    </div>
  );
}

/**
 * Live difference between the starting reading and the ending hours typed so
 * far. Display only: it does not validate the record.
 *
 * @param props.meterLabel - Meter the difference is measured on, e.g. "Hobbs".
 * @param props.entryName - Name in the prompt: "Enter ending Hobbs".
 * @param props.startSeconds - Starting reading in seconds, if known.
 * @param props.endHours - The ending reading as typed, in hours.
 * @returns A polite live region in the `neutral`, `good` or `danger` state;
 *   `danger` when the end is before the start.
 */
export function FlightTimeStrip({
  meterLabel,
  entryName,
  startSeconds,
  endHours,
}: {
  meterLabel: string;
  entryName: string;
  startSeconds: number | undefined;
  endHours: string;
}) {
  const { state, text } = readFlightTime(entryName, startSeconds, endHours);
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

/** Visible text plus a suffix only screen readers hear (e.g. " (hours)"). */
function LabelText({ text, srSuffix }: { text: string; srSuffix?: string }) {
  return (
    <>
      {text}
      {srSuffix && <span className="flight-sr-only">{srSuffix}</span>}
    </>
  );
}

function MeterStartInput({
  id,
  startLabel,
  startSrSuffix,
  startValue,
  describedBy,
}: MeterStartProps & { id: string }) {
  return (
    <>
      <label htmlFor={id} className="flight-meter-label">
        <LabelText text={startLabel} srSuffix={startSrSuffix} />
      </label>
      <span className="flight-meter-readout">
        <input
          id={id}
          readOnly
          value={startValue}
          size={Math.max(startValue.length, READOUT_MIN_CHARS)}
          aria-describedby={describedBy}
        />
        {startValue !== "Unknown" && (
          <span className="flight-meter-unit" aria-hidden="true">
            h
          </span>
        )}
      </span>
    </>
  );
}

function MeterStartText({ startLabel, startValue }: MeterStartProps) {
  return (
    <>
      <span className="flight-meter-label">{startLabel}</span>
      <span className="flight-meter-readout">
        <strong>{startValue}</strong>
        {startValue !== "Unknown" && (
          <span className="flight-meter-unit">h</span>
        )}
      </span>
    </>
  );
}

function MeterEnd({
  id,
  label,
  input,
  hintId,
}: {
  id: string;
  label: ReactNode;
  input: ReactElement<Labelled>;
  hintId: string | undefined;
}) {
  return (
    <>
      <span className="flight-meter-arrow" aria-hidden="true">
        <ArrowRight size={18} />
      </span>
      <div className="flight-meter-end">
        <label htmlFor={id} className="flight-meter-label">
          {label}
        </label>
        {cloneElement(input, { id, "aria-describedby": hintId })}
      </div>
    </>
  );
}

function readFlightTime(
  entryName: string,
  startSeconds: number | undefined,
  endHours: string,
): { state: "neutral" | "good" | "danger"; text: string } {
  const typed = endHours.trim() !== "" && Number.isFinite(Number(endHours));
  if (!typed) return { state: "neutral", text: `Enter ending ${entryName}` };
  if (startSeconds === undefined)
    return { state: "neutral", text: "Starting reading unknown" };
  const delta = Math.round(Number(endHours) * SECONDS_PER_HOUR) - startSeconds;
  if (delta < 0) return { state: "danger", text: "Ending is before start" };
  return { state: "good", text: `${(delta / SECONDS_PER_HOUR).toFixed(1)} h` };
}
