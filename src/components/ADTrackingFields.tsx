import { useState } from "react";
import type { ADTask } from "../domain/airworthiness";
import { Field } from "./ui";

const dimensions = [
  { label: "Hours", due: "dueHours", interval: "intervalHours" },
  { label: "Calendar", due: "dueDate", interval: "intervalDays" },
  { label: "Cycles", due: "dueCycles", interval: "intervalCycles" },
  { label: "Landings", due: "dueLandings", interval: "intervalLandings" },
] as const;
export function ADTrackingFields({
  task,
  onChange,
}: {
  task: ADTask;
  onChange: (next: ADTask) => void;
}) {
  const [enabled, setEnabled] = useState(() =>
    dimensions.map(
      ({ due, interval }) =>
        (task[due] != null && task[due] !== "") || !!task[interval],
    ),
  );
  return (
    <>
      <h4>Track by</h4>
      <div className="management-actions">
        {dimensions.map(({ label, due, interval }, index) => (
          <label className="checkbox" key={label}>
            <input
              type="checkbox"
              checked={enabled[index]}
              onChange={(e) => {
                setEnabled(
                  enabled.map((value, i) =>
                    i === index ? e.target.checked : value,
                  ),
                );
                if (!e.target.checked)
                  onChange({
                    ...task,
                    [due]: due === "dueDate" ? "" : null,
                    [interval]: null,
                  });
              }}
            />
            {label}
          </label>
        ))}
      </div>
      {dimensions.map(
        ({ label, due, interval }, index) =>
          enabled[index] && (
            <fieldset key={label}>
              <legend>{label}</legend>
              {label === "Landings" && <p>Uses aircraft total landings.</p>}
              <div className="form-grid">
                <Field
                  label={`Next due ${due === "dueDate" ? "date" : label.toLowerCase()}`}
                >
                  <input
                    type={due === "dueDate" ? "date" : "number"}
                    min="0"
                    step={label === "Hours" ? "0.1" : "1"}
                    value={task[due] ?? ""}
                    onChange={(e) =>
                      onChange({
                        ...task,
                        [due]:
                          due === "dueDate"
                            ? e.target.value
                            : e.target.value === ""
                              ? null
                              : Number(e.target.value),
                      })
                    }
                  />
                </Field>
                <Field
                  label={`Repeat every ${interval === "intervalDays" ? "days" : label.toLowerCase()}`}
                >
                  <input
                    type="number"
                    min={label === "Hours" ? "0.1" : "1"}
                    step={label === "Hours" ? "0.1" : "1"}
                    value={task[interval] ?? ""}
                    onChange={(e) =>
                      onChange({
                        ...task,
                        [interval]:
                          e.target.value === "" ? null : Number(e.target.value),
                      })
                    }
                  />
                </Field>
              </div>
            </fieldset>
          ),
      )}
    </>
  );
}
