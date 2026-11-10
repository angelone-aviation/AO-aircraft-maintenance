/**
 * Responsibility: Pins urgent alerts reaching people at once: who is emailed,
 *   no second email for the same alert on any channel, the digest still
 *   listing them, the daily cap, a refused send retried later, the email
 *   choice, the check running after a mutation, a grounding problem report
 *   reaching both the urgent email and the digest, calendar limits judged
 *   on the records time zone's date, de-duplication per occurrence (an alert
 *   that cleared and returned is sent, and unread, again), and deployment-wide
 *   dates sent once to system administrators, whatever their groups.
 * Layer: Test. convex-test suite with a stubbed Resend; never shipped.
 * Dependencies: convex/urgentAlerts.ts, convex/alerts.ts,
 *   convex/expiringItems.ts, convex/rateLimits.ts, convex/schema.ts,
 *   tests/fixtures/alertProgram.ts.
 */
import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { DAY } from "./rateLimits";
import { recordsDate } from "./recordsDate";
import { IMMEDIATE_CAP_KEY, IMMEDIATE_EMAILS_PER_DAY } from "./urgentAlerts";
import { computeAlerts } from "../src/domain/alerts";
import {
  DEMO_PROGRAM,
  seedAlertProgram,
  sentEmails,
  stubResend,
  type AlertWorld,
} from "../tests/fixtures/alertProgram";

const inProgram = { programUuid: DEMO_PROGRAM };
const SUBJECT = "Mission operations: 2 urgent alerts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const deliveries = (t: AlertWorld["t"]) =>
  t.run((ctx) => ctx.db.query("alertDeliveries").collect());
const sendImmediate = (t: AlertWorld["t"]) =>
  t.action(internal.urgentAlerts.sendImmediate, inProgram);

it("emails new urgent alerts at once to opted-in members, and never the same alert twice", async () => {
  const { t } = await seedAlertProgram();
  const request = stubResend();
  // The program administrator defaults on; the reader has no maintenance
  // permission and has not opted in.
  expect(await sendImmediate(t)).toEqual({
    sent: 1,
    failed: 0,
    capped: 0,
    pushed: 0,
    skipped: false,
  });
  const [email] = sentEmails(request);
  expect(email.to).toEqual(["admin@example.test"]);
  expect(email.subject).toBe(SUBJECT);
  expect(email.text).toContain("Inspection overdue: Annual N206MA");
  expect(email.text).toContain("N206MA is grounded");
  expect(email.text).toContain("https://app.example.test/inspections");
  expect(email.text).not.toContain("N208MA");
  const rows = await deliveries(t);
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.channel === "immediate")).toBe(true);
  expect(await sendImmediate(t)).toMatchObject({ sent: 0 });
  expect(request).toHaveBeenCalledTimes(1);
});

it("skips alerts the digest already emailed, while the digest still lists what went out at once", async () => {
  const { t } = await seedAlertProgram();
  const request = stubResend();
  await t.action(internal.alerts.sendDigests, {});
  expect(request).toHaveBeenCalledTimes(2);
  expect(await sendImmediate(t)).toMatchObject({ sent: 0 });
  expect(request).toHaveBeenCalledTimes(2);

  const fresh = await seedAlertProgram();
  const again = stubResend();
  expect(await sendImmediate(fresh.t)).toMatchObject({ sent: 1 });
  expect(await fresh.t.action(internal.alerts.sendDigests, {})).toMatchObject({
    sent: 2,
  });
  const subjects = sentEmails(again).map((e) => e.subject);
  expect(subjects).toEqual([
    SUBJECT,
    "Mission operations: 2 maintenance alerts",
    "Other: 2 maintenance alerts",
  ]);
  const channels = (await deliveries(fresh.t)).map((r) => r.channel).sort();
  expect(channels).toEqual([
    "digest",
    "digest",
    "digest",
    "digest",
    "immediate",
    "immediate",
  ]);
});

it("holds alerts back once the day's immediate emails are spent; the digest still sends them", async () => {
  const { t } = await seedAlertProgram();
  const request = stubResend();
  const now = Date.now();
  await t.run((ctx) =>
    ctx.db.insert("rateLimits", {
      key: IMMEDIATE_CAP_KEY,
      windowStart: now - (now % DAY),
      count: IMMEDIATE_EMAILS_PER_DAY,
    }),
  );
  expect(await sendImmediate(t)).toMatchObject({ sent: 0, capped: 1 });
  expect(request).not.toHaveBeenCalled();
  expect(await deliveries(t)).toEqual([]);
  expect(await t.action(internal.alerts.sendDigests, {})).toMatchObject({
    sent: 2,
  });
});

it("counts each immediate email against the cap", async () => {
  const { t } = await seedAlertProgram();
  stubResend();
  await sendImmediate(t);
  const [row] = await t.run((ctx) =>
    ctx.db
      .query("rateLimits")
      .withIndex("key", (q) => q.eq("key", IMMEDIATE_CAP_KEY))
      .collect(),
  );
  expect(row.count).toBe(1);
});

it("releases the claim when the provider refuses, so the next check retries", async () => {
  const { t, ids } = await seedAlertProgram();
  stubResend(503);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await sendImmediate(t)).toMatchObject({ sent: 0, failed: 1 });
  expect(await deliveries(t)).toEqual([]);
  expect(error).toHaveBeenCalledWith(
    "Urgent alert email not sent",
    ids.a.userId,
    "Email provider rejected the request (503).",
  );
  expect(JSON.stringify(error.mock.calls)).not.toContain("@example.test");
  error.mockRestore();
  stubResend(200);
  expect(await sendImmediate(t)).toMatchObject({ sent: 1 });
  expect(await deliveries(t)).toHaveLength(2);
});

it("honours the urgent email choice", async () => {
  const { t, a, reader } = await seedAlertProgram();
  const request = stubResend();
  await a.mutation(api.urgentAlerts.setUrgentEmailPreference, {
    enabled: false,
  });
  await reader.mutation(api.urgentAlerts.setUrgentEmailPreference, {
    enabled: true,
  });
  expect(await sendImmediate(t)).toMatchObject({ sent: 1 });
  expect(sentEmails(request)[0].to).toEqual(["reader@example.test"]);
});

it("skips quietly until email and push are both unconfigured", async () => {
  const { t } = await seedAlertProgram();
  const request = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", request);
  expect(await sendImmediate(t)).toEqual({
    sent: 0,
    failed: 0,
    capped: 0,
    pushed: 0,
    skipped: true,
  });
  expect(request).not.toHaveBeenCalled();
  expect(
    await t.action(internal.urgentAlerts.sendImmediate, {
      programUuid: "no-such-program",
    }),
  ).toMatchObject({ skipped: true });
});

it("runs after a mutation that can create an urgent state", async () => {
  const { t, a } = await seedAlertProgram();
  vi.useFakeTimers();
  const request = stubResend();
  // Already-urgent alerts go out with the first check; an expired date adds
  // a third.
  await a.mutation(api.expiringItems.save, {
    ...inProgram,
    payload: JSON.stringify({
      action: "save",
      item: {
        uuid: "11111111-1111-4111-8111-111111111111",
        programUuid: DEMO_PROGRAM,
        kind: "insurance",
        label: "Hull policy",
        expiresOn: "2020-01-01",
        version: 0,
      },
    }),
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(request).toHaveBeenCalledTimes(1);
  const [email] = sentEmails(request);
  expect(email.subject).toBe("Mission operations: 3 urgent alerts");
  expect(email.text).toContain("Hull policy expired on 2020-01-01");
});

it("schedules every program's check, and the deployment's dates', from the daily cron", async () => {
  const { t } = await seedAlertProgram();
  vi.useFakeTimers();
  const request = stubResend();
  expect(await t.action(internal.urgentAlerts.daily, {})).toEqual({
    scheduled: 3,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(
    sentEmails(request)
      .map((e) => e.to[0])
      .sort(),
  ).toEqual(["admin@example.test", "other@example.test"]);
});

const REPORT = "Nose gear oleo flat after landing";

// No other urgent alert: the seeded inspections are far from due.
const clearInspections = (t: AlertWorld["t"]) =>
  t.run(async (ctx) => {
    for (const i of await ctx.db.query("inspections").collect())
      await ctx.db.patch(i._id, { dueDate: "2999-01-01" });
  });

it("emails an aircraft grounded by a synced problem report at once, and lists it in the digest", async () => {
  const world = await seedAlertProgram();
  vi.useFakeTimers();
  await clearInspections(world.t);
  await world.t.run(async (ctx) => {
    const reader = await ctx.db.get(world.ids.reader.userId);
    await ctx.db.patch(reader!.groupIds![0], {
      permissions: ["read", "flight", "discrepancy"],
    });
  });
  const request = stubResend();
  await world.reader.mutation(api.operations.submit, {
    operation: {
      programUuid: DEMO_PROGRAM,
      kind: "discrepancy",
      uuid: crypto.randomUUID(),
      authorId: world.ids.reader.userId,
      aircraftUuid: world.ids.aircraftUuid,
      description: REPORT,
      grounding: true,
    },
  });
  await world.t.finishAllScheduledFunctions(vi.runAllTimers);
  const [urgent] = sentEmails(request);
  expect(urgent.subject).toBe("Mission operations: 1 urgent alert");
  expect(urgent.text).toContain("N206MA is grounded");
  expect(urgent.text).toContain("Open discrepancy: " + REPORT);
  await world.t.action(internal.alerts.sendDigests, {});
  const [, digest] = sentEmails(request);
  expect(digest.subject).toBe("Mission operations: 1 maintenance alert");
  expect(digest.text).toContain("N206MA is grounded");
});

it("emails an aircraft grounded by an expired deferral, and nothing for a resolved report", async () => {
  const { t, ids } = await seedAlertProgram();
  await clearInspections(t);
  const report = {
    aircraftUuid: ids.aircraftUuid,
    description: REPORT,
    authorId: ids.reader.userId,
    createdAt: 0,
  };
  await t.run(async (ctx) => {
    await ctx.db.insert("discrepancies", {
      ...report,
      uuid: "resolved-report",
      status: "resolved",
      grounding: true,
    });
  });
  const request = stubResend();
  expect(await sendImmediate(t)).toMatchObject({ sent: 0 });
  await t.run(async (ctx) => {
    await ctx.db.insert("discrepancies", {
      ...report,
      uuid: "deferred-report",
      status: "open",
      deferral: {
        type: "mel",
        melItem: "32-1",
        category: "B",
        placard: "INOP",
        deferredOn: "2020-01-01",
        deferredAt: 0,
        deferredBy: ids.a.userId,
        deferredByName: "admin",
        expiresOn: "2020-01-04",
      },
    });
  });
  expect(await sendImmediate(t)).toMatchObject({ sent: 1 });
  expect(sentEmails(request)[0].text).toContain("deferral expired 2020-01-04");
});

it("judges calendar limits on the records time zone's date, not the UTC date", async () => {
  const { t } = await seedAlertProgram();
  await t.run(async (ctx) => {
    for (const i of await ctx.db.query("inspections").collect())
      await ctx.db.patch(i._id, { dueDate: "2026-11-10" });
  });
  const request = stubResend();
  vi.useFakeTimers({ toFake: ["Date"] });
  // 20:00 on the due date in New York is already 11 Nov in UTC. GLOSSARY
  // "Overdue": a calendar limit is overdue from the day after its due date.
  vi.setSystemTime(new Date("2026-11-11T01:00:00Z"));
  expect(await sendImmediate(t)).toMatchObject({ sent: 0 });
  const digests = await t.action(internal.alerts.sendDigests, {});
  expect(digests).toMatchObject({ sent: 2 });
  expect(sentEmails(request)[0].text).toContain("Inspection due soon");
  expect(sentEmails(request)[0].text).not.toContain("grounded");
  // Midnight in New York.
  vi.setSystemTime(new Date("2026-11-11T05:00:00Z"));
  expect(await sendImmediate(t)).toMatchObject({ sent: 1 });
  expect(sentEmails(request)[2].text).toContain("N206MA is grounded");
  // A deployment further west sets RECORDS_TIME_ZONE.
  const west = await seedAlertProgram();
  await west.t.run(async (ctx) => {
    for (const i of await ctx.db.query("inspections").collect())
      await ctx.db.patch(i._id, { dueDate: "2026-11-10" });
  });
  vi.stubEnv("RECORDS_TIME_ZONE", "America/Los_Angeles");
  expect(await sendImmediate(west.t)).toMatchObject({ sent: 0 });
});

const ground = (world: AlertWorld, grounded: boolean) =>
  world.t.run(async (ctx) => {
    const aircraft = (await ctx.db.query("aircraft").collect()).find(
      (a) => a.uuid === world.ids.aircraftUuid,
    )!;
    await ctx.db.patch(aircraft._id, {
      operationalStatus: grounded ? "grounded" : "airworthy",
    });
  });

it("emails an urgent alert again when it cleared and came back, and once per occurrence", async () => {
  const world = await seedAlertProgram();
  const { t } = world;
  await clearInspections(t);
  const request = stubResend();
  await ground(world, true);
  expect(await sendImmediate(t)).toMatchObject({ sent: 1 });
  expect(await sendImmediate(t)).toMatchObject({ sent: 0 });
  // Returned to service: the check finds the alert gone, which ends the
  // occurrence although nothing new is sent.
  await ground(world, false);
  expect(await sendImmediate(t)).toMatchObject({ sent: 0 });
  expect(await deliveries(t)).toEqual([]);
  // Grounded again for the same reason: the same key, a new occurrence.
  await ground(world, true);
  expect(await sendImmediate(t)).toMatchObject({ sent: 1 });
  expect(await sendImmediate(t)).toMatchObject({ sent: 0 });
  expect(sentEmails(request).map((e) => e.subject)).toEqual([
    "Mission operations: 1 urgent alert",
    "Mission operations: 1 urgent alert",
  ]);
});

it("lists an alert in the digest again when it cleared and came back", async () => {
  const world = await seedAlertProgram();
  const { t } = world;
  await clearInspections(t);
  const request = stubResend();
  const sendDigests = () => t.action(internal.alerts.sendDigests, {});
  await ground(world, true);
  expect(await sendDigests()).toMatchObject({ sent: 1 });
  expect(await sendDigests()).toMatchObject({ sent: 0 });
  await ground(world, false);
  expect(await sendDigests()).toMatchObject({ sent: 0 });
  await ground(world, true);
  expect(await sendDigests()).toMatchObject({ sent: 1 });
  expect(sentEmails(request)[1].text).toContain("N206MA is grounded");
});

it("keeps a claim while its alert lasts, whatever a check running beside it saw", async () => {
  const world = await seedAlertProgram();
  const { t, ids } = world;
  stubResend();
  await sendImmediate(t);
  const claimed = (await deliveries(t)).map((r) => r.key).sort();
  expect(claimed).toHaveLength(2);
  // A second check that computed its alerts before these arose claims
  // another alert; the claims it never saw must stay, or they go out twice.
  await t.mutation(internal.urgentAlerts.claimDeliveries, {
    userId: ids.a.userId,
    ...inProgram,
    channel: "immediate",
    keys: ["another-alert"],
  });
  const kept = (await deliveries(t)).map((r) => r.key).sort();
  expect(kept).toEqual([...claimed, "another-alert"].sort());
  expect(await sendImmediate(t)).toMatchObject({ sent: 0 });
});

it("makes a returning alert unread again, and keeps the marks of alerts that last", async () => {
  const world = await seedAlertProgram();
  const { t, a } = world;
  stubResend();
  await ground(world, true);
  const shown = async () => {
    const snapshot = await a.query(api.operations.snapshot, {});
    return computeAlerts(snapshot!, recordsDate()).map((x) => x.key);
  };
  const before = await shown();
  const grounded = before.find((k) => k.startsWith("aircraft-grounded"))!;
  await a.mutation(api.alerts.markRead, { ...inProgram, keys: before });
  await sendImmediate(t);
  expect((await a.query(api.alerts.readKeys, inProgram)).sort()).toEqual(
    [...before].sort(),
  );
  // The profile grounding ends: the reasons, and so the key, change.
  await ground(world, false);
  await sendImmediate(t);
  const lasting = await shown();
  expect(lasting).not.toContain(grounded);
  expect(await a.query(api.alerts.readKeys, inProgram)).not.toContain(grounded);
  await ground(world, true);
  await sendImmediate(t);
  expect(await shown()).toContain(grounded);
  expect(await a.query(api.alerts.readKeys, inProgram)).not.toContain(grounded);
});

it("keeps a read mark for an alert a device ahead of the records date already shows", async () => {
  const { t, a } = await seedAlertProgram();
  await t.run(async (ctx) => {
    for (const i of await ctx.db.query("inspections").collect())
      await ctx.db.patch(i._id, { dueDate: "2026-11-10" });
  });
  stubResend();
  vi.useFakeTimers({ toFake: ["Date"] });
  // 10 Nov in New York, already 11 Nov in Auckland, where the inspection
  // reads overdue.
  vi.setSystemTime(new Date("2026-11-10T15:00:00Z"));
  const snapshot = await a.query(api.operations.snapshot, {});
  const overdue = computeAlerts(snapshot!, "2026-11-11")
    .filter((x) => x.kind === "inspection-overdue")
    .map((x) => x.key);
  expect(overdue).toHaveLength(1);
  await a.mutation(api.alerts.markRead, {
    ...inProgram,
    keys: [...overdue, "gone-everywhere"],
  });
  await sendImmediate(t);
  expect(await a.query(api.alerts.readKeys, inProgram)).toEqual(overdue);
});

const SECRET = {
  uuid: "33333333-3333-4333-8333-333333333333",
  kind: "secret",
  label: "Entra client secret",
  expiresOn: "2020-01-01",
  version: 1,
};
const SECRET_LINE = "Entra client secret expired on 2020-01-01";
const linesAbout = (request: ReturnType<typeof stubResend>, text: string) =>
  sentEmails(request).filter((e) => e.text.includes(text));

// A system administrator in no permission group, as admin.bootstrap creates
// the first one, with both email switches on.
async function addRoot(t: AlertWorld["t"]) {
  const subject = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      active: true,
      isAdmin: true,
      name: "root",
      email: "root@example.test",
      groupIds: [],
      activeProgramUuid: "",
      emailAlerts: true,
      urgentAlertEmails: true,
    });
    const session = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + DAY,
    });
    return `${userId}|${session}`;
  });
  return t.withIdentity({ subject });
}

it("emails a deployment-wide expired date to a system administrator in no group, at once and in the digest", async () => {
  const { t } = await seedAlertProgram();
  vi.useFakeTimers();
  const root = await addRoot(t);
  const request = stubResend();
  // Saved while working in no Flight Program.
  await root.mutation(api.expiringItems.save, {
    payload: JSON.stringify({
      action: "save",
      item: { ...SECRET, version: 0 },
    }),
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const urgent = linesAbout(request, SECRET_LINE);
  expect(urgent.map((e) => [e.to[0], e.subject])).toEqual([
    ["root@example.test", "System: 1 urgent alert"],
  ]);
  await t.action(internal.alerts.sendDigests, {});
  const digest = linesAbout(request, SECRET_LINE).slice(1);
  expect(digest.map((e) => [e.to[0], e.subject])).toEqual([
    ["root@example.test", "System: 1 maintenance alert"],
  ]);
  // Nobody outside the system administrators hears of it.
  expect(
    sentEmails(request).filter(
      (e) => e.to[0] !== "root@example.test" && e.text.includes("Entra"),
    ),
  ).toEqual([]);
});

it("sends a deployment-wide date once, not once per Flight Program, and only by the switches the administrator sees", async () => {
  const { t, ids } = await seedAlertProgram();
  vi.useFakeTimers();
  await t.run(async (ctx) => {
    const other = await ctx.db.get(ids.b.userId);
    const admin = await ctx.db.get(ids.a.userId);
    // An administrator of both programs, urgent emails on by default there.
    await ctx.db.patch(ids.a.userId, {
      isAdmin: true,
      groupIds: [...admin!.groupIds!, ...other!.groupIds!],
    });
    await ctx.db.insert("expiringItems", {
      uuid: SECRET.uuid,
      payload: JSON.stringify(SECRET),
    });
  });
  await t.mutation(internal.memberships.backfill, {});
  const root = await addRoot(t);
  await root.mutation(api.urgentAlerts.setUrgentEmailPreference, {
    enabled: false,
  });
  const request = stubResend();
  await t.action(internal.urgentAlerts.daily, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const urgent = linesAbout(request, SECRET_LINE);
  expect(urgent.map((e) => [e.to[0], e.subject])).toEqual([
    ["admin@example.test", "System: 1 urgent alert"],
  ]);
  await t.action(internal.urgentAlerts.daily, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(linesAbout(request, SECRET_LINE)).toHaveLength(1);
});
