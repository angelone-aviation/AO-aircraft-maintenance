import { mutation } from "./_generated/server";
import { v } from "convex/values";
import {
  checkContext,
  managementDocs,
  workOrderDocs,
  airworthinessDocs,
} from "./programContext";
import { audit } from "./access";
import {
  adAuditRecord,
  adCommandReason,
  adSchema,
  adCommandSchema,
  applyADCommand,
} from "../src/domain/airworthiness";
import { recordSchema } from "../src/domain/management";
import { workOrderSchema } from "../src/domain/workOrders";
export const save = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const base = await checkContext(ctx, args.programUuid);
    const command = adCommandSchema.parse(JSON.parse(args.payload));
    const docs = await airworthinessDocs(ctx, base.aircraft);
    const state = {
      ...base,
      airworthiness: docs.map((d) => adSchema.parse(JSON.parse(d.payload))),
      management: (await managementDocs(ctx, args.programUuid)).map((d) =>
        recordSchema.parse(JSON.parse(d.payload)),
      ),
      workOrders: (await workOrderDocs(ctx, base.aircraft)).map((d) =>
        workOrderSchema.parse(JSON.parse(d.payload)),
      ),
    };
    const changed = applyADCommand(state, command);
    for (const r of changed) {
      const value = {
        uuid: r.uuid,
        aircraftUuid: r.aircraftUuid,
        programUuid: r.programUuid,
        payload: JSON.stringify(r),
      };
      const old = docs.find((d) => d.uuid === r.uuid);
      if (old) await ctx.db.replace(old._id, value);
      else if (
        await ctx.db
          .query("airworthiness")
          .withIndex("uuid", (q) => q.eq("uuid", r.uuid))
          .first()
      )
        throw new Error("AD record belongs to another Flight Program.");
      else await ctx.db.insert("airworthiness", value);
      await audit(
        ctx,
        base.user.id as import("./_generated/dataModel").Id<"users">,
        "ad." + command.kind,
        r.uuid,
        {
          aircraftUuid: r.aircraftUuid,
          programUuid: r.programUuid,
          reason: adCommandReason(command),
          before: old
            ? adAuditRecord(adSchema.parse(JSON.parse(old.payload)))
            : undefined,
          after: adAuditRecord(r),
        },
      );
    }
    return changed.length;
  },
});
