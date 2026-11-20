/**
 * Responsibility: The purchase-order mutation, through the purchase-order
 *   domain applier, and the attachment list of one purchase order.
 * Layer: Server. Convex mutation and query; the rules live in
 *   src/domain/purchaseOrders.
 * Dependencies: convex/values, ./_generated, ./programContext, ./runCommand,
 *   ./collections, src/domain (management, partsRequests, purchaseOrders,
 *   programs).
 */
import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import { checkContext } from "./programContext";
import { runCommand, hydrate, plainErrors, writeChanged } from "./runCommand";
import { encode } from "./collections";
import type { PartsRequest } from "../src/domain/partsRequests";
import { applyPOCommand } from "../src/domain/purchaseOrders";
import { programPermission } from "../src/domain/programs";

const PO_NOT_FOUND = "PO not found.";

/**
 * Applies one purchase-order command in the active Flight Program: drafts,
 * issue, shipments and receipts, with the stock, components and parts
 * requests they change.
 *
 * @param payload - The purchase-order command, as JSON.
 * @returns The uuids of the purchase orders the command changed.
 * @throws {ConvexError} The domain's refusal; "Record belongs to another
 *   Flight Program." for a PO, stock or component uuid that another Flight
 *   Program holds; runCommand's program refusals.
 */
export const execute = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: (ctx, args) =>
    runCommand(ctx, {
      programUuid: args.programUuid,
      parse: () => JSON.parse(args.payload),
      load: ({ ctx, state }) =>
        hydrate(ctx, state, [
          "partsRequests",
          "purchaseOrders",
          "management",
          "inspections",
          "workOrders",
        ]),
      apply: ({ snapshot }, command) => applyPOCommand(snapshot, command),
      // Explicit domain validation messages are safe, actionable user feedback.
      // Unexpected parser/schema/runtime errors retain server-side details only.
      expose: plainErrors,
      persist: async ({ ctx }, { snapshot: s, docs }, changes) => {
        await writeChanged(ctx, "purchaseOrders", docs.purchaseOrders, changes);
        await writeChanged(
          ctx,
          "management",
          docs.management,
          s.management ?? [],
        );
        await patchRequests(ctx, docs.partsRequests, s.partsRequests ?? []);
      },
      audit: (log, { snapshot }) => log.record(snapshot.audit),
      returns: (changes) => changes.map((p) => p.uuid),
    }),
});

/**
 * Lists a purchase order's attachments, with download links, for an
 * inventory administrator of its Flight Program.
 *
 * @returns Each file's id, name, receipt and link.
 * @throws {ConvexError} "Inventory administrator access required."; "PO not
 *   found." for a purchase order outside the program; checkContext's
 *   program refusals.
 */
export const files = query({
  args: { poUuid: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const s = await checkContext(ctx, args.programUuid);
    if (!programPermission(s, "admin"))
      throw new ConvexError("Inventory administrator access required.");
    const po = await ctx.db
      .query("purchaseOrders")
      .withIndex("uuid", (q) => q.eq("uuid", args.poUuid))
      .unique();
    if (!po || po.programUuid !== args.programUuid)
      throw new ConvexError(PO_NOT_FOUND);
    const files = await ctx.db
      .query("poFiles")
      .withIndex("po", (q) => q.eq("poUuid", args.poUuid))
      .collect();
    return Promise.all(
      files.map(async (f) => ({
        uuid: f._id,
        name: f.name,
        receiptUuid: f.receiptUuid,
        url: await ctx.storage.getUrl(f.storageId),
      })),
    );
  },
});

// Receipts change a request's reservations and never create one, so only a
// changed request is written: its whole row, so an older row gets its
// derived columns.
async function patchRequests(
  ctx: MutationCtx,
  docs: Doc<"partsRequests">[],
  records: PartsRequest[],
) {
  for (const record of records) {
    const prior = docs.find((d) => d.uuid === record.uuid);
    const row = encode("partsRequests", record);
    if (prior && prior.payload !== row.payload)
      await ctx.db.patch(prior._id, row);
  }
}
