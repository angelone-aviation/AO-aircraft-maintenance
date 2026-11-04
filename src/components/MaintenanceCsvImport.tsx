/**
 * Responsibility: The maintenance CSV import from a manual: header templates
 *   and extraction instructions, validation and preview, and per-row record,
 *   template and job-card forms.
 * Layer: UI. React components; parsing and checks live in
 *   src/domain/maintenanceCsv.ts.
 * Dependencies: react, react-dom, src/data/store.ts, src/domain
 *   (inspectionTemplates, programs, model, manuals, manualDiscovery,
 *   maintenanceCsv, taskCards, csv), ./TaskCsvImport, ./InspectionTemplates,
 *   ./ManualDiscovery, ./Manuals, ./ui.
 */
import { TaskCsvImportButton } from "./TaskCsvImport";
import { TemplateEditor } from "./InspectionTemplates";
import {
  templateFromCandidate,
  type InspectionTemplate,
} from "../domain/inspectionTemplates";
import { programPermission } from "../domain/programs";
import { useState } from "react";
import { createPortal } from "react-dom";
import { useWorkspace } from "../data/store";
import { can, type Snapshot } from "../domain/model";
import type { Manual, ManualApplicability } from "../domain/manuals";
import {
  manualApplicability,
  type ManualCandidate,
} from "../domain/manualDiscovery";
import {
  csvSourceKey,
  importHeaders,
  parseMaintenanceCsv,
  type ImportedTask,
  type ImportBatch,
  type ImportKind,
} from "../domain/maintenanceCsv";
import { taskCardDefaults, type TaskCardCommand } from "../domain/taskCards";
import { toCsv } from "../domain/csv";
import {
  ApplicabilityEditor,
  CandidateForm,
  ReviewConfirmation,
} from "./ManualDiscovery";
import { ManualLink } from "./Manuals";
import { AsyncForm, Field, Modal, download, value } from "./ui";

const IMPORT_KINDS = Object.keys(importHeaders) as ImportKind[];
// readCsvRows refuses larger files; checking first spares reading them.
const MAX_CSV_BYTES = 2 * 1024 * 1024;
// Rows of each table, and errors, shown at once.
const ROWS_PER_PAGE = 100;
const ERRORS_SHOWN = 100;
// The task-card schema's text limit.
const TASK_TEXT_MAX = 10000;
// A suggested task title: the item code and the start of the instruction.
const TITLE_INSTRUCTION_CHARS = 120;
const TITLE_CHARS = 200;
const SAVED =
  "Saved. You can continue with the other rows; tasks become available after their parent is saved.";

type CandidateAction = "inspection" | "component" | "requirement";
type Selection = { row: ManualCandidate; action: CandidateAction };
type TaskParent = {
  uuid: string;
  aircraftUuid: string;
  componentUuid: string;
  label: string;
};

/**
 * The "Import maintenance CSV" button on a manual, opening the import in a
 * dialog. Loading files creates nothing; each record is saved from its row.
 *
 * @param props.manual - The manual the CSV files were extracted from.
 * @returns The button, disabled without a connection or maintenance access
 *   to the manual's aircraft, and the dialog.
 */
export function MaintenanceCsvImportButton({ manual }: { manual: Manual }) {
  const [open, setOpen] = useState(false);
  const { snapshot: s, online, connected } = useWorkspace();
  return (
    <>
      <button
        type="button"
        className="button"
        disabled={
          !online || !connected || !can(s!, manual.aircraftUuid, "maintenance")
        }
        onClick={() => setOpen(true)}
      >
        Import maintenance CSV
      </button>
      {open &&
        createPortal(
          <Modal
            wide
            title="Import maintenance CSV"
            onClose={() => setOpen(false)}
          >
            <CsvImport manualUuid={manual.uuid} />
          </Modal>,
          document.body,
        )}
    </>
  );
}

function CsvImport({ manualUuid }: { manualUuid: string }) {
  const csv = useCsvImport(manualUuid);
  if (!csv) return <p>Manual is unavailable in this Flight Program.</p>;
  const { manual, scope, batch } = csv;
  return (
    <>
      <TemplateDialog csv={csv} />
      <ImportIntro manual={manual} />
      <ScopeLine csv={csv} />
      {(csv.editScope || !scope) && (
        <ApplicabilityEditor
          manual={manual}
          scope={scope}
          onDone={() => csv.setEditScope(false)}
        />
      )}
      <CsvFilesForm csv={csv} />
      <CsvErrors errors={csv.errors} />
      {csv.saved && <p role="status">{csv.saved}</p>}
      {batch && scope && (
        <ImportPreview csv={csv} batch={batch} scope={scope} />
      )}
    </>
  );
}

// The import's state: the preview, its filter and page size, and the row
// form, template or applicability editor that is open.
function useCsvImport(manualUuid: string) {
  const { snapshot, online, connected } = useWorkspace();
  const s = snapshot!;
  const manual = s.manuals?.find((m) => m.uuid === manualUuid);
  const [template, setTemplate] = useState<InspectionTemplate>();
  const [batch, setBatch] = useState<ImportBatch>();
  const [errors, setErrors] = useState<string[]>([]);
  const [selected, setSelected] = useState<Selection>();
  const [task, setTask] = useState<ImportedTask>();
  const [filter, setFilter] = useState("");
  const [saved, setSaved] = useState("");
  const [editScope, setEditScope] = useState(false);
  const [limit, setLimit] = useState(ROWS_PER_PAGE);
  if (!manual) return undefined;
  const aircraft = s.aircraft.find((a) => a.uuid === manual.aircraftUuid);
  return {
    ...{ s, manual, scope: manualApplicability(manual, aircraft) },
    writable: online && connected && can(s, manual.aircraftUuid, "maintenance"),
    ...{ template, setTemplate, batch, setBatch, errors, setErrors },
    ...{ selected, setSelected, task, setTask, filter, setFilter },
    ...{ saved, setSaved, editScope, setEditScope, limit, setLimit },
    done: () => {
      setSaved(SAVED);
      setSelected(undefined);
      setTask(undefined);
    },
    matches: (text: string) =>
      text.toLowerCase().includes(filter.toLowerCase()),
  };
}

type CsvState = NonNullable<ReturnType<typeof useCsvImport>>;

function TemplateDialog({ csv }: { csv: CsvState }) {
  if (!csv.template) return null;
  return (
    <Modal
      wide
      title="Save CSV as template"
      onClose={() => csv.setTemplate(undefined)}
    >
      <TemplateEditor
        record={csv.template}
        onDone={() => {
          csv.setTemplate(undefined);
          csv.setSaved(
            "Template saved with intervals and linked checklist tasks. No compliance history was required.",
          );
        }}
      />
    </Modal>
  );
}

function ImportIntro({ manual }: { manual: Manual }) {
  return (
    <>
      <h3>
        {manual.title} · {manual.revision}
      </h3>
      <p>
        1. Download templates and AI instructions. 2. Load the completed files.
        3. Review each row and choose a target before saving. Loading CSVs does
        not create records. Unsaved rows remain here until this window closes.
      </p>
      <TaskCsvImportButton
        initialManual={manual.uuid}
        label="Import task file to one template or inspection"
      />
      <ImportDownloads manual={manual} />
    </>
  );
}

function ImportDownloads({ manual }: { manual: Manual }) {
  return (
    <div className="management-actions">
      {IMPORT_KINDS.map((k) => (
        <button
          type="button"
          className="button"
          key={k}
          onClick={() => saveText(`${k}.csv`, headerCsv(k))}
        >
          Download {k} template
        </button>
      ))}
      <button
        type="button"
        className="button"
        onClick={() =>
          saveText("maintenance-csv-ai-instructions.txt", instructions(manual))
        }
      >
        Download AI instructions
      </button>
    </div>
  );
}

// Editing the model association closes any open row form first.
function ScopeLine({ csv }: { csv: CsvState }) {
  const { scope } = csv;
  return (
    <p>
      Associated {scope?.kind ?? ""} model:{" "}
      {scope ? `${scope.manufacturer} ${scope.model}` : "Not set"}.{" "}
      <button
        type="button"
        className="button"
        disabled={!csv.writable}
        onClick={() => {
          csv.setSelected(undefined);
          csv.setTask(undefined);
          csv.setEditScope(!csv.editScope);
        }}
      >
        Edit model association
      </button>
    </p>
  );
}

// A new preview replaces the previous one, and any error leaves no rows.
function CsvFilesForm({ csv }: { csv: CsvState }) {
  return (
    <AsyncForm
      disabled={!csv.writable || csv.editScope || !csv.scope}
      submitLabel="Validate and preview CSVs"
      onSubmit={async (d) => {
        csv.setBatch(undefined);
        csv.setSelected(undefined);
        csv.setTask(undefined);
        csv.setSaved("");
        csv.setErrors([]);
        const next = parseMaintenanceCsv(await readCsvFiles(d), csv.manual);
        next.errors.push(...orphanTaskErrors(next, csv.s, csv.manual));
        if (next.errors.length) {
          csv.setErrors(next.errors);
          return;
        }
        csv.setBatch(next);
        csv.setLimit(ROWS_PER_PAGE);
      }}
    >
      <div className="form-grid">
        {IMPORT_KINDS.map((k) => (
          <Field key={k} label={`${k[0].toUpperCase()}${k.slice(1)} CSV`}>
            <input type="file" name={k} accept=".csv,text/csv" />
          </Field>
        ))}
      </div>
      <p className="muted">
        UTF-8 CSV, up to 2 MB / 2,000 records per file. You may load one or
        several files together. A new preview replaces the previous unsaved
        preview.
      </p>
    </AsyncForm>
  );
}

function CsvErrors({ errors }: { errors: string[] }) {
  if (!errors.length) return null;
  return (
    <div role="alert">
      <p>
        {errors.length} errors. No rows were loaded. Correct the files and try
        again.
      </p>
      <ul>
        {errors.slice(0, ERRORS_SHOWN).map((e, i) => (
          <li key={i}>{e}</li>
        ))}
      </ul>
      {errors.length > ERRORS_SHOWN && <p>Showing the first 100 errors.</p>}
    </div>
  );
}

type PreviewProps = {
  csv: CsvState;
  batch: ImportBatch;
  scope: ManualApplicability;
};

function ImportPreview({ csv, batch, scope }: PreviewProps) {
  const largest = Math.max(
    batch.inspections.length,
    batch.components.length,
    batch.tasks.length,
  );
  return (
    <>
      <p role="status">
        Ready for review: {batch.inspections.length} inspections,{" "}
        {batch.components.length} component requirements, {batch.tasks.length}{" "}
        tasks.
      </p>
      <FilterField csv={csv} />
      {(["inspections", "components"] as const).map((kind) => (
        <CandidateTable
          key={kind}
          kind={kind}
          csv={csv}
          batch={batch}
          scope={scope}
        />
      ))}
      <TaskTable csv={csv} batch={batch} />
      {largest > csv.limit && (
        <button
          type="button"
          className="button"
          onClick={() => csv.setLimit((n) => n + ROWS_PER_PAGE)}
        >
          Show more imported rows
        </button>
      )}
    </>
  );
}

function FilterField({ csv }: { csv: CsvState }) {
  return (
    <Field label="Filter imported rows">
      <input
        value={csv.filter}
        onChange={(e) => csv.setFilter(e.target.value)}
      />
    </Field>
  );
}

type CandidateKind = "inspections" | "components";

function CandidateTable(props: PreviewProps & { kind: CandidateKind }) {
  const { kind, csv, batch } = props;
  const rows = batch[kind]
    .filter((r) => csv.matches(`${r.importId} ${r.name} ${r.text}`))
    .slice(0, csv.limit);
  return (
    <section>
      <h3>
        {kind === "inspections"
          ? "Inspection candidates"
          : "Component and service candidates"}
      </h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID / name</th>
              <th>Limits / conditions</th>
              <th>Source</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <CandidateRow key={row.sourceKey} {...props} row={row} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

type RowProps = PreviewProps & { kind: CandidateKind; row: ManualCandidate };

function CandidateRow(props: RowProps) {
  const { row, csv } = props;
  return (
    <>
      <tr>
        <td>
          <strong>{row.name}</strong>
          <small className="block">{row.importId}</small>
          <details>
            <summary>Description</summary>
            <p style={{ whiteSpace: "pre-wrap" }}>{row.text}</p>
          </details>
        </td>
        <CandidateLimits row={row} />
        <td>
          <ManualLink reference={row.reference} />
        </td>
        <CandidateActions {...props} />
      </tr>
      {csv.selected?.row.sourceKey === row.sourceKey && (
        <CandidateFormRow {...props} selected={csv.selected} />
      )}
    </>
  );
}

function CandidateFormRow({
  row,
  csv,
  scope,
  selected,
}: RowProps & { selected: Selection }) {
  return (
    <tr>
      <td colSpan={4}>
        <section className="panel" aria-label="CSV record form">
          <button
            type="button"
            className="button"
            onClick={() => csv.setSelected(undefined)}
          >
            Close record form
          </button>
          <CandidateForm
            key={`${row.sourceKey}:${selected.action}`}
            row={row}
            scope={scope}
            action={selected.action}
            onDone={csv.done}
          />
        </section>
      </td>
    </tr>
  );
}

// A requirement's own calendar interval replaces the months repeat.
function CandidateLimits({ row }: { row: ManualCandidate }) {
  const defaults = row.requirementDefaults;
  return (
    <td>
      {row.initialHours !== undefined && (
        <div>Initial: {row.initialHours} hours</div>
      )}
      {row.initialCycles !== undefined && (
        <div>Initial: {row.initialCycles} cycles</div>
      )}
      {row.hours !== undefined && <div>{row.hours} hours</div>}
      {row.cycles !== undefined && <div>{row.cycles} cycles</div>}
      {defaults?.calendarIntervalValue !== undefined ? (
        <div>
          {defaults.calendarIntervalValue} {defaults.calendarIntervalUnit}
        </div>
      ) : (
        row.months !== undefined && <div>{row.months} months</div>
      )}
      <p>
        {row.scheduleText ||
          "Verify applicability and schedule against the manual."}
      </p>
    </td>
  );
}

// Only an aircraft-model manual creates inspections, which belong to an
// aircraft; templates need program maintenance access.
function CandidateActions({ kind, row, csv, batch, scope }: RowProps) {
  const blocked = !csv.writable || csv.editScope;
  const select = (action: CandidateAction) => {
    csv.setTask(undefined);
    csv.setSelected({ row, action });
  };
  return (
    <td>
      <button
        type="button"
        className="button"
        disabled={blocked || !programPermission(csv.s, "maintenance")}
        onClick={() =>
          csv.setTemplate(templateFromCandidate(row, scope, batch.tasks))
        }
      >
        Save as template
      </button>
      {kind === "inspections" ? (
        <button
          type="button"
          className="button"
          disabled={blocked || scope.kind !== "aircraft"}
          onClick={() => select("inspection")}
        >
          Create inspection
        </button>
      ) : (
        <ComponentActions disabled={blocked} onSelect={select} />
      )}
    </td>
  );
}

function ComponentActions({
  disabled,
  onSelect,
}: {
  disabled: boolean;
  onSelect: (action: CandidateAction) => void;
}) {
  return (
    <>
      <button
        type="button"
        className="button"
        disabled={disabled}
        onClick={() => onSelect("component")}
      >
        Create component
      </button>
      <button
        type="button"
        className="button"
        disabled={disabled}
        onClick={() => onSelect("requirement")}
      >
        Add service requirement
      </button>
    </>
  );
}

function TaskTable({ csv, batch }: { csv: CsvState; batch: ImportBatch }) {
  const tasks = batch.tasks
    .filter((t) =>
      csv.matches(`${t.id} ${t.itemCode} ${t.parentId} ${t.instruction}`),
    )
    .slice(0, csv.limit);
  return (
    <>
      <h3>Tasks</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID / code</th>
              <th>Parent / instruction</th>
              <th>Source</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <TaskRow key={t.id} task={t} csv={csv} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

type TaskRowProps = { task: ImportedTask; csv: CsvState };

function TaskRow({ task: t, csv }: TaskRowProps) {
  return (
    <>
      <tr>
        <td>
          {t.id}
          <small className="block">{t.itemCode}</small>
        </td>
        <td>
          {t.parentType}: {t.parentId}
          <p>{t.instruction}</p>
          <small>{t.applicability}</small>
        </td>
        <td>
          <ManualLink reference={t.reference} />
        </td>
        <td>
          <button
            type="button"
            className="button"
            disabled={!csv.writable || csv.editScope}
            onClick={() => {
              csv.setSelected(undefined);
              csv.setTask(t);
            }}
          >
            Create job card template
          </button>
        </td>
      </tr>
      {csv.task?.id === t.id && <TaskFormRow task={t} csv={csv} />}
    </>
  );
}

function TaskFormRow({ task: t, csv }: TaskRowProps) {
  return (
    <tr>
      <td colSpan={4}>
        <section className="panel" aria-label="CSV task form">
          <button
            type="button"
            className="button"
            onClick={() => csv.setTask(undefined)}
          >
            Close task form
          </button>
          <CsvTaskForm
            key={t.id}
            task={t}
            manual={csv.manual}
            onDone={csv.done}
          />
        </section>
      </td>
    </tr>
  );
}

type CsvTaskFormProps = {
  task: ImportedTask;
  manual: Manual;
  onDone: () => void;
};

// A task becomes a draft job card on one saved parent the user maintains,
// once per parent.
function CsvTaskForm({ task, manual, onDone }: CsvTaskFormProps) {
  const { snapshot, backend, online, connected } = useWorkspace();
  const s = snapshot!;
  const allowed = taskParents(s, task, manual).filter((p) =>
    can(s, p.aircraftUuid, "maintenance"),
  );
  const [parentId, setParentId] = useState("");
  const [uuid] = useState(() => crypto.randomUUID());
  const parent = allowed.find((p) => p.uuid === parentId);
  const duplicate = importedBefore(s, task, parentId);
  return (
    <>
      <TaskFormNotices orphan={!allowed.length} duplicate={duplicate} />
      <AsyncForm
        disabled={!online || !connected || !allowed.length}
        submitLabel="Save draft task"
        onSubmit={async (d) => {
          if (!parent) throw new Error("Choose the saved parent record.");
          if (duplicate)
            throw new Error(
              "This task has already been imported for this parent.",
            );
          await backend!.taskCard(taskCard(uuid, task, manual, parent, d));
          onDone();
        }}
      >
        <TaskFormFields
          task={task}
          parents={allowed}
          aircraft={s.aircraft}
          parentId={parentId}
          onParent={setParentId}
        />
      </AsyncForm>
    </>
  );
}

function TaskFormNotices({
  orphan,
  duplicate,
}: {
  orphan: boolean;
  duplicate: boolean | undefined;
}) {
  return (
    <>
      <h3>Create job card template</h3>
      {orphan && (
        <p>
          Save the parent inspection or component requirement first. Component
          tasks require an installed component on an accessible aircraft.
        </p>
      )}
      {duplicate && (
        <p>This task has already been imported for the selected parent.</p>
      )}
    </>
  );
}

function TaskFormFields({
  task,
  parents,
  aircraft,
  parentId,
  onParent,
}: {
  task: ImportedTask;
  parents: TaskParent[];
  aircraft: Snapshot["aircraft"];
  parentId: string;
  onParent: (uuid: string) => void;
}) {
  return (
    <>
      <Field label="Saved parent record">
        <select
          value={parentId}
          onChange={(e) => onParent(e.target.value)}
          required
        >
          <option value="">Select parent and aircraft</option>
          {parents.map((p) => (
            <option key={p.uuid} value={p.uuid}>
              {aircraft.find((a) => a.uuid === p.aircraftUuid)?.registration} ·{" "}
              {p.label}
            </option>
          ))}
        </select>
      </Field>
      <ReviewConfirmation />
      <TaskTextFields task={task} />
    </>
  );
}

function TaskTextFields({ task }: { task: ImportedTask }) {
  return (
    <>
      <Field label="Task title">
        <input
          name="title"
          defaultValue={taskTitle(task)}
          maxLength={TASK_TEXT_MAX}
          required
        />
      </Field>
      <Field label="Task instruction">
        <textarea
          name="instruction"
          defaultValue={task.instruction}
          maxLength={TASK_TEXT_MAX}
          required
        />
      </Field>
      <Field label="Task applicability">
        <textarea
          name="applicability"
          defaultValue={task.applicability}
          maxLength={TASK_TEXT_MAX}
        />
      </Field>
      <ManualLink reference={task.reference} />
      <p>
        Saved as draft with an unsigned step and empty execution results. Set
        any additional measurements, limits or signoff requirements in Task
        cards.
      </p>
    </>
  );
}

function headerCsv(kind: ImportKind) {
  const blank = Object.fromEntries(importHeaders[kind].map((h) => [h, ""]));
  return toCsv([blank]).split("\r\n")[0] + "\r\n";
}

function saveText(name: string, text: string) {
  const type = name.endsWith(".csv")
    ? "text/csv;charset=utf-8"
    : "text/plain;charset=utf-8";
  download(name, text, type);
}

async function readCsvFiles(d: FormData) {
  const files: Partial<Record<ImportKind, string>> = {};
  for (const k of IMPORT_KINDS) {
    const file = d.get(k);
    if (!(file instanceof File) || !file.size) continue;
    if (file.size > MAX_CSV_BYTES)
      throw new Error(`${k}: use a CSV file up to 2 MB.`);
    files[k] = await decodeUtf8(k, file);
  }
  if (!Object.keys(files).length)
    throw new Error("Choose at least one CSV file.");
  return files;
}

// A fatal decoder refuses a file that is not UTF-8 instead of reading it with
// replacement characters; the refusal names the fix.
async function decodeUtf8(kind: ImportKind, file: File) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await file.arrayBuffer(),
    );
  } catch {
    throw new Error(`${kind}: save the CSV as UTF-8.`);
  }
}

// A task's parent must be in this import or already saved from this manual.
function orphanTaskErrors(batch: ImportBatch, s: Snapshot, manual: Manual) {
  return batch.tasks
    .filter((t) => !parentPresent(batch, s, manual, t))
    .map(
      (t) =>
        `Task ${t.id}: parent ${t.parentId} was not found. Include its parent CSV or first save that parent from this manual.`,
    );
}

// An inspection created for a row's initial threshold, rather than its
// repeat interval, is keyed "<key>:initial".
function parentPresent(
  batch: ImportBatch,
  s: Snapshot,
  manual: Manual,
  t: ImportedTask,
) {
  const key = csvSourceKey(manual.uuid, t.parentType, t.parentId);
  if (t.parentType === "inspection")
    return (
      batch.inspections.some((r) => r.sourceKey === key) ||
      s.inspections.some(
        (r) => r.sourceKey === key || r.sourceKey === key + ":initial",
      )
    );
  return (
    batch.components.some((r) => r.sourceKey === key) ||
    s.management?.some(
      (r) => r.kind === "componentRequirement" && r.sourceKey === key,
    )
  );
}

// The saved records a task can attach to: live inspections from this row, or
// this row's requirements on installed components.
function taskParents(
  s: Snapshot,
  task: ImportedTask,
  manual: Manual,
): TaskParent[] {
  const key = csvSourceKey(manual.uuid, task.parentType, task.parentId);
  if (task.parentType === "inspection")
    return s.inspections
      .filter(
        (i) =>
          !i.archived &&
          (i.sourceKey === key || i.sourceKey === key + ":initial"),
      )
      .map((i) => ({
        uuid: i.uuid,
        aircraftUuid: i.aircraftUuid,
        componentUuid: i.componentUuid ?? "",
        label:
          i.reference + (i.sourceKey?.endsWith(":initial") ? " (initial)" : ""),
      }));
  return (s.management ?? []).flatMap((r) =>
    r.kind === "componentRequirement" && r.sourceKey === key
      ? requirementParent(s, r)
      : [],
  );
}

type Requirement = Extract<
  NonNullable<Snapshot["management"]>[number],
  { kind: "componentRequirement" }
>;

function requirementParent(s: Snapshot, r: Requirement): TaskParent[] {
  const c = s.management?.find(
    (c) => c.kind === "component" && c.uuid === r.componentUuid,
  );
  if (c?.kind !== "component" || !c.installed) return [];
  return [
    {
      uuid: r.uuid,
      aircraftUuid: c.aircraftUuid,
      componentUuid: c.uuid,
      label: `${r.description} · ${c.serial || c.partNumber}`,
    },
  ];
}

function importedBefore(s: Snapshot, task: ImportedTask, parentId: string) {
  return s.taskCards?.some(
    (t) =>
      t.sourceKey === task.sourceKey &&
      (task.parentType === "inspection"
        ? t.inspectionUuid === parentId
        : t.requirementUuid === parentId),
  );
}

function taskTitle(task: ImportedTask) {
  return task.itemCode
    ? `${task.itemCode}: ${task.instruction.slice(0, TITLE_INSTRUCTION_CHARS)}`
    : task.instruction.slice(0, TITLE_CHARS);
}

// The draft card links its parent, the manual page and revision, and has no
// steps until someone adds them in Task cards.
function taskCard(
  uuid: string,
  task: ImportedTask,
  manual: Manual,
  parent: TaskParent,
  d: FormData,
): TaskCardCommand {
  const instruction = value(d, "instruction");
  const inspection = task.parentType === "inspection";
  return {
    action: "save",
    uuid,
    version: 0,
    fields: {
      ...taskCardDefaults(parent.aircraftUuid),
      sourceKey: task.sourceKey,
      title: value(d, "title"),
      description: instruction,
      applicability: value(d, "applicability"),
      inspectionUuid: inspection ? parent.uuid : "",
      requirementUuid:
        task.parentType === "component_requirement" ? parent.uuid : "",
      componentUuid: parent.componentUuid,
      manualReference: task.reference,
      maintenanceReference: [task.itemCode, task.reference.section]
        .filter(Boolean)
        .join(" · "),
      referenceRevision: manual.revision,
      referenceDate: manual.revisionDate,
      steps: [],
    },
  };
}

function instructions(manual: Manual) {
  return `MAINTENANCE CSV EXTRACTION — FORMAT V1
Source manual: ${manual.title}
Document: ${manual.documentNumber}
Revision: ${manual.revision}
Original PDF pages: ${manual.pageCount}

Extract only the chapter/pages supplied. Return three separate UTF-8 comma-delimited CSV files with the EXACT headers below. Do not return Markdown tables. Quote fields containing commas, quotes or newlines; escape quotes by doubling them. Preserve task ordering in the tasks file.
${Object.entries(importHeaders)
  .map(([kind, headers]) => `\n${kind}.csv\n${headers.join(",")}`)
  .join("\n")}

RULES
- Use stable IDs (1–80 letters, digits, dot, underscore or hyphen), e.g. phase-2, oxygen-limit, phase-2-A243003. Never reuse an ID for a different item. Use the same IDs on repeat exports. IDs are unique within each file.
- inspections: one row per inspection package. description is a concise summary (max 1,800 characters); put each checklist task in tasks.csv. name max 200. initial_hours/initial_cycles describe first thresholds only; repeat_* describe recurring intervals only. Leave unknown values blank. Do not invent calendar equivalents for event-triggered rules.
- components: one row per component requirement; no invented installed components, serial numbers, locations or usage history. name max 100, description plus conditions max 10,000. component_model and part_number are the COMPONENT identity, not the aircraft model. Leave unknown identity blank. requirement_type must be life_limit, overhaul or inspection. time_basis must be TSN, TSO or TSR. hour_mode and cycle_mode must be ABSOLUTE or FROM_LAST_COMPLIED. calendar_unit must be DAYS, MONTHS or YEARS. If a basis is unresolved, leave the corresponding numeric limit blank, use TSN / FROM_LAST_COMPLIED / MONTHS as placeholders and explain the uncertainty in conditions.
- tasks: one row per task, linked by parent_type (inspection or component_requirement) and parent_id to the corresponding CSV id. item_code is the manual task code; instruction contains the task (max 9,000 characters); applicability preserves model, part, serial or equipment restrictions (max 1,000). No execution results, measurements taken, signatures or completion data. Each imported task becomes its own draft job card linked to the saved parent.
- Positive numeric values only, without units or thousands separators. Hours have at most one decimal place; cycles and calendar values are whole numbers. Blank means unknown; never use 0 or N/A for missing values.
- conditions must retain whichever-occurs-first rules, program alternatives, first-versus-repeat rules, external references and restrictions. Inspections description plus conditions must fit 2,000 characters; component conditions max 2,000.
- The app handles simple limits using the first reached dimension. If a rule uses whichever-is-later, conditional alternatives, sequencing, shelf/manufacture age or cannot be represented exactly, leave the affected numeric fields blank and explain the full rule in conditions. Do not simplify such rules into ordinary recurrence.
- Every row needs pdf_page (1-based page in the ORIGINAL uploaded manual), section and printed_page (these latter two may be blank if unknown). If given a chapter-only PDF, ask for its original PDF starting page and apply that offset. Never guess the original page number.
- Do not extract headers, page footers, table-of-contents lines or general background paragraphs as records. Preserve required general inspection criteria in the inspection description or as separate linked task rows.
- Check for duplicate IDs, orphan task parent IDs and missing source pages. List unresolved issues separately. Do not claim complete coverage of pages you have not examined.
- Limit each CSV to 2 MB and 2,000 records. Split larger batches while keeping parent IDs stable. Do not truncate instructions to fit; flag them for human review.

The application loads candidates only. A human verifies applicability, selects actual aircraft/components, enters compliance history and saves each record. Never populate those operational fields from a manual.
`;
}
