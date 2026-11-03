import { useState } from "react";
import { useWorkspace, previewDemoOwner } from "../data/store";
import {
  aircraftMeterLabels,
  hours,
  totalSeconds,
  type Aircraft,
  type Snapshot,
} from "../domain/model";
import { ownerDueItems, type DueItem } from "../domain/ownerDue";
import { AircraftStatusSummary } from "./AircraftStatus";
import { ExportAircraftStatus } from "./ExportAircraftStatus";
import { AircraftForm337 } from "./AircraftFiles";
import { Badge, Empty, PageTitle } from "./ui";

const RECENT_WORK_ORDERS = 5;
const tone = {
  overdue: "danger",
  "due-soon": "warning",
  ok: "good",
  unknown: "neutral",
} as const;
const statusLabel = {
  overdue: "Overdue",
  "due-soon": "Due soon",
  ok: "Scheduled",
  unknown: "Needs review",
};

function ADReportButton({
  state,
  aircraft,
}: {
  state: Snapshot;
  aircraft: Aircraft;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div>
      <button
        className="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            const { saveADReport } = await import("../data/adReport");
            saveADReport(state, aircraft.uuid);
          } catch (e) {
            setError(
              e instanceof Error ? e.message : "Unable to export AD report.",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Generating PDF…" : "AD compliance report"}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

function OwnerAircraft({
  state,
  aircraft: a,
}: {
  state: Snapshot;
  aircraft: Aircraft;
}) {
  const items = ownerDueItems(state, a);
  const reports = state.discrepancies.filter(
    (d) => d.aircraftUuid === a.uuid && d.status === "open",
  );
  const orders = (state.workOrders ?? [])
    .filter((w) => w.aircraftUuid === a.uuid && w.status === "completed")
    .sort((x, y) => y.completionDate.localeCompare(x.completionDate))
    .slice(0, RECENT_WORK_ORDERS);
  return (
    <section className="panel" aria-labelledby={`owner-${a.uuid}`}>
      <div className="section-heading compact">
        <div>
          <h2 id={`owner-${a.uuid}`}>{a.registration}</h2>
          <p className="muted">
            {a.make} {a.model} · Serial {a.serial}
          </p>
        </div>
        <AircraftStatusSummary
          aircraftUuid={a.uuid}
          registration={a.registration}
        />
      </div>
      <dl className="details">
        <dt>Total time ({aircraftMeterLabels[a.meter]})</dt>
        <dd>{hours(totalSeconds(a))} h</dd>
        <dt>Cycles</dt>
        <dd>{a.cycles.toLocaleString()}</dd>
        <dt>Landings</dt>
        <dd>{a.landings.toLocaleString()}</dd>
      </dl>
      <h3>Next due</h3>
      {items.length ? (
        items.map((i) => (
          <div className="list-row" key={i.uuid}>
            <div className="grow">
              <strong>{i.label}</strong>
              <small>
                {i.kind} · {i.remaining}
              </small>
            </div>
            <Badge tone={tone[i.status]}>{statusLabel[i.status]}</Badge>
          </div>
        ))
      ) : (
        <p className="muted">
          No inspections, component limits or ADs recorded.
        </p>
      )}
      <h3>Open discrepancies</h3>
      {reports.length ? (
        reports.map((d) => (
          <div className="list-row" key={d.uuid}>
            <div className="grow">
              <strong>{d.description}</strong>
            </div>
            <Badge tone="warning">Open</Badge>
          </div>
        ))
      ) : (
        <p className="muted">No open discrepancies.</p>
      )}
      <h3>Recently completed work</h3>
      {orders.length ? (
        orders.map((w) => (
          <div className="list-row" key={w.uuid}>
            <div className="grow">
              <strong>
                {w.number || "Work order"} · {w.completionDate}
              </strong>
              <small>{w.scope || "No summary recorded"}</small>
            </div>
          </div>
        ))
      ) : (
        <p className="muted">No completed work orders.</p>
      )}
      <AircraftForm337 state={state} aircraft={a} />
      <div className="filters">
        <ExportAircraftStatus state={state} aircraftUuid={a.uuid} />
        <ADReportButton state={state} aircraft={a} />
      </div>
    </section>
  );
}

/** Read-only portal for aircraft owners; rendered for every route. */
export function OwnerPortal() {
  const { snapshot: s, demo } = useWorkspace();
  const [error, setError] = useState("");
  return (
    <>
      <PageTitle
        eyebrow="OWNER PORTAL"
        title="Your aircraft"
        description="Current totals, upcoming maintenance and completed work. Read-only."
        action={
          demo && (
            <button
              className="button"
              onClick={() =>
                previewDemoOwner(false).catch((e) =>
                  setError(e instanceof Error ? e.message : String(e)),
                )
              }
            >
              Exit owner preview
            </button>
          )
        }
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {s!.aircraft.map((a) => (
        <OwnerAircraft key={a.uuid} state={s!} aircraft={a} />
      ))}
      {!s!.aircraft.length && (
        <Empty title="No aircraft assigned">
          Ask your Flight Program administrator to assign your aircraft.
        </Empty>
      )}
      <p className="muted">
        Recorded status only. Missing information never implies aircraft
        readiness; this is not a maintenance release.
      </p>
    </>
  );
}
