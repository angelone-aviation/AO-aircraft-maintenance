/**
 * Responsibility: The inspection templates screen (listing, filtering,
 *   editing, activating, importing and deleting templates), plus the template
 *   editor and interval summary other screens reuse.
 * Layer: UI. React components; template rules live in src/domain.
 * Dependencies: react, @tanstack/react-router, src/data/store.ts, src/domain
 *   (deleteInspectionTemplates, programs, inspectionTemplates, manuals,
 *   model), ./TaskCsvImport, ./ActivateTemplate, ./ScheduleTracking,
 *   ./ManagementShared, ./Manuals, ./MaintenanceUi, ./ui, ./design.
 */
import { CheckCircle, Funnel, Info } from "@phosphor-icons/react";
import {
  EmptyState,
  NoticeBar,
  PageHeader,
  SearchField,
  Toolbar,
} from "./design";
import { IconSelect, RowsCell, RowsRow, RowsTable } from "./MaintenanceUi";
import {
  MAX_TEMPLATES_PER_DELETION,
  templateDeletionPreview,
} from "../domain/deleteInspectionTemplates";
import { TaskCsvImportButton } from "./TaskCsvImport";
import { ActivateTemplate } from "./ActivateTemplate";
import { Link } from "@tanstack/react-router";
import { ScheduleTracking } from "./ScheduleTracking";
import { useState } from "react";
import { useWorkspace } from "../data/store";
import type { Backend } from "../data/backend";
import { programPermission } from "../domain/programs";
import {
  TEMPLATE_CONDITIONS_MAX_LENGTH,
  TEMPLATE_CSV_MAX_BYTES,
  TEMPLATE_DESCRIPTION_MAX_LENGTH,
  TEMPLATE_GROUP_MAX_LENGTH,
  TEMPLATE_NAME_MAX_LENGTH,
  taskSourceText,
  emptyTemplate,
  inspectionTemplateSchema,
  parseTemplateCsv,
  templateCsvHeaders,
  templateLandingCsvHeaders,
  type InspectionTemplate,
} from "../domain/inspectionTemplates";
import type { Snapshot } from "../domain/model";
import {
  AsyncForm,
  Field,
  Modal,
  downloadBlankCsv,
  errorText,
  value,
} from "./ui";
import { NumberField, num } from "./ManagementShared";
import { ManualLink } from "./Manuals";
import {
  APPLICABILITY_NAME_MAX_LENGTH,
  APPLICABILITY_PART_NUMBER_MAX_LENGTH,
  type ManualApplicability,
} from "../domain/manuals";

const TEMPLATE_FIELDS = inspectionTemplateSchema.shape;

/**
 * The form that edits one inspection template's model scope, intervals and
 * notes, and lists its reusable checklist tasks. Needs a connection and
 * maintenance permission in the active program.
 *
 * @param props.record - The template, or `emptyTemplate()` for a new one.
 * @param props.onDone - Called after the save succeeds.
 * @returns The form. Saving parses the fields with `inspectionTemplateSchema`
 *   and calls `backend.saveInspectionTemplates([template])`; a parse error
 *   shows on the form and saves nothing.
 */
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
        await backend!.saveInspectionTemplates([readTemplate(record, d)]);
        onDone();
      }}
    >
      <p>
        Templates contain reusable requirements. Last compliance, aircraft
        registration, serial numbers and due dates belong to the individual
        aircraft or component schedule.
      </p>
      <TemplateIdentityFields record={record} />
      <TemplateSchedule record={record} />
      <TemplateNotes record={record} />
      <p>
        <ManualLink reference={record.manualReference} />
      </p>
      <TemplateTasks tasks={record.tasks} />
    </AsyncForm>
  );
}

/**
 * A template's intervals, limits and initial thresholds, one line each, in a
 * fixed order: hours, cycles, landings, initial landings, calendar, initial
 * hours, initial cycles.
 *
 * @param props.record - The template; a limit it leaves unset is not shown.
 */
export function TemplateIntervals({
  record: t,
}: {
  record: InspectionTemplate;
}) {
  return (
    <>
      {t.hours !== undefined && (
        <div>
          {t.hours} hours · {limitModeText(t.hourMode)} ({t.timeBasis})
        </div>
      )}
      {t.cycles !== undefined && (
        <div>
          {t.cycles} cycles · {limitModeText(t.cycleMode)}
        </div>
      )}
      {t.landings !== undefined && (
        <div>
          {t.landings} landings · {limitModeText(t.landingMode)}
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

/**
 * The inspection templates screen: templates grouped by model and inspection
 * group, filtered by text, type and archived state, with forms to create,
 * edit, activate, import from CSV and delete them. Changes need a connection
 * and maintenance permission.
 *
 * @returns The screen. Saving calls `backend.saveInspectionTemplates`;
 *   deleting calls `backend.deleteInspectionTemplates` with each template's
 *   and job card's version, for at most 100 templates at a time.
 */
export function InspectionTemplates() {
  const { snapshot: s, backend, online, connected } = useWorkspace();
  const screen = useTemplateScreen();
  const writable = online && connected && programPermission(s!, "maintenance");
  const records = visibleTemplates(s!, screen);
  const props = { s: s!, backend: backend!, screen, writable, records };
  return (
    <>
      <TemplatesTitle {...props} />
      <SavedNotice screen={screen} />
      <TemplateFilters screen={screen} />
      {screen.deleting && <DeleteSelection {...props} />}
      {screen.deletePreview && (
        <DeleteTemplatesDialog {...props} preview={screen.deletePreview} />
      )}
      {!records.length && (
        <EmptyState title="No templates found">
          Create a template or import interval data from CSV.
        </EmptyState>
      )}
      <TemplateGroups {...props} />
      {screen.activating && (
        <ActivateDialog template={screen.activating} screen={screen} />
      )}
      {screen.selected && (
        <EditorDialog record={screen.selected} screen={screen} />
      )}
      {screen.importing && <ImportDialog {...props} />}
    </>
  );
}

type RecordProps = { record: InspectionTemplate };
type Screen = ReturnType<typeof useTemplateScreen>;
type ScreenProps = {
  s: Snapshot;
  backend: Backend;
  screen: Screen;
  writable: boolean;
  records: InspectionTemplate[];
};
type Preview = ReturnType<typeof parseTemplateCsv>;
type DeletePreview = ReturnType<typeof templateDeletionPreview>;

// An untracked schedule group's fieldset is disabled, so the form leaves out
// its fields and their modes and units fall back to the defaults.
function readTemplate(record: InspectionTemplate, d: FormData) {
  return inspectionTemplateSchema.parse({
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
}

function TemplateIdentityFields({ record }: RecordProps) {
  return (
    <div className="form-grid">
      <Field label="Template name">
        <input
          name="name"
          defaultValue={record.name}
          required
          maxLength={TEMPLATE_NAME_MAX_LENGTH}
        />
      </Field>
      <Field label="Inspection group">
        <input
          name="group"
          defaultValue={record.group}
          maxLength={TEMPLATE_GROUP_MAX_LENGTH}
          placeholder="Phase inspections"
        />
      </Field>
      <ScopeFields scope={record.applicability} />
      <OptionsField
        label="Requirement type"
        name="requirementType"
        defaultValue={record.requirementType}
        options={TEMPLATE_FIELDS.requirementType.options}
      />
    </div>
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
          maxLength={APPLICABILITY_NAME_MAX_LENGTH}
        />
      </Field>
      <Field label="Aircraft type / component model">
        <input
          name="model"
          defaultValue={scope?.model}
          maxLength={APPLICABILITY_NAME_MAX_LENGTH}
          required
        />
      </Field>
      <Field label="Applicable part number">
        <input
          name="partNumber"
          defaultValue={scope?.partNumber}
          maxLength={APPLICABILITY_PART_NUMBER_MAX_LENGTH}
        />
      </Field>
    </>
  );
}

function TemplateSchedule({ record: r }: RecordProps) {
  const tracked = {
    hours: r.hours !== undefined || r.initialHours !== undefined,
    calendar: r.calendarValue !== undefined,
    cycles: r.cycles !== undefined || r.initialCycles !== undefined,
    landings: r.landings !== undefined || r.initialLandings !== undefined,
  };
  return (
    <ScheduleTracking initial={tracked}>
      {{
        hours: <HourFields record={r} />,
        calendar: <CalendarFields record={r} />,
        cycles: <CycleFields record={r} />,
        landings: <LandingFields record={r} />,
      }}
    </ScheduleTracking>
  );
}

function HourFields({ record }: RecordProps) {
  return (
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
      <OptionsField
        label="Time basis"
        name="timeBasis"
        defaultValue={record.timeBasis}
        options={TEMPLATE_FIELDS.timeBasis.options}
      />
      <LimitModeField
        label="Hour limit mode"
        name="hourMode"
        defaultValue={record.hourMode}
      />
    </>
  );
}

function CalendarFields({ record }: RecordProps) {
  return (
    <>
      <NumberField
        name="calendarValue"
        label="Calendar interval"
        initial={record.calendarValue}
      />
      <OptionsField
        label="Calendar unit"
        name="calendarUnit"
        defaultValue={record.calendarUnit}
        options={TEMPLATE_FIELDS.calendarUnit.options}
      />
    </>
  );
}

function CycleFields({ record }: RecordProps) {
  return (
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
      <LimitModeField
        label="Cycle limit mode"
        name="cycleMode"
        defaultValue={record.cycleMode}
      />
    </>
  );
}

function LandingFields({ record }: RecordProps) {
  return (
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
      <LimitModeField
        label="Landing limit mode"
        name="landingMode"
        defaultValue={record.landingMode ?? "FROM_LAST_COMPLIED"}
        absolute="Absolute aircraft landings"
      />
    </>
  );
}

function OptionsField({
  label,
  name,
  defaultValue,
  options,
}: {
  label: string;
  name: string;
  defaultValue: string;
  options: readonly string[];
}) {
  return (
    <Field label={label}>
      <select name={name} defaultValue={defaultValue}>
        {options.map((v) => (
          <option key={v}>{v}</option>
        ))}
      </select>
    </Field>
  );
}

function LimitModeField({
  label,
  name,
  defaultValue,
  absolute = "Absolute limit",
}: {
  label: string;
  name: string;
  defaultValue: string;
  absolute?: string;
}) {
  return (
    <Field label={label}>
      <select name={name} defaultValue={defaultValue}>
        <option value="FROM_LAST_COMPLIED">
          Recurring from last compliance
        </option>
        <option value="ABSOLUTE">{absolute}</option>
      </select>
    </Field>
  );
}

function TemplateNotes({ record }: RecordProps) {
  return (
    <>
      <Field label="Description">
        <textarea
          name="description"
          defaultValue={record.description}
          maxLength={TEMPLATE_DESCRIPTION_MAX_LENGTH}
        />
      </Field>
      <Field label="Conditions / applicability notes">
        <textarea
          name="conditions"
          defaultValue={record.conditions}
          maxLength={TEMPLATE_CONDITIONS_MAX_LENGTH}
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
    </>
  );
}

function TemplateTasks({ tasks }: { tasks: InspectionTemplate["tasks"] }) {
  if (!tasks.length) return null;
  return (
    <details>
      <summary>{tasks.length} reusable checklist tasks</summary>
      <ol>
        {tasks.map((t, i) => (
          <li key={i}>
            {t.itemCode} — {t.instruction} {t.applicability}
            {t.zone && <p>Zone: {t.zone}</p>}
            {taskSourceText(t) && <p>{taskSourceText(t)}</p>}
            <ManualLink reference={t.manualReference} />
          </li>
        ))}
      </ol>
    </details>
  );
}

function limitModeText(mode: string | undefined) {
  return mode === "ABSOLUTE" ? "absolute" : "recurring";
}

function useTemplateScreen() {
  const [activating, setActivating] = useState<InspectionTemplate>();
  const [createdKind, setCreatedKind] = useState<"aircraft" | "component">();
  const [selected, setSelected] = useState<InspectionTemplate>();
  const [importing, setImporting] = useState(false);
  const [preview, setPreview] = useState<Preview>([]);
  const [filter, setFilter] = useState("");
  const [kind, setKind] = useState("");
  const [archived, setArchived] = useState(false);
  const [notice, setNotice] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteIds, setDeleteIds] = useState<string[]>([]);
  const [deleteError, setDeleteError] = useState("");
  const [deletePreview, setDeletePreview] = useState<DeletePreview>();
  return {
    ...{ activating, setActivating, createdKind, setCreatedKind },
    ...{ selected, setSelected, importing, setImporting, preview, setPreview },
    ...{ filter, setFilter, kind, setKind, archived, setArchived },
    ...{ notice, setNotice, deleting, setDeleting, deleteIds, setDeleteIds },
    ...{ deleteError, setDeleteError, deletePreview, setDeletePreview },
  };
}

function visibleTemplates(
  s: Snapshot,
  { filter, kind, archived }: Pick<Screen, "filter" | "kind" | "archived">,
) {
  const query = filter.toLowerCase();
  return (s.inspectionTemplates ?? []).filter(
    (t) =>
      (archived || !t.archived) &&
      (!kind || t.applicability.kind === kind) &&
      searchText(t).includes(query),
  );
}

function searchText({ name, group, applicability: a }: InspectionTemplate) {
  return `${name} ${group} ${a.manufacturer} ${a.model} ${a.partNumber}`.toLowerCase();
}

function TemplatesTitle(props: ScreenProps) {
  return (
    <PageHeader
      eyebrow="MAINTENANCE"
      title="Inspection"
      accent="templates"
      description="Reusable inspection and component requirements, grouped by model. Intervals only; no compliance history."
      actions={<TemplateActions {...props} />}
    />
  );
}

function TemplateActions({ s, screen, writable }: ScreenProps) {
  const toggleDeleting = () => {
    screen.setDeleting(!screen.deleting);
    screen.setDeleteIds([]);
    screen.setDeleteError("");
  };
  const startImport = () => {
    screen.setPreview([]);
    screen.setImporting(true);
  };
  return (
    <>
      <Link to="/inspections" className="button">
        Back to inspections
      </Link>
      <button
        className="button"
        disabled={!writable || !s.inspectionTemplates?.length}
        onClick={toggleDeleting}
      >
        {screen.deleting ? "Cancel template selection" : "Delete templates"}
      </button>
      <TaskCsvImportButton />
      <button className="button" disabled={!writable} onClick={startImport}>
        Import template CSV
      </button>
      <button
        className="button primary"
        disabled={!writable}
        onClick={() => screen.setSelected(emptyTemplate())}
      >
        New template
      </button>
    </>
  );
}

function SavedNotice({ screen }: { screen: Screen }) {
  const { notice, createdKind } = screen;
  if (!notice) return null;
  return (
    <NoticeBar tone="good" icon={CheckCircle} role="status">
      {notice}{" "}
      {createdKind && (
        <Link to={createdKind === "aircraft" ? "/inspections" : "/components"}>
          Open {createdKind === "aircraft" ? "Inspections" : "Components"}
        </Link>
      )}
    </NoticeBar>
  );
}

function TemplateFilters({ screen }: { screen: Screen }) {
  return (
    <Toolbar
      className="mx-filters"
      end={
        <label className="checkbox">
          <input
            type="checkbox"
            checked={screen.archived}
            onChange={(e) => screen.setArchived(e.target.checked)}
          />{" "}
          Show archived
        </label>
      }
    >
      <SearchField
        className="mx-search"
        label="Search templates"
        value={screen.filter}
        onChange={screen.setFilter}
      />
      <IconSelect
        icon={Funnel}
        label="Template type"
        value={screen.kind}
        onChange={screen.setKind}
      >
        <option value="">All models</option>
        <option value="aircraft">Aircraft types</option>
        <option value="component">Component models</option>
      </IconSelect>
    </Toolbar>
  );
}

function DeleteSelection({ s, screen, writable, records }: ScreenProps) {
  const { deleteIds, deleteError } = screen;
  const review = () => {
    try {
      screen.setDeletePreview(templateDeletionPreview(s, deleteIds));
      screen.setDeleteError("");
    } catch (e) {
      screen.setDeleteError(errorText(e, "Unable to preview deletion."));
    }
  };
  return (
    <div className="ds-card mx-tpl-select">
      <p>
        Select templates to delete. {deleteIds.length} selected (maximum{" "}
        {MAX_TEMPLATES_PER_DELETION}).
      </p>
      <div className="mx-tpl-buttons">
        <SelectVisibleButton {...{ screen, writable, records }} />
        <button className="button" onClick={() => screen.setDeleteIds([])}>
          Clear selection
        </button>
        <button
          className="button"
          disabled={!writable || !deleteIds.length}
          onClick={review}
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
  );
}

function SelectVisibleButton({
  screen,
  writable,
  records,
}: Omit<ScreenProps, "s" | "backend">) {
  const first = records.slice(0, MAX_TEMPLATES_PER_DELETION);
  return (
    <button
      className="button"
      disabled={!writable || !records.length}
      onClick={() => screen.setDeleteIds(first.map((t) => t.uuid))}
    >
      {records.length > MAX_TEMPLATES_PER_DELETION
        ? `Select first ${MAX_TEMPLATES_PER_DELETION} visible`
        : "Select all visible"}
    </button>
  );
}

function DeleteTemplatesDialog({
  s,
  backend,
  screen,
  writable,
  preview,
}: ScreenProps & { preview: DeletePreview }) {
  const { templates, taskCards } = preview;
  const submit = async () => {
    await backend.deleteInspectionTemplates({
      templates: templates.map(({ uuid, version }) => ({ uuid, version })),
      taskCards: taskCards.map(({ uuid, version }) => ({ uuid, version })),
    });
    screen.setNotice(
      `Deleted ${templates.length} templates and ${taskCards.length} associated job cards.`,
    );
    screen.setCreatedKind(undefined);
    screen.setDeletePreview(undefined);
    screen.setDeleteIds([]);
    screen.setDeleting(false);
  };
  const plural = templates.length === 1 ? "" : "s";
  return (
    <Modal
      title="Delete selected templates"
      onClose={() => screen.setDeletePreview(undefined)}
    >
      <AsyncForm
        submitLabel={`Delete ${templates.length} template${plural} and ${taskCards.length} job cards`}
        disabled={!writable}
        onSubmit={submit}
      >
        <DeletionSummary s={s} preview={preview} />
      </AsyncForm>
    </Modal>
  );
}

function DeletionSummary({
  s,
  preview,
}: {
  s: Snapshot;
  preview: DeletePreview;
}) {
  const { templates, taskCards } = preview;
  return (
    <>
      <p>
        This permanently deletes the selected templates, their embedded task
        definitions, and {taskCards.length} associated reusable job cards and
        attachments. Existing inspection schedules, component requirements, and
        independent work-order job cards remain.
      </p>
      <ul>
        {templates.map((t) => (
          <li key={t.uuid}>
            {t.name} · {t.tasks.length} task definitions
          </li>
        ))}
      </ul>
      <AssociatedCards s={s} taskCards={taskCards} />
      <label>
        <input type="checkbox" required /> I understand these templates and
        associated reusable job cards will be deleted.
      </label>
    </>
  );
}

function AssociatedCards({
  s,
  taskCards,
}: {
  s: Snapshot;
  taskCards: DeletePreview["taskCards"];
}) {
  if (!taskCards.length) return null;
  const registration = (uuid: string) =>
    s.aircraft.find((a) => a.uuid === uuid)?.registration ?? uuid;
  return (
    <details>
      <summary>Associated job cards ({taskCards.length})</summary>
      <ul>
        {taskCards.map((t) => (
          <li key={t.uuid}>
            {t.title} · {registration(t.aircraftUuid)}
          </li>
        ))}
      </ul>
    </details>
  );
}

const TEMPLATE_COLUMNS = [
  "Template",
  "Intervals / limits",
  "Conditions",
  "Tasks / source",
  "Actions",
];
const TEMPLATE_COLS =
  "minmax(0, 1.1fr) minmax(0, 0.95fr) minmax(0, 0.8fr) minmax(0, 0.6fr) minmax(0, 1.65fr)";
const SELECT_COL = "28px ";

function TemplateGroups(props: ScreenProps) {
  const groups = Map.groupBy(props.records, templateGroupLabel);
  const { deleting } = props.screen;
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, entries]) => (
      <section className="mx-tpl-group" key={label}>
        <h3>{label}</h3>
        <RowsTable
          label={`${label} templates`}
          columns={
            deleting ? ["Select", ...TEMPLATE_COLUMNS] : TEMPLATE_COLUMNS
          }
          cols={(deleting ? SELECT_COL : "") + TEMPLATE_COLS}
          hiddenColumns={["Select", "Actions"]}
        >
          {entries.map((t) => (
            <TemplateRow key={t.uuid} template={t} {...props} />
          ))}
        </RowsTable>
      </section>
    ));
}

function templateGroupLabel({ applicability: a, group }: InspectionTemplate) {
  const kind = a.kind === "aircraft" ? "Aircraft type" : "Component model";
  const part = a.partNumber ? ` · ${a.partNumber}` : "";
  return `${kind}: ${a.manufacturer} ${a.model}${part} / ${group || "General"}`;
}

function TemplateRow({
  template: t,
  screen,
  writable,
}: ScreenProps & { template: InspectionTemplate }) {
  return (
    <RowsRow>
      {screen.deleting && <SelectCell template={t} {...{ screen, writable }} />}
      <RowsCell kind="main">
        {t.name}
        {t.archived && " (archived)"}
        <small className="block">{t.requirementType}</small>
      </RowsCell>
      <RowsCell caption="Intervals / limits">
        <TemplateIntervals record={t} />
      </RowsCell>
      <RowsCell caption="Conditions">
        {t.conditions}
        <details>
          <summary>Description</summary>
          {t.description}
        </details>
      </RowsCell>
      <RowsCell caption="Tasks / source">
        {t.tasks.length} tasks
        <ManualLink reference={t.manualReference} />
      </RowsCell>
      <TemplateRowActions template={t} {...{ screen, writable }} />
    </RowsRow>
  );
}

function TemplateRowActions({
  template: t,
  screen,
  writable,
}: Pick<ScreenProps, "screen" | "writable"> & {
  template: InspectionTemplate;
}) {
  return (
    <RowsCell kind="actions">
      <button className="button small" onClick={() => screen.setSelected(t)}>
        {writable ? "Edit template" : "View template"}
      </button>
      <button
        className="button small"
        disabled={!writable || t.archived}
        onClick={() => screen.setActivating(t)}
      >
        {t.applicability.kind === "aircraft"
          ? "Create inspection"
          : "Create component requirement"}
      </button>
    </RowsCell>
  );
}

// The selection stops at the deletion limit; chosen rows stay clearable.
function SelectCell({
  template: t,
  screen,
  writable,
}: Pick<ScreenProps, "screen" | "writable"> & {
  template: InspectionTemplate;
}) {
  const checked = screen.deleteIds.includes(t.uuid);
  const full = screen.deleteIds.length >= MAX_TEMPLATES_PER_DELETION;
  return (
    <RowsCell kind="check">
      <input
        type="checkbox"
        aria-label={`Select template ${t.name}`}
        checked={checked}
        disabled={!writable || (!checked && full)}
        onChange={(e) =>
          screen.setDeleteIds((ids) =>
            e.target.checked
              ? [...ids, t.uuid]
              : ids.filter((id) => id !== t.uuid),
          )
        }
      />
    </RowsCell>
  );
}

function ActivateDialog({
  template,
  screen,
}: {
  template: InspectionTemplate;
  screen: Screen;
}) {
  const kind = template.applicability.kind;
  const done = () => {
    screen.setCreatedKind(kind);
    screen.setNotice(
      "Schedule and linked job card templates created. The template is unchanged.",
    );
    screen.setActivating(undefined);
  };
  return (
    <Modal
      wide
      title={
        kind === "aircraft"
          ? "Create inspection from template"
          : "Create component requirement from template"
      }
      onClose={() => screen.setActivating(undefined)}
    >
      <ActivateTemplate template={template} onDone={done} />
    </Modal>
  );
}

function EditorDialog({ record, screen }: RecordProps & { screen: Screen }) {
  const done = () => {
    screen.setSelected(undefined);
    screen.setNotice("Template saved. No compliance history was required.");
  };
  return (
    <Modal
      wide
      title="Inspection template"
      onClose={() => screen.setSelected(undefined)}
    >
      <TemplateEditor record={record} onDone={done} />
    </Modal>
  );
}

function ImportDialog(props: ScreenProps) {
  const { screen, writable } = props;
  const submit = async (d: FormData) => {
    screen.setPreview([]);
    screen.setPreview(await readTemplateCsv(d));
  };
  return (
    <Modal
      wide
      title="Import interval templates"
      onClose={() => screen.setImporting(false)}
    >
      <ImportGuidance />
      <button type="button" className="button" onClick={downloadTemplateCsv}>
        Download template CSV
      </button>
      <AsyncForm
        submitLabel="Preview templates"
        disabled={!writable}
        onChange={() => screen.setPreview([])}
        onSubmit={submit}
      >
        <div className="form-grid">
          <ScopeFields />
          <Field label="Inspection group">
            <input name="group" maxLength={TEMPLATE_GROUP_MAX_LENGTH} />
          </Field>
          <Field label="Template CSV">
            <input type="file" name="csv" accept=".csv,text/csv" required />
          </Field>
        </div>
      </AsyncForm>
      {!!screen.preview.length && <ImportPreview {...props} />}
    </Modal>
  );
}

function ImportGuidance() {
  return (
    <>
      <NoticeBar icon={Info}>
        <strong>Manufacturer and model must match the aircraft profile.</strong>{" "}
        Use the same manufacturer name and model recorded under Aircraft. For
        example, “Cessna” will not match “Cessna Aircraft Company”. If they do
        not match, the aircraft will not appear when you create an inspection
        from the imported template. Component templates must match the target
        component’s manufacturer and model instead.
      </NoticeBar>
      <p className="mx-tpl-intro">
        Choose a model and group for this batch. Download the interval-only
        format, or upload the C441 status export. For that export, SVC LIFE
        HRS/LAND is treated as hours and SVC LIFE MONTHS as months. Convert
        landing-based intervals to the template CSV landings column. Completion
        history, due dates and remaining values are excluded. Unit and option
        names accept either letter case. Rows with no numeric interval retain
        their description as conditions when conditions are blank; no numeric
        interval is inferred.
      </p>
    </>
  );
}

function downloadTemplateCsv() {
  downloadBlankCsv("inspection-templates.csv", [
    ...templateCsvHeaders,
    ...templateLandingCsvHeaders,
  ]);
}

async function readTemplateCsv(d: FormData) {
  const file = d.get("csv");
  if (
    !(file instanceof File) ||
    !file.size ||
    file.size > TEMPLATE_CSV_MAX_BYTES
  )
    throw new Error("Choose a UTF-8 CSV up to 2 MiB.");
  const scope = {
    kind: value(d, "kind") as ManualApplicability["kind"],
    manufacturer: value(d, "manufacturer"),
    model: value(d, "model"),
    partNumber: value(d, "partNumber"),
  };
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    await file.arrayBuffer(),
  );
  return parseTemplateCsv(text, scope, value(d, "group"));
}

function ImportPreview({ backend, screen, writable }: ScreenProps) {
  const { preview } = screen;
  const chosen = preview.flatMap((r) =>
    r.selected && r.template ? [r.template] : [],
  );
  const submit = async () => {
    await backend.saveInspectionTemplates(chosen);
    screen.setNotice("Selected templates saved with interval data only.");
    screen.setPreview([]);
    screen.setImporting(false);
  };
  const errors = preview.filter((r) => r.error).length;
  return (
    <AsyncForm
      submitLabel="Save selected templates"
      disabled={!writable || !preview.some((r) => r.selected && r.template)}
      onSubmit={submit}
    >
      <p className="mx-tpl-intro">
        {preview.length} rows · {preview.length - errors} valid · {errors}{" "}
        errors. Rows marked not applicable or unused start unselected. Review
        intervals and notes before saving.
      </p>
      <PreviewTable screen={screen} />
      <label className="mx-tpl-confirm">
        <input type="checkbox" required /> I reviewed the model, interval units
        and selected requirements.
      </label>
    </AsyncForm>
  );
}

const PREVIEW_COLUMNS = ["Include", "Name", "Intervals", "Notes / errors"];

function PreviewTable({ screen }: { screen: Screen }) {
  const { preview, setPreview } = screen;
  const include = (i: number, selected: boolean) =>
    setPreview(preview.map((v, j) => (j === i ? { ...v, selected } : v)));
  return (
    <RowsTable
      label="Templates to import"
      columns={PREVIEW_COLUMNS}
      cols="28px minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.2fr)"
      hiddenColumns={["Include"]}
    >
      {preview.map((r, i) => (
        <RowsRow key={r.row}>
          <RowsCell kind="check">
            <input
              aria-label={`Include row ${r.row}`}
              type="checkbox"
              checked={r.selected}
              disabled={!r.template}
              onChange={(e) => include(i, e.target.checked)}
            />
          </RowsCell>
          <RowsCell kind="main">{r.template?.name ?? `Row ${r.row}`}</RowsCell>
          <RowsCell caption="Intervals">
            {r.template && <TemplateIntervals record={r.template} />}
          </RowsCell>
          <RowsCell caption="Notes / errors">
            {r.template?.conditions || r.error}
          </RowsCell>
        </RowsRow>
      ))}
    </RowsTable>
  );
}
