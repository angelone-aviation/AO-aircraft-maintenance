/**
 * Responsibility: Pins which stored records the server's alert checks read:
 *   AD actions, component limits and a program's own expiring dates reach
 *   the digest and the urgent email of that program's members only.
 * Layer: Test. convex-test suite with a stubbed Resend; never shipped.
 * Dependencies: convex/alerts.ts, convex/urgentAlerts.ts,
 *   convex/expiringItems.ts, tests/fixtures/alertProgram.ts,
 *   tests/fixtures/dueFleet.ts.
 *
 * The other alert suites seed inspections only, so these loaders ran in no
 * test: a wrong index or table there would silence a whole kind of alert.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import {
  DEMO_PROGRAM,
  OTHER_PROGRAM,
  seedAlertProgram,
  sentEmails,
  stubResend,
  type AlertWorld,
} from "../tests/fixtures/alertProgram";
import { dueFleet } from "../tests/fixtures/dueFleet";
import type { AD } from "../src/domain/airworthiness";
import type { ManagedRecord } from "../src/domain/management";

// 2026-10-30 in the records time zone (US Eastern), dueFleet's day.
const NOW = new Date("2026-10-30T16:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it("lists a program's AD actions, component limits and expiring dates in its own members' digest only", async () => {
  const world = await seedFleet();
  const request = stubResend();
  await world.t.action(internal.alerts.sendDigests, {});
  const ours = digestTo(request, "admin@example.test");
  for (const title of [
    "AD AD-OVERDUE overdue",
    "AD AD-SOON due soon",
    "Component due now: Type pump",
    "Component due soon: Type pump",
    "Hull policy expired on 2026-10-01",
  ])
    expect(ours).toContain(title);
  expect(ours).not.toMatch(/AD-B|b-pump/);
  const theirs = digestTo(request, "other@example.test");
  expect(theirs).toContain("AD AD-B overdue");
  expect(theirs).toContain("Component due now: Type b-pump");
  expect(theirs).not.toMatch(/AD-OVERDUE|AD-SOON|Type pump|Hull policy/);
});

it("emails the overdue AD, the component past its limit and the expired date at once, not what is only coming due", async () => {
  const world = await seedFleet();
  const request = stubResend();
  await world.t.action(internal.urgentAlerts.sendImmediate, {
    programUuid: DEMO_PROGRAM,
  });
  const [email] = sentEmails(request);
  expect(email.to).toEqual(["admin@example.test"]);
  expect(email.subject).toBe("Mission operations: 5 urgent alerts");
  expect(email.text).toContain("AD AD-OVERDUE overdue");
  expect(email.text).toContain("Component due now: Type pump");
  expect(email.text).toContain("Hull policy expired on 2026-10-01");
  expect(email.text).not.toMatch(/due soon|AD-B/);
});

it("emails nothing to a member whose groups give no read permission, even opted in", async () => {
  const world = await seedFleet();
  await world.t.run(async (ctx) => {
    const groupId = await ctx.db.insert("groups", {
      programUuid: DEMO_PROGRAM,
      name: "Flight only",
      programAdmin: false,
      aircraftIds: [],
      permissions: ["flight"],
    });
    await ctx.db.insert("users", {
      active: true,
      isAdmin: false,
      name: "flight-only",
      email: "flight-only@example.test",
      groupIds: [groupId],
      activeProgramUuid: DEMO_PROGRAM,
      emailAlerts: true,
      urgentAlertEmails: true,
    });
  });
  await world.t.mutation(internal.memberships.backfill, {});
  const request = stubResend();
  await world.t.action(internal.alerts.sendDigests, {});
  await world.t.action(internal.urgentAlerts.sendImmediate, {
    programUuid: DEMO_PROGRAM,
  });
  const recipients = sentEmails(request).map((e) => e.to[0]);
  expect(recipients).toContain("admin@example.test");
  expect(recipients).not.toContain("flight-only@example.test");
});

it("finds no recipients for a scope that is not a Flight Program", async () => {
  const { t } = await seedAlertProgram();
  expect(
    await t.query(internal.urgentAlerts.urgentRecipients, {
      programUuid: "no-such-program",
      today: "2026-10-30",
    }),
  ).toEqual({ programName: "", recipients: [] });
});

it("claims nothing, and spends none of the day's emails, for alerts already sent on the channel", async () => {
  const { t, ids } = await seedAlertProgram();
  const claim = {
    userId: ids.a.userId,
    programUuid: DEMO_PROGRAM,
    channel: "immediate" as const,
    keys: ["k1", "k2", "k1"],
  };
  expect(
    await t.mutation(internal.urgentAlerts.claimDeliveries, claim),
  ).toEqual({ claimed: ["k1", "k2"], capped: false });
  const spent = () =>
    t.run(async (ctx) =>
      (await ctx.db.query("rateLimits").collect()).map((r) => r.count),
    );
  expect(await spent()).toEqual([1]);
  expect(
    await t.mutation(internal.urgentAlerts.claimDeliveries, claim),
  ).toEqual({ claimed: [], capped: false });
  expect(await spent()).toEqual([1]);
});

async function seedFleet(): Promise<AlertWorld> {
  const world = await seedAlertProgram();
  const { s, a } = dueFleet();
  const programOf = (aircraftUuid: string | undefined) =>
    aircraftUuid === a.uuid ? DEMO_PROGRAM : OTHER_PROGRAM;
  const records = s.management ?? [];
  const componentProgram = new Map(
    records.flatMap((r) =>
      r.kind === "component" ? [[r.uuid, programOf(r.aircraftUuid)]] : [],
    ),
  );
  await world.t.run(async (ctx) => {
    for (const r of records)
      await ctx.db.insert("management", {
        uuid: r.uuid,
        kind: r.kind,
        ...placement(r, programOf, componentProgram),
        payload: JSON.stringify(r),
      });
    for (const r of storedADs(s.airworthiness ?? []))
      await ctx.db.insert("airworthiness", {
        uuid: r.uuid,
        aircraftUuid: r.aircraftUuid,
        programUuid: programOf(r.aircraftUuid),
        payload: JSON.stringify(r),
      });
  });
  await world.a.mutation(api.expiringItems.save, {
    programUuid: DEMO_PROGRAM,
    payload: JSON.stringify({
      action: "save",
      requestUuid: crypto.randomUUID(),
      item: {
        uuid: "11111111-1111-4111-8111-111111111111",
        programUuid: DEMO_PROGRAM,
        kind: "insurance",
        label: "Hull policy",
        expiresOn: "2026-10-01",
        version: 0,
      },
    }),
  });
  return world;
}

// The fixture holds components and their requirements only; a requirement
// is tagged with its component's program.
function placement(
  r: ManagedRecord,
  programOf: (aircraftUuid: string | undefined) => string,
  componentProgram: Map<string, string>,
) {
  if (r.kind === "component")
    return {
      aircraftUuid: r.aircraftUuid,
      programUuid: programOf(r.aircraftUuid),
    };
  if (r.kind === "componentRequirement")
    return { programUuid: componentProgram.get(r.componentUuid) };
  throw new Error(`The due fleet holds no ${r.kind} records.`);
}

// The fixture's ids are readable names; stored ADs need real uuids.
function storedADs(ads: AD[]): AD[] {
  return ads
    .filter((r) => ["ad-overdue", "ad-soon", "ad-b"].includes(r.uuid))
    .map((r) => ({
      ...r,
      uuid: crypto.randomUUID(),
      tasks: r.tasks.map((t) => ({ ...t, uuid: crypto.randomUUID() })),
    }));
}

function digestTo(request: ReturnType<typeof stubResend>, to: string): string {
  const email = sentEmails(request).find((e) => e.to[0] === to);
  if (!email) throw new Error(`No digest went to ${to}.`);
  return email.text;
}
