/**
 * Responsibility: Inventory and inspection records (locations, stock,
 *   components and their requirements, inspections) changed as one command.
 * Layer: Server. A public mutation through runCommand; the rules are the
 *   domain's applyManagement.
 * Dependencies: convex/runCommand, convex/access, src/domain (changeLog,
 *   management, model).
 */
import { auditEntry } from "../src/domain/changeLog";
import { mutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { currentUser } from "./access";
import {
  runCommand,
  hydrate,
  writeChanged,
  RECORD_TAKEN,
  type LoadedDocs,
} from "./runCommand";
import type { MutationCtx } from "./_generated/server";
import { scheduleUrgentAlerts } from "./urgentAlerts";
import type { Doc } from "./_generated/dataModel";
import type { Inspection } from "../src/domain/model";
import {
  applyManagement,
  managementCommandSchema,
  inspectionSchema,
} from "../src/domain/management";

type ManagementResult = ReturnType<typeof applyManagement>;
type ManagementDocs = Pick<LoadedDocs, "management" | "inspections">;

/**
 * Applies one inventory or inspection command in the caller's Flight Program;
 * a replayed request id changes nothing. Logs an
 * `inspection.component_transferred` row for each inspection that moved with
 * its component, then the applier's entry for the command. Afterwards the
 * program's urgent alerts are checked (convex/urgentAlerts.ts).
 *
 * @param payload - JSON, as `managementCommandSchema`.
 * @param programUuid - The caller's active Flight Program.
 * @throws {ConvexError} As `runCommand`; "Record belongs to another Flight
 *   Program." for a new record or inspection whose uuid another program uses.
 */
export const execute = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, { payload, programUuid }) => {
    await runCommand(ctx, {
      programUuid,
      actor: await currentUser(ctx),
      parse: () => managementCommandSchema.parse(JSON.parse(payload)),
      request: (command) => ({ uuid: command.requestUuid, payload }),
      load: ({ ctx, state }) =>
        hydrate(ctx, state, ["management", "inspections"]),
      apply: ({ snapshot }, command) => applyManagement(snapshot, command),
      persist: async ({ ctx }, { docs }, result) => {
        if ("kind" in result.next) await persistRecords(ctx, docs, result);
        else await writeInspection(ctx, docs.inspections, result.next);
      },
      audit: (log, { snapshot, docs }, result, command) => {
        log.replay(
          result.updatedInspections.map((inspection) =>
            auditEntry(snapshot, {
              action: "inspection.component_transferred",
              entityUuid: inspection.uuid,
              aircraftUuid: inspection.aircraftUuid,
              reason: command.reason,
              before: docs.inspections.find((i) => i.uuid === inspection.uuid),
              after: inspection,
            }),
          ),
        );
        log.replay(snapshot.audit);
      },
    });
    await scheduleUrgentAlerts(ctx, programUuid);
  },
});

/**
 * Writes an inspection a command saved: replaces its loaded row, or inserts
 * it when no Flight Program stores its uuid. The system fields a completion
 * inherits from the loaded row are stripped.
 *
 * @param loaded - The inspections the command loaded.
 * @param inspection - The inspection as the applier left it.
 * @throws {ConvexError} "Record belongs to another Flight Program." for a new
 *   inspection whose uuid is already stored.
 */
export async function writeInspection(
  ctx: MutationCtx,
  loaded: readonly Doc<"inspections">[],
  inspection: Inspection,
) {
  const doc = loaded.find((d) => d.uuid === inspection.uuid);
  const fields = inspectionSchema.parse({
    ...inspection,
    materials: inspection.materials ?? "",
    archived: inspection.archived ?? false,
  });
  if (doc) return ctx.db.replace(doc._id, fields);
  if (
    await ctx.db
      .query("inspections")
      .withIndex("uuid", (q) => q.eq("uuid", fields.uuid))
      .first()
  )
    throw new ConvexError(RECORD_TAKEN);
  await ctx.db.insert("inspections", fields);
}

async function persistRecords(
  ctx: MutationCtx,
  docs: ManagementDocs,
  result: Pick<ManagementResult, "records" | "updatedInspections">,
) {
  await writeChanged(ctx, "management", docs.management, result.records);
  for (const inspection of result.updatedInspections) {
    const doc = docs.inspections.find((i) => i.uuid === inspection.uuid)!;
    await ctx.db.patch(doc._id, {
      aircraftUuid: inspection.aircraftUuid,
      version: inspection.version,
    });
  }
}
