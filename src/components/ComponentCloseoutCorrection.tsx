/**
 * Responsibility: Corrects a completed work order's repair or overhaul
 *   selection for a component, with a tracking preview, and lists past
 *   corrections with their logbook addenda.
 * Layer: UI. React components; the correction is previewed and applied by
 *   the domain and the server, never edited here.
 * Dependencies: src/data (store, historyPages), src/domain (model, workOrders,
 *   workOrderComponentWork, workOrderComponentCorrections, components),
 *   ./ui.tsx.
 *
 * A correction is appended to the work order; the original close-out stays
 * in history, and a signed logbook entry needs the correction addendum.
 */
import { useState } from "react";
import { useWorkspace } from "../data/store";
import { useRecordsSnapshot } from "../data/historyPages";
import { can, type Snapshot } from "../domain/model";
import type { WorkOrder } from "../domain/workOrders";
import { componentWorkLabels } from "../domain/workOrderComponentWork";
import {
  previewComponentCorrection,
  type ComponentCorrectionCommand,
} from "../domain/workOrderComponentCorrections";
import type { ComponentRequirement } from "../domain/components";
import { AsyncForm, Field, value, download } from "./ui";

const SECONDS_PER_HOUR = 3600;
// The limits componentWorkSchema and componentCorrectionCommandSchema set.
const DESCRIPTION_MAX_LENGTH = 10000;
const REFERENCE_MAX_LENGTH = 2000;
const REASON_MAX_LENGTH = 1500;
// Installs and removals move a component; only the work done to it is
// corrected here.
const MOVEMENT_ACTIONS: readonly string[] = ["install", "remove"];
const TRACKED_READINGS = [
  ["timeSinceNew", "TSN"],
  ["timeSinceOverhaul", "TSO"],
  ["timeSinceRepair", "TSR"],
  ["cyclesSinceNew", "Cycles"],
] as const;

type Preview = ReturnType<typeof previewComponentCorrection>["correction"];
type PendingCorrection = { command: ComponentCorrectionCommand; item: Preview };
type CorrectionChoice = ComponentCorrectionCommand["choice"];

/**
 * The component close-out corrections panel of a completed work order: pick
 * a serviced, repaired or overhauled component, preview the corrected
 * tracking and next-due limits, then confirm, which sends the correction as a
 * work order command. Needs a connection and the maintenance permission for
 * the aircraft. Past corrections are listed newest first.
 *
 * @param props.onDone - Called after a confirmed correction is saved.
 * @returns Nothing unless the order is completed with correctable work.
 */
export function ComponentCloseoutCorrection({
  order,
  onDone,
}: {
  order: WorkOrder;
  onDone: () => void;
}) {
  const { online, connected } = useWorkspace();
  const s = useRecordsSnapshot();
  const correctable = correctableWork(order);
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState(correctable[0]?.componentUuid ?? "");
  if (!s || order.status !== "completed" || !correctable.length) return null;
  const allowed =
    online && connected && can(s, order.aircraftUuid, "maintenance");
  const current = currentChoice(order, selected);
  const editor = { s, order, allowed, correctable, selected, setSelected };
  return (
    <section className="panel" aria-label="Component closeout corrections">
      <h3>Component closeout corrections</h3>
      <p>
        Correct a repair or overhaul selection at the original completion
        readings. Preview tracking and next-due limits before confirming. Later
        maintenance or changed requirements require manual review.
      </p>
      {!editing && (
        <StartButton allowed={allowed} onStart={() => setEditing(true)} />
      )}
      {editing && (
        <CorrectionEditor
          editor={{ ...editor, ...current }}
          onClose={() => setEditing(false)}
          onDone={onDone}
        />
      )}
      <CorrectionHistory order={order} />
    </section>
  );
}

type WorkChoice = NonNullable<
  NonNullable<WorkOrder["closeout"]>["componentWork"]
>[number];
interface Editor {
  s: Snapshot;
  order: WorkOrder;
  allowed: boolean;
  correctable: WorkChoice[];
  selected: string;
  setSelected: (componentUuid: string) => void;
  effective: Pick<CorrectionChoice, "action" | "description" | "reference">;
  supported: boolean;
}

function correctableWork(order: WorkOrder) {
  return (
    order.closeout?.componentWork?.filter(
      (c) => !MOVEMENT_ACTIONS.includes(c.action),
    ) ?? []
  );
}

// The selection in force for a component: its latest correction, or the
// close-out's own. Throws when `selected` is not in the close-out.
function currentChoice(order: WorkOrder, selected: string) {
  const original = order.closeout!.componentWork!.find(
    (c) => c.componentUuid === selected,
  )!;
  const latest = order.componentCorrections
    ?.filter((c) => c.componentUuid === selected)
    .at(-1);
  return {
    effective: latest?.choice ?? original,
    supported: !!(latest?.trackingBaseline ?? original.trackingBaseline),
  };
}

function StartButton({
  allowed,
  onStart,
}: {
  allowed: boolean;
  onStart: () => void;
}) {
  return (
    <button
      type="button"
      className="button"
      disabled={!allowed}
      onClick={onStart}
    >
      Correct component closeout
    </button>
  );
}

function CorrectionEditor({
  editor,
  onClose,
  onDone,
}: {
  editor: Editor;
  onClose: () => void;
  onDone: () => void;
}) {
  const { order, effective } = editor;
  const [preview, setPreview] = useState<PendingCorrection | null>(null);
  return (
    <>
      <ComponentSelect editor={editor} onChange={() => setPreview(null)} />
      <p>
        Currently recorded:{" "}
        <strong>{componentWorkLabels[effective.action]}</strong> on{" "}
        {order.completionDate}
      </p>
      {editor.supported ? (
        <ChoiceForm editor={editor} onPreview={setPreview} onClose={onClose} />
      ) : (
        <ManualReviewNotice />
      )}
      {preview && (
        <PreviewPanel
          preview={preview}
          allowed={editor.allowed}
          onDone={onDone}
        />
      )}
    </>
  );
}

function ManualReviewNotice() {
  return (
    <p role="alert">
      Manual review required: this older closeout lacks the saved pre-service
      records needed to restore tracking safely. Automatic correction is
      unavailable.
    </p>
  );
}

function ComponentSelect({
  editor: { order, correctable, selected, setSelected },
  onChange,
}: {
  editor: Editor;
  onChange: () => void;
}) {
  return (
    <Field label="Component to correct">
      <select
        value={selected}
        onChange={(e) => {
          setSelected(e.target.value);
          onChange();
        }}
      >
        {correctable.map((c) => {
          const info = order.closeout!.components.find(
            (i) => i.componentUuid === c.componentUuid,
          );
          return (
            <option key={c.componentUuid} value={c.componentUuid}>
              {info?.label} · S/N {info?.serial}
            </option>
          );
        })}
      </select>
    </Field>
  );
}

// Previewing writes nothing: a change to any field clears the preview, and
// only the confirm form below sends the command.
function ChoiceForm({
  editor,
  onPreview,
  onClose,
}: {
  editor: Editor;
  onPreview: (preview: PendingCorrection | null) => void;
  onClose: () => void;
}) {
  const { s, order, selected } = editor;
  return (
    <AsyncForm
      key={selected}
      disabled={!editor.allowed}
      submitLabel="Preview correction"
      onClose={onClose}
      onChange={() => onPreview(null)}
      onSubmit={async (data) => {
        const command = correctionCommand(s, order, selected, data);
        const result = previewComponentCorrection(s, order, command);
        onPreview({ command, item: result.correction });
      }}
    >
      <ChoiceFields effective={editor.effective} />
    </AsyncForm>
  );
}

function correctionCommand(
  s: Snapshot,
  order: WorkOrder,
  selected: string,
  data: FormData,
): ComponentCorrectionCommand {
  const c = s.management?.find(
    (r) => r.kind === "component" && r.uuid === selected,
  );
  const aircraft = s.aircraft.find((a) => a.uuid === order.aircraftUuid)!;
  return {
    action: "correctComponent",
    uuid: order.uuid,
    version: order.version,
    aircraftVersion: aircraft.version,
    reason: value(data, "reason"),
    choice: {
      componentUuid: selected,
      version: c?.version ?? 0,
      action: value(data, "action") as CorrectionChoice["action"],
      description: value(data, "description"),
      reference: value(data, "reference"),
    },
  };
}

function ChoiceFields({
  effective,
}: {
  effective: Pick<CorrectionChoice, "action" | "description" | "reference">;
}) {
  return (
    <>
      <Field label="Correct work performed">
        <select name="action" defaultValue={effective.action}>
          {Object.entries(componentWorkLabels)
            .filter(([v]) => !MOVEMENT_ACTIONS.includes(v))
            .map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
        </select>
      </Field>
      <Field label="Corrected work description">
        <textarea
          name="description"
          defaultValue={effective.description}
          maxLength={DESCRIPTION_MAX_LENGTH}
        />
      </Field>
      <Field label="Maintenance reference (optional)">
        <input
          name="reference"
          defaultValue={effective.reference}
          maxLength={REFERENCE_MAX_LENGTH}
        />
      </Field>
      <Field label="Reason for tracking correction">
        <textarea name="reason" required maxLength={REASON_MAX_LENGTH} />
      </Field>
    </>
  );
}

function PreviewPanel({
  preview,
  allowed,
  onDone,
}: {
  preview: PendingCorrection;
  allowed: boolean;
  onDone: () => void;
}) {
  const { backend } = useWorkspace();
  return (
    <section aria-label="Correction preview">
      <h4>Review correction</h4>
      <p>
        {componentWorkLabels[preview.item.originalAction]} →{" "}
        {componentWorkLabels[preview.item.choice.action]}
      </p>
      <TrackingPreview item={preview.item} />
      <p className="notice">
        The original closeout remains in history. Review the logbook entry and
        use the correction addendum with any previously signed or printed entry.
      </p>
      <p style={{ whiteSpace: "pre-wrap" }}>{preview.item.addendum}</p>
      <AsyncForm
        disabled={!allowed}
        submitLabel="Confirm tracking correction"
        onSubmit={async () => {
          await backend!.workOrder(preview.command);
          onDone();
        }}
      >
        <label>
          <input type="checkbox" required /> I reviewed the tracking changes and
          will review the associated logbook entry.
        </label>
      </AsyncForm>
    </section>
  );
}

function CorrectionHistory({ order }: { order: WorkOrder }) {
  if (!order.componentCorrections?.length) return null;
  return (
    <>
      <p className="notice">
        Logbook review required: component tracking has been corrected. Original
        closeout readings and wording below are retained; use the addendum to
        identify the correction.
      </p>
      {[...order.componentCorrections].reverse().map((c) => (
        <details key={c.uuid}>
          <summary>
            {componentWorkLabels[c.originalAction]} →{" "}
            {componentWorkLabels[c.choice.action]} · {c.authorName} ·{" "}
            {new Date(c.recordedAt).toLocaleString()}
          </summary>
          <p>Reason: {c.reason}</p>
          <TrackingPreview item={c} />
          <p style={{ whiteSpace: "pre-wrap" }}>{c.addendum}</p>
          <button
            type="button"
            className="button"
            onClick={() =>
              download(
                `${order.number}-correction-${c.uuid}.txt`,
                c.addendum,
                "text/plain",
              )
            }
          >
            Download correction addendum
          </button>
        </details>
      ))}
    </>
  );
}

function TrackingPreview({ item }: { item: Preview }) {
  const before = JSON.parse(item.requirementsBefore) as ComponentRequirement[];
  const after = JSON.parse(item.requirementsAfter) as ComponentRequirement[];
  return (
    <>
      <ReadingsTable item={item} />
      {!!after.length && <RequirementLimits before={before} after={after} />}
    </>
  );
}

function ReadingsTable({ item }: { item: Preview }) {
  const columns = [
    item.completionBefore,
    item.completionAfter,
    item.currentBefore,
    item.currentAfter,
  ];
  // Five columns: on a phone the table scrolls inside its own box.
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Reading</th>
            <th>Previously recorded completion</th>
            <th>Corrected completion</th>
            <th>Current before</th>
            <th>Current after</th>
          </tr>
        </thead>
        <tbody>
          {TRACKED_READINGS.map(([key, label]) => (
            <tr key={key}>
              <th>{label}</th>
              {columns.map((t, i) => (
                <td key={i}>
                  {key === "cyclesSinceNew" ? t[key] : formatHours(t[key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RequirementLimits({
  before,
  after,
}: {
  before: ComponentRequirement[];
  after: ComponentRequirement[];
}) {
  return (
    <>
      <h4>Requirement next-due limits</h4>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Requirement</th>
              <th>Before</th>
              <th>After</th>
            </tr>
          </thead>
          <tbody>
            {after.map((r) => (
              <tr key={r.uuid}>
                <th>{r.description}</th>
                <td>{formatLimits(before.find((b) => b.uuid === r.uuid))}</td>
                <td>{formatLimits(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function formatLimits(r: ComponentRequirement | undefined) {
  if (!r) return "Not recorded";
  return `${r.dueDate ?? "No date"} / ${formatHours(r.dueSeconds)} ${r.timeBasis} / ${r.dueCycles ?? "No"} cycles`;
}

function formatHours(seconds: number | null | undefined) {
  return seconds == null
    ? "Not recorded"
    : `${(seconds / SECONDS_PER_HOUR).toFixed(1)} h`;
}
