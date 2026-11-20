/**
 * Responsibility: The purchase-order mutation, through the purchase-order
 *   domain applier, and the attachment list of one purchase order.
 * Layer: Server. Convex mutation and query; the rules live in
 *   src/domain/purchaseOrders.
 * Dependencies: convex/values, ./_generated, ./programContext, ./runCommand,
 *   ./collections, ./workingSet, src/domain (management, partsRequests,
 *   purchaseOrders, programs).
 */
import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import { checkContext } from "./programContext";
import {
  runCommand,
  hydrate,
  plainErrors,
  writeChanged,
  type ProgramContext,
} from "./runCommand";
import { decode, encode } from "./collections";
import { workOrderDocsByUuid } from "./workingSet";
import type { PartsRequest } from "../src/domain/partsRequests";
import {
  applyPOCommand,
  poCommandSchema,
  type PurchaseOrder,
} from "../src/domain/purchaseOrders";
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
      load: ({ ctx, state }, command) => loadOrders(ctx, state, command),
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
 * Lists a purchase order's attachments for an inventory administrator of its
 * Flight Program. None carries a link: each opens through convex/fileLinks.ts.
 *
 * @returns Each file's id, name and receipt.
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
    return files.map((f) => ({
      uuid: f._id,
      name: f.name,
      receiptUuid: f.receiptUuid,
    }));
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

// The bounded working set (ADR-0013): parts requests, purchase orders, stock
// and inspections whole (H5 keeps requests and orders complete), and only the
// work orders the command's lines, or the lines of the orders it names,
// point to: the line checks read no other.
async function loadOrders(
  ctx: MutationCtx,
  state: ProgramContext,
  command: unknown,
) {
  const hydrated = await hydrate(ctx, state, [
    "partsRequests",
    "purchaseOrders",
    "management",
    "inspections",
  ]);
  const orders = await workOrderDocsByUuid(
    ctx,
    workOrdersNamed(command, hydrated.snapshot.purchaseOrders ?? []),
    state.aircraft,
  );
  return {
    snapshot: {
      ...hydrated.snapshot,
      workOrders: decode("workOrders", orders),
    },
    docs: { ...hydrated.docs, workOrders: orders },
  };
}

// The work orders a command's draft lines name, and those the lines of the
// stored orders it names do. A command that does not parse names none; the
// applier refuses it.
function workOrdersNamed(command: unknown, stored: PurchaseOrder[]) {
  const parsed = poCommandSchema.safeParse(command);
  if (!parsed.success) return [];
  const c = parsed.data;
  const drafts = c.kind === "save" ? c.drafts : [];
  const named = new Set([
    ...drafts.map((d) => d.uuid),
    ...("uuid" in c ? [c.uuid] : []),
  ]);
  const lines = [
    ...drafts.flatMap((d) => d.lines),
    ...stored.filter((p) => named.has(p.uuid)).flatMap((p) => p.lines),
  ];
  return lines.map((l) => l.workOrderUuid ?? "");
}
