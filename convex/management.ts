/**
 * Responsibility: Inventory and inspection records (locations, stock,
 *   components and their requirements, inspections) changed as one command,
 *   and the one-off oil marker backfill.
 * Layer: Server. A public mutation through runCommand and an internal
 *   migration; the rules are the domain's applyManagement.
 * Dependencies: convex/runCommand, convex/access, src/domain (programs,
 *   management, model).
 */
import { activeProgram } from "../src/domain/programs";
import { mutation, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import { currentUser, audit } from "./access";
import { runCommand, hydrate, type LoadedDocs } from "./runCommand";
import type { MutationCtx } from "./_generated/server";
import type { Inspection } from "../src/domain/model";
import {
  applyManagement,
  managementCommandSchema,
  recordSchema,
  inspectionSchema,
  type ManagedRecord,
} from "../src/domain/management";

const OIL_BACKFILL_BATCH = 500;

type ManagementResult = ReturnType<typeof applyManagement>;
type ManagementDocs = Pick<LoadedDocs, "management" | "inspections">;

/**
 * Applies one inventory or inspection command in the caller's Flight Program;
 * a replayed request id changes nothing. Audits the command's action, and
 * `inspection.component_transferred` for each inspection that moved with its
 * component.
 *
 * @param payload - JSON, as `managementCommandSchema`.
 * @param programUuid - The caller's active Flight Program.
 * @throws {ConvexError} As `runCommand`; "Record belongs to another Flight
 *   Program." for a new record or inspection whose uuid another program uses.
 */
export const execute = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, { payload, programUuid }) =>
    runCommand(ctx, {
      programUuid,
      actor: await currentUser(ctx),
      parse: () => managementCommandSchema.parse(JSON.parse(payload)),
      request: (command) => ({ uuid: command.requestUuid, payload }),
      load: ({ ctx, state }) =>
        hydrate(ctx, state, ["management", "inspections"]),
      apply: ({ snapshot }, command) => applyManagement(snapshot, command),
      persist: async ({ ctx }, { docs }, result) => {
        if ("kind" in result.next) await persistRecords(ctx, docs, result);
        else await persistInspection(ctx, docs, result.next);
      },
      audit: (log, { snapshot, docs }, result, command) => {
        if ("kind" in result.next)
          for (const inspection of result.updatedInspections)
            log.entry("inspection.component_transferred", inspection.uuid, {
              aircraftUuid: inspection.aircraftUuid,
              reason: command.reason,
              before: docs.inspections.find((i) => i.uuid === inspection.uuid),
              after: inspection,
            });
        log.entry(snapshot.audit[0].action, result.next.uuid, {
          programUuid: activeProgram(snapshot),
          aircraftUuid: result.aircraftUuid,
          reason: command.reason,
          before: result.before,
          after: result.next,
        });
      },
    }),
});

/**
 * Refuses a new record uuid that any Flight Program already uses: scoped
 * loads cannot see other programs' rows, so the check reads globally.
 *
 * @throws {ConvexError} "Record belongs to another Flight Program."
 */
export async function assertNewManagementUuid(ctx: MutationCtx, uuid: string) {
  if (
    await ctx.db
      .query("management")
      .withIndex("uuid", (q) => q.eq("uuid", uuid))
      .first()
  )
    throw new ConvexError("Record belongs to another Flight Program.");
}

/**
 * One-off after the deploy that added the stock `oil` marker, run with `npx
 * convex run management:backfillOilMarker`. Flight-line deductions now refuse
 * stock not marked as oil, so this marks every stock item that already has a
 * `stock.oil_used` change-log row, with one new entry by `system` each.
 * Existing rows are never modified, and rerunning it is safe.
 *
 * @param cursor - Where in the change log to continue; it schedules itself,
 *   500 rows at a time, until done.
 * @returns This batch's counts: rows scanned; items marked, already marked,
 *   or missing (gone, or no longer stock); and whether the log is done.
 */
export const backfillOilMarker = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const batch = await ctx.db
      .query("audit")
      .paginate({ cursor: cursor ?? null, numItems: OIL_BACKFILL_BATCH });
    const used = new Set(
      batch.page
        .filter((a) => a.action === "stock.oil_used")
        .map((a) => a.entityUuid),
    );
    const counts = { marked: 0, alreadyMarked: 0, missing: 0 };
    for (const uuid of used) counts[await markOilStock(ctx, uuid)]++;
    if (!batch.isDone)
      await ctx.scheduler.runAfter(0, internal.management.backfillOilMarker, {
        cursor: batch.continueCursor,
      });
    return { scanned: batch.page.length, ...counts, isDone: batch.isDone };
  },
});

async function persistRecords(
  ctx: MutationCtx,
  docs: ManagementDocs,
  result: Pick<ManagementResult, "records" | "updatedInspections">,
) {
  for (const record of result.records) await saveRecord(ctx, docs, record);
  for (const inspection of result.updatedInspections) {
    const doc = docs.inspections.find((i) => i.uuid === inspection.uuid)!;
    await ctx.db.patch(doc._id, {
      aircraftUuid: inspection.aircraftUuid,
      version: inspection.version,
    });
  }
}

async function saveRecord(
  ctx: MutationCtx,
  docs: ManagementDocs,
  record: ManagedRecord,
) {
  const doc = docs.management.find((d) => d.uuid === record.uuid);
  const fields = {
    programUuid: record.programUuid,
    uuid: record.uuid,
    kind: record.kind,
    aircraftUuid:
      "aircraftUuid" in record ? record.aircraftUuid || undefined : undefined,
    payload: JSON.stringify(record),
  };
  if (doc) return ctx.db.replace(doc._id, fields);
  await assertNewManagementUuid(ctx, record.uuid);
  await ctx.db.insert("management", fields);
}

async function persistInspection(
  ctx: MutationCtx,
  docs: ManagementDocs,
  next: Inspection,
) {
  const doc = docs.inspections.find((d) => d.uuid === next.uuid);
  // Strip database metadata inherited by a completion.
  const fields = inspectionSchema.parse({
    ...next,
    materials: next.materials ?? "",
    archived: next.archived ?? false,
  });
  if (doc) return ctx.db.replace(doc._id, fields);
  if (
    await ctx.db
      .query("inspections")
      .withIndex("uuid", (q) => q.eq("uuid", fields.uuid))
      .first()
  )
    throw new ConvexError("Record belongs to another Flight Program.");
  await ctx.db.insert("inspections", fields);
}

async function markOilStock(
  ctx: MutationCtx,
  uuid: string,
): Promise<"marked" | "alreadyMarked" | "missing"> {
  const doc = await ctx.db
    .query("management")
    .withIndex("uuid", (q) => q.eq("uuid", uuid))
    .unique();
  const record = doc && recordSchema.parse(JSON.parse(doc.payload));
  if (!doc || !record || record.kind !== "stock") return "missing";
  if (record.oil === true) return "alreadyMarked";
  await ctx.db.patch(doc._id, {
    payload: JSON.stringify({
      ...record,
      oil: true,
      version: record.version + 1,
    }),
  });
  await audit(ctx, "system", "stock.oil_marker_backfill", uuid, {
    programUuid: doc.programUuid ?? record.programUuid,
    reason:
      "Migration: marked as engine oil because it was already drawn down on the flight line.",
    before: { stockUuid: uuid, oil: record.oil ?? false },
    after: { stockUuid: uuid, oil: true },
  });
  return "marked";
}
