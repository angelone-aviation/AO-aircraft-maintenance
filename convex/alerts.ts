/**
 * Responsibility: Each member's maintenance alerts: which they have read,
 *   their email choice, and the daily digest and off-site backup warning.
 * Layer: Server. Public functions for the signed-in member; the digest runs
 *   from the daily cron and sends through Resend. The alert rules are the
 *   domain's.
 * Dependencies: convex (access, memberships, programContext), src/domain
 *   (alerts, alertDigest, offsiteBackups, airworthiness, faa, management,
 *   programs, model).
 */
import {
  query,
  mutation,
  internalQuery,
  internalMutation,
  internalAction,
  type ActionCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { ConvexError, v } from "convex/values";
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
import { backupWarningEmail, digestEmail } from "../src/domain/alertDigest";
import { offsiteFreshness } from "../src/domain/offsiteBackups";
import { adSchema } from "../src/domain/airworthiness";
import { faaMonitorSchema } from "../src/domain/faa";
import { recordSchema } from "../src/domain/management";
import { activeProgram, scopedSnapshot } from "../src/domain/programs";
import { localDate, type Group, type Snapshot } from "../src/domain/model";

const MAX_KEYS = 500;
const MAX_KEY_LENGTH = 300;
const EMAIL_TIMEOUT_MS = 15000;
const RESEND_URL = "https://api.resend.com/emails";

type AlertSources = Omit<Snapshot, "user">;
type DigestRecipient = NonNullable<Awaited<ReturnType<typeof pendingDigest>>>;
type Mailer = ReturnType<typeof createMailer>;
interface Email {
  subject: string;
  html: string;
  text: string;
}

/**
 * The caller's read alert keys in a Flight Program.
 *
 * @param programUuid - The caller's active Flight Program.
 * @returns The keys, in no particular order.
 * @throws As `checkContext`.
 */
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

/**
 * Marks alerts read for the caller in a Flight Program. With `all`, the keys
 * replace the read set: keys no longer listed are forgotten, which keeps the
 * table bounded to each user's live alerts.
 *
 * @param keys - Alert keys; duplicates count once.
 * @param all - Whether `keys` are every current alert.
 * @throws {ConvexError} As `checkContext`; "Too many or invalid alerts to
 *   update. Reload and retry." for more than 500 keys, or an empty key or one
 *   over 300 characters.
 */
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
    const forgotten = all ? rows.filter((r) => !wanted.includes(r.key)) : [];
    for (const row of forgotten) await ctx.db.delete(row._id);
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

/**
 * Turns the caller's alert emails on or off.
 *
 * @throws As `currentUser`.
 */
export const setEmailPreference = mutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, { enabled }) => {
    const user = await currentUser(ctx);
    await ctx.db.patch(user._id, { emailAlerts: enabled });
  },
});

/** Every Flight Program the digest covers, by uuid and name. */
export const digestPrograms = internalQuery({
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query("programs").collect()).map((p) => ({
      uuid: p.uuid,
      name: p.name,
    })),
});

/**
 * Opted-in active members of one program with alerts not yet emailed to
 * them, each seeing only what their groups allow.
 *
 * @param today - The local date the alerts are computed for.
 * @returns Per member: the pending alerts, and every current alert key.
 */
export const digestRecipients = internalQuery({
  args: { programUuid: v.string(), today: v.string() },
  handler: async (ctx, { programUuid, today }) => {
    const groups = (
      await ctx.db
        .query("groups")
        .withIndex("program", (q) => q.eq("programUuid", programUuid))
        .collect()
    ).map(group);
    const users = await emailMembers(ctx, programUuid, groups);
    if (!users.length) return [];
    const sources = await loadAlertSources(ctx, programUuid, groups);
    const recipients: DigestRecipient[] = [];
    for (const u of users) {
      const recipient = await pendingDigest(
        ctx,
        sources,
        u,
        programUuid,
        today,
      );
      if (recipient) recipients.push(recipient);
    }
    return recipients;
  },
});

/**
 * The newest off-site copy (ADR-0008) and who is warned when it is stale:
 * active system administrators whose alert email is on, by the rule and
 * default the switch in Settings and My certifications shows them. Nobody
 * else ever gets the warning.
 *
 * @returns When the newest copy completed (null for none), and the admins.
 */
export const digestBackupWarning = internalQuery({
  args: {},
  handler: async (ctx) => {
    const latest = await ctx.db
      .query("backupRuns")
      .withIndex("completedAt")
      .order("desc")
      .first();
    const programs = await ctx.db.query("programs").collect();
    const groups = (await ctx.db.query("groups").collect()).map(group);
    const admins = (await ctx.db.query("users").collect())
      .filter((u) => u.active && u.isAdmin && u.email)
      .filter((u) => {
        const user = member(u);
        return wantsAlertEmails(
          user,
          groups,
          activeProgram({ user, groups, programs }),
        );
      });
    return {
      latest: latest && { completedAt: latest.completedAt },
      admins: admins.map((u) => ({ userId: u._id, email: u.email! })),
    };
  },
});

/**
 * Records which alerts were emailed and forgets deliveries for alerts that
 * cleared, so a cleared alert that returns is emailed again.
 *
 * @param keys - The alerts the email showed.
 * @param active - Every current alert key for the member.
 */
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

/**
 * Emails each opted-in member their program's new alerts, and warns system
 * administrators of a stale off-site backup: at the top of a digest they get
 * anyway, or alone. A failed email is counted and logged by user id.
 *
 * @returns How many emails were sent and failed; `skipped` when
 *   RESEND_API_KEY or RESEND_FROM is not set.
 */
export const sendDigests = internalAction({
  args: {},
  handler: async (ctx) => {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM;
    // In-app alerts work without email; skip quietly until both are set.
    if (!apiKey || !from) return { sent: 0, failed: 0, skipped: true };
    const today = localDate();
    const mail = createMailer(apiKey, from);
    const backup = await ctx.runQuery(internal.alerts.digestBackupWarning, {});
    const freshness = offsiteFreshness(backup.latest, Date.now());
    const backupWarning =
      freshness.status === "ok" ? undefined : freshness.message;
    const admins = new Set<string>(backup.admins.map((a) => a.userId));
    const warningFor = (userId: string) =>
      admins.has(userId) ? backupWarning : undefined;
    const programs = await ctx.runQuery(internal.alerts.digestPrograms, {});
    const warned: string[] = [];
    for (const program of programs)
      warned.push(
        ...(await sendProgramDigests(ctx, mail, program, today, warningFor)),
      );
    if (backupWarning)
      await sendBackupWarnings(
        mail,
        backup.admins.filter((a) => !warned.includes(a.userId)),
        backupWarning,
      );
    return {
      sent: mail.counts.sent,
      failed: mail.counts.failed,
      skipped: false,
    };
  },
});

function validKeys(keys: string[]) {
  if (
    keys.length > MAX_KEYS ||
    keys.some((k) => !k || k.length > MAX_KEY_LENGTH)
  )
    throw new ConvexError(
      "Too many or invalid alerts to update. Reload and retry.",
    );
  return [...new Set(keys)];
}

function readRows(
  ctx: QueryCtx,
  userId: Id<"users">,
  programUuid: string,
  table: "alertReads" | "alertDeliveries",
) {
  return ctx.db
    .query(table)
    .withIndex("user_program", (q) =>
      q.eq("userId", userId).eq("programUuid", programUuid),
    )
    .collect();
}

// Members via the memberships index; groupIds stays authoritative.
async function emailMembers(
  ctx: QueryCtx,
  programUuid: string,
  groups: Group[],
) {
  const groupIds = new Set(groups.map((g) => g.id));
  return (await programUsers(ctx, programUuid)).filter(
    (u) =>
      u.active &&
      u.email &&
      (u.groupIds ?? []).some((id) => groupIds.has(id)) &&
      wantsAlertEmails(member(u), groups, programUuid),
  );
}

async function loadAlertSources(
  ctx: QueryCtx,
  programUuid: string,
  groups: Group[],
): Promise<AlertSources> {
  const programs = await ctx.db.query("programs").collect();
  const aircraft = await ctx.db
    .query("aircraft")
    .withIndex("program", (q) => q.eq("programUuid", programUuid))
    .collect();
  const management = await managementDocs(ctx, programUuid);
  return {
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
}

async function pendingDigest(
  ctx: QueryCtx,
  sources: AlertSources,
  u: Doc<"users">,
  programUuid: string,
  today: string,
) {
  const state = scopedSnapshot({
    ...sources,
    user: { ...member(u), activeProgramUuid: programUuid },
  });
  if (activeProgram(state) !== programUuid) return undefined;
  const alerts = computeAlerts(state, today);
  const sent = new Set(
    (await readRows(ctx, u._id, programUuid, "alertDeliveries")).map(
      (r) => r.key,
    ),
  );
  const pending = alerts.filter((a) => !sent.has(a.key));
  if (!pending.length) return undefined;
  return {
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
  };
}

// Returns the members whose digest carried the backup warning.
async function sendProgramDigests(
  ctx: ActionCtx,
  mail: Mailer,
  program: { uuid: string; name: string },
  today: string,
  warningFor: (userId: string) => string | undefined,
) {
  const recipients = await ctx.runQuery(internal.alerts.digestRecipients, {
    programUuid: program.uuid,
    today,
  });
  const warned: string[] = [];
  for (const r of recipients) {
    const backupWarning = warningFor(r.userId);
    const email = digestEmail(r.alerts, {
      programName: program.name,
      siteUrl: mail.siteUrl,
      backupWarning,
    });
    if (!(await mail.send(r.email, email, "Alert digest not sent", r.userId)))
      continue;
    if (backupWarning) warned.push(r.userId);
    await ctx.runMutation(internal.alerts.recordDeliveries, {
      userId: r.userId,
      programUuid: program.uuid,
      keys: email.shown.map((a) => a.key),
      active: r.active,
    });
  }
  return warned;
}

async function sendBackupWarnings(
  mail: Mailer,
  admins: { userId: string; email: string }[],
  warning: string,
) {
  const email = backupWarningEmail(warning, { siteUrl: mail.siteUrl });
  for (const a of admins)
    await mail.send(
      a.email,
      email,
      "Off-site backup warning not sent",
      a.userId,
    );
}

function createMailer(apiKey: string, from: string) {
  const counts = { sent: 0, failed: 0 };
  const send = async (
    to: string,
    email: Email,
    failure: string,
    userId: string,
  ) => {
    try {
      await sendEmail(apiKey, from, to, email);
      counts.sent++;
      return true;
    } catch (error) {
      // One failed email must not stop the rest; the log names the user id,
      // never the address or the content.
      counts.failed++;
      console.error(
        failure,
        userId,
        error instanceof Error ? error.message : "unknown error",
      );
      return false;
    }
  };
  return { counts, send, siteUrl: process.env.SITE_URL };
}

async function sendEmail(
  apiKey: string,
  from: string,
  to: string,
  email: Email,
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
