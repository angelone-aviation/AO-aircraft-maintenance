import { convexTest } from "convex-test";
import { it, expect, vi, afterEach } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
afterEach(() => vi.unstubAllGlobals());
it("protects the key, authorizes lookups, and rate-limits them without saving contact information", async () => {
  const t = convexTest(schema, modules);
  const identities = await t.run(async (ctx) => {
    const s = demoSnapshot();
    await ctx.db.insert("programs", s.programs![0]);
    const make = async (isAdmin: boolean) => {
      const userId = await ctx.db.insert("users", {
        name: "User",
        active: true,
        isAdmin,
        groupIds: [],
      });
      const session = await ctx.db.insert("authSessions", {
        userId,
        expirationTime: Date.now() + 86400000,
      });
      return { subject: `${userId}|${session}` };
    };
    return { admin: await make(true), other: await make(false) };
  });
  const admin = t.withIdentity(identities.admin),
    other = t.withIdentity(identities.other);
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ results: [] })));
  vi.stubGlobal("fetch", fetcher);
  await expect(
    other.action(api.addressVerification.setKey, {
      key: "test-key-that-is-long-enough",
      version: 0,
    }),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  // Test server persistence separately from the provider; lookups use the action below.
  await admin.mutation(internal.addressVerification.commit, {
    key: "test-key-that-is-long-enough",
    version: 0,
  });
  const status = await admin.query(api.addressVerification.status, {});
  expect(status).toEqual({ configured: true, version: 1 });
  const input = {
    street: "1600 Pennsylvania Avenue NW",
    city: "Washington",
    region: "DC",
    postalCode: "20500",
    country: "United States",
    email: "private@example.com",
    phone: "5555555555",
  };
  expect(
    await admin.action(api.addressVerification.lookup, {
      payload: JSON.stringify(input),
      programUuid: "demo-program",
    }),
  ).toEqual([]);
  expect(String(fetcher.mock.calls[0][0])).not.toContain("private");
  await expect(
    admin.action(api.addressVerification.lookup, {
      payload: JSON.stringify(input),
      programUuid: "demo-program",
    }),
  ).rejects.toThrow(/wait a second/);
  const audit = await t.run((ctx) => ctx.db.query("audit").collect());
  expect(JSON.stringify(audit)).not.toContain("test-key");
  await expect(
    other.query(api.addressVerification.status, {}),
  ).rejects.toThrow();
});
it("paces lookups per user so one user cannot block the others", async () => {
  const t = convexTest(schema, modules);
  const [first, second] = await t.run(async (ctx) => {
    await ctx.db.insert("programs", demoSnapshot().programs![0]);
    const make = async () => {
      const userId = await ctx.db.insert("users", {
        name: "Admin",
        active: true,
        isAdmin: true,
        groupIds: [],
      });
      const session = await ctx.db.insert("authSessions", {
        userId,
        expirationTime: Date.now() + 86400000,
      });
      return { subject: `${userId}|${session}` };
    };
    return [await make(), await make()];
  });
  await t.withIdentity(first).mutation(internal.addressVerification.commit, {
    key: "test-key-that-is-long-enough",
    version: 0,
  });
  // Anchor the fake clock after the setup commits: convex-test never lets a
  // transaction's time run behind the last commit, like the real backend.
  const base = Math.ceil((Date.now() + 60000) / 1000) * 1000 + 100;
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(base);
    const reserve = (identity: { subject: string }) =>
      t.withIdentity(identity).mutation(internal.addressVerification.reserve, {
        programUuid: "demo-program",
      });
    await reserve(first);
    await reserve(second);
    await expect(reserve(first)).rejects.toThrow(/wait a second/);
    await expect(reserve(second)).rejects.toThrow(/wait a second/);
    vi.setSystemTime(base + 1000);
    await reserve(first);
  } finally {
    vi.useRealTimers();
  }
});
it("gives each user a daily lookup share under the global cap", async () => {
  const t = convexTest(schema, modules);
  const { identity, userId } = await t.run(async (ctx) => {
    await ctx.db.insert("programs", demoSnapshot().programs![0]);
    const userId = await ctx.db.insert("users", {
      name: "Admin",
      active: true,
      isAdmin: true,
      groupIds: [],
    });
    const session = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 86400000,
    });
    return { identity: { subject: `${userId}|${session}` }, userId };
  });
  const admin = t.withIdentity(identity);
  await admin.mutation(internal.addressVerification.commit, {
    key: "test-key-that-is-long-enough",
    version: 0,
  });
  const now = Date.now();
  await t.run((ctx) =>
    ctx.db.insert("rateLimits", {
      key: `address:user:${userId}`,
      windowStart: now - (now % 86400000),
      count: 200,
    }),
  );
  await expect(
    admin.mutation(internal.addressVerification.reserve, {
      programUuid: "demo-program",
    }),
  ).rejects.toThrow(/Your address lookup allowance/);
});
