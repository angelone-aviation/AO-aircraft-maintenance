/**
 * Responsibility: The weekly summary of the change log for Flight Program
 *   administrators: action families, per-actor counts over a period, the
 *   notable events worth a second look, and the CSV rows of the table.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ./model (types, localDate).
 *
 * Refused sign-ins are counted and never listed: their entries carry the
 * email the stranger typed, which the summary must not repeat (ADR-0005
 * keeps the entries themselves for investigation).
 */
import { localDate, type AuditEntry } from "./model";

/** The kinds of work the summary groups actions into. */
export type ActionFamily =
  | "flights"
  | "maintenance"
  | "ads"
  | "workOrders"
  | "parts"
  | "access"
  | "faa"
  | "other";

/**
 * Which family an action's type (the part before the dot) belongs to. A
 * type not listed is "other".
 */
export const ACTION_FAMILIES: Readonly<Record<string, ActionFamily>> = {
  flight: "flights",
  discrepancy: "flights",
  plan: "flights",
  inspection: "maintenance",
  component: "maintenance",
  ad: "ads",
  taskCard: "workOrders",
  workOrder: "workOrders",
  stock: "parts",
  partsRequest: "parts",
  po: "parts",
  inventory: "parts",
  location: "parts",
  vendor: "parts",
  user: "access",
  group: "access",
  program: "access",
  faa: "faa",
};

/** The families in table order, with their column labels. */
export const FAMILY_LABELS: Readonly<Record<ActionFamily, string>> = {
  flights: "Flights and discrepancies",
  maintenance: "Inspections and components",
  ads: "ADs",
  workOrders: "Work orders and job cards",
  parts: "Parts and purchasing",
  access: "Users and access",
  faa: "FAA",
  other: "Other",
};

/** The families in table order. */
export const FAMILY_ORDER = Object.keys(FAMILY_LABELS) as ActionFamily[];

/** A range of local dates, inclusive. */
export interface SummaryPeriod {
  from: string;
  to: string;
}

/** Why an entry is listed as notable. */
export type NotableKind =
  | "dispatch-override"
  | "permission-change"
  | "account-change"
  | "archive"
  | "correction";

/** One notable entry, without its recorded values. */
export interface NotableEvent {
  kind: NotableKind;
  uuid: string;
  at: number;
  actorId: string;
  action: string;
  entityUuid: string;
  aircraftUuid?: string;
  reason?: string;
}

/** One actor's row of the summary table. */
export interface ActorSummary {
  actorId: string;
  counts: Record<ActionFamily, number>;
  total: number;
}

/** The summary of a period's change log. */
export interface AuditSummary {
  period: SummaryPeriod;
  /** Entries in the period, refused sign-ins left out. */
  total: number;
  /** Most active first; ties by actor id. */
  actors: ActorSummary[];
  families: Record<ActionFamily, number>;
  /** Newest first. */
  notable: NotableEvent[];
  refusedSignIns: number;
}

/** What the server returns: the summary, and whether its scan was cut short. */
export interface AuditSummaryResult {
  summary: AuditSummary;
  /** True when the scan budget ran out before the period's start, so older
   * entries in the period are not counted. */
  truncated: boolean;
}

const DAY_MS = 86_400_000;
const PERIOD_DAYS = { "7d": 7, "30d": 30 } as const;
const REFUSED_SIGN_IN = "user.sign_in_refused";
const DISPATCH_OVERRIDE = "flight.dispatch_override";
const ACCOUNT_ACTIONS: readonly string[] = [
  "user.created",
  "user.password_reset",
  "user.sessions_ended",
];
const PERMISSION_ACTIONS: readonly string[] = [
  "user.permissions_changed",
  "user.program_access_added",
  "user.program_access_changed",
];

/**
 * The family of an action.
 *
 * @param action - The stored action, such as "flight.reviewed".
 * @returns The family of its type, or "other".
 */
export function actionFamily(action: string): ActionFamily {
  return ACTION_FAMILIES[action.split(".")[0]] ?? "other";
}

/**
 * The last 7 or 30 days, ending today.
 *
 * @param kind - "7d" or "30d".
 * @param today - A local date.
 * @returns The period; "7d" on 2026-11-09 is 2026-11-03 to 2026-11-09.
 */
export function summaryPeriod(
  kind: keyof typeof PERIOD_DAYS,
  today: string,
): SummaryPeriod {
  const end = Date.parse(today + "T00:00:00Z");
  const start = end - (PERIOD_DAYS[kind] - 1) * DAY_MS;
  return { from: new Date(start).toISOString().slice(0, 10), to: today };
}

/**
 * Summarizes the change-log entries that fall in a period, by the local date
 * of each entry's `at`.
 *
 * @param entries - Entries in any order; those outside the period are
 *   ignored.
 * @param period - The dates to cover, inclusive.
 * @returns Per-actor counts per family, most active first; family totals;
 *   notable events newest first: dispatch overrides, permission changes
 *   (group saves and deletions, membership and access changes), account
 *   changes (users created, disabled, password reset, sessions ended),
 *   archives and deletions, and corrections (any other entry with a reason);
 *   and the number of refused sign-ins, which count nowhere else.
 */
export function summarizeAudit(
  entries: AuditEntry[],
  period: SummaryPeriod,
): AuditSummary {
  const inPeriod = entries.filter((a) => {
    const day = localDate(a.at);
    return day >= period.from && day <= period.to;
  });
  const counted = inPeriod.filter((a) => a.action !== REFUSED_SIGN_IN);
  return {
    period,
    total: counted.length,
    actors: summarizeActors(counted),
    families: countFamilies(counted),
    notable: counted
      .flatMap((a) => {
        const kind = notableKind(a);
        return kind ? [toNotable(a, kind)] : [];
      })
      .sort((x, y) => y.at - x.at),
    refusedSignIns: inPeriod.length - counted.length,
  };
}

/**
 * The summary table as CSV rows: one per actor with a column per family and
 * a total, then a "Refused sign-ins" row.
 *
 * @param summary - The summary.
 * @param nameOf - Names an actor id for the first column.
 */
export function auditSummaryCsvRows(
  summary: AuditSummary,
  nameOf: (actorId: string) => string,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = summary.actors.map((actor) => ({
    Actor: nameOf(actor.actorId),
    ...Object.fromEntries(
      FAMILY_ORDER.map((f) => [FAMILY_LABELS[f], actor.counts[f]]),
    ),
    Total: actor.total,
  }));
  rows.push({ Actor: "Refused sign-ins", Total: summary.refusedSignIns });
  return rows;
}

function emptyCounts(): Record<ActionFamily, number> {
  return Object.fromEntries(FAMILY_ORDER.map((f) => [f, 0])) as Record<
    ActionFamily,
    number
  >;
}

function countFamilies(entries: AuditEntry[]) {
  const counts = emptyCounts();
  for (const a of entries) counts[actionFamily(a.action)] += 1;
  return counts;
}

function summarizeActors(entries: AuditEntry[]): ActorSummary[] {
  const byActor = new Map<string, ActorSummary>();
  for (const a of entries) {
    const row = byActor.get(a.actorId) ?? {
      actorId: a.actorId,
      counts: emptyCounts(),
      total: 0,
    };
    row.counts[actionFamily(a.action)] += 1;
    row.total += 1;
    byActor.set(a.actorId, row);
  }
  return [...byActor.values()].sort(
    (x, y) => y.total - x.total || x.actorId.localeCompare(y.actorId),
  );
}

// The first matching kind wins: an override's reason is not a correction.
function notableKind(a: AuditEntry): NotableKind | undefined {
  if (a.action === DISPATCH_OVERRIDE) return "dispatch-override";
  if (ACCOUNT_ACTIONS.includes(a.action) || disablesAccount(a))
    return "account-change";
  if (a.action.startsWith("group.") || PERMISSION_ACTIONS.includes(a.action))
    return "permission-change";
  if (/\.[a-z_]*(archiv|delet)/.test(a.action)) return "archive";
  return a.reason?.trim() ? "correction" : undefined;
}

// A permissions change that turns the account off is an account change.
function disablesAccount(a: AuditEntry): boolean {
  if (a.action !== "user.permissions_changed" || !a.after) return false;
  try {
    const after: unknown = JSON.parse(a.after);
    return (
      typeof after === "object" &&
      after !== null &&
      (after as { active?: unknown }).active === false
    );
  } catch {
    // An older row whose `after` is not JSON records no account state.
    return false;
  }
}

function toNotable(a: AuditEntry, kind: NotableKind): NotableEvent {
  return {
    kind,
    uuid: a.uuid,
    at: a.at,
    actorId: a.actorId,
    action: a.action,
    entityUuid: a.entityUuid,
    aircraftUuid: a.aircraftUuid,
    reason: a.reason,
  };
}
