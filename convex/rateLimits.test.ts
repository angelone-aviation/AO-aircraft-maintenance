/**
 * Responsibility: Pins the rate-limit counter: epoch-aligned windows, a
 *   refusal that records nothing, multi-use costs, and refunds that stay in
 *   their window and never go below zero.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/rateLimits.ts, convex/schema.ts.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import schema from "./schema";
import { consume, DAY, HOUR, refund } from "./rateLimits";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);

const KEY = "email:program-1";
const REFUSAL = "Too many emails today.";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-03T23:59:00Z"));
});
afterEach(() => vi.useRealTimers());

function world() {
  const t = convexTest(schema, modules);
  return {
    use: (limit: number, cost?: number) =>
      t.run((ctx) => consume(ctx, KEY, limit, DAY, REFUSAL, cost)),
    giveBack: (cost?: number, windowMs = DAY) =>
      t.run((ctx) => refund(ctx, KEY, windowMs, cost)),
    rows: () => t.run((ctx) => ctx.db.query("rateLimits").collect()),
  };
}

it("refuses the use past the limit with the caller's message, recording nothing", async () => {
  const w = world();
  await w.use(2);
  await w.use(2);
  await expect(w.use(2)).rejects.toThrow(REFUSAL);
  expect(await w.rows()).toEqual([
    expect.objectContaining({ key: KEY, count: 2 }),
  ]);
});

it("counts a multi-use call whole, and refuses it whole when it would pass the limit", async () => {
  const w = world();
  await w.use(5, 3);
  await expect(w.use(5, 3)).rejects.toThrow(REFUSAL);
  await w.use(5, 2);
  expect((await w.rows())[0].count).toBe(5);
});

it("starts a DAY window at 00:00 UTC, whatever time the first use came", async () => {
  const w = world();
  await w.use(1);
  expect((await w.rows())[0].windowStart).toBe(
    Date.parse("2026-11-03T00:00:00Z"),
  );
  await expect(w.use(1)).rejects.toThrow(REFUSAL);
  vi.setSystemTime(new Date("2026-11-04T00:00:00Z"));
  await w.use(1);
  expect(await w.rows()).toEqual([
    expect.objectContaining({
      windowStart: Date.parse("2026-11-04T00:00:00Z"),
      count: 1,
    }),
  ]);
});

it("gives back a use in the same window, never below zero", async () => {
  const w = world();
  await w.use(1);
  await w.giveBack();
  await w.use(1);
  await w.giveBack(5);
  expect((await w.rows())[0].count).toBe(0);
});

it("ignores a refund once the window has rolled over, or for a key never used", async () => {
  const w = world();
  await w.giveBack();
  expect(await w.rows()).toEqual([]);
  await w.use(3, 2);
  vi.setSystemTime(new Date("2026-11-04T00:00:01Z"));
  await w.giveBack();
  expect((await w.rows())[0].count).toBe(2);
});

it("judges the refund's window by the length the caller passes", async () => {
  const w = world();
  await w.use(3, 2);
  // The DAY window began at midnight; the HOUR window now began at 23:00.
  await w.giveBack(1, HOUR);
  expect((await w.rows())[0].count).toBe(2);
});
