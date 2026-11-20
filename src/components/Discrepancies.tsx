/**
 * Responsibility: The Discrepancies screen: problem reports, their summary,
 *   search and filter, and the report, defer and resolve dialogs.
 * Layer: UI. A screen over the workspace snapshot; holds no business rules.
 * Dependencies: src/data (store, historyPages), src/domain (model,
 *   deferrals, discrepancyList, pilotView, retention), ./design, ./ui,
 *   ./TermTip, ./recordDates, ./HistoryPager, and the deferral, parts, job
 *   card and work order components.
 */
import "../styles/screens/discrepancies.css";
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  CaretDown,
  Check,
  CheckCircle,
  ClockCountdown,
  Warning,
  WarningCircle,
  Wrench,
  XCircle,
} from "@phosphor-icons/react";
import { useWorkspace, type Workspace } from "../data/store";
import { useHistoryPages, withHistory } from "../data/historyPages";
import { historyWindowMonths } from "../domain/retention";
import { MAX_RESOLUTION_LENGTH } from "../domain/deferrals";
import {
  discrepancyCounts,
  listedReports,
  reportStanding,
  reportWorkOrders,
  type DiscrepancyCounts,
  type ReportFilters,
  type ReportStanding,
} from "../domain/discrepancyList";
import {
  can,
  localDate,
  NOTE_MAX_LENGTH,
  type Aircraft,
  type Discrepancy,
  type Snapshot,
} from "../domain/model";
import { isPilotView } from "../domain/pilotView";
import { DeferralStatus, DeferDiscrepancyForm } from "./Deferrals";
import {
  Dialog,
  EmptyState,
  PageHeader,
  SearchField,
  Segmented,
  StatTile,
  StatsStrip,
  StatusPill,
  Toolbar,
  type IconType,
  useBreakpoint,
  type Tone,
} from "./design";
import { RequestPartsButton } from "./PartsRequests";
import { dateTime, shortDate } from "./recordDates";
import { DiscrepancyParts } from "./RequiredParts";
import { HistoryPager } from "./HistoryPager";
import { LinkedTaskCards } from "./TaskCards";
import { TermTip } from "./TermTip";
import { AsyncForm, Field, value } from "./ui";
import { AddToWorkOrder } from "./WorkOrders";

type ReportProps = { s: Snapshot; report: Discrepancy };
type QueuedEntry = Workspace["queue"][number];
type ReportDraft = Pick<
  Extract<QueuedEntry["operation"], { kind: "discrepancy" }>,
  "aircraftUuid" | "description" | "grounding"
>;
interface ReportActions {
  disabled: boolean;
  onDefer: (uuid: string) => void;
  onResolve: (uuid: string) => void;
}
/** What one report row needs beyond the report itself. */
interface RowContext {
  s: Snapshot;
  today: string;
  pilotView: boolean;
  /** Folds the secondary tools under "More actions". */
  phone: boolean;
  actions: ReportActions;
}

const STANDING_PILLS: Record<
  ReportStanding,
  { tone: Tone; icon: IconType; label: string }
> = {
  open: { tone: "warn", icon: WarningCircle, label: "Open" },
  grounding: { tone: "danger", icon: XCircle, label: "Grounds aircraft" },
  deferred: { tone: "warn", icon: ClockCountdown, label: "Deferred" },
  expired: { tone: "danger", icon: XCircle, label: "Deferral expired" },
  resolved: { tone: "good", icon: CheckCircle, label: "Resolved" },
};
const SHOW_OPEN = "open";
const SHOW_ALL = "all";

/**
 * Discrepancy reports, newest first: the open ones, or all of them, narrowed
 * by a search of registration, description, resolution and reporter, under
 * counts of every open, grounding, deferred and this month's resolved report.
 *
 * @returns One card of report rows, restacked on a phone. Under All, Load
 *   older adds the resolved reports the workspace's window leaves out, and
 *   the total reads "in the last 3 months" (H3): the counts cover the
 *   workspace, not the older reports loaded. Reporting a problem queues it
 *   on this device, so it works offline; deferring and recording a
 *   resolution need a connection and the resolve permission. Pilot view
 *   leaves out the parts, job card and work order tools.
 */
export function Discrepancies() {
  const { snapshot: workspace, online, connected } = useWorkspace();
  const older = useReportHistory(workspace!);
  const s = older.s;
  const [adding, setAdding] = useState(false),
    [resolve, setResolve] = useState<string | null>(null),
    [defer, setDefer] = useState<string | null>(null),
    [showResolved, setShowResolved] = useState(false),
    [search, setSearch] = useState("");
  const available = s.aircraft.filter((a) => can(s, a.uuid, "discrepancy"));
  const actions = {
    disabled: !online || !connected,
    onDefer: setDefer,
    onResolve: setResolve,
  };
  return (
    <>
      <DiscrepancyHeader
        canReport={!!available.length}
        onReport={() => setAdding(true)}
      />
      <DiscrepancyFilters
        s={workspace!}
        filters={{ search, showResolved }}
        onSearch={setSearch}
        onShowResolved={setShowResolved}
      />
      <ReportList s={s} filters={{ search, showResolved }} actions={actions} />
      {showResolved && <OlderReports older={older} />}
      {adding && (
        <ReportDialog aircraft={available} onClose={() => setAdding(false)} />
      )}
      {defer && <DeferDialog uuid={defer} onClose={() => setDefer(null)} />}
      {resolve && (
        <ResolveDialog uuid={resolve} onClose={() => setResolve(null)} />
      )}
    </>
  );
}

// The workspace with the older reports loaded; every older report is
// resolved, so only All lists them.
function useReportHistory(workspace: Snapshot) {
  const pages = useHistoryPages({ kind: "discrepancies" });
  const s = useMemo(
    () => withHistory(workspace, { ...pages.records, members: pages.members }),
    [workspace, pages.records, pages.members],
  );
  return { s, pages, total: workspace.discrepancies.length };
}

// H3: the total counts the workspace, which keeps the last 3 months.
function OlderReports({
  older,
}: {
  older: ReturnType<typeof useReportHistory>;
}) {
  const { s, pages, total } = older;
  const loaded = s.discrepancies.length - total;
  const months = historyWindowMonths("discrepancies");
  const reports = total === 1 ? "report" : "reports";
  return (
    <HistoryPager
      pages={pages}
      summary={`${total} ${reports} in the last ${months} months${loaded ? ` and ${loaded} older` : ""}`}
    />
  );
}

/**
 * The dialog that reports a problem: aircraft, what was observed, and whether
 * it grounds the aircraft. Saving queues the report on this device, so it
 * works offline and syncs when connected.
 *
 * @param props.aircraft - The aircraft the user may report on.
 * @param props.initial - Prefills the fields (Edit and retry).
 * @param props.replaces - The failed outbox entry the new report replaces.
 */
export function ReportDialog({
  aircraft,
  initial,
  replaces,
  onClose,
}: {
  aircraft: Aircraft[];
  initial?: ReportDraft;
  replaces?: string;
  onClose: () => void;
}) {
  const { snapshot: s, online, enqueue, replace } = useWorkspace();
  return (
    <Dialog
      className="disc-dialog"
      size="narrow"
      title={replaces ? "Edit and retry report" : "Report a problem"}
      dismissOnScrim={false}
      onClose={onClose}
    >
      <AsyncForm
        submitLabel="Save report"
        onSubmit={async (data) => {
          const report = reportOperation(s!, data);
          if (replaces) await replace(replaces, report);
          else await enqueue(report);
          onClose();
        }}
      >
        <ReportFields aircraft={aircraft} initial={initial} />
        {!online && (
          <p className="callout">
            This report will be saved on this device and synced when connected.
          </p>
        )}
      </AsyncForm>
    </Dialog>
  );
}

function DiscrepancyHeader({
  canReport,
  onReport,
}: {
  canReport: boolean;
  onReport: () => void;
}) {
  return (
    <PageHeader
      eyebrow="MAINTENANCE REPORTS"
      title="Discrepancies"
      accent="and write-ups."
      description="Report a problem from the air or on the ground. Keep the resolution on record."
      actions={
        canReport && (
          <button type="button" className="button primary" onClick={onReport}>
            <Warning size={18} weight="bold" aria-hidden="true" /> Report a
            problem
          </button>
        )
      }
    />
  );
}

// The figures cover every report in the program, whatever the search and
// filter below them show.
function DiscrepancyFilters({
  s,
  filters,
  onSearch,
  onShowResolved,
}: {
  s: Snapshot;
  filters: ReportFilters;
  onSearch: (search: string) => void;
  onShowResolved: (show: boolean) => void;
}) {
  const counts = discrepancyCounts(s.discrepancies, localDate());
  return (
    <>
      <DiscrepancySummary counts={counts} />
      <Toolbar
        className="disc-toolbar"
        end={
          <Segmented
            label="Show"
            value={filters.showResolved ? SHOW_ALL : SHOW_OPEN}
            onChange={(show) => onShowResolved(show === SHOW_ALL)}
            options={[
              { value: SHOW_OPEN, label: "Open", count: counts.open },
              { value: SHOW_ALL, label: "All", count: counts.total },
            ]}
          />
        }
      >
        <SearchField
          className="disc-search"
          label="Search reports"
          placeholder="Aircraft, description, resolution or reporter"
          value={filters.search}
          onChange={onSearch}
        />
      </Toolbar>
    </>
  );
}

function DiscrepancySummary({ counts }: { counts: DiscrepancyCounts }) {
  return (
    <StatsStrip className="disc-stats">
      <Figure icon={WarningCircle} tone="warn" value={counts.open}>
        Open
      </Figure>
      <Figure icon={XCircle} tone="danger" value={counts.grounding}>
        Grounding
      </Figure>
      <Figure icon={ClockCountdown} tone="warn" value={counts.deferred}>
        <TermTip term="deferral">Deferred</TermTip>
      </Figure>
      <Figure icon={CheckCircle} tone="good" value={counts.resolvedThisMonth}>
        Resolved this month
      </Figure>
    </StatsStrip>
  );
}

// A summary figure; its icon takes the status colour beside its word.
function Figure({
  icon: Icon,
  tone,
  value,
  children,
}: {
  icon: IconType;
  tone: "warn" | "danger" | "good";
  value: number;
  children: ReactNode;
}) {
  const label = (
    <span className={`disc-stat-label is-${tone}`}>
      <Icon size={16} aria-hidden="true" />
      {children}
    </span>
  );
  return <StatTile label={label} value={value} />;
}

function ReportList({
  s,
  filters,
  actions,
}: {
  s: Snapshot;
  filters: ReportFilters;
  actions: ReportActions;
}) {
  const { reports, anyListed } = listedReports(s, filters);
  const phone = useBreakpoint() === "phone";
  if (!reports.length) return <NoReports anyListed={anyListed} />;
  const row = {
    s,
    today: localDate(),
    pilotView: isPilotView(s),
    phone,
    actions,
  };
  return (
    <div className="ds-rows disc-reports">
      <div className="ds-row ds-row-head disc-head" aria-hidden="true">
        <span>Problem</span>
        <span>Reported</span>
        <span>Status</span>
      </div>
      {reports.map((d) => (
        <ReportRow key={d.uuid} row={row} report={d} />
      ))}
    </div>
  );
}

function NoReports({ anyListed }: { anyListed: boolean }) {
  if (anyListed)
    return (
      <EmptyState title="No matching reports">Try another search.</EmptyState>
    );
  return (
    <EmptyState title="No open reports">
      New discrepancies will appear here.
    </EmptyState>
  );
}

// One report: its line (problem, reporter, status, the one primary action),
// then what it carries (deferral, resolution, parts, work orders) and the
// secondary tools. CSS grid areas place them per screen width.
function ReportRow({
  row,
  report: d,
}: {
  row: RowContext;
  report: Discrepancy;
}) {
  const { s, today, pilotView, actions } = row;
  const standing = reportStanding(d, today);
  const resolvable = d.status === "open" && can(s, d.aircraftUuid, "resolve");
  return (
    <article className={`ds-row disc-report is-${standing}`}>
      <ReportProblem s={s} report={d} />
      <ReportedBy s={s} report={d} />
      <ReportStatus report={d} standing={standing} />
      {resolvable && (
        <div className="disc-primary">
          <button
            type="button"
            className="button small primary"
            disabled={actions.disabled}
            onClick={() => actions.onResolve(d.uuid)}
          >
            <Check size={16} weight="bold" aria-hidden="true" /> Record
            resolution
          </button>
        </div>
      )}
      <ReportDetails s={s} report={d} pilotView={pilotView} />
      <ReportTools report={d} canDefer={resolvable && !d.deferral} row={row} />
    </article>
  );
}

function ReportProblem({ s, report: d }: ReportProps) {
  return (
    <div className="disc-problem">
      <p className="disc-text">{d.description}</p>
      <small>
        {s.aircraft.find((a) => a.uuid === d.aircraftUuid)?.registration}
        {" · "}
        {d.flightUuid ? "Linked to a flight" : "Ground / standalone report"}
      </small>
    </div>
  );
}

// "Reported by" is hidden on wide screens, where the column says it, but
// stays for screen readers because the column header is hidden from them.
function ReportedBy({ s, report: d }: ReportProps) {
  const reporter = s.members.find((m) => m.id === d.authorId)?.name;
  return (
    <div className="disc-by">
      {reporter ? (
        <>
          <span className="disc-by-label">Reported by </span>
          <span className="disc-by-name">{reporter}</span>
        </>
      ) : (
        "Reported"
      )}
      <small>{shortDate(d.createdAt)}</small>
    </div>
  );
}

function ReportStatus({
  report: d,
  standing,
}: {
  report: Discrepancy;
  standing: ReportStanding;
}) {
  const pill = STANDING_PILLS[standing];
  const expiry = d.status === "open" && d.deferral && expiryNote(d.deferral);
  return (
    <div className="disc-status">
      <StatusPill tone={pill.tone} icon={pill.icon}>
        {pill.label}
      </StatusPill>
      {expiry && <small>{expiry}</small>}
    </div>
  );
}

function expiryNote(deferral: NonNullable<Discrepancy["deferral"]>) {
  return deferral.expiresOn ? `Expires ${deferral.expiresOn}` : "No expiry";
}

function ReportDetails({
  s,
  report: d,
  pilotView,
}: ReportProps & { pilotView: boolean }) {
  const orders = pilotView ? [] : reportWorkOrders(s, d.uuid);
  if (!d.deferral && !d.resolution && pilotView) return null;
  return (
    <div className="disc-details">
      {d.deferral && (
        <div className="disc-note disc-deferral">
          <DeferralStatus report={d} />
        </div>
      )}
      {d.resolution && <ResolutionNote s={s} report={d} />}
      {!pilotView && <DiscrepancyParts report={d} />}
      {orders.length > 0 && (
        <p className="disc-links">
          <Wrench size={16} aria-hidden="true" />
          {orders.map((w) => (
            <Link key={w.uuid} to="/work-orders" className="ds-link">
              Work order {w.number || w.dateOpened}
            </Link>
          ))}
        </p>
      )}
    </div>
  );
}

function ResolutionNote({ s, report: d }: ReportProps) {
  return (
    <div className="disc-note disc-resolution">
      <strong className="disc-note-label">
        <CheckCircle size={16} aria-hidden="true" />
        Resolution
      </strong>
      <p>{d.resolution}</p>
      <small>
        {s.members.find((m) => m.id === d.resolvedBy)?.name ??
          "Maintenance user"}{" "}
        · {dateTime(d.resolvedAt!)}
      </small>
    </div>
  );
}

// Secondary actions: quiet buttons in one wrapping row, so the row keeps a
// single primary button. On a phone they fold under "More actions"; the
// disclosure stays open while one of their dialogs is open.
function ReportTools(props: {
  report: Discrepancy;
  canDefer: boolean;
  row: RowContext;
}) {
  if (!props.canDefer && props.row.pilotView) return null;
  if (!props.row.phone) return <ToolButtons {...props} />;
  return (
    <details className="disc-more">
      <summary>
        More actions <CaretDown size={16} aria-hidden="true" />
      </summary>
      <ToolButtons {...props} />
    </details>
  );
}

function ToolButtons({
  report: d,
  canDefer,
  row: { pilotView, actions },
}: {
  report: Discrepancy;
  canDefer: boolean;
  row: RowContext;
}) {
  const link = { kind: "discrepancy", uuid: d.uuid } as const;
  return (
    <div className="disc-tools">
      {canDefer && (
        <button
          type="button"
          className="button small"
          disabled={actions.disabled}
          onClick={() => actions.onDefer(d.uuid)}
        >
          <ClockCountdown size={16} aria-hidden="true" /> Defer (MEL / 91.213)
        </button>
      )}
      {!pilotView && (
        <>
          <RequestPartsButton source={{ ...link, workOrderUuid: "" }} />
          <LinkedTaskCards aircraftUuid={d.aircraftUuid} link={link} />
          {d.status === "open" && (
            <AddToWorkOrder aircraftUuid={d.aircraftUuid} source={link} />
          )}
        </>
      )}
    </div>
  );
}

function reportOperation(s: Snapshot, data: FormData) {
  return {
    kind: "discrepancy" as const,
    uuid: crypto.randomUUID(),
    authorId: s.user.id,
    aircraftUuid: value(data, "aircraft"),
    description: value(data, "description"),
    grounding: data.get("grounding") === "on",
  };
}

function ReportFields({
  aircraft,
  initial,
}: {
  aircraft: Aircraft[];
  initial?: ReportDraft;
}) {
  return (
    <>
      <Field label="Aircraft">
        <select name="aircraft" defaultValue={initial?.aircraftUuid}>
          {aircraft.map((a) => (
            <option key={a.uuid} value={a.uuid}>
              {a.registration}
            </option>
          ))}
        </select>
      </Field>
      <Field label="What did you observe?">
        <textarea
          name="description"
          rows={5}
          maxLength={NOTE_MAX_LENGTH}
          required
          defaultValue={initial?.description}
          placeholder="Describe the problem and where you noticed it."
        />
      </Field>
      <label className="checkbox">
        <input
          type="checkbox"
          name="grounding"
          defaultChecked={initial?.grounding}
        />{" "}
        Aircraft not airworthy until resolved
      </label>
    </>
  );
}

function DeferDialog({ uuid, onClose }: { uuid: string; onClose: () => void }) {
  return (
    <Dialog
      className="disc-dialog"
      title="Defer discrepancy"
      dismissOnScrim={false}
      onClose={onClose}
    >
      <p className="term-tip-line">
        Defer under an <TermTip term="mel" /> item or 14 CFR 91.213(d).
      </p>
      <DeferDiscrepancyForm uuid={uuid} onDone={onClose} />
    </Dialog>
  );
}

function ResolveDialog({
  uuid,
  onClose,
}: {
  uuid: string;
  onClose: () => void;
}) {
  const { backend, online, connected } = useWorkspace();
  return (
    <Dialog
      className="disc-dialog"
      size="narrow"
      title="Record maintenance resolution"
      dismissOnScrim={false}
      onClose={onClose}
    >
      <AsyncForm
        submitLabel="Mark resolved"
        disabled={!online || !connected}
        onSubmit={async (data) => {
          await backend!.resolve(uuid, value(data, "resolution"));
          onClose();
        }}
      >
        <Field label="What fixed the problem?">
          <textarea
            name="resolution"
            rows={5}
            maxLength={MAX_RESOLUTION_LENGTH}
            required
          />
        </Field>
        <p className="muted">
          Your name, the time, and this explanation will remain in the history.
        </p>
      </AsyncForm>
    </Dialog>
  );
}
