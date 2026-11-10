/**
 * Responsibility: Urgent alerts (GLOSSARY "Urgent alert") reaching people at
 *   once: who gets them by email or on a device, the daily email cap, and
 *   the claim that stops the same alert going out twice.
 * Layer: Server. Internal functions scheduled after the mutations that can
 *   create an urgent state, plus the member's email choice; the alert rules
 *   and the messages are the domain's.
 * Dependencies: convex/values, ./_generated, ./access, ./alerts, ./mailer,
 *   ./rateLimits, src/domain (alerts, alertDigest).
 *
 * Resend's free tier sends 100 emails a day. Immediate emails stop at
 * IMMEDIATE_EMAILS_PER_DAY so the digest always fits; a capped alert waits
 * for the digest (docs/runbooks/monitoring.md).
 */
import { ConvexError, v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { currentUser, member } from "./access";
import {
  alertAudience,
  deliveredKeys,
  deliveryRows,
  emailChoice,
  memberAlerts,
  sendableSources,
  SYSTEM_SCOPE,
  SYSTEM_SCOPE_NAME,
  type AlertSources,
} from "./alerts";
import { createMailer, mailerSettings } from "./mailer";
import { consume, DAY, HOUR, MINUTE, refund } from "./rateLimits";
import {
  IMMEDIATE_EMAILS_PER_DAY,
  urgentAlerts,
  wantsUrgentAlertEmails,
  type Alert,
} from "../src/domain/alerts";
import { urgentEmail, urgentPushPayload } from "../src/domain/alertDigest";

export { IMMEDIATE_EMAILS_PER_DAY };

/** The rate-limit key the cap counts under. */
export const IMMEDIATE_CAP_KEY = "alerts:immediate";

const CAPPED = "Daily limit of immediate alert emails reached.";
const MAX_CLAIM_KEYS = 500;

/**
 * How long a check waits before retrying sends a provider refused, by
 * attempt. One transient error must not hold an urgent alert until the next
 * change or the next day's check; three retries bound the requests made to
 * a provider that keeps failing.
 */
export const RETRY_DELAYS_MS: readonly number[] = [
  5 * MINUTE,
  15 * MINUTE,
  HOUR,
];

/** What one urgent-alert check did. */
export interface SendImmediateResult {
  sent: number;
  failed: number;
  capped: number;
  pushed: number;
  skipped: boolean;
}

type UrgentAlert = Pick<
  Alert,
  "key" | "title" | "detail" | "severity" | "link"
>;
type Recipient = NonNullable<Awaited<ReturnType<typeof urgentRecipient>>>;

/**
 * Turns the caller's immediate urgent-alert emails on or off.
 *
 * @throws As `currentUser`.
 */
export const setUrgentEmailPreference = mutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, { enabled }) => {
    const user = await currentUser(ctx);
    await ctx.db.patch(user._id, { urgentAlertEmails: enabled });
  },
});

/**
 * Schedules the urgent-alert check for a Flight Program, from a mutation
 * that may have created an urgent state. Nothing is scheduled for a call
 * outside a program.
 *
 * @param programUuid - The mutation's Flight Program.
 */
export async function scheduleUrgentAlerts(
  ctx: MutationCtx,
  programUuid: string | undefined,
): Promise<void> {
  if (!programUuid) return;
  await ctx.scheduler.runAfter(0, internal.urgentAlerts.sendImmediate, {
    programUuid,
  });
}

/**
 * Schedules the check of the deployment's own dates (`SYSTEM_SCOPE`), from a
 * mutation that changed one.
 */
export async function scheduleSystemAlerts(ctx: MutationCtx): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.urgentAlerts.sendImmediate, {
    programUuid: SYSTEM_SCOPE,
  });
}

/**
 * The scope's name and the active members with urgent alerts not yet sent
 * to them, each seeing only what their groups allow.
 *
 * @param programUuid - A Flight Program, or `SYSTEM_SCOPE` for the
 *   deployment's own dates.
 * @param today - The local date the alerts are computed for.
 * @returns Per member: the alerts to email (none without an address or the
 *   email choice, and none already emailed on any channel) and the alerts to
 *   push (none without a subscribed device).
 */
export const urgentRecipients = internalQuery({
  args: { programUuid: v.string(), today: v.string() },
  handler: async (ctx, { programUuid, today }) => {
    const programName = await scopeName(ctx, programUuid);
    if (programName === undefined) return { programName: "", recipients: [] };
    const { groups, users } = await alertAudience(ctx, programUuid);
    if (!users.length) return { programName, recipients: [] };
    const sources = await sendableSources(ctx, programUuid, groups);
    const recipients: Recipient[] = [];
    for (const u of users) {
      const r = await urgentRecipient(ctx, sources, u, today);
      if (r) recipients.push(r);
    }
    return { programName, recipients };
  },
});

/**
 * Claims alerts for one channel before they are sent, so two checks running
 * at once cannot both send them. An immediate email claim also spends one of
 * the day's {@link IMMEDIATE_EMAILS_PER_DAY}. A claim lasts until
 * `alerts.forgetCleared` finds its alert gone; nothing is forgotten here,
 * because the caller may have computed its alerts from older records.
 *
 * @param keys - The alerts about to be sent.
 * @returns The keys newly claimed (none when every key was already sent on
 *   the channel), and `capped` when the day's emails are spent, in which
 *   case nothing is claimed.
 */
export const claimDeliveries = internalMutation({
  args: {
    userId: v.id("users"),
    programUuid: v.string(),
    channel: v.union(v.literal("immediate"), v.literal("push")),
    keys: v.array(v.string()),
  },
  handler: async (ctx, { userId, programUuid, channel, keys }) => {
    const rows = await deliveryRows(ctx, userId, programUuid, channel);
    const sent = new Set(rows.map((r) => r.key));
    const claimed = [...new Set(keys.slice(0, MAX_CLAIM_KEYS))].filter(
      (key) => !sent.has(key),
    );
    if (!claimed.length) return { claimed, capped: false };
    if (channel === "immediate" && !(await reserveImmediateEmail(ctx)))
      return { claimed: [], capped: true };
    const sentAt = Date.now();
    for (const key of claimed)
      await ctx.db.insert("alertDeliveries", {
        userId,
        programUuid,
        key,
        sentAt,
        channel,
      });
    return { claimed, capped: false };
  },
});

/**
 * Releases a claim whose send failed, so the alerts go out on a later check.
 * A refused immediate email also gives back its share of the day's
 * {@link IMMEDIATE_EMAILS_PER_DAY}, which counts only emails sent.
 *
 * @param keys - The claimed keys to forget.
 */
export const releaseDeliveries = internalMutation({
  args: {
    userId: v.id("users"),
    programUuid: v.string(),
    channel: v.union(v.literal("immediate"), v.literal("push")),
    keys: v.array(v.string()),
  },
  handler: async (ctx, { userId, programUuid, channel, keys }) => {
    const rows = await deliveryRows(ctx, userId, programUuid, channel);
    for (const row of rows)
      if (keys.includes(row.key)) await ctx.db.delete(row._id);
    if (channel === "immediate") await refund(ctx, IMMEDIATE_CAP_KEY, DAY);
  },
});

/**
 * Emails each opted-in member the program's new urgent alerts, and hands the
 * ones for subscribed devices to the push sender. Runs after a mutation that
 * may have created an urgent state, and after the daily digest. It first
 * ends the occurrence of every alert that has cleared
 * (`alerts.forgetCleared`), so an alert that returns is sent again. A failed
 * email is counted, logged by user id, and its claim released, and the
 * check runs again after the next of {@link RETRY_DELAYS_MS}.
 *
 * @param attempt - How many retries came before this check; 0 by default.
 * @returns How many emails were sent, failed and held back by the daily cap,
 *   how many members get a push message, and `skipped` when neither Resend
 *   (RESEND_API_KEY, RESEND_FROM) nor Web Push (the VAPID variables) is set.
 */
export const sendImmediate = internalAction({
  args: { programUuid: v.string(), attempt: v.optional(v.number()) },
  handler: async (
    ctx,
    { programUuid, attempt = 0 },
  ): Promise<SendImmediateResult> => {
    const settings = mailerSettings();
    const pushReady = hasVapidKeys();
    const counts = { sent: 0, failed: 0, capped: 0, pushed: 0 };
    if (!settings && !pushReady) return { ...counts, skipped: true };
    const { today } = await ctx.runMutation(internal.alerts.forgetCleared, {
      programUuid,
    });
    const { programName, recipients } = await ctx.runQuery(
      internal.urgentAlerts.urgentRecipients,
      { programUuid, today },
    );
    const mail = settings && createMailer(settings);
    const pushes: PushJob[] = [];
    for (const r of recipients) {
      if (mail && r.email && r.emailAlerts.length)
        await emailRecipient(ctx, mail, programUuid, programName, r, counts);
      if (pushReady && r.pushAlerts.length)
        pushes.push(pushJobOf(r, programUuid, programName));
    }
    if (pushes.length)
      await ctx.scheduler.runAfter(0, internal.push.sendUrgent, {
        notifications: pushes,
        attempt,
      });
    if (counts.failed && attempt < RETRY_DELAYS_MS.length)
      await ctx.scheduler.runAfter(
        RETRY_DELAYS_MS[attempt],
        internal.urgentAlerts.sendImmediate,
        { programUuid, attempt: attempt + 1 },
      );
    return { ...counts, pushed: pushes.length, skipped: false };
  },
});

/**
 * The daily check from the cron: an urgent alert that arose by the calendar
 * alone (a date or deadline passed overnight) reaches people who get no
 * digest. Each program's check, and the deployment's own dates' check, is
 * scheduled on its own.
 *
 * @returns How many checks were scheduled.
 */
export const daily = internalAction({
  args: {},
  handler: async (ctx): Promise<{ scheduled: number }> => {
    const programs = await ctx.runQuery(internal.alerts.digestPrograms, {});
    for (const program of programs)
      await ctx.scheduler.runAfter(0, internal.urgentAlerts.sendImmediate, {
        programUuid: program.uuid,
      });
    return { scheduled: programs.length };
  },
});

/** One member's push message to build and send (convex/push.ts). */
export interface PushJob {
  userId: Id<"users">;
  programUuid: string;
  alerts: Pick<Alert, "key" | "title">[];
  programName: string;
}

/** The push job validator, for the push sender's arguments. */
export const pushJobValidator = v.object({
  userId: v.id("users"),
  programUuid: v.string(),
  alerts: v.array(v.object({ key: v.string(), title: v.string() })),
  programName: v.string(),
});

/**
 * The push message for the alerts a device claim allowed.
 *
 * @returns As `urgentPushPayload`, for the claimed alerts only.
 */
export function pushPayloadFor(job: PushJob, claimed: string[]) {
  return urgentPushPayload(
    job.alerts.filter((a) => claimed.includes(a.key)),
    job.programName,
    job.programUuid,
  );
}

// Dormant until every VAPID variable is set (docs/runbooks/monitoring.md).
function hasVapidKeys() {
  return !!(
    process.env.VAPID_PUBLIC_KEY &&
    process.env.VAPID_PRIVATE_KEY &&
    process.env.VAPID_SUBJECT
  );
}

// Spends one email of the day; false, not a throw, once they are spent.
async function reserveImmediateEmail(ctx: MutationCtx) {
  try {
    await consume(
      ctx,
      IMMEDIATE_CAP_KEY,
      IMMEDIATE_EMAILS_PER_DAY,
      DAY,
      CAPPED,
    );
    return true;
  } catch (error) {
    // The cap is an expected outcome, not a fault: the alert waits for the
    // digest.
    if (error instanceof ConvexError) return false;
    throw error;
  }
}

async function scopeName(ctx: QueryCtx, scope: string) {
  if (scope === SYSTEM_SCOPE) return SYSTEM_SCOPE_NAME;
  const program = await ctx.db
    .query("programs")
    .withIndex("uuid", (q) => q.eq("uuid", scope))
    .unique();
  return program?.name;
}

async function urgentRecipient(
  ctx: QueryCtx,
  sources: AlertSources,
  u: Doc<"users">,
  today: string,
) {
  const alerts = memberAlerts(sources, u, today);
  if (!alerts) return undefined;
  const urgent = urgentAlerts(alerts);
  if (!urgent.length) return undefined;
  const rows = await deliveryRows(ctx, u._id, sources.programUuid);
  const emailed = new Set([
    ...deliveredKeys(rows, "digest"),
    ...deliveredKeys(rows, "immediate"),
  ]);
  const pushed = new Set(deliveredKeys(rows, "push"));
  const wantsEmail =
    !!u.email &&
    wantsUrgentAlertEmails(
      member(u),
      sources.groups,
      emailChoice(sources.programUuid, u, sources),
    );
  const subscribed = await hasDevice(ctx, u._id);
  const emailAlerts = wantsEmail
    ? urgent.filter((a) => !emailed.has(a.key))
    : [];
  const pushAlerts = subscribed ? urgent.filter((a) => !pushed.has(a.key)) : [];
  if (!emailAlerts.length && !pushAlerts.length) return undefined;
  return {
    userId: u._id,
    email: u.email ?? "",
    emailAlerts: emailAlerts.map(trimAlert),
    pushAlerts: pushAlerts.map(trimAlert),
  };
}

async function hasDevice(ctx: QueryCtx, userId: Id<"users">) {
  const first = await ctx.db
    .query("pushSubscriptions")
    .withIndex("user", (q) => q.eq("userId", userId))
    .first();
  return first !== null;
}

function pushJobOf(
  r: Recipient,
  programUuid: string,
  programName: string,
): PushJob {
  const alerts = r.pushAlerts.map(({ key, title }) => ({ key, title }));
  return { userId: r.userId, programUuid, alerts, programName };
}

function trimAlert({ key, title, detail, severity, link }: Alert): UrgentAlert {
  return { key, title, detail, severity, link };
}

// Claim, send, and release the claim when the provider refuses.
async function emailRecipient(
  ctx: Pick<ActionCtx, "runMutation">,
  mail: ReturnType<typeof createMailer>,
  programUuid: string,
  programName: string,
  r: Recipient,
  counts: { sent: number; failed: number; capped: number },
) {
  const claim = await ctx.runMutation(internal.urgentAlerts.claimDeliveries, {
    userId: r.userId,
    programUuid,
    channel: "immediate",
    keys: r.emailAlerts.map((a) => a.key),
  });
  if (claim.capped) {
    counts.capped++;
    return;
  }
  if (!claim.claimed.length) return;
  const alerts = r.emailAlerts.filter((a) => claim.claimed.includes(a.key));
  const email = urgentEmail(alerts, { programName, siteUrl: mail.siteUrl });
  const ok = await mail.send(
    r.email,
    email,
    "Urgent alert email not sent",
    r.userId,
  );
  if (ok) {
    counts.sent++;
    return;
  }
  counts.failed++;
  await ctx.runMutation(internal.urgentAlerts.releaseDeliveries, {
    userId: r.userId,
    programUuid,
    channel: "immediate",
    keys: claim.claimed,
  });
}
