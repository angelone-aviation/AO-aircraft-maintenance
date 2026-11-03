import { lastCompliance } from "./adCompliance";
import { adCounters, type AD, type ADTask } from "./airworthiness";
import { daysPerServiceMonth } from "./componentCalendar";
import { localDate, type Snapshot } from "./model";

export function adRemaining(
  state: Snapshot,
  record: AD,
  task: ADTask,
  today = localDate(),
): { label: string; value: string }[] {
  const last = lastCompliance(record, task.uuid);
  if (
    task.recurrence === "One-time" ||
    last?.terminatedBy ||
    ["Not applicable", "Superseded"].includes(record.applicability)
  )
    return [];
  const counters = adCounters(state, record);
  const component = state.management?.find(
    (item) => item.kind === "component" && item.uuid === record.componentUuid,
  );
  const available = (kind: "hours" | "cycles") =>
    counters &&
    (!record.componentUuid ||
      (component?.kind === "component" &&
        (kind === "hours" ? component.trackTime : component.trackCycles)));
  const format = (value: number, digits: number) =>
    value < 0
      ? `${Math.abs(value).toFixed(digits)} overdue`
      : value.toFixed(digits);
  // A usage limit is reached at 0 remaining (adTaskStatus): "Due now", as on
  // component screens. Hours compare in whole seconds.
  const usage = (value: number, digits: number) =>
    value === 0 ? "Due now" : format(value, digits);
  const rows: { label: string; value: string }[] = [];
  if (task.intervalHours)
    rows.push({
      label: "Hours remaining",
      value:
        task.dueHours === null
          ? "Due not set"
          : !available("hours")
            ? "Counter unavailable"
            : usage(
                Math.round((task.dueHours - counters!.hours) * 3600) / 3600,
                1,
              ),
    });
  if (task.intervalDays)
    rows.push({
      label: "Months remaining (approx.)",
      value: !task.dueDate
        ? "Due not set"
        : format(
            (Date.parse(task.dueDate) - Date.parse(today)) /
              86400000 /
              daysPerServiceMonth,
            1,
          ),
    });
  if (task.intervalCycles)
    rows.push({
      label: "Cycles remaining",
      value:
        task.dueCycles === null
          ? "Due not set"
          : !available("cycles")
            ? "Counter unavailable"
            : usage(task.dueCycles - counters!.cycles, 0),
    });
  if (task.intervalLandings)
    rows.push({
      label: "Landings remaining",
      value:
        task.dueLandings == null
          ? "Due not set"
          : !counters
            ? "Counter unavailable"
            : usage(task.dueLandings - counters.landings, 0),
    });
  return rows;
}
