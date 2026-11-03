import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useWorkspace } from "../data/store";
import { can } from "../domain/model";
import type { Manual, ManualApplicability } from "../domain/manuals";
import {
  manualApplicability,
  matchesAircraft,
  matchesComponent,
  type ManualCandidate,
} from "../domain/manualDiscovery";
import { programPermission } from "../domain/programs";
import type { Component, ComponentRequirement } from "../domain/components";
import { ComponentForm, RequirementForm } from "./Components";
import {
  ManualLink,
  ManualReferenceFields,
  manualReferenceFromForm,
} from "./Manuals";
import { AsyncForm, Field, Modal, value } from "./ui";
import { openManualFile } from "./KeepOnDevice";
import {
  NumberField,
  num,
  secs,
  today,
  useManagement,
} from "./ManagementShared";
import { endOfDueMonth } from "../domain/maintenance";
import { AtaChapterField } from "./AtaChapterField";
import { ataChapterSchema } from "../domain/ata";

export function ManualDiscoveryButton({ manual }: { manual: Manual }) {
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
        Find maintenance items
      </button>
      {open &&
        createPortal(
          <Modal
            wide
            title="Find maintenance items"
            onClose={() => setOpen(false)}
          >
            <ManualDiscovery manualUuid={manual.uuid} />
          </Modal>,
          document.body,
        )}
    </>
  );
}
export function ReviewConfirmation() {
  return (
    <label className="checkbox">
      <input type="checkbox" name="reviewed" required /> I checked the source
      pages, applicability, all conditions and the schedule entered below.
    </label>
  );
}
export function ApplicabilityEditor({
  manual,
  scope,
  onDone,
}: {
  manual: Manual;
  scope?: ManualApplicability;
  onDone: () => void;
}) {
  const { backend, online, connected } = useWorkspace();
  const [kind, setKind] = useState(scope?.kind ?? "aircraft");
  return (
    <AsyncForm
      disabled={!online || !connected}
      submitLabel="Save model association"
      onSubmit={async (d) => {
        await backend!.setManualApplicability(manual.uuid, {
          kind,
          manufacturer: value(d, "manufacturer"),
          model: value(d, "model"),
          partNumber: kind === "component" ? value(d, "partNumber") : "",
        });
        onDone();
      }}
    >
      <p>
        The model association filters suggested targets. The uploading aircraft
        still controls access to this manual.
      </p>
      <Field label="Manual applies to">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
        >
          <option value="aircraft">Aircraft model</option>
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
      <Field label="Applicable model">
        <input
          name="model"
          defaultValue={scope?.model}
          required
          maxLength={150}
        />
      </Field>
      {kind === "component" && (
        <Field label="Applicable part number (optional)">
          <input
            name="partNumber"
            defaultValue={scope?.partNumber}
            maxLength={100}
          />
        </Field>
      )}
    </AsyncForm>
  );
}
function ManualDiscovery({ manualUuid }: { manualUuid: string }) {
  const { snapshot: s, online, connected } = useWorkspace();
  const manual = s!.manuals?.find((m) => m.uuid === manualUuid);
  const scope =
    manual &&
    manualApplicability(
      manual,
      s!.aircraft.find((a) => a.uuid === manual.aircraftUuid),
    );
  const [editScope, setEditScope] = useState(false);
  const [rows, setRows] = useState<ManualCandidate[]>([]);
  const [query, setQuery] = useState("");
  const [visibleLimit, setVisibleLimit] = useState(100);
  const [progress, setProgress] = useState("");
  const [summary, setSummary] = useState("");
  const [selected, setSelected] = useState<{
    row: ManualCandidate;
    action: "inspection" | "requirement" | "component";
  }>();
  const [saved, setSaved] = useState("");
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  if (!manual) return <p>Manual is unavailable in this Flight Program.</p>;
  const writable =
    online && connected && can(s!, manual.aircraftUuid, "maintenance");
  const visible = rows.filter((r) =>
    `${r.name} ${r.text}`.toLowerCase().includes(query.toLowerCase()),
  );
  const choose = (
    row: ManualCandidate,
    action: "inspection" | "requirement" | "component",
  ) => {
    setSaved("");
    setSelected({ row, action });
  };
  return (
    <>
      <h3>
        {manual.title} · {manual.revision}
      </h3>
      <p>
        Associated {scope?.kind ?? "aircraft"} model:{" "}
        <strong>
          {scope
            ? `${scope.manufacturer} ${scope.model}${scope.partNumber ? ` · ${scope.partNumber}` : ""}`
            : "Not set"}
        </strong>{" "}
        <button
          type="button"
          className="button"
          disabled={!writable || !!progress}
          onClick={() => {
            setEditScope(!editScope);
            setSelected(undefined);
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
      <p>
        Search selectable PDF text for inspection, overhaul, replacement and
        life-limit items. Results are suggestions, not a complete maintenance
        program. Scanned pages need OCR; table layouts and continuation pages
        need source review.
      </p>
      <AsyncForm
        disabled={!writable || !!progress || !scope || editScope}
        submitLabel="Search manual"
        onSubmit={async (d) => {
          const from = Number(value(d, "from")),
            to = Number(value(d, "to"));
          if (
            !Number.isInteger(from) ||
            !Number.isInteger(to) ||
            from < 1 ||
            to < from ||
            to > manual.pageCount
          )
            throw new Error("Choose a valid PDF page range.");
          const abort = new AbortController();
          controller.current = abort;
          setRows([]);
          setSelected(undefined);
          setSaved("");
          setSummary("");
          setProgress("Opening PDF…");
          let url = "";
          let found: ManualCandidate[] = [];
          try {
            const { searchManualPdf } = await import("../data/manualPdf");
            // A copy kept on this device saves downloading the manual again.
            url = (await openManualFile(manual.uuid)).url;
            if (abort.signal.aborted) return;
            const result = await searchManualPdf(
              url,
              manual.uuid,
              from,
              to,
              (page, candidates) => {
                found = found.concat(candidates);
                if (mounted.current) {
                  setRows(found);
                  setProgress(
                    `Read PDF page ${page} of ${to} · ${found.length} suggestions`,
                  );
                }
              },
              abort.signal,
            );
            if (mounted.current)
              setSummary(
                `Searched PDF pages ${from}–${to}. Found ${found.length} suggestions. ${result.emptyPages.length ? `${result.emptyPages.length} pages had little or no searchable text (pages ${result.emptyPages.slice(0, 20).join(", ")}${result.emptyPages.length > 20 ? ", …" : ""}); review these pages separately.` : "All selected pages contained text."}`,
              );
          } catch (e) {
            if (abort.signal.aborted) {
              if (mounted.current)
                setSummary(
                  "Search canceled. Partial results are shown; the remaining pages were not searched.",
                );
            } else {
              if (mounted.current)
                setSummary(
                  "Search failed before completion. Any results shown are partial.",
                );
              throw e;
            }
          } finally {
            if (url.startsWith("blob:")) URL.revokeObjectURL(url);
            controller.current = null;
            if (mounted.current) setProgress("");
          }
        }}
      >
        <div className="form-grid">
          <Field label="First PDF page">
            <input
              type="number"
              name="from"
              min={1}
              max={manual.pageCount}
              defaultValue={1}
              required
            />
          </Field>
          <Field label="Last PDF page">
            <input
              type="number"
              name="to"
              min={1}
              max={manual.pageCount}
              defaultValue={manual.pageCount}
              required
            />
          </Field>
        </div>
        <p className="muted">
          For a large manual, start with the inspection / time-limits chapter.
          Results remain here until you close this window; saved records remain
          in the app.
        </p>
      </AsyncForm>
      {progress && (
        <p role="status">
          {progress}{" "}
          <button
            type="button"
            className="button"
            onClick={() => controller.current?.abort()}
          >
            Cancel search
          </button>
        </p>
      )}
      {summary && <p role="status">{summary}</p>}
      {saved && <p role="status">{saved}</p>}
      {!!rows.length && (
        <Field label="Filter found items">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Phase 2, oxygen, actuator…"
          />
        </Field>
      )}
      {(["inspection", "component"] as const).map((kind) => (
        <section key={kind}>
          <h3>
            {kind === "inspection"
              ? "Inspection and service candidates"
              : "Suggested trackable components and limits"}{" "}
            ({visible.filter((r) => r.kind === kind).length})
          </h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Suggested interval / limit</th>
                  <th>Description / source</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible
                  .filter((r) => r.kind === kind)
                  .slice(0, visibleLimit)
                  .map((row) => (
                    <Fragment key={row.sourceKey}>
                      <tr>
                        <td>{row.name}</td>
                        <td>
                          {row.hours !== undefined && (
                            <div>{row.hours} hours</div>
                          )}
                          {row.cycles !== undefined && (
                            <div>{row.cycles} cycles</div>
                          )}
                          {row.months !== undefined && (
                            <div>{row.months} months</div>
                          )}
                          {row.hours === undefined &&
                            row.cycles === undefined &&
                            row.months === undefined &&
                            "Needs interpretation"}
                          <small className="block">
                            Confirm recurring versus absolute limit.
                          </small>
                        </td>
                        <td>
                          <details>
                            <summary>Review extracted text</summary>
                            <pre
                              style={{
                                whiteSpace: "pre-wrap",
                                maxHeight: "22rem",
                                overflow: "auto",
                              }}
                            >
                              {row.text}
                            </pre>
                          </details>
                          <ManualLink reference={row.reference} />
                          {row.warnings.map((w) => (
                            <small className="block" key={w}>
                              {w}
                            </small>
                          ))}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="button"
                            disabled={
                              !writable ||
                              !!progress ||
                              !scope ||
                              editScope ||
                              scope.kind !== "aircraft"
                            }
                            onClick={() => choose(row, "inspection")}
                          >
                            Create inspection
                          </button>
                          <button
                            type="button"
                            className="button"
                            disabled={
                              !writable || !!progress || !scope || editScope
                            }
                            onClick={() => choose(row, "requirement")}
                          >
                            Create component service requirement
                          </button>
                          {kind === "component" && (
                            <button
                              type="button"
                              className="button"
                              disabled={
                                !writable || !!progress || !scope || editScope
                              }
                              onClick={() => choose(row, "component")}
                            >
                              Create component
                            </button>
                          )}
                        </td>
                      </tr>
                      {selected?.row.sourceKey === row.sourceKey && scope && (
                        <tr>
                          <td colSpan={4}>
                            <section
                              className="panel"
                              aria-label="Create from manual item"
                            >
                              <button
                                type="button"
                                className="button"
                                onClick={() => setSelected(undefined)}
                              >
                                Close item form
                              </button>
                              <CandidateForm
                                key={`${row.sourceKey}:${selected.action}`}
                                row={row}
                                scope={scope}
                                action={selected.action}
                                onDone={() => {
                                  setSaved(
                                    "Saved. You can select another item or target. Existing imports are checked before saving.",
                                  );
                                  setSelected(undefined);
                                }}
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
          {visible.filter((r) => r.kind === kind).length > visibleLimit && (
            <button
              type="button"
              className="button"
              onClick={() => setVisibleLimit((n) => n + 100)}
            >
              Show more suggestions
            </button>
          )}
          {!visible.some((r) => r.kind === kind) && (
            <p className="muted">
              No matching suggestions. Try a different page range or filter;
              absence from these results does not establish that no requirements
              exist.
            </p>
          )}
        </section>
      ))}
    </>
  );
}
export function CandidateForm({
  row,
  scope,
  action,
  onDone,
}: {
  row: ManualCandidate;
  scope: ManualApplicability;
  action: "inspection" | "requirement" | "component";
  onDone: () => void;
}) {
  const { s } = useManagement();
  const aircraft = s.aircraft.filter(
    (a) => can(s, a.uuid, "maintenance") && matchesAircraft(a, scope),
  );
  const components = (s.management ?? []).filter(
    (c): c is Component =>
      c.kind === "component" &&
      (c.aircraftUuid
        ? can(s, c.aircraftUuid, "maintenance")
        : programPermission(s, "maintenance")) &&
      (scope.kind === "component"
        ? matchesComponent(c, scope)
        : aircraft.some((a) => a.uuid === c.aircraftUuid)) &&
      (!row.componentDefaults?.model ||
        c.model?.trim().toLowerCase() ===
          row.componentDefaults.model.trim().toLowerCase()) &&
      (!row.componentDefaults?.manufacturer ||
        c.manufacturer.trim().toLowerCase() ===
          row.componentDefaults.manufacturer.trim().toLowerCase()) &&
      (!row.componentDefaults?.partNumber ||
        c.partNumber.trim().toLowerCase() ===
          row.componentDefaults.partNumber.trim().toLowerCase()),
  );
  const [componentId, setComponentId] = useState("");
  const [createdId, setCreatedId] = useState("");
  const c = (s.management ?? []).find(
    (c): c is Component =>
      c.kind === "component" && c.uuid === (createdId || componentId),
  );
  const isLife = row.kind === "component" && !/\boverhaul\b/i.test(row.text);
  const defaults: Partial<ComponentRequirement> = {
    sourceKey: row.sourceKey,
    manualReference: row.reference,
    description: row.name.slice(0, 255),
    notes: row.text.slice(0, 10000),
    requirementType: isLife
      ? "Life Limits"
      : /\boverhaul\b/i.test(row.text)
        ? "Overhaul Requirement"
        : "Inspection Requirement",
    intervalSeconds: row.hours === undefined ? undefined : row.hours * 3600,
    intervalCycles: row.cycles,
    calendarIntervalValue: row.months,
    calendarIntervalUnit: "MONTHS",
    timeBasis: "TSN",
    timeLimitMode: isLife ? "ABSOLUTE" : "FROM_LAST_COMPLIED",
    cycleLimitMode: isLife ? "ABSOLUTE" : "FROM_LAST_COMPLIED",
    ...row.requirementDefaults,
  };
  if (action === "inspection")
    return <InspectionCandidateForm row={row} scope={scope} onDone={onDone} />;
  if (action === "component" && !createdId)
    return (
      <>
        <h3>Create trackable component</h3>
        <p>
          Check existing components before adding another physical unit. After
          saving, add its service requirement below.
        </p>
        {components.length > 0 && (
          <p>
            Matching existing components:{" "}
            {components
              .map(
                (c) =>
                  `${c.componentType} / ${c.partNumber} / ${c.serial || "no serial"}`,
              )
              .join("; ")}
            . Use “Create component service requirement” to add a limit to one
            of these.
          </p>
        )}
        <ComponentForm
          aircraftUuids={
            scope.kind === "aircraft" ? aircraft.map((a) => a.uuid) : undefined
          }
          defaults={{
            componentType: row.name.slice(0, 100),
            model: scope.kind === "component" ? scope.model : "",
            manufacturer: scope.kind === "component" ? scope.manufacturer : "",
            partNumber: scope.kind === "component" ? scope.partNumber : "",
            notes: row.text.slice(0, 10000),
            manualReference: row.reference,
            ...row.componentDefaults,
          }}
          review={<ReviewConfirmation />}
          onDone={setCreatedId}
        />
      </>
    );
  const duplicate =
    c &&
    s.management?.some(
      (r) =>
        r.kind === "componentRequirement" &&
        r.componentUuid === c.uuid &&
        r.sourceKey === row.sourceKey,
    );
  const missingTracking =
    c &&
    ((row.hours !== undefined && !c.trackTime) ||
      (row.cycles !== undefined && !c.trackCycles) ||
      ((row.months !== undefined ||
        row.requirementDefaults?.calendarIntervalValue !== undefined) &&
        !c.trackCalendar));
  return (
    <>
      <h3>Create component service requirement</h3>
      {createdId ? (
        <p role="status">
          Component saved. Complete its service requirement below; the component
          remains saved if you close this form.
        </p>
      ) : (
        <Field label="Target component">
          <select
            value={componentId}
            onChange={(e) => setComponentId(e.target.value)}
          >
            <option value="">Select a matching component</option>
            {components.map((c) => (
              <option value={c.uuid} key={c.uuid}>
                {c.componentType} · {c.model || c.partNumber} ·{" "}
                {c.serial || "No serial"} ·{" "}
                {s.aircraft.find((a) => a.uuid === c.aircraftUuid)
                  ?.registration ?? "Inventory"}
              </option>
            ))}
          </select>
        </Field>
      )}
      {!createdId && !components.length && (
        <p>
          No matching components. Set the component model in Components, verify
          the manual association, or create the physical component first.
        </p>
      )}
      {duplicate ? (
        <p>
          This manual item has already been added to this component. Edit it
          from Components.
        </p>
      ) : missingTracking ? (
        <p>
          Enable all suggested tracking dimensions (time, cycles or calendar) in
          this component’s details before adding this requirement.
        </p>
      ) : (
        c && (
          <RequirementForm
            key={c.uuid}
            c={c}
            defaults={defaults}
            review={
              <>
                <p>
                  Review the limit type and tracking basis. Calendar month/year
                  limits use the end of the due month; do not use this for a
                  different age or shelf-life rule.
                </p>
                <ReviewConfirmation />
              </>
            }
            onDone={onDone}
          />
        )
      )}
    </>
  );
}
function InspectionCandidateForm({
  row,
  scope,
  onDone,
}: {
  row: ManualCandidate;
  scope: ManualApplicability;
  onDone: () => void;
}) {
  const { s, writable, execute } = useManagement();
  const aircraft = s.aircraft.filter(
    (a) => can(s, a.uuid, "maintenance") && matchesAircraft(a, scope),
  );
  const [target, setTarget] = useState("");
  const hasInitial =
    row.initialHours !== undefined || row.initialCycles !== undefined;
  const [scheduleMode, setScheduleMode] = useState(
    hasInitial ? "" : "recurring",
  );
  const sourceKey =
    row.sourceKey + (scheduleMode === "initial" ? ":initial" : "");
  const [preview, setPreview] = useState(
    "Enter verified last-compliance readings to preview due limits.",
  );
  const [uuid] = useState(() => crypto.randomUUID());
  const [requestUuid] = useState(() => crypto.randomUUID());
  const duplicate = s.inspections.some(
    (i) => i.aircraftUuid === target && i.sourceKey === sourceKey,
  );
  return (
    <>
      <h3>Create aircraft inspection</h3>
      {!aircraft.length && (
        <p>
          No aircraft of this model are available with maintenance access. Check
          the manual association and aircraft model.
        </p>
      )}
      {duplicate && (
        <p>
          This manual item has already been added to this aircraft. Edit it from
          Inspections.
        </p>
      )}
      <div
        onChange={(e) => {
          const form = (e.target as HTMLElement).closest("form");
          if (!form) return;
          const d = new FormData(form);
          const parts: string[] = [];
          const h = num(d, "intervalHours"),
            last = num(d, "lastHours"),
            cycles = num(d, "intervalCycles"),
            lc = num(d, "lastCycles"),
            months = num(d, "intervalMonths"),
            date = value(d, "lastDate");
          if (h && last !== undefined) parts.push(`${last + h} aircraft hours`);
          if (cycles && lc !== undefined) parts.push(`${lc + cycles} cycles`);
          try {
            if (months && date) parts.push(endOfDueMonth(date, months));
          } catch {
            /* Incomplete date input. */
          }
          setPreview(
            parts.length
              ? `Next due: ${parts.join(" or ")} (first reached).`
              : "Enter verified last-compliance readings to preview due limits.",
          );
        }}
      >
        <AsyncForm
          disabled={!writable || !aircraft.length}
          submitLabel="Save inspection"
          onSubmit={async (d) => {
            if (!scheduleMode)
              throw new Error("Choose an initial or recurring schedule.");
            if (duplicate)
              throw new Error(
                "This manual item has already been added to this aircraft.",
              );
            if (!aircraft.some((a) => a.uuid === target))
              throw new Error("Select an aircraft of the associated model.");
            await execute({
              action: "inspection.save",
              requestUuid,
              reason: "Inspection reviewed and created from manual search.",
              record: {
                uuid,
                version: 0,
                sourceKey,
                aircraftUuid: target,
                manualReference: manualReferenceFromForm(d),
                ataChapter: ataChapterSchema
                  .optional()
                  .parse(value(d, "ataChapter") || undefined),
                reference: value(d, "reference"),
                description: value(d, "description"),
                materials: value(d, "materials"),
                archived: false,
                intervalSeconds:
                  scheduleMode === "initial"
                    ? undefined
                    : secs(d, "intervalHours"),
                intervalCycles:
                  scheduleMode === "initial"
                    ? undefined
                    : num(d, "intervalCycles"),
                intervalMonths:
                  scheduleMode === "initial"
                    ? undefined
                    : num(d, "intervalMonths"),
                lastSeconds: secs(d, "lastHours"),
                lastCycles: num(d, "lastCycles"),
                lastDate: value(d, "lastDate") || undefined,
                dueSeconds: secs(d, "dueHours"),
                dueCycles: num(d, "dueCycles"),
                dueDate: value(d, "dueDate") || undefined,
              },
            });
            onDone();
          }}
        >
          <Field label="Target aircraft">
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              required
            >
              <option value="">Select a matching aircraft</option>
              {aircraft.map((a) => (
                <option key={a.uuid} value={a.uuid}>
                  {a.registration} · {a.make} {a.model}
                </option>
              ))}
            </select>
          </Field>
          {hasInitial && (
            <>
              <p>
                Initial threshold:{" "}
                {row.initialHours !== undefined && `${row.initialHours} hours `}
                {row.initialCycles !== undefined &&
                  `${row.initialCycles} cycles`}
                . Initial and recurring schedules are saved separately;
                completing the initial inspection does not automatically
                activate the recurring schedule.
              </p>
              <Field label="Schedule to create">
                <select
                  value={scheduleMode}
                  onChange={(e) => setScheduleMode(e.target.value)}
                  required
                >
                  <option value="">Choose a schedule</option>
                  <option value="initial">Initial one-time inspection</option>
                  <option value="recurring">
                    Recurring inspection after initial compliance
                  </option>
                </select>
              </Field>
            </>
          )}
          <ReviewConfirmation />
          <Field label="Inspection name / reference">
            <input
              name="reference"
              defaultValue={row.name}
              required
              maxLength={2000}
            />
          </Field>
          <Field label="Description / items">
            <textarea
              name="description"
              defaultValue={row.text.slice(0, 2000)}
              required
              maxLength={2000}
            />
          </Field>
          {row.text.length > 2000 && (
            <p>
              The description is limited to 2,000 characters. The complete
              extracted text and source PDF remain available above; verify the
              full checklist in the manual.
            </p>
          )}
          <AtaChapterField />
          <ManualReferenceFields initial={row.reference} />
          <fieldset disabled={hasInitial && scheduleMode !== "recurring"}>
            <div className="form-grid">
              <NumberField
                name="intervalHours"
                label="Repeat every (hours)"
                decimal
                initial={row.hours}
              />
              <NumberField
                name="lastHours"
                label="Last complied at (aircraft hours)"
                decimal
              />
              <NumberField
                name="intervalCycles"
                label="Repeat every (cycles)"
                initial={row.cycles}
              />
              <NumberField
                name="lastCycles"
                label="Last complied at (cycles)"
              />
              <NumberField
                name="intervalMonths"
                label="Repeat every (months)"
                initial={row.months}
              />
              <Field label="Last compliance date">
                <input type="date" name="lastDate" max={today()} />
              </Field>
            </div>
          </fieldset>
          <p role="status">
            {scheduleMode === "initial"
              ? "The due fields below define the initial one-time inspection."
              : preview}
          </p>
          <p className="muted">
            Calendar intervals expire at the end of the due month. For one-time
            limits, clear the corresponding repeat interval and use the due
            fields.
          </p>
          <div className="form-grid" key={scheduleMode}>
            <NumberField
              name="dueHours"
              initial={
                scheduleMode === "initial" ? row.initialHours : undefined
              }
              label="One-time due (aircraft hours)"
              decimal
            />
            <NumberField
              name="dueCycles"
              label="One-time due (cycles)"
              initial={
                scheduleMode === "initial" ? row.initialCycles : undefined
              }
            />
            <Field label="One-time due date">
              <input type="date" name="dueDate" />
            </Field>
          </div>
          <Field label="Required parts and supplies">
            <textarea name="materials" maxLength={5000} />
          </Field>
        </AsyncForm>
      </div>
    </>
  );
}
