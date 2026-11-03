import { TaskCsvImportButton } from "./TaskCsvImport";
import { TemplateEditor } from "./InspectionTemplates";
import {
  templateFromCandidate,
  type InspectionTemplate,
} from "../domain/inspectionTemplates";
import { programPermission } from "../domain/programs";
import { Fragment, useState } from "react";
import { createPortal } from "react-dom";
import { useWorkspace } from "../data/store";
import { can } from "../domain/model";
import type { Manual } from "../domain/manuals";
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
import { taskCardDefaults } from "../domain/taskCards";
import { toCsv } from "../domain/csv";
import {
  ApplicabilityEditor,
  CandidateForm,
  ReviewConfirmation,
} from "./ManualDiscovery";
import { ManualLink } from "./Manuals";
import { AsyncForm, Field, Modal, value } from "./ui";

function download(name: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], {
      type: name.endsWith(".csv")
        ? "text/csv;charset=utf-8"
        : "text/plain;charset=utf-8",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  const { snapshot: s, online, connected } = useWorkspace();
  const manual = s!.manuals?.find((m) => m.uuid === manualUuid);
  const [template, setTemplate] = useState<InspectionTemplate>();
  const [batch, setBatch] = useState<ImportBatch>();
  const [errors, setErrors] = useState<string[]>([]);
  const [selected, setSelected] = useState<{
    row: ManualCandidate;
    action: "inspection" | "component" | "requirement";
  }>();
  const [task, setTask] = useState<ImportedTask>();
  const [filter, setFilter] = useState("");
  const [saved, setSaved] = useState("");
  const [editScope, setEditScope] = useState(false);
  const [limit, setLimit] = useState(100);
  if (!manual) return <p>Manual is unavailable in this Flight Program.</p>;
  const scope = manualApplicability(
    manual,
    s!.aircraft.find((a) => a.uuid === manual.aircraftUuid),
  );
  const writable =
    online && connected && can(s!, manual.aircraftUuid, "maintenance");
  const done = () => {
    setSaved(
      "Saved. You can continue with the other rows; tasks become available after their parent is saved.",
    );
    setSelected(undefined);
    setTask(undefined);
  };
  const matches = (text: string) =>
    text.toLowerCase().includes(filter.toLowerCase());
  return (
    <>
      {template && (
        <Modal
          wide
          title="Save CSV as template"
          onClose={() => setTemplate(undefined)}
        >
          <TemplateEditor
            record={template}
            onDone={() => {
              setTemplate(undefined);
              setSaved(
                "Template saved with intervals and linked checklist tasks. No compliance history was required.",
              );
            }}
          />
        </Modal>
      )}
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
      <div className="management-actions">
        {(Object.keys(importHeaders) as ImportKind[]).map((k) => (
          <button
            type="button"
            className="button"
            key={k}
            onClick={() =>
              download(
                `${k}.csv`,
                toCsv([
                  Object.fromEntries(importHeaders[k].map((h) => [h, ""])),
                ]).split("\r\n")[0] + "\r\n",
              )
            }
          >
            Download {k} template
          </button>
        ))}
        <button
          type="button"
          className="button"
          onClick={() =>
            download(
              "maintenance-csv-ai-instructions.txt",
              instructions(manual),
            )
          }
        >
          Download AI instructions
        </button>
      </div>
      <p>
        Associated {scope?.kind ?? ""} model:{" "}
        {scope ? `${scope.manufacturer} ${scope.model}` : "Not set"}.{" "}
        <button
          type="button"
          className="button"
          disabled={!writable}
          onClick={() => {
            setSelected(undefined);
            setTask(undefined);
            setEditScope(!editScope);
          }}
        >
          Edit model association
        </button>
      </p>
      {(editScope || !scope) && (
        <ApplicabilityEditor
          manual={manual}
          scope={scope}
          onDone={() => setEditScope(false)}
        />
      )}
      <AsyncForm
        disabled={!writable || editScope || !scope}
        submitLabel="Validate and preview CSVs"
        onSubmit={async (d) => {
          setBatch(undefined);
          setSelected(undefined);
          setTask(undefined);
          setSaved("");
          setErrors([]);
          const files: Partial<Record<ImportKind, string>> = {};
          for (const k of Object.keys(importHeaders) as ImportKind[]) {
            const file = d.get(k);
            if (!(file instanceof File) || !file.size) continue;
            if (file.size > 2 * 1024 * 1024)
              throw new Error(`${k}: use a CSV file up to 2 MB.`);
            try {
              files[k] = new TextDecoder("utf-8", { fatal: true }).decode(
                await file.arrayBuffer(),
              );
            } catch {
              throw new Error(`${k}: save the CSV as UTF-8.`);
            }
          }
          if (!Object.keys(files).length)
            throw new Error("Choose at least one CSV file.");
          const next = parseMaintenanceCsv(files, manual);
          for (const t of next.tasks) {
            const key = csvSourceKey(manual.uuid, t.parentType, t.parentId);
            const parentPresent =
              t.parentType === "inspection"
                ? next.inspections.some((r) => r.sourceKey === key) ||
                  s!.inspections.some(
                    (r) =>
                      r.sourceKey === key || r.sourceKey === key + ":initial",
                  )
                : next.components.some((r) => r.sourceKey === key) ||
                  s!.management?.some(
                    (r) =>
                      r.kind === "componentRequirement" && r.sourceKey === key,
                  );
            if (!parentPresent)
              next.errors.push(
                `Task ${t.id}: parent ${t.parentId} was not found. Include its parent CSV or first save that parent from this manual.`,
              );
          }
          if (next.errors.length) {
            setErrors(next.errors);
            return;
          }
          setBatch(next);
          setLimit(100);
        }}
      >
        <div className="form-grid">
          {(Object.keys(importHeaders) as ImportKind[]).map((k) => (
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
      {!!errors.length && (
        <div role="alert">
          <p>
            {errors.length} errors. No rows were loaded. Correct the files and
            try again.
          </p>
          <ul>
            {errors.slice(0, 100).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
          {errors.length > 100 && <p>Showing the first 100 errors.</p>}
        </div>
      )}
      {saved && <p role="status">{saved}</p>}
      {batch && scope && (
        <>
          <p role="status">
            Ready for review: {batch.inspections.length} inspections,{" "}
            {batch.components.length} component requirements,{" "}
            {batch.tasks.length} tasks.
          </p>
          <Field label="Filter imported rows">
            <input value={filter} onChange={(e) => setFilter(e.target.value)} />
          </Field>
          {(["inspections", "components"] as const).map((kind) => (
            <section key={kind}>
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
                    {batch[kind]
                      .filter((r) =>
                        matches(`${r.importId} ${r.name} ${r.text}`),
                      )
                      .slice(0, limit)
                      .map((row) => (
                        <Fragment key={row.sourceKey}>
                          <tr>
                            <td>
                              <strong>{row.name}</strong>
                              <small className="block">{row.importId}</small>
                              <details>
                                <summary>Description</summary>
                                <p style={{ whiteSpace: "pre-wrap" }}>
                                  {row.text}
                                </p>
                              </details>
                            </td>
                            <td>
                              {row.initialHours !== undefined && (
                                <div>Initial: {row.initialHours} hours</div>
                              )}
                              {row.initialCycles !== undefined && (
                                <div>Initial: {row.initialCycles} cycles</div>
                              )}
                              {row.hours !== undefined && (
                                <div>{row.hours} hours</div>
                              )}
                              {row.cycles !== undefined && (
                                <div>{row.cycles} cycles</div>
                              )}
                              {row.requirementDefaults
                                ?.calendarIntervalValue !== undefined ? (
                                <div>
                                  {
                                    row.requirementDefaults
                                      .calendarIntervalValue
                                  }{" "}
                                  {row.requirementDefaults.calendarIntervalUnit}
                                </div>
                              ) : (
                                row.months !== undefined && (
                                  <div>{row.months} months</div>
                                )
                              )}
                              <p>
                                {row.scheduleText ||
                                  "Verify applicability and schedule against the manual."}
                              </p>
                            </td>
                            <td>
                              <ManualLink reference={row.reference} />
                            </td>
                            <td>
                              <button
                                type="button"
                                className="button"
                                disabled={
                                  !writable ||
                                  editScope ||
                                  !programPermission(s!, "maintenance")
                                }
                                onClick={() =>
                                  setTemplate(
                                    templateFromCandidate(
                                      row,
                                      scope,
                                      batch.tasks,
                                    ),
                                  )
                                }
                              >
                                Save as template
                              </button>
                              {kind === "inspections" ? (
                                <button
                                  type="button"
                                  className="button"
                                  disabled={
                                    !writable ||
                                    editScope ||
                                    scope.kind !== "aircraft"
                                  }
                                  onClick={() => {
                                    setTask(undefined);
                                    setSelected({ row, action: "inspection" });
                                  }}
                                >
                                  Create inspection
                                </button>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    className="button"
                                    disabled={!writable || editScope}
                                    onClick={() => {
                                      setTask(undefined);
                                      setSelected({ row, action: "component" });
                                    }}
                                  >
                                    Create component
                                  </button>
                                  <button
                                    type="button"
                                    className="button"
                                    disabled={!writable || editScope}
                                    onClick={() => {
                                      setTask(undefined);
                                      setSelected({
                                        row,
                                        action: "requirement",
                                      });
                                    }}
                                  >
                                    Add service requirement
                                  </button>
                                </>
                              )}
                            </td>
                          </tr>
                          {selected?.row.sourceKey === row.sourceKey && (
                            <tr>
                              <td colSpan={4}>
                                <section
                                  className="panel"
                                  aria-label="CSV record form"
                                >
                                  <button
                                    type="button"
                                    className="button"
                                    onClick={() => setSelected(undefined)}
                                  >
                                    Close record form
                                  </button>
                                  <CandidateForm
                                    key={`${row.sourceKey}:${selected.action}`}
                                    row={row}
                                    scope={scope}
                                    action={selected.action}
                                    onDone={done}
                                  />
                                </section>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
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
                {batch.tasks
                  .filter((t) =>
                    matches(
                      `${t.id} ${t.itemCode} ${t.parentId} ${t.instruction}`,
                    ),
                  )
                  .slice(0, limit)
                  .map((t) => (
                    <Fragment key={t.id}>
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
                            disabled={!writable || editScope}
                            onClick={() => {
                              setSelected(undefined);
                              setTask(t);
                            }}
                          >
                            Create job card template
                          </button>
                        </td>
                      </tr>
                      {task?.id === t.id && (
                        <tr>
                          <td colSpan={4}>
                            <section
                              className="panel"
                              aria-label="CSV task form"
                            >
                              <button
                                type="button"
                                className="button"
                                onClick={() => setTask(undefined)}
                              >
                                Close task form
                              </button>
                              <CsvTaskForm
                                key={t.id}
                                task={t}
                                manual={manual}
                                onDone={done}
                              />
                            </section>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
              </tbody>
            </table>
          </div>
          {Math.max(
            batch.inspections.length,
            batch.components.length,
            batch.tasks.length,
          ) > limit && (
            <button
              type="button"
              className="button"
              onClick={() => setLimit((n) => n + 100)}
            >
              Show more imported rows
            </button>
          )}
        </>
      )}
    </>
  );
}
function CsvTaskForm({
  task,
  manual,
  onDone,
}: {
  task: ImportedTask;
  manual: Manual;
  onDone: () => void;
}) {
  const { snapshot: s, backend, online, connected } = useWorkspace();
  const key = csvSourceKey(manual.uuid, task.parentType, task.parentId);
  const parents =
    task.parentType === "inspection"
      ? s!.inspections
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
              i.reference +
              (i.sourceKey?.endsWith(":initial") ? " (initial)" : ""),
          }))
      : (s!.management ?? []).flatMap((r) => {
          if (r.kind !== "componentRequirement" || r.sourceKey !== key)
            return [];
          const c = s!.management?.find(
            (c) => c.kind === "component" && c.uuid === r.componentUuid,
          );
          return c?.kind === "component" && c.installed
            ? [
                {
                  uuid: r.uuid,
                  aircraftUuid: c.aircraftUuid,
                  componentUuid: c.uuid,
                  label: `${r.description} · ${c.serial || c.partNumber}`,
                },
              ]
            : [];
        });
  const allowed = parents.filter((p) => can(s!, p.aircraftUuid, "maintenance"));
  const [parentId, setParentId] = useState("");
  const [uuid] = useState(() => crypto.randomUUID());
  const parent = allowed.find((p) => p.uuid === parentId);
  const duplicate = s!.taskCards?.some(
    (t) =>
      t.sourceKey === task.sourceKey &&
      (task.parentType === "inspection"
        ? t.inspectionUuid === parentId
        : t.requirementUuid === parentId),
  );
  return (
    <>
      <h3>Create job card template</h3>
      {!allowed.length && (
        <p>
          Save the parent inspection or component requirement first. Component
          tasks require an installed component on an accessible aircraft.
        </p>
      )}
      {duplicate && (
        <p>This task has already been imported for the selected parent.</p>
      )}
      <AsyncForm
        disabled={!online || !connected || !allowed.length}
        submitLabel="Save draft task"
        onSubmit={async (d) => {
          if (!parent) throw new Error("Choose the saved parent record.");
          if (duplicate)
            throw new Error(
              "This task has already been imported for this parent.",
            );
          const instruction = value(d, "instruction");
          await backend!.taskCard({
            action: "save",
            uuid,
            version: 0,
            fields: {
              ...taskCardDefaults(parent.aircraftUuid),
              sourceKey: task.sourceKey,
              title: value(d, "title"),
              description: instruction,
              applicability: value(d, "applicability"),
              inspectionUuid:
                task.parentType === "inspection" ? parent.uuid : "",
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
          });
          onDone();
        }}
      >
        <Field label="Saved parent record">
          <select
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
            required
          >
            <option value="">Select parent and aircraft</option>
            {allowed.map((p) => (
              <option key={p.uuid} value={p.uuid}>
                {
                  s!.aircraft.find((a) => a.uuid === p.aircraftUuid)
                    ?.registration
                }{" "}
                · {p.label}
              </option>
            ))}
          </select>
        </Field>
        <ReviewConfirmation />
        <Field label="Task title">
          <input
            name="title"
            defaultValue={
              task.itemCode
                ? `${task.itemCode}: ${task.instruction.slice(0, 120)}`
                : task.instruction.slice(0, 200)
            }
            maxLength={10000}
            required
          />
        </Field>
        <Field label="Task instruction">
          <textarea
            name="instruction"
            defaultValue={task.instruction}
            maxLength={10000}
            required
          />
        </Field>
        <Field label="Task applicability">
          <textarea
            name="applicability"
            defaultValue={task.applicability}
            maxLength={10000}
          />
        </Field>
        <ManualLink reference={task.reference} />
        <p>
          Saved as draft with an unsigned step and empty execution results. Set
          any additional measurements, limits or signoff requirements in Task
          cards.
        </p>
      </AsyncForm>
    </>
  );
}
