/**
 * Responsibility: The board's fleet summary: status counts, each aircraft's
 *   line (status, due items, open discrepancies, spend against budget), what
 *   falls due within the next 30 days, and the off-site backup's freshness.
 * Layer: Domain. Pure functions; no I/O, no React (a `now` left to its default
 *   reads the clock).
 * Dependencies: ./model, ./aircraftStatus, ./dueItems, ./ownerDue,
 *   ./boardView, ./offsiteBackups.
 *
 * The screen and the PDF both render this one summary, so they cannot drift.
 */
import { localDate, type Aircraft, type Snapshot } from "./model";
import { aircraftStatus, type AircraftStatusLevel } from "./aircraftStatus";
import { dueItems, type MaintenanceDue } from "./dueItems";
import { ownerDueItems, type DueItem } from "./ownerDue";
import { boardCostTotals, type BoardAircraftCosts } from "./boardView";
import { offsiteFreshness, type OffsiteFreshness } from "./offsiteBackups";

/** How far ahead the board's due list looks, in calendar days. */
export const BOARD_DUE_HORIZON_DAYS = 30;
const DAY_MS = 86_400_000;
const STATUS_RANK: Record<DueItem["status"], number> = {
  overdue: 0,
  "due-soon": 1,
  unknown: 2,
  ok: 3,
};

/** One aircraft's line of the board summary. */
export interface BoardAircraftLine {
  aircraft: Aircraft;
  status: AircraftStatusLevel;
  overdue: number;
  dueSoon: number;
  openDiscrepancies: number;
  grounding: number;
  costs: BoardAircraftCosts | undefined;
}

/** One due item within the horizon, with the aircraft it belongs to. */
export interface BoardDueLine extends DueItem {
  registration: string;
  /** Whole days until the calendar limit; unset when no date limits it. */
  days?: number;
}

/** The whole board summary for one Flight Program. */
export interface BoardSummary {
  today: string;
  programName: string;
  fleet: Record<AircraftStatusLevel, number>;
  overdue: number;
  aircraft: BoardAircraftLine[];
  upcoming: BoardDueLine[];
  /** Null when the snapshot carries no backup time. */
  backup: OffsiteFreshness | null;
}

/**
 * Builds the board summary from a board snapshot or a program
 * administrator's snapshot (whose cost records it totals itself).
 *
 * @param s - The snapshot.
 * @param now - The current time (epoch ms); the clock by default.
 * @returns Aircraft in snapshot order. `upcoming` holds every due item that
 *   is overdue, due soon, or has a calendar limit within 30 days, worst first
 *   and then soonest first.
 */
export function boardSummary(s: Snapshot, now = Date.now()): BoardSummary {
  const today = localDate(now);
  const costs = s.boardCosts ?? boardCostTotals(s, today);
  const aircraft = s.aircraft.map((a) => summarizeAircraft(s, a, costs, today));
  const fleet = { airworthy: 0, "due-soon": 0, grounded: 0 };
  for (const line of aircraft) fleet[line.status] += 1;
  return {
    today,
    programName:
      s.programs?.find((p) => p.uuid === s.activeProgramUuid)?.name ?? "",
    fleet,
    overdue: aircraft.reduce((n, line) => n + line.overdue, 0),
    aircraft,
    upcoming: listUpcoming(s, today),
    backup:
      s.offsiteBackupAt === undefined
        ? null
        : offsiteFreshness({ completedAt: s.offsiteBackupAt }, now),
  };
}

function summarizeAircraft(
  s: Snapshot,
  a: Aircraft,
  costs: BoardAircraftCosts[],
  today: string,
): BoardAircraftLine {
  const due = ownerDueItems(s, a, today);
  const open = s.discrepancies.filter(
    (d) => d.aircraftUuid === a.uuid && d.status === "open",
  );
  return {
    aircraft: a,
    status: aircraftStatus(s, a.uuid, today).level,
    overdue: due.filter((i) => i.status === "overdue").length,
    dueSoon: due.filter((i) => i.status === "due-soon").length,
    openDiscrepancies: open.length,
    grounding: open.filter((d) => d.grounding && !d.deferral).length,
    costs: costs.find((c) => c.aircraftUuid === a.uuid),
  };
}

function listUpcoming(s: Snapshot, today: string): BoardDueLine[] {
  return s.aircraft
    .flatMap((a) => {
      const days = calendarDays(dueItems(s, a.uuid, today), today);
      return ownerDueItems(s, a, today).map((item) => ({
        ...item,
        registration: a.registration,
        days: days.get(item.uuid),
      }));
    })
    .filter(
      (i) =>
        i.status === "overdue" ||
        i.status === "due-soon" ||
        (i.days !== undefined && i.days <= BOARD_DUE_HORIZON_DAYS),
    )
    .sort(
      (x, y) =>
        STATUS_RANK[x.status] - STATUS_RANK[y.status] ||
        (x.days ?? Infinity) - (y.days ?? Infinity),
    );
}

// The calendar days left on each item that a date limits, by the uuid the
// owner's due row carries (an AD counts from its earliest task due date).
function calendarDays(items: MaintenanceDue[], today: string) {
  const days = new Map<string, number>();
  for (const item of items) {
    if (item.kind === "inspection" && item.due?.daysRemaining !== undefined)
      days.set(item.inspection.uuid, item.due.daysRemaining);
    if (item.kind === "componentRequirement" && item.due?.days !== undefined)
      days.set(item.requirement.uuid, item.due.days);
    if (item.kind === "ad") {
      const dates = item.ad.tasks.flatMap((t) =>
        t.dueDate ? [t.dueDate] : [],
      );
      if (dates.length)
        days.set(item.ad.uuid, daysUntil(today, dates.sort()[0]));
    }
  }
  return days;
}

// ISO dates parse as UTC midnight, so the difference is whole days.
const daysUntil = (today: string, date: string) =>
  Math.round((Date.parse(date) - Date.parse(today)) / DAY_MS);
