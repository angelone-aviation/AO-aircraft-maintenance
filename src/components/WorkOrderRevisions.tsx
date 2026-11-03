import { useState } from "react";
import { useWorkspace } from "../data/store";
import { can } from "../domain/model";
import { workPerformedText } from "../domain/workOrderCloseout";
import {
  isOpenWorkOrder,
  workOrderSchema,
  type WorkOrder,
} from "../domain/workOrders";
import { AsyncForm, Field, value } from "./ui";
import { LogbookEntryButton } from "./LogbookEntry";

export function WorkOrderRevisions({
  order,
  onDone,
  initiallyEditing = false,
}: {
  order: WorkOrder;
  onDone: () => void;
  initiallyEditing?: boolean;
}) {
  const { snapshot, backend, online, connected } = useWorkspace();
  const [editing, setEditing] = useState(initiallyEditing);
  if (!snapshot || isOpenWorkOrder(order)) return null;
  const allowed =
    online && connected && can(snapshot, order.aircraftUuid, "maintenance");
  const workPerformed =
    order.revisedWorkPerformed ??
    order.closeout?.workPerformed ??
    workPerformedText(snapshot, order);
  return (
    <section className="panel" aria-label="Work order revisions">
      <h3>
        Revisions
        {order.revisions?.length ? ` · Revision ${order.revisions.length}` : ""}
      </h3>
      <p>
        Correct the written record with a reason. The original is retained.
        Dates, readings, task completion, inspection compliance and component
        tracking remain as recorded at closeout.
      </p>
      {!editing && (
        <button
          type="button"
          className="button"
          disabled={!allowed}
          onClick={() => setEditing(true)}
        >
          Revise work order
        </button>
      )}
      {editing && (
        <AsyncForm
          submitLabel="Save revision"
          disabled={!allowed}
          onClose={() => setEditing(false)}
          onSubmit={async (data) => {
            await backend!.workOrder({
              action: "revise",
              uuid: order.uuid,
              version: order.version,
              reason: value(data, "reason"),
              fields: {
                supervisor: value(data, "supervisor"),
                scope: value(data, "scope"),
                releaseOutcome: value(data, "releaseOutcome"),
                finalReview: order.finalReview,
                workPerformed: value(data, "workPerformed"),
              },
            });
            onDone();
          }}
        >
          <Field label="Reason for revision">
            <textarea name="reason" required maxLength={10000} />
          </Field>
          <Field label="Supervisor">
            <input
              name="supervisor"
              defaultValue={order.supervisor}
              maxLength={10000}
            />
          </Field>
          <Field label="Scope">
            <textarea
              name="scope"
              defaultValue={order.scope}
              maxLength={10000}
            />
          </Field>
          <Field
            label="Work performed / logbook wording"
            hint="Correct the written account here. The original task and job-card records are retained."
          >
            <textarea
              name="workPerformed"
              defaultValue={workPerformed}
              rows={10}
              maxLength={100000}
            />
          </Field>
          <Field label="Closing release statement">
            <textarea
              name="releaseOutcome"
              defaultValue={order.releaseOutcome}
              required={order.status === "completed"}
              maxLength={10000}
            />
          </Field>
        </AsyncForm>
      )}
      {!!order.revisions?.length && (
        <>
          <h4>Current corrected work performed</h4>
          <p style={{ whiteSpace: "pre-wrap" }}>
            {workPerformed || "No wording recorded."}
          </p>
          <h4>Revision history</h4>
          {[...order.revisions].reverse().map((revision) => {
            const previous = workOrderSchema.parse(
              JSON.parse(revision.previousRecord),
            );
            previous.revisions = order.revisions!.slice(0, revision.number - 1);
            return (
              <details key={revision.number}>
                <summary>
                  Revision {revision.number} ·{" "}
                  {new Date(revision.recordedAt).toLocaleString()} ·{" "}
                  {revision.authorName}
                </summary>
                <p>Reason: {revision.reason}</p>
                <h4>
                  {revision.number === 1
                    ? "Original record"
                    : `Record before revision ${revision.number}`}
                </h4>
                <p>Supervisor: {previous.supervisor}</p>
                <p style={{ whiteSpace: "pre-wrap" }}>
                  Scope: {previous.scope}
                </p>
                <p style={{ whiteSpace: "pre-wrap" }}>
                  Work performed:{" "}
                  {previous.revisedWorkPerformed ??
                    previous.closeout?.workPerformed ??
                    workPerformedText(snapshot, previous)}
                </p>
                <p style={{ whiteSpace: "pre-wrap" }}>
                  Release statement: {previous.releaseOutcome}
                </p>
                <p style={{ whiteSpace: "pre-wrap" }}>
                  Final review: {previous.finalReview}
                </p>
                {previous.status === "completed" && (
                  <LogbookEntryButton order={previous} />
                )}
              </details>
            );
          })}
        </>
      )}
    </section>
  );
}
