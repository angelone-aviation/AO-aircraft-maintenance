/**
 * Responsibility: The inspection templates screen: listing, editing,
 *   activating, exporting and deleting templates and their intervals.
 * Layer: UI. React components; template rules live in src/domain.
 * Dependencies: react, @tanstack/react-router, src/data/store.ts, src/domain
 *   (deleteInspectionTemplates, programs, inspectionTemplates, csv, manuals),
 *   ./TaskCsvImport, ./ActivateTemplate, ./ScheduleTracking,
 *   ./ManagementShared, ./Manuals, ./ui.
 */
import { templateDeletionPreview } from "../domain/deleteInspectionTemplates";
import { TaskCsvImportButton } from "./TaskCsvImport";
import { ActivateTemplate } from "./ActivateTemplate";
import { Link } from "@tanstack/react-router";
import { ScheduleTracking } from "./ScheduleTracking";
import { useState } from "react";
import { useWorkspace } from "../data/store";
import { programPermission } from "../domain/programs";
import {
  taskSourceText,
  emptyTemplate,
  inspectionTemplateSchema,
  parseTemplateCsv,
  templateCsvHeaders,
  templateLandingCsvHeaders,
  type InspectionTemplate,
} from "../domain/inspectionTemplates";
import { AsyncForm, Field, Modal, PageTitle, errorText, value } from "./ui";
import { NumberField, num } from "./ManagementShared";
import { ManualLink } from "./Manuals";
import { toCsv } from "../domain/csv";
import type { ManualApplicability } from "../domain/manuals";

export function TemplateEditor({
  record,
  onDone,
}: {
  record: InspectionTemplate;
  onDone: () => void;
}) {
  const { snapshot: s, backend, online, connected } = useWorkspace();
  return (
    <AsyncForm
      submitLabel="Save template"
      disabled={!online || !connected || !programPermission(s!, "maintenance")}
      onSubmit={async (d) => {
        const next = inspectionTemplateSchema.parse({
          ...record,
          name: value(d, "name"),
          group: value(d, "group"),
          description: value(d, "description"),
          conditions: value(d, "conditions"),
          applicability: {
            kind: value(d, "kind"),
            manufacturer: value(d, "manufacturer"),
            model: value(d, "model"),
            partNumber: value(d, "partNumber"),
          },
          requirementType: value(d, "requirementType"),
          hours: num(d, "hours"),
          cycles: num(d, "cycles"),
          landings: num(d, "landings"),
          initialLandings: num(d, "initialLandings"),
          landingMode: value(d, "landingMode") || "FROM_LAST_COMPLIED",
          calendarValue: num(d, "calendarValue"),
          calendarUnit: value(d, "calendarUnit") || "MONTHS",
          initialHours: num(d, "initialHours"),
          initialCycles: num(d, "initialCycles"),
          timeBasis: value(d, "timeBasis") || "TSN",
          hourMode: value(d, "hourMode") || "FROM_LAST_COMPLIED",
          cycleMode: value(d, "cycleMode") || "FROM_LAST_COMPLIED",
          archived: d.get("archived") === "on",
        });
        await backend!.saveInspectionTemplates([next]);
        onDone();
      }}
    >
      <p>
        Templates contain reusable requirements. Last compliance, aircraft
        registration, serial numbers and due dates belong to the individual
        aircraft or component schedule.
      </p>
      <div className="form-grid">
        <Field label="Template name">
          <input
            name="name"
            defaultValue={record.name}
            required
            maxLength={200}
          />
        </Field>
        <Field label="Inspection group">
          <input
            name="group"
            defaultValue={record.group}
            maxLength={150}
            placeholder="Phase inspections"
          />
        </Field>
        <ScopeFields scope={record.applicability} />
        <Field label="Requirement type">
          <select name="requirementType" defaultValue={record.requirementType}>
            {[
              "Inspection Requirement",
              "Overhaul Requirement",
              "Life Limits",
            ].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </Field>
      </div>
      <ScheduleTracking
        initial={{
          hours:
            record.hours !== undefined || record.initialHours !== undefined,
          calendar: record.calendarValue !== undefined,
          cycles:
            record.cycles !== undefined || record.initialCycles !== undefined,
          landings:
            record.landings !== undefined ||
            record.initialLandings !== undefined,
        }}
      >
        {{
          hours: (
            <>
              <NumberField
                name="hours"
                label="Hour interval / limit"
                initial={record.hours}
                decimal
              />
              <NumberField
                name="initialHours"
                label="Initial threshold (hours)"
                initial={record.initialHours}
                decimal
              />
              <Field label="Time basis">
                <select name="timeBasis" defaultValue={record.timeBasis}>
                  {["TSN", "TSO", "TSR"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </Field>
              <Field label="Hour limit mode">
                <select name="hourMode" defaultValue={record.hourMode}>
                  <option value="FROM_LAST_COMPLIED">
                    Recurring from last compliance
                  </option>
                  <option value="ABSOLUTE">Absolute limit</option>
                </select>
              </Field>
            </>
          ),
          calendar: (
            <>
              <NumberField
                name="calendarValue"
                label="Calendar interval"
                initial={record.calendarValue}
              />
              <Field label="Calendar unit">
                <select name="calendarUnit" defaultValue={record.calendarUnit}>
                  {["DAYS", "MONTHS", "YEARS"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </Field>
            </>
          ),
          cycles: (
            <>
              <NumberField
                name="cycles"
                label="Cycle interval / limit"
                initial={record.cycles}
              />
              <NumberField
                name="initialCycles"
                label="Initial threshold (cycles)"
                initial={record.initialCycles}
              />
              <Field label="Cycle limit mode">
                <select name="cycleMode" defaultValue={record.cycleMode}>
                  <option value="FROM_LAST_COMPLIED">
                    Recurring from last compliance
                  </option>
                  <option value="ABSOLUTE">Absolute limit</option>
                </select>
              </Field>
            </>
          ),
          landings: (
            <>
              <p>Uses the aircraft total landings counter.</p>
              <NumberField
                name="landings"
                label="Landing interval / limit"
                initial={record.landings}
              />
              <NumberField
                name="initialLandings"
                label="Initial threshold (landings)"
                initial={record.initialLandings}
              />
              <Field label="Landing limit mode">
                <select
                  name="landingMode"
                  defaultValue={record.landingMode ?? "FROM_LAST_COMPLIED"}
                >
                  <option value="FROM_LAST_COMPLIED">
                    Recurring from last compliance
                  </option>
                  <option value="ABSOLUTE">Absolute aircraft landings</option>
                </select>
              </Field>
            </>
          ),
        }}
      </ScheduleTracking>
      <Field label="Description">
        <textarea
          name="description"
          defaultValue={record.description}
          maxLength={10000}
        />
      </Field>
      <Field label="Conditions / applicability notes">
        <textarea
          name="conditions"
          defaultValue={record.conditions}
          maxLength={2000}
        />
      </Field>
      <label>
        <input
          name="archived"
          type="checkbox"
          defaultChecked={record.archived}
        />{" "}
        Archived
      </label>
      <p>
        <ManualLink reference={record.manualReference} />
      </p>
      {!!record.tasks.length && (
        <details>
          <summary>{record.tasks.length} reusable checklist tasks</summary>
          <ol>
            {record.tasks.map((t, i) => (
              <li key={i}>
                {t.itemCode} — {t.instruction} {t.applicability}
                {t.zone && <p>Zone: {t.zone}</p>}
                {taskSourceText(t) && <p>{taskSourceText(t)}</p>}
                <ManualLink reference={t.manualReference} />
              </li>
            ))}
          </ol>
        </details>
      )}
    </AsyncForm>
  );
}
function ScopeFields({ scope }: { scope?: ManualApplicability }) {
  return (
    <>
      <Field label="Group by">
        <select name="kind" defaultValue={scope?.kind ?? "aircraft"}>
          <option value="aircraft">Aircraft type</option>
          <option value="component">Component model</option>
        </select>
      </Field>
      <Field label="Manufacturer">
        <input
          name="manufacturer"
          defaultValue={scope?.manufacturer}
          maxLength={150}
        />
      </Field>
      <Field label="Aircraft type / component model">
        <input
          name="model"
          defaultValue={scope?.model}
          maxLength={150}
          required
        />
      </Field>
      <Field label="Applicable part number">
        <input
          name="partNumber"
          defaultValue={scope?.partNumber}
          maxLength={100}
        />
      </Field>
    </>
  );
}
export function TemplateIntervals({
  record: t,
}: {
  record: InspectionTemplate;
}) {
  return (
    <>
      {t.hours !== undefined && (
        <div>
          {t.hours} hours ·{" "}
          {t.hourMode === "ABSOLUTE" ? "absolute" : "recurring"} ({t.timeBasis})
        </div>
      )}
      {t.cycles !== undefined && (
        <div>
          {t.cycles} cycles ·{" "}
          {t.cycleMode === "ABSOLUTE" ? "absolute" : "recurring"}
        </div>
      )}
      {t.landings !== undefined && (
        <div>
          {t.landings} landings ·{" "}
          {t.landingMode === "ABSOLUTE" ? "absolute" : "recurring"}
        </div>
      )}
      {t.initialLandings !== undefined && (
        <div>Initial: {t.initialLandings} landings</div>
      )}
      {t.calendarValue !== undefined && (
        <div>
          {t.calendarValue} {t.calendarUnit.toLowerCase()}
        </div>
      )}
      {t.initialHours !== undefined && (
        <div>Initial: {t.initialHours} hours</div>
      )}
      {t.initialCycles !== undefined && (
        <div>Initial: {t.initialCycles} cycles</div>
      )}
    </>
  );
}
export function InspectionTemplates() {
  const { snapshot: s, backend, online, connected } = useWorkspace();
  const [activating, setActivating] = useState<InspectionTemplate>();
  const [createdKind, setCreatedKind] = useState<"aircraft" | "component">();
  const [selected, setSelected] = useState<InspectionTemplate>();
  const [importing, setImporting] = useState(false);
  const [preview, setPreview] = useState<ReturnType<typeof parseTemplateCsv>>(
    [],
  );
  const [filter, setFilter] = useState("");
  const [kind, setKind] = useState("");
  const [archived, setArchived] = useState(false);
  const [notice, setNotice] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteIds, setDeleteIds] = useState<string[]>([]);
  const [deleteError, setDeleteError] = useState("");
  const [deletePreview, setDeletePreview] =
    useState<ReturnType<typeof templateDeletionPreview>>();
  const writable = online && connected && programPermission(s!, "maintenance");
  const records = (s!.inspectionTemplates ?? []).filter(
    (t) =>
      (archived || !t.archived) &&
      (!kind || t.applicability.kind === kind) &&
      `${t.name} ${t.group} ${t.applicability.manufacturer} ${t.applicability.model} ${t.applicability.partNumber}`
        .toLowerCase()
        .includes(filter.toLowerCase()),
  );
  const groups = Map.groupBy(
    records,
    (t) =>
      `${t.applicability.kind === "aircraft" ? "Aircraft type" : "Component model"}: ${t.applicability.manufacturer} ${t.applicability.model}${t.applicability.partNumber ? ` · ${t.applicability.partNumber}` : ""} / ${t.group || "General"}`,
  );
  return (
    <>
      <PageTitle
        eyebrow="MAINTENANCE"
        title="Inspection templates"
        description="Reusable inspection and component requirements, grouped by model. Intervals only; no compliance history."
        action={
          <div className="management-actions">
            <Link to="/inspections" className="button">
              Back to inspections
            </Link>
            <button
              className="button"
              disabled={!writable || !s!.inspectionTemplates?.length}
              onClick={() => {
                setDeleting(!deleting);
                setDeleteIds([]);
                setDeleteError("");
              }}
            >
              {deleting ? "Cancel template selection" : "Delete templates"}
            </button>
            <TaskCsvImportButton />
            <button
              className="button"
              disabled={!writable}
              onClick={() => {
                setPreview([]);
                setImporting(true);
              }}
            >
              Import template CSV
            </button>
            <button
              className="button primary"
              disabled={!writable}
              onClick={() => setSelected(emptyTemplate())}
            >
              New template
            </button>
          </div>
        }
      />
      {notice && (
        <p role="status">
          {notice}{" "}
          {createdKind && (
            <Link
              to={createdKind === "aircraft" ? "/inspections" : "/components"}
            >
              Open {createdKind === "aircraft" ? "Inspections" : "Components"}
            </Link>
          )}
        </p>
      )}
      <div className="management-toolbar">
        <Field label="Search templates">
          <input value={filter} onChange={(e) => setFilter(e.target.value)} />
        </Field>
        <Field label="Template type">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All models</option>
            <option value="aircraft">Aircraft types</option>
            <option value="component">Component models</option>
          </select>
        </Field>
        <label>
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />{" "}
          Show archived
        </label>
      </div>
      {deleting && (
        <div className="callout">
          <p>
            Select templates to delete. {deleteIds.length} selected (maximum
            100).
          </p>
          <div className="management-actions">
            <button
              className="button"
              disabled={!writable || !records.length}
              onClick={() =>
                setDeleteIds(records.slice(0, 100).map((t) => t.uuid))
              }
            >
              {records.length > 100
                ? "Select first 100 visible"
                : "Select all visible"}
            </button>
            <button className="button" onClick={() => setDeleteIds([])}>
              Clear selection
            </button>
            <button
              className="button"
              disabled={!writable || !deleteIds.length}
              onClick={() => {
                try {
                  setDeletePreview(templateDeletionPreview(s!, deleteIds));
                  setDeleteError("");
                } catch (e) {
                  setDeleteError(errorText(e, "Unable to preview deletion."));
                }
              }}
            >
              Review deletion ({deleteIds.length})
            </button>
          </div>
          {deleteError && (
            <p className="error" role="alert">
              {deleteError}
            </p>
          )}
        </div>
      )}
      {deletePreview && (
        <Modal
          title="Delete selected templates"
          onClose={() => setDeletePreview(undefined)}
        >
          <AsyncForm
            submitLabel={`Delete ${deletePreview.templates.length} template${deletePreview.templates.length === 1 ? "" : "s"} and ${deletePreview.taskCards.length} job cards`}
            disabled={!writable}
            onSubmit={async () => {
              await backend!.deleteInspectionTemplates({
                templates: deletePreview.templates.map((t) => ({
                  uuid: t.uuid,
                  version: t.version,
                })),
                taskCards: deletePreview.taskCards.map((t) => ({
                  uuid: t.uuid,
                  version: t.version,
                })),
              });
              setNotice(
                `Deleted ${deletePreview.templates.length} templates and ${deletePreview.taskCards.length} associated job cards.`,
              );
              setCreatedKind(undefined);
              setDeletePreview(undefined);
              setDeleteIds([]);
              setDeleting(false);
            }}
          >
            <p>
              This permanently deletes the selected templates, their embedded
              task definitions, and {deletePreview.taskCards.length} associated
              reusable job cards and attachments. Existing inspection schedules,
              component requirements, and independent work-order job cards
              remain.
            </p>
            <ul>
              {deletePreview.templates.map((t) => (
                <li key={t.uuid}>
                  {t.name} · {t.tasks.length} task definitions
                </li>
              ))}
            </ul>
            {!!deletePreview.taskCards.length && (
              <details>
                <summary>
                  Associated job cards ({deletePreview.taskCards.length})
                </summary>
                <ul>
                  {deletePreview.taskCards.map((t) => (
                    <li key={t.uuid}>
                      {t.title} ·{" "}
                      {s!.aircraft.find((a) => a.uuid === t.aircraftUuid)
                        ?.registration ?? t.aircraftUuid}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <label>
              <input type="checkbox" required /> I understand these templates
              and associated reusable job cards will be deleted.
            </label>
          </AsyncForm>
        </Modal>
      )}
      {!records.length && (
        <p>
          No templates found. Create a template or import interval data from
          CSV.
        </p>
      )}
      {[...groups]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([label, entries]) => (
          <section key={label}>
            <h3>{label}</h3>
            <div className="panel table-wrap">
              <table>
                <thead>
                  <tr>
                    {deleting && <th>Select</th>}
                    <th>Actions</th>
                    <th>Template</th>
                    <th>Intervals / limits</th>
                    <th>Conditions</th>
                    <th>Tasks / source</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((t) => (
                    <tr key={t.uuid}>
                      {deleting && (
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Select template ${t.name}`}
                            checked={deleteIds.includes(t.uuid)}
                            disabled={
                              !writable ||
                              (!deleteIds.includes(t.uuid) &&
                                deleteIds.length >= 100)
                            }
                            onChange={(e) =>
                              setDeleteIds((ids) =>
                                e.target.checked
                                  ? [...ids, t.uuid]
                                  : ids.filter((id) => id !== t.uuid),
                              )
                            }
                          />
                        </td>
                      )}
                      <td>
                        <button
                          className="button"
                          onClick={() => setSelected(t)}
                        >
                          {writable ? "Edit template" : "View template"}
                        </button>
                        <button
                          className="button"
                          disabled={!writable || t.archived}
                          onClick={() => setActivating(t)}
                        >
                          {t.applicability.kind === "aircraft"
                            ? "Create inspection"
                            : "Create component requirement"}
                        </button>
                      </td>
                      <td>
                        {t.name}
                        {t.archived && " (archived)"}
                        <small className="block">{t.requirementType}</small>
                      </td>
                      <td>
                        <TemplateIntervals record={t} />
                      </td>
                      <td>
                        {t.conditions}
                        <details>
                          <summary>Description</summary>
                          {t.description}
                        </details>
                      </td>
                      <td>
                        {t.tasks.length} tasks
                        <ManualLink reference={t.manualReference} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      {activating && (
        <Modal
          wide
          title={
            activating.applicability.kind === "aircraft"
              ? "Create inspection from template"
              : "Create component requirement from template"
          }
          onClose={() => setActivating(undefined)}
        >
          <ActivateTemplate
            template={activating}
            onDone={() => {
              setCreatedKind(activating.applicability.kind);
              setNotice(
                "Schedule and linked job card templates created. The template is unchanged.",
              );
              setActivating(undefined);
            }}
          />
        </Modal>
      )}
      {selected && (
        <Modal
          wide
          title="Inspection template"
          onClose={() => setSelected(undefined)}
        >
          <TemplateEditor
            record={selected}
            onDone={() => {
              setSelected(undefined);
              setNotice("Template saved. No compliance history was required.");
            }}
          />
        </Modal>
      )}
      {importing && (
        <Modal
          wide
          title="Import interval templates"
          onClose={() => setImporting(false)}
        >
          <p className="notice">
            <strong>
              Manufacturer and model must match the aircraft profile.
            </strong>{" "}
            Use the same manufacturer name and model recorded under Aircraft.
            For example, “Cessna” will not match “Cessna Aircraft Company”. If
            they do not match, the aircraft will not appear when you create an
            inspection from the imported template. Component templates must
            match the target component’s manufacturer and model instead.
          </p>
          <p>
            Choose a model and group for this batch. Download the interval-only
            format, or upload the C441 status export. For that export, SVC LIFE
            HRS/LAND is treated as hours and SVC LIFE MONTHS as months. Convert
            landing-based intervals to the template CSV landings column.
            Completion history, due dates and remaining values are excluded.
            Unit and option names accept either letter case. Rows with no
            numeric interval retain their description as conditions when
            conditions are blank; no numeric interval is inferred.
          </p>
          <button
            type="button"
            className="button"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob(
                  [
                    toCsv([
                      Object.fromEntries(
                        [
                          ...templateCsvHeaders,
                          ...templateLandingCsvHeaders,
                        ].map((h) => [h, ""]),
                      ),
                    ]).split("\r\n")[0] + "\r\n",
                  ],
                  { type: "text/csv" },
                ),
              );
              const a = document.createElement("a");
              a.href = url;
              a.download = "inspection-templates.csv";
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            Download template CSV
          </button>
          <AsyncForm
            submitLabel="Preview templates"
            disabled={!writable}
            onChange={() => setPreview([])}
            onSubmit={async (d) => {
              setPreview([]);
              const file = d.get("csv");
              if (
                !(file instanceof File) ||
                !file.size ||
                file.size > 2 * 1024 * 1024
              )
                throw new Error("Choose a UTF-8 CSV up to 2 MB.");
              const scope = {
                kind: value(d, "kind") as ManualApplicability["kind"],
                manufacturer: value(d, "manufacturer"),
                model: value(d, "model"),
                partNumber: value(d, "partNumber"),
              };
              setPreview(
                parseTemplateCsv(
                  new TextDecoder("utf-8", { fatal: true }).decode(
                    await file.arrayBuffer(),
                  ),
                  scope,
                  value(d, "group"),
                ),
              );
            }}
          >
            <div className="form-grid">
              <ScopeFields />
              <Field label="Inspection group">
                <input name="group" maxLength={150} />
              </Field>
              <Field label="Template CSV">
                <input type="file" name="csv" accept=".csv,text/csv" required />
              </Field>
            </div>
          </AsyncForm>
          {!!preview.length && (
            <AsyncForm
              submitLabel="Save selected templates"
              disabled={
                !writable || !preview.some((r) => r.selected && r.template)
              }
              onSubmit={async () => {
                await backend!.saveInspectionTemplates(
                  preview.flatMap((r) =>
                    r.selected && r.template ? [r.template] : [],
                  ),
                );
                setNotice("Selected templates saved with interval data only.");
                setPreview([]);
                setImporting(false);
              }}
            >
              <p>
                {preview.length} rows · {preview.filter((r) => !r.error).length}{" "}
                valid · {preview.filter((r) => r.error).length} errors. Rows
                marked not applicable or unused start unselected. Review
                intervals and notes before saving.
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Include</th>
                      <th>Name</th>
                      <th>Intervals</th>
                      <th>Notes / errors</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((r, i) => (
                      <tr key={r.row}>
                        <td>
                          <input
                            aria-label={`Include row ${r.row}`}
                            type="checkbox"
                            checked={r.selected}
                            disabled={!r.template}
                            onChange={(e) =>
                              setPreview(
                                preview.map((v, j) =>
                                  j === i
                                    ? { ...v, selected: e.target.checked }
                                    : v,
                                ),
                              )
                            }
                          />
                        </td>
                        <td>{r.template?.name ?? `Row ${r.row}`}</td>
                        <td>
                          {r.template && (
                            <TemplateIntervals record={r.template} />
                          )}
                        </td>
                        <td>{r.template?.conditions || r.error}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <label>
                <input type="checkbox" required /> I reviewed the model,
                interval units and selected requirements.
              </label>
            </AsyncForm>
          )}
        </Modal>
      )}
    </>
  );
}
