/**
 * Responsibility: Pages the change log for History: a Flight Program's,
 *   an aircraft's or a record's entries, newest first; and summarizes a
 *   period of it for Flight Program administrators.
 * Layer: Server. Two public queries; they read only entries the snapshot's
 *   visibility rules let the caller see.
 * Dependencies: convex/programContext, convex/collections,
 *   convex/recordsDate, src/domain (programs, auditHistory, auditSummary,
 *   model).
 */
import { ConvexError, v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  checkContext,
  managementDocs,
  partsRequestDocs,
  purchaseOrderDocs,
  checklistDocs,
  componentTemplateDocs,
  componentSetupDocs,
  inspectionTemplateDocs,
  costDocs,
  expiringItemDocs,
  transferredAuditDocs,
} from "./programContext";
import { decode } from "./collections";
import { recordsMidnight } from "./recordsDate";
import {
  activeProgram,
  auditVisible,
  programPermission,
  readsAccountWideAudit,
} from "../src/domain/programs";
import {
  summarizeAudit,
  type AuditSummaryResult,
  type SummaryPeriod,
} from "../src/domain/auditSummary";
import {
  canPageAuditFilter,
  clampAuditPageSize,
  HISTORY_NOT_FOUND,
  MAX_AUDIT_PAGE_SIZE,
  type AuditFilter,
  type AuditPage,
} from "../src/domain/auditHistory";
import type { AuditEntry, Snapshot } from "../src/domain/model";

// Entries read per request before a page is returned short; only reached when
// a long run of the caller's own program index is hidden from them. The
// summary shares it, and says when the period was cut short by it.
const SCAN_BUDGET = 4000;
// The records the summary looks up by uuid, three index ranges each, to
// decide which rows a caller may see before it reports the period cut short,
// as it does past SCAN_BUDGET.
const LOOKUP_BUDGET = 100;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
// The furthest any time zone's midnight lies from UTC midnight (UTC+14 and
// UTC-12): local day bounds further than this do not belong to their date.
const MAX_UTC_OFFSET_MS = 14 * HOUR_MS;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type CanSee = (entry: AuditEntry) => boolean;
/** The records the visibility rule looks up by uuid, as rows name them. */
type NamedRecords = {
  [K in "costs" | "partsRequests" | "purchaseOrders"]: NonNullable<Snapshot[K]>;
};
type Source = (below: number | undefined) => Promise<Doc<"audit">[]>;
type Scan = {
  visible: Doc<"audit">[];
  exhausted: boolean;
  // The row the scan stopped at, which the caller may not be able to see.
  floor: Doc<"audit"> | undefined;
};

/**
 * Pages the change log newest first: one record's entries, one aircraft's, or
 * the whole program's (its own index, each visible aircraft's, and the rows
 * transfers brought in). Hidden entries never fill a page, decide `isDone`
 * or show in a cursor (S12): a page cut short by the scan budget resumes
 * from the row the scan stopped at, named by its opaque id, not its time.
 *
 * @param programUuid - The caller's active Flight Program.
 * @param entityUuid - Only this record's entries.
 * @param aircraftUuid - Only this aircraft's entries; with `entityUuid`, the
 *   record's entries on this aircraft.
 * @param cursor - The previous page's `continueCursor`, or null: a time, or
 *   after a page cut short, the id of the row to resume below.
 * @param numItems - Page size, as `clampAuditPageSize`.
 * @returns Entries without Convex fields; `isDone` once no visible entry is
 *   left. The page is short and not done after 4,000 entries are scanned.
 * @throws {ConvexError} "History not found." before paging, the same for a
 *   record or aircraft the caller cannot see as for one that does not exist.
 * @throws {Error} "Invalid history cursor."
 * @throws As `checkContext`, first.
 */
export const page = query({
  args: {
    programUuid: v.optional(v.string()),
    entityUuid: v.optional(v.string()),
    aircraftUuid: v.optional(v.string()),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (ctx, args): Promise<AuditPage> => {
    const { state, canSee } = await visibility(ctx, args.programUuid);
    const n = clampAuditPageSize(args.numItems);
    const before = await readCursor(ctx, args.cursor);
    await assertFilterVisible(ctx, canSee, args);
    const sources = selectSources(ctx, state, canSee, args, n);
    const shown = (d: Doc<"audit">) =>
      canSee(d) && (!args.aircraftUuid || d.aircraftUuid === args.aircraftUuid);
    const scan = await scanVisible(sources, shown, n, before);
    return buildPage(scan, n, before);
  },
});

/**
 * Summarizes the program's change log over a period for the weekly review:
 * per-actor counts by action family, notable events and refused sign-ins
 * (src/domain/auditSummary), from the same entries History pages. Days are
 * the caller's when it sends its local midnights, else the server's (UTC)
 * dates of each entry.
 *
 * @param programUuid - The caller's active Flight Program.
 * @param from - The first day, as an ISO date.
 * @param to - The last day, inclusive.
 * @param fromMs - The caller's midnight at the start of `from`; with `toMs`.
 *   Without both, days start at midnight in the records time zone.
 * @param toMs - The caller's midnight just after `to`.
 * @returns The summary; `truncated: true` when 4,000 entries were read
 *   before the period's start was reached, so older entries in it are not
 *   counted (narrow the period in that case); and `accountWide`, true only
 *   for a system administrator in Unassigned records, the one reader of
 *   refused sign-ins and other account-wide entries.
 * @throws {ConvexError} "Flight Program administrator required."; "Choose a
 *   start and end date." for a date that is not YYYY-MM-DD, or bounds that
 *   are not that date's midnight in some time zone; "Choose a start date on
 *   or before the end date."
 * @throws As `checkContext`, first.
 */
export const summary = query({
  args: {
    programUuid: v.optional(v.string()),
    from: v.string(),
    to: v.string(),
    fromMs: v.optional(v.number()),
    toMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<AuditSummaryResult> => {
    const state = await checkContext(ctx, args.programUuid);
    if (!programPermission(state, "admin"))
      throw new ConvexError("Flight Program administrator required.");
    const period = parsePeriod(args);
    const seen = new RowVisibility(
      ctx,
      state,
      await completeRecords(ctx, state),
    );
    const sources = selectSources(
      ctx,
      state,
      seen.canSee,
      {},
      MAX_AUDIT_PAGE_SIZE,
    );
    const scan = await scanPeriod(sources, seen, period);
    const entries = scan.rows.map(
      ({ _id, _creationTime, ...entry }): AuditEntry => entry,
    );
    return {
      summary: summarizeAudit(entries, period),
      truncated: scan.truncated,
      accountWide: readsAccountWideAudit(state),
    };
  },
});

// The same records the snapshot loads to decide which history entries a
// caller may read.
async function visibility(ctx: QueryCtx, programUuid?: string) {
  const state = await checkContext(ctx, programUuid);
  const program = activeProgram(state);
  return {
    state,
    canSee: auditVisible({
      ...state,
      ...(await completeRecords(ctx, state)),
      partsRequests: decode(
        "partsRequests",
        await partsRequestDocs(ctx, program),
      ),
      purchaseOrders: decode(
        "purchaseOrders",
        await purchaseOrderDocs(ctx, program),
      ),
      costs: decode("costs", await costDocs(ctx, program)),
    }),
  };
}

// The program's records the visibility rule reads that do not grow with
// history: inventory and components, checklists, templates and expiring
// dates.
async function completeRecords(
  ctx: QueryCtx,
  state: Snapshot,
): Promise<Partial<Snapshot>> {
  const program = activeProgram(state);
  const asWritten = (docs: { payload: string }[]) =>
    docs.map((d) => JSON.parse(d.payload));
  return {
    management: decode("management", await managementDocs(ctx, program)),
    checklists: decode("checklists", await checklistDocs(ctx, program)),
    componentTemplates: asWritten(await componentTemplateDocs(ctx, program)),
    componentSetups: asWritten(await componentSetupDocs(ctx, program)),
    inspectionTemplates: decode(
      "inspectionTemplates",
      await inspectionTemplateDocs(ctx, program),
    ),
    expiringItems: decode(
      "expiringItems",
      await expiringItemDocs(ctx, program, state.user.isAdmin),
    ),
  };
}

/**
 * History's visibility rule with the cost records, parts requests and
 * purchase orders loaded as the rows ask for them, not all of them
 * (ADR-0013). Those records only ever widen what the rule shows, so a row
 * it hides is decided again once the record the row names is loaded: by
 * uuid, from the program's own records, as the full load would hold it.
 */
class RowVisibility {
  /** The rule over the records loaded so far. */
  canSee: CanSee;
  private named: NamedRecords = {
    costs: [],
    partsRequests: [],
    purchaseOrders: [],
  };
  private readonly sought = new Set<string>();

  constructor(
    private readonly ctx: QueryCtx,
    private readonly state: Snapshot,
    private readonly complete: Partial<Snapshot>,
  ) {
    this.canSee = this.rule();
  }

  /**
   * Loads the records that rows the rule hides so far name.
   *
   * @returns False, loading nothing, when that would pass LOOKUP_BUDGET
   *   records looked up in all.
   */
  async learn(rows: readonly AuditEntry[]): Promise<boolean> {
    const hidden = rows.filter((r) => !this.canSee(r)).map((r) => r.entityUuid);
    const wanted = [...new Set(hidden)].filter((u) => !this.sought.has(u));
    if (this.sought.size + wanted.length > LOOKUP_BUDGET) return false;
    for (const uuid of wanted) this.sought.add(uuid);
    const found = await programRecordsByUuid(this.ctx, this.state, wanted);
    this.named = {
      costs: [...this.named.costs, ...found.costs],
      partsRequests: [...this.named.partsRequests, ...found.partsRequests],
      purchaseOrders: [...this.named.purchaseOrders, ...found.purchaseOrders],
    };
    this.canSee = this.rule();
    return true;
  }

  private rule() {
    return auditVisible({ ...this.state, ...this.complete, ...this.named });
  }
}

// The program's cost records, parts requests and purchase orders with these
// uuids, as the program loaders would return them.
async function programRecordsByUuid(
  ctx: QueryCtx,
  state: Snapshot,
  uuids: string[],
): Promise<NamedRecords> {
  const program = activeProgram(state);
  const ofProgram = async <D extends { programUuid: string }>(
    read: (uuid: string) => Promise<D[]>,
  ) =>
    (await Promise.all(uuids.map(read)))
      .flat()
      .filter((r) => program !== undefined && r.programUuid === program);
  return {
    costs: decode(
      "costs",
      await ofProgram((uuid) =>
        ctx.db
          .query("costs")
          .withIndex("uuid", (q) => q.eq("uuid", uuid))
          .collect(),
      ),
    ),
    partsRequests: decode(
      "partsRequests",
      await ofProgram((uuid) =>
        ctx.db
          .query("partsRequests")
          .withIndex("uuid", (q) => q.eq("uuid", uuid))
          .collect(),
      ),
    ),
    purchaseOrders: decode(
      "purchaseOrders",
      await ofProgram((uuid) =>
        ctx.db
          .query("purchaseOrders")
          .withIndex("uuid", (q) => q.eq("uuid", uuid))
          .collect(),
      ),
    ),
  };
}

function parsePeriod(period: SummaryPeriod): SummaryPeriod {
  const { from, to, fromMs, toMs } = period;
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to))
    throw new ConvexError("Choose a start and end date.");
  if (from > to)
    throw new ConvexError("Choose a start date on or before the end date.");
  // A caller that sends no day bounds gets the records time zone's days,
  // the same days the server's alerts use, for the scan and the counts.
  if (fromMs === undefined && toMs === undefined)
    return {
      from,
      to,
      fromMs: recordsMidnight(from),
      toMs: recordsMidnight(nextDate(to)),
    };
  const startUtc = Date.parse(from + "T00:00:00Z");
  const endUtc = Date.parse(to + "T00:00:00Z") + DAY_MS;
  if (
    fromMs === undefined ||
    toMs === undefined ||
    !isNear(fromMs, startUtc) ||
    !isNear(toMs, endUtc)
  )
    throw new ConvexError("Choose a start and end date.");
  return { from, to, fromMs, toMs };
}

// A local midnight of the date: within the widest UTC offset of its UTC one.
function isNear(ms: number, utcMidnight: number): boolean {
  return Number.isFinite(ms) && Math.abs(ms - utcMidnight) <= MAX_UTC_OFFSET_MS;
}

// A cursor is a creation time, or the id of the audit row a page cut short
// stopped at; only the server can turn that id into the time to resume from.
async function readCursor(
  ctx: QueryCtx,
  cursor: string | null,
): Promise<number | undefined> {
  if (cursor === null) return undefined;
  const before = Number(cursor);
  if (Number.isFinite(before)) return before;
  const id = ctx.db.normalizeId("audit", cursor);
  const resume = id && (await ctx.db.get(id));
  if (!resume) throw new Error("Invalid history cursor.");
  return resume._creationTime;
}

// Refused with the same answer as an unknown id; at most the record's newest
// entry is read, to check that it is visible.
async function assertFilterVisible(
  ctx: QueryCtx,
  canSee: CanSee,
  filter: AuditFilter,
): Promise<void> {
  const entityUuid = filter.entityUuid;
  const newest = entityUuid
    ? await ctx.db
        .query("audit")
        .withIndex("entity", (q) => q.eq("entityUuid", entityUuid))
        .order("desc")
        .first()
    : null;
  if (!canPageAuditFilter(canSee, filter, newest))
    throw new ConvexError(HISTORY_NOT_FOUND);
}

// Most aircraft entries carry no program column, so program-wide history
// merges several indexes, which `.paginate()` cannot express; each is read as
// a range below the cursor's _creationTime instead.
function selectSources(
  ctx: QueryCtx,
  state: Snapshot,
  canSee: CanSee,
  filter: AuditFilter,
  n: number,
): Source[] {
  if (filter.entityUuid)
    return [readIndex(ctx, n, "entity", "entityUuid", filter.entityUuid)];
  if (filter.aircraftUuid)
    return [readIndex(ctx, n, "aircraft", "aircraftUuid", filter.aircraftUuid)];
  const program = activeProgram(state);
  return [
    readIndex(ctx, n, "program", "programUuid", program),
    ...state.aircraft
      .filter((a) => canPageAuditFilter(canSee, { aircraftUuid: a.uuid }))
      .map((a) => readIndex(ctx, n, "aircraft", "aircraftUuid", a.uuid)),
    (below) => transferredAuditDocs(ctx, program, n, below),
  ];
}

function readIndex(
  ctx: QueryCtx,
  n: number,
  index: "program" | "aircraft" | "entity",
  field: "programUuid" | "aircraftUuid" | "entityUuid",
  value: string | undefined,
): Source {
  return (below) =>
    ctx.db
      .query("audit")
      .withIndex(index, (q) => {
        const eq = q.eq(field, value);
        return below === undefined ? eq : eq.lt("_creationTime", below);
      })
      .order("desc")
      .take(n);
}

// Reads rounds below `floor` until one entry more than a page is visible (so
// isDone is exact), every source is exhausted, or the budget is spent.
async function scanVisible(
  sources: Source[],
  shown: (d: Doc<"audit">) => boolean,
  n: number,
  before: number | undefined,
): Promise<Scan> {
  const visible: Doc<"audit">[] = [];
  let floor: Doc<"audit"> | undefined,
    exhausted = false,
    scanned = 0;
  while (!exhausted && visible.length <= n && scanned < SCAN_BUDGET) {
    const below = floor?._creationTime ?? before;
    const batches = await Promise.all(sources.map((s) => s(below)));
    scanned += batches.reduce((sum, b) => sum + b.length, 0);
    floor = findCompleteEdge(batches, n);
    exhausted = floor === undefined;
    visible.push(...mergeCompleteRows(batches, floor).filter(shown));
  }
  return { visible, exhausted, floor };
}

// Reads rounds from just after the period's last day down to its first day,
// by creation time (written in the same mutation as `at`, so the two agree),
// until every source is exhausted or a budget is spent: the rows scanned, or
// the records looked up to decide them.
async function scanPeriod(
  sources: Source[],
  seen: RowVisibility,
  period: SummaryPeriod,
): Promise<{ rows: Doc<"audit">[]; truncated: boolean }> {
  const start = period.fromMs ?? Date.parse(period.from + "T00:00:00Z");
  const rows: Doc<"audit">[] = [];
  let floor = period.toMs ?? Date.parse(period.to + "T00:00:00Z") + DAY_MS;
  let scanned = 0;
  while (floor > start) {
    if (scanned >= SCAN_BUDGET) return { rows, truncated: true };
    const batches = await Promise.all(sources.map((s) => s(floor)));
    scanned += batches.reduce((sum, b) => sum + b.length, 0);
    const edge = findCompleteEdge(batches, MAX_AUDIT_PAGE_SIZE);
    const complete = mergeCompleteRows(batches, edge);
    if (!(await seen.learn(complete))) return { rows, truncated: true };
    rows.push(...complete.filter(seen.canSee));
    if (edge === undefined) break;
    floor = edge._creationTime;
  }
  return { rows, truncated: false };
}

// Rows at or above the newest last row of any full batch are complete: no
// source can still hold an unread row there. Undefined when none was full.
function findCompleteEdge(
  batches: Doc<"audit">[][],
  n: number,
): Doc<"audit"> | undefined {
  const lasts = batches.filter((b) => b.length === n).map((b) => b.at(-1)!);
  return lasts.sort((a, b) => b._creationTime - a._creationTime)[0];
}

function mergeCompleteRows(
  batches: Doc<"audit">[][],
  edge: Doc<"audit"> | undefined,
): Doc<"audit">[] {
  return [...new Map(batches.flat().map((d) => [d._id, d])).values()]
    .filter((d) => !edge || d._creationTime >= edge._creationTime)
    .sort((a, b) => b._creationTime - a._creationTime);
}

function buildPage(
  scan: Scan,
  n: number,
  before: number | undefined,
): AuditPage {
  const batch = scan.visible.slice(0, n);
  const isDone = scan.exhausted && scan.visible.length <= n;
  return {
    page: batch.map(({ _id, _creationTime, ...entry }): AuditEntry => entry),
    isDone,
    // Short and not done means the scan budget ran out: resume there.
    continueCursor:
      !isDone && batch.length < n
        ? resumeId(scan.floor)
        : String(batch.at(-1)?._creationTime ?? before ?? 0),
  };
}

// A scan stops short only while a full batch remains, so it has a floor.
function resumeId(floor: Doc<"audit"> | undefined): Id<"audit"> {
  if (!floor) throw new Error("A history page cut short has no resume row.");
  return floor._id;
}

// The ISO date after `date`.
function nextDate(date: string): string {
  return new Date(Date.parse(date + "T00:00:00Z") + DAY_MS)
    .toISOString()
    .slice(0, 10);
}
