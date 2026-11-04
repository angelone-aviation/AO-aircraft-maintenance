/**
 * Responsibility: The flight-plan mutation: saving an imported or edited plan,
 *   or cancelling it, through the flight-plan domain applier.
 * Layer: Server. Convex mutation over runCommand; the rules live in
 *   src/domain/flightPlans.
 * Dependencies: convex/values, zod, ./_generated, ./access, ./runCommand,
 *   src/domain/flightPlans.
 */
import { mutation, type MutationCtx } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { authorized } from "./access";
import { runCommand, type ProgramContext } from "./runCommand";
import {
  flightPlanSchema,
  saveFlightPlan,
  type PlanCommand,
} from "../src/domain/flightPlans";
import { z } from "zod";
const commandSchema = z.object({
  plan: flightPlanSchema,
  baseVersion: z.number().int().nonnegative(),
});

/**
 * Saves a flight plan on one aircraft and writes a "plan.saved" or
 * "plan.cancelled" change-log row with the plan before and after.
 *
 * @param payload - The plan and the version it was edited from, as JSON.
 * @returns The plan's uuid.
 * @throws {ConvexError} "Plan ID already used." for a plan uuid stored on
 *   another aircraft; a domain Rejection, such as "Plan changed. Reopen it
 *   before saving."; authorized's flight permission and runCommand's program
 *   refusals.
 */
export const save = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: (ctx, args) =>
    runCommand(ctx, {
      programUuid: args.programUuid,
      parse: () => commandSchema.parse(JSON.parse(args.payload)),
      load: ({ ctx, state }, command) => loadPlan(ctx, state, command),
      apply: ({ s }, command) => saveFlightPlan(s, command),
      persist: async ({ ctx }, { existing }, next) => {
        const record = {
          uuid: next.uuid,
          aircraftUuid: next.aircraftUuid,
          payload: JSON.stringify(next),
        };
        if (existing) await ctx.db.replace(existing._id, record);
        else await ctx.db.insert("flightPlans", record);
      },
      audit: (log, { existing }, next) =>
        log.entry(
          next.status === "cancelled" ? "plan.cancelled" : "plan.saved",
          next.uuid,
          {
            aircraftUuid: next.aircraftUuid,
            before: existing ? JSON.parse(existing.payload) : undefined,
            after: next,
          },
        ),
      returns: (next) => next.uuid,
    }),
});

// The applier reads the aircraft's plans and the flights logged against this
// plan. Plans are loaded per aircraft, so a uuid stored on another aircraft is
// refused here rather than overwritten.
async function loadPlan(
  ctx: MutationCtx,
  state: ProgramContext,
  command: PlanCommand,
) {
  await authorized(ctx, command.plan.aircraftUuid, "flight", state);
  const existing = await ctx.db
    .query("flightPlans")
    .withIndex("uuid", (q) => q.eq("uuid", command.plan.uuid))
    .unique();
  if (existing && existing.aircraftUuid !== command.plan.aircraftUuid)
    throw new ConvexError("Plan ID already used.");
  const plans = await ctx.db
    .query("flightPlans")
    .withIndex("aircraft", (q) =>
      q.eq("aircraftUuid", command.plan.aircraftUuid),
    )
    .collect();
  return {
    existing,
    s: {
      ...state,
      flightPlans: plans.map((p) =>
        flightPlanSchema.parse(JSON.parse(p.payload)),
      ),
      flights: await ctx.db
        .query("flights")
        .withIndex("plan", (q) => q.eq("flightPlanUuid", command.plan.uuid))
        .collect(),
    },
  };
}
