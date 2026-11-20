/**
 * Responsibility: Loads an aircraft's cost report for a screen: the cost
 *   ledger's report and the period's flying, again after any write.
 * Layer: Data. A React hook over the workspace store and Backend; renders
 *   nothing.
 * Dependencies: react, ./store, ./backend (types), ./errors, ./historyLoads,
 *   src/domain (costs, costs/costReport, model types).
 *
 * The report comes only from Backend.costReport, which sums the server's
 * cost ledger (ADR-0013, stage S4), so the Costs screen and the board agree.
 * It needs a connection; the device holds no ledger.
 */
import { useEffect, useState } from "react";
import { useWorkspace } from "./store";
import type { Backend } from "./backend";
import { errorText } from "./errors";
import { loadFlightsBetween } from "./historyLoads";
import { periodFlightSeconds, type Period } from "../domain/costs";
import {
  costReportView,
  type CostReport,
  type CostReportRequest,
  type CostReportView,
} from "../domain/costs/costReport";
import type { Aircraft, Flight, Snapshot } from "../domain/model";

/** An aircraft's cost report for a period, and its load state. */
export interface LoadedCostReport {
  /** Undefined until loaded, offline, or when it could not load. */
  report?: CostReportView;
  loading: boolean;
  /** Why it could not load, as the user should read it; "" otherwise. */
  error: string;
  /** No connection: it cannot load. */
  offline: boolean;
}

const LOAD_ERROR = "Could not load the cost report.";

/**
 * An aircraft's cost report over a period, as the Costs screen shows it.
 *
 * @param aircraft - The aircraft; undefined loads nothing.
 * @param period - Inclusive dates; undefined loads nothing.
 * @returns The report with the period's flight hours. It loads again after
 *   any new change-log entry (a cost, issue or budget changes it), keeping
 *   the copy it has meanwhile, and is dropped for another aircraft, period,
 *   program or user.
 */
export function useCostReport(
  aircraft: Aircraft | undefined,
  period: Period | undefined,
): LoadedCostReport {
  const { backend, online, connected, snapshot } = useWorkspace();
  const live = !!backend && online && connected;
  const [uuid, from, to] = [aircraft?.uuid, period?.from, period?.to];
  const key = uuid && from && to ? reportKey(snapshot, [uuid, from, to]) : "";
  const mark = snapshot?.audit[0]?.uuid;
  const [state, setState] = useState<LoadedState>(NOTHING);
  const fresh = state.key === key && state.mark === mark;
  useEffect(() => {
    if (!uuid || !from || !to || !live || !backend || fresh) return;
    let current = true;
    loadReport(backend, { aircraftUuid: uuid, from, to }).then(
      (loaded) => current && setState({ key, mark, loaded, error: "" }),
      (e) =>
        current && setState({ key, mark, error: errorText(e, LOAD_ERROR) }),
    );
    return () => void (current = false);
  }, [uuid, from, to, live, backend, fresh, key, mark]);
  const kept = state.key === key ? state : NOTHING;
  return {
    report:
      kept.loaded && aircraft && period
        ? costReportView(
            kept.loaded.report,
            periodFlightSeconds(aircraft, kept.loaded.flights, period),
          )
        : undefined,
    loading: !!key && live && !fresh,
    error: kept.error,
    offline: !live,
  };
}

// What one load brought, for which key and write mark.
interface LoadedState {
  key: string;
  mark: string | undefined;
  loaded?: { report: CostReport; flights: Flight[] };
  error: string;
}

const NOTHING: LoadedState = { key: "", mark: undefined, error: "" };

// Who asks for what: another user, program, aircraft or period is another
// report.
function reportKey(snapshot: Snapshot | null, request: string[]): string {
  return JSON.stringify([
    snapshot?.user.id,
    snapshot?.activeProgramUuid,
    ...request,
  ]);
}

// The period's flights by local dates, as the report counts them: from the
// first day's local midnight to the midnight after the last day.
async function loadReport(
  reads: Pick<Backend, "costReport" | "flightsInRange">,
  request: CostReportRequest,
) {
  const [year, month, day] = request.to.split("-").map(Number);
  const [first, firstMonth, firstDay] = request.from.split("-").map(Number);
  const [report, range] = await Promise.all([
    reads.costReport(request),
    loadFlightsBetween(
      reads,
      request.aircraftUuid,
      new Date(first, firstMonth - 1, firstDay).getTime(),
      new Date(year, month - 1, day + 1).getTime(),
    ),
  ]);
  return { report, flights: range.flights };
}
