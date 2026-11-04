/**
 * Responsibility: An aircraft's inspection schedules: what remains of each
 *   limit, the status and a projected due date, sortable by what remains.
 * Layer: UI. React components; limits and status come from src/domain.
 * Dependencies: src/domain (model, management, maintenance,
 *   componentCalendar, forecast), ./ui.tsx.
 */
import { useState } from "react";
import type { Aircraft, Inspection, Snapshot } from "../domain/model";
import { inspectionCounters } from "../domain/management";
import { inspectionDueDate, inspectionStatus } from "../domain/maintenance";
import { daysPerServiceMonth } from "../domain/componentCalendar";
import { inspectionProjections } from "../domain/forecast";
import { Badge, Empty, Field } from "./ui";

const REMAINING_BY_SORT = {
  hours: "hoursRemaining",
  months: "daysRemaining",
  cycles: "cyclesRemaining",
  landings: "landingsRemaining",
} as const;
const FIRST_ORDER = { sort: "name", descending: false } as const;
const STATUS_TONES: Partial<Record<Remaining["status"], "danger" | "warning">> =
  { overdue: "danger", "due-soon": "warning" };

type Remaining = ReturnType<typeof inspectionStatus>;
type ScheduleRow = {
  inspection: Inspection;
  remaining: Remaining;
  projected?: string;
};
type ScheduleSort = "name" | keyof typeof REMAINING_BY_SORT;
type ScheduleOrder = { sort: ScheduleSort; descending: boolean };

/**
 * The aircraft's active inspections with what remains of each limit and
 * their status. Sorted by name (numbers in natural order) or by one limit's
 * remainder, ties by name; inspections without that limit sort last in
 * either order.
 *
 * @param props.state - The snapshot the remainders are measured from.
 * @throws As `inspectionStatus` and `inspectionProjections`.
 */
export function AircraftInspectionSchedules({
  aircraft,
  state,
}: {
  aircraft: Aircraft;
  state: Snapshot;
}) {
  const [order, setOrder] = useState<ScheduleOrder>(FIRST_ORDER);
  const rows = sortSchedules(scheduleRows(aircraft, state), order);
  return (
    <section aria-label="Inspection schedules">
      <h3>Inspection schedules</h3>
      <ScheduleSortFields order={order} onOrder={setOrder} />
      {rows.map((row) => (
        <ScheduleItem key={row.inspection.uuid} row={row} />
      ))}
      {!rows.length && <Empty title="Inspection information missing" />}
    </section>
  );
}

function scheduleRows(aircraft: Aircraft, state: Snapshot): ScheduleRow[] {
  const projected = inspectionProjections(state);
  return state.inspections
    .filter((i) => i.aircraftUuid === aircraft.uuid && !i.archived)
    .map((inspection) => ({
      inspection,
      remaining: inspectionStatus(
        inspection,
        aircraft,
        undefined,
        inspectionCounters(inspection, aircraft, state.management),
      ),
      projected: projected.get(inspection.uuid),
    }));
}

function sortSchedules(
  rows: ScheduleRow[],
  { sort, descending }: ScheduleOrder,
) {
  return rows.sort((a, b) => {
    const byName = scheduleName(a).localeCompare(scheduleName(b), undefined, {
      numeric: true,
      sensitivity: "base",
    });
    if (sort === "name") return descending ? -byName : byName;
    const av = a.remaining[REMAINING_BY_SORT[sort]];
    const bv = b.remaining[REMAINING_BY_SORT[sort]];
    if (av === undefined) return bv === undefined ? byName : 1;
    if (bv === undefined) return -1;
    return (descending ? bv - av : av - bv) || byName;
  });
}

function scheduleName({ inspection }: ScheduleRow) {
  return inspection.reference || inspection.description;
}

function ScheduleSortFields({
  order,
  onOrder,
}: {
  order: ScheduleOrder;
  onOrder: (order: ScheduleOrder) => void;
}) {
  const { sort, descending } = order;
  return (
    <div className="management-toolbar">
      <Field label="Sort inspection schedules by">
        <select
          value={sort}
          onChange={(e) =>
            onOrder({ ...order, sort: e.target.value as ScheduleSort })
          }
        >
          <option value="name">Inspection name</option>
          <option value="hours">Hours remaining</option>
          <option value="months">Months remaining</option>
          <option value="cycles">Cycles remaining</option>
          <option value="landings">Landings remaining</option>
        </select>
      </Field>
      <Field label="Inspection sort order">
        <select
          value={descending ? "descending" : "ascending"}
          onChange={(e) =>
            onOrder({ ...order, descending: e.target.value === "descending" })
          }
        >
          <option value="ascending">Ascending / least remaining first</option>
          <option value="descending">Descending / most remaining first</option>
        </select>
      </Field>
    </div>
  );
}

function ScheduleItem({ row }: { row: ScheduleRow }) {
  const { inspection: i, remaining: r, projected } = row;
  return (
    <div className="list-row">
      <div className="grow">
        <strong>{scheduleName(row)}</strong>
        <RemainingLimits row={row} />
        {i.calendarExempt && <small className="block">Calendar exempt</small>}
        {projected !== undefined && (
          <small className="block">Projected ~{projected}</small>
        )}
        {r.status === "unknown" && (
          <small className="block">Remaining units not available</small>
        )}
      </div>
      <Badge tone={STATUS_TONES[r.status] ?? "neutral"}>{r.status}</Badge>
    </div>
  );
}

function RemainingLimits({ row }: { row: ScheduleRow }) {
  const { inspection, remaining: r } = row;
  return (
    <>
      {r.hoursRemaining !== undefined && (
        <small className="block">
          {remainingText(r.hoursRemaining, "hours", 1)}
        </small>
      )}
      {r.daysRemaining !== undefined && (
        <small className="block">
          {remainingText(r.daysRemaining / daysPerServiceMonth, "months", 1)}{" "}
          (approx.) · Due {inspectionDueDate(inspection)}
        </small>
      )}
      {r.cyclesRemaining !== undefined && (
        <small className="block">
          {remainingText(r.cyclesRemaining, "cycles", 0)}
        </small>
      )}
      {r.landingsRemaining !== undefined && (
        <small className="block">
          {remainingText(r.landingsRemaining, "landings", 0)}
        </small>
      )}
    </>
  );
}

function remainingText(value: number, unit: string, decimals: number) {
  const amount = `${Math.abs(value).toFixed(decimals)} ${unit}`;
  if (value < 0) return `${amount} overdue`;
  return `${amount} ${value === 0 ? "remaining — due now" : "remaining"}`;
}
