/**
 * Responsibility: The cost-records mutation: labor, other costs, part unit
 *   costs, budgets and the labor rate, through the costs domain applier.
 * Layer: Server. Convex mutation over runCommand; the rules live in
 *   src/domain/costs.
 * Dependencies: convex/values, ./_generated, ./runCommand, ./collections,
 *   ./programContext, ./workingSet, src/domain (costs, programs, model).
 */
import { mutation, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { managementDocs } from "./programContext";
import {
  runCommand,
  plainErrors,
  requestOf,
  writeChanged,
  type ProgramContext,
} from "./runCommand";
import {
  archivedCardDocs,
  partsRequestDocsOn,
  workOrderCardDocs,
  workOrderCostDocs,
} from "./workingSet";
import { activeProgram } from "../src/domain/programs";
import { decode, encode } from "./collections";
import type { Snapshot } from "../src/domain/model";
import {
  applyCostCommand,
  costCommandSchema,
  type CostCommand,
} from "../src/domain/costs";

/**
 * Applies one cost command to the active Flight Program's cost records. An
 * unchanged record is neither saved nor audited again, and a replayed request
 * id changes nothing.
 *
 * @param payload - The cost command, as JSON, with its request id.
 * @returns The uuid of the cost record the command targets; nothing for a
 *   replay.
 * @throws {ConvexError} The domain's refusal, such as "Work order not
 *   found."; "Record belongs to another Flight Program." for a cost uuid
 *   another program holds; and runCommand's program refusals.
 */
export const execute = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: (ctx, args) =>
    runCommand(ctx, {
      programUuid: args.programUuid,
      parse: () => costCommandSchema.parse(JSON.parse(args.payload)),
      request: (command) => requestOf(command.requestUuid, args.payload),
      load: async ({ ctx, state }, command) => {
        const order = "workOrderUuid" in command ? command : undefined;
        const docs = await costDocsOf(ctx, state, order?.workOrderUuid);
        const s: Snapshot = { ...state, costs: decode("costs", docs) };
        if (order) await loadWorkOrder(ctx, s, args.programUuid, order);
        return { s, docs };
      },
      apply: ({ s }, command) => applyCostCommand(s, command),
      // Explicit domain validation messages are safe, actionable feedback.
      expose: plainErrors,
      persist: ({ ctx }, { docs }, next) =>
        writeChanged(ctx, "costs", docs, [next]),
      audit: (log, { s, docs }, next) => {
        const prior = docs.find((d) => d.uuid === next.uuid);
        if (prior?.payload !== encode("costs", next).payload)
          log.record(s.audit);
      },
      returns: (next) => next.uuid,
    }),
});

// The program's budgets and labor rate, and a work order's cost records: all
// a cost command reads of them (ADR-0013).
function costDocsOf(
  ctx: MutationCtx,
  state: ProgramContext,
  workOrderUuid: string | undefined,
) {
  const program = activeProgram(state);
  return program ? workOrderCostDocs(ctx, program, [workOrderUuid ?? ""]) : [];
}

// The domain refuses an order whose aircraft is outside this program. A
// part's unit cost also reads the parts issued to the order: the requests
// raised on it or on its job cards, archived ones included.
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
  const cards = await workOrderCardDocs(ctx, [order.uuid], aircraft);
  const archived = await archivedCardDocs(ctx, [order.uuid], aircraft);
  s.taskCards = decode("taskCards", cards);
  s.archivedTaskCards = decode("archivedTaskCards", archived);
  const raisedOn = {
    workOrderUuids: [order.uuid],
    sourceUuids: [...cards, ...archived].map((c) => c.uuid),
  };
  s.partsRequests = decode(
    "partsRequests",
    program ? await partsRequestDocsOn(ctx, program, raisedOn) : [],
  );
}
