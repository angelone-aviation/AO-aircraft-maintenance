import { useState } from "react";
import type { Aircraft, Snapshot } from "../domain/model";
import { inspectionCounters } from "../domain/management";
import { inspectionDueDate, inspectionStatus } from "../domain/maintenance";
import { daysPerServiceMonth } from "../domain/componentCalendar";
import { inspectionProjections } from "../domain/forecast";
import { Badge, Empty, Field } from "./ui";

export function AircraftInspectionSchedules({
  aircraft,
  state,
}: {
  aircraft: Aircraft;
  state: Snapshot;
}) {
  const [sort, setSort] = useState("name");
  const [descending, setDescending] = useState(false);
  const projected = inspectionProjections(state);
  const rows = state.inspections
    .filter((i) => i.aircraftUuid === aircraft.uuid && !i.archived)
    .map((inspection) => ({
      inspection,
      remaining: inspectionStatus(
        inspection,
        aircraft,
        undefined,
        inspectionCounters(inspection, aircraft, state.management),
      ),
    }));
  const name = (row: (typeof rows)[number]) =>
    row.inspection.reference || row.inspection.description;
  const value = (row: (typeof rows)[number]) =>
    sort === "hours"
      ? row.remaining.hoursRemaining
      : sort === "months"
        ? row.remaining.daysRemaining
        : sort === "landings"
          ? row.remaining.landingsRemaining
          : row.remaining.cyclesRemaining;
  rows.sort((a, b) => {
    const byName = name(a).localeCompare(name(b), undefined, {
      numeric: true,
      sensitivity: "base",
    });
    if (sort === "name") return descending ? -byName : byName;
    const av = value(a),
      bv = value(b);
    if (av === undefined) return bv === undefined ? byName : 1;
    if (bv === undefined) return -1;
    return (descending ? bv - av : av - bv) || byName;
  });
  const format = (value: number, unit: string, decimals: number) =>
    `${Math.abs(value).toFixed(decimals)} ${unit} ${value < 0 ? "overdue" : value === 0 ? "remaining — due now" : "remaining"}`;
  return (
    <section aria-label="Inspection schedules">
      <h3>Inspection schedules</h3>
      <div className="management-toolbar">
        <Field label="Sort inspection schedules by">
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
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
            onChange={(e) => setDescending(e.target.value === "descending")}
          >
            <option value="ascending">Ascending / least remaining first</option>
            <option value="descending">
              Descending / most remaining first
            </option>
          </select>
        </Field>
      </div>
      {rows.map(({ inspection: i, remaining: r }) => (
        <div className="list-row" key={i.uuid}>
          <div className="grow">
            <strong>{name({ inspection: i, remaining: r })}</strong>
            {r.hoursRemaining !== undefined && (
              <small className="block">
                {format(r.hoursRemaining, "hours", 1)}
              </small>
            )}
            {r.daysRemaining !== undefined && (
              <small className="block">
                {format(r.daysRemaining / daysPerServiceMonth, "months", 1)}{" "}
                (approx.) · Due {inspectionDueDate(i)}
              </small>
            )}
            {r.cyclesRemaining !== undefined && (
              <small className="block">
                {format(r.cyclesRemaining, "cycles", 0)}
              </small>
            )}
            {r.landingsRemaining !== undefined && (
              <small className="block">
                {format(r.landingsRemaining, "landings", 0)}
              </small>
            )}
            {i.calendarExempt && (
              <small className="block">Calendar exempt</small>
            )}
            {projected.has(i.uuid) && (
              <small className="block">
                Projected ~{projected.get(i.uuid)}
              </small>
            )}
            {r.status === "unknown" && (
              <small className="block">Remaining units not available</small>
            )}
          </div>
          <Badge
            tone={
              r.status === "overdue"
                ? "danger"
                : r.status === "due-soon"
                  ? "warning"
                  : "neutral"
            }
          >
            {r.status}
          </Badge>
        </div>
      ))}
      {!rows.length && <Empty title="Inspection information missing" />}
    </section>
  );
}
