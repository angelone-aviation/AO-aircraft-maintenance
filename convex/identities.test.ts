/**
 * Responsibility: Pins how a Google or Microsoft refusal is carried and
 *   logged: refusalOf, the "ambiguous" refusal and the refusal-log caps.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/identities, convex/rateLimits, convex/schema.
 */
import { convexTest } from "convex-test";
import { afterEach, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import schema from "./schema";
import { internal } from "./_generated/api";
import { refusalOf, userForIdentity } from "./identities";
import { HOUR } from "./rateLimits";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);

afterEach(() => vi.useRealTimers());

it("reads a refusal only from the sign-in's own ConvexError", async () => {
  expect(refusalOf(new Error("ambiguous"))).toBeUndefined();
  expect(refusalOf(new ConvexError("ambiguous"))).toBeUndefined();
  expect(refusalOf(new ConvexError({ code: "other" }))).toBeUndefined();
  const t = convexTest(schema, modules);
  const error = await t
    .run(async (ctx) => {
      for (const name of ["One", "Two"])
        await ctx.db.insert("users", {
          name,
          email: "shared@example.test",
          active: true,
        });
      return userForIdentity(ctx, "google", null, {
        email: " Shared@Example.TEST ",
        emailVerified: true,
      });
    })
    .catch((e: unknown) => e);
  expect(refusalOf(error)).toEqual({ reason: "ambiguous", userId: undefined });
});

it("logs at most 10 refusals an hour for one identity", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-03T10:30:00Z"));
  const t = convexTest(schema, modules);
  const refusal = {
    provider: "google",
    providerAccountId: "123",
    reason: "no_account",
  };
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  for (let i = 0; i < 11; i++)
    await t.mutation(internal.identities.recordRefusal, refusal);
  const entries = await t.run((ctx) => ctx.db.query("audit").collect());
  expect(entries).toHaveLength(10);
  expect(entries[0]).toMatchObject({
    actorId: "system",
    action: "user.sign_in_refused",
    entityUuid: "google:123",
  });
  expect(log).toHaveBeenCalledTimes(1);
  log.mockRestore();
});

it("logs at most 300 refusals an hour for the deployment", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-03T10:30:00Z"));
  const t = convexTest(schema, modules);
  const now = Date.now();
  await t.run((ctx) =>
    ctx.db.insert("rateLimits", {
      key: "sso-refused",
      windowStart: now - (now % HOUR),
      count: 300,
    }),
  );
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  await t.mutation(internal.identities.recordRefusal, {
    provider: "microsoft-entra-id",
    providerAccountId: "456",
    reason: "disabled",
  });
  expect(await t.run((ctx) => ctx.db.query("audit").collect())).toEqual([]);
  expect(log).toHaveBeenCalledTimes(1);
  log.mockRestore();
  // Characterizes current behaviour (roadmap Finding 18): the identity's own
  // count is still spent when the deployment cap refuses.
  expect(
    await t.run((ctx) =>
      ctx.db
        .query("rateLimits")
        .withIndex("key", (q) =>
          q.eq("key", "sso-refused:microsoft-entra-id:456"),
        )
        .unique(),
    ),
  ).toMatchObject({ count: 1 });
});
