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
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { audit } from "./access";
import { chargeFaaAllowance } from "./faaSearch";
import { faaSecret } from "./faaCredentials";
import {
  checkContext,
  managementDocs,
  airworthinessDocs,
} from "./programContext";
import { can } from "../src/domain/model";
import { adSchema } from "../src/domain/airworthiness";
import { recordSchema } from "../src/domain/management";
import {
  emptyMonitor,
  faaCommandSchema,
  faaMonitorSchema,
  mergeCandidates,
  faaCandidateSchema,
} from "../src/domain/faa";
import { z } from "zod";
// Daily checks share the program's FAA allowance with interactive searches.
export const MAX_ENABLED_FAA_MONITORS = 25;
async function assertMonitorCapacity(ctx: MutationCtx, aircraftUuid: string) {
  const aircraft = await ctx.db
    .query("aircraft")
    .withIndex("uuid", (q) => q.eq("uuid", aircraftUuid))
    .unique();
  if (!aircraft) throw Error("Aircraft not found.");
  const fleet = await ctx.db
    .query("aircraft")
    .withIndex("program", (q) => q.eq("programUuid", aircraft.programUuid))
    .collect();
  let enabled = 0;
  for (const a of fleet) {
    const doc = await ctx.db
      .query("faaMonitors")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", a.uuid))
      .unique();
    if (doc && faaMonitorSchema.parse(JSON.parse(doc.payload)).enabled)
      enabled++;
  }
  if (enabled >= MAX_ENABLED_FAA_MONITORS)
    throw Error(
      `A Flight Program can monitor at most ${MAX_ENABLED_FAA_MONITORS} aircraft daily. Turn off monitoring on another aircraft first.`,
    );
}
// Charges a monitoring run to the same FAA allowances as interactive searches.
export const chargeRun = internalMutation({
  args: { aircraftUuid: v.string(), requests: v.number() },
  handler: async (ctx, args) => {
    const aircraft = await ctx.db
      .query("aircraft")
      .withIndex("uuid", (q) => q.eq("uuid", args.aircraftUuid))
      .unique();
    if (!aircraft) throw Error("Aircraft not found.");
    await chargeFaaAllowance(ctx, aircraft.programUuid ?? "", args.requests);
  },
});
export const command = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const state = await checkContext(ctx, args.programUuid);
    const cmd = faaCommandSchema.parse(JSON.parse(args.payload));
    if (!can(state, cmd.aircraftUuid, "maintenance"))
      throw Error("Aircraft maintenance permission required.");
    const doc = await ctx.db
      .query("faaMonitors")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", cmd.aircraftUuid))
      .unique();
    const m = doc
      ? faaMonitorSchema.parse(JSON.parse(doc.payload))
      : emptyMonitor(cmd.aircraftUuid);
    if (cmd.kind === "configure") {
      if (cmd.enabled && !m.enabled)
        await assertMonitorCapacity(ctx, cmd.aircraftUuid);
      m.enabled = cmd.enabled;
      m.terms = cmd.terms;
      m.runId = "";
      m.error = "Settings changed. Run a check to verify coverage.";
    }
    if (cmd.kind === "review") {
      const c = m.candidates.find((c) => c.id === cmd.id);
      if (!c) throw Error("Candidate not found.");
      c.reviewReason = cmd.reason;
      c.reviewedAt = Date.now();
    }
    if (cmd.kind === "check") {
      if (m.lastAttempt && Date.now() - m.lastAttempt < 60000)
        throw Error("Wait one minute before checking again.");
      m.runId = crypto.randomUUID();
      m.lastAttempt = Date.now();
      m.error = "";
      await ctx.scheduler.runAfter(0, internal.faa.check, {
        aircraftUuid: cmd.aircraftUuid,
        runId: m.runId,
      });
    }
    const record = {
      aircraftUuid: cmd.aircraftUuid,
      payload: JSON.stringify(m),
    };
    if (doc) await ctx.db.replace(doc._id, record);
    else await ctx.db.insert("faaMonitors", record);
    await audit(
      ctx,
      state.user.id as import("./_generated/dataModel").Id<"users">,
      "faa." + cmd.kind,
      cmd.aircraftUuid,
      { aircraftUuid: cmd.aircraftUuid, after: cmd },
    );
  },
});
export const input = internalQuery({
  args: { aircraftUuid: v.string(), runId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("faaMonitors")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", args.aircraftUuid))
      .unique();
    if (!doc) return null;
    const m = faaMonitorSchema.parse(JSON.parse(doc.payload));
    if (m.runId !== args.runId) return null;
    const a = await ctx.db
      .query("aircraft")
      .withIndex("uuid", (q) => q.eq("uuid", args.aircraftUuid))
      .unique();
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
export const finish = internalMutation({
  args: {
    aircraftUuid: v.string(),
    runId: v.string(),
    payload: v.string(),
    error: v.string(),
    terms: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("faaMonitors")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", args.aircraftUuid))
      .unique();
    if (!doc) return;
    const m = faaMonitorSchema.parse(JSON.parse(doc.payload));
    if (m.runId !== args.runId) return;
    m.runId = "";
    m.error = args.error;
    if (!args.error) {
      try {
        const merged = mergeCandidates(
          m.candidates,
          z.array(faaCandidateSchema).parse(JSON.parse(args.payload)),
        );
        if (
          new TextEncoder().encode(JSON.stringify(merged)).byteLength > 700000
        )
          throw Error(
            "FAA candidate history exceeds storage limit. Narrow monitoring scope; results were not saved.",
          );
        m.candidates = merged;
        m.lastSuccess = Date.now();
        m.checkedTerms = args.terms;
      } catch (e) {
        m.error =
          e instanceof Error ? e.message : "Unable to save FAA results.";
      }
    }
    await ctx.db.patch(doc._id, { payload: JSON.stringify(m) });
  },
});
export const check = internalAction({
  args: { aircraftUuid: v.string(), runId: v.string() },
  handler: async (ctx, args) => {
    let terms: string[] = [];
    let payload = "[]",
      error = "";
    try {
      const input = await ctx.runQuery(internal.faa.input, args);
      if (!input) return;
      terms = input.terms;
      const credential = await faaSecret(ctx);
      const key = credential.key;
      if (
        credential.expiresOn &&
        credential.expiresOn <= new Date().toISOString().slice(0, 10)
      )
        throw Error(
          "FAA API key has reached its renewal date. Ask an administrator to update it in FAA key settings.",
        );
      if (!key)
        throw Error(
          "FAA DRS is not configured. Set FAA_DRS_API_KEY in the backend environment.",
        );
      await ctx.runMutation(internal.faa.chargeRun, {
        aircraftUuid: args.aircraftUuid,
        requests: input.queries.length,
      });
      payload = JSON.stringify(
        await fetchMonitoringCandidates(key, input.queries),
      );
    } catch (e) {
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
export const daily = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const doc of await ctx.db.query("faaMonitors").collect()) {
      const m = faaMonitorSchema.parse(JSON.parse(doc.payload));
      if (!m.enabled || (m.lastAttempt && Date.now() - m.lastAttempt < 3600000))
        continue;
      m.runId = crypto.randomUUID();
      m.lastAttempt = Date.now();
      m.error = "";
      await ctx.db.patch(doc._id, { payload: JSON.stringify(m) });
      await ctx.scheduler.runAfter(0, internal.faa.check, {
        aircraftUuid: m.aircraftUuid,
        runId: m.runId,
      });
    }
  },
});
