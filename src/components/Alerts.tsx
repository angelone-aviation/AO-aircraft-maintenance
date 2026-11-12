/**
 * Responsibility: The alerts screen, the shell's alert bell and its unread
 *   count, with alerts marked read one at a time or all at once.
 * Layer: UI. Computes alerts from the workspace snapshot; read marks go
 *   through the alert-reads store.
 * Dependencies: react, @tanstack/react-router, @phosphor-icons/react,
 *   src/data/store.ts, src/data/alerts.ts (useAlertReads),
 *   src/domain/alerts.ts, src/domain/listSearch.ts, src/domain/model.ts
 *   (localDate), src/components/design.tsx, maintenance.css.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Bell, Check, Checks, Warning } from "@phosphor-icons/react";
import { useWorkspace } from "../data/store";
import { useAlertReads } from "../data/alerts";
import {
  ALERT_KINDS_SUMMARY,
  computeAlerts,
  severityLabels,
  type Alert,
  type AlertSeverity,
} from "../domain/alerts";
import { alertMatches } from "../domain/listSearch";
import { localDate } from "../domain/model";
import { EmptyState, PageHeader, SearchField, Toolbar } from "./design";
import "../styles/screens/maintenance.css";

// Most urgent first: the order the screen lists the groups in.
const SEVERITIES = ["danger", "warning", "info"] as const;
const SEVERITY_TONES = {
  danger: "danger",
  warning: "warning",
  info: "neutral",
} as const satisfies Record<AlertSeverity, string>;
const SEVERITY_ICONS = {
  danger: Warning,
  warning: Bell,
  info: Bell,
} as const satisfies Record<AlertSeverity, unknown>;
const ROW_ICON_SIZE = 20;
// Above this the badge reads "99+", keeping it to three characters.
const BADGE_MAX = 99;
const ACTION_ICON_SIZE = 18;

/**
 * The number of the user's current alerts not yet marked read, for the
 * shell's navigation badge.
 *
 * @returns The unread count.
 */
export function useUnreadAlertCount() {
  return useAlerts().unread;
}

/**
 * A link to the alerts screen whose badge shows the unread count. It reloads
 * the read marks whenever the user, program, backend or connection changes,
 * and forgets the marks of alerts that have cleared, so an alert that
 * returns (an aircraft grounded a second time) is unread again.
 *
 * @returns The bell link.
 */
export function AlertBell() {
  const { backend, connected, snapshot } = useWorkspace();
  const load = useAlertReads((x) => x.load);
  const forgetCleared = useAlertReads((x) => x.forgetCleared);
  const { alerts, unread, read } = useAlerts();
  const user = snapshot?.user.id;
  const program = snapshot?.activeProgramUuid;
  useEffect(() => {
    void load();
  }, [load, backend, connected, user, program]);
  useEffect(() => {
    void forgetCleared(alerts.map((a) => a.key));
  }, [forgetCleared, alerts, read]);
  return (
    <Link
      to="/alerts"
      className="icon-button alert-bell"
      aria-label={unread ? `Alerts, ${unread} unread` : "Alerts"}
    >
      <Bell size={22} aria-hidden="true" />
      {unread > 0 && (
        <span className="alert-count" aria-hidden="true">
          {unread > BADGE_MAX ? `${BADGE_MAX}+` : unread}
        </span>
      )}
    </Link>
  );
}

/**
 * The alerts screen: the user's current alerts grouped by severity, most
 * urgent first, each with a link to its screen, narrowed by a search of
 * title, detail and registration.
 *
 * @returns The screen. Marking read saves through the alert-reads store and
 *   shows its error, if any, above the groups. Mark all read covers every
 *   current alert, whatever the search shows.
 */
export function AlertsPage() {
  const alertView = useAlerts();
  const { alerts, unread } = alertView;
  const error = useAlertReads((x) => x.error);
  return (
    <div className="mx-alerts">
      <PageHeader
        eyebrow="ALERTS"
        title="What needs"
        accent="attention."
        description={ALERT_KINDS_SUMMARY}
        actions={
          <MarkAllReadButton
            keys={alerts.map((a) => a.key)}
            disabled={!unread}
          />
        }
      />
      <p className="mx-alerts-settings">
        <Link to="/settings" hash="alerts">
          Email and device alerts are in Settings
        </Link>
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <AlertList view={alertView} />
    </div>
  );
}

function AlertList({ view }: { view: ReturnType<typeof useAlerts> }) {
  const markRead = useAlertReads((x) => x.markRead);
  const [search, setSearch] = useState("");
  const { alerts, snapshot } = view;
  const shown = alerts.filter((a) => alertMatches(snapshot, a, search));
  return (
    <>
      {!!alerts.length && (
        <Toolbar>
          <SearchField
            label="Search alerts"
            placeholder="Alert, detail or aircraft"
            value={search}
            onChange={setSearch}
          />
        </Toolbar>
      )}
      <NoAlerts any={!!alerts.length} shown={!!shown.length} />
      {SEVERITIES.map((severity) => (
        <AlertGroup
          key={severity}
          severity={severity}
          rows={shown.filter((a) => a.severity === severity)}
          isRead={view.isRead}
          onMarkRead={(key) => void markRead([key])}
        />
      ))}
    </>
  );
}

function useAlerts() {
  const s = useWorkspace((x) => x.snapshot)!;
  const read = useAlertReads((x) => x.keys);
  const alerts = useMemo(() => computeAlerts(s, localDate()), [s]);
  const readSet = useMemo(() => new Set(read), [read]);
  return {
    snapshot: s,
    alerts,
    read,
    isRead: (key: string) => readSet.has(key),
    unread: alerts.filter((a) => !readSet.has(a.key)).length,
  };
}

function NoAlerts({ any, shown }: { any: boolean; shown: boolean }) {
  if (!any)
    return (
      <EmptyState title="No alerts">
        Nothing is due or awaiting review.
      </EmptyState>
    );
  if (shown) return null;
  return (
    <EmptyState title="No matching alerts">Try another search.</EmptyState>
  );
}

// Marks every current alert read and forgets marks on alerts no longer
// listed (convex/alerts.ts markRead).
function MarkAllReadButton({
  keys,
  disabled,
}: {
  keys: string[];
  disabled: boolean;
}) {
  const markRead = useAlertReads((x) => x.markRead);
  return (
    <button
      type="button"
      className="button"
      disabled={disabled}
      onClick={() => void markRead(keys, true)}
    >
      <Checks size={ACTION_ICON_SIZE} aria-hidden="true" />
      Mark all read
    </button>
  );
}

function AlertGroup({
  severity,
  rows,
  isRead,
  onMarkRead,
}: {
  severity: AlertSeverity;
  rows: Alert[];
  isRead: (key: string) => boolean;
  onMarkRead: (key: string) => void;
}) {
  if (!rows.length) return null;
  const headingId = `mx-alerts-${severity}`;
  return (
    <section
      className={
        "mx-alert-group ds-section mx-tone-" + SEVERITY_TONES[severity]
      }
      aria-labelledby={headingId}
    >
      <header className="ds-section-head">
        <h2 id={headingId}>{severityLabels[severity]}</h2>
        <span className="ds-section-note">
          {rows.length}
          <span className="sr-only"> alerts</span>
        </span>
      </header>
      <div className="ds-rows">
        {rows.map((a) => (
          <AlertRow
            key={a.key}
            alert={a}
            read={isRead(a.key)}
            onMarkRead={() => onMarkRead(a.key)}
          />
        ))}
      </div>
    </section>
  );
}

function AlertRow({
  alert: a,
  read,
  onMarkRead,
}: {
  alert: Alert;
  read: boolean;
  onMarkRead: () => void;
}) {
  const Icon = SEVERITY_ICONS[a.severity];
  return (
    <div className={"mx-alert-row ds-row" + (read ? " is-read" : "")}>
      <Icon className="mx-alert-icon" size={ROW_ICON_SIZE} aria-hidden="true" />
      <div className="mx-alert-text">
        <strong>
          <span className="sr-only">{read ? "Read: " : "Unread: "}</span>
          {a.title}
        </strong>
        <p>{a.detail}</p>
      </div>
      <div className="mx-alert-actions">
        <Link to={a.link} className="button small">
          Open
        </Link>
        {!read && <span className="mx-alert-unread" aria-hidden="true" />}
        {!read && (
          <button
            type="button"
            className="mx-alert-mark"
            aria-label={`Mark read: ${a.title}`}
            title="Mark read"
            onClick={onMarkRead}
          >
            <Check size={ACTION_ICON_SIZE} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
