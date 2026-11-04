/**
 * Responsibility: The parts-request mutation: saving, reserving, releasing,
 *   issuing and cancelling, through the parts-request domain applier.
 * Layer: Server. Convex mutation over runCommand; the rules live in
 *   src/domain/partsRequests and src/domain/recurringParts.
 * Dependencies: convex/values, ./_generated, ./runCommand, ./collections,
 *   src/domain (model, management, partsRequests, recurringParts).
 */
import { mutation, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import { runCommand, hydrate, writeChanged } from "./runCommand";
import { encode } from "./collections";
import {
  applyRequestCommand,
  type PartsRequest,
} from "../src/domain/partsRequests";
import type { Snapshot } from "../src/domain/model";
import type { ManagedRecord } from "../src/domain/management";
import { generateRecurringRequests } from "../src/domain/recurringParts";

const REQUEST_TAKEN = "Request identifier already used.";

/**
 * Applies one parts-request command in the active Flight Program, with the
 * stock it moves. Saving an active recurring list also creates the requests
 * it owes the open work orders on its aircraft.
 *
 * @param payload - The request command, as JSON.
 * @returns The uuid of the request the command changed.
 * @throws {ConvexError} A domain Rejection; "Request identifier already
 *   used." for a request uuid another Flight Program holds; runCommand's
 *   program refusals.
 */
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
        await writeChanged(
          ctx,
          "partsRequests",
          docs.partsRequests,
          [r],
          REQUEST_TAKEN,
        );
        if (r.recurring && !r.cancelled) await insertOwedRequests(ctx, s, r);
        await patchStock(ctx, docs.management, s.management ?? []);
      },
      audit: (log, { snapshot }) =>
        log.record(snapshot.audit, { programUuid: args.programUuid }),
      returns: (r) => r.uuid,
    }),
});

// An active recurring list owes a request to each open work order on its
// aircraft that has none from it yet (generateRecurringRequests).
async function insertOwedRequests(
  ctx: MutationCtx,
  s: Snapshot,
  list: PartsRequest,
) {
  for (const order of s.workOrders ?? []) {
    if (order.aircraftUuid !== list.aircraftUuid) continue;
    for (const created of generateRecurringRequests(s, order))
      await ctx.db.insert("partsRequests", encode("partsRequests", created));
  }
}

// Parts commands change stock quantities, never a record's columns, so a
// changed record's row keeps the columns it was written with.
async function patchStock(
  ctx: MutationCtx,
  docs: Doc<"management">[],
  records: ManagedRecord[],
) {
  for (const record of records) {
    const prior = docs.find((d) => d.uuid === record.uuid);
    const { payload } = encode("management", record);
    if (prior && prior.payload !== payload)
      await ctx.db.patch(prior._id, { payload });
  }
}
