/**
 * Responsibility: The demo's workspace view of its full fictional snapshot,
 *   through the retention window, and its history reads: older pages, one
 *   work order, flights over a span and the cost report.
 * Layer: Data. Browser only; no Convex server, no React.
 * Dependencies: ./backend (types), src/domain (retention, historyReads,
 *   costs/costReport, programs, model).
 *
 * Each read scopes the full snapshot as the server's workspace query does,
 * then runs the domain function the server's queries are tested against
 * (ADR-0013), so the demo pages what a live program would.
 */
import type { Backend } from "./backend";
import { historyPage, workspaceWindow } from "../domain/retention";
import { flightRange, workOrderHistory } from "../domain/historyReads";
import { snapshotCostReport } from "../domain/costs/costReport";
import { scopedSnapshot } from "../domain/programs";
import type { Snapshot } from "../domain/model";

/** The Backend members that read history beyond the workspace. */
export type HistoryCalls = Pick<
  Backend,
  "historyPage" | "workOrderHistory" | "flightsInRange" | "costReport"
>;

/**
 * The workspace the demo shows from its full snapshot, as the server's
 * workspace query builds it: scoped, with history narrowed to the retention
 * window (workspaceWindow, ADR-0013). Older records load through
 * {@link demoHistoryCalls}.
 *
 * @param full - The full, unscoped demo snapshot.
 * @param now - The current time, in milliseconds.
 */
export function demoWorkspaceView(full: Snapshot, now = Date.now()): Snapshot {
  return workspaceWindow(full, now);
}

/**
 * The demo's history reads over its full snapshot.
 *
 * @param readFull - Reads the full, unscoped demo snapshot.
 * @returns The members; each throws the domain's Rejection unchanged, as the
 *   server's refusal would read.
 */
export function demoHistoryCalls(
  readFull: () => Promise<Snapshot>,
): HistoryCalls {
  const readScoped = async () => scopedSnapshot(await readFull());
  return {
    historyPage: async (request) =>
      historyPage(await readScoped(), request, Date.now()),
    workOrderHistory: async (uuid) =>
      workOrderHistory(await readScoped(), uuid),
    flightsInRange: async (request) => flightRange(await readScoped(), request),
    costReport: async (request) =>
      snapshotCostReport(await readScoped(), request),
  };
}
