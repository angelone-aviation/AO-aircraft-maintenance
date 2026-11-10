/**
 * Responsibility: The history steps of the Set up an aircraft wizard: the
 *   inspection and AD compliance CSV steps, the dry-run review and the Save
 *   step that starts, shows and resumes the aircraft's commit.
 * Layer: UI. React components; parsing and planning live in
 *   src/domain/aircraftSetup, the commit in src/data/aircraftSetupSession.
 * Dependencies: react, @tanstack/react-router,
 *   src/data/aircraftSetupSession.ts (types), src/domain (aircraftSetup,
 *   maintenanceCsv, model), ./design, ./ui.
 */
import { Link } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";
import type { SetupRun } from "../data/aircraftSetupSession";
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

/** The wizard's draft and commit, and the ways a step changes them. */
export interface SetupDrafts {
  draft: SetupDraft;
  /** Replaces a template text and stores it; ignored while a commit runs. */
  update: (patch: Partial<Pick<SetupDraft, "inspectionCsv" | "adCsv">>) => void;
  /** Forgets the draft once setup is complete. */
  clear: () => void;
  /** The aircraft's commit: running, failed or finished. */
  run: SetupRun | undefined;
  /** Starts the commit of a plan; does nothing while one is running. */
  start: (actions: SetupAction[]) => void;
  /** Resumes a failed commit from the row it stopped at. */
  retry: () => void;
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
type RowState = { label: string; className: string };

const ROW_STATES = {
  saved: { label: "Saved", className: "setup-progress-saved" },
  onRecord: { label: "Already there", className: "setup-progress-saved" },
  failed: { label: "Failed", className: "setup-progress-failed" },
  waiting: { label: "Waiting", className: "setup-progress-waiting" },
  notSaved: { label: "Not saved", className: "setup-progress-waiting" },
} satisfies Record<string, RowState>;

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
 * its rows or the first error. The text is kept in the draft, and cannot be
 * changed while a commit is running.
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
        locked={!!drafts.run?.busy}
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
 * The Save step: starts the aircraft's commit, then shows its progress, its
 * failure with Retry, or its result. The commit belongs to the aircraft, not
 * to this step, so leaving and returning shows the same run and never offers
 * a second Save beside it.
 */
export function CommitStep(props: HistoryStepProps) {
  const { aircraft, drafts, nav } = props;
  const run = drafts.run;
  return (
    <section className="panel setup-panel">
      <h2>Save</h2>
      {!run && <SaveControls {...props} onSave={drafts.start} />}
      {run && <RunProgress run={run} />}
      {run?.failure && !run.busy && (
        <FailureControls {...props} run={run} onRetry={drafts.retry} />
      )}
      {run && !run.busy && !run.failure && (
        <Finished drafts={drafts} aircraft={aircraft} />
      )}
      {nav}
    </section>
  );
}

function SaveControls({
  s,
  aircraft,
  writable,
  drafts,
  onSave,
}: HistoryStepProps & { onSave: (actions: SetupAction[]) => void }) {
  const review = useMemo(
    () => reviewOf(s, aircraft, drafts.draft),
    [s, aircraft, drafts.draft],
  );
  const plan = review.plan;
  if (!plan || plan.errors.length > 0 || review.parseErrors.length > 0)
    return (
      <>
        <NoticeBar tone="warn" role="alert">
          Fix the errors shown in the review before saving.
        </NoticeBar>
        <SaveButton actions={plan?.actions ?? []} disabled onSave={onSave} />
      </>
    );
  return (
    <ReadyToSave
      plan={plan}
      registration={aircraft.registration}
      writable={writable}
      onSave={onSave}
    />
  );
}

function ReadyToSave({
  plan,
  registration,
  writable,
  onSave,
}: {
  plan: SetupPlan;
  registration: string;
  writable: boolean;
  onSave: (actions: SetupAction[]) => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const unconfirmed = plan.confirmations.length > 0 && !confirmed;
  return (
    <>
      {plan.actions.length > 0 && (
        <p>
          {countText(plan.actions)} will be saved for {registration}, in order.
          Each row is its own change-log entry; if one fails, the rows before it
          stay saved and you can retry from the failed row.
        </p>
      )}
      <Confirmations
        items={plan.confirmations}
        confirmed={confirmed}
        onConfirm={setConfirmed}
      />
      <SaveButton
        actions={plan.actions}
        disabled={!writable || unconfirmed}
        onSave={onSave}
      />
    </>
  );
}

function SaveButton({
  actions,
  disabled,
  onSave,
}: {
  actions: SetupAction[];
  disabled: boolean;
  onSave: (actions: SetupAction[]) => void;
}) {
  return (
    <button
      type="button"
      className="button primary"
      disabled={disabled || !actions.length}
      onClick={() => onSave(actions)}
    >
      {actions.length ? `Save ${countText(actions)}` : "Nothing to save"}
    </button>
  );
}

// Values saved exactly as written that look altered: the administrator ticks
// the box after checking them, and only then can the commit start.
function Confirmations({
  items,
  confirmed,
  onConfirm,
}: {
  items: string[];
  confirmed: boolean;
  onConfirm: (confirmed: boolean) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="setup-warnings">
      <h3>Confirm before saving</h3>
      <ul>
        {items.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => onConfirm(e.target.checked)}
        />
        I have checked these AD numbers against the directives. Save them as
        written.
      </label>
    </div>
  );
}

function FailureControls({
  writable,
  run,
  onRetry,
  onStep,
}: HistoryStepProps & { run: SetupRun; onRetry: () => void }) {
  const failed = run.actions.find((a) => a.key === run.failure?.key);
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
        onClick={() => onStep(failed?.step ?? "inspections")}
      >
        Fix the file
      </button>
    </div>
  );
}

function RunProgress({ run }: { run: SetupRun }) {
  return (
    <ol className="setup-progress" aria-label="Save progress">
      {run.actions.map((a) => {
        const state = rowStateOf(run, a.key);
        return (
          <li key={a.key} className={state.className}>
            <span>{state.label}</span>
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

function rowStateOf(run: SetupRun, key: string): RowState {
  if (run.saved.includes(key)) return ROW_STATES.saved;
  if (run.onRecord.includes(key)) return ROW_STATES.onRecord;
  if (run.failure?.key === key) return ROW_STATES.failed;
  return run.busy ? ROW_STATES.waiting : ROW_STATES.notSaved;
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
      <p>{outcomeText(plan)}</p>
      <CountsTable plan={plan} onStep={onStep} />
      <MessageList
        title="Fix before saving"
        items={plan.errors}
        className="setup-errors"
        role="alert"
      />
      <MessageList
        title="Confirm before saving"
        items={plan.confirmations}
        className="setup-warnings"
      />
      <MessageList
        title="Check"
        items={plan.warnings}
        className="setup-warnings"
      />
      <ActionTable actions={plan.actions} />
      <SkippedTable skipped={plan.skipped} />
    </>
  );
}

// One sentence on what Save will and will not write, so nobody has to add up
// the tables to learn that a row is being left out.
function outcomeText(plan: SetupPlan) {
  if (plan.errors.length)
    return "Nothing can be saved until the rows under Fix before saving are corrected.";
  const skipped = plan.skipped.length;
  const left = skipped
    ? ` ${skipped} ${skipped === 1 ? "row" : "rows"} will not be saved; each is listed below with the reason.`
    : " No row is left out.";
  return plan.actions.length
    ? `Save will write ${countText(plan.actions)}.${left}`
    : `Save will write nothing.${left}`;
}

function SkippedTable({ skipped }: { skipped: SetupPlan["skipped"] }) {
  if (!skipped.length) return null;
  return (
    <div className="table-wrap">
      <h3>Rows that will not be saved ({skipped.length})</h3>
      <table aria-label="Rows not saved">
        <thead>
          <tr>
            <th>Step</th>
            <th>Record</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {skipped.map((r) => (
            <tr key={r.key}>
              <td>{r.step === "ads" ? "AD" : "Inspection"}</td>
              <td>{r.label}</td>
              <td>{r.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
          <th>Not saved</th>
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
  locked,
  onCsv,
  onFileError,
}: {
  spec: CsvSpec;
  csv: string;
  /** A commit is running, so the text it was planned from stays as it is. */
  locked: boolean;
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
            disabled={locked}
            onChange={(e) =>
              void readCsvFile(e.target.files?.[0], onCsv, onFileError)
            }
          />
        </Field>
      </div>
      <CsvTextField spec={spec} csv={csv} locked={locked} onCsv={onCsv} />
    </>
  );
}

function CsvTextField({
  spec,
  csv,
  locked,
  onCsv,
}: {
  spec: CsvSpec;
  csv: string;
  locked: boolean;
  onCsv: (csv: string) => void;
}) {
  return (
    <Field
      label={`${spec.title} rows (CSV)`}
      hint={`Columns: ${spec.headers.join(", ")}`}
    >
      <textarea
        rows={10}
        value={csv}
        readOnly={locked}
        onChange={(e) => onCsv(e.target.value)}
      />
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
      : ["Row", "Name", "Intervals", "Last done", "Manual reference"];
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
      <td>{r.manualReference || "—"}</td>
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
