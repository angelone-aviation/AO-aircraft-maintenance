/**
 * Responsibility: Pins the FAA monitor's refusals and their class, the daily
 *   run's skips, and how a run that cannot be stored ends.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/faa.ts, convex/schema.ts, src/domain/faa.ts,
 *   src/data/demo.ts (fixture).
 */
import { convexTest } from "convex-test";
import { afterEach, expect, it, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import {
  emptyMonitor,
  type FaaCandidate,
  type FaaMonitor,
} from "../src/domain/faa";
import { MAX_ENABLED_FAA_MONITORS } from "./faa";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const aircraft = demoSnapshot().aircraft[0];
const programUuid = aircraft.programUuid!;

afterEach(() => {
  vi.useRealTimers();
});

async function fixture() {
  const t = convexTest(schema, modules);
  const identities = await t.run(async (ctx) => {
    await ctx.db.insert("programs", demoSnapshot().programs![0]);
    await ctx.db.insert("aircraft", aircraft);
    const readers = await ctx.db.insert("groups", {
      programUuid,
      name: "Readers",
      programAdmin: false,
      aircraftIds: [],
      permissions: ["read"],
    });
    const signIn = async (isAdmin: boolean) => {
      const userId = await ctx.db.insert("users", {
        name: isAdmin ? "Admin" : "Reader",
        active: true,
        isAdmin,
        groupIds: isAdmin ? [] : [readers],
        activeProgramUuid: programUuid,
      });
      const session = await ctx.db.insert("authSessions", {
        userId,
        expirationTime: Date.now() + 86400000,
      });
      return { subject: `${userId}|${session}` };
    };
    return { admin: await signIn(true), reader: await signIn(false) };
  });
  const monitor = (uuid: string, fields: Partial<FaaMonitor>) =>
    t.run((ctx) =>
      ctx.db.insert("faaMonitors", {
        aircraftUuid: uuid,
        payload: JSON.stringify({ ...emptyMonitor(uuid), ...fields }),
      }),
    );
  const stored = async (uuid: string): Promise<FaaMonitor> =>
    JSON.parse(
      (await t.run((ctx) =>
        ctx.db
          .query("faaMonitors")
          .withIndex("aircraft", (q) => q.eq("aircraftUuid", uuid))
          .unique(),
      ))!.payload,
    );
  return {
    t,
    monitor,
    stored,
    admin: t.withIdentity(identities.admin),
    reader: t.withIdentity(identities.reader),
  };
}

const candidate = (id: string, status = "Final rule"): FaaCandidate => ({
  id,
  modified: "2026-01-01",
  source: {
    number: "2026-01-01",
    amendment: "",
    issued: "",
    effective: "",
    subject: "",
    recurring: "Unknown",
    supersededBy: "",
    url: "",
    source: "",
    section: "Airframe",
    make: "",
    model: "",
    sourceNotes: "",
  },
  emergency: false,
  status,
  reviewReason: "",
});

// The error a run rejects with.
const refusal = (run: Promise<unknown>) =>
  run.then(
    () => {
      throw new Error("Expected a refusal.");
    },
    (error: unknown) => error,
  );

it("shows the monitor's refusals to the user as ConvexErrors", async () => {
  const { t, monitor, admin, reader } = await fixture();
  await monitor(aircraft.uuid, { lastAttempt: Date.now() - MINUTE / 2 });
  await t.run(async (ctx) => {
    for (let i = 0; i < MAX_ENABLED_FAA_MONITORS; i++)
      await ctx.db.insert("aircraft", {
        ...aircraft,
        uuid: `other-${i}`,
        registration: `N${i}`,
      });
  });
  for (let i = 0; i < MAX_ENABLED_FAA_MONITORS; i++)
    await monitor(`other-${i}`, { enabled: true });
  const send = (as: typeof admin, payload: object) =>
    as.mutation(api.faa.command, {
      payload: JSON.stringify({ aircraftUuid: aircraft.uuid, ...payload }),
      programUuid,
    });
  const configure = { kind: "configure", enabled: true, terms: [] };
  const shown: [string, () => Promise<unknown>][] = [
    [
      "Aircraft maintenance permission required.",
      () => send(reader, configure),
    ],
    [
      `A Flight Program can monitor at most ${MAX_ENABLED_FAA_MONITORS} aircraft daily. Turn off monitoring on another aircraft first.`,
      () => send(admin, configure),
    ],
    [
      "Candidate not found.",
      () => send(admin, { kind: "review", id: "missing", reason: "Checked." }),
    ],
    [
      "Wait one minute before checking again.",
      () => send(admin, { kind: "check" }),
    ],
  ];
  for (const [message, run] of shown)
    expect(await refusal(run()), message).toMatchObject({
      name: "ConvexError",
      data: message,
    });
});

it("starts the daily run on enabled monitors not attempted within the last hour", async () => {
  // Fake timers also keep the scheduled checks from running.
  vi.useFakeTimers();
  const { t, monitor, stored } = await fixture();
  await t.run(async (ctx) => {
    for (const uuid of ["recent", "stale", "never", "disabled"])
      await ctx.db.insert("aircraft", {
        ...aircraft,
        uuid,
        registration: uuid,
      });
  });
  const now = Date.now();
  await monitor("recent", { enabled: true, lastAttempt: now - HOUR + MINUTE });
  await monitor("stale", { enabled: true, lastAttempt: now - HOUR });
  await monitor("never", { enabled: true });
  await monitor("disabled", { lastAttempt: now - 2 * HOUR });
  await t.mutation(internal.faa.daily, {});
  expect(await stored("recent")).toMatchObject({ runId: "" });
  expect(await stored("disabled")).toMatchObject({ runId: "" });
  for (const uuid of ["stale", "never"]) {
    const started = await stored(uuid);
    expect(started, uuid).toMatchObject({
      runId: expect.stringMatching(/./),
      error: "",
    });
    expect(started.lastAttempt, uuid).toBeGreaterThanOrEqual(now);
  }
});

it("keeps the last successful check when a run's results cannot be stored", async () => {
  const { t, monitor, stored } = await fixture();
  const lastSuccess = 1;
  const finish = async (payload: string) => {
    const before = await stored(aircraft.uuid);
    await t.run(async (ctx) => {
      const doc = await ctx.db.query("faaMonitors").first();
      await ctx.db.patch(doc!._id, {
        payload: JSON.stringify({ ...before, runId: "r" }),
      });
    });
    await t.mutation(internal.faa.finish, {
      aircraftUuid: aircraft.uuid,
      runId: "r",
      payload,
      error: "",
      terms: ["441"],
    });
    return stored(aircraft.uuid);
  };
  await monitor(aircraft.uuid, { lastSuccess, candidates: [candidate("old")] });
  expect(
    await finish(JSON.stringify([candidate("big", "x".repeat(800_000))])),
  ).toMatchObject({
    runId: "",
    lastSuccess,
    candidates: [{ id: "old" }],
    error:
      "FAA candidate history exceeds storage limit. Narrow monitoring scope; results were not saved.",
  });
  expect(await finish("not JSON")).toMatchObject({
    lastSuccess,
    candidates: [{ id: "old" }],
    error: expect.stringContaining("JSON"),
  });
  const saved = await finish(JSON.stringify([candidate("new")]));
  expect(saved.lastSuccess).toBeGreaterThan(lastSuccess);
  expect(saved).toMatchObject({
    error: "",
    checkedTerms: ["441"],
    candidates: [{ id: "old" }, { id: "new" }],
  });
});

it("stores what each command changes on the monitor, schedules a started check, and audits the parsed command", async () => {
  // Fake timers also keep the scheduled check from running.
  vi.useFakeTimers();
  const { t, monitor, stored, admin } = await fixture();
  const uuid = aircraft.uuid;
  await monitor(uuid, {
    runId: "earlier",
    error: "Earlier error.",
    lastAttempt: 1,
    candidates: [candidate("c1")],
  });
  const send = (payload: object) =>
    admin.mutation(api.faa.command, {
      payload: JSON.stringify({ aircraftUuid: uuid, ...payload }),
      programUuid,
    });
  await send({ kind: "configure", enabled: false, terms: [" 441 "] });
  expect(await stored(uuid)).toEqual({
    ...emptyMonitor(uuid),
    terms: ["441"],
    lastAttempt: 1,
    error: "Settings changed. Run a check to verify coverage.",
    runId: "",
    candidates: [candidate("c1")],
  });
  const sent = Date.now();
  const since = expect.toSatisfy((at: number) => at >= sent);
  await send({ kind: "review", id: "c1", reason: " Not applicable. " });
  expect((await stored(uuid)).candidates).toEqual([
    { ...candidate("c1"), reviewReason: "Not applicable.", reviewedAt: since },
  ]);
  await send({ kind: "check" });
  const checked = await stored(uuid);
  expect(checked).toMatchObject({
    runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    lastAttempt: since,
    error: "",
  });
  const scheduled = await t.run((ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  expect(scheduled.map((f) => [f.name, f.args])).toEqual([
    [
      expect.stringContaining("check"),
      [{ aircraftUuid: uuid, runId: checked.runId }],
    ],
  ]);
  const rows = await t.run((ctx) => ctx.db.query("audit").collect());
  expect(
    rows.map((r) => [r.action, r.entityUuid, r.aircraftUuid, r.after]),
  ).toEqual([
    [
      "faa.configure",
      uuid,
      uuid,
      JSON.stringify({
        kind: "configure",
        aircraftUuid: uuid,
        enabled: false,
        terms: ["441"],
      }),
    ],
    [
      "faa.review",
      uuid,
      uuid,
      JSON.stringify({
        kind: "review",
        aircraftUuid: uuid,
        id: "c1",
        reason: "Not applicable.",
      }),
    ],
    [
      "faa.check",
      uuid,
      uuid,
      JSON.stringify({ kind: "check", aircraftUuid: uuid }),
    ],
  ]);
});
