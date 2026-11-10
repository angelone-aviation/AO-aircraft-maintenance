/**
 * Responsibility: Each member's maintenance alerts: which they have read,
 *   their email choice, the daily digest and off-site backup warning, and
 *   the alert sources and delivery rows the urgent sender shares, with the
 *   step that ends an alert's occurrence once it has cleared.
 * Layer: Server. Public functions for the signed-in member; the digest runs
 *   from the daily cron and sends through the mailer. The alert rules are
 *   the domain's.
 * Dependencies: convex (access, faaCredentials, mailer, memberships,
 *   programContext, recordsDate), src/domain (alerts, alertDigest,
 *   offsiteBackups, aircraftStatus, airworthiness, expiringItems, faa,
 *   management, programs, model).
 *
 * Deployment-wide dates are checked once, in SYSTEM_SCOPE, for system
 * administrators whatever their groups; a program's checks leave them out.
 *
 * Deliveries and read marks are kept by alert key, and a key does not change
 * when a state ends and starts again (an aircraft grounded a second time).
 * So every check first runs forgetCleared, which drops the rows of alerts a
 * member no longer has: de-duplication is per occurrence, not per key.
 */
import {
  query,
  mutation,
  internalQuery,
  internalMutation,
  internalAction,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { ConvexError, v } from "convex/values";
import { currentUser, group, member } from "./access";
import { faaCredentialStatus } from "./faaCredentials";
import { createMailer, mailerSettings, type Mailer } from "./mailer";
import { programUsers } from "./memberships";
import { recordsDate } from "./recordsDate";
import {
  checkContext,
  managementDocs,
  inspectionDocs,
  airworthinessDocs,
  faaMonitorDocs,
  expiringItemDocs,
  discrepancyDocs,
} from "./programContext";
import {
  computeAlerts,
  systemDateAlerts,
  wantsAlertEmails,
} from "../src/domain/alerts";
import { backupWarningEmail, digestEmail } from "../src/domain/alertDigest";
import { offsiteFreshness } from "../src/domain/offsiteBackups";
import { adSchema } from "../src/domain/airworthiness";
import { expiringItemSchema } from "../src/domain/expiringItems";
import { faaMonitorSchema } from "../src/domain/faa";
import { recordSchema } from "../src/domain/management";
import { activeProgram, scopedSnapshot } from "../src/domain/programs";
import { earliestLocalDate } from "../src/domain/aircraftStatus";
import {
  latestLocalDate,
  type Group,
  type Snapshot,
} from "../src/domain/model";

const MAX_KEYS = 500;
const MAX_KEY_LENGTH = 300;

/**
 * The scope the deployment's own expiring dates are checked and delivered
 * in, apart from every Flight Program (a program uuid is never empty).
 */
export const SYSTEM_SCOPE = "";

/** The name system-scope emails and push messages carry. */
export const SYSTEM_SCOPE_NAME = "System";

/**
 * One scope's records every member's alerts are computed from: a program's,
 * before scopedSnapshot narrows them to a member, or for {@link SYSTEM_SCOPE}
 * the deployment's own dates.
 */
export type AlertSources = Omit<Snapshot, "user"> & { programUuid: string };

/** Where an alert was sent: the daily digest, at once by email, or pushed. */
export type DeliveryChannel = "digest" | "immediate" | "push";

type DigestRecipient = NonNullable<Awaited<ReturnType<typeof pendingDigest>>>;

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
    const rows = await readRows(ctx, userId, program);
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
 * Forgets the caller's read marks for alerts their device no longer shows,
 * so an alert that clears and later returns is unread again. Keys never
 * marked are ignored.
 *
 * @param keys - The cleared alerts' keys; duplicates count once.
 * @throws {ConvexError} As `markRead`.
 */
export const forgetRead = mutation({
  args: { programUuid: v.optional(v.string()), keys: v.array(v.string()) },
  handler: async (ctx, { programUuid, keys }) => {
    const state = await checkContext(ctx, programUuid);
    const cleared = new Set(validKeys(keys));
    const rows = await readRows(
      ctx,
      state.user.id as Id<"users">,
      programUuid ?? "",
    );
    await deleteRows(
      ctx,
      rows.filter((r) => cleared.has(r.key)),
    );
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

/**
 * Every scope the digest and the daily urgent check cover: each Flight
 * Program, then {@link SYSTEM_SCOPE}.
 *
 * @returns Each scope's uuid and the name its emails carry.
 */
export const digestPrograms = internalQuery({
  args: {},
  handler: async (ctx) => [
    ...(await ctx.db.query("programs").collect()).map((p) => ({
      uuid: p.uuid,
      name: p.name,
    })),
    { uuid: SYSTEM_SCOPE, name: SYSTEM_SCOPE_NAME },
  ],
});

/**
 * Opted-in active members of one scope with alerts not yet emailed to them,
 * each seeing only what their groups allow.
 *
 * @param programUuid - A Flight Program, or {@link SYSTEM_SCOPE}.
 * @param today - The local date the alerts are computed for.
 * @returns Per member: the pending alerts.
 */
export const digestRecipients = internalQuery({
  args: { programUuid: v.string(), today: v.string() },
  handler: async (ctx, { programUuid, today }) => {
    const audience = await alertAudience(ctx, programUuid);
    const users = audience.users.filter(
      (u) =>
        u.email &&
        wantsAlertEmails(
          member(u),
          audience.groups,
          emailChoice(programUuid, u, audience),
        ),
    );
    if (!users.length) return [];
    const sources = await sendableSources(ctx, programUuid, audience.groups);
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
 * Records which alerts a digest emailed. Nothing is forgotten here: only
 * {@link forgetCleared} ends an occurrence.
 *
 * @param keys - The alerts the email showed.
 */
export const recordDeliveries = internalMutation({
  args: {
    userId: v.id("users"),
    programUuid: v.string(),
    keys: v.array(v.string()),
  },
  handler: async (ctx, { userId, programUuid, keys }) => {
    const rows = await deliveryRows(ctx, userId, programUuid, "digest");
    const known = new Set(rows.map((r) => r.key));
    const sentAt = Date.now();
    for (const key of new Set(keys))
      if (!known.has(key))
        await ctx.db.insert("alertDeliveries", {
          userId,
          programUuid,
          key,
          sentAt,
          channel: "digest",
        });
  },
});

/**
 * Ends the occurrence of every alert that has cleared in a scope (a Flight
 * Program or {@link SYSTEM_SCOPE}):
 * forgets each member's delivery rows, on every channel, and read marks for
 * alerts they no longer have, so an alert that returns is sent again and is
 * unread again. The alerts are computed inside this transaction, so a row is
 * dropped only if its alert is gone at that moment; a claim made beside a
 * check that saw older records is never lost. A read mark is kept while the
 * alert exists on any date that is today somewhere, since a device judges
 * dates on its own calendar day. Read marks in the system scope belong to
 * the unassigned records' bell and are left alone.
 *
 * @returns `today`: the records date the alerts were computed for, which the
 *   check that follows must use.
 */
export const forgetCleared = internalMutation({
  args: { programUuid: v.string() },
  handler: async (ctx, { programUuid }) => {
    const now = Date.now();
    const today = recordsDate(now);
    const system = programUuid === SYSTEM_SCOPE;
    const audience = await alertAudience(ctx, programUuid);
    let sources: AlertSources | undefined;
    for (const u of audience.users) {
      const deliveries = await deliveryRows(ctx, u._id, programUuid);
      const reads = system ? [] : await readRows(ctx, u._id, programUuid);
      if (!deliveries.length && !reads.length) continue;
      // The bell shows a program's members the deployment's dates too, so
      // their read marks are judged against every alert, system dates
      // included.
      sources ??= system
        ? await sendableSources(ctx, programUuid, audience.groups)
        : await loadAlertSources(ctx, programUuid, audience.groups);
      const keysOn = alertKeysOf(sources, u);
      const live = keysOn(today);
      await deleteRows(
        ctx,
        deliveries.filter((r) => !live.has(r.key)),
      );
      const marks = reads.filter((r) => !live.has(r.key));
      if (!marks.length) continue;
      const elsewhere = [earliestLocalDate(now), latestLocalDate(now)].map(
        keysOn,
      );
      await deleteRows(
        ctx,
        marks.filter((r) => !elsewhere.some((keys) => keys.has(r.key))),
      );
    }
    return { today };
  },
});

/**
 * Emails each opted-in member their program's new alerts, and warns system
 * administrators of a stale off-site backup: at the top of a digest they get
 * anyway, or alone. A failed email is counted and logged by user id; a
 * program whose alerts cannot be computed (a damaged record) is logged by
 * its uuid and skipped, and the other programs and the warnings still go.
 *
 * @returns How many emails were sent and failed; `skipped` when
 *   RESEND_API_KEY or RESEND_FROM is not set.
 */
export const sendDigests = internalAction({
  args: {},
  handler: async (ctx) => {
    const settings = mailerSettings();
    // In-app alerts work without email; skip quietly until both are set.
    if (!settings) return { sent: 0, failed: 0, skipped: true };
    const mail = createMailer(settings);
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
        ...(await sendIsolatedDigests(ctx, mail, program, warningFor)),
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

function readRows(ctx: QueryCtx, userId: Id<"users">, programUuid: string) {
  return ctx.db
    .query("alertReads")
    .withIndex("user_program", (q) =>
      q.eq("userId", userId).eq("programUuid", programUuid),
    )
    .collect();
}

async function programGroups(ctx: QueryCtx, programUuid: string) {
  const docs = await ctx.db
    .query("groups")
    .withIndex("program", (q) => q.eq("programUuid", programUuid))
    .collect();
  return docs.map(group);
}

async function deleteRows(
  ctx: MutationCtx,
  rows: Doc<"alertDeliveries" | "alertReads">[],
) {
  for (const row of rows) await ctx.db.delete(row._id);
}

// The member's alert keys on a date; none when they cannot work in the
// program.
const alertKeysOf =
  (sources: AlertSources, u: Doc<"users">) => (date: string) =>
    new Set(memberAlerts(sources, u, date)?.map((a) => a.key));

/**
 * A member's delivery rows in a program.
 *
 * @param channel - Only that channel's rows; every row without one.
 * @returns The rows, in no particular order; a row stored before channels
 *   existed counts as "digest".
 */
export async function deliveryRows(
  ctx: QueryCtx,
  userId: Id<"users">,
  programUuid: string,
  channel?: DeliveryChannel,
) {
  const rows = await ctx.db
    .query("alertDeliveries")
    .withIndex("user_program", (q) =>
      q.eq("userId", userId).eq("programUuid", programUuid),
    )
    .collect();
  return channel ? rows.filter((r) => channelOf(r) === channel) : rows;
}

/**
 * The alert keys among delivery rows that were sent on one channel.
 *
 * @returns Each key, in row order.
 */
export function deliveredKeys(
  rows: Doc<"alertDeliveries">[],
  channel: DeliveryChannel,
): string[] {
  return rows.filter((r) => channelOf(r) === channel).map((r) => r.key);
}

const channelOf = (row: Doc<"alertDeliveries">): DeliveryChannel =>
  row.channel ?? "digest";

/**
 * Who a scope's alerts may reach: a program's active members with a group in
 * it (via the memberships index; groupIds stays authoritative), or every
 * active system administrator for {@link SYSTEM_SCOPE}, whatever their
 * groups.
 *
 * @param scope - A Flight Program, or {@link SYSTEM_SCOPE}.
 * @returns The scope, its groups (every group for the system scope, so each
 *   administrator's email switches can be read) and programs, and the users.
 */
export async function alertAudience(ctx: QueryCtx, scope: string) {
  const programs = await ctx.db.query("programs").collect();
  if (scope === SYSTEM_SCOPE) {
    const users = await ctx.db.query("users").collect();
    return {
      scope,
      programs,
      groups: (await ctx.db.query("groups").collect()).map(group),
      users: users.filter((u) => u.active && u.isAdmin),
    };
  }
  const groups = await programGroups(ctx, scope);
  const groupIds = new Set(groups.map((g) => g.id));
  const users = (await programUsers(ctx, scope)).filter(
    (u) => u.active && (u.groupIds ?? []).some((id) => groupIds.has(id)),
  );
  return { scope, programs, groups, users };
}

/**
 * The Flight Program whose email switches decide what a member is emailed:
 * the scope itself, or for {@link SYSTEM_SCOPE} the program whose Settings
 * the administrator sees, as for the off-site backup warning.
 *
 * @param context - Every group and program, for the system scope.
 * @returns The program uuid; undefined when the member has none.
 */
export function emailChoice(
  scope: string,
  u: Doc<"users">,
  context: Pick<Snapshot, "groups" | "programs">,
): string | undefined {
  if (scope !== SYSTEM_SCOPE) return scope;
  return activeProgram({ user: member(u), ...context });
}

/**
 * Loads one program's alert sources: its aircraft, maintenance records,
 * inspections, ADs, FAA monitors, open problem reports, expiring dates (with
 * the deployment's) and the FAA key status.
 *
 * @param groups - The program's permission groups, already loaded.
 * @returns The sources; members, flights, closed problem reports and the
 *   change log stay empty, since no alert reads them.
 */
export async function loadAlertSources(
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
    programUuid,
    programs,
    groups,
    aircraft,
    faaCredential: await faaCredentialStatus(ctx),
    expiringItems: (await expiringItemDocs(ctx, programUuid, true)).map((d) =>
      expiringItemSchema.parse(JSON.parse(d.payload)),
    ),
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
    discrepancies: await openDiscrepancies(ctx, aircraft),
    audit: [],
    syncedAt: 0,
    authenticatedAt: 0,
  };
}

// Aircraft status grounds on open grounding reports and expired deferrals,
// so the "is grounded" alert needs them; closed reports alert on nothing.
async function openDiscrepancies(ctx: QueryCtx, aircraft: { uuid: string }[]) {
  const reports = await discrepancyDocs(ctx, aircraft);
  return reports.filter((d) => d.status === "open");
}

/**
 * What a scope's check sends from: a program's alert sources without the
 * deployment's dates, which go out once in {@link SYSTEM_SCOPE}, or for the
 * system scope those dates and the FAA key status alone.
 *
 * @param scope - A Flight Program, or {@link SYSTEM_SCOPE}.
 * @param groups - The scope's groups, as {@link alertAudience} gives them.
 */
export async function sendableSources(
  ctx: QueryCtx,
  scope: string,
  groups: Group[],
): Promise<AlertSources> {
  if (scope !== SYSTEM_SCOPE) {
    const sources = await loadAlertSources(ctx, scope, groups);
    return {
      ...sources,
      expiringItems: sources.expiringItems?.filter((i) => i.programUuid),
      faaCredential: undefined,
    };
  }
  return {
    programUuid: SYSTEM_SCOPE,
    programs: await ctx.db.query("programs").collect(),
    groups,
    aircraft: [],
    faaCredential: await faaCredentialStatus(ctx),
    expiringItems: (await expiringItemDocs(ctx, undefined, true)).map((d) =>
      expiringItemSchema.parse(JSON.parse(d.payload)),
    ),
    members: [],
    flights: [],
    inspections: [],
    discrepancies: [],
    audit: [],
    syncedAt: 0,
    authenticatedAt: 0,
  };
}

/**
 * One member's alerts in the scope: in a program, from what their groups
 * let them see; in {@link SYSTEM_SCOPE}, the deployment's dates.
 *
 * @param today - The local date the alerts are computed for.
 * @returns The alerts, as computeAlerts orders them; undefined when the
 *   member cannot work in the program, or is not a system administrator in
 *   the system scope.
 */
export function memberAlerts(
  sources: AlertSources,
  u: Doc<"users">,
  today: string,
) {
  const { programUuid, ...records } = sources;
  if (programUuid === SYSTEM_SCOPE)
    return u.isAdmin
      ? systemDateAlerts({ ...records, user: member(u) }, today)
      : undefined;
  const state = scopedSnapshot({
    ...records,
    user: { ...member(u), activeProgramUuid: programUuid },
  });
  if (activeProgram(state) !== programUuid) return undefined;
  return computeAlerts(state, today);
}

async function pendingDigest(
  ctx: QueryCtx,
  sources: AlertSources,
  u: Doc<"users">,
  programUuid: string,
  today: string,
) {
  const alerts = memberAlerts(sources, u, today);
  if (!alerts) return undefined;
  const sent = new Set(
    deliveredKeys(await deliveryRows(ctx, u._id, programUuid), "digest"),
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
  };
}

// One program's failure must not cost every later program its digest and
// the system administrators their backup warning; Convex does not retry a
// failed action.
async function sendIsolatedDigests(
  ctx: ActionCtx,
  mail: Mailer,
  program: { uuid: string; name: string },
  warningFor: (userId: string) => string | undefined,
): Promise<string[]> {
  try {
    return await sendProgramDigests(ctx, mail, program, warningFor);
  } catch (error) {
    console.error(
      "Alert digest skipped for a Flight Program",
      program.uuid,
      error instanceof Error ? error.name : "unknown error",
    );
    return [];
  }
}

// Returns the members whose digest carried the backup warning.
async function sendProgramDigests(
  ctx: ActionCtx,
  mail: Mailer,
  program: { uuid: string; name: string },
  warningFor: (userId: string) => string | undefined,
) {
  const { today } = await ctx.runMutation(internal.alerts.forgetCleared, {
    programUuid: program.uuid,
  });
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
