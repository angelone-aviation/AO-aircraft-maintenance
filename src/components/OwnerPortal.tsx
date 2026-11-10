/**
 * Responsibility: The read-only owner portal: an owner's aircraft with their
 *   totals, upcoming maintenance, completed work and reports.
 * Layer: UI. React components; reads the owner's snapshot and changes no
 *   records.
 * Dependencies: react, src/data/store.ts, src/data/adReport.ts (on demand),
 *   src/domain/model.ts, src/domain/ownerDue.ts, src/domain/ownerView.ts,
 *   ./AircraftFiles, ./AircraftStatus, ./ExportAircraftStatus, ./design, ./ui.
 */
import { useState } from "react";
import { useWorkspace, previewDemoOwner } from "../data/store";
import {
  aircraftMeterLabels,
  hours,
  recordedTotalSeconds,
  type Aircraft,
  type Snapshot,
} from "../domain/model";
import { ownerDueItems, type DueItem } from "../domain/ownerDue";
import { ownerPortalAircraft } from "../domain/ownerView";
import { AircraftStatusSummary } from "./AircraftStatus";
import { ExportAircraftStatus } from "./ExportAircraftStatus";
import { AircraftForm337 } from "./AircraftFiles";
import { Empty, PageTitle, errorText } from "./ui";
import { StatusPill } from "./design";

const RECENT_WORK_ORDERS = 5;
const DUE_BADGES = {
  overdue: { tone: "danger", label: "Overdue" },
  "due-soon": { tone: "warning", label: "Due soon" },
  ok: { tone: "good", label: "Scheduled" },
  unknown: { tone: "neutral", label: "Needs review" },
} as const;

type AircraftProps = { state: Snapshot; aircraft: Aircraft };

/**
 * The owner portal, shown for every route of an owner view: each of the
 * owner's aircraft with its totals, next due items, open discrepancies, five
 * most recently completed work orders, Form 337 copies and reports. In the
 * demo's owner preview it offers a way back.
 *
 * @returns The portal; it changes no records.
 */
export function OwnerPortal() {
  const { snapshot: s, demo } = useWorkspace();
  const [error, setError] = useState("");
  // An owner who also sits on the board holds other aircraft for the board
  // view; the portal lists only their own.
  const owned = ownerPortalAircraft(s!);
  return (
    <>
      <PageTitle
        eyebrow="OWNER PORTAL"
        title="Your aircraft"
        description="Current totals, upcoming maintenance and completed work. Read-only."
        action={demo && <ExitPreviewButton onError={setError} />}
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {owned.map((a) => (
        <OwnerAircraft key={a.uuid} state={s!} aircraft={a} />
      ))}
      {!owned.length && (
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

function ExitPreviewButton({ onError }: { onError: (error: string) => void }) {
  return (
    <button
      className="button"
      onClick={() =>
        previewDemoOwner(false).catch((e) => onError(errorText(e)))
      }
    >
      Exit owner preview
    </button>
  );
}

function OwnerAircraft({ state, aircraft: a }: AircraftProps) {
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
        <dd>{totalLabel(a)}</dd>
        <dt>Cycles</dt>
        <dd>{a.cycles.toLocaleString()}</dd>
        <dt>Landings</dt>
        <dd>{a.landings.toLocaleString()}</dd>
      </dl>
      <NextDue items={ownerDueItems(state, a)} />
      <OpenDiscrepancies state={state} aircraft={a} />
      <RecentWork state={state} aircraft={a} />
      <AircraftForm337 state={state} aircraft={a} />
      <div className="filters">
        <ExportAircraftStatus state={state} aircraftUuid={a.uuid} />
        <ADReportButton state={state} aircraft={a} />
      </div>
    </section>
  );
}

// Only damaged data has a meter without a reading.
function totalLabel(a: Aircraft) {
  const total = recordedTotalSeconds(a);
  return total === undefined ? "Not recorded" : <>{hours(total)} h</>;
}

function NextDue({ items }: { items: DueItem[] }) {
  return (
    <>
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
            <StatusPill tone={DUE_BADGES[i.status].tone}>
              {DUE_BADGES[i.status].label}
            </StatusPill>
          </div>
        ))
      ) : (
        <p className="muted">
          No inspections, component limits or ADs recorded.
        </p>
      )}
    </>
  );
}

function OpenDiscrepancies({ state, aircraft }: AircraftProps) {
  const reports = state.discrepancies.filter(
    (d) => d.aircraftUuid === aircraft.uuid && d.status === "open",
  );
  return (
    <>
      <h3>Open discrepancies</h3>
      {reports.length ? (
        reports.map((d) => (
          <div className="list-row" key={d.uuid}>
            <div className="grow">
              <strong>{d.description}</strong>
            </div>
            <StatusPill tone="warning">Open</StatusPill>
          </div>
        ))
      ) : (
        <p className="muted">No open discrepancies.</p>
      )}
    </>
  );
}

function RecentWork({ state, aircraft }: AircraftProps) {
  const orders = (state.workOrders ?? [])
    .filter((w) => w.aircraftUuid === aircraft.uuid && w.status === "completed")
    .sort((x, y) => y.completionDate.localeCompare(x.completionDate))
    .slice(0, RECENT_WORK_ORDERS);
  return (
    <>
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
    </>
  );
}

function ADReportButton({ state, aircraft }: AircraftProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      // Loaded on demand, so jsPDF stays out of the portal until it is used.
      const { saveADReport } = await import("../data/adReport");
      saveADReport(state, aircraft.uuid);
    } catch (e) {
      setError(errorText(e, "Unable to export AD report."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <button className="button" disabled={busy} onClick={save}>
        {busy ? "Generating PDF…" : "AD compliance report"}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
