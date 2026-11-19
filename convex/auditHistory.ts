/**
 * Responsibility: Pages the change log for History: a Flight Program's,
 *   an aircraft's or a record's entries, newest first; and summarizes a
 *   period of it for Flight Program administrators.
 * Layer: Server. Two public queries; they read only entries the snapshot's
 *   visibility rules let the caller see.
 * Dependencies: convex/programContext, convex/collections,
 *   convex/recordsDate, src/domain
 *   (programs, auditHistory, auditSummary, model, and the management,
 *   partsRequests, purchaseOrders, checklists and inspectionTemplates
 *   schemas).
 */
import { ConvexError, v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
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
import { recordSchema } from "../src/domain/management";
import { partsRequestSchema } from "../src/domain/partsRequests";
import { poSchema } from "../src/domain/purchaseOrders";
import { checklistRecordSchema } from "../src/domain/checklists";
import { inspectionTemplateSchema } from "../src/domain/inspectionTemplates";
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
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
// The furthest any time zone's midnight lies from UTC midnight (UTC+14 and
// UTC-12): local day bounds further than this do not belong to their date.
const MAX_UTC_OFFSET_MS = 14 * HOUR_MS;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type CanSee = (entry: AuditEntry) => boolean;
type Source = (below: number | undefined) => Promise<Doc<"audit">[]>;
type Scan = {
  visible: Doc<"audit">[];
  exhausted: boolean;
  floor: number | undefined;
};

/**
 * Pages the change log newest first: one record's entries, one aircraft's, or
 * the whole program's (its own index, each visible aircraft's, and the rows
 * transfers brought in). Hidden entries never fill a page or decide `isDone`
 * (S12); only a page cut short by the scan budget takes its cursor from one.
 *
 * @param programUuid - The caller's active Flight Program.
 * @param entityUuid - Only this record's entries.
 * @param aircraftUuid - Only this aircraft's entries; with `entityUuid`, the
 *   record's entries on this aircraft.
 * @param cursor - The previous page's `continueCursor`, or null.
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
    const before = parseCursor(args.cursor);
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
    const { state, canSee } = await visibility(ctx, args.programUuid);
    if (!programPermission(state, "admin"))
      throw new ConvexError("Flight Program administrator required.");
    const period = parsePeriod(args);
    const sources = selectSources(ctx, state, canSee, {}, MAX_AUDIT_PAGE_SIZE);
    const scan = await scanPeriod(sources, canSee, period);
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
  const parse = <T>(
    docs: { payload: string }[],
    schema: { parse(x: unknown): T },
  ) => docs.map((d) => schema.parse(JSON.parse(d.payload)));
  return {
    state,
    canSee: auditVisible({
      ...state,
      management: parse(await managementDocs(ctx, program), recordSchema),
      partsRequests: parse(
        await partsRequestDocs(ctx, program),
        partsRequestSchema,
      ),
      purchaseOrders: parse(await purchaseOrderDocs(ctx, program), poSchema),
      checklists: parse(
        await checklistDocs(ctx, program),
        checklistRecordSchema,
      ),
      componentTemplates: (await componentTemplateDocs(ctx, program)).map((d) =>
        JSON.parse(d.payload),
      ),
      componentSetups: (await componentSetupDocs(ctx, program)).map((d) =>
        JSON.parse(d.payload),
      ),
      inspectionTemplates: parse(
        await inspectionTemplateDocs(ctx, program),
        inspectionTemplateSchema,
      ),
      costs: decode("costs", await costDocs(ctx, program)),
      expiringItems: decode(
        "expiringItems",
        await expiringItemDocs(ctx, program, state.user.isAdmin),
      ),
    }),
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

function parseCursor(cursor: string | null): number | undefined {
  const before = cursor === null ? undefined : Number(cursor);
  if (before !== undefined && !Number.isFinite(before))
    throw new Error("Invalid history cursor.");
  return before;
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
  let floor = before,
    exhausted = false,
    scanned = 0;
  while (!exhausted && visible.length <= n && scanned < SCAN_BUDGET) {
    const batches = await Promise.all(sources.map((s) => s(floor)));
    scanned += batches.reduce((sum, b) => sum + b.length, 0);
    const edge = findCompleteEdge(batches, n);
    exhausted = edge === undefined;
    visible.push(...mergeCompleteRows(batches, edge).filter(shown));
    floor = edge;
  }
  return { visible, exhausted, floor };
}

// Reads rounds from just after the period's last day down to its first day,
// by creation time (written in the same mutation as `at`, so the two agree),
// until every source is exhausted or the budget is spent.
async function scanPeriod(
  sources: Source[],
  canSee: CanSee,
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
    rows.push(...mergeCompleteRows(batches, edge).filter(canSee));
    if (edge === undefined) break;
    floor = edge;
  }
  return { rows, truncated: false };
}

// Rows at or above the newest last row of any full batch are complete: no
// source can still hold an unread row there. Undefined when none was full.
function findCompleteEdge(
  batches: Doc<"audit">[][],
  n: number,
): number | undefined {
  const full = batches.filter((b) => b.length === n);
  return full.length
    ? Math.max(...full.map((b) => b.at(-1)!._creationTime))
    : undefined;
}

function mergeCompleteRows(
  batches: Doc<"audit">[][],
  edge: number | undefined,
): Doc<"audit">[] {
  return [...new Map(batches.flat().map((d) => [d._id, d])).values()]
    .filter((d) => edge === undefined || d._creationTime >= edge)
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
    continueCursor: String(
      !isDone && batch.length < n
        ? scan.floor
        : (batch.at(-1)?._creationTime ?? before ?? 0),
    ),
  };
}

// The ISO date after `date`.
function nextDate(date: string): string {
  return new Date(Date.parse(date + "T00:00:00Z") + DAY_MS)
    .toISOString()
    .slice(0, 10);
}
