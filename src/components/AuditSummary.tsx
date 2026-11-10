/**
 * Responsibility: The Weekly summary tab of Change history: a period picker,
 *   the per-actor table by action family, the notable events with links to
 *   their screens, and the CSV export.
 * Layer: UI. React components; the summary itself comes from the backend
 *   (src/domain/auditSummary on the server or in the demo).
 * Dependencies: react, @tanstack/react-router, @phosphor-icons/react,
 *   src/data/store.ts, src/domain (auditSummary, auditHistory, csv, model),
 *   ./design, ./ui.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Warning, WifiSlash } from "@phosphor-icons/react";
import { useWorkspace } from "../data/store";
import type { Backend } from "../data/backend";
import {
  auditSummaryCsvRows,
  FAMILY_LABELS,
  FAMILY_ORDER,
  summaryPeriod,
  withLocalBounds,
  type AuditSummaryResult,
  type NotableEvent,
  type NotableKind,
  type SummaryPeriod,
} from "../domain/auditSummary";
import { auditActionLabel } from "../domain/auditHistory";
import { toCsv } from "../domain/csv";
import { localDate, type Snapshot } from "../domain/model";
import {
  EmptyState,
  ListCard,
  ListRow,
  NoticeBar,
  Segmented,
  StatusPill,
  Toolbar,
  type Tone,
} from "./design";
import { download } from "./ui";

const CSV_TYPE = "text/csv;charset=utf-8";
type PeriodKind = "7d" | "30d" | "custom";
const PERIOD_OPTIONS: { value: PeriodKind; label: string }[] = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "custom", label: "Custom" },
];
const NOTABLE_LABELS: Record<NotableKind, { label: string; tone: Tone }> = {
  "dispatch-override": { label: "Dispatch override", tone: "danger" },
  "permission-change": { label: "Permission change", tone: "warn" },
  "account-change": { label: "Account change", tone: "warn" },
  archive: { label: "Archived or deleted", tone: "neutral" },
  correction: { label: "Correction", tone: "blue" },
};
// Where a notable entry's record lives, by its action type; records without
// a screen of their own stay unlinked.
const ROUTES_BY_TYPE: Record<string, string> = {
  flight: "/flights",
  discrepancy: "/discrepancies",
  plan: "/flight-plans",
  inspection: "/inspections",
  component: "/components",
  ad: "/airworthiness",
  taskCard: "/task-cards",
  workOrder: "/work-orders",
  stock: "/inventory",
  partsRequest: "/parts-requests",
  po: "/purchase-orders",
  user: "/admin",
  group: "/admin",
  program: "/programs",
  checklist: "/checklists",
  manual: "/manuals",
};

/**
 * The weekly summary of the active program's change log, for Flight Program
 * administrators: the last 7 days by default, the last 30 or a custom range,
 * in the reviewer's own days; one row per actor with counts per action
 * family; the notable events (dispatch overrides, permission and account
 * changes, archives, corrections with their reasons) linked to their
 * screens; refused sign-ins as a count where the reader sees them (a system
 * administrator in Unassigned records); and a CSV of the table.
 *
 * @returns The tab. Offline it says the summary needs a connection.
 */
export function WeeklySummary() {
  const { snapshot, backend, online, connected } = useWorkspace();
  const s = snapshot!;
  const [kind, setKind] = useState<PeriodKind>("7d");
  const [custom, setCustom] = useState<SummaryPeriod>(() =>
    summaryPeriod("7d", localDate()),
  );
  const period = kind === "custom" ? custom : summaryPeriod(kind, localDate());
  const live = !!backend && online && connected;
  const { result, error, loading } = useSummary(backend, live, period);
  return (
    <>
      <SummaryToolbar
        kind={kind}
        onKind={setKind}
        custom={custom}
        onCustom={setCustom}
        onExport={result && (() => exportCsv(s, result, period))}
      />
      {!live && (
        <NoticeBar tone="warn" icon={WifiSlash}>
          The weekly summary needs a connection.
        </NoticeBar>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading && <p role="status">Loading summary…</p>}
      {result && <SummaryBody s={s} result={result} />}
    </>
  );
}

function SummaryToolbar({
  kind,
  onKind,
  custom,
  onCustom,
  onExport,
}: {
  kind: PeriodKind;
  onKind: (kind: PeriodKind) => void;
  custom: SummaryPeriod;
  onCustom: (period: SummaryPeriod) => void;
  /** Absent until a summary has loaded. */
  onExport?: () => void;
}) {
  return (
    <Toolbar className="rise">
      <Segmented
        label="Summary period"
        options={PERIOD_OPTIONS}
        value={kind}
        onChange={(value) => onKind(value as PeriodKind)}
      />
      {kind === "custom" && (
        <CustomPeriod period={custom} onChange={onCustom} />
      )}
      {onExport && (
        <button type="button" className="button small" onClick={onExport}>
          Export CSV
        </button>
      )}
    </Toolbar>
  );
}

// State is written only after the backend answers, and only for the newest
// request; "loading" is the gap between the period asked for and the one
// answered, so nothing is set while rendering.
function useSummary(
  backend: Backend | null,
  live: boolean,
  { from, to }: SummaryPeriod,
) {
  const { answer, load } = useSummaryLoader(backend, from, to);
  useEffect(() => {
    if (live) void load();
  }, [live, load]);
  const current =
    answer && answer.period.from === from && answer.period.to === to;
  return {
    result: current ? answer.result : undefined,
    error: current ? answer.error : "",
    loading: live && !current,
  };
}

function useSummaryLoader(backend: Backend | null, from: string, to: string) {
  const [answer, setAnswer] = useState<Answer>();
  const request = useRef(0);
  const load = useCallback(async () => {
    if (!backend) return;
    const id = ++request.current;
    const period = { from, to };
    try {
      // The reviewer's own days, not the server's: "Last 7 days" in the
      // evening west of UTC includes that evening.
      const result = await backend.auditSummary(withLocalBounds(period));
      if (id === request.current) setAnswer({ period, result, error: "" });
    } catch (e) {
      if (id === request.current)
        setAnswer({ period, error: describeLoadError(e) });
    }
  }, [backend, from, to]);
  return { answer, load };
}

/** The backend's answer to one period: a result, or the failure message. */
type Answer = {
  period: SummaryPeriod;
  result?: AuditSummaryResult;
  error: string;
};

function describeLoadError(e: unknown): string {
  return e instanceof Error ? e.message : "Could not load the summary.";
}

function CustomPeriod({
  period,
  onChange,
}: {
  period: SummaryPeriod;
  onChange: (period: SummaryPeriod) => void;
}) {
  const fromId = useId();
  const toId = useId();
  return (
    <div className="rec-period">
      <label htmlFor={fromId}>From</label>
      <input
        id={fromId}
        type="date"
        value={period.from}
        max={period.to}
        onChange={(e) => onChange({ ...period, from: e.target.value })}
      />
      <label htmlFor={toId}>To</label>
      <input
        id={toId}
        type="date"
        value={period.to}
        min={period.from}
        onChange={(e) => onChange({ ...period, to: e.target.value })}
      />
    </div>
  );
}

function SummaryBody({
  s,
  result: { summary, truncated, accountWide },
}: {
  s: Snapshot;
  result: AuditSummaryResult;
}) {
  return (
    <>
      {truncated && (
        <NoticeBar tone="warn" icon={Warning} role="status">
          The period has more entries than one summary reads. Older entries in
          it are not counted; choose a shorter period.
        </NoticeBar>
      )}
      <p className="muted">
        {summary.period.from} to {summary.period.to}: {summary.total}{" "}
        {summary.total === 1 ? "entry" : "entries"}
        {accountWide &&
          ` · ${summary.refusedSignIns} refused sign-in${summary.refusedSignIns === 1 ? "" : "s"}`}
      </p>
      {!accountWide && (
        <p className="muted">
          Refused sign-ins, password resets, ended sessions and permissions set
          by a system administrator belong to no Flight Program. System
          administrators review them under Unassigned records.
        </p>
      )}
      <ActorTable s={s} summary={summary} />
      <NotableList s={s} events={summary.notable} />
    </>
  );
}

function ActorTable({
  s,
  summary,
}: {
  s: Snapshot;
  summary: AuditSummaryResult["summary"];
}) {
  if (!summary.actors.length)
    return (
      <EmptyState title="No changes in this period">
        Entries recorded in the period will be counted here by who made them.
      </EmptyState>
    );
  return (
    <div className="rec-table-card">
      <div className="rec-table-scroll">
        <table className="rec-table rec-summary-table">
          <caption className="rec-cap">Changes by person</caption>
          <thead>
            <tr>
              <th scope="col">Person</th>
              {FAMILY_ORDER.map((f) => (
                <th key={f} scope="col" className="rec-num">
                  {FAMILY_LABELS[f]}
                </th>
              ))}
              <th scope="col" className="rec-num">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {summary.actors.map((actor) => (
              <ActorRow key={actor.actorId} s={s} actor={actor} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ActorRow({
  s,
  actor,
}: {
  s: Snapshot;
  actor: AuditSummaryResult["summary"]["actors"][number];
}) {
  return (
    <tr>
      <th scope="row">{actorName(s, actor.actorId)}</th>
      {FAMILY_ORDER.map((f) => (
        <td key={f} className="rec-num">
          {actor.counts[f] || ""}
        </td>
      ))}
      <td className="rec-num">
        <strong>{actor.total}</strong>
      </td>
    </tr>
  );
}

function NotableList({ s, events }: { s: Snapshot; events: NotableEvent[] }) {
  return (
    <ListCard title="Notable events" className="rec-list-card">
      {events.map((event) => (
        <NotableRow key={event.uuid} s={s} event={event} />
      ))}
      {!events.length && (
        <EmptyState title="Nothing notable">
          No dispatch override, permission or account change, archive or
          correction in this period.
        </EmptyState>
      )}
    </ListCard>
  );
}

function NotableRow({ s, event }: { s: Snapshot; event: NotableEvent }) {
  const look = NOTABLE_LABELS[event.kind];
  const registration =
    event.aircraftUuid &&
    (s.aircraft.find((a) => a.uuid === event.aircraftUuid)?.registration ??
      event.aircraftUuid);
  const to = ROUTES_BY_TYPE[event.action.split(".")[0]];
  return (
    <ListRow
      title={auditActionLabel(event.action)}
      sub={
        <>
          {actorName(s, event.actorId)}
          {registration && ` · ${registration}`}
          {event.reason && ` · ${event.reason}`}
        </>
      }
      meta={new Date(event.at).toLocaleString()}
      badge={<StatusPill tone={look.tone}>{look.label}</StatusPill>}
      action={
        to && (
          // ROUTES_BY_TYPE lists route paths the router registers; the
          // router's Link type cannot see through the lookup table.
          <Link to={to as "/flights"} className="button small">
            Open
          </Link>
        )
      }
    />
  );
}

function actorName(s: Snapshot, actorId: string) {
  if (actorId === "system") return "System";
  return s.members.find((m) => m.id === actorId)?.name ?? "User";
}

function exportCsv(s: Snapshot, result: AuditSummaryResult, p: SummaryPeriod) {
  const rows = auditSummaryCsvRows(
    result.summary,
    (id) => actorName(s, id),
    result.accountWide,
  );
  download(`change-summary-${p.from}-to-${p.to}.csv`, toCsv(rows), CSV_TYPE);
}
