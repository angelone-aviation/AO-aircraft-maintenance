/**
 * Responsibility: Pages the change log for History: a Flight Program's,
 *   an aircraft's or a record's entries, newest first; and summarizes a
 *   period of it for Flight Program administrators.
 * Layer: Server. Two public queries; they read only entries the snapshot's
 *   visibility rules let the caller see.
 * Dependencies: convex/programContext, convex/collections, src/domain
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
import {
  activeProgram,
  auditVisible,
  programPermission,
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
 * the server's (UTC) dates of each entry.
 *
 * @param programUuid - The caller's active Flight Program.
 * @param from - The first day, as an ISO date.
 * @param to - The last day, inclusive.
 * @returns The summary, and `truncated: true` when 4,000 entries were read
 *   before the period's start was reached, so older entries in it are not
 *   counted; narrow the period in that case.
 * @throws {ConvexError} "Flight Program administrator required."; "Choose a
 *   start and end date." for a date that is not YYYY-MM-DD; "Choose a start
 *   date on or before the end date."
 * @throws As `checkContext`, first.
 */
export const summary = query({
  args: {
    programUuid: v.optional(v.string()),
    from: v.string(),
    to: v.string(),
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
      costs: decode("costs", await costDocs(ctx, program, state.aircraft)),
      expiringItems: decode(
        "expiringItems",
        await expiringItemDocs(ctx, program, state.user.isAdmin),
      ),
    }),
  };
}

function parsePeriod(period: SummaryPeriod): SummaryPeriod {
  if (!ISO_DATE.test(period.from) || !ISO_DATE.test(period.to))
    throw new ConvexError("Choose a start and end date.");
  if (period.from > period.to)
    throw new ConvexError("Choose a start date on or before the end date.");
  return { from: period.from, to: period.to };
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
  const start = Date.parse(period.from + "T00:00:00Z");
  const rows: Doc<"audit">[] = [];
  let floor = Date.parse(period.to + "T00:00:00Z") + DAY_MS;
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
