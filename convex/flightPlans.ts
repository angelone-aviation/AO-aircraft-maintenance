/**
 * Responsibility: The flight-plan mutation: saving an imported or edited plan,
 *   or cancelling it, through the flight-plan domain applier.
 * Layer: Server. Convex mutation over runCommand; the rules live in
 *   src/domain/flightPlans.
 * Dependencies: convex/values, zod, ./_generated, ./access, ./collections,
 *   ./runCommand, src/domain (flightPlans, commandRequest).
 */
import { mutation, type MutationCtx } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { authorized } from "./access";
import { decode } from "./collections";
import {
  runCommand,
  requestOf,
  writeChanged,
  type ProgramContext,
} from "./runCommand";
import {
  flightPlanSchema,
  saveFlightPlan,
  type PlanCommand,
} from "../src/domain/flightPlans";
import { z } from "zod";
import { requestUuidField } from "../src/domain/commandRequest";
const commandSchema = z.object({
  plan: flightPlanSchema,
  baseVersion: z.number().int().nonnegative(),
  ...requestUuidField,
});
const PLAN_ID_USED = "Plan ID already used.";

/**
 * Saves a flight plan on one aircraft and writes the "plan.saved" or
 * "plan.cancelled" row saveFlightPlan records. A replayed request id changes
 * nothing.
 *
 * @param payload - The plan and the version it was edited from, as JSON,
 *   with its request id.
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
      request: (command) => requestOf(command.requestUuid, args.payload),
      load: ({ ctx, state }, command) => loadPlan(ctx, state, command),
      apply: ({ s }, command) => saveFlightPlan(s, command),
      persist: ({ ctx }, { plans }, next) =>
        writeChanged(ctx, "flightPlans", plans, [next]),
      // The row has always named no program.
      audit: (log, { s }) => log.replay(s.audit, { programUuid: undefined }),
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
    throw new ConvexError(PLAN_ID_USED);
  const plans = await ctx.db
    .query("flightPlans")
    .withIndex("aircraft", (q) =>
      q.eq("aircraftUuid", command.plan.aircraftUuid),
    )
    .collect();
  return {
    plans,
    s: {
      ...state,
      flightPlans: decode("flightPlans", plans),
      flights: await ctx.db
        .query("flights")
        .withIndex("plan", (q) => q.eq("flightPlanUuid", command.plan.uuid))
        .collect(),
    },
  };
}
