/**
 * Responsibility: Component templates: the library with its editor, CSV
 *   import and preview, the Setup incomplete list, and the Imported
 *   components page.
 * Layer: UI. React components; template rules live in src/domain.
 * Dependencies: react, @tanstack/react-router, src/data/store.ts,
 *   src/data/backend.ts (types), src/domain (model, programs, components,
 *   componentTemplates, csv), ./Components, ./ui.
 */
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
import { type Component } from "../domain/components";
import { ComponentForm } from "./Components";
import {
  Modal,
  Field,
  AsyncForm,
  PageTitle,
  value,
  download,
  errorText,
} from "./ui";

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
      <div className="management-toolbar">
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
      <PageTitle
        eyebrow="MAINTENANCE"
        title="Imported components"
        description="Import component templates and complete verified setup before tracking components."
        action={
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

function PendingSetups({
  s,
  writable,
  onComplete,
}: WriteProps & { onComplete: (setup: ComponentSetup) => void }) {
  const pending = pendingComponentSetups(s);
  if (!pending.length) return null;
  return (
    <details open>
      <summary>
        Setup incomplete — {pending.length} recommended components
      </summary>
      <p>
        Serial numbers, installation dates and opening readings are unknown
        until verified. These entries are not yet installed component records.
      </p>
      <div className="panel table-wrap">
        <table>
          <TableHead
            columns={["Aircraft", "Component", "Part / position", "Parent"]}
            actions
          />
          <tbody>
            {pending.map((d) => (
              <PendingRow
                key={d.uuid}
                s={s}
                writable={writable}
                setup={d}
                onComplete={() => onComplete(d)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </details>
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
    <tr>
      <td>{s.aircraft.find((a) => a.uuid === d.aircraftUuid)?.registration}</td>
      <td>
        {d.row.model}
        <small className="block">
          {d.row.componentType} · Setup incomplete
        </small>
      </td>
      <td>
        {d.row.partNumber || "—"} · {d.row.installPosition || "Not specified"}
      </td>
      <td>{parentSetup?.row.model || "—"}</td>
      <td>
        <button
          className="button"
          disabled={
            !writable || !ready || !can(s, d.aircraftUuid, "maintenance")
          }
          onClick={onComplete}
        >
          Complete setup
        </button>
        {!ready && <small className="block">Complete parent first</small>}
      </td>
    </tr>
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
      <p>
        Create reusable recommended-component lists for an aircraft make and
        model. Importing adds entries to Setup incomplete for verification.
      </p>
      <button className="button" onClick={downloadSample}>
        Download CSV columns
      </button>{" "}
      <button
        className="button primary"
        disabled={!card.editable}
        onClick={() => card.onEdit("new")}
      >
        New template / import CSV
      </button>
      {templates.map((t) => (
        <TemplateCard key={t.uuid} template={t} {...card} />
      ))}
    </Modal>
  );
}

function TemplateCard({ template: t, writable, editable, ...on }: CardProps) {
  return (
    <div className="panel">
      <strong>{t.name}</strong>
      <p>
        {t.make} · {t.model} · {t.rows.length} components
      </p>
      <button
        className="button"
        disabled={!editable}
        onClick={() => on.onEdit(t)}
      >
        Edit template
      </button>{" "}
      <button
        className="button"
        disabled={!writable}
        onClick={() => on.onPreview(t)}
      >
        Preview / apply to aircraft
      </button>
    </div>
  );
}

function TemplateEditor({
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
    const text = await file.text();
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
      <p>
        Make and model must match the aircraft profile. Required columns:
        Component type, ATA chapter, Part number, Component Name. Optional:
        Manufacturer, Position, ID, Parent ID. Use unique IDs to connect child
        parts to a parent row.
      </p>
      <p>
        Types: Appliance, Engine, Propeller, Main Rotor, Tail Rotor. Positions:
        LEFT, RIGHT, NUMBER 1, NUMBER 2, MAIN, AUX. ATA chapter and part number
        cells may be blank.
      </p>
    </>
  );
}

function TemplatePreview({
  s,
  writable,
  template,
  onClose,
  onApplied,
}: PreviewProps) {
  const { backend } = useWorkspace();
  const [aircraftId, setAircraftId] = useState("");
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
    <>
      <button
        type="button"
        className="button"
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
      </button>{" "}
      <button type="button" className="button" onClick={() => onSelect([])}>
        Clear selection
      </button>
    </>
  );
}

function PreviewTable({ s, ...selection }: Selection & { s: Snapshot }) {
  return (
    <table>
      <TableHead
        columns={[
          "Select",
          "Name / type",
          "ATA",
          "Part / position",
          "Parent ID",
          "Review",
        ]}
      />
      <tbody>
        {selection.template.rows.map((r) => (
          <PreviewRow
            key={r.id}
            row={r}
            duplicate={componentDuplicate(s, selection.aircraftId, r)}
            {...selection}
          />
        ))}
      </tbody>
    </table>
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
    <tr>
      <td>
        <input
          aria-label={`Select ${r.model}`}
          type="checkbox"
          disabled={!aircraftId || duplicate}
          checked={selected.includes(r.id)}
          onChange={(e) => onSelect(toggled(selected, r.id, e.target.checked))}
        />
      </td>
      <td>
        {r.model}
        <small className="block">{r.componentType}</small>
      </td>
      <td>{r.ataChapter || "—"}</td>
      <td>
        {r.partNumber || "—"} · {r.installPosition || "—"}
      </td>
      <td>{r.parentId || "—"}</td>
      <td>
        {duplicate
          ? "Already imported / possible duplicate"
          : "Serial and readings left blank"}
      </td>
    </tr>
  );
}

function toggled(selected: string[], id: string, checked: boolean) {
  return checked ? [...selected, id] : selected.filter((x) => x !== id);
}

function TableHead({
  columns,
  actions = false,
}: {
  columns: string[];
  actions?: boolean;
}) {
  return (
    <thead>
      <tr>
        {columns.map((c) => (
          <th key={c}>{c}</th>
        ))}
        {actions && (
          <th>
            <span className="sr-only">Actions</span>
          </th>
        )}
      </tr>
    </thead>
  );
}

function SetupWindow({
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
