/**
 * Responsibility: Revises a closed work order's written record, and lists
 *   each earlier version of that record.
 * Layer: UI. React components; the domain and the server append the
 *   revision, which keeps the previous record whole.
 * Dependencies: src/data/store.ts, src/domain (model, workOrders,
 *   workOrderCloseout), ./ui.tsx, ./LogbookEntry.tsx.
 */
import { useState } from "react";
import { useWorkspace } from "../data/store";
import { can, type Snapshot } from "../domain/model";
import { workPerformedText } from "../domain/workOrderCloseout";
import {
  isOpenWorkOrder,
  workOrderSchema,
  type WorkOrder,
  type WorkOrderCommand,
} from "../domain/workOrders";
import { AsyncForm, Field, value } from "./ui";
import { LogbookEntryButton } from "./LogbookEntry";

// The limits workOrderRevisionFieldsSchema sets.
const TEXT_MAX_LENGTH = 10000;
const WORDING_MAX_LENGTH = 100000;
const PRE_WRAP = { whiteSpace: "pre-wrap" } as const;

type Revision = NonNullable<WorkOrder["revisions"]>[number];
type RecordProps = { order: WorkOrder; workPerformed: string };
type OrderProps = { snapshot: Snapshot; order: WorkOrder };
type EntryProps = OrderProps & { revision: Revision };
type ControlProps = RecordProps & {
  allowed: boolean;
  editing: boolean;
  onEditing: (editing: boolean) => void;
  onSave: (data: FormData) => Promise<void>;
};

/**
 * The revisions panel of a completed or cancelled work order: revise its
 * supervisor, scope, work performed wording and release statement with a
 * reason, and read each earlier version, newest first. Revising needs a
 * connection and the maintenance permission for the aircraft.
 *
 * @param props.onDone - Called once a revision is saved.
 * @param props.initiallyEditing - Opens the revision form at once.
 * @returns Nothing for an open work order or before the snapshot loads.
 * @throws {z.ZodError} When a stored previous record no longer parses.
 */
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
  const workPerformed = recordedWording(snapshot, order);
  const save = async (data: FormData) => {
    await backend!.workOrder(reviseCommand(order, data));
    onDone();
  };
  return (
    <section className="panel" aria-label="Work order revisions">
      <RevisionsIntro count={order.revisions?.length} />
      <ReviseControl
        order={order}
        workPerformed={workPerformed}
        allowed={allowed}
        editing={editing}
        onEditing={setEditing}
        onSave={save}
      />
      {!!order.revisions?.length && (
        <RevisionHistory snapshot={snapshot} order={order} />
      )}
    </section>
  );
}

// The latest revision's wording, else the closeout's, else its tasks' wording.
function recordedWording(snapshot: Snapshot, order: WorkOrder) {
  return (
    order.revisedWorkPerformed ??
    order.closeout?.workPerformed ??
    workPerformedText(snapshot, order)
  );
}

function reviseCommand(order: WorkOrder, data: FormData): WorkOrderCommand {
  return {
    action: "revise",
    uuid: order.uuid,
    version: order.version,
    reason: value(data, "reason"),
    fields: {
      supervisor: value(data, "supervisor"),
      scope: value(data, "scope"),
      releaseOutcome: value(data, "releaseOutcome"),
      workPerformed: value(data, "workPerformed"),
    },
  };
}

function RevisionsIntro({ count }: { count?: number }) {
  return (
    <>
      <h3>Revisions{count ? ` · Revision ${count}` : ""}</h3>
      <p>
        Correct the written record with a reason. The original is retained.
        Dates, readings, task completion, inspection compliance and component
        tracking remain as recorded at closeout.
      </p>
    </>
  );
}

function ReviseControl(props: ControlProps) {
  const { allowed, onEditing } = props;
  if (!props.editing)
    return (
      <button
        type="button"
        className="button"
        disabled={!allowed}
        onClick={() => onEditing(true)}
      >
        Revise work order
      </button>
    );
  return (
    <AsyncForm
      submitLabel="Save revision"
      disabled={!allowed}
      onClose={() => onEditing(false)}
      onSubmit={props.onSave}
    >
      <Field label="Reason for revision">
        <textarea name="reason" required maxLength={TEXT_MAX_LENGTH} />
      </Field>
      <RevisionFields {...props} />
    </AsyncForm>
  );
}

function RevisionFields({ order, workPerformed }: RecordProps) {
  return (
    <>
      <Field label="Supervisor">
        <input
          name="supervisor"
          defaultValue={order.supervisor}
          maxLength={TEXT_MAX_LENGTH}
        />
      </Field>
      <Field label="Scope">
        <textarea
          name="scope"
          defaultValue={order.scope}
          maxLength={TEXT_MAX_LENGTH}
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
          maxLength={WORDING_MAX_LENGTH}
        />
      </Field>
      <Field label="Closing release statement">
        <textarea
          name="releaseOutcome"
          defaultValue={order.releaseOutcome}
          required={order.status === "completed"}
          maxLength={TEXT_MAX_LENGTH}
        />
      </Field>
    </>
  );
}

function RevisionHistory({ snapshot, order }: OrderProps) {
  const workPerformed = recordedWording(snapshot, order);
  return (
    <>
      <h4>Current corrected work performed</h4>
      <p style={PRE_WRAP}>{workPerformed || "No wording recorded."}</p>
      <h4>Revision history</h4>
      {[...order.revisions!].reverse().map((revision) => (
        <RevisionEntry
          key={revision.number}
          snapshot={snapshot}
          order={order}
          revision={revision}
        />
      ))}
    </>
  );
}

// A stored record omits its history; it gets back the revisions before it.
function previousRecord(order: WorkOrder, revision: Revision) {
  const previous = workOrderSchema.parse(JSON.parse(revision.previousRecord));
  previous.revisions = order.revisions!.slice(0, revision.number - 1);
  return previous;
}

function RevisionEntry({ snapshot, order, revision }: EntryProps) {
  const previous = previousRecord(order, revision);
  return (
    <details>
      <summary>
        Revision {revision.number} ·{" "}
        {new Date(revision.recordedAt).toLocaleString()} · {revision.authorName}
      </summary>
      <p>Reason: {revision.reason}</p>
      <h4>
        {revision.number === 1
          ? "Original record"
          : `Record before revision ${revision.number}`}
      </h4>
      <p>Supervisor: {previous.supervisor}</p>
      <p style={PRE_WRAP}>Scope: {previous.scope}</p>
      <p style={PRE_WRAP}>
        Work performed: {recordedWording(snapshot, previous)}
      </p>
      <p style={PRE_WRAP}>Release statement: {previous.releaseOutcome}</p>
      {previous.status === "completed" && (
        <LogbookEntryButton order={previous} />
      )}
    </details>
  );
}
