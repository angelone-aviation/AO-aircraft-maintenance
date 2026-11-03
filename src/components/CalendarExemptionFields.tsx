import { useState } from "react";
import type { Inspection, Snapshot } from "../domain/model";
import { Field } from "./ui";

export function CalendarExemptionFields({
  record,
  members,
}: {
  record?: Inspection;
  members: Snapshot["members"];
}) {
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
          maxLength={5000}
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
