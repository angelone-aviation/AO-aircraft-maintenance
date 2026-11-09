/**
 * Responsibility: The history steps of the Set up an aircraft wizard: the
 *   inspection and AD compliance CSV steps, the dry-run review and the commit
 *   that sends the plan's commands one by one and can be resumed.
 * Layer: UI. React components; parsing and planning live in
 *   src/domain/aircraftSetup.
 * Dependencies: react, @tanstack/react-router, src/data/store.ts,
 *   src/data/backend.ts (types), src/domain (aircraftSetup, maintenanceCsv,
 *   model), ./design, ./ui.
 */
import { Link } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";
import { useWorkspace } from "../data/store";
import type { Backend } from "../data/backend";
import {
  adSetupHeaders,
  inspectionSetupHeaders,
  parseAdSetupCsv,
  parseInspectionSetupCsv,
  planAircraftSetup,
  type AdSetupRow,
  type InspectionSetupRow,
  type SetupAction,
  type SetupDraft,
  type SetupPlan,
  type SetupStep,
} from "../domain/aircraftSetup";
import { CSV_MAX_BYTES } from "../domain/maintenanceCsv";
import { hours, type Aircraft, type Snapshot } from "../domain/model";
import { NoticeBar } from "./design";
import { Field, downloadBlankCsv, errorText } from "./ui";

/** The wizard's draft and the ways a step changes it. */
export interface SetupDrafts {
  draft: SetupDraft;
  /** Changes part of the draft and persists it. */
  update: (patch: Partial<SetupDraft>) => void;
  /** Forgets the draft once setup is complete. */
  clear: () => void;
  /** Counts CSV changes, so a commit in progress is reset by an edit. */
  revision: number;
  storageError: string;
}

/** What every history step receives. */
export interface HistoryStepProps {
  s: Snapshot;
  aircraft: Aircraft;
  writable: boolean;
  drafts: SetupDrafts;
  onStep: (step: SetupStep) => void;
  /** The step's Back and Next controls. */
  nav: ReactNode;
}

type CsvKind = "inspections" | "ads";
type CsvSpec = (typeof CSV_STEPS)[CsvKind];
type Parsed<T> = { rows: T[]; error: "" } | { rows: []; error: string };
type Review = { plan?: SetupPlan; parseErrors: string[] };
type RunState = {
  actions: SetupAction[];
  saved: string[];
  failure?: { key: string; message: string };
  busy: boolean;
};

const CSV_STEPS = {
  inspections: {
    title: "Inspections",
    fileName: "inspection-setup.csv",
    headers: inspectionSetupHeaders,
    draftKey: "inspectionCsv",
    help: "One row per inspection: its name, the intervals it repeats at (hours, months, cycles, landings; any that apply) and when it was last done. Each interval needs its last-done hours, count or date, and no last-done value may be above the aircraft's current totals.",
  },
  ads: {
    title: "AD compliance",
    fileName: "ad-setup.csv",
    headers: adSetupHeaders,
    draftKey: "adCsv",
    help: "One row per airworthiness directive: its number, whether it applies, and if it was complied with, the date and aircraft total time, the method and what is next due. An AD that does not apply is recorded with your notes as the reason.",
  },
} as const;

/**
 * A CSV step: download the blank template, paste or upload the file, and see
 * its rows or the first error. The text is kept in the draft.
 *
 * @param props.kind - Which template the step reads.
 */
export function CsvStep({
  kind,
  drafts,
  nav,
}: HistoryStepProps & { kind: CsvKind }) {
  const spec = CSV_STEPS[kind];
  const csv = drafts.draft[spec.draftKey];
  const [fileError, setFileError] = useState("");
  const parsed = useMemo(
    () => (kind === "inspections" ? parseInspections(csv) : parseAds(csv)),
    [kind, csv],
  );
  const onCsv = (text: string) => drafts.update({ [spec.draftKey]: text });
  return (
    <section className="panel setup-panel">
      <h2>{spec.title}</h2>
      <p>{spec.help}</p>
      {kind === "ads" && <FaaImportNote />}
      <CsvInputs
        spec={spec}
        csv={csv}
        onCsv={onCsv}
        onFileError={setFileError}
      />
      <ErrorText text={fileError} />
      <ErrorText text={parsed.error} />
      {!parsed.error && <ParsedRows kind={kind} rows={parsed.rows} />}
      {nav}
    </section>
  );
}

function FaaImportNote() {
  return (
    <p>
      ADs the FAA lists for this make and model can be imported afterwards from{" "}
      <Link to="/airworthiness">Airworthiness directives</Link> (FAA search
      import); they open as Needs review.
    </p>
  );
}

function ErrorText({ text }: { text: string }) {
  if (!text) return null;
  return (
    <p role="alert" className="error">
      {text}
    </p>
  );
}

/**
 * The dry run: what the commit will save, skip, and what to fix first.
 * Nothing is saved here.
 */
export function ReviewStep({
  s,
  aircraft,
  drafts,
  onStep,
  nav,
}: HistoryStepProps) {
  const review = useMemo(
    () => reviewOf(s, aircraft, drafts.draft),
    [s, aircraft, drafts.draft],
  );
  return (
    <section className="panel setup-panel">
      <h2>Review (dry run)</h2>
      <NoticeBar tone="blue">
        Nothing from the Inspections and AD compliance steps has been saved yet.
        Components were saved as their forms were saved.
      </NoticeBar>
      <MessageList
        title="Fix the file first"
        items={review.parseErrors}
        className="setup-errors"
        role="alert"
      />
      {review.plan && <PlanSummary plan={review.plan} onStep={onStep} />}
      {nav}
    </section>
  );
}

/**
 * Sends the plan's commands in order, each with its own request id, and
 * records every saved row in the draft. A failure stops the run at its row;
 * Retry resumes from it, and leaving the page keeps what was saved.
 */
export function CommitStep(props: HistoryStepProps) {
  const { s, aircraft, drafts, nav } = props;
  const { backend } = useWorkspace();
  const [run, setRun] = useState<RunState | null>(null);
  const review = useMemo(
    () => reviewOf(s, aircraft, drafts.draft),
    [s, aircraft, drafts.draft],
  );
  const start = (actions: SetupAction[], saved: string[]) => {
    const state: RunState = { actions, saved, busy: true };
    setRun(state);
    void commitActions(backend!, state, drafts, setRun);
  };
  return (
    <section className="panel setup-panel">
      <h2>Save</h2>
      {!run && (
        <SaveControls
          {...props}
          review={review}
          onSave={(actions) => start(actions, drafts.draft.done)}
        />
      )}
      {run && <RunProgress run={run} />}
      {run?.failure && !run.busy && (
        <FailureControls
          {...props}
          run={run}
          onRetry={() => start(run.actions, run.saved)}
        />
      )}
      {run && !run.busy && !run.failure && (
        <Finished drafts={drafts} aircraft={aircraft} />
      )}
      {nav}
    </section>
  );
}

function SaveControls({
  aircraft,
  writable,
  review,
  onSave,
}: HistoryStepProps & {
  review: Review;
  onSave: (actions: SetupAction[]) => void;
}) {
  const plan = review.plan;
  const blocked =
    !plan || plan.errors.length > 0 || review.parseErrors.length > 0;
  const actions = plan?.actions ?? [];
  return (
    <>
      {blocked && (
        <NoticeBar tone="warn" role="alert">
          Fix the errors shown in the review before saving.
        </NoticeBar>
      )}
      {!blocked && actions.length > 0 && (
        <p>
          {countText(actions)} will be saved for {aircraft.registration}, in
          order. Each row is its own change-log entry; if one fails, the rows
          before it stay saved and you can retry from the failed row.
        </p>
      )}
      <button
        type="button"
        className="button primary"
        disabled={blocked || !writable || !actions.length}
        onClick={() => onSave(actions)}
      >
        {actions.length ? `Save ${countText(actions)}` : "Nothing to save"}
      </button>
    </>
  );
}

function FailureControls({
  writable,
  run,
  onRetry,
  onStep,
}: HistoryStepProps & { run: RunState; onRetry: () => void }) {
  return (
    <div className="setup-actions">
      <button
        type="button"
        className="button primary"
        disabled={!writable}
        onClick={onRetry}
      >
        Retry from the failed row
      </button>
      <button
        type="button"
        className="button"
        onClick={() =>
          onStep(run.failure!.key.startsWith("ad:") ? "ads" : "inspections")
        }
      >
        Fix the file
      </button>
    </div>
  );
}

// Carries the whole saved list on every update: the draft's `update` replaces
// `done`, and this loop outlives the render it was started from.
async function commitActions(
  backend: Backend,
  state: RunState,
  drafts: SetupDrafts,
  setRun: (run: RunState) => void,
) {
  let saved = state.saved;
  for (const action of state.actions) {
    if (saved.includes(action.key)) continue;
    try {
      await sendAction(backend, action);
    } catch (e) {
      setRun({
        ...state,
        saved,
        busy: false,
        failure: { key: action.key, message: errorText(e) },
      });
      return;
    }
    saved = [...saved, action.key];
    drafts.update({ done: saved });
    setRun({ ...state, saved, busy: true });
  }
  setRun({ ...state, saved, busy: false });
}

function sendAction(backend: Backend, action: SetupAction) {
  return action.step === "inspections"
    ? backend.manage(action.command)
    : backend.saveAD(action.command);
}

function RunProgress({ run }: { run: RunState }) {
  return (
    <ol className="setup-progress" aria-label="Save progress">
      {run.actions.map((a) => {
        const state = runStateOf(run, a.key);
        return (
          <li key={a.key} className={`setup-progress-${state.toLowerCase()}`}>
            <span>{state}</span>
            <strong>{a.label}</strong> <span className="muted">{a.detail}</span>
            {run.failure?.key === a.key && (
              <p role="alert" className="error">
                {run.failure.message}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function runStateOf(run: RunState, key: string) {
  if (run.saved.includes(key)) return "Saved";
  if (run.failure?.key === key) return "Failed";
  return run.busy ? "Waiting" : "Not saved";
}

function Finished({
  drafts,
  aircraft,
}: {
  drafts: SetupDrafts;
  aircraft: Aircraft;
}) {
  return (
    <NoticeBar tone="good" role="status">
      Setup saved for {aircraft.registration}. Check{" "}
      <Link to="/inspections">Inspections</Link> and{" "}
      <Link to="/airworthiness">Airworthiness directives</Link>, then{" "}
      <button type="button" className="text-button" onClick={drafts.clear}>
        forget this draft
      </button>
      .
    </NoticeBar>
  );
}

function PlanSummary({
  plan,
  onStep,
}: {
  plan: SetupPlan;
  onStep: (step: SetupStep) => void;
}) {
  return (
    <>
      <CountsTable plan={plan} onStep={onStep} />
      <MessageList
        title="Fix before saving"
        items={plan.errors}
        className="setup-errors"
        role="alert"
      />
      <MessageList
        title="Check"
        items={plan.warnings}
        className="setup-warnings"
      />
      <ActionTable actions={plan.actions} />
      {plan.skipped.length > 0 && (
        <details>
          <summary>Skipped rows ({plan.skipped.length})</summary>
          <ul>
            {plan.skipped.map((r) => (
              <li key={r.key}>
                {r.label}: {r.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function CountsTable({
  plan,
  onStep,
}: {
  plan: SetupPlan;
  onStep: (step: SetupStep) => void;
}) {
  const rows: [CsvKind, string][] = [
    ["inspections", "Inspections"],
    ["ads", "AD compliance"],
  ];
  return (
    <table className="setup-counts">
      <thead>
        <tr>
          <th>Step</th>
          <th>To save</th>
          <th>Skipped</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([step, label]) => (
          <tr key={step}>
            <td>
              <button
                type="button"
                className="text-button"
                onClick={() => onStep(step)}
              >
                {label}
              </button>
            </td>
            <td>{plan.actions.filter((a) => a.step === step).length}</td>
            <td>{plan.skipped.filter((r) => r.step === step).length}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MessageList({
  title,
  items,
  className,
  role,
}: {
  title: string;
  items: string[];
  className: string;
  role?: "alert";
}) {
  if (!items.length) return null;
  return (
    <div className={className} role={role}>
      <h3>{title}</h3>
      <ul>
        {items.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
    </div>
  );
}

function ActionTable({ actions }: { actions: SetupAction[] }) {
  if (!actions.length) return <p className="muted">Nothing to save.</p>;
  return (
    <div className="table-wrap">
      <table aria-label="Records to save">
        <thead>
          <tr>
            <th>Step</th>
            <th>Record</th>
            <th>What is saved</th>
          </tr>
        </thead>
        <tbody>
          {actions.map((a) => (
            <tr key={a.key}>
              <td>{a.step === "ads" ? "AD" : "Inspection"}</td>
              <td>{a.label}</td>
              <td>{a.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CsvInputs({
  spec,
  csv,
  onCsv,
  onFileError,
}: {
  spec: CsvSpec;
  csv: string;
  onCsv: (csv: string) => void;
  onFileError: (error: string) => void;
}) {
  return (
    <>
      <div className="setup-actions">
        <button
          type="button"
          className="button"
          onClick={() => downloadBlankCsv(spec.fileName, spec.headers)}
        >
          Download CSV template
        </button>
        <Field label={`${spec.title} CSV file`}>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) =>
              void readCsvFile(e.target.files?.[0], onCsv, onFileError)
            }
          />
        </Field>
      </div>
      <CsvTextField spec={spec} csv={csv} onCsv={onCsv} />
    </>
  );
}

function CsvTextField({
  spec,
  csv,
  onCsv,
}: {
  spec: CsvSpec;
  csv: string;
  onCsv: (csv: string) => void;
}) {
  return (
    <Field
      label={`${spec.title} rows (CSV)`}
      hint={`Columns: ${spec.headers.join(", ")}`}
    >
      <textarea rows={10} value={csv} onChange={(e) => onCsv(e.target.value)} />
    </Field>
  );
}

function ParsedRows({
  kind,
  rows,
}: {
  kind: CsvKind;
  rows: InspectionSetupRow[] | AdSetupRow[];
}) {
  if (!rows.length)
    return <p className="muted">No rows yet. Paste or upload the file.</p>;
  const columns =
    kind === "ads"
      ? ["Row", "AD", "Applies", "Compliance", "Next due"]
      : ["Row", "Name", "Intervals", "Last done", "Notes"];
  return (
    <div className="table-wrap">
      <table aria-label={`${CSV_STEPS[kind].title} rows`}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.row}>{"name" in r ? inspectionCells(r) : adCells(r)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function inspectionCells(r: InspectionSetupRow) {
  const intervals = [
    r.intervalSeconds !== undefined && `${hours(r.intervalSeconds)} h`,
    r.intervalMonths && `${r.intervalMonths} mo`,
    r.intervalCycles && `${r.intervalCycles} cycles`,
    r.intervalLandings && `${r.intervalLandings} landings`,
  ].filter(Boolean);
  const last = [
    r.lastDate,
    r.lastSeconds !== undefined && `${hours(r.lastSeconds)} h`,
    r.lastCycles !== undefined && `${r.lastCycles} cycles`,
    r.lastLandings !== undefined && `${r.lastLandings} landings`,
  ].filter(Boolean);
  return (
    <>
      <td>{r.row}</td>
      <td>{r.name}</td>
      <td>{intervals.join(", ") || "—"}</td>
      <td>{last.join(" · ") || "—"}</td>
      <td>{r.notes || "—"}</td>
    </>
  );
}

function adCells(r: AdSetupRow) {
  const due = [
    r.nextDueHours !== undefined && `${r.nextDueHours} h`,
    r.nextDueDate,
  ]
    .filter(Boolean)
    .join(", ");
  const compliance = [
    r.complianceDate,
    r.complianceHours !== undefined && `at ${r.complianceHours} h`,
    r.method,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      <td>{r.row}</td>
      <td>
        {r.number}
        {r.title && <small className="block">{r.title}</small>}
      </td>
      <td>{r.applies ? "Yes" : "No"}</td>
      <td>{compliance || "—"}</td>
      <td>
        {due || "—"}
        {r.recurring !== undefined && (
          <small className="block">
            {r.recurring ? "Recurring" : "One-time"}
          </small>
        )}
      </td>
    </>
  );
}

// A template that does not parse is shown, not sent.
function attempt<T>(csv: string, parse: (csv: string) => T[]): Parsed<T> {
  if (!csv.trim()) return { rows: [], error: "" };
  try {
    return { rows: parse(csv), error: "" };
  } catch (e) {
    return { rows: [], error: errorText(e) };
  }
}

const parseInspections = (csv: string) => attempt(csv, parseInspectionSetupCsv);
const parseAds = (csv: string) => attempt(csv, parseAdSetupCsv);

// Both files must parse before a plan is made, so a plan never hides a file
// error behind its own counts.
function reviewOf(s: Snapshot, aircraft: Aircraft, draft: SetupDraft): Review {
  const inspections = parseInspections(draft.inspectionCsv);
  const ads = parseAds(draft.adCsv);
  const parseErrors = [
    inspections.error && `Inspections: ${inspections.error}`,
    ads.error && `AD compliance: ${ads.error}`,
  ].filter((e): e is string => !!e);
  if (parseErrors.length) return { parseErrors };
  return {
    parseErrors,
    plan: planAircraftSetup(
      s,
      aircraft.uuid,
      { inspections: inspections.rows, ads: ads.rows },
      { done: draft.done },
    ),
  };
}

function countText(actions: SetupAction[]) {
  const n = (step: CsvKind) => actions.filter((a) => a.step === step).length;
  const plural = (count: number, word: string) =>
    `${count} ${word}${count === 1 ? "" : "s"}`;
  return `${plural(n("inspections"), "inspection")} and ${plural(n("ads"), "AD")}`;
}

// The file replaces the text only once read; a parse error then shows under
// the text, where it can be fixed.
async function readCsvFile(
  file: File | undefined,
  onCsv: (csv: string) => void,
  onError: (error: string) => void,
) {
  if (!file) return;
  if (file.size > CSV_MAX_BYTES) {
    onError("CSV must be under 2 MB.");
    return;
  }
  onCsv(await file.text());
  onError("");
}
