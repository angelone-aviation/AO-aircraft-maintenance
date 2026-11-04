/**
 * Responsibility: The maintenance alerts a user sees for their Flight
 *   Program, and whether they want them emailed.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ./model, ./aircraftStatus, ./airworthiness, ./certifications,
 *   ./components, ./faaCandidateReview, ./maintenance, ./management.
 */
import { aircraftStatus } from "./aircraftStatus";
import {
  adAircraftUuid,
  adStatus,
  adTaskStatus,
  type AD,
  type ADTask,
} from "./airworthiness";
import { certificationLabels, normalizeCertifications } from "./certifications";
import {
  requirementDueDate,
  requirementStatus,
  type Component,
  type ComponentRequirement,
} from "./components";
import { monitoringReviewCandidates } from "./faaCandidateReview";
import { inspectionDueDate, inspectionStatus } from "./maintenance";
import { inspectionCounters } from "./management";
import {
  can,
  type Aircraft,
  type Group,
  type Inspection,
  type Member,
  type Snapshot,
} from "./model";

/** What an alert is about. Extend it as new alert sources are added. */
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

/** How urgent an alert is, as {@link severityLabels} names it. */
export type AlertSeverity = "info" | "warning" | "danger";

/** The screen an alert opens. */
export type AlertLink = "/" | "/inspections" | "/airworthiness" | "/components";

/** One alert, shown in the app and sent in the email digest. */
export interface Alert {
  /** Changes whenever the alert's substance (kind, entity, due point) changes.
   * Read marks and sent digests are kept by key, so a changed alert is unread
   * and emailed again. */
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

/** The heading each severity is listed under. */
export const severityLabels: Record<AlertSeverity, string> = {
  danger: "Action required",
  warning: "Coming due",
  info: "For review",
};

/** A certificate alerts from this many days before it expires. */
export const CERTIFICATE_WARNING_DAYS = 30;

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  danger: 0,
  warning: 1,
  info: 2,
};
const SKIPPED_AD_STATUSES = [
  "Not applicable",
  "Superseded",
  "Removed component",
  "Previously Complied With (PCW)",
];
const PAST_DUE_STATUSES = ["Past due", "Due now"];
const DAY_MS = 86_400_000;

// Sorts after every YYYY-MM-DD date, so undated alerts come last.
const UNDATED = "9999";

const AD_DETAIL_MAX_LENGTH = 200;
const FAA_NUMBERS_SHOWN = 5;
const GROUNDED_REASONS_SHOWN = 3;

// FNV-1a (32-bit); keeps keys short when they summarize a set of documents.
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * Every alert for a program-scoped snapshot, on aircraft the user can read.
 *
 * @param s - The snapshot.
 * @param today - A YYYY-MM-DD local date.
 * @returns Action required first, then coming due, then for review; within
 *   each, by due date (undated last), then title. None for an inactive user.
 */
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
      SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity] ||
      (x.dueDate ?? UNDATED).localeCompare(y.dueDate ?? UNDATED) ||
      x.title.localeCompare(y.title),
  );
}

/**
 * Whether a member receives alert digests for a Flight Program.
 *
 * @param user - The member; `emailAlerts` is their explicit choice, if any.
 * @param groups - The permission groups.
 * @param programUuid - The program.
 * @returns The explicit choice; without one, true for a member of a program
 *   administrator group with read access in that program.
 */
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

const alertKey = (kind: AlertKind, ...parts: unknown[]) =>
  [kind, ...parts.map((p) => (p === undefined || p === null ? "" : p))].join(
    "|",
  );
function hash(text: string) {
  let h = FNV_OFFSET_BASIS;
  for (let i = 0; i < text.length; i++)
    h = Math.imul(h ^ text.charCodeAt(i), FNV_PRIME);
  return (h >>> 0).toString(16);
}
const days = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
const amount = (n: number, unit: string) =>
  n < 0
    ? `${Math.abs(n).toFixed(1).replace(/\.0$/, "")} ${unit} over`
    : `${n.toFixed(1).replace(/\.0$/, "")} ${unit} remaining`;
const joinDetail = (...parts: (string | false | undefined)[]) =>
  parts.filter(Boolean).join(" · ");
const listFirst = (items: string[], shown: number, separator: string) =>
  items.slice(0, shown).join(separator) +
  (items.length > shown ? ` and ${items.length - shown} more` : "");

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
    return [inspectionAlert(i, a, status)];
  });
}

function inspectionAlert(
  i: Inspection,
  a: Aircraft,
  status: ReturnType<typeof inspectionStatus>,
): Alert {
  const overdue = status.status === "overdue";
  const kind = overdue ? "inspection-overdue" : "inspection-due-soon";
  const dueDate = inspectionDueDate(i);
  const { hoursRemaining, cyclesRemaining, landingsRemaining } = status;
  return {
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
      hoursRemaining !== undefined && amount(hoursRemaining, "h"),
      cyclesRemaining !== undefined && amount(cyclesRemaining, "cycles"),
      landingsRemaining !== undefined && amount(landingsRemaining, "landings"),
    ),
    aircraftUuid: a.uuid,
    entityUuid: i.uuid,
    dueDate,
    link: "/inspections",
  };
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
      return [adTaskAlert(r, t, a, status)];
    });
  });
}

function adTaskAlert(
  r: AD,
  t: ADTask,
  a: Aircraft,
  status: "Overdue" | "Due soon",
): Alert {
  const overdue = status === "Overdue";
  const kind = overdue ? "ad-overdue" : "ad-due-soon";
  return {
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
      t.description.slice(0, AD_DETAIL_MAX_LENGTH),
      t.dueDate && `due ${t.dueDate}`,
      t.dueHours !== null && `due at ${t.dueHours} h`,
      t.dueCycles !== null && `due at ${t.dueCycles} cycles`,
    ),
    aircraftUuid: a.uuid,
    entityUuid: r.uuid,
    dueDate: t.dueDate || undefined,
    link: "/airworthiness",
  };
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
      // Usage it cannot compute (readings before the installation baseline,
      // no collective meter) shows on the component page instead.
      return [];
    }
    if (!PAST_DUE_STATUSES.includes(status) && status !== "Due soon") return [];
    return [componentAlert(r, c, a, status)];
  });
}

function componentAlert(
  r: ComponentRequirement,
  c: Component,
  a: Aircraft,
  status: string,
): Alert {
  const pastDue = PAST_DUE_STATUSES.includes(status);
  const kind = pastDue ? "component-past-due" : "component-due-soon";
  const dueDate = requirementDueDate(r);
  return {
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
  };
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
    const documents = pending.map((c) => c.id + "@" + c.modified).sort();
    return [
      {
        key: alertKey("faa-ad-review", a.uuid, hash(documents.join(","))),
        kind: "faa-ad-review",
        severity: pending.some((c) => c.emergency) ? "danger" : "info",
        title: `${pending.length} new or changed FAA AD document${pending.length === 1 ? "" : "s"} to review`,
        detail: joinDetail(
          a.registration,
          listFirst(numbers, FAA_NUMBERS_SHOWN, ", "),
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
    const reasons = status.reasons.map((r) => r.kind + ":" + r.entityUuid);
    return [
      {
        key: alertKey(
          "aircraft-grounded",
          a.uuid,
          hash(reasons.sort().join(",")),
        ),
        kind: "aircraft-grounded",
        severity: "danger",
        title: `${a.registration} is grounded`,
        detail: joinDetail(listFirst(labels, GROUNDED_REASONS_SHOWN, "; ")),
        aircraftUuid: a.uuid,
        entityUuid: a.uuid,
        link: "/",
      },
    ];
  });
}
