import { useState, type ReactNode } from "react";

export type ScheduleDimension = "hours" | "calendar" | "cycles" | "landings";
const labels: Record<ScheduleDimension, string> = {
  hours: "Hours",
  calendar: "Calendar",
  cycles: "Cycles",
  landings: "Landings",
};
/** Disabled fieldsets keep typed values while excluding deselected limits from FormData. */
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
        {(Object.keys(labels) as ScheduleDimension[]).map((key) => (
          <label className="checkbox" key={key}>
            <input
              type="checkbox"
              checked={enabled[key]}
              onChange={(event) =>
                setEnabled({ ...enabled, [key]: event.target.checked })
              }
            />
            {labels[key]}
          </label>
        ))}
      </div>
      {(Object.keys(labels) as ScheduleDimension[]).map((key) => (
        <fieldset key={key} hidden={!enabled[key]} disabled={!enabled[key]}>
          <legend>{labels[key]}</legend>
          <div className="form-grid">{children[key]}</div>
        </fieldset>
      ))}
    </>
  );
}
