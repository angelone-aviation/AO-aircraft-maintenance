/**
 * Responsibility: The alerts screen, the shell's alert bell and its unread
 *   count, with alerts marked read one at a time or all at once.
 * Layer: UI. Computes alerts from the workspace snapshot; read marks go
 *   through the alert-reads store.
 * Dependencies: react, @tanstack/react-router, @phosphor-icons/react,
 *   src/data/store.ts, src/data/alerts.ts (useAlertReads),
 *   src/domain/alerts.ts, src/domain/model.ts (localDate),
 *   src/components/design.tsx, maintenance.css.
 */
import { useEffect, useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { Bell, Check, Checks } from "@phosphor-icons/react";
import { useWorkspace } from "../data/store";
import { useAlertReads } from "../data/alerts";
import {
  computeAlerts,
  severityLabels,
  type Alert,
  type AlertSeverity,
} from "../domain/alerts";
import { localDate } from "../domain/model";
import { EmptyState, PageHeader } from "./design";
import "../styles/screens/maintenance.css";

// Most urgent first: the order the screen lists the groups in.
const SEVERITIES = ["danger", "warning", "info"] as const;
const SEVERITY_TONES = {
  danger: "danger",
  warning: "warning",
  info: "neutral",
} as const satisfies Record<AlertSeverity, string>;
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
 * the read marks whenever the user, program, backend or connection changes.
 *
 * @returns The bell link.
 */
export function AlertBell() {
  const { backend, connected, snapshot } = useWorkspace();
  const load = useAlertReads((x) => x.load);
  const { unread } = useAlerts();
  const user = snapshot?.user.id;
  const program = snapshot?.activeProgramUuid;
  useEffect(() => {
    void load();
  }, [load, backend, connected, user, program]);
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
 * urgent first, each with a link to its screen.
 *
 * @returns The screen. Marking read saves through the alert-reads store and
 *   shows its error, if any, above the groups.
 */
export function AlertsPage() {
  const { alerts, isRead, unread } = useAlerts();
  const { markRead, error } = useAlertReads();
  return (
    <div className="mx-alerts">
      <PageHeader
        eyebrow="ALERTS"
        title="What needs attention."
        description="Inspections, ADs, component limits, certificates and FAA documents for aircraft you can access."
        actions={
          <MarkAllReadButton
            keys={alerts.map((a) => a.key)}
            disabled={!unread}
          />
        }
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!alerts.length && (
        <EmptyState title="No alerts">
          Nothing is due or awaiting review.
        </EmptyState>
      )}
      {SEVERITIES.map((severity) => (
        <AlertGroup
          key={severity}
          severity={severity}
          rows={alerts.filter((a) => a.severity === severity)}
          isRead={isRead}
          onMarkRead={(key) => void markRead([key])}
        />
      ))}
    </div>
  );
}

function useAlerts() {
  const s = useWorkspace((x) => x.snapshot)!;
  const read = useAlertReads((x) => x.keys);
  const alerts = useMemo(() => computeAlerts(s, localDate()), [s]);
  const readSet = useMemo(() => new Set(read), [read]);
  return {
    alerts,
    isRead: (key: string) => readSet.has(key),
    unread: alerts.filter((a) => !readSet.has(a.key)).length,
  };
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
      className={"mx-alert-group mx-tone-" + SEVERITY_TONES[severity]}
      aria-labelledby={headingId}
    >
      <header className="mx-alert-group-head">
        <h2 id={headingId}>{severityLabels[severity]}</h2>
        <span className="mx-alert-count">
          {rows.length}
          <span className="sr-only"> alerts</span>
        </span>
      </header>
      {rows.map((a) => (
        <AlertRow
          key={a.key}
          alert={a}
          read={isRead(a.key)}
          onMarkRead={() => onMarkRead(a.key)}
        />
      ))}
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
  return (
    <div className={"mx-alert-row" + (read ? " is-read" : "")}>
      <span className="mx-alert-dot" aria-hidden="true" />
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
