/**
 * Responsibility: The "Track by" fields of an AD task: the limits it is
 *   tracked by, each with its next due point and repeat interval.
 * Layer: UI. Changes go back through `onChange`.
 * Dependencies: react, src/domain/airworthiness.ts (ADTask type),
 *   src/components/ui.tsx.
 */
import { useState } from "react";
import type { ADTask } from "../domain/airworthiness";
import { Field } from "./ui";

// In display order, each with the ADTask fields that hold its values.
const DIMENSIONS = [
  { label: "Hours", due: "dueHours", interval: "intervalHours" },
  { label: "Calendar", due: "dueDate", interval: "intervalDays" },
  { label: "Cycles", due: "dueCycles", interval: "intervalCycles" },
  { label: "Landings", due: "dueLandings", interval: "intervalLandings" },
] as const;

type Dimension = (typeof DIMENSIONS)[number];
type FieldsProps = { task: ADTask; onChange: (next: ADTask) => void };
type DimensionProps = FieldsProps & { dimension: Dimension };

/**
 * Checkboxes choosing the limits an AD task is tracked by, then the next due
 * point and repeat interval of each chosen limit. Clearing a box clears that
 * limit's values.
 *
 * @param props.task - The AD task; a limit starts checked when it has a due
 *   point or an interval.
 * @param props.onChange - Called with the whole task after each change.
 * @returns The fields.
 */
export function ADTrackingFields({ task, onChange }: FieldsProps) {
  const [enabled, setEnabled] = useState(() =>
    DIMENSIONS.map((dimension) => isTracked(task, dimension)),
  );
  const toggle = (index: number, checked: boolean) => {
    setEnabled(enabled.map((value, i) => (i === index ? checked : value)));
    if (!checked) onChange(withoutDimension(task, DIMENSIONS[index]));
  };
  return (
    <>
      <h4>Track by</h4>
      <div className="management-actions">
        {DIMENSIONS.map(({ label }, index) => (
          <label className="checkbox" key={label}>
            <input
              type="checkbox"
              checked={enabled[index]}
              onChange={(e) => toggle(index, e.target.checked)}
            />
            {label}
          </label>
        ))}
      </div>
      {DIMENSIONS.map(
        (dimension, index) =>
          enabled[index] && (
            <DimensionFields
              key={dimension.label}
              dimension={dimension}
              task={task}
              onChange={onChange}
            />
          ),
      )}
    </>
  );
}

function DimensionFields(props: DimensionProps) {
  const { label } = props.dimension;
  return (
    <fieldset>
      <legend>{label}</legend>
      {label === "Landings" && <p>Uses aircraft total landings.</p>}
      <div className="form-grid">
        <DueField {...props} />
        <IntervalField {...props} />
      </div>
    </fieldset>
  );
}

function DueField({ dimension, task, onChange }: DimensionProps) {
  const { label, due } = dimension;
  const isDate = due === "dueDate";
  return (
    <Field label={`Next due ${isDate ? "date" : label.toLowerCase()}`}>
      <input
        type={isDate ? "date" : "number"}
        min="0"
        step={stepFor(dimension)}
        value={task[due] ?? ""}
        onChange={(e) =>
          onChange({
            ...task,
            [due]: isDate ? e.target.value : parseCount(e.target.value),
          })
        }
      />
    </Field>
  );
}

function IntervalField({ dimension, task, onChange }: DimensionProps) {
  const { label, interval } = dimension;
  const step = stepFor(dimension);
  return (
    <Field
      label={`Repeat every ${interval === "intervalDays" ? "days" : label.toLowerCase()}`}
    >
      <input
        type="number"
        min={step}
        step={step}
        value={task[interval] ?? ""}
        onChange={(e) =>
          onChange({ ...task, [interval]: parseCount(e.target.value) })
        }
      />
    </Field>
  );
}

// Hour meters read to a tenth; the other limits count whole units.
function stepFor({ label }: Dimension): string {
  return label === "Hours" ? "0.1" : "1";
}

function isTracked(task: ADTask, { due, interval }: Dimension): boolean {
  return (task[due] != null && task[due] !== "") || !!task[interval];
}

function withoutDimension(task: ADTask, { due, interval }: Dimension): ADTask {
  return {
    ...task,
    [due]: due === "dueDate" ? "" : null,
    [interval]: null,
  };
}

function parseCount(text: string): number | null {
  return text === "" ? null : Number(text);
}
