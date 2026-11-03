import { aircraftStatus } from "./aircraftStatus";
import { adAircraftUuid, adStatus, adTaskStatus } from "./airworthiness";
import { certificationLabels, normalizeCertifications } from "./certifications";
import { requirementDueDate, requirementStatus } from "./components";
import { monitoringReviewCandidates } from "./faaCandidateReview";
import { inspectionDueDate, inspectionStatus } from "./maintenance";
import { inspectionCounters } from "./management";
import { can, type Group, type Member, type Snapshot } from "./model";

// Extend these unions as new alert sources are added.
export type AlertKind =
  | "inspection-due-soon"
  | "inspection-overdue"
  | "ad-due-soon"
  | "ad-overdue"
  | "component-due-soon"
  | "component-past-due"
  | "certificate-expiring"
  | "certificate-expired"
  | "faa-ad-review"
  | "aircraft-grounded";
export type AlertSeverity = "info" | "warning" | "danger";
export type AlertLink = "/" | "/inspections" | "/airworthiness" | "/components";
export interface Alert {
  // Changes whenever the alert's substance (kind, entity, due point) changes.
  key: string;
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  detail: string;
  aircraftUuid?: string;
  entityUuid: string;
  dueDate?: string;
  link: AlertLink;
}
export const severityLabels: Record<AlertSeverity, string> = {
  danger: "Action required",
  warning: "Coming due",
  info: "For review",
};
const severityRank: Record<AlertSeverity, number> = {
  danger: 0,
  warning: 1,
  info: 2,
};
export const CERTIFICATE_WARNING_DAYS = 30;
const SKIPPED_AD_STATUSES = [
  "Not applicable",
  "Superseded",
  "Removed component",
  "Previously Complied With (PCW)",
];
const alertKey = (kind: AlertKind, ...parts: unknown[]) =>
  [kind, ...parts.map((p) => (p === undefined || p === null ? "" : p))].join(
    "|",
  );
// FNV-1a; keeps keys short when they summarize a set of documents.
function hash(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++)
    h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}
const days = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
const amount = (n: number, unit: string) =>
  n < 0
    ? `${Math.abs(n).toFixed(1).replace(/\.0$/, "")} ${unit} over`
    : `${n.toFixed(1).replace(/\.0$/, "")} ${unit} remaining`;
const joinDetail = (...parts: (string | false | undefined)[]) =>
  parts.filter(Boolean).join(" · ");

function inspectionAlerts(s: Snapshot, today: string): Alert[] {
  return s.inspections.flatMap((i): Alert[] => {
    const a = s.aircraft.find((a) => a.uuid === i.aircraftUuid);
    if (i.archived || !a || !can(s, a.uuid, "read")) return [];
    let status;
    try {
      status = inspectionStatus(
        i,
        a,
        today,
        inspectionCounters(i, a, s.management),
      );
    } catch {
      return []; // Missing component or counters: the schedule page shows it.
    }
    if (status.status !== "overdue" && status.status !== "due-soon") return [];
    const overdue = status.status === "overdue";
    const kind = overdue ? "inspection-overdue" : "inspection-due-soon";
    const dueDate = inspectionDueDate(i);
    return [
      {
        key: alertKey(
          kind,
          i.uuid,
          dueDate,
          i.dueSeconds,
          i.dueCycles,
          i.dueLandings,
        ),
        kind,
        severity: overdue ? "danger" : "warning",
        title: `Inspection ${overdue ? "overdue" : "due soon"}: ${i.reference || i.description}`,
        detail: joinDetail(
          a.registration,
          i.description,
          dueDate && `due ${dueDate}`,
          status.hoursRemaining !== undefined &&
            amount(status.hoursRemaining, "h"),
          status.cyclesRemaining !== undefined &&
            amount(status.cyclesRemaining, "cycles"),
          status.landingsRemaining !== undefined &&
            amount(status.landingsRemaining, "landings"),
        ),
        aircraftUuid: a.uuid,
        entityUuid: i.uuid,
        dueDate,
        link: "/inspections",
      },
    ];
  });
}

function adAlerts(s: Snapshot, today: string): Alert[] {
  return (s.airworthiness ?? []).flatMap((r): Alert[] => {
    const aircraftUuid = adAircraftUuid(s, r);
    const a = s.aircraft.find((a) => a.uuid === aircraftUuid);
    if (!a || !can(s, a.uuid, "read")) return [];
    if (SKIPPED_AD_STATUSES.includes(adStatus(s, r))) return [];
    return r.tasks.flatMap((t): Alert[] => {
      const status = adTaskStatus(s, r, t, today);
      if (status !== "Overdue" && status !== "Due soon") return [];
      const overdue = status === "Overdue";
      const kind = overdue ? "ad-overdue" : "ad-due-soon";
      return [
        {
          key: alertKey(
            kind,
            r.uuid,
            t.uuid,
            t.dueDate,
            t.dueHours,
            t.dueCycles,
            t.dueLandings,
          ),
          kind,
          severity: overdue ? "danger" : "warning",
          title: `AD ${r.source.number} ${overdue ? "overdue" : "due soon"}`,
          detail: joinDetail(
            a.registration,
            t.description.slice(0, 200),
            t.dueDate && `due ${t.dueDate}`,
            t.dueHours !== null && `due at ${t.dueHours} h`,
            t.dueCycles !== null && `due at ${t.dueCycles} cycles`,
          ),
          aircraftUuid: a.uuid,
          entityUuid: r.uuid,
          dueDate: t.dueDate || undefined,
          link: "/airworthiness",
        },
      ];
    });
  });
}

function componentAlerts(s: Snapshot, today: string): Alert[] {
  const records = s.management ?? [];
  return records.flatMap((r): Alert[] => {
    if (r.kind !== "componentRequirement") return [];
    const c = records.find(
      (c) => c.kind === "component" && c.uuid === r.componentUuid,
    );
    if (c?.kind !== "component" || !c.installed) return [];
    const a = s.aircraft.find((a) => a.uuid === c.aircraftUuid);
    if (!a || !can(s, a.uuid, "read")) return [];
    let status;
    try {
      status = requirementStatus(r, c, a, today).status;
    } catch {
      return [];
    }
    const pastDue = status === "Past due" || status === "Due now";
    if (!pastDue && status !== "Due soon") return [];
    const kind = pastDue ? "component-past-due" : "component-due-soon";
    const dueDate = requirementDueDate(r);
    return [
      {
        key: alertKey(
          kind,
          r.uuid,
          dueDate,
          r.dueSeconds,
          r.dueCycles,
          r.dueLandings,
        ),
        kind,
        severity: pastDue ? "danger" : "warning",
        title: `Component ${status.toLowerCase()}: ${c.componentType}`,
        detail: joinDetail(
          a.registration,
          [c.partNumber && `P/N ${c.partNumber}`, c.serial && `S/N ${c.serial}`]
            .filter(Boolean)
            .join(" "),
          `${r.requirementType}: ${r.description}`,
          dueDate && `due ${dueDate}`,
        ),
        aircraftUuid: a.uuid,
        entityUuid: r.uuid,
        dueDate,
        link: "/components",
      },
    ];
  });
}

// Only the signed-in user's own certificates; other members' details are private.
function certificateAlerts(s: Snapshot, today: string): Alert[] {
  return normalizeCertifications(s.user.certifications ?? []).flatMap((c) => {
    const dates: [string, string, string | undefined][] = [
      [c.kind, certificationLabels[c.kind], c.expiresOn],
      ...(c.kind === "mechanic" && c.ia
        ? [["ia", "IA renewal", c.renewalDate] as [string, string, string]]
        : []),
    ];
    return dates.flatMap(([id, label, date]): Alert[] => {
      if (!date) return [];
      const remaining = days(today, date);
      if (remaining > CERTIFICATE_WARNING_DAYS) return [];
      const expired = remaining < 0;
      const kind = expired ? "certificate-expired" : "certificate-expiring";
      return [
        {
          key: alertKey(kind, s.user.id, id, date),
          kind,
          severity: expired ? "danger" : "warning",
          title: expired
            ? `${label} expired on ${date}`
            : `${label} expires on ${date}`,
          detail: expired
            ? "Renew it and update My certifications."
            : `${remaining} day${remaining === 1 ? "" : "s"} remaining. Update My certifications after renewal.`,
          entityUuid: `${s.user.id}:${id}`,
          dueDate: date,
          link: "/",
        },
      ];
    });
  });
}

function faaReviewAlerts(s: Snapshot): Alert[] {
  return (s.faaMonitors ?? []).flatMap((m): Alert[] => {
    const a = s.aircraft.find((a) => a.uuid === m.aircraftUuid);
    if (!a || !can(s, a.uuid, "read")) return [];
    const pending = monitoringReviewCandidates(
      s,
      m.aircraftUuid,
      m.candidates,
    ).filter((c) => !c.reviewReason);
    if (!pending.length) return [];
    const numbers = pending.map((c) => c.source.number);
    return [
      {
        key: alertKey(
          "faa-ad-review",
          a.uuid,
          hash(
            pending
              .map((c) => c.id + "@" + c.modified)
              .sort()
              .join(","),
          ),
        ),
        kind: "faa-ad-review",
        severity: pending.some((c) => c.emergency) ? "danger" : "info",
        title: `${pending.length} new or changed FAA AD document${pending.length === 1 ? "" : "s"} to review`,
        detail: joinDetail(
          a.registration,
          numbers.slice(0, 5).join(", ") +
            (numbers.length > 5 ? ` and ${numbers.length - 5} more` : ""),
        ),
        aircraftUuid: a.uuid,
        entityUuid: a.uuid,
        link: "/airworthiness",
      },
    ];
  });
}

// One summary alert per grounded aircraft; the key changes with the reasons.
function groundedAlerts(s: Snapshot, today: string): Alert[] {
  return s.aircraft.flatMap((a): Alert[] => {
    if (!can(s, a.uuid, "read")) return [];
    const status = aircraftStatus(s, a.uuid, today);
    if (status.level !== "grounded") return [];
    const labels = status.reasons.map((r) => r.label);
    return [
      {
        key: alertKey(
          "aircraft-grounded",
          a.uuid,
          hash(
            status.reasons
              .map((r) => r.kind + ":" + r.entityUuid)
              .sort()
              .join(","),
          ),
        ),
        kind: "aircraft-grounded",
        severity: "danger",
        title: `${a.registration} is grounded`,
        detail: joinDetail(
          labels.slice(0, 3).join("; ") +
            (labels.length > 3 ? ` and ${labels.length - 3} more` : ""),
        ),
        aircraftUuid: a.uuid,
        entityUuid: a.uuid,
        link: "/",
      },
    ];
  });
}

/** Alerts for a program-scoped snapshot; today is a YYYY-MM-DD local date. */
export function computeAlerts(s: Snapshot, today: string): Alert[] {
  if (!s.user.active) return [];
  return [
    ...inspectionAlerts(s, today),
    ...adAlerts(s, today),
    ...componentAlerts(s, today),
    ...certificateAlerts(s, today),
    ...faaReviewAlerts(s),
    ...groundedAlerts(s, today),
  ].sort(
    (x, y) =>
      severityRank[x.severity] - severityRank[y.severity] ||
      (x.dueDate ?? "9999").localeCompare(y.dueDate ?? "9999") ||
      x.title.localeCompare(y.title),
  );
}

/** Explicit choice wins; otherwise program administrators receive digests. */
export function wantsAlertEmails(
  user: Pick<Member, "emailAlerts" | "groupIds">,
  groups: Group[],
  programUuid: string | undefined,
) {
  return (
    user.emailAlerts ??
    groups.some(
      (g) =>
        g.programAdmin &&
        g.programUuid === programUuid &&
        g.permissions.includes("read") &&
        user.groupIds.includes(g.id),
    )
  );
}
