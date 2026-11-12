/**
 * Responsibility: Component templates: the library with its editor, CSV
 *   import and preview, the Setup incomplete list, and the Imported
 *   components page.
 * Layer: UI. React components; template rules live in src/domain.
 * Dependencies: react, @tanstack/react-router, src/data/store.ts,
 *   src/data/backend.ts (types), src/domain (model, programs, components,
 *   componentTemplates, csv, maintenanceCsv), @phosphor-icons/react,
 *   ./Components, ./MaintenanceUi, ./design, ./ui.
 */
import { CaretDown } from "@phosphor-icons/react";
import { PageHeader } from "./design";
import { RowsCell, RowsRow, RowsTable } from "./MaintenanceUi";
import { Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { useWorkspace } from "../data/store";
import type { Backend } from "../data/backend";
import { can, type Snapshot } from "../domain/model";
import { programPermission } from "../domain/programs";
import {
  componentTemplateHeaders,
  parseComponentTemplateCsv,
  matchesComponentTemplate,
  componentDuplicate,
  pendingComponentSetups,
  setupParentReady,
  type ComponentTemplate,
  type ComponentSetup,
} from "../domain/componentTemplates";
import { toCsv } from "../domain/csv";
import { decodeCsvFile } from "../domain/maintenanceCsv";
import { type Component } from "../domain/components";
import { ComponentForm } from "./Components";
import { Modal, Field, AsyncForm, value, download, errorText } from "./ui";

// parseComponentTemplateCsv's limit, checked first so a larger file is never
// read.
const CSV_MAX_BYTES = 2 * 1024 * 1024;
// The limit componentTemplateSchema sets on a name, make and model.
const TEXT_MAX_LENGTH = 150;
// The form's text fields; make and model suggest the fleet's own values.
const TEMPLATE_FIELDS = [
  { label: "Template name", name: "name", key: "name" },
  {
    label: "Aircraft manufacturer / make",
    name: "make",
    key: "make",
    list: "component-template-makes",
  },
  {
    label: "Aircraft model",
    name: "aircraftModel",
    key: "model",
    list: "component-template-models",
  },
] as const;

type TemplateRow = ComponentTemplate["rows"][number];
type Editing = ComponentTemplate | "new";
type WriteProps = { s: Snapshot; writable: boolean };
type CardProps = {
  template: ComponentTemplate;
  writable: boolean;
  editable: boolean;
  onEdit: (editing: Editing) => void;
  onPreview: (template: ComponentTemplate) => void;
};
type CsvHandlers = {
  onCsv: (csv: string) => void;
  onError: (error: string) => void;
};
type PreviewProps = WriteProps & {
  template: ComponentTemplate;
  aircraftUuid?: string;
  onClose: () => void;
  onApplied: () => void;
};
type Selection = {
  template: ComponentTemplate;
  aircraftId: string;
  selected: string[];
  onSelect: (rowIds: string[]) => void;
};

/**
 * The active Flight Program's component templates: a library to write,
 * import and preview them, and the Setup incomplete list of recommended
 * components waiting to be verified. Changes need a connection; writing a
 * template, applying it and completing a setup need maintenance access.
 */
export function ComponentTemplatesPanel() {
  const { snapshot: s, online, connected } = useWorkspace();
  const [library, setLibrary] = useState(false),
    [setup, setSetup] = useState<ComponentSetup | null>(null);
  if (!s) return null;
  const writable = online && connected;
  return (
    <>
      <div className="ds-toolbar">
        <button className="button" onClick={() => setLibrary(true)}>
          Component templates
        </button>
      </div>
      <PendingSetups s={s} writable={writable} onComplete={setSetup} />
      {library && (
        <TemplateLibrary
          s={s}
          writable={writable}
          onClose={() => setLibrary(false)}
        />
      )}
      {setup && (
        <SetupWindow s={s} setup={setup} onClose={() => setSetup(null)} />
      )}
    </>
  );
}

/** The Maintenance page that holds {@link ComponentTemplatesPanel}. */
export function ImportedComponents() {
  return (
    <>
      <PageHeader
        eyebrow="MAINTENANCE"
        title="Imported"
        accent="components"
        description="Import component templates and complete verified setup before tracking components."
        actions={
          <Link className="button" to="/components">
            Back to components
          </Link>
        }
      />
      <ComponentTemplatesPanel />
    </>
  );
}

// One line per row in componentTemplateHeaders order; with no template, the
// header line alone.
function csvFor(t?: ComponentTemplate) {
  if (!t) return componentTemplateHeaders.join(",") + "\n";
  return toCsv(t.rows.map(rowCells));
}

function rowCells(r: TemplateRow) {
  const cells = [
    r.componentType,
    r.ataChapter,
    r.partNumber,
    r.model,
    r.manufacturer,
    r.installPosition,
    r.id,
    r.parentId,
  ];
  return Object.fromEntries(
    componentTemplateHeaders.map((h, i) => [h, cells[i] ?? ""]),
  );
}

function downloadSample() {
  download("component-template.csv", csvFor(), "text/csv");
}

/**
 * The Setup incomplete list: recommended components waiting for verified
 * serials and readings, with Complete setup on each row.
 *
 * @param props.aircraftUuid - Limits the list to one aircraft.
 * @param props.onComplete - Receives the setup to complete.
 * @returns The list, or null when nothing is pending.
 */
export function PendingSetups({
  s,
  writable,
  aircraftUuid,
  onComplete,
}: WriteProps & {
  aircraftUuid?: string;
  onComplete: (setup: ComponentSetup) => void;
}) {
  const pending = pendingComponentSetups(s).filter(
    (d) => !aircraftUuid || d.aircraftUuid === aircraftUuid,
  );
  if (!pending.length) return null;
  return (
    <details className="mx-pending" open>
      <summary>
        <CaretDown
          className="mx-pending-caret"
          size={CARET_SIZE}
          aria-hidden="true"
        />
        Setup incomplete — {pending.length} recommended components
      </summary>
      <p className="mx-tpl-intro">
        Serial numbers, installation dates and opening readings are unknown
        until verified. These entries are not yet installed component records.
      </p>
      <PendingTable
        s={s}
        writable={writable}
        pending={pending}
        onComplete={onComplete}
      />
    </details>
  );
}

const PENDING_COLUMNS = [
  "Component",
  "Aircraft",
  "Part / position",
  "Parent",
  "Actions",
];
const PREVIEW_COLUMNS = [
  "Select",
  "Name / type",
  "ATA",
  "Part / position",
  "Parent ID",
  "Review",
];
const CARET_SIZE = 18;

function PendingTable({
  s,
  writable,
  pending,
  onComplete,
}: WriteProps & {
  pending: ComponentSetup[];
  onComplete: (setup: ComponentSetup) => void;
}) {
  return (
    <RowsTable
      label="Components with setup incomplete"
      columns={PENDING_COLUMNS}
      cols="minmax(0, 1.3fr) minmax(0, 0.7fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 0.9fr)"
      hiddenColumns={["Actions"]}
    >
      {pending.map((d) => (
        <PendingRow
          key={d.uuid}
          s={s}
          writable={writable}
          setup={d}
          onComplete={() => onComplete(d)}
        />
      ))}
    </RowsTable>
  );
}

function PendingRow({
  s,
  writable,
  setup: d,
  onComplete,
}: WriteProps & { setup: ComponentSetup; onComplete: () => void }) {
  const ready = setupParentReady(s, d);
  const parentSetup = (s.componentSetups ?? []).find(
    (p) => p.uuid === d.parentComponentUuid,
  );
  return (
    <RowsRow>
      <RowsCell kind="main">
        {d.row.model}
        <small className="block">
          {d.row.componentType} · Setup incomplete
        </small>
      </RowsCell>
      <RowsCell caption="Aircraft">
        {s.aircraft.find((a) => a.uuid === d.aircraftUuid)?.registration}
      </RowsCell>
      <RowsCell caption="Part / position">
        {d.row.partNumber || "—"} · {d.row.installPosition || "Not specified"}
      </RowsCell>
      <RowsCell caption="Parent">{parentSetup?.row.model || "—"}</RowsCell>
      <RowsCell kind="actions">
        <button
          className="button small"
          disabled={
            !writable || !ready || !can(s, d.aircraftUuid, "maintenance")
          }
          onClick={onComplete}
        >
          Complete setup
        </button>
        {!ready && <small className="block">Complete parent first</small>}
      </RowsCell>
    </RowsRow>
  );
}

// The editor and preview open over the library; applying closes all three.
function TemplateLibrary({
  s,
  writable,
  onClose,
}: WriteProps & { onClose: () => void }) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [preview, setPreview] = useState<ComponentTemplate | null>(null);
  const editable = writable && programPermission(s, "maintenance");
  const opened = { s, writable };
  return (
    <>
      <LibraryWindow
        templates={s.componentTemplates ?? []}
        card={{ writable, editable, onEdit: setEditing, onPreview: setPreview }}
        onClose={onClose}
      />
      {editing && (
        <TemplateEditor
          key={editing === "new" ? editing : editing.uuid}
          {...opened}
          editing={editing}
          onClose={() => setEditing(null)}
        />
      )}
      {preview && (
        <TemplatePreview
          key={preview.uuid}
          {...opened}
          template={preview}
          onClose={() => setPreview(null)}
          onApplied={onClose}
        />
      )}
    </>
  );
}

function LibraryWindow({
  templates,
  card,
  onClose,
}: {
  templates: ComponentTemplate[];
  card: Omit<CardProps, "template">;
  onClose: () => void;
}) {
  return (
    <Modal title="Component templates" onClose={onClose}>
      <p className="mx-tpl-intro">
        Create reusable recommended-component lists for an aircraft make and
        model. Importing adds entries to Setup incomplete for verification.
      </p>
      <div className="mx-tpl-buttons">
        <button className="button" onClick={downloadSample}>
          Download CSV columns
        </button>
        <button
          className="button primary"
          disabled={!card.editable}
          onClick={() => card.onEdit("new")}
        >
          New template / import CSV
        </button>
      </div>
      <div className="mx-tpl-cards">
        {templates.map((t) => (
          <TemplateCard key={t.uuid} template={t} {...card} />
        ))}
      </div>
    </Modal>
  );
}

function TemplateCard({ template: t, writable, editable, ...on }: CardProps) {
  return (
    <div className="ds-card mx-tpl-card">
      <div>
        <strong>{t.name}</strong>
        <small>
          {t.make} · {t.model} · {t.rows.length} components
        </small>
      </div>
      <div className="mx-tpl-buttons">
        <button
          className="button small"
          disabled={!editable}
          onClick={() => on.onEdit(t)}
        >
          Edit template
        </button>
        <button
          className="button small"
          disabled={!writable}
          onClick={() => on.onPreview(t)}
        >
          Preview / apply to aircraft
        </button>
      </div>
    </div>
  );
}

/**
 * Writes a component template from its fields and a CSV of rows, typed or
 * imported from a file.
 *
 * @param props.editing - The template to edit, or "new".
 * @param props.onClose - Called on close and after the template is saved.
 */
export function TemplateEditor({
  s,
  writable,
  editing,
  onClose,
}: WriteProps & { editing: Editing; onClose: () => void }) {
  const { backend } = useWorkspace();
  const template = editing === "new" ? undefined : editing;
  const [csv, setCsv] = useState(() => csvFor(template));
  const [error, setError] = useState("");
  return (
    <Modal
      title={template ? "Edit component template" : "New component template"}
      onClose={onClose}
    >
      <AsyncForm
        submitLabel="Save template"
        disabled={!writable}
        onSubmit={async (d) => {
          await saveTemplate(backend!, template, d, csv);
          onClose();
        }}
      >
        <TemplateFields s={s} template={template} />
        <CsvHelp />
        <CsvFileField onCsv={setCsv} onError={setError} />
        {error && <p role="alert">{error}</p>}
        <Field label="Component rows (CSV)">
          <textarea
            rows={12}
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
          />
        </Field>
      </AsyncForm>
    </Modal>
  );
}

// The rows parse first, so a CSV error refuses the save before it is sent.
async function saveTemplate(
  backend: Backend,
  template: ComponentTemplate | undefined,
  d: FormData,
  csv: string,
) {
  const rows = parseComponentTemplateCsv(csv);
  await backend.saveComponentTemplate({
    uuid: template?.uuid ?? crypto.randomUUID(),
    version: template?.version ?? 0,
    name: value(d, "name"),
    make: value(d, "make"),
    model: value(d, "aircraftModel"),
    rows,
  });
}

function CsvFileField(on: CsvHandlers) {
  return (
    <Field label="Import component CSV">
      <input
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => void importCsv(e.target.files?.[0], on)}
      />
    </Field>
  );
}

// A file replaces the rows only once they parse; otherwise its error shows.
async function importCsv(
  file: File | undefined,
  { onCsv, onError }: CsvHandlers,
) {
  if (!file) return;
  if (file.size > CSV_MAX_BYTES) {
    onError("CSV must be under 2 MB.");
    return;
  }
  try {
    const text = decodeCsvFile(await file.arrayBuffer());
    parseComponentTemplateCsv(text);
    onCsv(text);
    onError("");
  } catch (e) {
    onError(errorText(e));
  }
}

function TemplateFields({
  s,
  template,
}: {
  s: Snapshot;
  template?: ComponentTemplate;
}) {
  return TEMPLATE_FIELDS.map((f) => (
    <Fragment key={f.name}>
      <Field label={f.label}>
        <input
          name={f.name}
          required
          maxLength={TEXT_MAX_LENGTH}
          list={"list" in f ? f.list : undefined}
          defaultValue={template?.[f.key] ?? ""}
        />
      </Field>
      {"list" in f && (
        <Suggestions id={f.list} values={s.aircraft.map((a) => a[f.key])} />
      )}
    </Fragment>
  ));
}

function Suggestions({ id, values }: { id: string; values: string[] }) {
  return (
    <datalist id={id}>
      {[...new Set(values)].map((m) => (
        <option key={m} value={m} />
      ))}
    </datalist>
  );
}

function CsvHelp() {
  return (
    <>
      <p className="mx-tpl-intro">
        Make and model must match the aircraft profile. Required columns:
        Component type, ATA chapter, Part number, Component Name. Optional:
        Manufacturer, Position, ID, Parent ID. Use unique IDs to connect child
        parts to a parent row.
      </p>
      <p className="mx-tpl-intro">
        Types: Appliance, Engine, Propeller, Main Rotor, Tail Rotor. Positions:
        LEFT, RIGHT, NUMBER 1, NUMBER 2, MAIN, AUX. ATA chapter and part number
        cells may be blank.
      </p>
    </>
  );
}

/**
 * Applies a template's chosen rows to one matching aircraft as Setup
 * incomplete entries.
 *
 * @param props.aircraftUuid - The aircraft selected when the preview opens.
 * @param props.onApplied - Called once the setups are saved.
 */
export function TemplatePreview({
  s,
  writable,
  template,
  aircraftUuid = "",
  onClose,
  onApplied,
}: PreviewProps) {
  const { backend } = useWorkspace();
  const [aircraftId, setAircraftId] = useState(aircraftUuid);
  const [selected, setSelected] = useState<string[]>([]);
  const selection = { template, aircraftId, selected, onSelect: setSelected };
  return (
    <Modal title="Preview component import" onClose={onClose}>
      <AsyncForm
        submitLabel="Import selected as setup incomplete"
        disabled={!writable}
        onSubmit={async () => {
          await applyTemplate(backend!, template, aircraftId, selected);
          onApplied();
        }}
      >
        <TargetAircraft
          s={s}
          template={template}
          aircraftId={aircraftId}
          onChange={(id) => {
            setAircraftId(id);
            setSelected([]);
          }}
        />
        <SelectionButtons s={s} {...selection} />
        <PreviewTable s={s} {...selection} />
      </AsyncForm>
    </Modal>
  );
}

async function applyTemplate(
  backend: Backend,
  template: ComponentTemplate,
  aircraftUuid: string,
  rowIds: string[],
) {
  if (!aircraftUuid || !rowIds.length)
    throw Error("Choose an aircraft and at least one component.");
  await backend.applyComponentTemplate({
    templateUuid: template.uuid,
    version: template.version,
    aircraftUuid,
    rowIds,
  });
}

function TargetAircraft({
  s,
  template,
  aircraftId,
  onChange,
}: {
  s: Snapshot;
  template: ComponentTemplate;
  aircraftId: string;
  onChange: (aircraftId: string) => void;
}) {
  const eligible = s.aircraft.filter(
    (a) =>
      can(s, a.uuid, "maintenance") && matchesComponentTemplate(template, a),
  );
  return (
    <>
      <Field label="Target aircraft">
        <select
          value={aircraftId}
          required
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Select matching aircraft</option>
          {eligible.map((a) => (
            <option key={a.uuid} value={a.uuid}>
              {a.registration}
            </option>
          ))}
        </select>
      </Field>
      {!eligible.length && (
        <p>
          No aircraft with maintenance access matches this template’s
          make/model.
        </p>
      )}
    </>
  );
}

function SelectionButtons({
  s,
  template,
  aircraftId,
  onSelect,
}: Selection & { s: Snapshot }) {
  return (
    <div className="mx-tpl-buttons">
      <button
        type="button"
        className="button small"
        disabled={!aircraftId}
        onClick={() =>
          onSelect(
            template.rows
              .filter((r) => !componentDuplicate(s, aircraftId, r))
              .map((r) => r.id),
          )
        }
      >
        Select new entries
      </button>
      <button
        type="button"
        className="button small"
        onClick={() => onSelect([])}
      >
        Clear selection
      </button>
    </div>
  );
}

function PreviewTable({ s, ...selection }: Selection & { s: Snapshot }) {
  return (
    <RowsTable
      label="Template components"
      columns={PREVIEW_COLUMNS}
      cols="28px minmax(0, 1.3fr) 56px minmax(0, 1fr) minmax(0, 0.7fr) minmax(0, 1.2fr)"
      hiddenColumns={["Select"]}
    >
      {selection.template.rows.map((r) => (
        <PreviewRow
          key={r.id}
          row={r}
          duplicate={componentDuplicate(s, selection.aircraftId, r)}
          {...selection}
        />
      ))}
    </RowsTable>
  );
}

function PreviewRow({
  row: r,
  duplicate,
  aircraftId,
  selected,
  onSelect,
}: Selection & { row: TemplateRow; duplicate: boolean }) {
  return (
    <RowsRow>
      <RowsCell kind="check">
        <input
          aria-label={`Select ${r.model}`}
          type="checkbox"
          disabled={!aircraftId || duplicate}
          checked={selected.includes(r.id)}
          onChange={(e) => onSelect(toggled(selected, r.id, e.target.checked))}
        />
      </RowsCell>
      <RowsCell kind="main">
        {r.model}
        <small className="block">{r.componentType}</small>
      </RowsCell>
      <RowsCell caption="ATA">{r.ataChapter || "—"}</RowsCell>
      <RowsCell caption="Part / position">
        {r.partNumber || "—"} · {r.installPosition || "—"}
      </RowsCell>
      <RowsCell caption="Parent ID">{r.parentId || "—"}</RowsCell>
      <RowsCell caption="Review">
        {duplicate
          ? "Already imported / possible duplicate"
          : "Serial and readings left blank"}
      </RowsCell>
    </RowsRow>
  );
}

function toggled(selected: string[], id: string, checked: boolean) {
  return checked ? [...selected, id] : selected.filter((x) => x !== id);
}

/**
 * Completes one Setup incomplete entry through the component form, with the
 * template's identity filled in and the readings left blank.
 *
 * @param props.onClose - Called on close and once the component is saved.
 */
export function SetupWindow({
  s,
  setup,
  onClose,
}: {
  s: Snapshot;
  setup: ComponentSetup;
  onClose: () => void;
}) {
  const parentUuid = setup.parentComponentUuid;
  const parent = parentUuid
    ? (s.management ?? []).find(
        (c): c is Component => c.kind === "component" && c.uuid === parentUuid,
      )
    : undefined;
  return (
    <Modal title={`Complete setup — ${setup.row.model}`} onClose={onClose}>
      <ComponentForm
        key={setup.uuid}
        initialAircraftUuid={setup.aircraftUuid}
        parentComponent={parent}
        defaults={{ ...setup.row, uuid: setup.uuid }}
        review={
          <p className="notice">
            Verify this component is installed and enter its opening readings
            from maintenance records. Serial number may remain blank if unknown.
          </p>
        }
        onDone={onClose}
      />
    </Modal>
  );
}
