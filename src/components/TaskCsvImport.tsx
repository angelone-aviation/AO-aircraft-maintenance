/**
 * Responsibility: Imports a jobs CSV into one inspection template or one
 *   existing inspection, after the user previews and confirms every row.
 * Layer: UI. Reads and checks the file in the browser; the import goes
 *   through the workspace backend.
 * Dependencies: react, react-dom, @tanstack/react-router, src/data/store.ts,
 *   src/domain/model.ts, src/domain/programs.ts, src/domain/taskCsv.ts,
 *   src/domain/inspectionTemplates.ts, src/domain/manuals.ts,
 *   src/domain/maintenanceCsv.ts, src/components/ui.tsx.
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "@tanstack/react-router";
import { useWorkspace } from "../data/store";
import { can, type Snapshot } from "../domain/model";
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
import type { Manual } from "../domain/manuals";
import { CSV_MAX_BYTES } from "../domain/maintenanceCsv";
import { AsyncForm, Field, Modal, download } from "./ui";

// Rows the preview shows at first, and adds with each "Show more tasks".
const PREVIEW_PAGE_SIZE = 100;

type TargetKind = "template" | "inspection";
type Preview = {
  input: TaskCsvImport;
  tasks: TemplateTask[];
  filename: string;
};
type FormProps = {
  initialKind: TargetKind;
  initialTarget: string;
  initialManual: string;
};
type Destination = ReturnType<typeof useDestination>;
type Review = ReturnType<typeof useReview>;

/**
 * Opens the jobs CSV import, which attaches every row of one file to a single
 * template or inspection the user may maintain. Needs a connection.
 *
 * @param props.initialKind - The destination kind to start on; "template"
 *   when omitted.
 * @param props.initialTarget - Uuid of the template or inspection to start on.
 * @param props.initialManual - Uuid of the source PDF manual to start on.
 * @param props.label - The button's text; "Import Jobs CSV" when omitted.
 * @returns The button, disabled without maintenance permission on the program
 *   or any aircraft, and the import dialog while open.
 */
export function TaskCsvImportButton({
  initialKind = "template",
  initialTarget = "",
  initialManual = "",
  label = "Import Jobs CSV",
}: Partial<FormProps> & { label?: string }) {
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
      {open && (
        <ImportDialog
          form={{ initialKind, initialTarget, initialManual }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

// React events bubble through portals, so a submit in the dialog would
// otherwise reach a form that encloses the button.
function ImportDialog({
  form,
  onClose,
}: {
  form: FormProps;
  onClose: () => void;
}) {
  return createPortal(
    <div onSubmit={(e) => e.stopPropagation()}>
      <Modal
        wide
        title="Import Jobs to a template or inspection"
        onClose={onClose}
      >
        <TaskCsvImportForm {...form} />
      </Modal>
    </div>,
    document.body,
  );
}

function TaskCsvImportForm(props: FormProps) {
  const { online, connected } = useWorkspace();
  const destination = useDestination(props);
  const review = useReview();
  const { kind, parent } = destination;
  const { preview } = review;
  const disabled = !online || !connected || !parent;
  return (
    <>
      <p>
        Choose one destination for the entire file. Template imports append
        reusable checklist instructions. Inspection imports create one linked,
        unsigned draft job card per row.
      </p>
      <DestinationFields destination={destination} review={review} />
      <ImportNotes kind={kind} manual={destination.manual} />
      <button className="button" type="button" onClick={downloadCsvFormat}>
        Download task CSV format
      </button>
      <PreviewFileForm
        destination={destination}
        review={review}
        disabled={disabled}
      />
      {review.saved && <SavedStatus kind={kind} saved={review.saved} />}
      {preview && (
        <ImportPreview
          key={`${preview.filename}:${preview.input.targetUuid}:${preview.input.targetVersion}`}
          preview={preview}
          review={review}
          targetName={destination.targetName}
          disabled={disabled}
        />
      )}
    </>
  );
}

function useDestination({
  initialKind,
  initialTarget,
  initialManual,
}: FormProps) {
  const { snapshot } = useWorkspace();
  const [kind, setKind] = useState(initialKind);
  const [target, setTarget] = useState(initialTarget);
  const [manual, setManual] = useState(initialManual);
  const choices = destinationChoices(snapshot!, kind, target);
  return { ...choices, kind, target, manual, setKind, setTarget, setManual };
}

function useReview() {
  const [preview, setPreview] = useState<Preview>();
  const [saved, setSaved] = useState("");
  const [limit, setLimit] = useState(PREVIEW_PAGE_SIZE);
  return {
    preview,
    saved,
    limit,
    discard: () => setPreview(undefined),
    clear() {
      setPreview(undefined);
      setSaved("");
    },
    show(next: Preview) {
      setPreview(next);
      setLimit(PREVIEW_PAGE_SIZE);
    },
    showMore: () => setLimit((n) => n + PREVIEW_PAGE_SIZE),
    finish(message: string) {
      setSaved(message);
      setPreview(undefined);
    },
  };
}

function DestinationFields({
  destination: d,
  review,
}: {
  destination: Destination;
  review: Review;
}) {
  return (
    <div className="form-grid">
      <Field label="Attach whole file to">
        <select
          value={d.kind}
          onChange={(e) => {
            d.setKind(e.target.value as TargetKind);
            d.setTarget("");
            review.clear();
          }}
        >
          <option value="template">Inspection template</option>
          <option value="inspection">Existing inspection</option>
        </select>
      </Field>
      <Field
        label={d.kind === "template" ? "Target template" : "Target inspection"}
      >
        <select
          value={d.target}
          onChange={(e) => {
            d.setTarget(e.target.value);
            review.clear();
          }}
        >
          <option value="">Choose a destination</option>
          <TargetOptions destination={d} />
        </select>
      </Field>
      <ManualField destination={d} review={review} />
    </div>
  );
}

// Unlike a new destination, a new manual leaves the last import's status.
function ManualField({
  destination: d,
  review,
}: {
  destination: Destination;
  review: Review;
}) {
  return (
    <Field label="Source PDF manual (optional)">
      <select
        value={d.manual}
        onChange={(e) => {
          d.setManual(e.target.value);
          review.discard();
        }}
      >
        <option value="">Keep references as text</option>
        {d.manuals.map((m) => (
          <option key={m.uuid} value={m.uuid}>
            {m.title} · {m.revision}
          </option>
        ))}
      </select>
    </Field>
  );
}

function TargetOptions({ destination: d }: { destination: Destination }) {
  if (d.kind === "template")
    return d.templates.map((t) => (
      <option key={t.uuid} value={t.uuid}>
        {t.applicability.manufacturer} {t.applicability.model} ·{" "}
        {t.group || "General"} · {t.name}
      </option>
    ));
  return d.inspections.map((i) => (
    <option key={i.uuid} value={i.uuid}>
      {d.registration(i.aircraftUuid)} · {i.reference}
    </option>
  ));
}

function ImportNotes({ kind, manual }: { kind: TargetKind; manual: string }) {
  return (
    <>
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
    </>
  );
}

function PreviewFileForm({
  destination,
  review,
  disabled,
}: {
  destination: Destination;
  review: Review;
  disabled: boolean;
}) {
  async function previewFile(data: FormData) {
    review.clear();
    const { manual, manuals } = destination;
    const file = await readTaskFile(data.get("csv"), manual, manuals);
    review.show({
      input: importInput(destination, file.csv),
      tasks: file.tasks,
      filename: file.name,
    });
  }
  return (
    <AsyncForm
      submitLabel="Preview task file"
      disabled={disabled}
      onChange={review.clear}
      onSubmit={previewFile}
    >
      <Field label="Task CSV file">
        <input name="csv" type="file" accept=".csv,text/csv" required />
      </Field>
    </AsyncForm>
  );
}

function SavedStatus({ kind, saved }: { kind: TargetKind; saved: string }) {
  return (
    <p role="status">
      {saved}{" "}
      <Link to={kind === "template" ? "/inspection-templates" : "/inspections"}>
        Open {kind === "template" ? "templates" : "inspections"}
      </Link>
    </p>
  );
}

function ImportPreview({
  preview,
  review,
  targetName,
  disabled,
}: {
  preview: Preview;
  review: Review;
  targetName: string | undefined;
  disabled: boolean;
}) {
  const { backend } = useWorkspace();
  const count = preview.tasks.length;
  async function importAll() {
    await backend!.importTaskCsv(preview.input);
    review.finish(`${count} tasks imported to ${targetName}.`);
  }
  return (
    <AsyncForm
      submitLabel={`Import all ${count} tasks`}
      disabled={disabled}
      onSubmit={importAll}
    >
      <p>
        <strong>
          {preview.filename}: {count} tasks → {targetName}
        </strong>
      </p>
      <PreviewTable tasks={preview.tasks} review={review} />
      <label>
        <input type="checkbox" required /> I reviewed this file and want every
        task attached to {targetName}.
      </label>
    </AsyncForm>
  );
}

function PreviewTable(props: { tasks: TemplateTask[]; review: Review }) {
  const { tasks, review } = props;
  return (
    <>
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
            {tasks.slice(0, review.limit).map((t) => (
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
      {review.limit < tasks.length && (
        <button type="button" className="button" onClick={review.showMore}>
          Show more tasks
        </button>
      )}
    </>
  );
}

// Templates follow program maintenance permission and inspections their
// aircraft's; manuals need only read access to their aircraft.
function destinationChoices(s: Snapshot, kind: TargetKind, target: string) {
  const maintainsProgram = programPermission(s, "maintenance");
  const templates = (s.inspectionTemplates ?? []).filter(
    (t) => !t.archived && maintainsProgram,
  );
  const inspections = s.inspections.filter(
    (i) => !i.archived && can(s, i.aircraftUuid, "maintenance"),
  );
  const manuals = (s.manuals ?? []).filter((m) =>
    can(s, m.aircraftUuid, "read"),
  );
  const registration = (uuid: string) =>
    s.aircraft.find((a) => a.uuid === uuid)?.registration;
  const template =
    kind === "template" ? templates.find((t) => t.uuid === target) : undefined;
  const inspection =
    kind === "template"
      ? undefined
      : inspections.find((i) => i.uuid === target);
  const parent = template ?? inspection;
  const targetName = template ? template.name : inspection?.reference;
  return { templates, inspections, manuals, registration, parent, targetName };
}

function importInput(destination: Destination, csv: string): TaskCsvImport {
  return {
    csv,
    targetKind: destination.kind,
    targetUuid: destination.target,
    targetVersion: destination.parent?.version ?? 0,
    manualUuid: destination.manual || undefined,
    reviewed: true,
  };
}

async function readTaskFile(
  file: FormDataEntryValue | null,
  manualUuid: string,
  manuals: Manual[],
) {
  // The file's bytes, the unit parseTaskCsv checks again after decoding.
  if (!(file instanceof File) || !file.size || file.size > CSV_MAX_BYTES)
    throw new Error("Choose a UTF-8 CSV up to 2 MiB.");
  const csv = new TextDecoder("utf-8", { fatal: true }).decode(
    await file.arrayBuffer(),
  );
  const tasks = parseTaskCsv(csv);
  if (manualUuid)
    assertPagesInManual(
      tasks,
      manuals.find((m) => m.uuid === manualUuid),
    );
  return { csv, tasks, name: file.name };
}

function assertPagesInManual(tasks: TemplateTask[], manual?: Manual): void {
  if (!manual) throw new Error("Selected manual is unavailable.");
  for (const t of tasks)
    if (!t.pdfPage || t.pdfPage > manual.pageCount)
      throw new Error(
        `Task ${t.itemCode}: PDF page must be between 1 and ${manual.pageCount}.`,
      );
}

function downloadCsvFormat() {
  download(
    "tasks-for-one-target.csv",
    taskCsvHeaders.join(",") + "\r\n",
    "text/csv;charset=utf-8",
  );
}
