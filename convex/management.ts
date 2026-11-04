/**
 * Responsibility: Inventory and inspection records (locations, stock,
 *   components and their requirements, inspections) changed as one command.
 * Layer: Server. A public mutation through runCommand; the rules are the
 *   domain's applyManagement.
 * Dependencies: convex/runCommand, convex/access, src/domain (programs,
 *   management, model).
 */
import { activeProgram } from "../src/domain/programs";
import { mutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { currentUser } from "./access";
import {
  runCommand,
  hydrate,
  writeChanged,
  type LoadedDocs,
} from "./runCommand";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { Inspection } from "../src/domain/model";
import {
  applyManagement,
  managementCommandSchema,
  inspectionSchema,
} from "../src/domain/management";

const RECORD_TAKEN = "Record belongs to another Flight Program.";

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
        else await writeInspection(ctx, docs.inspections, result.next);
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
    throw new ConvexError(RECORD_TAKEN);
}

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
  await writeChanged(
    ctx,
    "management",
    docs.management,
    result.records,
    RECORD_TAKEN,
  );
  for (const inspection of result.updatedInspections) {
    const doc = docs.inspections.find((i) => i.uuid === inspection.uuid)!;
    await ctx.db.patch(doc._id, {
      aircraftUuid: inspection.aircraftUuid,
      version: inspection.version,
    });
  }
}
