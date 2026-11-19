/**
 * Responsibility: Pins FAA AD monitoring runs: targeted queries, the last
 *   successful check kept when a later FAA call fails, the FAA allowances
 *   charged, and the cap on enabled monitors per Flight Program.
 * Layer: Test. convex-test suite with a stubbed FAA DRS; never shipped.
 * Dependencies: convex/faa.ts, convex/faaSearch.ts, convex/faaCredentials.ts,
 *   convex/secrets.ts, convex/schema.ts, src/domain/faa.ts, src/data/demo.ts
 *   (fixture).
 */
import { convexTest } from "convex-test";
import { expect, it, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import { emptyMonitor } from "../src/domain/faa";
import { MAX_ENABLED_FAA_MONITORS } from "../src/domain/faa";
import { FAA_GLOBAL_DAILY } from "./faaSearch";
import { FAA_SECRET } from "./faaCredentials";
import { sealSecret } from "./secrets";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const DAY_MS = 86_400_000;
const CREDENTIALS_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

// The stored FAA key, sealed as saving one seals it.
async function sealedFaaKey() {
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", CREDENTIALS_KEY);
  return sealSecret("synthetic", FAA_SECRET);
}
it("completes targeted monitoring and retains the last successful check when a later FAA call fails", async () => {
  const t = convexTest(schema, modules);
  const aircraft = {
    ...demoSnapshot().aircraft[0],
    model: "C441",
    faaSearchModel: "441",
  };
  const key = await sealedFaaKey();
  const id = await t.run(async (ctx) => {
    await ctx.db.insert("aircraft", aircraft);
    await ctx.db.insert("faaCredentials", {
      key,
      expiresOn: "2099-01-01",
      version: 1,
      updatedAt: 0,
    });
    return ctx.db.insert("faaMonitors", {
      aircraftUuid: aircraft.uuid,
      payload: JSON.stringify({
        ...emptyMonitor(aircraft.uuid),
        runId: "first",
      }),
    });
  });
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.documentFilters.Keyword).toBeUndefined();
      const filters = body.documentFilters;
      expect(
        filters["drs:adfrawdModel"] ?? filters["drs:adfreadModel"],
      ).toEqual(["441"]);
      expect(
        filters["drs:adfrawdProductType"] ?? filters["drs:adfreadProductTypes"],
      ).toEqual(["Aircraft"]);
      return new Response(
        JSON.stringify({ summary: { hasMoreItems: false }, documents: [] }),
      );
    });
  vi.stubGlobal("fetch", request);
  try {
    await t.action(internal.faa.check, {
      aircraftUuid: aircraft.uuid,
      runId: "first",
    });
    const first = await t.run(async (ctx) =>
      JSON.parse((await ctx.db.get(id))!.payload),
    );
    expect(first.lastSuccess).toBeGreaterThan(0);
    expect(first.error).toBe("");
    expect(request).toHaveBeenCalledTimes(2);
    await t.run(async (ctx) =>
      ctx.db.patch(id, {
        payload: JSON.stringify({ ...first, runId: "second" }),
      }),
    );
    request.mockResolvedValue(new Response("Failure", { status: 503 }));
    await t.action(internal.faa.check, {
      aircraftUuid: aircraft.uuid,
      runId: "second",
    });
    const second = await t.run(async (ctx) =>
      JSON.parse((await ctx.db.get(id))!.payload),
    );
    expect(second.lastSuccess).toBe(first.lastSuccess);
    expect(second.error).toContain("Aircraft 441");
    expect(second.error).toContain("503");
  } finally {
    vi.unstubAllGlobals();
  }
});
/**
 * Seeds the demo program and aircraft (model 441), a saved FAA key and a
 * system administrator.
 */
async function monitorSetup() {
  const t = convexTest(schema, modules);
  const aircraft = {
    ...demoSnapshot().aircraft[0],
    model: "C441",
    faaSearchModel: "441",
  };
  const key = await sealedFaaKey();
  const identity = await t.run(async (ctx) => {
    await ctx.db.insert("programs", demoSnapshot().programs![0]);
    await ctx.db.insert("aircraft", aircraft);
    await ctx.db.insert("faaCredentials", {
      key,
      expiresOn: "2099-01-01",
      version: 1,
      updatedAt: 0,
    });
    const userId = await ctx.db.insert("users", {
      name: "Admin",
      active: true,
      isAdmin: true,
      groupIds: [],
    });
    const session = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + DAY_MS,
    });
    return { subject: `${userId}|${session}` };
  });
  return { t, aircraft, admin: t.withIdentity(identity) };
}
it("charges monitoring runs to the program and global FAA allowances", async () => {
  const { t, aircraft } = await monitorSetup();
  const id = await t.run((ctx) =>
    ctx.db.insert("faaMonitors", {
      aircraftUuid: aircraft.uuid,
      payload: JSON.stringify({ ...emptyMonitor(aircraft.uuid), runId: "a" }),
    }),
  );
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ summary: { hasMoreItems: false }, documents: [] }),
        ),
    );
  vi.stubGlobal("fetch", request);
  const counts = () =>
    t.run(async (ctx) =>
      Object.fromEntries(
        (await ctx.db.query("rateLimits").collect()).map((r) => [
          r.key,
          r.count,
        ]),
      ),
    );
  try {
    await t.action(internal.faa.check, {
      aircraftUuid: aircraft.uuid,
      runId: "a",
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(await counts()).toEqual({
      "faa:program:demo-program": 2,
      "faa:global": 2,
    });
    // An exhausted program allowance stops the run before calling the FAA;
    // the only program's share is the whole day.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("rateLimits")
        .withIndex("key", (q) => q.eq("key", "faa:program:demo-program"))
        .unique();
      await ctx.db.patch(row!._id, { count: FAA_GLOBAL_DAILY - 1 });
      const doc = (await ctx.db.get(id))!;
      await ctx.db.patch(id, {
        payload: JSON.stringify({ ...JSON.parse(doc.payload), runId: "b" }),
      });
    });
    await t.action(internal.faa.check, {
      aircraftUuid: aircraft.uuid,
      runId: "b",
    });
    expect(request).toHaveBeenCalledTimes(2);
    const monitor = await t.run(async (ctx) =>
      JSON.parse((await ctx.db.get(id))!.payload),
    );
    expect(monitor.error).toMatch(/FAA search allowance/);
    expect((await counts())["faa:global"]).toBe(2);
  } finally {
    vi.unstubAllGlobals();
  }
});
it("caps enabled FAA monitors per Flight Program", async () => {
  const { t, aircraft, admin } = await monitorSetup();
  await t.run(async (ctx) => {
    for (let i = 0; i < MAX_ENABLED_FAA_MONITORS; i++) {
      const uuid = `other-${i}`;
      await ctx.db.insert("aircraft", {
        ...aircraft,
        uuid,
        registration: `N${i}`,
      });
      await ctx.db.insert("faaMonitors", {
        aircraftUuid: uuid,
        payload: JSON.stringify({ ...emptyMonitor(uuid), enabled: true }),
      });
    }
  });
  const configure = (enabled: boolean) =>
    admin.mutation(api.faa.command, {
      payload: JSON.stringify({
        kind: "configure",
        aircraftUuid: aircraft.uuid,
        enabled,
        terms: [],
      }),
      programUuid: "demo-program",
    });
  await expect(configure(true)).rejects.toThrow(
    `at most ${MAX_ENABLED_FAA_MONITORS} aircraft`,
  );
  // Saving settings with monitoring off is still allowed.
  await configure(false);
  await t.run(async (ctx) => {
    const doc = await ctx.db
      .query("faaMonitors")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", "other-0"))
      .unique();
    await ctx.db.patch(doc!._id, {
      payload: JSON.stringify(emptyMonitor("other-0")),
    });
  });
  await configure(true);
  // Re-saving an already enabled monitor at the cap is allowed.
  await configure(true);
});
