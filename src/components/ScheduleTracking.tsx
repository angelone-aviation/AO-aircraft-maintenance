/**
 * Responsibility: "Track by" choice of the dimensions an inspection or
 *   component requirement is tracked by, with the limit inputs for each.
 * Layer: UI. A section of an enclosing form, which reads the inputs on submit.
 * Dependencies: react.
 */
import { useState, type ReactNode } from "react";

/** A measure an inspection or component requirement can fall due by. */
export type ScheduleDimension = "hours" | "calendar" | "cycles" | "landings";

const DIMENSION_LABELS: Record<ScheduleDimension, string> = {
  hours: "Hours",
  calendar: "Calendar",
  cycles: "Cycles",
  landings: "Landings",
};
const DIMENSIONS = Object.keys(DIMENSION_LABELS) as ScheduleDimension[];

/**
 * A checkbox per dimension and a fieldset of its limit inputs. Disabled
 * fieldsets keep typed values while excluding deselected limits from FormData.
 *
 * @param props.initial - Which dimensions are checked on first render.
 * @param props.children - The limit inputs for each dimension.
 * @returns The "Track by" heading, the checkboxes and one fieldset per
 *   dimension.
 */
export function ScheduleTracking({
  initial,
  children,
}: {
  initial: Record<ScheduleDimension, boolean>;
  children: Record<ScheduleDimension, ReactNode>;
}) {
  const [enabled, setEnabled] = useState(initial);
  return (
    <>
      <h3>Track by</h3>
      <div className="management-actions">
        {DIMENSIONS.map((key) => (
          <label className="checkbox" key={key}>
            <input
              type="checkbox"
              checked={enabled[key]}
              onChange={(event) =>
                setEnabled({ ...enabled, [key]: event.target.checked })
              }
            />
            {DIMENSION_LABELS[key]}
          </label>
        ))}
      </div>
      {DIMENSIONS.map((key) => (
        <fieldset key={key} hidden={!enabled[key]} disabled={!enabled[key]}>
          <legend>{DIMENSION_LABELS[key]}</legend>
          <div className="form-grid">{children[key]}</div>
        </fieldset>
      ))}
    </>
  );
}
