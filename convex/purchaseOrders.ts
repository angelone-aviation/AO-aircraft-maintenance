/**
 * Responsibility: The purchase-order mutation, through the purchase-order
 *   domain applier, and the attachment list of one purchase order.
 * Layer: Server. Convex mutation and query; the rules live in
 *   src/domain/purchaseOrders.
 * Dependencies: convex/values, ./_generated, ./programContext, ./runCommand,
 *   ./collections, ./workingSet, ./purchasingKeys, src/domain
 *   (partsRequests, purchaseOrders, programs).
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
import {
  highestOrderDocs,
  inProgramOrder,
  orderDocsByKey,
  orderDocsByUuid,
  requestDocsByUuid,
  workOrderDocsByUuid,
} from "./workingSet";
import { syncPurchasingKeys } from "./purchasingKeys";
import type { PartsRequest } from "../src/domain/partsRequests";
import {
  applyPOCommand,
  poCommandSchema,
  type POCommand,
  type POLine,
  type PurchaseOrder,
} from "../src/domain/purchaseOrders";
import { activeProgram, programPermission } from "../src/domain/programs";

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
// derived columns, and its keys, since its history now holds the receipt's
// request id.
async function patchRequests(
  ctx: MutationCtx,
  docs: Doc<"partsRequests">[],
  records: PartsRequest[],
) {
  for (const record of records) {
    const prior = docs.find((d) => d.uuid === record.uuid);
    const row = encode("partsRequests", record);
    if (!prior || prior.payload === row.payload) continue;
    await ctx.db.patch(prior._id, row);
    await syncPurchasingKeys(ctx, "partsRequests", record);
  }
}

// The bounded working set (ADR-0013, H5): stock and inspections whole; of
// the program's orders, those the command names (ordersNamed) and those the
// line checks of a save or issue read beside them (ordersOnLines); of its
// requests, those the lines are allocated to; and of history, the work
// orders the lines point to.
async function loadOrders(
  ctx: MutationCtx,
  state: ProgramContext,
  command: unknown,
) {
  const c = poCommandSchema.safeParse(command).data;
  // Without an active program the applier refuses the command, and no
  // request or order is stored under "", so nothing more is read.
  const program = activeProgram(state) ?? "";
  const hydrated = await hydrate(ctx, state, ["management", "inspections"]);
  const named = await ordersNamed(ctx, program, c);
  const lines = linesNamed(c, decode("purchaseOrders", named));
  const allocated = lines.flatMap((l) =>
    (l.requestAllocations ?? []).map((a) => a.requestUuid),
  );
  const loaded = {
    purchaseOrders: inProgramOrder([
      ...named,
      ...(await ordersOnLines(ctx, program, lines, allocated)),
    ]),
    partsRequests: await requestDocsByUuid(ctx, program, allocated),
    workOrders: await workOrderDocsByUuid(
      ctx,
      lines.map((l) => l.workOrderUuid),
      state.aircraft,
    ),
  };
  return {
    snapshot: {
      ...hydrated.snapshot,
      purchaseOrders: decode("purchaseOrders", loaded.purchaseOrders),
      partsRequests: decode("partsRequests", loaded.partsRequests),
      workOrders: decode("workOrders", loaded.workOrders),
    },
    docs: { ...hydrated.docs, ...loaded },
  };
}

// The orders the command names, those whose history holds its request id
// (a replay, or an id used before), and the highest-numbered, which a new
// draft's number continues from.
async function ordersNamed(
  ctx: MutationCtx,
  program: string,
  c: POCommand | undefined,
) {
  const named = c?.kind === "save" ? c.drafts.map((d) => d.uuid) : [];
  if (c && "uuid" in c) named.push(c.uuid);
  return inProgramOrder([
    ...(await orderDocsByUuid(ctx, program, named)),
    ...(await orderDocsByKey(ctx, program, "requestId", [
      c?.requestUuid ?? "",
    ])),
    ...(await highestOrderDocs(ctx, program)),
  ]);
}

// What a save's or issue's line checks read in other orders: each allocated
// request line's commitments on every order, and any other live repair of
// the same component.
async function ordersOnLines(
  ctx: MutationCtx,
  program: string,
  lines: POLine[],
  allocated: string[],
) {
  const repaired = lines.map((l) => l.repairComponentUuid ?? "");
  return [
    ...(await orderDocsByKey(ctx, program, "allocation", allocated)),
    ...(await orderDocsByKey(ctx, program, "component", repaired)),
  ];
}

// The lines of the command's drafts, and of the stored orders it names. A
// command that does not parse names none; the applier refuses it.
function linesNamed(c: POCommand | undefined, stored: PurchaseOrder[]) {
  if (!c) return [];
  const drafts = c.kind === "save" ? c.drafts : [];
  const named = new Set([
    ...drafts.map((d) => d.uuid),
    ...("uuid" in c ? [c.uuid] : []),
  ]);
  return [
    ...drafts.flatMap((d) => d.lines),
    ...stored.filter((p) => named.has(p.uuid)).flatMap((p) => p.lines),
  ];
}
