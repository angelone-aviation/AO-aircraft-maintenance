import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useWorkspace } from "../data/store";
import { can } from "../domain/model";
import { programPermission } from "../domain/programs";
import {
  componentTemplateHeaders,
  parseComponentTemplateCsv,
  matchesComponentTemplate,
  componentDuplicate,
  type ComponentTemplate,
  type ComponentSetup,
} from "../domain/componentTemplates";
import { toCsv } from "../domain/csv";
import { type Component } from "../domain/components";
import { ComponentForm } from "./Components";
import { Modal, Field, AsyncForm, PageTitle, value, download } from "./ui";
const csvFor = (t?: ComponentTemplate) =>
  t
    ? toCsv(
        t.rows.map((r) =>
          Object.fromEntries(
            componentTemplateHeaders.map((h, i) => [
              h,
              [
                r.componentType,
                r.ataChapter,
                r.partNumber,
                r.model,
                r.manufacturer,
                r.installPosition,
                r.id,
                r.parentId,
              ][i] ?? "",
            ]),
          ),
        ),
      )
    : componentTemplateHeaders.join(",") + "\n";
function downloadSample() {
  download("component-template.csv", csvFor(), "text/csv");
}
export function ComponentTemplatesPanel() {
  const { snapshot: s, backend, online, connected } = useWorkspace();
  const [library, setLibrary] = useState(false),
    [editing, setEditing] = useState<ComponentTemplate | "new" | null>(null),
    [csv, setCsv] = useState(""),
    [error, setError] = useState(""),
    [preview, setPreview] = useState<ComponentTemplate | null>(null),
    [aircraftId, setAircraftId] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [setup, setSetup] = useState<ComponentSetup | null>(null);
  if (!s) return null;
  const writable = online && connected;
  const templates = s.componentTemplates ?? [];
  const pending = (s.componentSetups ?? []).filter(
    (d) =>
      !(s.management ?? []).some(
        (c) => c.kind === "component" && c.uuid === d.uuid,
      ),
  );
  const parent = setup?.parentComponentUuid
    ? (s.management ?? []).find(
        (c): c is Component =>
          c.kind === "component" && c.uuid === setup.parentComponentUuid,
      )
    : undefined;
  const eligible = preview
    ? s.aircraft.filter(
        (a) =>
          can(s, a.uuid, "maintenance") && matchesComponentTemplate(preview, a),
      )
    : [];
  return (
    <>
      <div className="management-toolbar">
        <button className="button" onClick={() => setLibrary(true)}>
          Component templates
        </button>
      </div>
      {pending.length > 0 && (
        <details open>
          <summary>
            Setup incomplete — {pending.length} recommended components
          </summary>
          <p>
            Serial numbers, installation dates and opening readings are unknown
            until verified. These entries are not yet installed component
            records.
          </p>
          <div className="panel table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Aircraft</th>
                  <th>Component</th>
                  <th>Part / position</th>
                  <th>Parent</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {pending.map((d) => {
                  const parentReady =
                    !d.parentComponentUuid ||
                    (s.management ?? []).some(
                      (c) =>
                        c.kind === "component" &&
                        c.uuid === d.parentComponentUuid &&
                        c.installed &&
                        c.aircraftUuid === d.aircraftUuid,
                    );
                  return (
                    <tr key={d.uuid}>
                      <td>
                        {
                          s.aircraft.find((a) => a.uuid === d.aircraftUuid)
                            ?.registration
                        }
                      </td>
                      <td>
                        {d.row.model}
                        <small className="block">
                          {d.row.componentType} · Setup incomplete
                        </small>
                      </td>
                      <td>
                        {d.row.partNumber || "—"} ·{" "}
                        {d.row.installPosition || "Not specified"}
                      </td>
                      <td>
                        {(s.componentSetups ?? []).find(
                          (p) => p.uuid === d.parentComponentUuid,
                        )?.row.model || "—"}
                      </td>
                      <td>
                        <button
                          className="button"
                          disabled={
                            !writable ||
                            !parentReady ||
                            !can(s, d.aircraftUuid, "maintenance")
                          }
                          onClick={() => setSetup(d)}
                        >
                          Complete setup
                        </button>
                        {!parentReady && (
                          <small className="block">Complete parent first</small>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {library && (
        <Modal title="Component templates" onClose={() => setLibrary(false)}>
          <p>
            Create reusable recommended-component lists for an aircraft make and
            model. Importing adds entries to Setup incomplete for verification.
          </p>
          <button className="button" onClick={downloadSample}>
            Download CSV columns
          </button>{" "}
          <button
            className="button primary"
            disabled={!writable || !programPermission(s, "maintenance")}
            onClick={() => {
              setEditing("new");
              setCsv(csvFor());
              setError("");
            }}
          >
            New template / import CSV
          </button>
          {templates.map((t) => (
            <div className="panel" key={t.uuid}>
              <strong>{t.name}</strong>
              <p>
                {t.make} · {t.model} · {t.rows.length} components
              </p>
              <button
                className="button"
                disabled={!writable || !programPermission(s, "maintenance")}
                onClick={() => {
                  setEditing(t);
                  setCsv(csvFor(t));
                  setError("");
                }}
              >
                Edit template
              </button>{" "}
              <button
                className="button"
                disabled={!writable}
                onClick={() => {
                  setPreview(t);
                  setAircraftId("");
                  setSelected([]);
                }}
              >
                Preview / apply to aircraft
              </button>
            </div>
          ))}
        </Modal>
      )}
      {editing && (
        <Modal
          title={
            editing === "new"
              ? "New component template"
              : "Edit component template"
          }
          onClose={() => setEditing(null)}
        >
          <AsyncForm
            submitLabel="Save template"
            disabled={!writable}
            onSubmit={async (d) => {
              const rows = parseComponentTemplateCsv(csv);
              await backend!.saveComponentTemplate({
                uuid: editing === "new" ? crypto.randomUUID() : editing.uuid,
                version: editing === "new" ? 0 : editing.version,
                name: value(d, "name"),
                make: value(d, "make"),
                model: value(d, "aircraftModel"),
                rows,
              });
              setEditing(null);
            }}
          >
            <Field label="Template name">
              <input
                name="name"
                required
                maxLength={150}
                defaultValue={editing === "new" ? "" : editing.name}
              />
            </Field>
            <Field label="Aircraft manufacturer / make">
              <input
                name="make"
                required
                maxLength={150}
                list="component-template-makes"
                defaultValue={editing === "new" ? "" : editing.make}
              />
            </Field>
            <datalist id="component-template-makes">
              {[...new Set(s.aircraft.map((a) => a.make))].map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <Field label="Aircraft model">
              <input
                name="aircraftModel"
                required
                maxLength={150}
                list="component-template-models"
                defaultValue={editing === "new" ? "" : editing.model}
              />
            </Field>
            <datalist id="component-template-models">
              {[...new Set(s.aircraft.map((a) => a.model))].map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <p>
              Make and model must match the aircraft profile. Required columns:
              Component type, ATA chapter, Part number, Component Name.
              Optional: Manufacturer, Position, ID, Parent ID. Use unique IDs to
              connect child parts to a parent row.
            </p>
            <p>
              Types: Appliance, Engine, Propeller, Main Rotor, Tail Rotor.
              Positions: LEFT, RIGHT, NUMBER 1, NUMBER 2, MAIN, AUX. ATA chapter
              and part number cells may be blank.
            </p>
            <Field label="Import component CSV">
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  try {
                    if (f.size > 2 * 1024 * 1024)
                      throw Error("CSV must be under 2 MB.");
                    const text = await f.text();
                    parseComponentTemplateCsv(text);
                    setCsv(text);
                    setError("");
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  }
                }}
              />
            </Field>
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
      )}
      {preview && (
        <Modal
          title="Preview component import"
          onClose={() => setPreview(null)}
        >
          <AsyncForm
            submitLabel="Import selected as setup incomplete"
            disabled={!writable}
            onSubmit={async () => {
              if (!aircraftId || !selected.length)
                throw Error("Choose an aircraft and at least one component.");
              await backend!.applyComponentTemplate({
                templateUuid: preview.uuid,
                version: preview.version,
                aircraftUuid: aircraftId,
                rowIds: selected,
              });
              setPreview(null);
              setLibrary(false);
            }}
          >
            <Field label="Target aircraft">
              <select
                value={aircraftId}
                required
                onChange={(e) => {
                  setAircraftId(e.target.value);
                  setSelected([]);
                }}
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
            <button
              type="button"
              className="button"
              disabled={!aircraftId}
              onClick={() =>
                setSelected(
                  preview.rows
                    .filter((r) => !componentDuplicate(s, aircraftId, r))
                    .map((r) => r.id),
                )
              }
            >
              Select new entries
            </button>{" "}
            <button
              type="button"
              className="button"
              onClick={() => setSelected([])}
            >
              Clear selection
            </button>
            <table>
              <thead>
                <tr>
                  <th>Select</th>
                  <th>Name / type</th>
                  <th>ATA</th>
                  <th>Part / position</th>
                  <th>Parent ID</th>
                  <th>Review</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => {
                  const duplicate = componentDuplicate(s, aircraftId, r);
                  return (
                    <tr key={r.id}>
                      <td>
                        <input
                          aria-label={`Select ${r.model}`}
                          type="checkbox"
                          disabled={!aircraftId || duplicate}
                          checked={selected.includes(r.id)}
                          onChange={(e) =>
                            setSelected(
                              e.target.checked
                                ? [...selected, r.id]
                                : selected.filter((id) => id !== r.id),
                            )
                          }
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
                })}
              </tbody>
            </table>
          </AsyncForm>
        </Modal>
      )}
      {setup && (
        <Modal
          title={`Complete setup — ${setup.row.model}`}
          onClose={() => setSetup(null)}
        >
          <ComponentForm
            key={setup.uuid}
            initialAircraftUuid={setup.aircraftUuid}
            parentComponent={parent}
            defaults={{ ...setup.row, uuid: setup.uuid }}
            review={
              <p className="notice">
                Verify this component is installed and enter its opening
                readings from maintenance records. Serial number may remain
                blank if unknown.
              </p>
            }
            onDone={() => setSetup(null)}
          />
        </Modal>
      )}
    </>
  );
}

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
