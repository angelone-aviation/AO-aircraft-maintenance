/**
 * Responsibility: Pins alert read state per user and program, and the daily
 *   digest: who is emailed what, no resends, failures, the off-site backup
 *   warning that only system administrators get, which delivery rows are
 *   forgotten once their alerts clear, and one program's damaged record not
 *   stopping the others' digests.
 * Layer: Test. convex-test suite with a stubbed Resend; never shipped.
 * Dependencies: convex/alerts.ts, convex/backups.ts, convex/memberships.ts,
 *   convex/recordsDate.ts, convex/schema.ts, src/data/demo.ts (fixture).
 */
import { convexTest } from "convex-test";
import { afterEach, expect, it, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import { recordsDate } from "./recordsDate";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const demo = demoSnapshot();
    await ctx.db.insert("programs", demo.programs![0]);
    await ctx.db.insert("programs", {
      ...demo.programs![0],
      uuid: "other-program",
      name: "Other",
    });
    const [ours, theirs] = demo.aircraft;
    await ctx.db.insert("aircraft", ours);
    await ctx.db.insert("aircraft", {
      ...theirs,
      programUuid: "other-program",
    });
    for (const a of [ours, theirs])
      await ctx.db.insert("inspections", {
        uuid: "insp-" + a.uuid,
        aircraftUuid: a.uuid,
        reference: "Annual " + a.registration,
        description: "Calendar inspection",
        dueDate: "2000-01-01",
      });
    async function member(name: string, programUuid: string, admin: boolean) {
      const groupId = await ctx.db.insert("groups", {
        programUuid,
        name: name + " group",
        programAdmin: admin,
        aircraftIds: [],
        permissions: ["read"],
      });
      const userId = await ctx.db.insert("users", {
        active: true,
        isAdmin: false,
        name,
        email: name + "@example.test",
        groupIds: [groupId],
        activeProgramUuid: programUuid,
      });
      const session = await ctx.db.insert("authSessions", {
        userId,
        expirationTime: Date.now() + DAY_MS,
      });
      return { userId, identity: { subject: `${userId}|${session}` } };
    }
    return {
      a: await member("admin", "demo-program", true),
      reader: await member("reader", "demo-program", false),
      b: await member("other", "other-program", true),
    };
  });
  // Accounts inserted directly predate the memberships index; backfill it.
  await t.mutation(internal.memberships.backfill, {});
  return {
    t,
    ids,
    a: t.withIdentity(ids.a.identity),
    reader: t.withIdentity(ids.reader.identity),
    b: t.withIdentity(ids.b.identity),
  };
}
const demo = { programUuid: "demo-program" };

it("keeps alert read state per user and per program", async () => {
  const { t, a, reader, b } = await setup();
  await a.mutation(api.alerts.markRead, { ...demo, keys: ["k1", "k1", "k2"] });
  expect((await a.query(api.alerts.readKeys, demo)).sort()).toEqual([
    "k1",
    "k2",
  ]);
  expect(await reader.query(api.alerts.readKeys, demo)).toEqual([]);
  expect(
    await b.query(api.alerts.readKeys, { programUuid: "other-program" }),
  ).toEqual([]);
  await expect(b.query(api.alerts.readKeys, demo)).rejects.toThrow();
  await expect(
    b.mutation(api.alerts.markRead, { ...demo, keys: ["x"] }),
  ).rejects.toThrow();
  await expect(t.query(api.alerts.readKeys, demo)).rejects.toThrow();
  await expect(
    a.mutation(api.alerts.markRead, { ...demo, keys: ["x".repeat(301)] }),
  ).rejects.toThrow(/invalid alerts/);
  // Marking all read replaces the set, dropping alerts that have cleared.
  await a.mutation(api.alerts.markRead, {
    ...demo,
    keys: ["k2", "k3"],
    all: true,
  });
  expect((await a.query(api.alerts.readKeys, demo)).sort()).toEqual([
    "k2",
    "k3",
  ]);
  // Forgetting the marks of cleared alerts drops only the caller's own.
  await reader.mutation(api.alerts.markRead, { ...demo, keys: ["k2"] });
  await a.mutation(api.alerts.forgetRead, { ...demo, keys: ["k2", "never"] });
  expect(await a.query(api.alerts.readKeys, demo)).toEqual(["k3"]);
  expect(await reader.query(api.alerts.readKeys, demo)).toEqual(["k2"]);
  await expect(
    b.mutation(api.alerts.forgetRead, { ...demo, keys: ["k3"] }),
  ).rejects.toThrow();
  await expect(
    a.mutation(api.alerts.forgetRead, { ...demo, keys: [""] }),
  ).rejects.toThrow(/invalid alerts/);
});

it("tells signed-in members whether alert email is set up", async () => {
  const { t, reader } = await setup();
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("RESEND_FROM", "");
  expect(await reader.query(api.alerts.emailEnabled, {})).toBe(false);
  vi.stubEnv("RESEND_FROM", "Angel One <alerts@example.test>");
  expect(await reader.query(api.alerts.emailEnabled, {})).toBe(true);
  vi.stubEnv("RESEND_API_KEY", "");
  expect(await reader.query(api.alerts.emailEnabled, {})).toBe(false);
  await expect(t.query(api.alerts.emailEnabled, {})).rejects.toThrow(
    "An active account and session are required.",
  );
});

it("refuses an invalid set of alert keys as a ConvexError", async () => {
  const { a } = await setup();
  const refused = {
    name: "ConvexError",
    data: "Too many or invalid alerts to update. Reload and retry.",
  };
  for (const keys of [
    Array.from({ length: 501 }, (_, i) => `k${i}`),
    [""],
    ["x".repeat(301)],
  ])
    await expect(
      a.mutation(api.alerts.markRead, { ...demo, keys }),
      `${keys.length} keys`,
    ).rejects.toMatchObject(refused);
  await a.mutation(api.alerts.markRead, {
    ...demo,
    keys: [...Array.from({ length: 499 }, (_, i) => `k${i}`), "x".repeat(300)],
  });
  expect(await a.query(api.alerts.readKeys, demo)).toHaveLength(500);
});

function stubResend(status = 200) {
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("RESEND_FROM", "Angel One <alerts@example.test>");
  vi.stubEnv("SITE_URL", "https://app.example.test");
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(
      async () => new Response(JSON.stringify({ id: "1" }), { status }),
    );
  vi.stubGlobal("fetch", request);
  return request;
}
const deliveries = (t: Awaited<ReturnType<typeof setup>>["t"]) =>
  t.run((ctx) => ctx.db.query("alertDeliveries").collect());

it("emails one digest per opted-in member, scoped to their program, without resending", async () => {
  const { t, ids, reader } = await setup();
  const request = stubResend();
  const result = await t.action(internal.alerts.sendDigests, {});
  // Program admins default on; the reader has not opted in.
  expect(result).toEqual({ sent: 2, failed: 0, skipped: false });
  expect(request).toHaveBeenCalledTimes(2);
  const bodies = request.mock.calls.map(([url, init]) => {
    expect(url).toBe("https://api.resend.com/emails");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer re_test",
    );
    return JSON.parse(String(init?.body));
  });
  const ours = bodies.find((b) => b.to[0] === "admin@example.test")!;
  expect(ours.from).toBe("Angel One <alerts@example.test>");
  // The overdue item also grounds the aircraft, adding its summary alert.
  expect(ours.subject).toBe("Mission operations: 2 maintenance alerts");
  expect(ours.html).toContain("Annual N206MA");
  expect(ours.html).toContain('href="https://app.example.test/inspections"');
  expect(ours.html).not.toContain("N208MA");
  expect(ours.text).toContain("Annual N206MA");
  const theirs = bodies.find((b) => b.to[0] === "other@example.test")!;
  expect(theirs.html).toContain("N208MA");
  expect(theirs.html).not.toContain("N206MA");
  // Two alerts (overdue item + grounded summary) for each of two recipients.
  expect(await deliveries(t)).toHaveLength(4);

  // Nothing new: no second email.
  expect(await t.action(internal.alerts.sendDigests, {})).toMatchObject({
    sent: 0,
  });
  expect(request).toHaveBeenCalledTimes(2);

  // Opting in sends the reader only their own pending alerts.
  await reader.mutation(api.alerts.setEmailPreference, { enabled: true });
  expect(await t.action(internal.alerts.sendDigests, {})).toMatchObject({
    sent: 1,
  });
  expect(JSON.parse(String(request.mock.calls[2][1]?.body)).to).toEqual([
    "reader@example.test",
  ]);
  const stored = await deliveries(t);
  expect(stored.filter((d) => d.userId === ids.reader.userId)).toHaveLength(2);
});

it("honours opting out", async () => {
  const { t, a } = await setup();
  const request = stubResend();
  await a.mutation(api.alerts.setEmailPreference, { enabled: false });
  expect(await t.action(internal.alerts.sendDigests, {})).toMatchObject({
    sent: 1,
  });
  expect(JSON.parse(String(request.mock.calls[0][1]?.body)).to).toEqual([
    "other@example.test",
  ]);
});

it("skips email without configuration and records nothing on provider failure", async () => {
  const { t, ids } = await setup();
  const request = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", request);
  vi.stubEnv("RESEND_API_KEY", "");
  expect(await t.action(internal.alerts.sendDigests, {})).toEqual({
    sent: 0,
    failed: 0,
    skipped: true,
  });
  expect(request).not.toHaveBeenCalled();

  const failing = stubResend(503);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await t.action(internal.alerts.sendDigests, {})).toEqual({
    sent: 0,
    failed: 2,
    skipped: false,
  });
  expect(failing).toHaveBeenCalledTimes(2);
  expect(await deliveries(t)).toEqual([]);
  expect(error).toHaveBeenCalledWith(
    "Alert digest not sent",
    ids.a.userId,
    "Email provider rejected the request (503).",
  );
  expect(JSON.stringify(error.mock.calls)).not.toContain("@example.test");
  error.mockRestore();
});

// The off-site backup warning (ADR-0008) goes only to system administrators
// whose alert email is on; program members and program admins never get it.
async function systemAdmins(t: Awaited<ReturnType<typeof setup>>["t"]) {
  const ids = await t.run(async (ctx) => {
    const groupId = await ctx.db.insert("groups", {
      programUuid: "demo-program",
      name: "System admins in the program",
      programAdmin: true,
      aircraftIds: [],
      permissions: ["read"],
    });
    const user = (name: string, extra: object) =>
      ctx.db.insert("users", {
        active: true,
        isAdmin: true,
        name,
        email: name + "@example.test",
        groupIds: [],
        activeProgramUuid: "demo-program",
        ...extra,
      });
    return {
      // Program admin of its active program: alert email on by default.
      member: await user("sys-member", { groupIds: [groupId] }),
      // In no program: alert email on only because it was turned on.
      optedIn: await user("sys-opted-in", { emailAlerts: true }),
      // The switch shows off (never turned on), or it was turned off.
      unset: await user("sys-unset", {}),
      optedOut: await user("sys-opted-out", {
        groupIds: [groupId],
        emailAlerts: false,
      }),
    };
  });
  await t.mutation(internal.memberships.backfill, {});
  return ids;
}
const recordCopy = (
  t: Awaited<ReturnType<typeof setup>>["t"],
  completedAt: number,
) =>
  t.mutation(internal.backups.recordOffsiteCopy, {
    completedAt,
    objectKey: "daily/2026/11/04/angelone-20261104T084112Z.zip.age",
    bytes: 1000,
    sha256: "0".repeat(64),
    envUploaded: true,
  });
const emails = (request: ReturnType<typeof stubResend>) =>
  new Map(
    request.mock.calls.map(([, init]) => {
      const body = JSON.parse(String(init?.body));
      return [body.to[0] as string, body];
    }),
  );

it("warns system administrators when no off-site backup is recorded, and nobody else", async () => {
  const { t, reader } = await setup();
  await systemAdmins(t);
  await reader.mutation(api.alerts.setEmailPreference, { enabled: true });
  const request = stubResend();
  expect(await t.action(internal.alerts.sendDigests, {})).toEqual({
    sent: 5,
    failed: 0,
    skipped: false,
  });
  const sent = emails(request);
  expect([...sent.keys()].sort()).toEqual([
    "admin@example.test",
    "other@example.test",
    "reader@example.test",
    "sys-member@example.test",
    "sys-opted-in@example.test",
  ]);
  const warning = "No off-site backup has been recorded yet.";
  // At the top of the digest a system administrator gets anyway...
  const member = sent.get("sys-member@example.test");
  expect(member.subject).toBe("Mission operations: 2 maintenance alerts");
  expect(member.text.startsWith(`Off-site backups: ${warning}\n`)).toBe(true);
  expect(member.html).toMatch(/^<p><strong>Off-site backups:<\/strong> No /);
  expect(member.html).toContain("Annual N206MA");
  // ...or on its own when they have no maintenance alerts.
  const optedIn = sent.get("sys-opted-in@example.test");
  expect(optedIn.subject).toBe("Off-site backup warning");
  expect(optedIn.text).toContain(warning);
  expect(optedIn.html).toContain(
    'href="https://app.example.test/settings#system"',
  );
  for (const to of [
    "admin@example.test",
    "other@example.test",
    "reader@example.test",
  ]) {
    expect(sent.get(to).html).not.toContain("Off-site");
    expect(sent.get(to).text).not.toContain("Off-site");
  }
});

it("warns system administrators every day while the newest copy is stale", async () => {
  const { t } = await setup();
  await systemAdmins(t);
  await recordCopy(t, Date.now() - 37 * HOUR_MS);
  const request = stubResend();
  expect(await t.action(internal.alerts.sendDigests, {})).toMatchObject({
    sent: 4,
    failed: 0,
  });
  const first = emails(request);
  const warning =
    "No off-site backup for 37 hours. Check the Nightly backup job in GitHub Actions.";
  expect(first.get("sys-member@example.test").text).toContain(warning);
  expect(first.get("sys-opted-in@example.test").text).toContain(warning);
  expect(first.get("admin@example.test").text).not.toContain("Off-site");
  expect(first.get("other@example.test").text).not.toContain("Off-site");
  // The next run has no new maintenance alerts, so the warning comes alone,
  // and only to the system administrators.
  request.mockClear();
  expect(await t.action(internal.alerts.sendDigests, {})).toMatchObject({
    sent: 2,
  });
  const second = emails(request);
  expect([...second.keys()].sort()).toEqual([
    "sys-member@example.test",
    "sys-opted-in@example.test",
  ]);
  for (const email of second.values()) {
    expect(email.subject).toBe("Off-site backup warning");
    expect(email.text).toContain(warning);
  }
});

it("sends no backup warning while the newest copy is fresh", async () => {
  const { t } = await setup();
  await systemAdmins(t);
  await recordCopy(t, Date.now() - 2 * HOUR_MS);
  const request = stubResend();
  expect(await t.action(internal.alerts.sendDigests, {})).toMatchObject({
    sent: 3,
    failed: 0,
  });
  const sent = emails(request);
  expect([...sent.keys()].sort()).toEqual([
    "admin@example.test",
    "other@example.test",
    "sys-member@example.test",
  ]);
  for (const email of sent.values()) {
    expect(email.html).not.toContain("Off-site");
    expect(email.text).not.toContain("Off-site");
  }
});

it("forgets the deliveries of cleared alerts only, one program at a time", async () => {
  const { t, ids } = await setup();
  stubResend();
  await t.action(internal.alerts.sendDigests, {});
  const keysOf = async (userId: string) =>
    (await deliveries(t)).filter((d) => d.userId === userId).map((d) => d.key);
  const forget = () => t.mutation(internal.alerts.forgetCleared, demo);
  // Nothing has cleared: the rows stay, so nothing is emailed twice.
  expect(await forget()).toEqual({ today: recordsDate() });
  expect(await keysOf(ids.a.userId)).toHaveLength(2);
  await t.run(async (ctx) => {
    for (const i of await ctx.db.query("inspections").collect())
      await ctx.db.patch(i._id, { dueDate: "2999-01-01" });
  });
  await forget();
  expect(await keysOf(ids.a.userId)).toEqual([]);
  expect(await keysOf(ids.b.userId)).toHaveLength(2);
});

it("goes on with the other programs' digests when one program's alerts cannot be computed", async () => {
  const { t, ids } = await setup();
  await t.run((ctx) =>
    ctx.db.insert("expiringItems", {
      uuid: "55555555-5555-4555-8555-555555555555",
      programUuid: "demo-program",
      payload: JSON.stringify({ label: "An older shape" }),
    }),
  );
  const request = stubResend();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await t.action(internal.alerts.sendDigests, {})).toMatchObject({
    sent: 1,
    failed: 0,
  });
  expect(
    request.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).to),
  ).toEqual([["other@example.test"]]);
  expect(error).toHaveBeenCalledWith(
    "Alert digest skipped for a Flight Program",
    "demo-program",
    expect.any(String),
  );
  expect(JSON.stringify(error.mock.calls)).not.toContain(String(ids.a.userId));
  error.mockRestore();
});
