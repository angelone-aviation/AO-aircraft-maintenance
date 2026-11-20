/**
 * Responsibility: Reads one history list newest first from several index
 *   ranges, merged by position, until a page is full or a budget is spent.
 * Layer: Server. Merge logic over the range readers convex/history.ts
 *   builds; it holds no Convex context itself.
 * Dependencies: convex/values (document size), src/domain/retention.
 *
 * A list spans one index range per aircraft (two for work orders), which
 * `.paginate()` cannot merge, so each range is read in growing batches after
 * a position, as auditHistory reads the change log.
 */
import { getConvexSize, type Value } from "convex/values";
import {
  compareHistoryPositions,
  type HistoryPosition,
} from "../src/domain/retention";

/**
 * Index ranges one request may read: a quarter of Convex's 4,096, the plan's
 * headroom (docs/history-paging.md).
 */
export const MAX_SCAN_RANGES = 1000;
/** Bytes one request may read: a quarter of Convex's 16 MiB, likewise. */
export const MAX_SCAN_BYTES = 4 * 1024 * 1024;

/** Reads at most `limit` rows strictly after a position, in list order. */
export type ReadAfter<T, P extends HistoryPosition> = (
  after: P,
  limit: number,
) => Promise<T[]>;

/** What one request has read, against {@link MAX_SCAN_RANGES} and bytes. */
export class ReadBudget {
  private ranges = 0;
  private bytes = 0;

  /**
   * Counts one index range and the documents it returned.
   *
   * @returns The rows, unchanged.
   */
  spend<T extends { [field: string]: Value | undefined }>(rows: T[]): T[] {
    this.ranges += 1;
    for (const row of rows) this.bytes += getConvexSize(row);
    return rows;
  }

  /** True once either limit is reached; reads already made still count. */
  get spent(): boolean {
    return this.ranges >= MAX_SCAN_RANGES || this.bytes >= MAX_SCAN_BYTES;
  }
}

/** One list scan: where it reads, and what it keeps of each row. */
export interface ScanRequest<T, R, P extends HistoryPosition> {
  /** One reader per index range; each spends `budget` as it reads. */
  ranges: ReadAfter<T, P>[];
  /** The scan reads rows after this: the cursor, or the list's start. */
  after: P;
  /** A row's place in the list, in the terms its index range orders by. */
  positionOf: (row: T) => P;
  /** The page's entry for a row, or null to leave it out. It may read
   * more, spending `budget`. */
  pick: (row: T) => Promise<R | null>;
  /** Entries wanted, already bounded. */
  numItems: number;
  budget: ReadBudget;
}

/** The entries one scan picked, and where the next starts. */
export interface Scan<R, P extends HistoryPosition> {
  /** At most `numItems`, in list order. */
  picked: R[];
  /** True when no row is left after the scan to pick. */
  isDone: boolean;
  /**
   * Where the next page starts: the last entry's row on a full page, else
   * the last row read when the budget cut the scan short; undefined when
   * nothing was read.
   */
  resume: P | undefined;
}

/**
 * Reads the ranges as one list, newest first, picking entries until one more
 * than a page is picked (so `isDone` is exact), every range is read to its
 * end, or the budget is spent. A page cut short by the budget is short and
 * not done.
 *
 * @returns The entries, `isDone`, and where to resume.
 * @throws What a reader or `pick` throws.
 */
export async function scanHistory<T, R, P extends HistoryPosition>(
  request: ScanRequest<T, R, P>,
): Promise<Scan<R, P>> {
  const { numItems, budget, positionOf } = request;
  const heads = openHeads(request);
  const picked: { entry: R; at: P }[] = [];
  let last: P | undefined;
  while (picked.length <= numItems) {
    const head = await nextHead(heads, positionOf);
    if (!head) return finishScan(picked, numItems, true, last);
    const row = head.take();
    last = positionOf(row);
    const entry = await request.pick(row);
    if (entry !== null) picked.push({ entry, at: last });
    if (budget.spent) break;
  }
  return finishScan(picked, numItems, false, last);
}

// One index range's unread rows. Each refill doubles its batch, so a list
// spread over many aircraft first reads about a page in all.
class Head<T, P extends HistoryPosition> {
  private rows: T[] = [];
  private ended = false;

  constructor(
    private readonly read: ReadAfter<T, P>,
    private after: P,
    private batch: number,
    private readonly maxBatch: number,
  ) {}

  get first(): T | undefined {
    return this.rows[0];
  }

  get needsRows(): boolean {
    return this.rows.length === 0 && !this.ended;
  }

  async fill(positionOf: (row: T) => P): Promise<void> {
    const rows = await this.read(this.after, this.batch);
    this.ended = rows.length < this.batch;
    this.rows = rows;
    const last = rows.at(-1);
    if (last !== undefined) this.after = positionOf(last);
    this.batch = Math.min(this.batch * 2, this.maxBatch);
  }

  take(): T {
    const row = this.rows.shift();
    if (row === undefined) throw new Error("A history range was read empty.");
    return row;
  }
}

function openHeads<T, R, P extends HistoryPosition>(
  request: ScanRequest<T, R, P>,
): Head<T, P>[] {
  const { ranges, numItems, after } = request;
  const wanted = numItems + 1;
  const batch = Math.max(2, Math.ceil(wanted / Math.max(1, ranges.length)));
  return ranges.map((read) => new Head(read, after, batch, wanted));
}

// The range holding the list's next row, after refilling every range whose
// rows ran out; undefined once every range is read to its end.
async function nextHead<T, P extends HistoryPosition>(
  heads: Head<T, P>[],
  positionOf: (row: T) => P,
): Promise<Head<T, P> | undefined> {
  await Promise.all(
    heads.filter((h) => h.needsRows).map((h) => h.fill(positionOf)),
  );
  let next: { head: Head<T, P>; at: P } | undefined;
  for (const head of heads) {
    const at = head.first === undefined ? undefined : positionOf(head.first);
    if (at && (!next || compareHistoryPositions(at, next.at) < 0))
      next = { head, at };
  }
  return next?.head;
}

function finishScan<R, P extends HistoryPosition>(
  picked: { entry: R; at: P }[],
  numItems: number,
  ended: boolean,
  last: P | undefined,
): Scan<R, P> {
  const page = picked.slice(0, numItems);
  const full = page.length === numItems;
  return {
    picked: page.map((p) => p.entry),
    isDone: ended && picked.length <= numItems,
    resume: full || ended ? page.at(-1)?.at : last,
  };
}
