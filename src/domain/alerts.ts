/**
 * Responsibility: The maintenance alerts a user sees for their Flight
 *   Program, which of them are urgent, and whether they want them emailed.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ./model, ./aircraftStatus, ./certifications, ./components,
 *   ./dueItems, ./expiringItems, ./faaCandidateReview, ./maintenance,
 *   ./programs, ./programShare, ./reportBacklog; ./airworthiness.
 */
import { aircraftStatus } from "./aircraftStatus";
import { SETTLED_AD_STATUSES, type AD, type ADTask } from "./airworthiness";
import { certificationLabels, normalizeCertifications } from "./certifications";
import {
  requirementDueDate,
  type Component,
  type ComponentRequirement,
} from "./components";
import {
  dueItems,
  type AdDue,
  type DueLevel,
  type InspectionDue,
  type MaintenanceDue,
} from "./dueItems";
import {
  daysUntil,
  expiringKindLabels,
  expiringStatus,
  listExpiringItems,
  type ExpiringItem,
} from "./expiringItems";
import { monitoringReviewCandidates } from "./faaCandidateReview";
import { inspectionDueDate } from "./maintenance";
import {
  can,
  type Aircraft,
  type Group,
  type Inspection,
  type Member,
  type Snapshot,
} from "./model";
import { programPermission } from "./programs";
import { programShare } from "./programShare";
import {
  highReportBacklogs,
  MAX_OPEN_REPORT_BYTES_PER_MEMBER,
  MAX_OPEN_REPORTS_PER_MEMBER,
} from "./reportBacklog";

/** What an alert is about. Extend it as new alert sources are added. */
export type AlertKind =
  | "inspection-due-soon"
  | "inspection-overdue"
  | "ad-due-soon"
  | "ad-overdue"
  | "ad-review"
  | "component-due-soon"
  | "component-past-due"
  | "certificate-expiring"
  | "certificate-expired"
  | "faa-ad-review"
  | "aircraft-grounded"
  | "date-expiring"
  | "date-expired"
  | "report-backlog";

/** How urgent an alert is, as {@link severityLabels} names it. */
export type AlertSeverity = "info" | "warning" | "danger";

/** The screen an alert opens. */
export type AlertLink =
  | "/"
  | "/inspections"
  | "/airworthiness"
  | "/components"
  | "/discrepancies"
  | "/settings";

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

/** What the alerts cover, as the Alerts page and Settings describe them. */
export const ALERT_KINDS_SUMMARY =
  "Inspections, ADs and component limits coming due, ADs to review, grounded aircraft, your certificates, FAA documents to review and expiring dates, for the aircraft you can access; for administrators, a member's open problem reports piling up.";

/** The UTC hour the daily alert digest goes out (convex/crons.ts). */
export const ALERT_DIGEST_HOUR_UTC = 13;

/**
 * Immediate emails for urgent alerts allowed per UTC day, for the whole
 * deployment, so Resend's free 100 a day leaves room for the digest; a capped
 * alert waits for the next digest (docs/alerts.md).
 */
export const IMMEDIATE_EMAILS_PER_DAY = 60;

/** No Flight Program's share of the day's immediate emails is smaller. */
export const IMMEDIATE_EMAIL_SHARE_FLOOR = 10;

/**
 * The alerts that reach people at once (GLOSSARY "Urgent alert"): an
 * aircraft that may not fly, a limit already passed, a date already expired,
 * a member's problem reports piling up fast enough to lock the program out.
 * Everything else waits for the daily digest.
 */
export const URGENT_ALERT_KINDS: readonly AlertKind[] = [
  "aircraft-grounded",
  "inspection-overdue",
  "ad-overdue",
  "component-past-due",
  "date-expired",
  "report-backlog",
];

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  danger: 0,
  warning: 1,
  info: 2,
};
const DAY_MS = 86_400_000;

// Sorts after every YYYY-MM-DD date, so undated alerts come last.
const UNDATED = "9999";

const AD_DETAIL_MAX_LENGTH = 200;
const BYTES_PER_KIB = 1024;
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
  const due = dueItems(s, undefined, today);
  return [
    ...inspectionAlerts(s, due),
    ...adAlerts(s, due),
    ...componentAlerts(s, due),
    ...certificateAlerts(s, today),
    ...faaReviewAlerts(s),
    ...groundedAlerts(s, today),
    ...expiringDateAlerts(s, "system", today),
    ...expiringDateAlerts(s, "program", today),
    ...reportBacklogAlerts(s),
  ].sort(compareAlerts);
}

/**
 * The deployment's own expiring dates, the FAA key's renewal included, as a
 * system administrator's alerts apart from any Flight Program, so the server
 * sends each of them once rather than once per program.
 *
 * @param s - A snapshot holding the system-wide dates and the FAA key status.
 * @param today - A YYYY-MM-DD local date.
 * @returns As {@link computeAlerts} orders them; none for an inactive user
 *   or one who is not a system administrator.
 */
export function systemDateAlerts(s: Snapshot, today: string): Alert[] {
  if (!s.user.active || !s.user.isAdmin) return [];
  return expiringDateAlerts(s, "system", today).sort(compareAlerts);
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

/**
 * Whether a member gets urgent alerts by email as soon as they arise.
 *
 * @param user - The member; `urgentAlertEmails` is their explicit choice.
 * @param groups - The permission groups.
 * @param programUuid - The program.
 * @returns The explicit choice; without one, true for a member of a program
 *   administrator group, or of a group with maintenance permission, with
 *   read access in that program.
 */
export function wantsUrgentAlertEmails(
  user: Pick<Member, "urgentAlertEmails" | "groupIds">,
  groups: Group[],
  programUuid: string | undefined,
) {
  return (
    user.urgentAlertEmails ??
    groups.some(
      (g) =>
        g.programUuid === programUuid &&
        g.permissions.includes("read") &&
        user.groupIds.includes(g.id) &&
        (g.programAdmin || g.permissions.includes("maintenance")),
    )
  );
}

/**
 * The urgent alerts among a list, in the list's order.
 *
 * @returns Those whose kind is in {@link URGENT_ALERT_KINDS}.
 */
export function urgentAlerts<T extends Pick<Alert, "kind">>(alerts: T[]): T[] {
  return alerts.filter((a) => URGENT_ALERT_KINDS.includes(a.kind));
}

/**
 * How many immediate emails one Flight Program may send in a UTC day: the
 * deployment's {@link IMMEDIATE_EMAILS_PER_DAY} split equally between the
 * programs with an active member, never below
 * {@link IMMEDIATE_EMAIL_SHARE_FLOOR}.
 *
 * @param activePrograms - Programs where an active member holds a group.
 * @returns The program's share; the whole total for one program or none.
 */
export function immediateEmailShare(activePrograms: number): number {
  // One program's flood (an administrator re-saving a past date 60 times,
  // SE-3) must not hold back another program's "is grounded" email until
  // the next digest. The floor leaves room for one bad event among a
  // program's administrators and maintenance members once many programs
  // share the total: past six programs the shares add up to more than it.
  return programShare(
    IMMEDIATE_EMAILS_PER_DAY,
    activePrograms,
    IMMEDIATE_EMAIL_SHARE_FLOOR,
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

function inspectionAlerts(s: Snapshot, due: MaintenanceDue[]): Alert[] {
  return due.flatMap((item): Alert[] => {
    if (item.kind !== "inspection" || !item.due) return [];
    if (!isComingDue(item.level) || !can(s, item.aircraft.uuid, "read"))
      return [];
    return [inspectionAlert(item.inspection, item.aircraft, item.due)];
  });
}

function inspectionAlert(
  i: Inspection,
  a: Aircraft,
  status: NonNullable<InspectionDue["due"]>,
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

// An AD the dashboard lists alerts on each overdue or due-soon action, even
// while it needs review; without one, it asks for review once.
function adAlerts(s: Snapshot, due: MaintenanceDue[]): Alert[] {
  return due.flatMap((item): Alert[] => {
    if (item.kind !== "ad" || !item.aircraft) return [];
    if (!can(s, item.aircraft.uuid, "read")) return [];
    if (SETTLED_AD_STATUSES.includes(item.status)) return [];
    const actions = adTaskAlerts(item, item.aircraft);
    return actions.length ? actions : [adReviewAlert(item, item.aircraft)];
  });
}

function adReviewAlert({ ad: r, status }: AdDue, a: Aircraft): Alert {
  return {
    key: alertKey("ad-review", r.uuid, status),
    kind: "ad-review",
    severity: "info",
    title: `AD ${r.source.number}: ${status}`,
    detail: joinDetail(
      a.registration,
      r.source.subject.slice(0, AD_DETAIL_MAX_LENGTH),
    ),
    aircraftUuid: a.uuid,
    entityUuid: r.uuid,
    link: "/airworthiness",
  };
}

function adTaskAlerts(item: AdDue, a: Aircraft): Alert[] {
  return item.tasks.flatMap(({ task, status }): Alert[] =>
    status === "Overdue" || status === "Due soon"
      ? [adTaskAlert(item.ad, task, a, status)]
      : [],
  );
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

// Components held in inventory do not alert.
function componentAlerts(s: Snapshot, due: MaintenanceDue[]): Alert[] {
  return due.flatMap((item): Alert[] => {
    if (item.kind !== "componentRequirement") return [];
    if (!item.aircraft || !item.due || !isComingDue(item.level)) return [];
    if (!can(s, item.aircraft.uuid, "read")) return [];
    const { requirement, component, aircraft, due, level } = item;
    return [
      componentAlert(requirement, component, aircraft, due.status, level),
    ];
  });
}

// An item whose status cannot be computed (a missing component, readings
// before the installation baseline, no collective meter) shows on its
// schedule or component page instead.
function isComingDue(level: DueLevel) {
  return level === "overdue" || level === "due-soon";
}

function componentAlert(
  r: ComponentRequirement,
  c: Component,
  a: Aircraft,
  status: string,
  level: DueLevel,
): Alert {
  const pastDue = level === "overdue";
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

// Only the signed-in user's own certificates; other members' details are
// private.
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

function compareAlerts(x: Alert, y: Alert) {
  return (
    SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity] ||
    (x.dueDate ?? UNDATED).localeCompare(y.dueDate ?? UNDATED) ||
    x.title.localeCompare(y.title)
  );
}

// System-wide dates alert system administrators, a program's dates its
// administrators (listExpiringItems applies both rules).
function expiringDateAlerts(
  s: Snapshot,
  scope: "system" | "program",
  today: string,
): Alert[] {
  return listExpiringItems(s, scope).flatMap((item): Alert[] => {
    const status = expiringStatus(item, today);
    if (status === "ok") return [];
    return [expiringDateAlert(s, item, status === "expired", today)];
  });
}

function expiringDateAlert(
  s: Snapshot,
  item: ExpiringItem,
  expired: boolean,
  today: string,
): Alert {
  const kind = expired ? "date-expired" : "date-expiring";
  const remaining = daysUntil(today, item.expiresOn);
  const aircraft = s.aircraft.find((a) => a.uuid === item.aircraftUuid);
  return {
    key: alertKey(kind, item.uuid, item.expiresOn),
    kind,
    severity: expired ? "danger" : "warning",
    title: `${item.label} ${expired ? "expired" : "expires"} on ${item.expiresOn}`,
    detail: joinDetail(
      expiringKindLabels[item.kind],
      aircraft?.registration,
      expired
        ? "Renew it, then record the new date under Expiring dates in Settings."
        : `${remaining} day${remaining === 1 ? "" : "s"} remaining.`,
    ),
    aircraftUuid: aircraft?.uuid,
    entityUuid: item.uuid,
    dueDate: item.expiresOn,
    link: "/settings",
  };
}

// A program's administrators can resolve or defer the reports, and see who
// filed them. The key names only the member, so one occurrence is sent
// once however many more reports arrive.
function reportBacklogAlerts(s: Snapshot): Alert[] {
  if (!programPermission(s, "admin")) return [];
  return highReportBacklogs(s).map((b) => ({
    key: alertKey("report-backlog", b.authorId),
    kind: "report-backlog",
    severity: "danger",
    title: `${memberName(s, b.authorId)} has ${b.count} open problem reports`,
    detail: joinDetail(
      `${Math.ceil(b.bytes / BYTES_PER_KIB)} KiB of text`,
      `New reports from them are refused past ${MAX_OPEN_REPORTS_PER_MEMBER} or ${MAX_OPEN_REPORT_BYTES_PER_MEMBER / BYTES_PER_KIB} KiB. Resolve or defer them, or check the account.`,
    ),
    entityUuid: b.authorId,
    link: "/discrepancies",
  }));
}

function memberName(s: Snapshot, id: string) {
  return s.members.find((m) => m.id === id)?.name ?? "A member";
}
