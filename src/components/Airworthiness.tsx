/**
 * Responsibility: The airworthiness directives screen (an aircraft's AD
 *   register, compliance records and reports, Word and FAA imports, FAA
 *   monitoring) and the dashboard's AD alerts.
 * Layer: UI. React components; AD rules live in src/domain.
 * Dependencies: src/data (store, adImport, adReport on demand), src/domain
 *   (airworthiness, faa, listSearch and the AD helpers), ./design, ./ui,
 *   ./TermTip and the AD, FAA, parts and ops components.
 */
import { ADTrackingFields } from "./ADTrackingFields";
import { localDate, type Snapshot } from "../domain/model";
import { ADWorkOrderButton } from "./ADWorkOrderButton";
import { isPilotView } from "../domain/pilotView";
import { adRemaining } from "../domain/adRemaining";
import { memberLicense } from "../domain/certifications";
import { PartsAvailability } from "./RequiredParts";
import { RequestPartsButton } from "./PartsRequests";
import { monitoringReviewCandidates } from "../domain/faaCandidateReview";
import { monitoringScope } from "../domain/faaMonitoringSearch";
import { ADRegister } from "./ADRegister";
import { adMatches } from "../domain/listSearch";
import { FaaSearchImport } from "./FaaSearchImport";
import { FaaKeyStatus } from "./FaaKeySettings";
import { FAA_DRS_KEY_URL } from "../domain/faaCredential";
import {
  emptyMonitor,
  FAA_CHECK_HOUR_UTC,
  faaSearchTerms,
  type FaaCandidate,
  type FaaCommand,
} from "../domain/faa";
import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useWorkspace, type Workspace } from "../data/store";
import { can } from "../domain/model";
import { programPermission } from "../domain/programs";
import {
  AD_RECURRING_CHOICES,
  DASHBOARD_SETTLED_AD_STATUSES,
  REASON_MAX_LENGTH,
  REQUIRED_COMPLIANCE_FIELDS,
  adAircraftUuid,
  adNumber,
  adSaveIsCorrection,
  adSchema,
  adSourceSchema,
  adStatus,
  adTaskSchema,
  adTaskStatus,
  blankAD,
  blankADTask,
  clearInitialLimits,
  effectiveCompliance,
  initialLimitClearReason,
  isTrackedAD,
  needsApplicabilityReason,
  needsSupersedingAD,
  staleInitialLimitNotice,
  staleInitialLimits,
  tracksSameAD,
  withApplicability,
  type AD,
  type ADCommand,
  type ADCompliance,
  type ADSource,
  type ADTask,
  type StaleInitialLimit,
} from "../domain/airworthiness";
import { importADDocx, type ADImport } from "../data/adImport";
import { Field, Modal, errorText, safeHref } from "./ui";
import { useStaleSave, type StaleSaveOptions } from "./StaleSave";
import type { FieldSpecs } from "../domain/fieldDiff";
import { AD_KEEP_MINE } from "../domain/keepMineRules";
import {
  Airplane,
  ArrowsClockwise,
  CaretDown,
  CheckCircle,
  DotsThree,
  FileDoc,
  FilePdf,
  Info,
  Key,
  Plus,
  Printer,
  Warning,
} from "@phosphor-icons/react";
import {
  EmptyState,
  IconTile,
  NoticeBar,
  PageHeader,
  SearchField,
  StatsStrip,
  StatTile,
  Toolbar,
  type IconType,
} from "./design";
import { OpsSelect } from "./OpsList";
import { TermTip } from "./TermTip";

const PCW = "Previously Complied With (PCW)";
// Marks an import group the user chose not to import yet.
const SKIP = "__skip__";
const SOURCE_FIELDS = [
  ["number", "AD number"],
  ["amendment", "Amendment"],
  ["issued", "Issue date (as published)"],
  ["effective", "Effective date (as published)"],
  ["subject", "Subject"],
  ["supersededBy", "Superseded by (source reference)"],
  ["url", "FAA document URL"],
] as const;
const SECTIONS = adSourceSchema.shape.section.options;
const APPLICABILITY_CHOICES = adSchema.shape.applicability.options;
const RECURRENCE_CHOICES = adTaskSchema.shape.recurrence.unwrap().options;
const PRIOR_HOURS_LABELS = {
  aircraftHours: "Aircraft total time at compliance (hours)",
  componentHours: "Component total time at compliance (hours)",
};
const COMPLIANCE_FIELDS = [
  ["date", "Completion date"],
  ["hours", "Hours at completion (airframe total / component TSN)"],
  ["cycles", "Cycles at completion"],
  ["landings", "Aircraft total landings at completion"],
  ["method", "Method of compliance"],
  ["serviceBulletin", "Service bulletin"],
  ["terminatedBy", "Terminating action (only when recurrence ends)"],
  ["mechanic", "Mechanic name"],
  ["certificate", "Certificate number"],
  ["evidence", "Evidence / attachment / logbook reference"],
] as const;
const COUNTER_FIELDS: readonly string[] = ["hours", "cycles", "landings"];
const HOUR_MS = 3_600_000;
// Checks run daily (convex/crons.ts); results older than two days are stale.
const STALE_CHECK_MS = 48 * HOUR_MS;
// A check still marked running blocks another only this long after it
// started, in case it never finishes.
const CHECK_RETRY_MS = 5 * 60_000;

/** A new compliance entry, or (with corrects) a correction of one. */
interface ComplianceDraft {
  record: AD;
  entry: ADCompliance;
  corrects?: string;
  reason?: string;
}
interface ClearingDraft {
  record: AD;
  stale: StaleInitialLimit;
  reason: string;
}
type ADScreen = ReturnType<typeof useADScreen>;
type ADProps = { ad: ADScreen };
type RecordProps = ADProps & { record: AD };
type DraftProps = ADProps & { draft: AD };
type ComponentItem = ReturnType<typeof aircraftComponents>[number];
type WorkOrder = NonNullable<Snapshot["workOrders"]>[number];
type FaaMonitor = ReturnType<typeof useFaaMonitor>;

const groupKey = (e: ADSource) => [e.section, e.make, e.model].join(" / ");

/**
 * The AD alerts panel: tracked ADs that still need attention, and FAA
 * documents awaiting maintenance review.
 *
 * @param props.aircraftUuid - One aircraft's ADs; all aircraft when omitted.
 * @returns The panel. Pilot view gets plain text where others get links to
 *   the AD screen, and no link to manage ADs.
 */
export function ADAlerts({ aircraftUuid }: { aircraftUuid?: string }) {
  const s = useWorkspace((x) => x.snapshot)!;
  const pilotView = isPilotView(s);
  const rows = (s.airworthiness ?? []).filter(
    (r) =>
      (!aircraftUuid || adAircraftUuid(s, r) === aircraftUuid) &&
      !DASHBOARD_SETTLED_AD_STATUSES.includes(adStatus(s, r)),
  );
  const pending = pendingFaaReviews(s, aircraftUuid);
  return (
    <div>
      <h3>Airworthiness directives</h3>
      {pending > 0 && (
        <p>
          {pilotView ? (
            `${pending} FAA document(s) awaiting maintenance review.`
          ) : (
            <Link to="/airworthiness">
              {pending} new or changed FAA documents need review
            </Link>
          )}
        </p>
      )}
      {rows.length ? (
        rows.map((r) => (
          <ADAlert key={r.uuid} s={s} record={r} pilotView={pilotView} />
        ))
      ) : (
        <p>No AD alerts in recorded data.</p>
      )}
      {!pilotView && (
        <Link to="/airworthiness">Manage ADs and compliance reports</Link>
      )}
    </div>
  );
}

function pendingFaaReviews(s: Snapshot, aircraftUuid?: string) {
  return (s.faaMonitors ?? [])
    .filter((m) => !aircraftUuid || m.aircraftUuid === aircraftUuid)
    .reduce(
      (n, m) =>
        n +
        monitoringReviewCandidates(s, m.aircraftUuid, m.candidates).filter(
          (c) => !c.reviewReason,
        ).length,
      0,
    );
}

function ADAlert({
  s,
  record: r,
  pilotView,
}: {
  s: Snapshot;
  record: AD;
  pilotView: boolean;
}) {
  const label = (
    <>
      {s.aircraft.find((a) => a.uuid === r.aircraftUuid)?.registration} · AD{" "}
      {r.source.number}
    </>
  );
  return (
    <div className="list-row">
      <span>
        {pilotView ? (
          <span>{label}</span>
        ) : (
          <Link to="/airworthiness">{label}</Link>
        )}
        {staleInitialLimits(r).map((stale) => (
          <small className="ad-stale-limit" key={stale.taskUuid}>
            {staleInitialLimitNotice(r, stale)}
          </small>
        ))}
      </span>
      <strong>{adStatus(s, r)}</strong>
    </div>
  );
}

/**
 * The AD screen for one aircraft at a time: its register and counts, Word
 * report and FAA imports, compliance PDFs and printing, FAA monitoring, and
 * the AD, compliance and initial-limit forms.
 *
 * @returns The screen. Changes need the maintenance permission and a
 *   connection (the demo works offline); correcting recorded compliance is
 *   for Flight Program administrators and keeps the original entry. Errors
 *   show on the screen and in the open form.
 */
export function Airworthiness() {
  const ad = useADScreen();
  return (
    <div className="ops-page ops-ad">
      <ADHeader ad={ad} />
      <ADToolbar ad={ad} />
      {ad.error && (
        <p role="alert" className="error">
          {ad.error}
        </p>
      )}
      {ad.notice && (
        <NoticeBar tone="good" icon={CheckCircle} role="status">
          {ad.notice}
        </NoticeBar>
      )}
      <ADStats ad={ad} />
      <NoticeBar icon={Info}>
        New imports require applicability review. Counter thresholds use
        aircraft total hours or component time since new. Due-soon warnings
        start at 30 days, hours, or cycles. Source updates preserve recorded
        compliance.
      </NoticeBar>
      <ADTools ad={ad} />
      <ADRegisterSection ad={ad} />
      {ad.rows
        .filter((r) => r.uuid === ad.viewUuid)
        .map((r) => (
          <ADDetails key={r.uuid} ad={ad} record={r} />
        ))}
      {ad.preview && <ImportReview ad={ad} preview={ad.preview} />}
      {ad.draft && <ADDraftForm ad={ad} draft={ad.draft} />}
      {ad.compliance && <ComplianceForm ad={ad} compliance={ad.compliance} />}
      {ad.clearing && <ClearLimitForm ad={ad} clearing={ad.clearing} />}
    </div>
  );
}

function useADScreen() {
  const { snapshot: s, backend, online, connected, demo } = useWorkspace();
  const state = s!;
  const screen = useADState(state.aircraft[0]?.uuid ?? "");
  const [search, setSearch] = useState("");
  const { aircraft } = screen;
  const editable =
    can(state, aircraft, "maintenance") && (demo || (online && connected));
  const aircraftRecord = state.aircraft.find((a) => a.uuid === aircraft);
  return {
    ...screen,
    ...screenActions(screen),
    search,
    setSearch,
    state,
    backend,
    editable,
    aircraftRecord,
    // Correcting recorded compliance is for Flight Program administrators.
    correctable:
      editable &&
      programPermission(state, "admin", aircraftRecord?.programUuid),
    components: aircraftComponents(state, aircraft),
    rows: (state.airworthiness ?? []).filter(
      (r) => adAircraftUuid(state, r) === aircraft,
    ),
    workOrders: (state.workOrders ?? []).filter(
      (w) => w.aircraftUuid === aircraft && w.status !== "cancelled",
    ),
  };
}

function useADState(firstAircraft: string) {
  const [aircraft, setAircraft] = useState(firstAircraft);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [viewUuid, setViewUuid] = useState<string | null>(null);
  const [draft, setDraft] = useState<AD | null>(null);
  const [preview, setPreview] = useState<ADImport | null>(null);
  const [assign, setAssign] = useState<Record<string, string[]>>({});
  const [draftReason, setDraftReason] = useState("");
  const [compliance, setCompliance] = useState<ComplianceDraft | null>(null);
  const [clearing, setClearing] = useState<ClearingDraft | null>(null);
  return {
    aircraft,
    setAircraft,
    error,
    setError,
    notice,
    setNotice,
    busy,
    setBusy,
    viewUuid,
    setViewUuid,
    draft,
    setDraft,
    preview,
    setPreview,
    assign,
    setAssign,
    draftReason,
    setDraftReason,
    compliance,
    setCompliance,
    clearing,
    setClearing,
  };
}

function screenActions(screen: ReturnType<typeof useADState>) {
  const openDraft = (r: AD) => {
    screen.setDraftReason("");
    screen.setDraft(r);
  };
  const clearLimit = (record: AD, stale: StaleInitialLimit) => {
    screen.setError("");
    screen.setViewUuid(null);
    screen.setClearing({
      record,
      stale,
      reason: initialLimitClearReason(record, stale),
    });
  };
  const run = (fn: () => Promise<unknown>, message: string) =>
    runAction(screen, fn, message);
  return { openDraft, clearLimit, run };
}

async function runAction(
  screen: ReturnType<typeof useADState>,
  fn: () => Promise<unknown>,
  message: string,
) {
  screen.setBusy(true);
  screen.setError("");
  try {
    await fn();
    screen.setNotice(message);
    return true;
  } catch (e) {
    // Shown on the screen and in the open form, which stays open to retry.
    screen.setError(errorText(e));
    return false;
  } finally {
    screen.setBusy(false);
  }
}

function aircraftComponents(state: Snapshot, aircraft: string) {
  return (state.management ?? [])
    .filter((c) => c.kind === "component")
    .filter((c) => c.aircraftUuid === aircraft);
}

function ADHeader({ ad }: ADProps) {
  return (
    <PageHeader
      eyebrow="COMPLIANCE"
      title="Airworthiness directives"
      description={
        <>
          <TermTip term="faa" /> directives (<TermTip term="ad">ADs</TermTip>)
          that apply to your aircraft, with applicability review, compliance
          records and printable reports.
        </>
      }
      actions={
        <>
          <span className="ops-ad-faa">
            <FaaSearchImport key={ad.aircraft} aircraftUuid={ad.aircraft} />
          </span>
          <button
            className="button primary"
            disabled={!ad.editable || ad.busy}
            onClick={() => ad.openDraft(blankAD(ad.aircraft))}
          >
            <Plus size={18} weight="bold" aria-hidden="true" /> Add AD
          </button>
        </>
      }
    />
  );
}

function ADToolbar({ ad }: ADProps) {
  return (
    <Toolbar
      end={
        <>
          <WordImportMenu ad={ad} />
          <button
            className="button"
            disabled={!ad.aircraft}
            onClick={() => saveReport(ad)}
          >
            <FilePdf size={18} aria-hidden="true" /> Save compliance PDF
          </button>
          <button
            className="button"
            disabled={!ad.aircraft}
            onClick={() => printReport(ad)}
          >
            <Printer size={18} aria-hidden="true" /> Print compliance report
          </button>
        </>
      }
    >
      <ADFilters ad={ad} />
    </Toolbar>
  );
}

function ADFilters({ ad }: ADProps) {
  return (
    <>
      <OpsSelect
        label="Aircraft"
        icon={Airplane}
        value={ad.aircraft}
        onChange={(value) => selectAircraft(ad, value)}
      >
        {ad.state.aircraft.map((a) => (
          <option key={a.uuid} value={a.uuid}>
            {a.registration} · {a.model}
          </option>
        ))}
      </OpsSelect>
      <SearchField
        label="Search ADs"
        placeholder="AD number, subject or model"
        value={ad.search}
        onChange={ad.setSearch}
      />
    </>
  );
}

function selectAircraft(ad: ADScreen, aircraft: string) {
  ad.setAircraft(aircraft);
  ad.setPreview(null);
  ad.setDraft(null);
  ad.setError("");
}

function WordImportMenu({ ad }: ADProps) {
  return (
    <details className="ops-more">
      <summary className="button">
        <DotsThree size={18} weight="bold" aria-hidden="true" />
        Other import options
      </summary>
      <div className="ops-more-menu">
        <label className="button ops-file-button">
          <FileDoc size={18} aria-hidden="true" />
          Import Word report
          <input
            aria-label="Import AD Word report"
            type="file"
            accept=".docx"
            className="ops-file-input"
            disabled={!ad.editable || ad.busy}
            onChange={(e) => importWordReport(ad, e.target)}
          />
        </label>
      </div>
    </details>
  );
}

function importWordReport(ad: ADScreen, input: HTMLInputElement) {
  const file = input.files?.[0];
  // Cleared so choosing the same file again is a change.
  input.value = "";
  if (!file) return;
  void ad.run(async () => {
    ad.setPreview(await importADDocx(file));
    ad.setAssign({});
  }, "Report ready for review.");
}

async function saveReport(ad: ADScreen) {
  try {
    // Loaded on demand so the PDF library stays out of startup.
    const { saveADReport } = await import("../data/adReport");
    saveADReport(ad.state, ad.aircraft);
  } catch (e) {
    ad.setError(errorText(e));
  }
}

async function printReport(ad: ADScreen) {
  // Open the tab inside the click so pop-up blockers allow it.
  const tab = window.open("", "_blank");
  try {
    if (!tab) throw Error("Allow pop-ups to print the report.");
    const { printADReport } = await import("../data/adReport");
    printADReport(ad.state, ad.aircraft, tab);
  } catch (e) {
    tab?.close();
    ad.setError(errorText(e));
  }
}

function ADStats({ ad }: ADProps) {
  const statuses = ad.rows.map((r) => adStatus(ad.state, r));
  const count = (status: string) => statuses.filter((x) => x === status).length;
  return (
    <StatsStrip className="ops-stats">
      <StatTile label="Tracked ADs" value={ad.rows.length} />
      <StatTile label="ADs needing review" value={count("Needs review")} />
      <StatTile label="ADs due soon" value={count("Due soon")} />
      <StatTile label="Overdue ADs" value={count("Overdue")} />
    </StatsStrip>
  );
}

function ADTools({ ad }: ADProps) {
  return (
    <>
      <Disclosure icon={Key} title="FAA API key status">
        <FaaKeyStatus />
      </Disclosure>
      <Disclosure icon={ArrowsClockwise} title="FAA monitoring and updates">
        <FaaMonitoring
          key={ad.aircraft}
          aircraftUuid={ad.aircraft}
          onImport={(c) => importCandidate(ad, c)}
        />
      </Disclosure>
    </>
  );
}

function Disclosure({
  icon,
  title,
  children,
}: {
  icon: IconType;
  title: string;
  children: ReactNode;
}) {
  return (
    <details className="ad-tools ops-disclosure">
      <summary>
        <IconTile icon={icon} size="sm" />
        <span>{title}</span>
        <CaretDown
          className="ops-disclosure-caret"
          size={18}
          aria-hidden="true"
        />
      </summary>
      <div className="ops-disclosure-body">{children}</div>
    </details>
  );
}

// A candidate updates the one tracked AD with its number, or starts a new
// one; either way its applicability needs review.
function importCandidate(ad: ADScreen, c: FaaCandidate) {
  const matches = ad.rows.filter(
    (r) => adNumber(r.source.number) === adNumber(c.source.number),
  );
  const r =
    matches.length === 1
      ? structuredClone(matches[0])
      : blankAD(ad.aircraft, c.source.section);
  r.source = c.source;
  r.reviewRequired = true;
  ad.openDraft(r);
}

// A search opens every group, so the matching ADs are in view.
function ADRegisterSection({ ad }: ADProps) {
  const matching = ad.rows.filter((r) => adMatches(r, ad.search));
  return (
    <>
      <NoADs rows={ad.rows} matching={matching} />
      <StaleLimitNotice rows={ad.rows} />
      <ADRegister
        records={matching}
        expanded={!!ad.search.trim()}
        state={ad.state}
        aircraftUuid={ad.aircraft}
        editable={ad.editable && !ad.busy}
        onEdit={(r) => {
          ad.setError("");
          ad.openDraft(structuredClone(r));
        }}
        onView={(r) => ad.setViewUuid(r.uuid)}
        onClearInitialLimit={ad.clearLimit}
      />
    </>
  );
}

function NoADs({ rows, matching }: { rows: AD[]; matching: AD[] }) {
  if (!rows.length)
    return (
      <EmptyState title="No AD records for this aircraft">
        Import a report or add an AD to begin.
      </EmptyState>
    );
  if (matching.length) return null;
  return (
    <EmptyState title="No matching ADs">
      Try another search or aircraft.
    </EmptyState>
  );
}

function StaleLimitNotice({ rows }: { rows: AD[] }) {
  const stale = rows.filter((r) => staleInitialLimits(r).length).length;
  if (stale === 0) return null;
  return (
    <NoticeBar tone="warn" icon={Warning}>
      {stale === 1
        ? "1 AD has a one-time limit that was not cleared when compliance was recorded."
        : `${stale} ADs have a one-time limit that was not cleared when compliance was recorded.`}{" "}
      Open the AD group to review it. If compliance satisfied the limit, use
      Clear initial limit; the change is recorded in Change history.
    </NoticeBar>
  );
}

function ADDetails({ ad, record: r }: RecordProps) {
  return (
    <Modal
      title={`AD ${r.source.number} details`}
      onClose={() => ad.setViewUuid(null)}
    >
      <section className="panel">
        <ADSummary ad={ad} record={r} />
        <button
          className="button"
          disabled={!ad.editable || ad.busy}
          onClick={() => {
            ad.setError("");
            ad.setViewUuid(null);
            ad.openDraft(structuredClone(r));
          }}
        >
          Review / edit AD
        </button>
        {r.tasks.map((t) => (
          <ADTaskRow key={t.uuid} ad={ad} record={r} task={t} />
        ))}
        <ComplianceHistory ad={ad} record={r} />
      </section>
    </Modal>
  );
}

function ADSummary({ ad, record: r }: RecordProps) {
  return (
    <>
      <div className="section-heading">
        <h2>AD {r.source.number}</h2>
        <strong>{adStatus(ad.state, r)}</strong>
      </div>
      <p>
        {r.source.section} · {r.source.subject}
      </p>
      <p>
        {r.componentUuid
          ? ad.components.find((c) => c.uuid === r.componentUuid)?.serial ||
            "Component serial not recorded"
          : ad.aircraftRecord?.registration}{" "}
        · Effective {r.source.effective || "not recorded"} · Recurring:{" "}
        {r.source.recurring}
      </p>
      {r.source.supersededBy && (
        <p>
          Source supersession reference: {r.source.supersededBy} — review
          against FAA document.
        </p>
      )}
      {r.priorCompliance && <PriorCompliance record={r} />}
      {r.reason && <p>Applicability reason: {r.reason}</p>}
    </>
  );
}

function PriorCompliance({ record: r }: { record: AD }) {
  const prior = r.priorCompliance!;
  return (
    <p>
      Previously Complied With (PCW) · {prior.date} · Aircraft total time:{" "}
      {prior.aircraftHours ?? "Not recorded"} hours
      {r.componentUuid && (
        <>
          {" "}
          · Component total time: {prior.componentHours ?? "Not recorded"} hours
        </>
      )}
    </p>
  );
}

function ADTaskRow({ ad, record: r, task: t }: RecordProps & { task: ADTask }) {
  return (
    <div className="list-row">
      <div className="grow">
        <strong>{t.description}</strong>
        {adRemaining(ad.state, r, t).map(({ label, value }) => (
          <p key={label}>
            <strong>
              {label}: {value}
            </strong>
          </p>
        ))}
        <p>
          {adTaskStatus(ad.state, r, t)} · Due: {taskDue(t)}
        </p>
        <p>
          {t.recurrence} · Interval: {taskInterval(t)}
        </p>
        <TaskStaleLimits ad={ad} record={r} task={t} />
        <TaskParts ad={ad} task={t} />
      </div>
      <ADWorkOrderButton state={ad.state} record={r} taskUuid={t.uuid} />
      <button
        className="button small"
        disabled={!ad.editable || ad.busy || !isTrackedAD(r)}
        onClick={() => {
          ad.setViewUuid(null);
          ad.setCompliance({ record: r, entry: newCompliance(ad, t) });
        }}
      >
        Record compliance
      </button>
    </div>
  );
}

// A limit shows when it has an interval or a due value. Landings are optional
// in the schema, so an undefined due value counts as unset there.
function taskDue(t: ADTask) {
  return (
    [
      (t.intervalDays || t.dueDate) && (t.dueDate || "date not set"),
      (t.intervalHours || t.dueHours !== null) &&
        `${t.dueHours ?? "not set"} hours`,
      (t.intervalLandings || t.dueLandings != null) &&
        `${t.dueLandings ?? "not set"} landings`,
      (t.intervalCycles || t.dueCycles !== null) &&
        `${t.dueCycles ?? "not set"} cycles`,
    ]
      .filter(Boolean)
      .join(" / ") || "not set"
  );
}

function taskInterval(t: ADTask) {
  return (
    [
      t.intervalDays && `${t.intervalDays} days`,
      t.intervalHours && `${t.intervalHours} hours`,
      t.intervalCycles && `${t.intervalCycles} cycles`,
      t.intervalLandings && `${t.intervalLandings} landings`,
    ]
      .filter(Boolean)
      .join(" / ") || "not set"
  );
}

function TaskStaleLimits({
  ad,
  record: r,
  task: t,
}: RecordProps & { task: ADTask }) {
  return (
    <>
      {staleInitialLimits(r)
        .filter((stale) => stale.taskUuid === t.uuid)
        .map((stale) => (
          <div className="ad-stale-limit" key={stale.taskUuid}>
            <p>{staleInitialLimitNotice(r, stale)}</p>
            <button
              className="button small"
              disabled={!ad.editable || ad.busy}
              onClick={() => ad.clearLimit(r, stale)}
            >
              Clear initial limit
            </button>
          </div>
        ))}
    </>
  );
}

function TaskParts({ ad, task: t }: ADProps & { task: ADTask }) {
  return (
    <>
      <PartsAvailability source={partsSource(t)} />
      <RequestPartsButton source={partsSource(t)} />
      {t.workOrderUuid && (
        <Link to="/work-orders">
          Work order:{" "}
          {ad.workOrders.find((w) => w.uuid === t.workOrderUuid)?.number ||
            t.workOrderUuid}
        </Link>
      )}
    </>
  );
}

const partsSource = (t: ADTask) =>
  ({ kind: "airworthiness", uuid: t.uuid, workOrderUuid: "" }) as const;

// Prefilled with today, the signed-in mechanic and the task's work order, or
// a work order that already carries the task.
function newCompliance(ad: ADScreen, t: ADTask): ADCompliance {
  return {
    uuid: crypto.randomUUID(),
    taskUuid: t.uuid,
    date: localDate(),
    hours: null,
    cycles: null,
    method: "",
    serviceBulletin: "",
    terminatedBy: "",
    workOrderUuid:
      t.workOrderUuid || taskWorkOrder(ad.workOrders, t.uuid)?.uuid || "",
    mechanic: ad.state.user.name,
    certificate: memberLicense(ad.state.user).licenseNumber,
    evidence: "",
    recordedAt: 0,
    recordedBy: "",
  };
}

function taskWorkOrder(workOrders: WorkOrder[], taskUuid: string) {
  return workOrders.find((w) =>
    w.tasks.some(
      (x) => x.source.kind === "airworthiness" && x.source.uuid === taskUuid,
    ),
  );
}

function ComplianceHistory({ ad, record: r }: RecordProps) {
  const entries = effectiveCompliance(r);
  return (
    <details>
      <summary>
        Compliance history ({entries.length}) and source history (
        {r.sourceHistory.length})
      </summary>
      {entries.map((h) => (
        <ComplianceEntry key={h.uuid} ad={ad} record={r} entry={h} />
      ))}
      {ad.editable && !ad.correctable && entries.length > 0 && (
        <p>
          <small>
            A Flight Program administrator can correct recorded compliance.
          </small>
        </p>
      )}
      {r.sourceHistory.map((h, i) => (
        <p key={i}>
          {new Date(h.at).toLocaleString()} · {h.source.number} ·{" "}
          {h.source.subject}
        </p>
      ))}
      <pre style={{ whiteSpace: "pre-wrap" }}>{r.source.sourceNotes}</pre>
    </details>
  );
}

function ComplianceEntry({
  ad,
  record: r,
  entry: h,
}: RecordProps & { entry: ADCompliance }) {
  const original = r.history.find((x) => x.uuid === h.corrects);
  return (
    <div>
      <p>
        {h.date} · {h.method} · {h.hours ?? "—"} hours · {h.cycles ?? "—"}{" "}
        cycles · {h.landings != null && <>{h.landings} aircraft landings · </>}{" "}
        {h.mechanic} / {h.certificate} · {h.evidence}
      </p>
      {original && <CorrectionNote entry={h} original={original} />}
      {ad.correctable && (
        <button
          className="button small"
          disabled={ad.busy}
          aria-label={`Correct entry of ${h.date}`}
          onClick={() => correctEntry(ad, r, h)}
        >
          Correct entry
        </button>
      )}
    </div>
  );
}

function CorrectionNote({
  entry: h,
  original,
}: {
  entry: ADCompliance;
  original: ADCompliance;
}) {
  return (
    <p>
      <small>
        Corrected {new Date(h.recordedAt).toLocaleDateString()}:{" "}
        {h.correctionReason}. Originally recorded: {original.date} ·{" "}
        {original.method} · {original.hours ?? "—"} hours ·{" "}
        {original.cycles ?? "—"} cycles · {original.mechanic}
      </small>
    </p>
  );
}

// Correcting a correction points at the same original entry.
function correctEntry(ad: ADScreen, r: AD, h: ADCompliance) {
  const { corrects: _corrects, correctionReason: _reason, ...values } = h;
  ad.setError("");
  ad.setViewUuid(null);
  ad.setCompliance({
    record: r,
    corrects: h.corrects ?? h.uuid,
    reason: "",
    entry: { ...values, uuid: crypto.randomUUID() },
  });
}

function ImportReview({ ad, preview }: ADProps & { preview: ADImport }) {
  const groups = [
    ...new Set(
      preview.entries.filter((e) => e.section !== "Airframe").map(groupKey),
    ),
  ];
  return (
    <Modal
      title="Review AD import"
      onClose={() => !ad.busy && ad.setPreview(null)}
    >
      <ImportSummary ad={ad} preview={preview} />
      {groups.map((key) => (
        <ComponentAssignment key={key} ad={ad} group={key} />
      ))}
      <ImportEntries ad={ad} preview={preview} />
      <button
        className="button primary"
        disabled={
          ad.busy ||
          preview.entries.some(
            (e) => e.section !== "Airframe" && !ad.assign[groupKey(e)]?.length,
          )
        }
        onClick={() => confirmImport(ad, preview)}
      >
        Confirm import
      </button>
    </Modal>
  );
}

function ImportSummary({ ad, preview }: ADProps & { preview: ADImport }) {
  const target = ad.aircraftRecord?.registration;
  return (
    <>
      <p>
        {preview.entries.length} AD entries. Report aircraft:{" "}
        {preview.registration || "not recorded"}. Import into: {target}.
      </p>
      {preview.registration && preview.registration !== target && (
        <p role="alert">
          Registration differs. Confirm that this report is appropriate for the
          selected aircraft before importing.
        </p>
      )}
      <p>
        Compliance fields from the report are preserved as source notes. They do
        not automatically establish compliance.
      </p>
      {preview.warnings.map((w, i) => (
        <p key={i} className="callout">
          {w}
        </p>
      ))}
    </>
  );
}

function ComponentAssignment({ ad, group }: ADProps & { group: string }) {
  const chosen = ad.assign[group] ?? [];
  const choose = (next: string[]) =>
    ad.setAssign({ ...ad.assign, [group]: next });
  return (
    <fieldset>
      <legend>{group}: assign to specific components</legend>
      <label>
        <input
          type="checkbox"
          checked={chosen.includes(SKIP)}
          onChange={(e) => choose(e.target.checked ? [SKIP] : [])}
        />
        Skip this section for now (not imported)
      </label>
      {ad.components.map((c) => (
        <label key={c.uuid}>
          <input
            type="checkbox"
            checked={chosen.includes(c.uuid)}
            onChange={(e) =>
              choose(toggleComponent(chosen, c.uuid, e.target.checked))
            }
          />
          <ComponentLabel component={c} />
        </label>
      ))}
      {!ad.components.length && (
        <p>Add the aircraft’s components first, then import this report.</p>
      )}
    </fieldset>
  );
}

// Choosing a component takes the group off "skip".
function toggleComponent(chosen: string[], uuid: string, checked: boolean) {
  return checked
    ? [...chosen.filter((id) => id !== SKIP), uuid]
    : chosen.filter((id) => id !== uuid);
}

function ComponentLabel({ component: c }: { component: ComponentItem }) {
  return (
    <>
      {c.manufacturer} {c.model || c.componentType} · {c.installPosition} · P/N{" "}
      {c.partNumber} · S/N {c.serial || "not recorded"}
    </>
  );
}

function ImportEntries({ ad, preview }: ADProps & { preview: ADImport }) {
  return (
    <div style={{ maxHeight: 260, overflow: "auto" }}>
      {preview.entries.map((e, i) => (
        <p key={i}>
          {e.section} · {e.number} · {e.subject} ·{" "}
          {ad.rows.some((r) => adNumber(r.source.number) === adNumber(e.number))
            ? "Existing AD — match by component on import"
            : "New AD"}
        </p>
      ))}
    </div>
  );
}

function confirmImport(ad: ADScreen, preview: ADImport) {
  void ad.run(async () => {
    await ad.backend!.saveAD({
      kind: "import",
      aircraftUuid: ad.aircraft,
      entries: importEntries(preview, ad.assign),
    });
    ad.setPreview(null);
  }, "AD report imported. Review applicability and enter required actions.");
}

// Airframe ADs import onto the aircraft (""); the others once for each
// component chosen for their group.
function importEntries(preview: ADImport, assign: Record<string, string[]>) {
  return preview.entries.flatMap((source) =>
    (source.section === "Airframe"
      ? [""]
      : (assign[groupKey(source)] ?? []).filter((id) => id !== SKIP)
    ).map((componentUuid) => ({ source, componentUuid })),
  );
}

const AD_TASK_LABELS: FieldSpecs<ADTask> = {
  description: "Required action",
  recurrence: "Action recurrence",
  dueDate: "Next due date",
  dueHours: "Next due hours",
  dueCycles: "Next due cycles",
  dueLandings: "Next due landings",
  intervalDays: "Repeat every days",
  intervalHours: "Repeat every hours",
  intervalCycles: "Repeat every cycles",
  intervalLandings: "Repeat every landings",
  workOrderUuid: {
    label: "Work order",
    format: (uuid) => (uuid ? "Linked" : "Not linked"),
  },
};

// How the stale-save review names and formats an AD's fields, down to each
// required action's limits; the compliance history reads as a count and its
// latest entry, never as stored data.
const AD_STALE_SAVE: StaleSaveOptions<AD> = {
  label: "AD",
  entityUuid: (r) => r.uuid,
  rules: AD_KEEP_MINE,
  specs: {
    source: {
      label: "FAA source",
      fields: {
        ...Object.fromEntries(SOURCE_FIELDS),
        recurring: "Recurring",
        section: "Section",
        sourceNotes: "Source notes",
      },
    },
    applicability: "Applicability",
    reason: "Applicability reason / paragraph",
    priorCompliance: {
      label: "Previous compliance",
      fields: { date: "Date", ...PRIOR_HOURS_LABELS },
    },
    tasks: {
      label: "Required actions",
      item: (t, index) => `Required action ${index + 1} (${t.description})`,
      fields: AD_TASK_LABELS,
    },
    history: { label: "Compliance history", format: formatADHistory },
    sourceHistory: {
      label: "Earlier FAA source versions",
      format: (kept) => `${(kept as AD["sourceHistory"]).length} kept`,
    },
    reviewRequired: "Review required",
  },
};

function formatADHistory(value: unknown) {
  const history = value as AD["history"];
  const latest = history.at(-1);
  if (!latest) return "No entries";
  const at = latest.hours === null ? "" : ` at ${latest.hours} h`;
  return `${history.length} ${history.length === 1 ? "entry" : "entries"}; latest ${latest.date}${at} by ${latest.mechanic}`;
}

function ADDraftForm({ ad, draft }: DraftProps) {
  const needsReason = adSaveIsCorrection(
    (ad.state.airworthiness ?? []).find((r) => r.uuid === draft.uuid),
  );
  const stale = useStaleSave(AD_STALE_SAVE);
  // The stored AD as it was when the form opened (or was reloaded): what
  // Keep mine measures the user's changes against.
  const [loaded, setLoaded] = useState(() => storedAD(ad.state, draft.uuid));
  return (
    <Modal
      title={draft.version ? "Review AD" : "Add AD"}
      onClose={() => !ad.busy && ad.setDraft(null)}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submitDraft(ad, stale, {
            draft,
            loaded,
            needsReason,
            onReload: setLoaded,
          });
        }}
      >
        <div className="form-grid">
          <SourceFields ad={ad} draft={draft} />
          <ApplicabilityFields ad={ad} draft={draft} />
        </div>
        <DraftReview ad={ad} draft={draft} />
        <DraftTasks ad={ad} draft={draft} />
        {needsReason && <ChangeReasonField ad={ad} />}
        <button className="button primary" disabled={ad.busy} type="submit">
          Save AD
        </button>
        {ad.error && <p role="alert">{ad.error}</p>}
      </form>
      {stale.dialog}
    </Modal>
  );
}

function storedAD(s: Snapshot, uuid: string) {
  const stored = s.airworthiness?.find((r) => r.uuid === uuid);
  return stored && structuredClone(stored);
}

// The draft is the edited copy itself: the review compares it and the copy
// the form opened on with the stored AD, and Use theirs reopens the form on
// a fresh copy of that.
async function submitDraft(
  ad: ADScreen,
  stale: ReturnType<typeof useStaleSave<AD>>,
  form: {
    draft: AD;
    loaded: AD | undefined;
    needsReason: boolean;
    onReload: (current: AD | undefined) => void;
  },
) {
  const { draft, loaded, needsReason } = form;
  ad.setBusy(true);
  ad.setError("");
  try {
    await stale.run({
      draft,
      loaded,
      find: (live) => live.airworthiness?.find((r) => r.uuid === draft.uuid),
      save: (version, merged) =>
        saveDraft(ad, { ...(merged ?? draft), version }, needsReason),
      useTheirs: (current) => {
        form.onReload(current && structuredClone(current));
        ad.setDraft(current ? structuredClone(current) : null);
      },
    });
  } catch (e) {
    // Shown on the screen and in the open form, which stays open to retry.
    ad.setError(errorText(e));
  } finally {
    ad.setBusy(false);
  }
}

async function saveDraft(ad: ADScreen, draft: AD, needsReason: boolean) {
  await ad.backend!.saveAD({
    kind: "save",
    record: draft,
    ...(needsReason ? { reason: ad.draftReason } : {}),
  });
  ad.setDraft(null);
  ad.setNotice("AD saved.");
}

function SourceFields({ ad, draft }: DraftProps) {
  return (
    <>
      {SOURCE_FIELDS.map(([key, label]) => (
        <Field label={label} key={key}>
          <input
            required={
              key === "number" ||
              key === "subject" ||
              (key === "supersededBy" &&
                needsSupersedingAD(draft.applicability))
            }
            value={draft.source[key]}
            onChange={(e) => updateSource(ad, key, e.target.value)}
          />
        </Field>
      ))}
      <Field label="Section">
        <select
          disabled={draft.version > 0}
          value={draft.source.section}
          onChange={(e) => updateSource(ad, "section", e.target.value)}
        >
          <Choices values={SECTIONS} />
        </select>
      </Field>
      {draft.source.section !== "Airframe" && (
        <ComponentField ad={ad} draft={draft} />
      )}
      <Field label="Recurring">
        <select
          value={draft.source.recurring}
          onChange={(e) => updateSource(ad, "recurring", e.target.value)}
        >
          <Choices values={AD_RECURRING_CHOICES} />
        </select>
      </Field>
    </>
  );
}

function updateSource(ad: ADScreen, key: keyof ADSource, text: string) {
  ad.setDraft((d) => (d ? { ...d, source: { ...d.source, [key]: text } } : d));
}

function Choices({ values }: { values: readonly string[] }) {
  return (
    <>
      {values.map((v) => (
        <option key={v}>{v}</option>
      ))}
    </>
  );
}

function ComponentField({ ad, draft }: DraftProps) {
  return (
    <Field label="Component">
      <select
        required
        disabled={draft.version > 0}
        value={draft.componentUuid}
        onChange={(e) =>
          ad.setDraft(withComponent(ad.rows, draft, e.target.value))
        }
      >
        <option value="">Select component</option>
        {ad.components.map((c) => (
          <option key={c.uuid} value={c.uuid}>
            {c.componentType} · {c.installPosition} · {c.serial}
          </option>
        ))}
      </select>
    </Field>
  );
}

// Choosing a component that already tracks this AD number switches the draft
// to that record, keeping the source being edited.
function withComponent(rows: AD[], draft: AD, componentUuid: string): AD {
  const tracked = rows.find((r) =>
    tracksSameAD(r, { componentUuid, source: draft.source }),
  );
  return {
    ...(tracked ?? draft),
    source: draft.source,
    reviewRequired: true,
    componentUuid,
  };
}

function ApplicabilityFields({ ad, draft }: DraftProps) {
  return (
    <>
      <Field label="Applicability">
        <select
          value={draft.applicability}
          onChange={(e) =>
            ad.setDraft(
              withApplicability(draft, e.target.value as AD["applicability"]),
            )
          }
        >
          <Choices values={APPLICABILITY_CHOICES} />
        </select>
      </Field>
      {draft.applicability === PCW && (
        <PriorComplianceFields ad={ad} draft={draft} />
      )}
      <Field label="Applicability reason / paragraph">
        <textarea
          required={needsApplicabilityReason(draft.applicability)}
          value={draft.reason}
          onChange={(e) => ad.setDraft({ ...draft, reason: e.target.value })}
        />
      </Field>
    </>
  );
}

function PriorComplianceFields({ ad, draft }: DraftProps) {
  const hours: (keyof typeof PRIOR_HOURS_LABELS)[] = draft.componentUuid
    ? ["aircraftHours", "componentHours"]
    : ["aircraftHours"];
  return (
    <>
      <Field label="Previous compliance date">
        <input
          type="date"
          required
          max={localDate()}
          value={draft.priorCompliance?.date ?? ""}
          onChange={(e) =>
            ad.setDraft({
              ...draft,
              priorCompliance: {
                aircraftHours: null,
                componentHours: null,
                ...draft.priorCompliance,
                date: e.target.value,
              },
            })
          }
        />
      </Field>
      {hours.map((key) => (
        <PriorHoursField key={key} ad={ad} draft={draft} field={key} />
      ))}
      <p>
        Enter the historical total time, not today's reading. For component ADs,
        enter aircraft time, component time, or both. PCW records previous
        compliance; recurring or unknown requirements still need required
        actions and next due limits.
      </p>
    </>
  );
}

function PriorHoursField({
  ad,
  draft,
  field,
}: DraftProps & { field: keyof typeof PRIOR_HOURS_LABELS }) {
  return (
    <Field label={PRIOR_HOURS_LABELS[field]}>
      <input
        type="number"
        min="0"
        step="any"
        value={draft.priorCompliance?.[field] ?? ""}
        onChange={(e) =>
          ad.setDraft({
            ...draft,
            priorCompliance: {
              date: "",
              aircraftHours: null,
              componentHours: null,
              ...draft.priorCompliance,
              [field]: numberOrNull(e.target.value),
            },
          })
        }
      />
    </Field>
  );
}

const numberOrNull = (text: string) => (text === "" ? null : Number(text));

function DraftReview({ ad, draft }: DraftProps) {
  return (
    <>
      <label>
        <input
          type="checkbox"
          checked={!draft.reviewRequired}
          onChange={(e) =>
            ad.setDraft({ ...draft, reviewRequired: !e.target.checked })
          }
        />
        Applicability and source changes reviewed
      </label>
      {draft.applicability === "Superseded" && (
        <p>
          Enter the replacing AD in Superseded by. Saving marks this AD as
          superseded and preserves its compliance history. Track the replacing
          AD separately.
        </p>
      )}
      {draft.applicability === "Not applicable" && (
        <p>
          Selecting Not applicable marks the review complete. Record your reason
          before saving. Uncheck the review box if further review is needed;
          later FAA source updates will require review again.
        </p>
      )}
    </>
  );
}

function DraftTasks({ ad, draft }: DraftProps) {
  return (
    <>
      <h3>Required actions</h3>
      {draft.tasks.map((t, index) => (
        <DraftTask key={t.uuid} ad={ad} draft={draft} task={t} index={index} />
      ))}
      <button
        className="button"
        type="button"
        onClick={() =>
          ad.setDraft({ ...draft, tasks: [...draft.tasks, blankADTask()] })
        }
      >
        Add required action
      </button>
    </>
  );
}

function DraftTask({
  ad,
  draft,
  task: t,
  index,
}: DraftProps & { task: ADTask; index: number }) {
  const update = (change: (task: ADTask) => ADTask) =>
    ad.setDraft({
      ...draft,
      tasks: draft.tasks.map((x) => (x.uuid === t.uuid ? change(x) : x)),
    });
  return (
    <fieldset>
      <legend>Action {index + 1}</legend>
      <TaskTextFields task={t} update={update} />
      <ADTrackingFields task={t} onChange={(next) => update(() => next)} />
      <Field label="Work order">
        <WorkOrderSelect
          workOrders={ad.workOrders}
          value={t.workOrderUuid}
          onChange={(v) => update((x) => ({ ...x, workOrderUuid: v }))}
        />
      </Field>
      <button
        className="button small"
        type="button"
        disabled={draft.history.some((h) => h.taskUuid === t.uuid)}
        onClick={() =>
          ad.setDraft({
            ...draft,
            tasks: draft.tasks.filter((x) => x.uuid !== t.uuid),
          })
        }
      >
        Remove action
      </button>
    </fieldset>
  );
}

function TaskTextFields({
  task: t,
  update,
}: {
  task: ADTask;
  update: (change: (task: ADTask) => ADTask) => void;
}) {
  return (
    <>
      <Field label="Action recurrence">
        <select
          value={t.recurrence}
          onChange={(e) => {
            const recurrence = e.target.value as ADTask["recurrence"];
            update((x) => ({ ...x, recurrence }));
          }}
        >
          <Choices values={RECURRENCE_CHOICES} />
        </select>
      </Field>
      <Field label="Required action">
        <textarea
          required
          value={t.description}
          onChange={(e) => {
            const description = e.target.value;
            update((x) => ({ ...x, description }));
          }}
        />
      </Field>
    </>
  );
}

// Field gives its child the label's id and hint, so they pass through here.
function WorkOrderSelect({
  workOrders,
  value,
  onChange,
  ...field
}: {
  workOrders: WorkOrder[];
  value: string;
  onChange: (workOrderUuid: string) => void;
  id?: string;
  "aria-describedby"?: string;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} {...field}>
      <option value="">No work order linked</option>
      {workOrders.map((w) => (
        <option key={w.uuid} value={w.uuid}>
          {w.number || w.uuid} · {w.status}
        </option>
      ))}
    </select>
  );
}

function ChangeReasonField({ ad }: ADProps) {
  return (
    <Field
      label="Reason for change"
      hint="Required to change an AD whose applicability is decided or that has compliance recorded. Recorded in Change history."
    >
      <textarea
        required
        maxLength={REASON_MAX_LENGTH}
        value={ad.draftReason}
        onChange={(e) => ad.setDraftReason(e.target.value)}
      />
    </Field>
  );
}

function ComplianceForm({
  ad,
  compliance,
}: ADProps & { compliance: ComplianceDraft }) {
  const set = ad.setCompliance;
  return (
    <Modal
      title={
        compliance.corrects
          ? "Correct AD compliance record"
          : "Record AD compliance"
      }
      onClose={() => !ad.busy && set(null)}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          saveCompliance(ad, compliance);
        }}
      >
        <ComplianceIntro compliance={compliance} />
        <ComplianceFields ad={ad} compliance={compliance} />
        {compliance.corrects && (
          <Field label="Reason for correction">
            <textarea
              required
              maxLength={REASON_MAX_LENGTH}
              value={compliance.reason ?? ""}
              onChange={(e) => set({ ...compliance, reason: e.target.value })}
            />
          </Field>
        )}
        <button className="button primary" disabled={ad.busy}>
          {compliance.corrects ? "Save correction" : "Save compliance"}
        </button>
        {ad.error && <p role="alert">{ad.error}</p>}
      </form>
    </Modal>
  );
}

function ComplianceIntro({ compliance }: { compliance: ComplianceDraft }) {
  return (
    <p>
      {compliance.corrects
        ? "The original entry stays in the compliance history. This correction replaces it for due limits and reports, and Change history records it with your reason."
        : "This records compliance evidence; it does not sign or close a work order."}
    </p>
  );
}

function saveCompliance(ad: ADScreen, compliance: ComplianceDraft) {
  void ad.run(
    async () => {
      await ad.backend!.saveAD(complianceCommand(compliance));
      ad.setCompliance(null);
    },
    compliance.corrects
      ? "Correction recorded; the original entry is kept."
      : "Compliance recorded; recurring due limits updated.",
  );
}

function complianceCommand(c: ComplianceDraft): ADCommand {
  const { record, entry } = c;
  if (!c.corrects)
    return {
      kind: "comply",
      uuid: record.uuid,
      version: record.version,
      entry,
    };
  return {
    kind: "correct",
    uuid: record.uuid,
    version: record.version,
    corrects: c.corrects,
    reason: c.reason ?? "",
    entry,
  };
}

function ComplianceFields({
  ad,
  compliance,
}: ADProps & { compliance: ComplianceDraft }) {
  return (
    <>
      <div className="form-grid">
        {COMPLIANCE_FIELDS.map(([key, label]) => (
          <ComplianceField
            key={key}
            ad={ad}
            compliance={compliance}
            field={key}
            label={label}
          />
        ))}
      </div>
      <Field label="Compliance work order">
        <WorkOrderSelect
          workOrders={ad.workOrders}
          value={compliance.entry.workOrderUuid}
          onChange={(v) =>
            ad.setCompliance({
              ...compliance,
              entry: { ...compliance.entry, workOrderUuid: v },
            })
          }
        />
      </Field>
    </>
  );
}

function ComplianceField({
  ad,
  compliance,
  field,
  label,
}: ADProps & {
  compliance: ComplianceDraft;
  field: (typeof COMPLIANCE_FIELDS)[number][0];
  label: string;
}) {
  const counter = COUNTER_FIELDS.includes(field);
  return (
    <Field label={label}>
      <input
        required={REQUIRED_COMPLIANCE_FIELDS.includes(field)}
        type={field === "date" ? "date" : counter ? "number" : "text"}
        min="0"
        step={field === "hours" ? "0.1" : "1"}
        value={compliance.entry[field] ?? ""}
        onChange={(e) =>
          ad.setCompliance({
            ...compliance,
            entry: {
              ...compliance.entry,
              [field]: counter ? numberOrNull(e.target.value) : e.target.value,
            },
          })
        }
      />
    </Field>
  );
}

function ClearLimitForm({
  ad,
  clearing,
}: ADProps & { clearing: ClearingDraft }) {
  const { record, stale } = clearing;
  return (
    <Modal
      title="Clear initial limit"
      onClose={() => !ad.busy && ad.setClearing(null)}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          saveClearedLimit(ad, clearing);
        }}
      >
        <p>
          AD {record.source.number} ·{" "}
          {record.tasks.find((t) => t.uuid === stale.taskUuid)?.description}
        </p>
        <p>{staleInitialLimitNotice(record, stale)}</p>
        <ClearLimitHelp />
        <Field label="Reason for change">
          <textarea
            required
            maxLength={REASON_MAX_LENGTH}
            value={clearing.reason}
            onChange={(e) =>
              ad.setClearing({ ...clearing, reason: e.target.value })
            }
          />
        </Field>
        <button className="button primary" disabled={ad.busy}>
          Clear initial limit
        </button>
        {ad.error && <p role="alert">{ad.error}</p>}
      </form>
    </Modal>
  );
}

function ClearLimitHelp() {
  return (
    <p>
      Repeating limits stay as they are. The AD is saved with the limit removed,
      and Change history records the values before and after with this reason.
    </p>
  );
}

function saveClearedLimit(ad: ADScreen, clearing: ClearingDraft) {
  void ad.run(async () => {
    await ad.backend!.saveAD({
      kind: "save",
      record: clearInitialLimits(clearing.record, clearing.stale.taskUuid),
      reason: clearing.reason,
    });
    ad.setClearing(null);
  }, "Initial limit cleared.");
}

function FaaMonitoring({
  aircraftUuid,
  onImport,
}: {
  aircraftUuid: string;
  onImport: (c: FaaCandidate) => void;
}) {
  const m = useFaaMonitor(aircraftUuid);
  const hidden = m.saved.candidates.length - m.candidates.length;
  return (
    <section className="ops-monitoring">
      <h2>FAA monitoring</h2>
      <p>
        Checks final rules and emergency ADs in FAA DRS. Matches are candidates
        for review, not confirmed applicability. Proposed rules are excluded.
      </p>
      <MonitorStatus monitor={m} />
      <MonitorSettings monitor={m} />
      <CheckNowButton monitor={m} />
      {m.demo && <p>Live FAA checks require a connected backend.</p>}
      <p>
        {m.pending.length} new or changed candidate documents awaiting review.
      </p>
      {hidden > 0 && (
        <p>
          {hidden} unchanged documents already imported for this
          aircraft/components are hidden.
        </p>
      )}
      {m.candidates.map((c) => (
        <CandidateReview
          key={c.id}
          monitor={m}
          candidate={c}
          onImport={onImport}
        />
      ))}
    </section>
  );
}

function useFaaMonitor(aircraftUuid: string) {
  const { snapshot: s, backend, demo, online, connected } = useWorkspace();
  const state = s!;
  const saved =
    state.faaMonitors?.find((m) => m.aircraftUuid === aircraftUuid) ??
    emptyMonitor(aircraftUuid);
  const form = useMonitorForm(saved);
  const candidates = monitoringReviewCandidates(
    state,
    aircraftUuid,
    saved.candidates,
  );
  return {
    ...form,
    state,
    aircraftUuid,
    saved,
    demo,
    editable:
      can(state, aircraftUuid, "maintenance") &&
      (demo || (online && connected)),
    run: (command: FaaCommand) =>
      runFaaCommand(backend, command, form.setBusy, form.setError),
    candidates,
    pending: candidates.filter((c) => !c.reviewReason),
  };
}

function useMonitorForm(saved: { terms: string[]; enabled: boolean }) {
  const [terms, setTerms] = useState(saved.terms.join("\n"));
  const [enabled, setEnabled] = useState(saved.enabled);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  return {
    terms,
    setTerms,
    enabled,
    setEnabled,
    error,
    setError,
    busy,
    setBusy,
    reasons,
    setReasons,
  };
}

async function runFaaCommand(
  backend: Workspace["backend"],
  command: FaaCommand,
  setBusy: (busy: boolean) => void,
  setError: (error: string) => void,
) {
  setBusy(true);
  setError("");
  try {
    await backend!.faaCommand(command);
  } catch (e) {
    // Shown in the monitoring panel; the command can be sent again.
    setError(errorText(e));
  } finally {
    setBusy(false);
  }
}

function MonitorStatus({ monitor: m }: { monitor: FaaMonitor }) {
  const { saved } = m;
  const coverageChanged =
    !!saved.lastSuccess &&
    JSON.stringify(monitoringScope(m.state, m.aircraftUuid, saved.terms)) !==
      JSON.stringify(saved.checkedTerms);
  return (
    <>
      <p>
        Last successful check:{" "}
        {saved.lastSuccess
          ? new Date(saved.lastSuccess).toLocaleString()
          : "Never"}
        . {saved.runId ? "Check in progress…" : ""}{" "}
        {saved.lastSuccess && Date.now() - saved.lastSuccess > STALE_CHECK_MS
          ? "Results are stale — last check was more than 48 hours ago."
          : ""}
      </p>
      {coverageChanged && (
        <p role="alert">
          Aircraft equipment or search terms changed since the last successful
          check. Run a new check.
        </p>
      )}
      {saved.error && <p role="alert">{saved.error}</p>}
      {m.error && <p role="alert">{m.error}</p>}
    </>
  );
}

function MonitorSettings({ monitor: m }: { monitor: FaaMonitor }) {
  return (
    <details>
      <summary>Monitoring settings and FAA key setup</summary>
      <KeySetupHelp />
      <label>
        <input
          type="checkbox"
          checked={m.enabled}
          onChange={(e) => m.setEnabled(e.target.checked)}
          disabled={!m.editable}
        />
        Enable daily checks
      </label>
      <Field label="Additional FAA search terms (one per line)">
        <textarea
          value={m.terms}
          onChange={(e) => m.setTerms(e.target.value)}
          disabled={!m.editable}
        />
      </Field>
      <SearchTermsHelp monitor={m} />
      <button
        className="button"
        disabled={!m.editable || m.busy}
        onClick={() =>
          void m.run({
            kind: "configure",
            aircraftUuid: m.aircraftUuid,
            enabled: m.enabled,
            terms: termList(m.terms),
          })
        }
      >
        Save monitoring settings
      </button>
    </details>
  );
}

function KeySetupHelp() {
  return (
    <p>
      Checks use the shared FAA API key (status above; a system administrator
      requests it at{" "}
      <a href={FAA_DRS_KEY_URL} target="_blank" rel="noreferrer">
        the FAA DRS API page
      </a>{" "}
      and saves it in Settings → System). Daily checks run at{" "}
      {String(FAA_CHECK_HOUR_UTC).padStart(2, "0")}:00 UTC while the backend is
      running.
    </p>
  );
}

const termList = (terms: string) =>
  terms
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean);

function SearchTermsHelp({ monitor: m }: { monitor: FaaMonitor }) {
  return (
    <>
      <p>
        Aircraft and installed components are searched by model and product
        type. FAA search model overrides are used when set; part numbers are a
        fallback for components without models. Tracked AD numbers are checked
        separately. Add older manufacturer/model names and other relevant
        equipment identifiers here. Missing equipment data can lead to missed
        matches.
      </p>
      <p>
        Current search terms:{" "}
        {faaSearchTerms(m.state, m.aircraftUuid, termList(m.terms)).join(
          ", ",
        ) || "None"}
      </p>
    </>
  );
}

function CheckNowButton({ monitor: m }: { monitor: FaaMonitor }) {
  const running =
    !!m.saved.runId && Date.now() - (m.saved.lastAttempt ?? 0) < CHECK_RETRY_MS;
  return (
    <button
      className="button"
      disabled={!m.editable || m.busy || running || m.demo}
      onClick={() =>
        void m.run({ kind: "check", aircraftUuid: m.aircraftUuid })
      }
    >
      Check FAA now
    </button>
  );
}

function CandidateReview({
  monitor: m,
  candidate: c,
  onImport,
}: {
  monitor: FaaMonitor;
  candidate: FaaCandidate;
  onImport: (c: FaaCandidate) => void;
}) {
  const reason = m.reasons[c.id] ?? c.reviewReason;
  return (
    <details>
      <CandidateSummary candidate={c} />
      <button
        className="button small"
        disabled={!m.editable || m.busy}
        onClick={() => onImport(c)}
      >
        Review / import candidate
      </button>
      <ReviewReasonField monitor={m} candidate={c} reason={reason} />
      <button
        className="button small"
        disabled={!m.editable || m.busy || !reason.trim()}
        onClick={() =>
          void m.run({
            kind: "review",
            aircraftUuid: m.aircraftUuid,
            id: c.id,
            reason,
          })
        }
      >
        Record candidate review
      </button>
      {c.reviewReason && <p>{c.reviewReason}</p>}
    </details>
  );
}

function ReviewReasonField({
  monitor: m,
  candidate: c,
  reason,
}: {
  monitor: FaaMonitor;
  candidate: FaaCandidate;
  reason: string;
}) {
  return (
    <Field label={`Review reason for ${c.source.number}`}>
      <input
        value={reason}
        onChange={(e) => m.setReasons({ ...m.reasons, [c.id]: e.target.value })}
      />
    </Field>
  );
}

function CandidateSummary({ candidate: c }: { candidate: FaaCandidate }) {
  return (
    <>
      <summary>
        {c.emergency ? "EMERGENCY · " : ""}
        {c.source.number} · {c.status} ·{" "}
        {c.reviewReason ? "Reviewed" : "Needs review"}
      </summary>
      <p>{c.source.subject}</p>
      <p>
        {c.source.make} · {c.source.model} · Effective{" "}
        {c.source.effective || "see document"}
      </p>
      <a href={safeHref(c.source.url)} target="_blank" rel="noreferrer">
        Open FAA document
      </a>
      <p>{c.source.sourceNotes}</p>
    </>
  );
}
