import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { runCommand, hydrate } from "./runCommand";
import {
  adAuditRecord,
  adCommandReason,
  adSchema,
  adCommandSchema,
  applyADCommand,
} from "../src/domain/airworthiness";
export const save = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: (ctx, args) =>
    runCommand(ctx, {
      programUuid: args.programUuid,
      parse: () => adCommandSchema.parse(JSON.parse(args.payload)),
      load: ({ ctx, state }) =>
        hydrate(ctx, state, ["airworthiness", "management", "workOrders"]),
      apply: ({ snapshot }, command) => applyADCommand(snapshot, command),
      persist: async ({ ctx }, { docs }, changed) => {
        for (const r of changed) {
          const value = {
            uuid: r.uuid,
            aircraftUuid: r.aircraftUuid,
            programUuid: r.programUuid,
            payload: JSON.stringify(r),
          };
          const old = docs.airworthiness.find((d) => d.uuid === r.uuid);
          if (old) await ctx.db.replace(old._id, value);
          else if (
            await ctx.db
              .query("airworthiness")
              .withIndex("uuid", (q) => q.eq("uuid", r.uuid))
              .first()
          )
            throw new Error("AD record belongs to another Flight Program.");
          else await ctx.db.insert("airworthiness", value);
        }
      },
      audit: (log, { docs }, changed, command) => {
        for (const r of changed) {
          const old = docs.airworthiness.find((d) => d.uuid === r.uuid);
          log.entry("ad." + command.kind, r.uuid, {
            aircraftUuid: r.aircraftUuid,
            programUuid: r.programUuid,
            reason: adCommandReason(command),
            before: old
              ? adAuditRecord(adSchema.parse(JSON.parse(old.payload)))
              : undefined,
            after: adAuditRecord(r),
          });
        }
      },
      returns: (changed) => changed.length,
    }),
});
