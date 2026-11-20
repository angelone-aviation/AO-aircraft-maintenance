/**
 * Responsibility: Loads older history whole for the features that need every
 *   record: one aircraft's history, named work orders, flights over a span,
 *   closed work orders back to a date, and one month's records.
 * Layer: Data. Async functions over Backend; no React.
 * Dependencies: ./backend (types), ./errors, ./historyPages (merge), src/domain
 *   (retention, historyReads, auditHistory, model types).
 *
 * Every read goes through the server's permission-checked history queries
 * (ADR-0013); what comes back joins the snapshot with the snapshot's copy
 * winning, so a feature reads one set of records either way.
 */
import type { Backend } from "./backend";
import { errorText } from "./errors";
import { withHistory, workOrderRows, type HistoryRows } from "./historyPages";
import { HISTORY_NOT_FOUND } from "../domain/auditHistory";
import {
  FLIGHT_RANGE_TOO_LONG,
  type FlightRange,
} from "../domain/historyReads";
import {
  MAX_HISTORY_PAGE_SIZE,
  type HistoryKind,
  type HistoryPage,
} from "../domain/retention";
import type { Snapshot } from "../domain/model";

/** The Backend calls these loads use. */
export type HistoryReads = Pick<
  Backend,
  "historyPage" | "workOrderHistory" | "flightsInRange"
>;

/**
 * The most pages one list of one aircraft is read to: 200,000 rows, far
 * beyond an aircraft's life of flights. A list longer than that is reported
 * incomplete rather than read without end.
 */
export const MAX_HISTORY_PAGES = 2000;

/** One aircraft's history, joined to the snapshot. */
export interface AircraftHistory {
  snapshot: Snapshot;
  /** False when a list stopped at {@link MAX_HISTORY_PAGES}. */
  complete: boolean;
}

const KINDS: HistoryKind[] = ["flights", "discrepancies", "workOrders"];
// A span shorter than this that still holds too many flights is refused as
// is, rather than split without end.
const MIN_SPLIT_MS = 3_600_000;

/**
 * Every flight, problem report and work order of one aircraft, older than
 * the workspace's window or not, with each older work order's files.
 *
 * @param reads - The backend's history reads.
 * @param s - The workspace snapshot.
 * @param aircraftUuid - The aircraft.
 * @param onProgress - Told how many older records are loaded so far.
 * @returns The snapshot with the aircraft's whole history joined.
 * @throws What the backend throws, such as "History not found." for an
 *   aircraft the user may not read.
 */
export async function loadAircraftHistory(
  reads: HistoryReads,
  s: Snapshot,
  aircraftUuid: string,
  onProgress: (loaded: number) => void = () => {},
): Promise<AircraftHistory> {
  const pages: HistoryPage[] = [];
  let complete = true;
  for (const kind of KINDS) {
    const list = await pageToEnd(reads, kind, aircraftUuid, (page) => {
      pages.push(page);
      onProgress(pages.reduce((n, p) => n + rowCount(p), 0));
    });
    complete &&= list;
  }
  const joined = withHistory(s, ...pages.map(pageRows));
  const files = await workOrderFiles(reads, olderOrders(s, joined));
  return { snapshot: withHistory(joined, ...files), complete };
}

/**
 * The named work orders the snapshot lacks, loaded whole and joined.
 *
 * @param reads - The backend's history reads.
 * @param s - The snapshot.
 * @param uuids - Work orders a record names; those in `s` are not asked
 *   for, and each is asked for once.
 * @returns `s` with each order and everything on it joined. An order the
 *   server answers "History not found." for (one the user may not read) is
 *   left out, as the snapshot would leave it out.
 * @throws What the backend throws otherwise.
 */
export async function loadWorkOrders(
  reads: Pick<HistoryReads, "workOrderHistory">,
  s: Snapshot,
  uuids: readonly (string | undefined)[],
): Promise<Snapshot> {
  const held = new Set((s.workOrders ?? []).map((w) => w.uuid));
  const wanted = [...new Set(uuids)].filter(
    (uuid): uuid is string => !!uuid && !held.has(uuid),
  );
  return withHistory(s, ...(await workOrderFiles(reads, wanted)));
}

/**
 * One aircraft's flights that started within a span, however many: a span
 * the server refuses as holding more than its limit is asked in halves.
 *
 * @param reads - The backend's history reads.
 * @param aircraftUuid - The aircraft.
 * @param from - The span's first moment, in milliseconds; included.
 * @param to - The moment after its last; excluded.
 * @returns The flights newest first, and the members they name.
 * @throws What the backend throws, and "Choose a shorter span…" for an hour
 *   that alone holds more flights than the server returns.
 */
export async function loadFlightsBetween(
  reads: Pick<HistoryReads, "flightsInRange">,
  aircraftUuid: string,
  from: number,
  to: number,
): Promise<FlightRange> {
  try {
    return await reads.flightsInRange({ aircraftUuid, from, to });
  } catch (e) {
    if (errorText(e, "") !== FLIGHT_RANGE_TOO_LONG || to - from < MIN_SPLIT_MS)
      throw e;
    const middle = from + Math.floor((to - from) / 2);
    const later = await loadFlightsBetween(reads, aircraftUuid, middle, to);
    const earlier = await loadFlightsBetween(reads, aircraftUuid, from, middle);
    return {
      flights: [...later.flights, ...earlier.flights],
      members: [...later.members, ...earlier.members],
    };
  }
}

/**
 * One aircraft's closed work orders completed on or after a date, older
 * than the workspace's window or not.
 *
 * @param reads - The backend's history reads.
 * @param s - The workspace snapshot.
 * @param aircraftUuid - The aircraft.
 * @param since - The first completion date wanted, as YYYY-MM-DD.
 * @returns `s` with those orders, their job cards and costs joined. Pages
 *   run newest completion first, so reading stops at the first page that
 *   reaches back before `since`.
 * @throws What the backend throws.
 */
export async function loadWorkOrdersSince(
  reads: Pick<HistoryReads, "historyPage">,
  s: Snapshot,
  aircraftUuid: string,
  since: string,
): Promise<Snapshot> {
  const pages: HistoryPage[] = [];
  await pageToEnd(reads, "workOrders", aircraftUuid, (page) => {
    pages.push(page);
    const last = page.records.workOrders.at(-1)?.completionDate;
    return last !== undefined && last < since;
  });
  return withHistory(s, ...pages.map(pageRows));
}

/**
 * One aircraft's flights that started, and work orders completed, in a
 * month, older than the workspace's window or not: what the paper check
 * lists.
 *
 * @param reads - The backend's history reads.
 * @param s - The workspace snapshot.
 * @param aircraftUuid - The aircraft.
 * @param yearMonth - The month as YYYY-MM; flights by this browser's local
 *   dates, as the paper check counts them.
 * @returns `s` with the month's records joined.
 * @throws What the backend throws.
 */
export async function loadMonthHistory(
  reads: HistoryReads,
  s: Snapshot,
  aircraftUuid: string,
  yearMonth: string,
): Promise<Snapshot> {
  const [year, month] = yearMonth.split("-").map(Number);
  const from = new Date(year, month - 1, 1).getTime();
  const to = new Date(year, month, 1).getTime();
  const range = await loadFlightsBetween(reads, aircraftUuid, from, to);
  const flown = withHistory(s, { ...range });
  return loadWorkOrdersSince(reads, flown, aircraftUuid, `${yearMonth}-01`);
}

// Reads a list's pages until it is done, `onPage` says to stop, or the page
// limit is reached; false only in the last case.
async function pageToEnd(
  reads: Pick<HistoryReads, "historyPage">,
  kind: HistoryKind,
  aircraftUuid: string,
  onPage: (page: HistoryPage) => boolean | void,
): Promise<boolean> {
  let cursor: string | null = null;
  for (let n = 0; n < MAX_HISTORY_PAGES; n++) {
    const page = await reads.historyPage({
      kind,
      aircraftUuid,
      cursor,
      numItems: MAX_HISTORY_PAGE_SIZE,
    });
    if (onPage(page) || page.isDone) return true;
    cursor = page.continueCursor;
  }
  return false;
}

function pageRows(page: HistoryPage): HistoryRows {
  return { ...page.records, members: page.members };
}

function rowCount({ records }: HistoryPage): number {
  return (
    records.flights.length +
    records.discrepancies.length +
    records.workOrders.length
  );
}

// The work orders paged in that the workspace lacks: their files come only
// with the whole order.
function olderOrders(s: Snapshot, joined: Snapshot): string[] {
  const held = new Set((s.workOrders ?? []).map((w) => w.uuid));
  return (joined.workOrders ?? [])
    .map((w) => w.uuid)
    .filter((uuid) => !held.has(uuid));
}

// Each order whole, one at a time; the work order pages carry no files.
async function workOrderFiles(
  reads: Pick<HistoryReads, "workOrderHistory">,
  uuids: string[],
): Promise<HistoryRows[]> {
  const rows: HistoryRows[] = [];
  for (const uuid of uuids) {
    const history = await readOrNotFound(() => reads.workOrderHistory(uuid));
    if (history) rows.push(workOrderRows(history));
  }
  return rows;
}

// The server refuses an order the user may not read as one that does not
// exist; neither is in the user's records.
async function readOrNotFound<T>(read: () => Promise<T>) {
  try {
    return await read();
  } catch (e) {
    if (errorText(e, "") === HISTORY_NOT_FOUND) return undefined;
    throw e;
  }
}
