/**
 * Responsibility: An aircraft's engine trend imports and its CHT and oil
 *   pressure limits: listing them, importing, removing and setting limits.
 * Layer: Server. A public query and a mutation through runCommand; read
 *   permission on the aircraft to list, maintenance to change.
 * Dependencies: convex/programContext, convex/runCommand, src/domain/model,
 *   src/domain/engineTrends.
 */
import { query, mutation } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { checkContext } from "./programContext";
import { runCommand, type CommandLog, type Transaction } from "./runCommand";
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

type Stored = Awaited<ReturnType<typeof loadTrends>>;
type Working = Awaited<ReturnType<typeof loadForChange>>;
type Change = ReturnType<typeof applyEngineTrendCommand>;

/**
 * Lists an aircraft's engine trend imports and its limits.
 *
 * @param aircraftUuid - The aircraft.
 * @param programUuid - The caller's active Flight Program.
 * @returns The imports, at most `MAX_ENGINE_TRENDS`, and the saved limits or
 *   the defaults.
 * @throws {ConvexError} "Aircraft read permission required."
 * @throws As `checkContext`, first.
 */
export const list = query({
  args: target,
  handler: async (ctx, args): Promise<EngineTrendData> => {
    const state = await checkContext(ctx, args.programUuid);
    if (!can(state, args.aircraftUuid, "read"))
      throw new ConvexError("Aircraft read permission required.");
    return dataOf(await loadTrends(ctx, args.aircraftUuid));
  },
});

/**
 * Imports an engine-data summary, removes an import or sets the limits, and
 * audits `engineTrend.imported`, `.removed` or `.limits`.
 *
 * @param payload - JSON, as `engineTrendCommandSchema`; the other arguments
 *   are {@link list}'s.
 * @throws {ConvexError} As `runCommand`; "Aircraft maintenance permission
 *   required."; "Engine trend data is invalid." for a payload the command
 *   schema refuses; any other error the applier throws, with its message
 *   ("This engine data file was already imported.", …).
 */
export const execute = mutation({
  args: { ...target, payload: v.string() },
  handler: (ctx, args) =>
    runCommand(ctx, {
      programUuid: args.programUuid,
      // Parsed inside apply: malformed data is a user-facing rejection too.
      parse: () => args.payload,
      load: (tx) => loadForChange(tx, args.aircraftUuid),
      apply: ({ loaded, actorId }, payload) =>
        applyEngineTrendCommand(dataOf(loaded), JSON.parse(payload), {
          aircraftUuid: args.aircraftUuid,
          actorId,
          now: Date.now(),
        }),
      expose: showTrendError,
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
      audit: logChange,
    }),
});

async function loadTrends(ctx: QueryCtx, aircraftUuid: string) {
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

function dataOf({ docs, limits }: Stored): EngineTrendData {
  return {
    trends: docs.map((d) => engineTrendSchema.parse(JSON.parse(d.payload))),
    limits: limits
      ? { chtMaxF: limits.chtMaxF, oilPressureMinPsi: limits.oilPressureMinPsi }
      : defaultEngineLimits,
  };
}

async function loadForChange(
  { ctx, state }: Transaction,
  aircraftUuid: string,
) {
  if (!can(state, aircraftUuid, "maintenance"))
    throw new ConvexError("Aircraft maintenance permission required.");
  const programUuid = state.aircraft.find(
    (a) => a.uuid === aircraftUuid,
  )?.programUuid;
  return {
    loaded: await loadTrends(ctx, aircraftUuid),
    actorId: state.user.id,
    scope: { programUuid, aircraftUuid },
  };
}

// A ZodError's message is its issue list as JSON, which starts with "[".
function showTrendError(error: unknown): string {
  return error instanceof Error && !error.message.startsWith("[")
    ? error.message
    : "Engine trend data is invalid.";
}

function logChange(
  log: CommandLog,
  { loaded, scope }: Working,
  result: Change,
) {
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
    log.entry("engineTrend.limits", scope.aircraftUuid, {
      ...scope,
      before: loaded.limits ? dataOf(loaded).limits : undefined,
      after: result.limits,
    });
}
