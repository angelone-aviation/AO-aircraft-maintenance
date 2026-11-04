/**
 * Responsibility: The calendar exemption fields of the inspection form, and
 *   who last changed the exemption.
 * Layer: UI. React component; the rule that an exemption needs a reason is
 *   enforced again by src/domain/management.ts on save.
 * Dependencies: src/domain/model.ts (types), ./ui.tsx.
 */
import { useState } from "react";
import type { Inspection, Snapshot } from "../domain/model";
import { Field } from "./ui";

// The limit inspectionSchema sets on calendarExemptReason.
const EXEMPT_REASON_MAX_LENGTH = 5000;

type ExemptionProps = { record?: Inspection; members: Snapshot["members"] };

/**
 * The "Calendar exempt" checkbox and its reason, for an inspection form; the
 * reason is required while the box is checked.
 *
 * @param props.record - The inspection being edited; absent for a new one.
 * @param props.members - Resolves who last changed the exemption; an unknown
 *   id shows as itself.
 */
export function CalendarExemptionFields({ record, members }: ExemptionProps) {
  const [exempt, setExempt] = useState(record?.calendarExempt ?? false);
  return (
    <fieldset>
      <legend>Calendar exemption</legend>
      <label>
        <input
          type="checkbox"
          name="calendarExempt"
          checked={exempt}
          onChange={(event) => setExempt(event.target.checked)}
        />{" "}
        Calendar exempt
      </label>
      <p className="muted">
        Retains the calendar requirement and history, but excludes calendar
        deadlines from alerts and counts. Hours and cycles still apply.
        Unchecking restores the deadline from existing compliance.
      </p>
      <Field label="Calendar exemption reason / reference">
        <textarea
          name="calendarExemptReason"
          required={exempt}
          maxLength={EXEMPT_REASON_MAX_LENGTH}
          defaultValue={record?.calendarExemptReason}
        />
      </Field>
      {record?.calendarExemptChangedAt && (
        <p className="muted">
          Last changed{" "}
          {new Date(record.calendarExemptChangedAt).toLocaleString()} by{" "}
          {members.find((m) => m.id === record.calendarExemptChangedBy)?.name ??
            record.calendarExemptChangedBy}
        </p>
      )}
    </fieldset>
  );
}
