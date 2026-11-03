import { checkContext, managementDocs, inspectionDocs } from "./programContext";
import { activeProgram } from "../src/domain/programs";
import { mutation, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { ComponentUsageError } from "../src/domain/components";
import { currentUser, member, audit } from "./access";
import type { MutationCtx } from "./_generated/server";
import {
  applyManagement,
  managementCommandSchema,
  recordSchema,
  inspectionSchema,
} from "../src/domain/management";
import type { Snapshot } from "../src/domain/model";
export const execute = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, { payload, programUuid }) => {
    const user = await currentUser(ctx);
    const programContext = await checkContext(ctx, programUuid, user);
    const command = managementCommandSchema.parse(JSON.parse(payload));
    const prior = await ctx.db
      .query("managementRequests")
      .withIndex("uuid", (q) => q.eq("uuid", command.requestUuid))
      .unique();
    if (prior) {
      if (prior.actorId !== user._id || prior.payload !== payload)
        throw new Error("Request identifier already used.");
      return;
    }
    const documents = await managementDocs(ctx, programUuid);
    const inspections = await inspectionDocs(
      ctx,
      programContext.aircraft,
      documents,
    );
    const state: Snapshot = {
      manuals: programContext.manuals,
      programs: programContext.programs,
      user: member(user),
      groups: programContext.groups,
      members: [],
      aircraft: programContext.aircraft,
      flights: [],
      discrepancies: [],
      inspections,
      management: documents.map((d) =>
        recordSchema.parse(JSON.parse(d.payload)),
      ),
      audit: [],
      authenticatedAt: Date.now(),
      syncedAt: Date.now(),
    };
    const result = (() => {
      try {
        return applyManagement(state, command);
      } catch (error) {
        // Expected input errors must survive production error redaction.
        if (error instanceof ComponentUsageError)
          throw new ConvexError(error.message);
        throw error;
      }
    })();
    if ("kind" in result.next) {
      for (const record of result.records) {
        const doc = documents.find((d) => d.uuid === record.uuid);
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
        const doc = inspections.find((i) => i.uuid === inspection.uuid)!;
        await ctx.db.patch(doc._id, {
          aircraftUuid: inspection.aircraftUuid,
          version: inspection.version,
        });
        await audit(
          ctx,
          user._id,
          "inspection.component_transferred",
          inspection.uuid,
          {
            aircraftUuid: inspection.aircraftUuid,
            reason: command.reason,
            before: doc,
            after: inspection,
          },
        );
      }
    } else {
      const doc = inspections.find((d) => d.uuid === result.next.uuid);
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
    await audit(ctx, user._id, state.audit[0].action, result.next.uuid, {
      programUuid: activeProgram(state),
      aircraftUuid: result.aircraftUuid,
      reason: command.reason,
      before: result.before,
      after: result.next,
    });
    await ctx.db.insert("managementRequests", {
      uuid: command.requestUuid,
      actorId: user._id,
      payload,
    });
  },
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
