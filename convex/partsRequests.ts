import { generateRecurringRequests } from "../src/domain/recurringParts";
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { runCommand, hydrate } from "./runCommand";
import { applyRequestCommand } from "../src/domain/partsRequests";
export const execute = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: (ctx, args) =>
    runCommand(ctx, {
      programUuid: args.programUuid,
      parse: () => JSON.parse(args.payload),
      load: ({ ctx, state }) =>
        hydrate(ctx, state, [
          "management",
          "partsRequests",
          "purchaseOrders",
          "workOrders",
          "taskCards",
          "airworthiness",
          "inspections",
          "discrepancies",
        ]),
      apply: ({ snapshot }, command) => applyRequestCommand(snapshot, command),
      persist: async ({ ctx }, { snapshot: s, docs }, r) => {
        const previous = docs.partsRequests.find((d) => d.uuid === r.uuid);
        const fields = {
          uuid: r.uuid,
          programUuid: r.programUuid,
          payload: JSON.stringify(r),
        };
        if (previous) await ctx.db.replace(previous._id, fields);
        else if (
          await ctx.db
            .query("partsRequests")
            .withIndex("uuid", (q) => q.eq("uuid", r.uuid))
            .first()
        )
          throw new Error("Request identifier already used.");
        else await ctx.db.insert("partsRequests", fields);
        if (r.recurring && !r.cancelled) {
          for (const order of s.workOrders ?? []) {
            if (order.aircraftUuid !== r.aircraftUuid) continue;
            for (const created of generateRecurringRequests(s, order))
              await ctx.db.insert("partsRequests", {
                uuid: created.uuid,
                programUuid: created.programUuid,
                payload: JSON.stringify(created),
              });
          }
        }
        for (const record of s.management ?? []) {
          const prior = docs.management.find((d) => d.uuid === record.uuid);
          const payload = JSON.stringify(record);
          if (prior && prior.payload !== payload)
            await ctx.db.patch(prior._id, { payload });
        }
      },
      audit: (log, { snapshot }) =>
        log.record(snapshot.audit, { programUuid: args.programUuid }),
      returns: (r) => r.uuid,
    }),
});
