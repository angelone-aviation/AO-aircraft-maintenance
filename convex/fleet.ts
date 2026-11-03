import { ensureDefaultGroups } from "./defaultGroups";
import { activeProgram } from "../src/domain/programs";
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { currentUser } from "./access";
import { runCommand, hydrate } from "./runCommand";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { applyFleet, fleetCommandSchema } from "../src/domain/fleet";
export const save = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, { payload, programUuid }) =>
    runCommand(ctx, {
      programUuid,
      actor: await currentUser(ctx),
      parse: () => fleetCommandSchema.parse(JSON.parse(payload)),
      request: (command) => ({ uuid: command.requestUuid, payload }),
      load: ({ ctx, state }) =>
        hydrate(ctx, state, ["management", "inspections"]),
      apply: ({ snapshot }, command) => applyFleet(snapshot, command),
      persist: async ({ ctx, state, log }, { docs }, result) => {
        const { aircraft, programs } = state;
        if (result.aircraft) {
          const existing = aircraft.find(
            (a) => a.uuid === result.aircraft!.uuid,
          );
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
          const existing = programs.find(
            (p) => p.uuid === result.program!.uuid,
          );
          if (existing) await ctx.db.replace(existing._id, result.program);
          else {
            await ctx.db.insert("programs", result.program);
            await ensureDefaultGroups(
              ctx,
              result.program.uuid,
              log.actorId,
              log,
            );
          }
        }
        for (const component of result.components) {
          const doc = docs.management.find((r) => r.uuid === component.uuid)!;
          await ctx.db.patch(doc._id, { payload: JSON.stringify(component) });
        }
      },
      audit: (log, { snapshot }, result) =>
        log.replay(snapshot.audit, {
          programUuid: result.program?.uuid ?? activeProgram(snapshot),
        }),
    }),
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
