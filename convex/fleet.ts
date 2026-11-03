import { ensureDefaultGroups } from "./defaultGroups";
import { checkContext, managementDocs, inspectionDocs } from "./programContext";
import { activeProgram } from "../src/domain/programs";
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { currentUser, member, audit } from "./access";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { applyFleet, fleetCommandSchema } from "../src/domain/fleet";
import { recordSchema } from "../src/domain/management";
import type { Snapshot } from "../src/domain/model";
export const save = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, { payload, programUuid }) => {
    const actor = await currentUser(ctx);
    const programContext = await checkContext(ctx, programUuid, actor),
      command = fleetCommandSchema.parse(JSON.parse(payload));
    const prior = await ctx.db
      .query("managementRequests")
      .withIndex("uuid", (q) => q.eq("uuid", command.requestUuid))
      .unique();
    if (prior) {
      if (prior.actorId !== actor._id || prior.payload !== payload)
        throw new Error("Request identifier already used.");
      return;
    }
    const { aircraft, programs } = programContext,
      records = await managementDocs(ctx, programUuid);
    const state: Snapshot = {
      user: member(actor),
      groups: programContext.groups,
      members: [],
      aircraft,
      programs,
      management: records.map((r) => recordSchema.parse(JSON.parse(r.payload))),
      inspections: await inspectionDocs(ctx, aircraft, records),
      flights: [],
      discrepancies: [],
      audit: [],
      syncedAt: Date.now(),
      authenticatedAt: Date.now(),
    };
    const result = applyFleet(state, command);
    if (result.aircraft) {
      const existing = aircraft.find((a) => a.uuid === result.aircraft!.uuid);
      await assertAvailableAircraft(ctx, result.aircraft, existing);
      const {
        _id: ignoredId,
        _creationTime: ignoredTime,
        ...fields
      } = result.aircraft as typeof result.aircraft & {
        _id?: unknown;
        _creationTime?: number;
      };
      if (existing) await ctx.db.replace(existing._id, fields);
      else await ctx.db.insert("aircraft", fields);
    }
    if (result.program) {
      const existing = programs.find((p) => p.uuid === result.program!.uuid);
      if (existing) await ctx.db.replace(existing._id, result.program);
      else {
        await ctx.db.insert("programs", result.program);
        await ensureDefaultGroups(ctx, result.program.uuid, actor._id);
      }
    }
    for (const component of result.components) {
      const doc = records.find((r) => r.uuid === component.uuid)!;
      await ctx.db.patch(doc._id, { payload: JSON.stringify(component) });
    }
    for (const entry of state.audit)
      await audit(ctx, actor._id, entry.action, entry.entityUuid, {
        programUuid: result.program?.uuid ?? activeProgram(state),
        aircraftUuid: entry.aircraftUuid,
        reason: entry.reason,
        before: entry.before ? JSON.parse(entry.before) : undefined,
        after: entry.after ? JSON.parse(entry.after) : undefined,
      });
    await ctx.db.insert("managementRequests", {
      uuid: command.requestUuid,
      actorId: actor._id,
      payload,
    });
  },
});
// Program state is tenant-scoped, so identifiers and registrations are checked
// globally here without revealing which other program holds them.
export async function assertAvailableAircraft(
  ctx: MutationCtx,
  next: { uuid: string; registration: string },
  existing?: Doc<"aircraft">,
) {
  if (
    !existing &&
    (await ctx.db
      .query("aircraft")
      .withIndex("uuid", (q) => q.eq("uuid", next.uuid))
      .first())
  )
    throw new Error("Aircraft belongs to another Flight Program.");
  const holder = await ctx.db
    .query("aircraft")
    .withIndex("registration", (q) => q.eq("registration", next.registration))
    .first();
  if (holder && holder.uuid !== next.uuid)
    throw new Error("This registration cannot be used.");
}
