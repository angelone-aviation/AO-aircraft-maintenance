import { query, mutation, type QueryCtx } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { checkContext } from "./programContext";
import { runCommand } from "./runCommand";
import { can } from "../src/domain/model";
import {
  applyEngineTrendCommand,
  defaultEngineLimits,
  engineTrendSchema,
  MAX_ENGINE_TRENDS,
  type EngineTrendData,
} from "../src/domain/engineTrends";
const target = {
  aircraftUuid: v.string(),
  programUuid: v.optional(v.string()),
};
async function load(ctx: QueryCtx, aircraftUuid: string) {
  const docs = await ctx.db
    .query("engineTrends")
    .withIndex("aircraft", (q) => q.eq("aircraftUuid", aircraftUuid))
    .take(MAX_ENGINE_TRENDS);
  const limits = await ctx.db
    .query("engineTrendLimits")
    .withIndex("aircraft", (q) => q.eq("aircraftUuid", aircraftUuid))
    .unique();
  return { docs, limits };
}
const dataOf = ({ docs, limits }: Awaited<ReturnType<typeof load>>) => ({
  trends: docs.map((d) => engineTrendSchema.parse(JSON.parse(d.payload))),
  limits: limits
    ? { chtMaxF: limits.chtMaxF, oilPressureMinPsi: limits.oilPressureMinPsi }
    : defaultEngineLimits,
});
export const list = query({
  args: target,
  handler: async (ctx, args): Promise<EngineTrendData> => {
    const state = await checkContext(ctx, args.programUuid);
    if (!can(state, args.aircraftUuid, "read"))
      throw new ConvexError("Aircraft read permission required.");
    return dataOf(await load(ctx, args.aircraftUuid));
  },
});
export const execute = mutation({
  args: { ...target, payload: v.string() },
  handler: (ctx, args) =>
    runCommand(ctx, {
      programUuid: args.programUuid,
      // Parsed inside apply: malformed data is a user-facing rejection too.
      parse: () => args.payload,
      load: async ({ ctx, state }) => {
        if (!can(state, args.aircraftUuid, "maintenance"))
          throw new ConvexError("Aircraft maintenance permission required.");
        const programUuid = state.aircraft.find(
          (a) => a.uuid === args.aircraftUuid,
        )?.programUuid;
        const loaded = await load(ctx, args.aircraftUuid);
        return {
          loaded,
          actorId: state.user.id,
          scope: { programUuid, aircraftUuid: args.aircraftUuid },
        };
      },
      apply: ({ loaded, actorId }, payload) =>
        applyEngineTrendCommand(dataOf(loaded), JSON.parse(payload), {
          aircraftUuid: args.aircraftUuid,
          actorId,
          now: Date.now(),
        }),
      expose: (e) =>
        e instanceof Error && !e.message.startsWith("[")
          ? e.message
          : "Engine trend data is invalid.",
      persist: async ({ ctx }, { loaded, scope }, result) => {
        if (result.created)
          await ctx.db.insert("engineTrends", {
            uuid: result.created.uuid,
            aircraftUuid: args.aircraftUuid,
            programUuid: scope.programUuid,
            payload: JSON.stringify(result.created),
          });
        else if (result.removed) {
          const doc = loaded.docs.find((d) => d.uuid === result.removed!.uuid)!;
          await ctx.db.delete(doc._id);
        } else {
          const limits = { ...scope, ...result.limits };
          if (loaded.limits) await ctx.db.replace(loaded.limits._id, limits);
          else await ctx.db.insert("engineTrendLimits", limits);
        }
      },
      audit: (log, { loaded, scope }, result) => {
        if (result.created)
          log.entry("engineTrend.imported", result.created.uuid, {
            ...scope,
            after: result.created,
          });
        else if (result.removed)
          log.entry("engineTrend.removed", result.removed.uuid, {
            ...scope,
            before: result.removed,
          });
        else
          log.entry("engineTrend.limits", args.aircraftUuid, {
            ...scope,
            before: loaded.limits ? dataOf(loaded).limits : undefined,
            after: result.limits,
          });
      },
    }),
});
