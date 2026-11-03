import { useEffect, useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { Bell } from "@phosphor-icons/react";
import { useWorkspace } from "../data/store";
import { useAlertReads } from "../data/alerts";
import {
  computeAlerts,
  severityLabels,
  type AlertSeverity,
} from "../domain/alerts";
import { localDate } from "../domain/model";
import { EmptyState, PageHeader } from "./design";
import { Check, Checks } from "@phosphor-icons/react";
import "../styles/screens/maintenance.css";

const tones = {
  danger: "danger",
  warning: "warning",
  info: "neutral",
} as const satisfies Record<AlertSeverity, string>;

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

/** Unread alert count for the shell's navigation badge. */
export function useUnreadAlertCount() {
  return useAlerts().unread;
}

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
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  );
}

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
          <button
            type="button"
            className="button"
            disabled={!unread}
            onClick={() =>
              void markRead(
                alerts.map((a) => a.key),
                true,
              )
            }
          >
            <Checks size={18} aria-hidden="true" />
            Mark all read
          </button>
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
      {(["danger", "warning", "info"] as const).map((severity) => {
        const rows = alerts.filter((a) => a.severity === severity);
        if (!rows.length) return null;
        const headingId = `mx-alerts-${severity}`;
        return (
          <section
            className={"mx-alert-group mx-tone-" + tones[severity]}
            key={severity}
            aria-labelledby={headingId}
          >
            <header className="mx-alert-group-head">
              <h2 id={headingId}>{severityLabels[severity]}</h2>
              <span className="mx-alert-count">
                {rows.length}
                <span className="sr-only"> alerts</span>
              </span>
            </header>
            {rows.map((a) => {
              const read = isRead(a.key);
              return (
                <div
                  className={"mx-alert-row" + (read ? " is-read" : "")}
                  key={a.key}
                >
                  <span className="mx-alert-dot" aria-hidden="true" />
                  <div className="mx-alert-text">
                    <strong>
                      <span className="sr-only">
                        {read ? "Read: " : "Unread: "}
                      </span>
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
                        onClick={() => void markRead([a.key])}
                      >
                        <Check size={18} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
