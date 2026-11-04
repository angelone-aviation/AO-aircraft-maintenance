/**
 * Responsibility: Pins Geoapify address lookups: who may run them, the
 *   per-second, per-user, per-program and global daily allowances, the
 *   request and its failures, and how the administrator's key is checked,
 *   sealed, saved and audited.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/addressVerification, src/domain/model, src/data/demo.
 */
import { convexTest } from "convex-test";
import { it, expect, vi, afterEach } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import { demoSnapshot } from "../src/data/demo";
import type { Permission } from "../src/domain/model";
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
  // Test server persistence separately from the provider; lookups use the
  // action below.
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
  // Both lookups run at one frozen instant: on a busy machine real time could
  // cross the one-second window between them and skip the refusal.
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(Math.ceil((Date.now() + 60000) / 1000) * 1000 + 100);
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
  } finally {
    vi.useRealTimers();
  }
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

it("sends Geoapify only the physical address, with the key, and reads its reply", async () => {
  const fetcher = reply({
    results: [
      {
        formatted: "Washington, DC",
        housenumber: "1600",
        street: "Pennsylvania Avenue NW",
        city: "Washington",
        state_code: "DC",
        country: "United States",
        result_type: "city",
        rank: { confidence: 0.4 },
        datasource: { attribution: "Source" },
      },
    ],
  });
  const results = await lookupWith(fetcher);
  const [[url, init]] = fetcher.mock.calls;
  const sent = new URL(String(url));
  expect(sent.origin + sent.pathname).toBe(
    "https://api.geoapify.com/v1/geocode/search",
  );
  expect(Object.fromEntries(sent.searchParams)).toEqual({
    text: "1600 Pennsylvania Avenue NW, Washington, 20500, United States",
    format: "json",
    limit: "5",
    lang: "en",
    bias: "countrycode:none",
    apiKey: DEPLOYMENT_KEY,
  });
  expect(String(url)).not.toMatch(/receiving|555/i);
  expect(init).toMatchObject({
    redirect: "error",
    signal: expect.any(AbortSignal),
  });
  expect(results).toEqual([
    {
      formatted: "Washington, DC",
      street: "1600 Pennsylvania Avenue NW",
      city: "Washington",
      region: "DC",
      postalCode: "",
      country: "United States",
      confidence: 0.4,
      matchLevel: "city",
      attribution: "Source",
    },
  ]);
});

it("shows a failed connection without the key the network error quotes", async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValue(Error(`URL failed with apiKey=${DEPLOYMENT_KEY}`));
  const error = await lookupWith(fetcher).catch((e: unknown) => e);
  expect(error).toMatchObject({
    name: "ConvexError",
    data: "Address lookup could not connect. Your address has not been changed.",
  });
  expect(String(error)).not.toContain(DEPLOYMENT_KEY);
});

it.each([
  [
    401,
    "The Geoapify key was not accepted. Ask a system administrator to check Address verification in Settings → System.",
  ],
  [
    403,
    "The Geoapify key was not accepted. Ask a system administrator to check Address verification in Settings → System.",
  ],
  [429, "Address lookup quota reached. Try again later."],
  [
    500,
    "The address service is unavailable. Your address has not been changed.",
  ],
])("shows HTTP %i from Geoapify to the user", async (status, message) => {
  await expect(lookupWith(reply({}, status))).rejects.toMatchObject({
    name: "ConvexError",
    data: message,
  });
});

it("shows an unreadable reply plainly", async () => {
  const unexpected = {
    name: "ConvexError",
    data: "The address service returned an unexpected response. Your address has not been changed.",
  };
  await expect(lookupWith(reply({ results: "none" }))).rejects.toMatchObject(
    unexpected,
  );
  const notJson = vi.fn().mockResolvedValue(new Response("not json"));
  await expect(lookupWith(notJson)).rejects.toMatchObject(unexpected);
});

const CREDENTIALS_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const DEPLOYMENT_KEY = "deployment-key-long-enough";
const KEY = "test-key-that-is-long-enough";
const today = () => new Date().toISOString().slice(0, 10);
const settings = (fields: { day?: string; used?: number } = {}) => ({
  key: KEY,
  version: 1,
  day: "",
  used: 0,
  lastLookupAt: 0,
  ...fields,
});
type Membership = { permissions: Permission[]; programAdmin?: boolean };

async function fixture() {
  const t = convexTest(schema, modules),
    demo = demoSnapshot();
  await t.run(async (ctx) => {
    await ctx.db.insert("programs", demo.programs![0]);
    await ctx.db.insert("aircraft", demo.aircraft[0]);
  });
  const user = async (membership?: Membership) =>
    t.withIdentity({
      subject: await t.run((ctx) => addUser(ctx, membership)),
    });
  const reserve = async (membership?: Membership) =>
    (await user(membership)).mutation(internal.addressVerification.reserve, {
      programUuid: "demo-program",
    });
  const saved = () =>
    t.run((ctx) => ctx.db.query("addressVerificationSettings").unique());
  return { t, user, reserve, saved };
}

// A system administrator without a membership; a member otherwise.
async function addUser(ctx: MutationCtx, membership?: Membership) {
  const groupIds = membership
    ? [
        await ctx.db.insert("groups", {
          programUuid: "demo-program",
          name: "Group",
          aircraftIds: [demoSnapshot().aircraft[0].uuid],
          ...membership,
        }),
      ]
    : [];
  const userId = await ctx.db.insert("users", {
    name: "User",
    active: true,
    isAdmin: !membership,
    groupIds,
    activeProgramUuid: "demo-program",
  });
  const session = await ctx.db.insert("authSessions", {
    userId,
    expirationTime: Date.now() + 86400000,
  });
  return `${userId}|${session}`;
}

it("lets maintainers and any administrator look up addresses, not readers", async () => {
  const { t, reserve } = await fixture();
  await t.run((ctx) =>
    ctx.db.insert("addressVerificationSettings", settings()),
  );
  await expect(reserve({ permissions: ["read"] })).rejects.toThrow(
    "Maintenance access required for address lookups.",
  );
  await expect(
    reserve({ permissions: ["read", "maintenance"] }),
  ).resolves.toEqual({ stored: KEY });
  // Otherwise maintenance on an aircraft already admits a program
  // administrator, so only a program without aircraft tells them apart.
  await t.run(async (ctx) => {
    for (const a of await ctx.db.query("aircraft").collect())
      await ctx.db.delete(a._id);
  });
  await expect(
    reserve({ permissions: ["read"], programAdmin: true }),
  ).resolves.toEqual({ stored: KEY });
});

it("refuses lookups until a key is saved or set on the deployment", async () => {
  const { reserve, user, saved } = await fixture();
  await expect(reserve()).rejects.toThrow(
    "Address lookup is not enabled. A system administrator must add a free Geoapify API key in Settings → System → Address verification.",
  );
  vi.stubEnv("GEOAPIFY_API_KEY", "deployment-key-long-enough");
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ results: [] })));
  vi.stubGlobal("fetch", fetcher);
  const admin = await user();
  expect(await admin.query(api.addressVerification.status, {})).toEqual({
    configured: true,
    version: 0,
  });
  await admin.action(api.addressVerification.lookup, {
    payload: JSON.stringify({
      street: "1 Main St",
      city: "Wichita",
      region: "KS",
      postalCode: "67202",
      country: "US",
    }),
    programUuid: "demo-program",
  });
  expect(
    new URL(String(fetcher.mock.calls[0][0])).searchParams.get("apiKey"),
  ).toBe("deployment-key-long-enough");
  expect(await saved()).toMatchObject({ version: 0, day: today(), used: 1 });
});

it("caps lookups at 2,900 a UTC day across users, counting afresh each day", async () => {
  const { t, reserve, saved } = await fixture();
  const id = await t.run((ctx) =>
    ctx.db.insert(
      "addressVerificationSettings",
      settings({ day: today(), used: 2899 }),
    ),
  );
  await reserve();
  expect(await saved()).toMatchObject({ used: 2900 });
  await expect(reserve()).rejects.toThrow(
    "Today's address lookup allowance is used. Try again tomorrow.",
  );
  await t.run((ctx) => ctx.db.patch(id, { day: "2000-01-01" }));
  await reserve();
  expect(await saved()).toMatchObject({ day: today(), used: 1 });
});

it("gives each Flight Program a daily share of 1,000 lookups", async () => {
  const { t, reserve } = await fixture();
  const now = Date.now();
  await t.run(async (ctx) => {
    await ctx.db.insert("addressVerificationSettings", settings());
    await ctx.db.insert("rateLimits", {
      key: "address:program:demo-program",
      windowStart: now - (now % 86400000),
      count: 999,
    });
  });
  await reserve();
  await expect(reserve()).rejects.toThrow(
    "This Flight Program's address lookup allowance for today is used. Try again tomorrow.",
  );
});

it("refuses a stale settings version and audits a saved key without it", async () => {
  const { t, user } = await fixture();
  const admin = await user();
  await admin.mutation(internal.addressVerification.commit, {
    key: KEY,
    version: 0,
  });
  await expect(
    admin.mutation(internal.addressVerification.commit, {
      key: KEY,
      version: 0,
    }),
  ).rejects.toThrow("Address settings changed. Reload before saving.");
  const rows = await t.run((ctx) => ctx.db.query("audit").collect());
  expect(rows).toMatchObject([
    {
      action: "addressVerification.key.updated",
      entityUuid: "address-verification",
      after: JSON.stringify({ configured: true, version: 1 }),
    },
  ]);
});

it("saves a key sealed, and only once Geoapify accepts it", async () => {
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", CREDENTIALS_KEY);
  const { user, saved } = await fixture();
  const admin = await user();
  const fetcher = vi.fn().mockResolvedValue(new Response("", { status: 401 }));
  vi.stubGlobal("fetch", fetcher);
  await expect(
    admin.action(api.addressVerification.setKey, { key: "short", version: 0 }),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  await expect(
    admin.action(api.addressVerification.setKey, { key: KEY, version: 0 }),
  ).rejects.toThrow("The Geoapify key was not accepted.");
  expect(await saved()).toBeNull();
  fetcher.mockResolvedValue(new Response(JSON.stringify({ results: [] })));
  await admin.action(api.addressVerification.setKey, { key: KEY, version: 0 });
  const row = await saved();
  expect(row).toMatchObject({
    version: 1,
    key: expect.stringMatching(/^enc:v2:/),
  });
  expect(row!.key).not.toContain(KEY);
});

const reply = (body: unknown, status = 200) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));

// One lookup by a new system administrator, so the one-a-second pacing never
// decides, with the deployment's key and `fetcher` standing in for Geoapify.
async function lookupWith(fetcher: typeof fetch) {
  vi.stubEnv("GEOAPIFY_API_KEY", DEPLOYMENT_KEY);
  vi.stubGlobal("fetch", fetcher);
  const { user } = await fixture();
  return (await user()).action(api.addressVerification.lookup, {
    payload: JSON.stringify({
      street: "1600 Pennsylvania Avenue NW",
      city: "Washington",
      region: "",
      postalCode: "20500",
      country: "United States",
      contactName: "Receiving",
      email: "receiving@example.com",
      phone: "+1 202 555 0100",
    }),
    programUuid: "demo-program",
  });
}
