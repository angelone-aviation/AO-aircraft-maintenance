import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { checkContext } from "./programContext";
import { authorized, audit } from "./access";
import { flightPlanSchema, saveFlightPlan } from "../src/domain/flightPlans";
import { z } from "zod";
const commandSchema = z.object({
  plan: flightPlanSchema,
  baseVersion: z.number().int().nonnegative(),
});
export const save = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const state = await checkContext(ctx, args.programUuid);
    const command = commandSchema.parse(JSON.parse(args.payload));
    const user = await authorized(
      ctx,
      command.plan.aircraftUuid,
      "flight",
      state,
    );
    const existing = await ctx.db
      .query("flightPlans")
      .withIndex("uuid", (q) => q.eq("uuid", command.plan.uuid))
      .unique();
    if (existing && existing.aircraftUuid !== command.plan.aircraftUuid)
      throw new Error("Plan ID already used.");
    const plans = await ctx.db
      .query("flightPlans")
      .withIndex("aircraft", (q) =>
        q.eq("aircraftUuid", command.plan.aircraftUuid),
      )
      .collect();
    const next = saveFlightPlan(
      {
        ...state,
        flightPlans: plans.map((p) =>
          flightPlanSchema.parse(JSON.parse(p.payload)),
        ),
        flights: await ctx.db
          .query("flights")
          .withIndex("plan", (q) => q.eq("flightPlanUuid", command.plan.uuid))
          .collect(),
      },
      command,
    );
    const record = {
      uuid: next.uuid,
      aircraftUuid: next.aircraftUuid,
      payload: JSON.stringify(next),
    };
    if (existing) await ctx.db.replace(existing._id, record);
    else await ctx.db.insert("flightPlans", record);
    await audit(
      ctx,
      user._id,
      next.status === "cancelled" ? "plan.cancelled" : "plan.saved",
      next.uuid,
      {
        aircraftUuid: next.aircraftUuid,
        before: existing ? JSON.parse(existing.payload) : undefined,
        after: next,
      },
    );
    return next.uuid;
  },
});
