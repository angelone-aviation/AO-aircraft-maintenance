import { mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import {
  managementDocs,
  partsRequestDocs,
  taskCardDocs,
  archivedTaskCardDocs,
} from "./programContext";
import { runCommand, hydrate, plainErrors } from "./runCommand";
import { applyCostCommand, costCommandSchema } from "../src/domain/costs";
import { workOrderSchema } from "../src/domain/workOrders";
import { recordSchema } from "../src/domain/management";
import { partsRequestSchema } from "../src/domain/partsRequests";
import { taskCardSchema } from "../src/domain/taskCards";
import type { CostRecord } from "../src/domain/costs";
const row = (next: CostRecord) => ({
  uuid: next.uuid,
  programUuid: next.programUuid,
  aircraftUuid: next.kind === "settings" ? "" : next.aircraftUuid,
  payload: JSON.stringify(next),
});
export const execute = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: (ctx, args) =>
    runCommand(ctx, {
      programUuid: args.programUuid,
      parse: () => costCommandSchema.parse(JSON.parse(args.payload)),
      load: async ({ ctx, state }, command) => {
        const { snapshot: s, docs } = await hydrate(ctx, state, ["costs"]);
        if ("workOrderUuid" in command) {
          const order = await ctx.db
            .query("workOrders")
            .withIndex("uuid", (q) => q.eq("uuid", command.workOrderUuid))
            .unique();
          // The domain rejects orders whose aircraft is outside this program.
          s.workOrders = order
            ? [workOrderSchema.parse(JSON.parse(order.payload))]
            : [];
          if (command.action === "part.unitCost" && order) {
            const aircraft = [{ uuid: order.aircraftUuid }];
            s.management = (await managementDocs(ctx, args.programUuid)).map(
              (d) => recordSchema.parse(JSON.parse(d.payload)),
            );
            s.partsRequests = (
              await partsRequestDocs(ctx, args.programUuid)
            ).map((d) => partsRequestSchema.parse(JSON.parse(d.payload)));
            s.taskCards = (await taskCardDocs(ctx, aircraft)).map((d) =>
              taskCardSchema.parse(JSON.parse(d.payload)),
            );
            s.archivedTaskCards = (
              await archivedTaskCardDocs(ctx, aircraft)
            ).map((d) => taskCardSchema.parse(JSON.parse(d.payload)));
          }
        }
        return { s, docs: docs.costs };
      },
      apply: ({ s }, command) => applyCostCommand(s, command),
      // Explicit domain validation messages are safe, actionable feedback.
      expose: plainErrors,
      persist: async ({ ctx }, { docs }, next) => {
        const fields = row(next);
        const prior = docs.find((d) => d.uuid === next.uuid);
        if (prior) {
          if (prior.payload !== fields.payload)
            await ctx.db.replace(prior._id, fields);
        } else if (
          await ctx.db
            .query("costs")
            .withIndex("uuid", (q) => q.eq("uuid", next.uuid))
            .first()
        )
          // A uuid outside the active program is never overwritten.
          throw new ConvexError(
            "Cost record belongs to another Flight Program.",
          );
        else await ctx.db.insert("costs", fields);
      },
      // An unchanged record is not saved again, so it is not audited again.
      audit: (log, { s, docs }, next) => {
        const prior = docs.find((d) => d.uuid === next.uuid);
        if (prior?.payload !== row(next).payload) log.record(s.audit);
      },
      returns: (next) => next.uuid,
    }),
});
