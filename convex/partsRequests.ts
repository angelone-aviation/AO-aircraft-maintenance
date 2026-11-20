/**
 * Responsibility: The parts-request mutation: saving, reserving, releasing,
 *   issuing and cancelling, through the parts-request domain applier.
 * Layer: Server. Convex mutation over runCommand; the rules live in
 *   src/domain/partsRequests.
 * Dependencies: convex/values, ./_generated, ./runCommand, ./collections,
 *   src/domain (model, management, partsRequests).
 */
import { mutation, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import { runCommand, hydrate, writeChanged } from "./runCommand";
import { decode, encode } from "./collections";
import {
  applyRequestCommand,
  type PartsRequest,
} from "../src/domain/partsRequests";
import type { Snapshot } from "../src/domain/model";
import type { ManagedRecord } from "../src/domain/management";

/**
 * Applies one parts-request command in the active Flight Program, with the
 * stock it moves. An issue also writes the work-order cost records that
 * record its price (decision D13). Saving an active recurring list also
 * writes the requests the applier creates for the open work orders on its
 * aircraft. Each change has its change-log row.
 *
 * @param payload - The request command, as JSON.
 * @returns The uuid of the request the command changed.
 * @throws {ConvexError} A domain Rejection; "Record belongs to another Flight
 *   Program." for a request uuid another Flight Program holds; runCommand's
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
          "archivedTaskCards",
          "airworthiness",
          "inspections",
          "discrepancies",
          "costs",
        ]),
      apply: ({ snapshot }, command) => applyRequestCommand(snapshot, command),
      persist: async ({ ctx }, { snapshot: s, docs }, r) => {
        await writeChanged(
          ctx,
          "partsRequests",
          docs.partsRequests,
          changedRequests(s, docs.partsRequests, r),
        );
        await patchStock(ctx, docs.management, s.management ?? []);
        await writeChanged(
          ctx,
          "costs",
          docs.costs,
          pricedCosts(s, docs.costs),
        );
      },
      audit: (log, { snapshot }) => log.record(snapshot.audit),
      returns: (r) => r.uuid,
    }),
});

// The command's request, then the occurrences the applier created for a saved
// list: the requests with no stored row. Only these are written, so a loaded
// row the command left alone is never rewritten.
function changedRequests(
  s: Snapshot,
  loaded: Doc<"partsRequests">[],
  saved: PartsRequest,
) {
  const stored = new Set(loaded.map((d) => d.uuid));
  return (s.partsRequests ?? []).filter(
    (r) => r.uuid === saved.uuid || !stored.has(r.uuid),
  );
}

// The cost records an issue priced: new ones, and stored ones at a new
// version. Only these are written, so a loaded row the command left alone is
// never rewritten.
function pricedCosts(s: Snapshot, loaded: Doc<"costs">[]) {
  const stored = new Map(
    decode("costs", loaded).map((r) => [r.uuid, r.version]),
  );
  return (s.costs ?? []).filter((r) => stored.get(r.uuid) !== r.version);
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
