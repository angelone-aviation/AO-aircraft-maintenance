/**
 * Responsibility: The demo's workspace view of its full fictional snapshot,
 *   and its history reads: older pages, one work order, and flights over a
 *   span.
 * Layer: Data. Browser only; no Convex server, no React.
 * Dependencies: ./backend (types), src/domain (retention, historyReads,
 *   programs, model).
 *
 * Each read scopes the full snapshot as the server's workspace query does,
 * then runs the domain function the server's queries are tested against
 * (ADR-0013), so the demo pages what a live program would.
 */
import type { Backend } from "./backend";
import { historyPage, retainedSnapshot } from "../domain/retention";
import { flightRange, workOrderHistory } from "../domain/historyReads";
import { scopedSnapshot } from "../domain/programs";
import type { Snapshot } from "../domain/model";

/**
 * The session flag that turns the retention window on in the demo before it
 * is on for every program (stage S7 of the history-paging plan). Browser
 * tests set it so their aged records load only through Load older.
 */
export const DEMO_WINDOW_KEY = "angel-one-demo-window";

/** The Backend members that read history beyond the workspace. */
export type HistoryCalls = Pick<
  Backend,
  "historyPage" | "workOrderHistory" | "flightsInRange"
>;

/**
 * The workspace the demo shows from its full snapshot: scoped as the
 * server's workspace query scopes it, and narrowed to the retention window
 * (ADR-0013) while {@link DEMO_WINDOW_KEY} is "on" for this tab.
 *
 * @param full - The full, unscoped demo snapshot.
 * @param now - The current time, in milliseconds.
 */
export function demoWorkspaceView(full: Snapshot, now = Date.now()): Snapshot {
  const scoped = scopedSnapshot(full);
  return demoWindowOn() ? retainedSnapshot(scoped, now) : scoped;
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
  };
}

function demoWindowOn(): boolean {
  try {
    return sessionStorage.getItem(DEMO_WINDOW_KEY) === "on";
  } catch {
    // Storage blocked or absent (a sandboxed frame, a test without a DOM):
    // the window stays off, as it is everywhere before S7.
    return false;
  }
}
