import { componentAircraftSeconds } from "./components";
import { localDate, type Aircraft, type Inspection } from "./model";
export function endOfDueMonth(
  lastDate: string,
  intervalMonths: number,
): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(lastDate) ||
    !Number.isInteger(intervalMonths) ||
    intervalMonths < 1
  )
    throw new Error("A valid date and positive month interval are required.");
  const date = new Date(lastDate + "T00:00:00Z");
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== lastDate
  )
    throw new Error("Invalid calendar date.");
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + intervalMonths + 1, 0),
  )
    .toISOString()
    .slice(0, 10);
}
// Recurring deadlines derive from compliance; saved due dates may be stale.
export function inspectionDueDate(inspection: Inspection): string | undefined {
  if (inspection.calendarExempt) return undefined;
  return inspection.lastDate && inspection.intervalMonths
    ? endOfDueMonth(inspection.lastDate, inspection.intervalMonths)
    : inspection.dueDate;
}
export function inspectionStatus(
  inspection: Inspection,
  aircraft: Aircraft,
  today = localDate(),
  counters = {
    seconds: componentAircraftSeconds(inspection, aircraft),
    cycles: aircraft.cycles,
  },
) {
  const hoursRemaining =
    inspection.dueSeconds === undefined
      ? undefined
      : (inspection.dueSeconds - counters.seconds) / 3600;
  const cyclesRemaining =
    inspection.dueCycles === undefined
      ? undefined
      : inspection.dueCycles - counters.cycles;
  const landingsRemaining =
    inspection.dueLandings === undefined
      ? undefined
      : inspection.dueLandings - aircraft.landings;
  const dueDate = inspectionDueDate(inspection);
  const daysRemaining = dueDate
    ? Math.round(
        (Date.parse(dueDate + "T00:00:00Z") -
          Date.parse(today + "T00:00:00Z")) /
          86400000,
      )
    : undefined;
  const known = inspectionLimits({
    hoursRemaining,
    cyclesRemaining,
    landingsRemaining,
    daysRemaining,
  });
  return {
    hoursRemaining,
    cyclesRemaining,
    landingsRemaining,
    daysRemaining,
    status: !known.length
      ? inspection.calendarExempt
        ? "scheduled"
        : "unknown"
      : known.some((l) => l.overdue)
        ? "overdue"
        : known.some((l) => l.dueSoon)
          ? "due-soon"
          : "scheduled",
  } as const;
}
export const inspectionStatusLabels: Record<
  ReturnType<typeof inspectionStatus>["status"],
  string
> = {
  overdue: "Overdue",
  "due-soon": "Due soon",
  scheduled: "Scheduled",
  unknown: "Unknown",
};
/** How near each tracked limit an inspection becomes due soon. */
const dueSoonWithin = { hours: 10, days: 30, cycles: 10, landings: 10 };
export type InspectionDimension = keyof typeof dueSoonWithin;
type Remaining = {
  [D in InspectionDimension as `${D}Remaining`]?: number;
};
function inspectionLimits(remaining: Remaining) {
  return (Object.keys(dueSoonWithin) as InspectionDimension[]).flatMap(
    (dimension) => {
      const value = remaining[`${dimension}Remaining`];
      if (value === undefined) return [];
      return [
        {
          dimension,
          remaining: value,
          // A calendar limit is still met on its due day; a counter at its
          // limit is not.
          overdue: dimension === "days" ? value < 0 : value <= 0,
          dueSoon: value <= dueSoonWithin[dimension],
          /** Remaining share of the due-soon allowance; lower is more urgent. */
          urgency: value / dueSoonWithin[dimension],
        },
      ];
    },
  );
}
export type InspectionLimit = ReturnType<typeof inspectionLimits>[number];
/** The limit that drives an inspection's status: the most overdue one, or
 * else the one closest to its limit relative to its due-soon allowance. Its
 * `urgency` also orders inspections that share a status. */
export function inspectionDueLimit(
  remaining: Remaining,
): InspectionLimit | undefined {
  const known = inspectionLimits(remaining);
  const overdue = known.filter((l) => l.overdue);
  return (overdue.length ? overdue : known).reduce<InspectionLimit | undefined>(
    (most, l) => (!most || l.urgency < most.urgency ? l : most),
    undefined,
  );
}
