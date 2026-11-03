import {
  query,
  mutation,
  internalQuery,
  internalMutation,
  internalAction,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { currentUser, group, member } from "./access";
import { programUsers } from "./memberships";
import {
  checkContext,
  managementDocs,
  inspectionDocs,
  airworthinessDocs,
  faaMonitorDocs,
} from "./programContext";
import { computeAlerts, wantsAlertEmails } from "../src/domain/alerts";
import { digestEmail } from "../src/domain/alertDigest";
import { adSchema } from "../src/domain/airworthiness";
import { faaMonitorSchema } from "../src/domain/faa";
import { recordSchema } from "../src/domain/management";
import { activeProgram, scopedSnapshot } from "../src/domain/programs";
import { localDate, type Snapshot } from "../src/domain/model";

const MAX_KEYS = 500;
const MAX_KEY_LENGTH = 300;
const EMAIL_TIMEOUT_MS = 15000;
const RESEND_URL = "https://api.resend.com/emails";

function validKeys(keys: string[]) {
  if (
    keys.length > MAX_KEYS ||
    keys.some((k) => !k || k.length > MAX_KEY_LENGTH)
  )
    throw new Error("Too many or invalid alerts to update. Reload and retry.");
  return [...new Set(keys)];
}
const readRows = (
  ctx: QueryCtx,
  userId: Id<"users">,
  programUuid: string,
  table: "alertReads" | "alertDeliveries",
) =>
  ctx.db
    .query(table)
    .withIndex("user_program", (q) =>
      q.eq("userId", userId).eq("programUuid", programUuid),
    )
    .collect();

export const readKeys = query({
  args: { programUuid: v.optional(v.string()) },
  handler: async (ctx, { programUuid }) => {
    const state = await checkContext(ctx, programUuid);
    const rows = await readRows(
      ctx,
      state.user.id as Id<"users">,
      programUuid ?? "",
      "alertReads",
    );
    return rows.map((r) => r.key);
  },
});

// `all` marks every current alert read and forgets keys no longer listed,
// which keeps the table bounded to each user's live alerts.
export const markRead = mutation({
  args: {
    programUuid: v.optional(v.string()),
    keys: v.array(v.string()),
    all: v.optional(v.boolean()),
  },
  handler: async (ctx, { programUuid, keys, all }) => {
    const state = await checkContext(ctx, programUuid);
    const wanted = validKeys(keys);
    const userId = state.user.id as Id<"users">;
    const program = programUuid ?? "";
    const rows = await readRows(ctx, userId, program, "alertReads");
    const known = new Set(rows.map((r) => r.key));
    if (all)
      for (const row of rows)
        if (!wanted.includes(row.key)) await ctx.db.delete(row._id);
    const readAt = Date.now();
    for (const key of wanted)
      if (!known.has(key))
        await ctx.db.insert("alertReads", {
          userId,
          programUuid: program,
          key,
          readAt,
        });
  },
});

export const setEmailPreference = mutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, { enabled }) => {
    const user = await currentUser(ctx);
    await ctx.db.patch(user._id, { emailAlerts: enabled });
  },
});

export const digestPrograms = internalQuery({
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query("programs").collect()).map((p) => ({
      uuid: p.uuid,
      name: p.name,
    })),
});

// Opted-in active members of one program with alerts not yet emailed to them.
export const digestRecipients = internalQuery({
  args: { programUuid: v.string(), today: v.string() },
  handler: async (ctx, { programUuid, today }) => {
    const programs = await ctx.db.query("programs").collect();
    const groups = (
      await ctx.db
        .query("groups")
        .withIndex("program", (q) => q.eq("programUuid", programUuid))
        .collect()
    ).map(group);
    const groupIds = new Set(groups.map((g) => g.id));
    // Members via the memberships index; groupIds stays authoritative.
    const users = (await programUsers(ctx, programUuid)).filter(
      (u) =>
        u.active &&
        u.email &&
        (u.groupIds ?? []).some((id) => groupIds.has(id)) &&
        wantsAlertEmails(member(u), groups, programUuid),
    );
    if (!users.length) return [];
    const aircraft = await ctx.db
      .query("aircraft")
      .withIndex("program", (q) => q.eq("programUuid", programUuid))
      .collect();
    const management = await managementDocs(ctx, programUuid);
    const base: Omit<Snapshot, "user"> = {
      programs,
      groups,
      aircraft,
      management: management.map((d) =>
        recordSchema.parse(JSON.parse(d.payload)),
      ),
      inspections: await inspectionDocs(ctx, aircraft, management),
      airworthiness: (await airworthinessDocs(ctx, aircraft)).map((d) =>
        adSchema.parse(JSON.parse(d.payload)),
      ),
      faaMonitors: (await faaMonitorDocs(ctx, aircraft)).map((d) =>
        faaMonitorSchema.parse(JSON.parse(d.payload)),
      ),
      members: [],
      flights: [],
      discrepancies: [],
      audit: [],
      syncedAt: 0,
      authenticatedAt: 0,
    };
    const recipients = [];
    for (const u of users) {
      const state = scopedSnapshot({
        ...base,
        user: { ...member(u), activeProgramUuid: programUuid },
      });
      if (activeProgram(state) !== programUuid) continue;
      const alerts = computeAlerts(state, today);
      const sent = new Set(
        (await readRows(ctx, u._id, programUuid, "alertDeliveries")).map(
          (r) => r.key,
        ),
      );
      const pending = alerts.filter((a) => !sent.has(a.key));
      if (!pending.length) continue;
      recipients.push({
        userId: u._id,
        email: u.email!,
        alerts: pending.map(({ key, title, detail, severity, link }) => ({
          key,
          title,
          detail,
          severity,
          link,
        })),
        active: alerts.map((a) => a.key),
      });
    }
    return recipients;
  },
});

// Records what was emailed and forgets deliveries for alerts that cleared.
export const recordDeliveries = internalMutation({
  args: {
    userId: v.id("users"),
    programUuid: v.string(),
    keys: v.array(v.string()),
    active: v.array(v.string()),
  },
  handler: async (ctx, { userId, programUuid, keys, active }) => {
    const rows = await readRows(ctx, userId, programUuid, "alertDeliveries");
    const live = new Set(active);
    const known = new Set(rows.map((r) => r.key));
    for (const row of rows)
      if (!live.has(row.key)) await ctx.db.delete(row._id);
    const sentAt = Date.now();
    for (const key of new Set(keys))
      if (!known.has(key))
        await ctx.db.insert("alertDeliveries", {
          userId,
          programUuid,
          key,
          sentAt,
        });
  },
});

async function sendEmail(
  apiKey: string,
  from: string,
  to: string,
  email: { subject: string; html: string; text: string },
) {
  const response = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: email.subject,
      html: email.html,
      text: email.text,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(
      `Email provider rejected the request (${response.status}).`,
    );
}

export const sendDigests = internalAction({
  args: {},
  handler: async (ctx) => {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM;
    // In-app alerts work without email; skip quietly until both are set.
    if (!apiKey || !from) return { sent: 0, failed: 0, skipped: true };
    const today = localDate();
    let sent = 0;
    let failed = 0;
    for (const program of await ctx.runQuery(
      internal.alerts.digestPrograms,
      {},
    )) {
      const recipients = await ctx.runQuery(internal.alerts.digestRecipients, {
        programUuid: program.uuid,
        today,
      });
      for (const r of recipients) {
        const email = digestEmail(r.alerts, {
          programName: program.name,
          siteUrl: process.env.SITE_URL,
        });
        try {
          await sendEmail(apiKey, from, r.email, email);
        } catch (error) {
          failed++;
          console.error(
            "Alert digest not sent",
            r.userId,
            error instanceof Error ? error.message : "unknown error",
          );
          continue;
        }
        await ctx.runMutation(internal.alerts.recordDeliveries, {
          userId: r.userId,
          programUuid: program.uuid,
          keys: email.shown.map((a) => a.key),
          active: r.active,
        });
        sent++;
      }
    }
    return { sent, failed, skipped: false };
  },
});
