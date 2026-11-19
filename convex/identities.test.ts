/**
 * Responsibility: Pins how a Google or Microsoft refusal is carried and
 *   logged: refusalOf, the "ambiguous" refusal and the refusal-log caps.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/identities, convex/rateLimits, convex/schema.
 */
import { convexTest, type TestConvex } from "convex-test";
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
  await fillAllowance(t, "sso-refused", 300);
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  await t.mutation(internal.identities.recordRefusal, {
    provider: "microsoft-entra-id",
    providerAccountId: "456",
    reason: "disabled",
  });
  expect(await t.run((ctx) => ctx.db.query("audit").collect())).toEqual([]);
  expect(log).toHaveBeenCalledTimes(1);
  log.mockRestore();
});

// Roadmap Finding 18: a refusal one cap drops must not spend the other's
// allowance, or an identity stops being logged earlier than its cap says.
it("spends neither cap on a refusal that one of them drops", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-03T10:30:00Z"));
  const t = convexTest(schema, modules);
  const identity = "sso-refused:google:789";
  const refusal = {
    provider: "google",
    providerAccountId: "789",
    reason: "no_account",
  };
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  await fillAllowance(t, "sso-refused", 300);
  await t.mutation(internal.identities.recordRefusal, refusal);
  expect(await countOf(t, identity)).toBe(0);
  await fillAllowance(t, "sso-refused", 0);
  await fillAllowance(t, identity, 10);
  await t.mutation(internal.identities.recordRefusal, refusal);
  expect(await countOf(t, "sso-refused")).toBe(0);
  expect(log).toHaveBeenCalledTimes(2);
  log.mockRestore();
});

// Sets a rate-limit key's count for the current hour.
async function fillAllowance(
  t: TestConvex<typeof schema>,
  key: string,
  count: number,
) {
  const now = Date.now();
  const windowStart = now - (now % HOUR);
  await t.run(async (ctx) => {
    const row = await ctx.db
      .query("rateLimits")
      .withIndex("key", (q) => q.eq("key", key))
      .unique();
    if (row) await ctx.db.patch(row._id, { windowStart, count });
    else await ctx.db.insert("rateLimits", { key, windowStart, count });
  });
}

async function countOf(t: TestConvex<typeof schema>, key: string) {
  const row = await t.run((ctx) =>
    ctx.db
      .query("rateLimits")
      .withIndex("key", (q) => q.eq("key", key))
      .unique(),
  );
  return row?.count ?? 0;
}
