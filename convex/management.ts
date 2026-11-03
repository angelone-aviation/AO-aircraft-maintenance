import { activeProgram } from "../src/domain/programs";
import { mutation, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { ComponentUsageError } from "../src/domain/components";
import { currentUser, audit } from "./access";
import { runCommand, hydrate, errorsOf } from "./runCommand";
import type { MutationCtx } from "./_generated/server";
import {
  applyManagement,
  managementCommandSchema,
  recordSchema,
  inspectionSchema,
} from "../src/domain/management";
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
      // Expected input errors must survive production error redaction.
      expose: errorsOf(ComponentUsageError),
      persist: async ({ ctx }, { docs }, result) => {
        if ("kind" in result.next) {
          for (const record of result.records) {
            const doc = docs.management.find((d) => d.uuid === record.uuid);
            const fields = {
              programUuid: record.programUuid,
              uuid: record.uuid,
              kind: record.kind,
              aircraftUuid:
                "aircraftUuid" in record
                  ? record.aircraftUuid || undefined
                  : undefined,
              payload: JSON.stringify(record),
            };
            if (doc) await ctx.db.replace(doc._id, fields);
            else {
              await assertNewManagementUuid(ctx, record.uuid);
              await ctx.db.insert("management", fields);
            }
          }
          for (const inspection of result.updatedInspections) {
            const doc = docs.inspections.find(
              (i) => i.uuid === inspection.uuid,
            )!;
            await ctx.db.patch(doc._id, {
              aircraftUuid: inspection.aircraftUuid,
              version: inspection.version,
            });
          }
        } else {
          const doc = docs.inspections.find((d) => d.uuid === result.next.uuid);
          // Strip database metadata inherited by a completion.
          const fields = inspectionSchema.parse({
            ...result.next,
            materials: result.next.materials ?? "",
            archived: result.next.archived ?? false,
          });
          if (doc) await ctx.db.replace(doc._id, fields);
          else if (
            await ctx.db
              .query("inspections")
              .withIndex("uuid", (q) => q.eq("uuid", fields.uuid))
              .first()
          )
            throw new Error("Record belongs to another Flight Program.");
          else await ctx.db.insert("inspections", fields);
        }
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
// Scoped loads cannot see other tenants' rows, so new identifiers are checked
// globally before insert to avoid duplicating another program's record.
export async function assertNewManagementUuid(ctx: MutationCtx, uuid: string) {
  if (
    await ctx.db
      .query("management")
      .withIndex("uuid", (q) => q.eq("uuid", uuid))
      .first()
  )
    throw new Error("Record belongs to another Flight Program.");
}

const OIL_BACKFILL_BATCH = 500;
// One-off after the deploy that added the stock `oil` marker. Run with
// `npx convex run management:backfillOilMarker`. Flight-line deductions now
// refuse stock not marked as oil, so this marks every stock item that already
// has a `stock.oil_used` change-log row. It reads the change log in batches,
// scheduling itself until done, and never modifies existing rows: each stock
// item it marks gets one new append-only entry. Safe to rerun.
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
    let marked = 0,
      alreadyMarked = 0,
      missing = 0;
    for (const uuid of used) {
      const doc = await ctx.db
        .query("management")
        .withIndex("uuid", (q) => q.eq("uuid", uuid))
        .unique();
      const record = doc && recordSchema.parse(JSON.parse(doc.payload));
      if (!doc || !record || record.kind !== "stock") {
        missing++;
        continue;
      }
      if (record.oil === true) {
        alreadyMarked++;
        continue;
      }
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
      marked++;
    }
    if (!batch.isDone)
      await ctx.scheduler.runAfter(0, internal.management.backfillOilMarker, {
        cursor: batch.continueCursor,
      });
    return {
      scanned: batch.page.length,
      marked,
      alreadyMarked,
      missing,
      isDone: batch.isDone,
    };
  },
});
