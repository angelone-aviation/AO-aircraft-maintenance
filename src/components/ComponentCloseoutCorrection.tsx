import { useState } from "react";
import { useWorkspace } from "../data/store";
import { can } from "../domain/model";
import type { WorkOrder } from "../domain/workOrders";
import { componentWorkLabels } from "../domain/workOrderComponentWork";
import {
  previewComponentCorrection,
  type ComponentCorrectionCommand,
} from "../domain/workOrderComponentCorrections";
import type { ComponentRequirement } from "../domain/components";
import { AsyncForm, Field, value, download } from "./ui";
const hours = (n: number | null | undefined) =>
  n == null ? "Not recorded" : `${(n / 3600).toFixed(1)} h`;
type Preview = ReturnType<typeof previewComponentCorrection>["correction"];
function TrackingPreview({ item }: { item: Preview }) {
  const before = JSON.parse(item.requirementsBefore) as ComponentRequirement[];
  const after = JSON.parse(item.requirementsAfter) as ComponentRequirement[];
  return (
    <>
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
          {(
            [
              ["timeSinceNew", "TSN"],
              ["timeSinceOverhaul", "TSO"],
              ["timeSinceRepair", "TSR"],
              ["cyclesSinceNew", "Cycles"],
            ] as const
          ).map(([key, label]) => (
            <tr key={key}>
              <th>{label}</th>
              {[
                item.completionBefore,
                item.completionAfter,
                item.currentBefore,
                item.currentAfter,
              ].map((t, i) => (
                <td key={i}>
                  {key === "cyclesSinceNew" ? t[key] : hours(t[key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!!after.length && (
        <>
          <h4>Requirement next-due limits</h4>
          <table>
            <thead>
              <tr>
                <th>Requirement</th>
                <th>Before</th>
                <th>After</th>
              </tr>
            </thead>
            <tbody>
              {after.map((r) => {
                const prior = before.find((b) => b.uuid === r.uuid);
                const limits = (v: ComponentRequirement | undefined) =>
                  v
                    ? `${v.dueDate ?? "No date"} / ${hours(v.dueSeconds)} ${v.timeBasis} / ${v.dueCycles ?? "No"} cycles`
                    : "Not recorded";
                return (
                  <tr key={r.uuid}>
                    <th>{r.description}</th>
                    <td>{limits(prior)}</td>
                    <td>{limits(r)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
export function ComponentCloseoutCorrection({
  order,
  onDone,
}: {
  order: WorkOrder;
  onDone: () => void;
}) {
  const { snapshot: s, backend, online, connected } = useWorkspace();
  const correctable =
    order.closeout?.componentWork?.filter(
      (c) => c.action !== "install" && c.action !== "remove",
    ) ?? [];
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState(correctable[0]?.componentUuid ?? "");
  const [preview, setPreview] = useState<{
    command: ComponentCorrectionCommand;
    item: Preview;
  } | null>(null);
  if (
    !s ||
    order.status !== "completed" ||
    !correctable.length ||
    !order.closeout?.componentWork
  )
    return null;
  const allowed =
    online && connected && can(s, order.aircraftUuid, "maintenance");
  const original = order.closeout.componentWork.find(
    (c) => c.componentUuid === selected,
  )!;
  const latest = order.componentCorrections
    ?.filter((c) => c.componentUuid === selected)
    .at(-1);
  const effective = latest?.choice ?? original;
  const supported = !!(latest?.trackingBaseline ?? original.trackingBaseline);
  return (
    <section className="panel" aria-label="Component closeout corrections">
      <h3>Component closeout corrections</h3>
      <p>
        Correct a repair or overhaul selection at the original completion
        readings. Preview tracking and next-due limits before confirming. Later
        maintenance or changed requirements require manual review.
      </p>
      {!editing && (
        <button
          type="button"
          className="button"
          disabled={!allowed}
          onClick={() => setEditing(true)}
        >
          Correct component closeout
        </button>
      )}
      {editing && (
        <>
          <Field label="Component to correct">
            <select
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                setPreview(null);
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
          <p>
            Currently recorded:{" "}
            <strong>{componentWorkLabels[effective.action]}</strong> on{" "}
            {order.completionDate}
          </p>
          {!supported ? (
            <p role="alert">
              Manual review required: this older closeout lacks the saved
              pre-service records needed to restore tracking safely. Automatic
              correction is unavailable.
            </p>
          ) : (
            <AsyncForm
              key={selected}
              disabled={!allowed}
              submitLabel="Preview correction"
              onClose={() => {
                setEditing(false);
                setPreview(null);
              }}
              onChange={() => setPreview(null)}
              onSubmit={async (data) => {
                const c = s.management?.find(
                  (r) => r.kind === "component" && r.uuid === selected,
                );
                const aircraft = s.aircraft.find(
                  (a) => a.uuid === order.aircraftUuid,
                )!;
                const command: ComponentCorrectionCommand = {
                  action: "correctComponent",
                  uuid: order.uuid,
                  version: order.version,
                  aircraftVersion: aircraft.version,
                  reason: value(data, "reason"),
                  choice: {
                    componentUuid: selected,
                    version: c?.version ?? 0,
                    action: value(
                      data,
                      "action",
                    ) as ComponentCorrectionCommand["choice"]["action"],
                    description: value(data, "description"),
                    reference: value(data, "reference"),
                  },
                };
                const result = previewComponentCorrection(s, order, command);
                setPreview({ command, item: result.correction });
              }}
            >
              <Field label="Correct work performed">
                <select name="action" defaultValue={effective.action}>
                  {Object.entries(componentWorkLabels)
                    .filter(([v]) => v !== "install" && v !== "remove")
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
                  maxLength={10000}
                />
              </Field>
              <Field label="Maintenance reference (optional)">
                <input
                  name="reference"
                  defaultValue={effective.reference}
                  maxLength={2000}
                />
              </Field>
              <Field label="Reason for tracking correction">
                <textarea name="reason" required maxLength={1500} />
              </Field>
            </AsyncForm>
          )}
          {preview && (
            <section aria-label="Correction preview">
              <h4>Review correction</h4>
              <p>
                {componentWorkLabels[preview.item.originalAction]} →{" "}
                {componentWorkLabels[preview.item.choice.action]}
              </p>
              <TrackingPreview item={preview.item} />
              <p className="notice">
                The original closeout remains in history. Review the logbook
                entry and use the correction addendum with any previously signed
                or printed entry.
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
                  <input type="checkbox" required /> I reviewed the tracking
                  changes and will review the associated logbook entry.
                </label>
              </AsyncForm>
            </section>
          )}
        </>
      )}
      {!!order.componentCorrections?.length && (
        <>
          <p className="notice">
            Logbook review required: component tracking has been corrected.
            Original closeout readings and wording below are retained; use the
            addendum to identify the correction.
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
      )}
    </section>
  );
}
