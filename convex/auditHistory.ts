import { v } from "convex/values";
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
  transferredAuditDocs,
} from "./programContext";
import { activeProgram, auditVisible } from "../src/domain/programs";
import { recordSchema } from "../src/domain/management";
import { partsRequestSchema } from "../src/domain/partsRequests";
import { poSchema } from "../src/domain/purchaseOrders";
import { checklistRecordSchema } from "../src/domain/checklists";
import { inspectionTemplateSchema } from "../src/domain/inspectionTemplates";
import {
  canPageAuditFilter,
  clampAuditPageSize,
  HISTORY_NOT_FOUND,
  type AuditPage,
} from "../src/domain/auditHistory";
import type { AuditEntry } from "../src/domain/model";
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
    }),
  };
}
// Entries read per request before a page is returned short; only reached when
// a long run of the caller's own program index is hidden from them.
const SCAN_BUDGET = 4000;
// Pages newest-first through the audit log. Program-wide history merges the
// program index, each visible aircraft's index (most aircraft entries carry no
// program column) and the rows transfers listed for the program, so
// `.paginate()` cannot express it; instead each index is read as a range below
// the cursor's _creationTime.
//
// Nothing about entries the caller cannot see may leak (S12): a filter naming
// a record or aircraft outside the caller's scope is refused before paging
// (at most the record's newest entry is read, to check it is visible), with
// the same answer as an unknown id, and the page, isDone and
// continueCursor are built only from entries the caller can see.
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
    const before = args.cursor === null ? undefined : Number(args.cursor);
    if (before !== undefined && !Number.isFinite(before))
      throw new Error("Invalid history cursor.");
    const newest = args.entityUuid
      ? await ctx.db
          .query("audit")
          .withIndex("entity", (q) => q.eq("entityUuid", args.entityUuid!))
          .order("desc")
          .first()
      : null;
    if (!canPageAuditFilter(canSee, args, newest))
      throw new Error(HISTORY_NOT_FOUND);
    type Source = (below: number | undefined) => Promise<Doc<"audit">[]>;
    const read =
      (
        index: "program" | "aircraft" | "entity",
        field: "programUuid" | "aircraftUuid" | "entityUuid",
        value: string | undefined,
      ): Source =>
      (below) =>
        ctx.db
          .query("audit")
          .withIndex(index, (q) => {
            const eq = q.eq(field, value);
            return below === undefined ? eq : eq.lt("_creationTime", below);
          })
          .order("desc")
          .take(n);
    const program = activeProgram(state);
    const sources: Source[] = args.entityUuid
      ? [read("entity", "entityUuid", args.entityUuid)]
      : args.aircraftUuid
        ? [read("aircraft", "aircraftUuid", args.aircraftUuid)]
        : [
            read("program", "programUuid", program),
            ...state.aircraft
              .filter((a) =>
                canPageAuditFilter(canSee, { aircraftUuid: a.uuid }),
              )
              .map((a) => read("aircraft", "aircraftUuid", a.uuid)),
            (below) => transferredAuditDocs(ctx, program, n, below),
          ];
    const shown = (d: Doc<"audit">) =>
      canSee(d) && (!args.aircraftUuid || d.aircraftUuid === args.aircraftUuid);
    // Read rounds below `floor` until one entry more than a page is visible
    // (so isDone is exact) or every source is exhausted. Within a round, rows
    // at or above the newest "last row" of any full source are complete.
    const visible: Doc<"audit">[] = [];
    let floor = before,
      exhausted = false,
      scanned = 0;
    while (!exhausted && visible.length <= n && scanned < SCAN_BUDGET) {
      const batches = await Promise.all(sources.map((s) => s(floor)));
      scanned += batches.reduce((sum, b) => sum + b.length, 0);
      const full = batches.filter((b) => b.length === n);
      const edge = full.length
        ? Math.max(...full.map((b) => b.at(-1)!._creationTime))
        : undefined;
      exhausted = edge === undefined;
      const rows = [...new Map(batches.flat().map((d) => [d._id, d])).values()]
        .filter((d) => edge === undefined || d._creationTime >= edge)
        .sort((a, b) => b._creationTime - a._creationTime);
      visible.push(...rows.filter(shown));
      floor = edge;
    }
    const batch = visible.slice(0, n);
    const isDone = exhausted && visible.length <= n;
    return {
      page: batch.map(({ _id, _creationTime, ...entry }): AuditEntry => entry),
      isDone,
      // A short page that is not done stopped on the scan budget inside the
      // caller's own indexes; continue from where the scan stopped.
      continueCursor: String(
        !isDone && batch.length < n
          ? floor
          : (batch.at(-1)?._creationTime ?? before ?? 0),
      ),
    };
  },
});
