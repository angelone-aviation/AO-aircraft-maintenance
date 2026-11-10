/**
 * Responsibility: Pins how an FAA monitor check ends without searching: a key
 *   at its renewal date (judged on the records date), no key at all, and a
 *   run the monitor no longer expects.
 * Layer: Test. convex-test suite with a stubbed FAA DRS; never shipped.
 * Dependencies: convex/faa.ts, convex/faaCredentials.ts, convex/secrets.ts,
 *   convex/schema.ts, src/domain/faa.ts, src/data/demo.ts (fixture).
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import { emptyMonitor, type FaaMonitor } from "../src/domain/faa";
import { FAA_SECRET } from "./faaCredentials";
import { sealSecret } from "./secrets";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);

const CREDENTIALS_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const RUN = "run-1";
const LAST_SUCCESS = 1;
// 21:00 on 3 November in the records time zone (US Eastern), already
// 4 November in UTC.
const EVENING = new Date("2026-11-04T02:00:00Z");
const RENEWAL_REACHED =
  "FAA API key has reached its renewal date. Ask an administrator to update it in FAA key settings.";
const aircraft = { ...demoSnapshot().aircraft[0], faaSearchModel: "441" };

const request = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(EVENING);
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", CREDENTIALS_KEY);
  vi.stubEnv("FAA_DRS_API_KEY", "");
  request.mockReset();
  request.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({ summary: { hasMoreItems: false }, documents: [] }),
      ),
  );
  vi.stubGlobal("fetch", request);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("ends the check with the renewal message from the records date the key expires, before any FAA request", async () => {
  const w = await world({ expiresOn: "2026-11-03" });
  await w.check();
  expect(await w.monitor()).toMatchObject({
    runId: "",
    error: RENEWAL_REACHED,
    lastSuccess: LAST_SUCCESS,
  });
  expect(request).not.toHaveBeenCalled();
  expect(await w.allowanceRows()).toEqual([]);
});

it("still searches on the evening before the renewal date, though UTC has reached it", async () => {
  const w = await world({ expiresOn: "2026-11-04" });
  await w.check();
  const m = await w.monitor();
  expect(m.error).toBe("");
  expect(m.lastSuccess).toBeGreaterThan(LAST_SUCCESS);
  expect(request).toHaveBeenCalled();
});

it("ends the check as not configured when no key is saved or set", async () => {
  const w = await world(undefined);
  await w.check();
  expect(await w.monitor()).toMatchObject({
    runId: "",
    error:
      "FAA DRS is not configured. Set FAA_DRS_API_KEY in the backend environment.",
    lastSuccess: LAST_SUCCESS,
  });
  expect(request).not.toHaveBeenCalled();
});

it("ignores a check and its result for a run the monitor no longer expects", async () => {
  const w = await world({ expiresOn: "2099-01-01" });
  const before = await w.monitor();
  await w.t.action(internal.faa.check, {
    aircraftUuid: aircraft.uuid,
    runId: "superseded",
  });
  await w.t.mutation(internal.faa.finish, {
    aircraftUuid: aircraft.uuid,
    runId: "superseded",
    payload: "[]",
    error: "Late failure",
    terms: [],
  });
  expect(await w.monitor()).toEqual(before);
  expect(request).not.toHaveBeenCalled();
});

it("does nothing for a check whose aircraft has been deleted", async () => {
  const w = await world({ expiresOn: "2099-01-01" });
  await w.t.run(async (ctx) => {
    const doc = await ctx.db.query("aircraft").first();
    if (doc) await ctx.db.delete(doc._id);
  });
  const before = await w.monitor();
  await w.check();
  expect(await w.monitor()).toEqual(before);
  expect(request).not.toHaveBeenCalled();
});

// Seeds the aircraft, a monitor waiting for RUN, and the saved key (none
// when `credential` is undefined).
async function world(credential: { expiresOn: string } | undefined) {
  const t = convexTest(schema, modules);
  const key = credential && (await sealSecret("synthetic", FAA_SECRET));
  await t.run(async (ctx) => {
    await ctx.db.insert("programs", demoSnapshot().programs![0]);
    await ctx.db.insert("aircraft", aircraft);
    await ctx.db.insert("faaMonitors", {
      aircraftUuid: aircraft.uuid,
      payload: JSON.stringify({
        ...emptyMonitor(aircraft.uuid),
        enabled: true,
        runId: RUN,
        lastSuccess: LAST_SUCCESS,
      }),
    });
    if (key && credential)
      await ctx.db.insert("faaCredentials", {
        key,
        expiresOn: credential.expiresOn,
        version: 1,
        updatedAt: 0,
      });
  });
  return {
    t,
    check: () =>
      t.action(internal.faa.check, { aircraftUuid: aircraft.uuid, runId: RUN }),
    monitor: async (): Promise<FaaMonitor> =>
      JSON.parse(
        (await t.run((ctx) => ctx.db.query("faaMonitors").first()))!.payload,
      ),
    allowanceRows: () => t.run((ctx) => ctx.db.query("rateLimits").collect()),
  };
}
