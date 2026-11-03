import { useState } from "react";
import { createPortal } from "react-dom";
import { useWorkspace } from "../data/store";
import { can } from "../domain/model";
import { programPermission } from "../domain/programs";
import {
  parseTaskCsv,
  taskCsvHeaders,
  type TaskCsvImport,
} from "../domain/taskCsv";
import {
  taskSourceText,
  type TemplateTask,
} from "../domain/inspectionTemplates";
import { AsyncForm, Field, Modal } from "./ui";
import { Link } from "@tanstack/react-router";
export function TaskCsvImportButton({
  initialKind = "template",
  initialTarget = "",
  initialManual = "",
  label = "Import Jobs CSV",
}: {
  initialKind?: "template" | "inspection";
  initialTarget?: string;
  initialManual?: string;
  label?: string;
}) {
  const { snapshot: s, online, connected } = useWorkspace();
  const [open, setOpen] = useState(false);
  const permitted =
    programPermission(s!, "maintenance") ||
    s!.aircraft.some((a) => can(s!, a.uuid, "maintenance"));
  return (
    <>
      <button
        type="button"
        className="button"
        disabled={!online || !connected || !permitted}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      {open &&
        createPortal(
          <div onSubmit={(e) => e.stopPropagation()}>
            <Modal
              wide
              title="Import Jobs to a template or inspection"
              onClose={() => setOpen(false)}
            >
              <TaskCsvImportForm
                initialKind={initialKind}
                initialTarget={initialTarget}
                initialManual={initialManual}
              />
            </Modal>
          </div>,
          document.body,
        )}
    </>
  );
}
function TaskCsvImportForm({
  initialKind,
  initialTarget,
  initialManual,
}: {
  initialKind: "template" | "inspection";
  initialTarget: string;
  initialManual: string;
}) {
  const { snapshot: s, backend, online, connected } = useWorkspace();
  const [kind, setKind] = useState(initialKind),
    [target, setTarget] = useState(initialTarget),
    [manual, setManual] = useState(initialManual);
  const [preview, setPreview] = useState<{
    input: TaskCsvImport;
    tasks: TemplateTask[];
    filename: string;
  }>();
  const [saved, setSaved] = useState("");
  const [limit, setLimit] = useState(100);
  const templates = (s!.inspectionTemplates ?? []).filter(
    (t) => !t.archived && programPermission(s!, "maintenance"),
  );
  const inspections = s!.inspections.filter(
    (i) => !i.archived && can(s!, i.aircraftUuid, "maintenance"),
  );
  const parent =
    kind === "template"
      ? templates.find((t) => t.uuid === target)
      : inspections.find((i) => i.uuid === target);
  const targetName =
    kind === "template"
      ? templates.find((t) => t.uuid === target)?.name
      : inspections.find((i) => i.uuid === target)?.reference;
  const manuals = (s!.manuals ?? []).filter((m) =>
    can(s!, m.aircraftUuid, "read"),
  );
  return (
    <>
      <p>
        Choose one destination for the entire file. Template imports append
        reusable checklist instructions. Inspection imports create one linked,
        unsigned draft job card per row.
      </p>
      <div className="form-grid">
        <Field label="Attach whole file to">
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as typeof kind);
              setTarget("");
              setPreview(undefined);
              setSaved("");
            }}
          >
            <option value="template">Inspection template</option>
            <option value="inspection">Existing inspection</option>
          </select>
        </Field>
        <Field
          label={kind === "template" ? "Target template" : "Target inspection"}
        >
          <select
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
              setPreview(undefined);
              setSaved("");
            }}
          >
            <option value="">Choose a destination</option>
            {kind === "template"
              ? templates.map((t) => (
                  <option key={t.uuid} value={t.uuid}>
                    {t.applicability.manufacturer} {t.applicability.model} ·{" "}
                    {t.group || "General"} · {t.name}
                  </option>
                ))
              : inspections.map((i) => (
                  <option key={i.uuid} value={i.uuid}>
                    {
                      s!.aircraft.find((a) => a.uuid === i.aircraftUuid)
                        ?.registration
                    }{" "}
                    · {i.reference}
                  </option>
                ))}
          </select>
        </Field>
        <Field label="Source PDF manual (optional)">
          <select
            value={manual}
            onChange={(e) => {
              setManual(e.target.value);
              setPreview(undefined);
            }}
          >
            <option value="">Keep references as text</option>
            {manuals.map((m) => (
              <option key={m.uuid} value={m.uuid}>
                {m.title} · {m.revision}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <p>
        Accepted columns: {taskCsvHeaders.join(", ")}. Optional: Applicability.
        The existing tasks.csv format is also accepted; its parent IDs are
        replaced by the destination you choose here.
      </p>
      <p>
        {manual
          ? "PDF pages will be validated against the selected manual and linked for viewing."
          : "Manual references and PDF page numbers will be preserved as text without a PDF link."}
      </p>
      {kind === "template" && (
        <p>
          Adding tasks to a template affects future inspections created from it.
          To add tasks to an inspection already created, choose that inspection
          directly.
        </p>
      )}
      <button
        className="button"
        type="button"
        onClick={() => {
          const url = URL.createObjectURL(
            new Blob([taskCsvHeaders.join(",") + "\r\n"], {
              type: "text/csv;charset=utf-8",
            }),
          );
          const a = document.createElement("a");
          a.href = url;
          a.download = "tasks-for-one-target.csv";
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}
      >
        Download task CSV format
      </button>
      <AsyncForm
        submitLabel="Preview task file"
        disabled={!online || !connected || !parent}
        onChange={() => {
          setPreview(undefined);
          setSaved("");
        }}
        onSubmit={async (d) => {
          setPreview(undefined);
          setSaved("");
          const file = d.get("csv");
          if (
            !(file instanceof File) ||
            !file.size ||
            file.size > 2 * 1024 * 1024
          )
            throw new Error("Choose a UTF-8 CSV up to 2 MB.");
          const csv = new TextDecoder("utf-8", { fatal: true }).decode(
            await file.arrayBuffer(),
          );
          const tasks = parseTaskCsv(csv);
          if (manual) {
            const m = manuals.find((m) => m.uuid === manual);
            if (!m) throw new Error("Selected manual is unavailable.");
            for (const t of tasks)
              if (!t.pdfPage || t.pdfPage > m.pageCount)
                throw new Error(
                  `Task ${t.itemCode}: PDF page must be between 1 and ${m.pageCount}.`,
                );
          }
          setPreview({
            input: {
              csv,
              targetKind: kind,
              targetUuid: target,
              targetVersion: parent?.version ?? 0,
              manualUuid: manual || undefined,
              reviewed: true,
            },
            tasks,
            filename: file.name,
          });
          setLimit(100);
        }}
      >
        <Field label="Task CSV file">
          <input name="csv" type="file" accept=".csv,text/csv" required />
        </Field>
      </AsyncForm>
      {saved && (
        <p role="status">
          {saved}{" "}
          <Link
            to={kind === "template" ? "/inspection-templates" : "/inspections"}
          >
            Open {kind === "template" ? "templates" : "inspections"}
          </Link>
        </p>
      )}
      {preview && (
        <AsyncForm
          key={`${preview.filename}:${preview.input.targetUuid}:${preview.input.targetVersion}`}
          submitLabel={`Import all ${preview.tasks.length} tasks`}
          disabled={!online || !connected || !parent}
          onSubmit={async () => {
            await backend!.importTaskCsv(preview.input);
            setSaved(
              `${preview.tasks.length} tasks imported to ${targetName}.`,
            );
            setPreview(undefined);
          }}
        >
          <p>
            <strong>
              {preview.filename}: {preview.tasks.length} tasks → {targetName}
            </strong>
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Item code</th>
                  <th>Task</th>
                  <th>Zone / applicability</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {preview.tasks.slice(0, limit).map((t) => (
                  <tr key={t.itemCode}>
                    <td>{t.itemCode}</td>
                    <td>{t.instruction}</td>
                    <td>
                      {t.zone}
                      {t.applicability && <p>{t.applicability}</p>}
                    </td>
                    <td>{taskSourceText(t)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {limit < preview.tasks.length && (
            <button
              type="button"
              className="button"
              onClick={() => setLimit((n) => n + 100)}
            >
              Show more tasks
            </button>
          )}
          <label>
            <input type="checkbox" required /> I reviewed this file and want
            every task attached to {targetName}.
          </label>
        </AsyncForm>
      )}
    </>
  );
}
