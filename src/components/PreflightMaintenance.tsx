/**
 * Responsibility: The maintenance summary a pilot reviews when starting a
 *   flight: aircraft status, inspections needing review, open discrepancies
 *   and open work orders on one aircraft.
 * Layer: UI. Renders the snapshot it is given; due status and open work
 *   orders are decided in src/domain.
 * Dependencies: src/domain/model.ts (types), src/domain/management.ts
 *   (inspection counters), src/domain/maintenance.ts (due date and status),
 *   src/domain/workOrders.ts (open work orders).
 */
import type {
  Aircraft,
  Discrepancy,
  Inspection,
  Snapshot,
} from "../domain/model";
import { inspectionCounters } from "../domain/management";
import { inspectionDueDate, inspectionStatus } from "../domain/maintenance";
import { isOpenWorkOrder, type WorkOrder } from "../domain/workOrders";

type InspectionReview = ReturnType<typeof inspectionStatus> & {
  inspection: Inspection;
};
type ReviewStatus = InspectionReview["status"];
type MaintenanceSummary = ReturnType<typeof summarizeMaintenance>;
type MetricTone = "attention" | "upcoming";
type Metric = [
  shown: boolean,
  tone: MetricTone,
  label: string,
  value: string | number,
];

const REVIEW_ORDER: Record<ReviewStatus, number> = {
  overdue: 0,
  unknown: 1,
  "due-soon": 2,
  scheduled: 3,
};

// Names what is missing, where the domain's inspectionStatusLabels says
// "Unknown".
const STATUS_LABELS: Record<ReviewStatus, string> = {
  overdue: "Overdue",
  unknown: "Due data missing",
  "due-soon": "Due soon",
  scheduled: "Scheduled",
};

/**
 * The maintenance summary a pilot reviews before starting a flight.
 *
 * @param props.aircraft - The aircraft about to fly.
 * @param props.snapshot - Workspace data holding its inspections,
 *   discrepancies and work orders; archived inspections are left out.
 * @returns A "Maintenance summary" section: count tiles for what needs
 *   review, an all-clear note when nothing does, and collapsible lists of
 *   inspections needing review (overdue, then missing due data, then due
 *   soon; by reference within each), open discrepancies and open work orders.
 */
export function PreflightMaintenance({
  aircraft,
  snapshot,
}: {
  aircraft: Aircraft;
  snapshot: Snapshot;
}) {
  const summary = summarizeMaintenance(aircraft, snapshot);
  return (
    <section className="preflight-maintenance" aria-label="Maintenance summary">
      <div className="preflight-metrics">
        {listMetrics(aircraft, summary).map(([, tone, label, value]) => (
          <div key={label} className={`preflight-metric ${tone}`}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      {isAllClear(aircraft, summary) && (
        <p className="callout">
          No due inspections or items needing review in the recorded maintenance
          data.
        </p>
      )}
      <InspectionDetails summary={summary} />
      <DiscrepancyDetails discrepancies={summary.discrepancies} />
      <WorkOrderDetails orders={summary.orders} />
    </section>
  );
}

function summarizeMaintenance(aircraft: Aircraft, snapshot: Snapshot) {
  const inspections = reviewInspections(aircraft, snapshot);
  const count = (status: ReviewStatus) =>
    inspections.filter((review) => review.status === status).length;
  return {
    inspections,
    needingReview: inspections.filter(
      (review) => review.status !== "scheduled",
    ),
    overdue: count("overdue"),
    upcoming: count("due-soon"),
    unknown: count("unknown"),
    discrepancies: snapshot.discrepancies.filter(
      (d) => d.aircraftUuid === aircraft.uuid && d.status === "open",
    ),
    orders: (snapshot.workOrders ?? []).filter(
      (w) => w.aircraftUuid === aircraft.uuid && isOpenWorkOrder(w),
    ),
  };
}

function reviewInspections(
  aircraft: Aircraft,
  snapshot: Snapshot,
): InspectionReview[] {
  return snapshot.inspections
    .filter((i) => i.aircraftUuid === aircraft.uuid && !i.archived)
    .map((inspection) => ({
      inspection,
      ...inspectionStatus(
        inspection,
        aircraft,
        undefined,
        inspectionCounters(inspection, aircraft, snapshot.management),
      ),
    }))
    .sort(
      (a, b) =>
        REVIEW_ORDER[a.status] - REVIEW_ORDER[b.status] ||
        a.inspection.reference.localeCompare(b.inspection.reference),
    );
}

function listMetrics(aircraft: Aircraft, summary: MaintenanceSummary) {
  const { inspections, overdue, upcoming, unknown } = summary;
  const { discrepancies, orders } = summary;
  const status = aircraft.operationalStatus;
  const metrics: Metric[] = [
    [status !== "airworthy", "attention", "Aircraft status to review", status],
    [!!overdue, "attention", "Overdue inspections", overdue],
    [!!upcoming, "upcoming", "Due soon", upcoming],
    [!!unknown, "upcoming", "Missing due data", unknown],
    [
      !inspections.length,
      "upcoming",
      "Inspection data to review",
      "Not recorded",
    ],
    [
      !!discrepancies.length,
      "attention",
      "Open discrepancies",
      discrepancies.length,
    ],
    [!!orders.length, "upcoming", "Open work orders", orders.length],
  ];
  return metrics.filter(([shown]) => shown);
}

function isAllClear(aircraft: Aircraft, summary: MaintenanceSummary) {
  return (
    aircraft.operationalStatus === "airworthy" &&
    !!summary.inspections.length &&
    !summary.needingReview.length &&
    !summary.discrepancies.length &&
    !summary.orders.length
  );
}

function InspectionDetails({ summary }: { summary: MaintenanceSummary }) {
  const { needingReview, overdue, upcoming, unknown } = summary;
  if (!needingReview.length) return null;
  return (
    <details className="preflight-review-details">
      <summary>
        Inspections needing review ({needingReview.length}) · {overdue} overdue
        · {upcoming} due soon · {unknown} missing due data
      </summary>
      <div className="table-wrap">
        <table className="inspection-table">
          <thead>
            <tr>
              <th>Inspection</th>
              <th>Status</th>
              <th>Due / remaining</th>
            </tr>
          </thead>
          <tbody>
            {needingReview.map((review) => (
              <InspectionRow key={review.inspection.uuid} review={review} />
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function InspectionRow({ review }: { review: InspectionReview }) {
  const { inspection, status, hoursRemaining } = review;
  const { cyclesRemaining, landingsRemaining } = review;
  return (
    <tr>
      <td>
        <strong>{inspection.reference}</strong>
        <br />
        {inspection.description}
      </td>
      <td>{STATUS_LABELS[status]}</td>
      <td>
        {inspection.calendarExempt
          ? "Calendar exempt"
          : inspectionDueDate(inspection)}
        {hoursRemaining !== undefined && (
          <div>{describeRemaining(hoursRemaining, "h", 1)}</div>
        )}
        {landingsRemaining !== undefined && (
          <span>{describeRemaining(landingsRemaining, "landings")}</span>
        )}
        {cyclesRemaining !== undefined && (
          <div>{describeRemaining(cyclesRemaining, "cycles")}</div>
        )}
        {status === "unknown" && "No due thresholds recorded"}
      </td>
    </tr>
  );
}

function DiscrepancyDetails({
  discrepancies,
}: {
  discrepancies: Discrepancy[];
}) {
  if (!discrepancies.length) return null;
  return (
    <details className="preflight-review-details">
      <summary>Open discrepancies ({discrepancies.length})</summary>
      {discrepancies.map((d) => (
        <p key={d.uuid}>{d.description}</p>
      ))}
    </details>
  );
}

function WorkOrderDetails({ orders }: { orders: WorkOrder[] }) {
  if (!orders.length) return null;
  return (
    <details className="preflight-review-details">
      <summary>Open work orders ({orders.length})</summary>
      {orders.map((w) => (
        <p key={w.uuid}>
          <strong>{w.number}</strong> · {w.status} · {w.tasks.length} tasks
        </p>
      ))}
    </details>
  );
}

// A counter at its limit reads as due, as the domain's overdue rule counts it.
function describeRemaining(
  remaining: number,
  unit: string,
  decimals?: number,
): string {
  const amount = Math.abs(remaining);
  const shown = decimals === undefined ? amount : amount.toFixed(decimals);
  return `${shown} ${unit} ${remaining <= 0 ? "overdue / due now" : "remaining"}`;
}
