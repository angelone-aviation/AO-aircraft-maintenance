/**
 * Responsibility: Each aircraft's FAA AD monitor: its settings, candidate
 *   reviews, and the manual and daily checks that fill it.
 * Layer: Server. One public mutation over internal steps; the command,
 *   search and merge rules are the domain's, and each run is charged to the
 *   FAA allowance.
 * Dependencies: convex (access, faaSearch, faaCredentials, programContext,
 *   userErrors), src/domain (faa, faaMonitoringSearch, model, airworthiness,
 *   management), zod.
 */
import {
  monitoringQueries,
  monitoringScope,
  fetchMonitoringCandidates,
} from "../src/domain/faaMonitoringSearch";
import {
  mutation,
  internalMutation,
  internalQuery,
  internalAction,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { ConvexError, v } from "convex/values";
import { audit } from "./access";
import { chargeFaaAllowance } from "./faaSearch";
import { faaSecret } from "./faaCredentials";
import { exposeRejections } from "./userErrors";
import {
  checkContext,
  managementDocs,
  airworthinessDocs,
} from "./programContext";
import { can } from "../src/domain/model";
import { adSchema } from "../src/domain/airworthiness";
import { recordSchema } from "../src/domain/management";
import {
  applyFaaCommand,
  emptyMonitor,
  faaCommandSchema,
  faaMonitorSchema,
  mergeCandidates,
  faaCandidateSchema,
  monitorAttemptedWithin,
  startFaaRun,
  type FaaMonitor,
} from "../src/domain/faa";
import { z } from "zod";

/**
 * How many aircraft one Flight Program may monitor daily: the daily checks
 * share the program's FAA allowance with interactive searches.
 */
export const MAX_ENABLED_FAA_MONITORS = 25;

// A monitor attempted within the last hour (a manual check) skips the daily run.
const DAILY_SKIP_RECENT_MS = 3_600_000;
// Keeps the stored monitor under Convex's 1 MiB document limit.
const CANDIDATE_HISTORY_MAX_BYTES = 700_000;

/**
 * Charges a monitoring run to the same FAA allowances as interactive searches.
 *
 * @param aircraftUuid - The monitored aircraft, whose program is charged.
 * @param requests - How many FAA requests the run makes.
 * @throws {ConvexError} The allowance refusals of `chargeFaaAllowance`.
 */
export const chargeRun = internalMutation({
  args: { aircraftUuid: v.string(), requests: v.number() },
  handler: async (ctx, args) => {
    const aircraft = await findAircraft(ctx, args.aircraftUuid);
    if (!aircraft) throw Error("Aircraft not found.");
    await chargeFaaAllowance(ctx, aircraft.programUuid ?? "", args.requests);
  },
});

/**
 * Configures an aircraft's monitor, reviews one of its candidates, or starts a
 * check now; audits "faa.<kind>" with the command.
 *
 * @param payload - JSON, as `faaCommandSchema`.
 * @param programUuid - The caller's active Flight Program.
 * @throws {ConvexError} As `checkContext`; "Aircraft maintenance permission
 *   required."; the {@link MAX_ENABLED_FAA_MONITORS} cap, when enabling;
 *   "Candidate not found."; "Wait one minute before checking again."
 * @throws A ZodError for an invalid payload.
 */
export const command = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const state = await checkContext(ctx, args.programUuid);
    const cmd = faaCommandSchema.parse(JSON.parse(args.payload));
    if (!can(state, cmd.aircraftUuid, "maintenance"))
      throw new ConvexError("Aircraft maintenance permission required.");
    const doc = await findMonitor(ctx, cmd.aircraftUuid);
    const m = doc ? parseMonitor(doc) : emptyMonitor(cmd.aircraftUuid);
    if (cmd.kind === "configure" && cmd.enabled && !m.enabled)
      await assertMonitorCapacity(ctx, cmd.aircraftUuid);
    const next = exposeRejections(() => applyFaaCommand(m, cmd, Date.now()));
    if (cmd.kind === "check")
      await scheduleRun(ctx, cmd.aircraftUuid, next.runId);
    const record = {
      aircraftUuid: cmd.aircraftUuid,
      payload: JSON.stringify(next),
    };
    if (doc) await ctx.db.replace(doc._id, record);
    else await ctx.db.insert("faaMonitors", record);
    await audit(ctx, state.user.id, "faa." + cmd.kind, cmd.aircraftUuid, {
      aircraftUuid: cmd.aircraftUuid,
      after: cmd,
    });
  },
});

/**
 * What a run searches for: the aircraft's scope and FAA queries, from its
 * records and the ADs of the whole program's fleet.
 *
 * @param runId - The run; a monitor since given another run gets null.
 * @returns The terms and queries, or null when the monitor, the run or the
 *   aircraft is gone.
 */
export const input = internalQuery({
  args: { aircraftUuid: v.string(), runId: v.string() },
  handler: async (ctx, args) => {
    const doc = await findMonitor(ctx, args.aircraftUuid);
    if (!doc) return null;
    const m = parseMonitor(doc);
    if (m.runId !== args.runId) return null;
    const a = await findAircraft(ctx, args.aircraftUuid);
    if (!a) return null;
    const management = (await managementDocs(ctx, a.programUuid)).map((d) =>
      recordSchema.parse(JSON.parse(d.payload)),
    );
    // Component ADs follow the component, so read the whole program's fleet.
    const fleet = await ctx.db
      .query("aircraft")
      .withIndex("program", (q) => q.eq("programUuid", a.programUuid))
      .collect();
    const ads = (await airworthinessDocs(ctx, fleet)).map((d) =>
      adSchema.parse(JSON.parse(d.payload)),
    );
    const state = { aircraft: [a], management, airworthiness: ads };
    return {
      terms: monitoringScope(state, args.aircraftUuid, m.terms),
      queries: monitoringQueries(state, args.aircraftUuid, m.terms),
    };
  },
});

/**
 * Ends a run: stores its error, or merges its candidates and marks the check
 * successful. A run the monitor no longer expects changes nothing.
 *
 * @param payload - JSON array of `faaCandidateSchema` candidates.
 * @param error - Why the run failed; "" for a successful run.
 * @param terms - The terms the run searched.
 */
export const finish = internalMutation({
  args: {
    aircraftUuid: v.string(),
    runId: v.string(),
    payload: v.string(),
    error: v.string(),
    terms: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const doc = await findMonitor(ctx, args.aircraftUuid);
    if (!doc) return;
    const m = parseMonitor(doc);
    if (m.runId !== args.runId) return;
    m.runId = "";
    m.error = args.error;
    if (!args.error) saveResults(m, args);
    await ctx.db.patch(doc._id, { payload: JSON.stringify(m) });
  },
});

/**
 * Runs one check: charges the allowance, searches FAA DRS and hands the
 * results, or why it failed, to {@link finish}.
 *
 * @param runId - The run the monitor expects; any other is ignored.
 */
export const check = internalAction({
  args: { aircraftUuid: v.string(), runId: v.string() },
  handler: async (ctx, args) => {
    let terms: string[] = [];
    let payload = "[]";
    let error = "";
    try {
      const input = await ctx.runQuery(internal.faa.input, args);
      if (!input) return;
      terms = input.terms;
      const key = await currentFaaKey(ctx);
      await ctx.runMutation(internal.faa.chargeRun, {
        aircraftUuid: args.aircraftUuid,
        requests: input.queries.length,
      });
      payload = JSON.stringify(
        await fetchMonitoringCandidates(key, input.queries),
      );
    } catch (e) {
      // Any failure is the run's result: the monitor shows it and keeps its
      // last successful check.
      error = e instanceof Error ? e.message : "FAA check failed.";
    }
    await ctx.runMutation(internal.faa.finish, {
      ...args,
      payload,
      error,
      terms,
    });
  },
});

/**
 * Starts a check on every enabled monitor not attempted within the last hour
 * (the daily cron).
 */
export const daily = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const doc of await ctx.db.query("faaMonitors").collect()) {
      const m = parseMonitor(doc);
      const now = Date.now();
      if (!m.enabled || monitorAttemptedWithin(m, DAILY_SKIP_RECENT_MS, now))
        continue;
      const next = startFaaRun(m, now);
      await scheduleRun(ctx, m.aircraftUuid, next.runId);
      await ctx.db.patch(doc._id, { payload: JSON.stringify(next) });
    }
  },
});

function findAircraft(ctx: QueryCtx | MutationCtx, uuid: string) {
  return ctx.db
    .query("aircraft")
    .withIndex("uuid", (q) => q.eq("uuid", uuid))
    .unique();
}

function findMonitor(ctx: QueryCtx | MutationCtx, aircraftUuid: string) {
  return ctx.db
    .query("faaMonitors")
    .withIndex("aircraft", (q) => q.eq("aircraftUuid", aircraftUuid))
    .unique();
}

function parseMonitor(doc: Doc<"faaMonitors">) {
  return faaMonitorSchema.parse(JSON.parse(doc.payload));
}

async function assertMonitorCapacity(ctx: MutationCtx, aircraftUuid: string) {
  const aircraft = await findAircraft(ctx, aircraftUuid);
  if (!aircraft) throw Error("Aircraft not found.");
  const fleet = await ctx.db
    .query("aircraft")
    .withIndex("program", (q) => q.eq("programUuid", aircraft.programUuid))
    .collect();
  let enabled = 0;
  for (const a of fleet) {
    const doc = await findMonitor(ctx, a.uuid);
    if (doc && parseMonitor(doc).enabled) enabled++;
  }
  if (enabled >= MAX_ENABLED_FAA_MONITORS)
    throw new ConvexError(
      `A Flight Program can monitor at most ${MAX_ENABLED_FAA_MONITORS} aircraft daily. Turn off monitoring on another aircraft first.`,
    );
}

async function scheduleRun(
  ctx: MutationCtx,
  aircraftUuid: string,
  runId: string,
) {
  await ctx.scheduler.runAfter(0, internal.faa.check, { aircraftUuid, runId });
}

async function currentFaaKey(ctx: ActionCtx) {
  const credential = await faaSecret(ctx);
  if (
    credential.expiresOn &&
    credential.expiresOn <= new Date().toISOString().slice(0, 10)
  )
    throw Error(
      "FAA API key has reached its renewal date. Ask an administrator to update it in FAA key settings.",
    );
  if (!credential.key)
    throw Error(
      "FAA DRS is not configured. Set FAA_DRS_API_KEY in the backend environment.",
    );
  return credential.key;
}

// A result that cannot be stored keeps the last successful check, says why.
function saveResults(m: FaaMonitor, run: { payload: string; terms: string[] }) {
  try {
    const merged = mergeCandidates(
      m.candidates,
      z.array(faaCandidateSchema).parse(JSON.parse(run.payload)),
    );
    const bytes = new TextEncoder().encode(JSON.stringify(merged)).byteLength;
    if (bytes > CANDIDATE_HISTORY_MAX_BYTES) {
      m.error =
        "FAA candidate history exceeds storage limit. Narrow monitoring scope; results were not saved.";
      return;
    }
    m.candidates = merged;
    m.lastSuccess = Date.now();
    m.checkedTerms = run.terms;
  } catch (e) {
    m.error = e instanceof Error ? e.message : "Unable to save FAA results.";
  }
}
