import type { Aircraft, Snapshot } from "../domain/model";
import { inspectionCounters } from "../domain/management";
import { inspectionDueDate, inspectionStatus } from "../domain/maintenance";

const priority = { overdue: 0, unknown: 1, "due-soon": 2, scheduled: 3 };
export function PreflightMaintenance({
  aircraft,
  snapshot,
}: {
  aircraft: Aircraft;
  snapshot: Snapshot;
}) {
  const inspections = snapshot.inspections
    .filter((i) => i.aircraftUuid === aircraft.uuid && !i.archived)
    .map((i) => ({
      i,
      ...inspectionStatus(
        i,
        aircraft,
        undefined,
        inspectionCounters(i, aircraft, snapshot.management),
      ),
    }))
    .sort(
      (a, b) =>
        priority[a.status] - priority[b.status] ||
        a.i.reference.localeCompare(b.i.reference),
    );
  const discrepancies = snapshot.discrepancies.filter(
    (d) => d.aircraftUuid === aircraft.uuid && d.status === "open",
  );
  const orders = (snapshot.workOrders ?? []).filter(
    (w) =>
      w.aircraftUuid === aircraft.uuid &&
      !["completed", "cancelled"].includes(w.status),
  );
  const overdue = inspections.filter((i) => i.status === "overdue").length;
  const upcoming = inspections.filter((i) => i.status === "due-soon").length;
  const unknown = inspections.filter((i) => i.status === "unknown").length;
  const attention = inspections.filter((i) => i.status !== "scheduled");
  const statusLabel = (status: string) =>
    status === "unknown"
      ? "Due data missing"
      : status === "due-soon"
        ? "Due soon"
        : status === "overdue"
          ? "Overdue"
          : "Scheduled";
  return (
    <section className="preflight-maintenance" aria-label="Maintenance summary">
      <div className="preflight-metrics">
        {aircraft.operationalStatus !== "airworthy" && (
          <div className="preflight-metric attention">
            <span>Aircraft status to review</span>
            <strong>{aircraft.operationalStatus}</strong>
          </div>
        )}
        {!!overdue && (
          <div className="preflight-metric attention">
            <span>Overdue inspections</span>
            <strong>{overdue}</strong>
          </div>
        )}
        {!!upcoming && (
          <div className="preflight-metric upcoming">
            <span>Due soon</span>
            <strong>{upcoming}</strong>
          </div>
        )}
        {!!unknown && (
          <div className="preflight-metric upcoming">
            <span>Missing due data</span>
            <strong>{unknown}</strong>
          </div>
        )}
        {!inspections.length && (
          <div className="preflight-metric upcoming">
            <span>Inspection data to review</span>
            <strong>Not recorded</strong>
          </div>
        )}
        {!!discrepancies.length && (
          <div className="preflight-metric attention">
            <span>Open discrepancies</span>
            <strong>{discrepancies.length}</strong>
          </div>
        )}
        {!!orders.length && (
          <div className="preflight-metric upcoming">
            <span>Open work orders</span>
            <strong>{orders.length}</strong>
          </div>
        )}
      </div>
      {!attention.length &&
        !!inspections.length &&
        !discrepancies.length &&
        !orders.length &&
        aircraft.operationalStatus === "airworthy" && (
          <p className="callout">
            No due inspections or items needing review in the recorded
            maintenance data.
          </p>
        )}
      {!!attention.length && (
        <details className="preflight-review-details">
          <summary>
            Inspections needing review ({attention.length}) · {overdue} overdue
            · {upcoming} due soon · {unknown} missing due data
          </summary>
          {!inspections.length ? (
            <p>No inspection schedules recorded for this aircraft.</p>
          ) : (
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
                  {attention.map(
                    ({
                      i,
                      status,
                      hoursRemaining,
                      cyclesRemaining,
                      landingsRemaining,
                    }) => (
                      <tr key={i.uuid}>
                        <td>
                          <strong>{i.reference}</strong>
                          <br />
                          {i.description}
                        </td>
                        <td>{statusLabel(status)}</td>
                        <td>
                          {i.calendarExempt
                            ? "Calendar exempt"
                            : inspectionDueDate(i)}
                          {hoursRemaining !== undefined && (
                            <div>
                              {Math.abs(hoursRemaining).toFixed(1)} h{" "}
                              {hoursRemaining <= 0
                                ? "overdue / due now"
                                : "remaining"}
                            </div>
                          )}
                          {landingsRemaining !== undefined && (
                            <span>
                              {Math.abs(landingsRemaining)} landings{" "}
                              {landingsRemaining <= 0
                                ? "overdue / due now"
                                : "remaining"}
                            </span>
                          )}
                          {cyclesRemaining !== undefined && (
                            <div>
                              {Math.abs(cyclesRemaining)} cycles{" "}
                              {cyclesRemaining <= 0
                                ? "overdue / due now"
                                : "remaining"}
                            </div>
                          )}
                          {status === "unknown" && "No due thresholds recorded"}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </details>
      )}
      {!!discrepancies.length && (
        <details className="preflight-review-details">
          <summary>Open discrepancies ({discrepancies.length})</summary>
          {discrepancies.length ? (
            discrepancies.map((d) => <p key={d.uuid}>{d.description}</p>)
          ) : (
            <p>No open discrepancies recorded.</p>
          )}
        </details>
      )}
      {!!orders.length && (
        <details className="preflight-review-details">
          <summary>Open work orders ({orders.length})</summary>
          {orders.length ? (
            orders.map((w) => (
              <p key={w.uuid}>
                <strong>{w.number}</strong> · {w.status} · {w.tasks.length}{" "}
                tasks
              </p>
            ))
          ) : (
            <p>No open work orders recorded.</p>
          )}
        </details>
      )}
    </section>
  );
}
