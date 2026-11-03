import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { checkContext } from "./programContext";
import { runCommand, hydrate, plainErrors } from "./runCommand";
import { assertNewManagementUuid } from "./management";
import { applyPOCommand } from "../src/domain/purchaseOrders";
import { programPermission } from "../src/domain/programs";
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
        for (const p of changes) {
          const prior = docs.purchaseOrders.find((d) => d.uuid === p.uuid);
          const fields = {
            uuid: p.uuid,
            programUuid: p.programUuid,
            payload: JSON.stringify(p),
          };
          if (prior) await ctx.db.replace(prior._id, fields);
          else if (
            await ctx.db
              .query("purchaseOrders")
              .withIndex("uuid", (q) => q.eq("uuid", p.uuid))
              .first()
          )
            throw new ConvexError("PO not found.");
          else await ctx.db.insert("purchaseOrders", fields);
        }
        for (const r of s.management ?? []) {
          const prior = docs.management.find((d) => d.uuid === r.uuid);
          const payload = JSON.stringify(r);
          if (prior?.payload === payload) continue;
          const fields = {
            uuid: r.uuid,
            programUuid: r.programUuid,
            kind: r.kind,
            aircraftUuid: "aircraftUuid" in r ? r.aircraftUuid : undefined,
            payload,
          };
          if (prior) await ctx.db.replace(prior._id, fields);
          else {
            await assertNewManagementUuid(ctx, r.uuid);
            await ctx.db.insert("management", fields);
          }
        }
        for (const r of s.partsRequests ?? []) {
          const prior = docs.partsRequests.find((d) => d.uuid === r.uuid);
          if (prior && prior.payload !== JSON.stringify(r))
            await ctx.db.patch(prior._id, { payload: JSON.stringify(r) });
        }
      },
      audit: (log, { snapshot }) =>
        log.record(snapshot.audit, { programUuid: args.programUuid }),
      returns: (changes) => changes.map((p) => p.uuid),
    }),
});
export const files = query({
  args: { poUuid: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const s = await checkContext(ctx, args.programUuid);
    if (!programPermission(s, "admin"))
      throw Error("Inventory administrator access required.");
    const po = await ctx.db
      .query("purchaseOrders")
      .withIndex("uuid", (q) => q.eq("uuid", args.poUuid))
      .unique();
    if (!po || po.programUuid !== args.programUuid)
      throw Error("PO not found.");
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
