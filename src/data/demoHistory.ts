/**
 * Responsibility: The demo adapter's history reads: older pages, one work
 *   order, and flights over a span, from the full fictional snapshot.
 * Layer: Data. Browser only; no Convex server, no React.
 * Dependencies: ./backend (types), src/domain (retention, historyReads,
 *   programs, model).
 *
 * Each read scopes the full snapshot as the server's workspace query does,
 * then runs the domain function the server's queries are tested against
 * (ADR-0013), so the demo pages what a live program would.
 */
import type { Backend } from "./backend";
import { historyPage } from "../domain/retention";
import { flightRange, workOrderHistory } from "../domain/historyReads";
import { scopedSnapshot } from "../domain/programs";
import type { Snapshot } from "../domain/model";

/** The Backend members that read history beyond the workspace. */
export type HistoryCalls = Pick<
  Backend,
  "historyPage" | "workOrderHistory" | "flightsInRange"
>;

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
  };
}
