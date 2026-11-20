/**
 * Responsibility: How much one member has open in problem reports, the
 *   per-member limit on filing more, and when that backlog is high enough
 *   to alert administrators (decision D2).
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ./model, ./programs.
 *
 * The workspace loads every problem report and the newest 250 change-log rows
 * in one query, which Convex stops at 16 MiB read. One member filed 800
 * maximum-length reports in about a minute and locked everyone out (SE-13).
 * Paging that history is the real fix (decision D3); until then one member's
 * open backlog is bounded, so they cannot grow the workspace without an
 * administrator resolving or deferring their reports.
 */
import type { Discrepancy, Snapshot } from "./model";
import { ownsActive } from "./programs";

/**
 * The most open, undeferred problem reports one member may have in a Flight
 * Program. The bug hunt's model fleet files 180 reports a year across six
 * aircraft, so this is more than the whole fleet's year from one person. It
 * bounds the per-report fields the text limit does not: about 0.6 KB each
 * (the report and its change-log row), 120 KB at the limit.
 */
export const MAX_OPEN_REPORTS_PER_MEMBER = 200;

/**
 * The most text, in UTF-8 bytes, one member's open, undeferred reports may
 * hold. The Size test measured a one-year program's workspace at about 9.5 MB
 * of the 16 MiB read limit, leaving about 7 MB. A report's text is read about
 * twice (the report and its change-log row), so 512 KiB costs about 1 MiB with
 * the per-report fields: under a sixth of that headroom, where SE-13 took the
 * whole 16 MiB. A long real report is about 1 KB, so this is hundreds of them.
 */
export const MAX_OPEN_REPORT_BYTES_PER_MEMBER = 512 * 1024;

/**
 * The share of either limit at which the program's administrators are
 * alerted: 100 reports or 256 KiB, already more than half the model fleet's
 * year from one member. SE-13's rate reaches it in seconds, and a genuine
 * reporter there still has room, so it is early enough to act either way.
 */
export const REPORT_BACKLOG_ALERT_SHARE = 0.5;

/** What a member sees when a new report would pass their limit. */
export const REPORT_LIMIT_REFUSAL =
  "You have too many open problem reports. Ask an administrator to resolve or defer some of your open reports, then send this one again.";

/** How much one member has open in problem reports. */
export interface ReportBacklog {
  authorId: string;
  /** Open, undeferred reports they filed on the program's aircraft. */
  count: number;
  /** Those reports' descriptions, in UTF-8 bytes. */
  bytes: number;
}

/**
 * A member's open backlog in the active Flight Program: their open reports
 * that are not deferred, on aircraft the program holds. Resolving or
 * deferring a report takes it off.
 *
 * @param s - A snapshot holding at least the member's open reports.
 * @param authorId - The member.
 * @returns Their report count and text size.
 */
export function reportBacklog(s: Snapshot, authorId: string): ReportBacklog {
  const open = s.discrepancies.filter(
    (d) => d.authorId === authorId && isOpenBacklog(s, d),
  );
  return {
    authorId,
    count: open.length,
    bytes: open.reduce((n, d) => n + textBytes(d.description), 0),
  };
}

/**
 * Whether filing one more report would take a member past either per-member
 * limit. Reaching a limit exactly is allowed.
 *
 * @param s - A snapshot holding at least the member's open reports.
 * @param authorId - The member filing.
 * @param description - The new report's text.
 * @returns True when the report must be refused with
 *   {@link REPORT_LIMIT_REFUSAL}.
 */
export function passesReportLimit(
  s: Snapshot,
  authorId: string,
  description: string,
): boolean {
  const { count, bytes } = reportBacklog(s, authorId);
  return (
    count + 1 > MAX_OPEN_REPORTS_PER_MEMBER ||
    bytes + textBytes(description) > MAX_OPEN_REPORT_BYTES_PER_MEMBER
  );
}

/**
 * The members whose open backlog has reached {@link REPORT_BACKLOG_ALERT_SHARE}
 * of either limit in the active Flight Program.
 *
 * @param s - A snapshot holding the program's open reports.
 * @returns One backlog per such member, in the order their reports appear.
 */
export function highReportBacklogs(s: Snapshot): ReportBacklog[] {
  const authors = new Set(
    s.discrepancies.filter((d) => isOpenBacklog(s, d)).map((d) => d.authorId),
  );
  return [...authors]
    .map((authorId) => reportBacklog(s, authorId))
    .filter(
      ({ count, bytes }) =>
        count >= MAX_OPEN_REPORTS_PER_MEMBER * REPORT_BACKLOG_ALERT_SHARE ||
        bytes >= MAX_OPEN_REPORT_BYTES_PER_MEMBER * REPORT_BACKLOG_ALERT_SHARE,
    );
}

// Bytes, not characters, because the read limit counts bytes: a description
// of 5,000 three-byte characters is 15 KB (SE-13).
function textBytes(text: string) {
  return new TextEncoder().encode(text).length;
}

function isOpenBacklog(s: Snapshot, d: Discrepancy) {
  if (d.status !== "open" || d.deferral) return false;
  const aircraft = s.aircraft.find((a) => a.uuid === d.aircraftUuid);
  return !!aircraft && ownsActive(s, aircraft.programUuid);
}
