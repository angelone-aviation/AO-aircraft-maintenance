/**
 * Responsibility: The cost-records mutation: labor, other costs, part unit
 *   costs, budgets and the labor rate, through the costs domain applier.
 * Layer: Server. Convex mutation over runCommand; the rules live in
 *   src/domain/costs.
 * Dependencies: convex/values, ./_generated, ./runCommand, ./collections,
 *   ./programContext, src/domain/costs.
 */
import { mutation, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import {
  managementDocs,
  partsRequestDocs,
  taskCardDocs,
  archivedTaskCardDocs,
} from "./programContext";
import { runCommand, hydrate, plainErrors, writeChanged } from "./runCommand";
import { decode, encode } from "./collections";
import type { Snapshot } from "../src/domain/model";
import {
  applyCostCommand,
  costCommandSchema,
  type CostCommand,
} from "../src/domain/costs";

/**
 * Applies one cost command to the active Flight Program's cost records. An
 * unchanged record is neither saved nor audited again.
 *
 * @param payload - The cost command, as JSON.
 * @returns The uuid of the cost record the command targets.
 * @throws {ConvexError} The domain's refusal, such as "Work order not
 *   found."; "Cost record belongs to another Flight Program."; and
 *   runCommand's program refusals.
 */
export const execute = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: (ctx, args) =>
    runCommand(ctx, {
      programUuid: args.programUuid,
      parse: () => costCommandSchema.parse(JSON.parse(args.payload)),
      load: async ({ ctx, state }, command) => {
        const { snapshot: s, docs } = await hydrate(ctx, state, ["costs"]);
        if ("workOrderUuid" in command)
          await loadWorkOrder(ctx, s, args.programUuid, command);
        return { s, docs: docs.costs };
      },
      apply: ({ s }, command) => applyCostCommand(s, command),
      // Explicit domain validation messages are safe, actionable feedback.
      expose: plainErrors,
      persist: ({ ctx }, { docs }, next) =>
        writeChanged(
          ctx,
          "costs",
          docs,
          [next],
          "Cost record belongs to another Flight Program.",
        ),
      audit: (log, { s, docs }, next) => {
        const prior = docs.find((d) => d.uuid === next.uuid);
        if (prior?.payload !== encode("costs", next).payload)
          log.record(s.audit);
      },
      returns: (next) => next.uuid,
    }),
});

// The domain refuses an order whose aircraft is outside this program. A
// part's unit cost also reads the parts issued to the order and its job cards.
async function loadWorkOrder(
  ctx: MutationCtx,
  s: Snapshot,
  program: string | undefined,
  command: Extract<CostCommand, { workOrderUuid: string }>,
) {
  const order = await ctx.db
    .query("workOrders")
    .withIndex("uuid", (q) => q.eq("uuid", command.workOrderUuid))
    .unique();
  s.workOrders = order ? decode("workOrders", [order]) : [];
  if (command.action !== "part.unitCost" || !order) return;
  const aircraft = [{ uuid: order.aircraftUuid }];
  s.management = decode("management", await managementDocs(ctx, program));
  s.partsRequests = decode(
    "partsRequests",
    await partsRequestDocs(ctx, program),
  );
  s.taskCards = decode("taskCards", await taskCardDocs(ctx, aircraft));
  s.archivedTaskCards = decode(
    "archivedTaskCards",
    await archivedTaskCardDocs(ctx, aircraft),
  );
}
