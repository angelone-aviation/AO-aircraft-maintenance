/**
 * Responsibility: Finding maintenance items in a reference manual: the
 *   candidate list, its model association, and the forms that turn a
 *   candidate into an inspection, a component or a component requirement.
 * Layer: UI. React components; matching rules live in src/domain.
 * Dependencies: react, react-dom, src/data (store, manualPdf), src/domain
 *   (manualDiscovery, manuals, components, programs, model, maintenance, ata,
 *   readings, management), ./Components, ./Manuals, ./KeepOnDevice,
 *   ./ManagementShared, ./AtaChapterField, ./ui.
 *
 * Suggestions come from PDF text, so each one is reviewed against its source
 * pages (ReviewConfirmation) before it becomes a record.
 */
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useWorkspace } from "../data/store";
import { can, type Aircraft, type Snapshot } from "../domain/model";
import type { Manual, ManualApplicability } from "../domain/manuals";
import {
  manualApplicability,
  matchesAircraft,
  matchesComponent,
  type ManualCandidate,
} from "../domain/manualDiscovery";
import { programPermission } from "../domain/programs";
import type { Component, ComponentRequirement } from "../domain/components";
import type { ManagementCommand } from "../domain/management";
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
import { hoursToSeconds } from "../domain/readings";

// Input limits mirror manualApplicabilitySchema (src/domain/manuals.ts),
// inspectionSchema (src/domain/management/schemas.ts) and the component
// schemas (src/domain/components/records.ts), which refuse longer values.
const MODEL_MAX_LENGTH = 150;
const PART_NUMBER_MAX_LENGTH = 100;
const COMPONENT_TYPE_MAX_LENGTH = 100;
const REQUIREMENT_DESCRIPTION_MAX_LENGTH = 255;
const NOTES_MAX_LENGTH = 10_000;
const INSPECTION_TEXT_MAX_LENGTH = 2000;
const MATERIALS_MAX_LENGTH = 5000;
// Suggestions shown per kind, and added by "Show more suggestions".
const SUGGESTIONS_PAGE = 100;
const EMPTY_PAGES_LISTED = 20;
const CANDIDATE_KINDS = ["inspection", "component"] as const;
const OVERHAUL = /\boverhaul\b/i;
const SAVED_NOTICE =
  "Saved. You can select another item or target. Existing imports are checked before saving.";
const INSPECTION_PREVIEW_PROMPT =
  "Enter verified last-compliance readings to preview due limits.";

type CandidateAction = "inspection" | "requirement" | "component";
type Selection = { row: ManualCandidate; action: CandidateAction };

/** The candidate {@link CandidateForm} records, as what, and its callback. */
interface CandidateFormProps {
  row: ManualCandidate;
  scope: ManualApplicability;
  action: CandidateAction;
  onDone: () => void;
}

/**
 * Opens the manual's maintenance-item finder; online, with maintenance
 * permission on the manual's aircraft.
 *
 * @param manual - The reference manual to search.
 */
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

/** The required check that the user reviewed a candidate against its source. */
export function ReviewConfirmation() {
  return (
    <label className="checkbox">
      <input type="checkbox" name="reviewed" required /> I checked the source
      pages, applicability, all conditions and the schedule entered below.
    </label>
  );
}

/**
 * Associates a manual with the aircraft or component model it applies to,
 * which filters the targets suggested for its items.
 *
 * @param manual - The manual.
 * @param scope - Its current association, if any.
 * @param onDone - Called after the association is saved.
 */
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
        const applicability = applicabilityFromForm(d, kind);
        await backend!.setManualApplicability(manual.uuid, applicability);
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
      <ApplicableModelFields scope={scope} component={kind === "component"} />
    </AsyncForm>
  );
}

/**
 * Records one manual candidate as an inspection, a component or a component
 * requirement, pre-filled from the manual's text. A new component goes on to
 * its requirement form once saved.
 *
 * @param row - The candidate.
 * @param scope - The manual's association, which picks the targets offered.
 * @param action - What to record it as.
 * @param onDone - Called after the inspection or requirement is saved.
 */
export function CandidateForm({
  row,
  scope,
  action,
  onDone,
}: CandidateFormProps) {
  const { s } = useManagement();
  const aircraft = maintainedAircraft(s, scope);
  const components = matchingComponents(s, scope, row, aircraft);
  const [componentId, setComponentId] = useState("");
  const [createdId, setCreatedId] = useState("");
  const c = componentById(s, createdId || componentId);
  if (action === "inspection")
    return <InspectionCandidateForm row={row} scope={scope} onDone={onDone} />;
  if (action === "component" && !createdId)
    return (
      <NewComponentStep
        row={row}
        scope={scope}
        aircraft={aircraft}
        matches={components}
        onCreated={setCreatedId}
      />
    );
  return (
    <>
      <h3>Create component service requirement</h3>
      <TargetComponent
        s={s}
        created={!!createdId}
        components={components}
        componentId={componentId}
        onChange={setComponentId}
      />
      <RequirementStep s={s} row={row} c={c} onDone={onDone} />
    </>
  );
}

// Only a component model has a part number.
function applicabilityFromForm(
  d: FormData,
  kind: ManualApplicability["kind"],
): ManualApplicability {
  return {
    kind,
    manufacturer: value(d, "manufacturer"),
    model: value(d, "model"),
    partNumber: kind === "component" ? value(d, "partNumber") : "",
  };
}

function ApplicableModelFields({
  scope,
  component,
}: {
  scope?: ManualApplicability;
  component: boolean;
}) {
  return (
    <>
      <Field label="Manufacturer">
        <input
          name="manufacturer"
          defaultValue={scope?.manufacturer}
          maxLength={MODEL_MAX_LENGTH}
        />
      </Field>
      <Field label="Applicable model">
        <input
          name="model"
          defaultValue={scope?.model}
          required
          maxLength={MODEL_MAX_LENGTH}
        />
      </Field>
      {component && (
        <Field label="Applicable part number (optional)">
          <input
            name="partNumber"
            defaultValue={scope?.partNumber}
            maxLength={PART_NUMBER_MAX_LENGTH}
          />
        </Field>
      )}
    </>
  );
}

type Discovery = ReturnType<typeof useDiscovery>;

function ManualDiscovery({ manualUuid }: { manualUuid: string }) {
  const view = useDiscovery(manualUuid);
  const { manual, scope } = view;
  if (!manual) return <p>Manual is unavailable in this Flight Program.</p>;
  return (
    <>
      <h3>
        {manual.title} · {manual.revision}
      </h3>
      <ScopeLine view={view} />
      {(view.editScope || !scope) && (
        <ApplicabilityEditor
          manual={manual}
          scope={scope}
          onDone={() => view.setEditScope(false)}
        />
      )}
      <p>
        Search selectable PDF text for inspection, overhaul, replacement and
        life-limit items. Results are suggestions, not a complete maintenance
        program. Scanned pages need OCR; table layouts and continuation pages
        need source review.
      </p>
      <SearchForm
        manual={manual}
        disabled={view.locked}
        onSubmit={(d) => searchManual(d, manual, view)}
      />
      <SearchStatus view={view} />
      {CANDIDATE_KINDS.map((kind) => (
        <CandidateSection key={kind} kind={kind} view={view} />
      ))}
    </>
  );
}

function useDiscovery(manualUuid: string) {
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
  const [visibleLimit, setVisibleLimit] = useState(SUGGESTIONS_PAGE);
  const [progress, setProgress] = useState("");
  const [summary, setSummary] = useState("");
  const [selected, setSelected] = useState<Selection>();
  const [saved, setSaved] = useState("");
  const search = useSearchLifetime();
  const writable =
    !!manual &&
    online &&
    connected &&
    can(s!, manual.aircraftUuid, "maintenance");
  return {
    ...{ manual, scope, writable, ...search },
    ...{ editScope, setEditScope, rows, setRows, query, setQuery },
    ...{ visibleLimit, setVisibleLimit, progress, setProgress },
    ...{ summary, setSummary, selected, setSelected, saved, setSaved },
    locked: !writable || !!progress || !scope || editScope,
  };
}

// A search outlives the dialog's render: closing the dialog aborts it, and
// its callbacks stop setting state once the dialog is gone.
function useSearchLifetime() {
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  const start = () => {
    const abort = new AbortController();
    controller.current = abort;
    return abort;
  };
  const finish = () => {
    controller.current = null;
  };
  const cancel = () => controller.current?.abort();
  return { mounted, start, finish, cancel };
}

function ScopeLine({ view }: { view: Discovery }) {
  const { scope } = view;
  return (
    <p>
      Associated {scope?.kind ?? "aircraft"} model:{" "}
      <strong>{scope ? scopeLabel(scope) : "Not set"}</strong>{" "}
      <button
        type="button"
        className="button"
        disabled={!view.writable || !!view.progress}
        onClick={() => {
          view.setEditScope(!view.editScope);
          view.setSelected(undefined);
        }}
      >
        Edit model association
      </button>
    </p>
  );
}

function scopeLabel(scope: ManualApplicability) {
  const part = scope.partNumber ? ` · ${scope.partNumber}` : "";
  return `${scope.manufacturer} ${scope.model}${part}`;
}

function SearchForm({
  manual,
  disabled,
  onSubmit,
}: {
  manual: Manual;
  disabled: boolean;
  onSubmit: (d: FormData) => Promise<void>;
}) {
  return (
    <AsyncForm
      disabled={disabled}
      submitLabel="Search manual"
      onSubmit={onSubmit}
    >
      <div className="form-grid">
        <PageField label="First PDF page" name="from" manual={manual} />
        <PageField label="Last PDF page" name="to" manual={manual} />
      </div>
      <p className="muted">
        For a large manual, start with the inspection / time-limits chapter.
        Results remain here until you close this window; saved records remain in
        the app.
      </p>
    </AsyncForm>
  );
}

function PageField({
  label,
  name,
  manual,
}: {
  label: string;
  name: "from" | "to";
  manual: Manual;
}) {
  return (
    <Field label={label}>
      <input
        type="number"
        name={name}
        min={1}
        max={manual.pageCount}
        defaultValue={name === "from" ? 1 : manual.pageCount}
        required
      />
    </Field>
  );
}

type SearchState = Pick<
  Discovery,
  | "start"
  | "finish"
  | "mounted"
  | "setRows"
  | "setSelected"
  | "setSaved"
  | "setSummary"
  | "setProgress"
>;

// The results so far stay on screen when a search is canceled or fails, with
// a summary saying they are partial; a failure also reaches the form.
async function searchManual(d: FormData, manual: Manual, view: SearchState) {
  const range = pageRange(d, manual.pageCount);
  const abort = view.start();
  view.setRows([]);
  view.setSelected(undefined);
  view.setSaved("");
  view.setSummary("");
  view.setProgress("Opening PDF…");
  const opened = { url: "" };
  try {
    await scanPages(manual, range, abort.signal, opened, view);
  } catch (e) {
    const aborted = abort.signal.aborted;
    if (view.mounted.current) view.setSummary(stoppedSummary(aborted));
    if (!aborted) throw e;
  } finally {
    if (opened.url.startsWith("blob:")) URL.revokeObjectURL(opened.url);
    view.finish();
    if (view.mounted.current) view.setProgress("");
  }
}

function pageRange(d: FormData, pageCount: number) {
  const from = Number(value(d, "from")),
    to = Number(value(d, "to"));
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 1 ||
    to < from ||
    to > pageCount
  )
    throw new Error("Choose a valid PDF page range.");
  return { from, to };
}

async function scanPages(
  manual: Manual,
  { from, to }: { from: number; to: number },
  signal: AbortSignal,
  opened: { url: string },
  view: SearchState,
) {
  const { searchManualPdf } = await import("../data/manualPdf");
  // A copy kept on this device saves downloading the manual again.
  opened.url = (await openManualFile(manual.uuid)).url;
  if (signal.aborted) return;
  let found: ManualCandidate[] = [];
  const onPage = (page: number, candidates: ManualCandidate[]) => {
    found = found.concat(candidates);
    if (!view.mounted.current) return;
    view.setRows(found);
    view.setProgress(
      `Read PDF page ${page} of ${to} · ${found.length} suggestions`,
    );
  };
  const result = await searchManualPdf(
    opened.url,
    manual.uuid,
    from,
    to,
    onPage,
    signal,
  );
  if (view.mounted.current)
    view.setSummary(searchSummary(from, to, found.length, result.emptyPages));
}

function searchSummary(
  from: number,
  to: number,
  count: number,
  emptyPages: number[],
) {
  const listed = emptyPages.slice(0, EMPTY_PAGES_LISTED).join(", ");
  const more = emptyPages.length > EMPTY_PAGES_LISTED ? ", …" : "";
  const pages = emptyPages.length
    ? `${emptyPages.length} pages had little or no searchable text (pages ${listed}${more}); review these pages separately.`
    : "All selected pages contained text.";
  return `Searched PDF pages ${from}–${to}. Found ${count} suggestions. ${pages}`;
}

function stoppedSummary(aborted: boolean) {
  return aborted
    ? "Search canceled. Partial results are shown; the remaining pages were not searched."
    : "Search failed before completion. Any results shown are partial.";
}

function SearchStatus({ view }: { view: Discovery }) {
  const { progress, summary, saved } = view;
  return (
    <>
      {progress && (
        <p role="status">
          {progress}{" "}
          <button type="button" className="button" onClick={view.cancel}>
            Cancel search
          </button>
        </p>
      )}
      {summary && <p role="status">{summary}</p>}
      {saved && <p role="status">{saved}</p>}
      {!!view.rows.length && (
        <Field label="Filter found items">
          <input
            value={view.query}
            onChange={(e) => view.setQuery(e.target.value)}
            placeholder="Phase 2, oxygen, actuator…"
          />
        </Field>
      )}
    </>
  );
}

function CandidateSection({
  kind,
  view,
}: {
  kind: ManualCandidate["kind"];
  view: Discovery;
}) {
  const query = view.query.toLowerCase();
  const rows = view.rows.filter(
    (r) =>
      `${r.name} ${r.text}`.toLowerCase().includes(query) && r.kind === kind,
  );
  return (
    <section>
      <h3>
        {kind === "inspection"
          ? "Inspection and service candidates"
          : "Suggested trackable components and limits"}{" "}
        ({rows.length})
      </h3>
      <CandidateTable rows={rows.slice(0, view.visibleLimit)} view={view} />
      {rows.length > view.visibleLimit && (
        <button
          type="button"
          className="button"
          onClick={() => view.setVisibleLimit((n) => n + SUGGESTIONS_PAGE)}
        >
          Show more suggestions
        </button>
      )}
      {!rows.length && (
        <p className="muted">
          No matching suggestions. Try a different page range or filter; absence
          from these results does not establish that no requirements exist.
        </p>
      )}
    </section>
  );
}

function CandidateTable({
  rows,
  view,
}: {
  rows: ManualCandidate[];
  view: Discovery;
}) {
  return (
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
          {rows.map((row) => (
            <Fragment key={row.sourceKey}>
              <tr>
                <td>{row.name}</td>
                <IntervalCell row={row} />
                <SourceCell row={row} />
                <CandidateActions row={row} view={view} />
              </tr>
              <SelectedCandidate row={row} view={view} />
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function IntervalCell({ row }: { row: ManualCandidate }) {
  const { hours, cycles, months } = row;
  return (
    <td>
      {hours !== undefined && <div>{hours} hours</div>}
      {cycles !== undefined && <div>{cycles} cycles</div>}
      {months !== undefined && <div>{months} months</div>}
      {hours === undefined &&
        cycles === undefined &&
        months === undefined &&
        "Needs interpretation"}
      <small className="block">Confirm recurring versus absolute limit.</small>
    </td>
  );
}

function SourceCell({ row }: { row: ManualCandidate }) {
  return (
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
  );
}

// Only an aircraft manual can create an aircraft inspection.
function CandidateActions({
  row,
  view,
}: {
  row: ManualCandidate;
  view: Discovery;
}) {
  const { locked } = view;
  const choose = (action: CandidateAction) => {
    view.setSaved("");
    view.setSelected({ row, action });
  };
  return (
    <td>
      <ChoiceButton
        disabled={locked || view.scope?.kind !== "aircraft"}
        onClick={() => choose("inspection")}
      >
        Create inspection
      </ChoiceButton>
      <ChoiceButton disabled={locked} onClick={() => choose("requirement")}>
        Create component service requirement
      </ChoiceButton>
      {row.kind === "component" && (
        <ChoiceButton disabled={locked} onClick={() => choose("component")}>
          Create component
        </ChoiceButton>
      )}
    </td>
  );
}

function ChoiceButton({
  disabled,
  onClick,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="button"
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function SelectedCandidate({
  row,
  view,
}: {
  row: ManualCandidate;
  view: Discovery;
}) {
  const { selected, scope } = view;
  if (selected?.row.sourceKey !== row.sourceKey || !scope) return null;
  return (
    <tr>
      <td colSpan={4}>
        <section className="panel" aria-label="Create from manual item">
          <button
            type="button"
            className="button"
            onClick={() => view.setSelected(undefined)}
          >
            Close item form
          </button>
          <CandidateForm
            key={`${row.sourceKey}:${selected.action}`}
            row={row}
            scope={scope}
            action={selected.action}
            onDone={() => {
              view.setSaved(SAVED_NOTICE);
              view.setSelected(undefined);
            }}
          />
        </section>
      </td>
    </tr>
  );
}

function componentById(s: Snapshot, uuid: string) {
  return (s.management ?? []).find(
    (c): c is Component => c.kind === "component" && c.uuid === uuid,
  );
}

function maintainedAircraft(s: Snapshot, scope: ManualApplicability) {
  return s.aircraft.filter(
    (a) => can(s, a.uuid, "maintenance") && matchesAircraft(a, scope),
  );
}

// Components the user maintains that the manual applies to: of its
// component model, or on an aircraft of its model; and of the model,
// manufacturer and part number the candidate names, ignoring case.
function matchingComponents(
  s: Snapshot,
  scope: ManualApplicability,
  row: ManualCandidate,
  aircraft: Aircraft[],
) {
  const named = row.componentDefaults;
  return (s.management ?? []).filter(
    (c): c is Component =>
      c.kind === "component" &&
      (c.aircraftUuid
        ? can(s, c.aircraftUuid, "maintenance")
        : programPermission(s, "maintenance")) &&
      (scope.kind === "component"
        ? matchesComponent(c, scope)
        : aircraft.some((a) => a.uuid === c.aircraftUuid)) &&
      isNamed(c.model, named?.model) &&
      isNamed(c.manufacturer, named?.manufacturer) &&
      isNamed(c.partNumber, named?.partNumber),
  );
}

function isNamed(have: string | undefined, want: string | undefined) {
  return !want || have?.trim().toLowerCase() === want.trim().toLowerCase();
}

function NewComponentStep({
  row,
  scope,
  aircraft,
  matches,
  onCreated,
}: {
  row: ManualCandidate;
  scope: ManualApplicability;
  aircraft: Aircraft[];
  matches: Component[];
  onCreated: (uuid: string) => void;
}) {
  return (
    <>
      <h3>Create trackable component</h3>
      <p>
        Check existing components before adding another physical unit. After
        saving, add its service requirement below.
      </p>
      {matches.length > 0 && <ExistingMatches matches={matches} />}
      <ComponentForm
        aircraftUuids={
          scope.kind === "aircraft" ? aircraft.map((a) => a.uuid) : undefined
        }
        defaults={componentDefaults(row, scope)}
        review={<ReviewConfirmation />}
        onDone={onCreated}
      />
    </>
  );
}

function ExistingMatches({ matches }: { matches: Component[] }) {
  return (
    <p>
      Matching existing components:{" "}
      {matches
        .map(
          (c) =>
            `${c.componentType} / ${c.partNumber} / ${c.serial || "no serial"}`,
        )
        .join("; ")}
      . Use “Create component service requirement” to add a limit to one of
      these.
    </p>
  );
}

function componentDefaults(
  row: ManualCandidate,
  scope: ManualApplicability,
): Partial<Component> {
  const ofModel = scope.kind === "component";
  return {
    componentType: row.name.slice(0, COMPONENT_TYPE_MAX_LENGTH),
    model: ofModel ? scope.model : "",
    manufacturer: ofModel ? scope.manufacturer : "",
    partNumber: ofModel ? scope.partNumber : "",
    notes: row.text.slice(0, NOTES_MAX_LENGTH),
    manualReference: row.reference,
    ...row.componentDefaults,
  };
}

interface TargetProps {
  s: Snapshot;
  created: boolean;
  components: Component[];
  componentId: string;
  onChange: (uuid: string) => void;
}

function TargetComponent({
  s,
  created,
  components,
  componentId,
  onChange,
}: TargetProps) {
  if (created)
    return (
      <p role="status">
        Component saved. Complete its service requirement below; the component
        remains saved if you close this form.
      </p>
    );
  return (
    <>
      <Field label="Target component">
        <select value={componentId} onChange={(e) => onChange(e.target.value)}>
          <option value="">Select a matching component</option>
          {components.map((c) => (
            <option value={c.uuid} key={c.uuid}>
              {targetLabel(s, c)}
            </option>
          ))}
        </select>
      </Field>
      {!components.length && (
        <p>
          No matching components. Set the component model in Components, verify
          the manual association, or create the physical component first.
        </p>
      )}
    </>
  );
}

function targetLabel(s: Snapshot, c: Component) {
  const where =
    s.aircraft.find((a) => a.uuid === c.aircraftUuid)?.registration ??
    "Inventory";
  return `${c.componentType} · ${c.model || c.partNumber} · ${c.serial || "No serial"} · ${where}`;
}

function RequirementStep({
  s,
  row,
  c,
  onDone,
}: {
  s: Snapshot;
  row: ManualCandidate;
  c?: Component;
  onDone: () => void;
}) {
  if (c && isAlreadyAdded(s, c, row))
    return (
      <p>
        This manual item has already been added to this component. Edit it from
        Components.
      </p>
    );
  if (c && lacksTracking(c, row))
    return (
      <p>
        Enable all suggested tracking dimensions (time, cycles or calendar) in
        this component’s details before adding this requirement.
      </p>
    );
  if (!c) return null;
  return (
    <RequirementForm
      key={c.uuid}
      c={c}
      defaults={requirementDefaults(row)}
      review={<RequirementReview />}
      onDone={onDone}
    />
  );
}

function isAlreadyAdded(s: Snapshot, c: Component, row: ManualCandidate) {
  return !!s.management?.some(
    (r) =>
      r.kind === "componentRequirement" &&
      r.componentUuid === c.uuid &&
      r.sourceKey === row.sourceKey,
  );
}

// Each limit the candidate suggests needs its dimension tracked.
function lacksTracking(c: Component, row: ManualCandidate) {
  const calendar =
    row.months !== undefined ||
    row.requirementDefaults?.calendarIntervalValue !== undefined;
  return (
    (row.hours !== undefined && !c.trackTime) ||
    (row.cycles !== undefined && !c.trackCycles) ||
    (calendar && !c.trackCalendar)
  );
}

function RequirementReview() {
  return (
    <>
      <p>
        Review the limit type and tracking basis. Calendar month/year limits use
        the end of the due month; do not use this for a different age or
        shelf-life rule.
      </p>
      <ReviewConfirmation />
    </>
  );
}

// A component candidate's limit is a life limit unless its text says
// overhaul; a life limit counts in absolute hours and cycles, the others
// from the last compliance.
function requirementDefaults(
  row: ManualCandidate,
): Partial<ComponentRequirement> {
  const isLife = row.kind === "component" && !OVERHAUL.test(row.text);
  const mode = isLife ? "ABSOLUTE" : "FROM_LAST_COMPLIED";
  return {
    sourceKey: row.sourceKey,
    manualReference: row.reference,
    description: row.name.slice(0, REQUIREMENT_DESCRIPTION_MAX_LENGTH),
    notes: row.text.slice(0, NOTES_MAX_LENGTH),
    requirementType: requirementType(row, isLife),
    intervalSeconds:
      row.hours === undefined ? undefined : hoursToSeconds(row.hours),
    intervalCycles: row.cycles,
    calendarIntervalValue: row.months,
    calendarIntervalUnit: "MONTHS",
    timeBasis: "TSN",
    timeLimitMode: mode,
    cycleLimitMode: mode,
    ...row.requirementDefaults,
  };
}

function requirementType(
  row: ManualCandidate,
  isLife: boolean,
): ComponentRequirement["requirementType"] {
  if (isLife) return "Life Limits";
  return OVERHAUL.test(row.text)
    ? "Overhaul Requirement"
    : "Inspection Requirement";
}

type ScheduleMode = "" | "initial" | "recurring";

function InspectionCandidateForm({
  row,
  scope,
  onDone,
}: {
  row: ManualCandidate;
  scope: ManualApplicability;
  onDone: () => void;
}) {
  const form = useInspectionCandidate(row, scope);
  return (
    <>
      <h3>Create aircraft inspection</h3>
      <InspectionNotices form={form} />
      <div onChange={(e) => updatePreview(e, form.setPreview)}>
        <AsyncForm
          disabled={!form.writable || !form.aircraft.length}
          submitLabel="Save inspection"
          onSubmit={async (d) => {
            await form.execute(inspectionCommand(d, form));
            onDone();
          }}
        >
          <InspectionFields row={row} form={form} />
        </AsyncForm>
      </div>
    </>
  );
}

type InspectionCandidate = ReturnType<typeof useInspectionCandidate>;

function InspectionNotices({ form }: { form: InspectionCandidate }) {
  return (
    <>
      {!form.aircraft.length && (
        <p>
          No aircraft of this model are available with maintenance access. Check
          the manual association and aircraft model.
        </p>
      )}
      {form.duplicate && (
        <p>
          This manual item has already been added to this aircraft. Edit it from
          Inspections.
        </p>
      )}
    </>
  );
}

// The record and request ids are fixed for the form's life, so a retried
// save after a lost reply is recognised rather than recorded twice.
function useInspectionCandidate(
  row: ManualCandidate,
  scope: ManualApplicability,
) {
  const { s, writable, execute } = useManagement();
  const aircraft = maintainedAircraft(s, scope);
  const [target, setTarget] = useState("");
  const hasInitial =
    row.initialHours !== undefined || row.initialCycles !== undefined;
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>(
    hasInitial ? "" : "recurring",
  );
  const sourceKey =
    row.sourceKey + (scheduleMode === "initial" ? ":initial" : "");
  const [preview, setPreview] = useState(INSPECTION_PREVIEW_PROMPT);
  const [uuid] = useState(() => crypto.randomUUID());
  const [requestUuid] = useState(() => crypto.randomUUID());
  const duplicate = s.inspections.some(
    (i) => i.aircraftUuid === target && i.sourceKey === sourceKey,
  );
  return {
    ...{ writable, execute, aircraft, target, setTarget, hasInitial },
    ...{ scheduleMode, setScheduleMode, sourceKey, preview, setPreview },
    ...{ uuid, requestUuid, duplicate },
  };
}

// The preview reads the whole form on any change inside it.
function updatePreview(
  e: FormEvent<HTMLDivElement>,
  setPreview: (preview: string) => void,
) {
  const form = (e.target as HTMLElement).closest("form");
  if (!form) return;
  const parts = dueParts(new FormData(form));
  setPreview(
    parts.length
      ? `Next due: ${parts.join(" or ")} (first reached).`
      : INSPECTION_PREVIEW_PROMPT,
  );
}

function dueParts(d: FormData) {
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
    // A date still being typed has no due month yet; the preview skips it.
  }
  return parts;
}

function inspectionCommand(
  d: FormData,
  form: InspectionCandidate,
): ManagementCommand {
  assertInspectionTarget(form);
  return {
    action: "inspection.save",
    requestUuid: form.requestUuid,
    reason: "Inspection reviewed and created from manual search.",
    record: inspectionRecord(d, form),
  };
}

function assertInspectionTarget(form: InspectionCandidate) {
  if (!form.scheduleMode)
    throw new Error("Choose an initial or recurring schedule.");
  if (form.duplicate)
    throw new Error(
      "This manual item has already been added to this aircraft.",
    );
  if (!form.aircraft.some((a) => a.uuid === form.target))
    throw new Error("Select an aircraft of the associated model.");
}

// A one-time initial inspection has only due limits; its repeat interval
// belongs to the recurring schedule, saved separately.
function inspectionRecord(d: FormData, form: InspectionCandidate) {
  const repeats = form.scheduleMode !== "initial";
  return {
    uuid: form.uuid,
    version: 0,
    sourceKey: form.sourceKey,
    aircraftUuid: form.target,
    manualReference: manualReferenceFromForm(d),
    ataChapter: ataChapterSchema
      .optional()
      .parse(value(d, "ataChapter") || undefined),
    reference: value(d, "reference"),
    description: value(d, "description"),
    materials: value(d, "materials"),
    archived: false,
    intervalSeconds: repeats ? secs(d, "intervalHours") : undefined,
    intervalCycles: repeats ? num(d, "intervalCycles") : undefined,
    intervalMonths: repeats ? num(d, "intervalMonths") : undefined,
    lastSeconds: secs(d, "lastHours"),
    lastCycles: num(d, "lastCycles"),
    lastDate: value(d, "lastDate") || undefined,
    dueSeconds: secs(d, "dueHours"),
    dueCycles: num(d, "dueCycles"),
    dueDate: value(d, "dueDate") || undefined,
  };
}

function InspectionFields({
  row,
  form,
}: {
  row: ManualCandidate;
  form: InspectionCandidate;
}) {
  return (
    <>
      <TargetAircraftField form={form} />
      {form.hasInitial && <InitialSchedule row={row} form={form} />}
      <ReviewConfirmation />
      <InspectionTextFields row={row} />
      <AtaChapterField />
      <ManualReferenceFields initial={row.reference} />
      <RecurringFields
        row={row}
        disabled={form.hasInitial && form.scheduleMode !== "recurring"}
      />
      <p role="status">
        {form.scheduleMode === "initial"
          ? "The due fields below define the initial one-time inspection."
          : form.preview}
      </p>
      <p className="muted">
        Calendar intervals expire at the end of the due month. For one-time
        limits, clear the corresponding repeat interval and use the due fields.
      </p>
      <OneTimeDueFields row={row} mode={form.scheduleMode} />
      <Field label="Required parts and supplies">
        <textarea name="materials" maxLength={MATERIALS_MAX_LENGTH} />
      </Field>
    </>
  );
}

function TargetAircraftField({ form }: { form: InspectionCandidate }) {
  return (
    <Field label="Target aircraft">
      <select
        value={form.target}
        onChange={(e) => form.setTarget(e.target.value)}
        required
      >
        <option value="">Select a matching aircraft</option>
        {form.aircraft.map((a) => (
          <option key={a.uuid} value={a.uuid}>
            {a.registration} · {a.make} {a.model}
          </option>
        ))}
      </select>
    </Field>
  );
}

function InitialSchedule({
  row,
  form,
}: {
  row: ManualCandidate;
  form: InspectionCandidate;
}) {
  return (
    <>
      <p>
        Initial threshold:{" "}
        {row.initialHours !== undefined && `${row.initialHours} hours `}
        {row.initialCycles !== undefined && `${row.initialCycles} cycles`}.
        Initial and recurring schedules are saved separately; completing the
        initial inspection does not automatically activate the recurring
        schedule.
      </p>
      <Field label="Schedule to create">
        <select
          value={form.scheduleMode}
          onChange={(e) => form.setScheduleMode(e.target.value as ScheduleMode)}
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
  );
}

function InspectionTextFields({ row }: { row: ManualCandidate }) {
  return (
    <>
      <Field label="Inspection name / reference">
        <input
          name="reference"
          defaultValue={row.name}
          required
          maxLength={INSPECTION_TEXT_MAX_LENGTH}
        />
      </Field>
      <Field label="Description / items">
        <textarea
          name="description"
          defaultValue={row.text.slice(0, INSPECTION_TEXT_MAX_LENGTH)}
          required
          maxLength={INSPECTION_TEXT_MAX_LENGTH}
        />
      </Field>
      {row.text.length > INSPECTION_TEXT_MAX_LENGTH && (
        <p>
          The description is limited to 2,000 characters. The complete extracted
          text and source PDF remain available above; verify the full checklist
          in the manual.
        </p>
      )}
    </>
  );
}

function RecurringFields({
  row,
  disabled,
}: {
  row: ManualCandidate;
  disabled: boolean;
}) {
  return (
    <fieldset disabled={disabled}>
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
        <NumberField name="lastCycles" label="Last complied at (cycles)" />
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
  );
}

// Keyed by the schedule, so switching to the initial schedule re-fills the
// due fields from the candidate's initial threshold.
function OneTimeDueFields({
  row,
  mode,
}: {
  row: ManualCandidate;
  mode: ScheduleMode;
}) {
  const initial = mode === "initial";
  return (
    <div className="form-grid" key={mode}>
      <NumberField
        name="dueHours"
        initial={initial ? row.initialHours : undefined}
        label="One-time due (aircraft hours)"
        decimal
      />
      <NumberField
        name="dueCycles"
        label="One-time due (cycles)"
        initial={initial ? row.initialCycles : undefined}
      />
      <Field label="One-time due date">
        <input type="date" name="dueDate" />
      </Field>
    </div>
  );
}
