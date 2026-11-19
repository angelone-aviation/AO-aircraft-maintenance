/**
 * Responsibility: Pins each Flight Program's share of the day's immediate
 *   urgent-alert emails (decision D9): one program cannot spend another's,
 *   the total stays the deployment's cap, refused sends give back both, and
 *   system administrators are warned once a day when a share holds an email
 *   back.
 * Layer: Test. convex-test suite with a stubbed Resend; never shipped.
 * Dependencies: convex/urgentAlerts.ts, convex/rateLimits.ts,
 *   src/domain/alerts.ts, tests/fixtures/alertProgram.ts.
 */
import { afterEach, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import { DAY } from "./rateLimits";
import {
  IMMEDIATE_CAP_KEY,
  IMMEDIATE_EMAILS_PER_DAY,
  immediateShareKey,
} from "./urgentAlerts";
import { immediateEmailShare } from "../src/domain/alerts";
import {
  DEMO_PROGRAM,
  OTHER_PROGRAM,
  seedAlertProgram,
  sentEmails,
  stubResend,
  type AlertWorld,
} from "../tests/fixtures/alertProgram";

const WARNING =
  "System: Mission operations reached its share of urgent alert emails";
// Both seeded programs have active members.
const SHARE = immediateEmailShare(2);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const check = (t: AlertWorld["t"], programUuid = DEMO_PROGRAM) =>
  t.action(internal.urgentAlerts.sendImmediate, { programUuid });

const spent = (t: AlertWorld["t"], key: string, count: number) =>
  t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("rateLimits", {
      key,
      windowStart: now - (now % DAY),
      count,
    });
  });

const counted = (t: AlertWorld["t"], key: string) =>
  t.run(
    async (ctx) =>
      (
        await ctx.db
          .query("rateLimits")
          .withIndex("key", (q) => q.eq("key", key))
          .unique()
      )?.count ?? 0,
  );

// A system administrator in no group with urgent emails on.
const addRoot = (t: AlertWorld["t"]) =>
  t.run((ctx) =>
    ctx.db.insert("users", {
      active: true,
      isAdmin: true,
      name: "root",
      email: "root@example.test",
      groupIds: [],
      activeProgramUuid: "",
      urgentAlertEmails: true,
    }),
  );

it("gives each Flight Program its share, so one program's flood cannot hold back another's", async () => {
  const { t } = await seedAlertProgram();
  stubResend();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(SHARE).toBe(IMMEDIATE_EMAILS_PER_DAY / 2);
  await spent(t, immediateShareKey(DEMO_PROGRAM), SHARE);
  expect(await check(t)).toMatchObject({ sent: 0, capped: 1 });
  expect(await check(t, OTHER_PROGRAM)).toMatchObject({ sent: 1, capped: 0 });
  expect(await counted(t, immediateShareKey(DEMO_PROGRAM))).toBe(SHARE);
  expect(await counted(t, immediateShareKey(OTHER_PROGRAM))).toBe(1);
  expect(await counted(t, IMMEDIATE_CAP_KEY)).toBe(1);
});

it("splits the total only between programs with an active member", async () => {
  const { t, ids } = await seedAlertProgram();
  stubResend();
  await t.run((ctx) => ctx.db.patch(ids.b.userId, { active: false }));
  await spent(t, immediateShareKey(DEMO_PROGRAM), SHARE);
  expect(await check(t)).toMatchObject({ sent: 1, capped: 0 });
});

it("counts an email against its program's share and the total, and gives both back when it is refused", async () => {
  const { t } = await seedAlertProgram();
  stubResend(503);
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await check(t)).toMatchObject({ sent: 0, failed: 1 });
  expect(await counted(t, immediateShareKey(DEMO_PROGRAM))).toBe(0);
  expect(await counted(t, IMMEDIATE_CAP_KEY)).toBe(0);
  stubResend(200);
  expect(await check(t)).toMatchObject({ sent: 1 });
  expect(await counted(t, immediateShareKey(DEMO_PROGRAM))).toBe(1);
  expect(await counted(t, IMMEDIATE_CAP_KEY)).toBe(1);
});

it("keeps the deployment's total as the cap, and gives the share back when the total refuses", async () => {
  const { t } = await seedAlertProgram();
  stubResend();
  await spent(t, IMMEDIATE_CAP_KEY, IMMEDIATE_EMAILS_PER_DAY);
  expect(await check(t)).toMatchObject({ sent: 0, capped: 1 });
  expect(await counted(t, immediateShareKey(DEMO_PROGRAM))).toBe(0);
});

it("warns system administrators once a day when a program's share holds an email back", async () => {
  const { t } = await seedAlertProgram();
  vi.useFakeTimers();
  await addRoot(t);
  const request = stubResend();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await spent(t, immediateShareKey(DEMO_PROGRAM), SHARE);
  await check(t);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  await check(t);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const warnings = sentEmails(request).filter((e) => e.subject === WARNING);
  expect(warnings.map((e) => e.to)).toEqual([["root@example.test"]]);
  expect(warn).toHaveBeenCalledWith(
    "A Flight Program reached its share of immediate alert emails",
    DEMO_PROGRAM,
    SHARE,
  );
  // The warning is an immediate email too, so it counts in the total.
  expect(await counted(t, IMMEDIATE_CAP_KEY)).toBe(1);
});
