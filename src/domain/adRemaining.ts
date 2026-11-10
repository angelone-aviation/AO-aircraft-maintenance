/**
 * Responsibility: The "remaining" lines (hours, months, cycles, landings) shown
 *   for one AD task that is still to be done.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ./airworthiness, ./componentCalendar, ./model.
 */
import {
  adCounters,
  adTaskStatus,
  CLOSED_APPLICABILITY,
  type AD,
  type ADTask,
} from "./airworthiness";
import { daysPerServiceMonth } from "./componentCalendar";
import { localDate, type Snapshot } from "./model";

const SECONDS_PER_HOUR = 3600;
const MS_PER_DAY = 86_400_000;
const DUE_NOT_SET = "Due not set";
const COUNTER_UNAVAILABLE = "Counter unavailable";

type RemainingRow = { label: string; value: string };

/**
 * Lists what is left before an AD task falls due, one row for each limit or
 * repeat interval the task sets, in the order hours, months, cycles,
 * landings. A first limit without a repeat interval ("within 50 hours") is
 * listed like a repeating one.
 *
 * @param state - The snapshot holding the aircraft and component counters.
 * @param record - The AD the task belongs to.
 * @param task - The task to measure.
 * @param today - The local date the approximate months count from and a
 *   component's totals are read on.
 * @returns Rows such as `{ label: "Hours remaining", value: "42.5" }`, with
 *   "<n> overdue" below 0; none once compliance has ended the task or the
 *   AD no longer applies.
 */
export function adRemaining(
  state: Snapshot,
  record: AD,
  task: ADTask,
  today = localDate(),
): RemainingRow[] {
  if (!isStillDue(state, record, task, today)) return [];
  const counters = availableCounters(state, record, today);
  const rows: RemainingRow[] = [];
  if (task.intervalHours || task.dueHours !== null)
    rows.push({
      label: "Hours remaining",
      value: usageValue(task.dueHours, counters.hours, 1, roundToSecond),
    });
  if (task.intervalDays || task.dueDate)
    rows.push({
      label: "Months remaining (approx.)",
      value: monthsValue(task.dueDate, today),
    });
  if (task.intervalCycles || task.dueCycles !== null)
    rows.push({
      label: "Cycles remaining",
      value: usageValue(task.dueCycles, counters.cycles, 0),
    });
  if (task.intervalLandings || task.dueLandings != null)
    rows.push({
      label: "Landings remaining",
      value: usageValue(task.dueLandings ?? null, counters.landings, 0),
    });
  return rows;
}

function isStillDue(state: Snapshot, record: AD, task: ADTask, today: string) {
  return !(
    CLOSED_APPLICABILITY.includes(record.applicability) ||
    adTaskStatus(state, record, task, today) === "Complied"
  );
}

// A component AD counts only the hours and cycles that component tracks;
// landings always come from the aircraft.
function availableCounters(state: Snapshot, record: AD, today: string) {
  const counters = adCounters(state, record, today);
  const component = state.management?.find(
    (item) => item.kind === "component" && item.uuid === record.componentUuid,
  );
  const tracks = (kind: "trackTime" | "trackCycles") =>
    !record.componentUuid ||
    (component?.kind === "component" && component[kind]);
  return {
    hours: counters && tracks("trackTime") ? counters.hours : null,
    cycles: counters && tracks("trackCycles") ? counters.cycles : null,
    landings: counters ? counters.landings : null,
  };
}

// A usage limit is reached at 0 remaining (adTaskStatus), so 0 reads "Due
// now", as on component screens.
function usageValue(
  due: number | null,
  current: number | null,
  digits: number,
  round = (left: number) => left,
) {
  if (due === null) return DUE_NOT_SET;
  if (current === null) return COUNTER_UNAVAILABLE;
  const left = round(due - current);
  return left === 0 ? "Due now" : formatLeft(left, digits);
}

// Hours compare in whole seconds, as adTaskStatus does, so floating-point
// noise cannot turn "Due now" into "0.0 overdue".
function roundToSecond(hours: number) {
  return Math.round(hours * SECONDS_PER_HOUR) / SECONDS_PER_HOUR;
}

// Approximate: service months of 30.4375 days. A calendar limit stays valid
// through its due date, so 0 is never "Due now".
function monthsValue(dueDate: string, today: string) {
  if (!dueDate) return DUE_NOT_SET;
  const days = (Date.parse(dueDate) - Date.parse(today)) / MS_PER_DAY;
  return formatLeft(days / daysPerServiceMonth, 1);
}

function formatLeft(value: number, digits: number) {
  return value < 0
    ? `${Math.abs(value).toFixed(digits)} overdue`
    : value.toFixed(digits);
}
