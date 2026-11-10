/**
 * Responsibility: Pins urgent alerts reaching people at once: who is emailed,
 *   no second email for the same alert on any channel, the digest still
 *   listing them, the daily cap, a refused send retried later, the email
 *   choice, the check running after a mutation, and a grounding problem
 *   report reaching both the urgent email and the digest.
 * Layer: Test. convex-test suite with a stubbed Resend; never shipped.
 * Dependencies: convex/urgentAlerts.ts, convex/alerts.ts,
 *   convex/expiringItems.ts, convex/rateLimits.ts, convex/schema.ts,
 *   tests/fixtures/alertProgram.ts.
 */
import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { DAY } from "./rateLimits";
import { IMMEDIATE_CAP_KEY, IMMEDIATE_EMAILS_PER_DAY } from "./urgentAlerts";
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

it("schedules every program's check from the daily cron", async () => {
  const { t } = await seedAlertProgram();
  vi.useFakeTimers();
  const request = stubResend();
  expect(await t.action(internal.urgentAlerts.daily, {})).toEqual({
    scheduled: 2,
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
