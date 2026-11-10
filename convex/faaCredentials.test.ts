/**
 * Responsibility: Pins the FAA key settings: who may replace the key, the FAA
 *   check before a working key is discarded, the renewal date, and the
 *   deployment key used until one is saved.
 * Layer: Test. convex-test suite with a stubbed fetch; never shipped.
 * Dependencies: convex/faaCredentials, convex/secrets, convex/schema.
 */
import { convexTest } from "convex-test";
import { afterEach, it, expect, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { openSecret } from "./secrets";
import { FAA_SECRET, faaSecret } from "./faaCredentials";
const ENCRYPTION_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
it("validates replacements, rejects non-admin and stale updates, and never exposes keys in snapshots or audits", async () => {
  const t = convexTest(schema, modules);
  async function identity(isAdmin: boolean) {
    return t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {
        active: true,
        isAdmin,
        name: "Credential test",
      });
      const session = await ctx.db.insert("authSessions", {
        userId: id,
        expirationTime: Date.now() + 86400000,
      });
      return { subject: `${id}|${session}` };
    });
  }
  const admin = t.withIdentity(await identity(true)),
    reader = t.withIdentity(await identity(false));
  const args = {
    key: "synthetic-test-key-000001",
    expiresOn: "2099-10-14",
    version: 0,
  };
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementation(
      async () =>
        new Response(JSON.stringify({ summary: { count: 0 }, documents: [] })),
    );
  vi.stubGlobal("fetch", fetchMock);
  try {
    await expect(
      admin.action(api.faaCredentials.replace, args),
    ).rejects.toThrow(/CREDENTIALS_ENCRYPTION_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", ENCRYPTION_KEY);
    await expect(
      reader.action(api.faaCredentials.replace, args),
    ).rejects.toThrow("Administrator");
    expect(fetchMock).not.toHaveBeenCalled();
    await admin.action(api.faaCredentials.replace, args);
    const snapshot = await admin.query(api.operations.snapshot, {});
    expect(snapshot?.faaCredential).toEqual({
      configured: true,
      expiresOn: args.expiresOn,
      version: 1,
    });
    expect(JSON.stringify(snapshot)).not.toContain(args.key);
    const audit = await t.run((ctx) => ctx.db.query("audit").collect());
    expect(JSON.stringify(audit)).not.toContain(args.key);
    await expect(
      admin.action(api.faaCredentials.replace, args),
    ).rejects.toThrow("changed");
    fetchMock.mockImplementation(
      async () => new Response("Rejected", { status: 403 }),
    );
    await expect(
      admin.action(api.faaCredentials.replace, {
        ...args,
        key: "synthetic-rejected-key",
        version: 1,
      }),
    ).rejects.toThrow("previous key is unchanged");
    const stored = (await t.run((ctx) =>
      ctx.db.query("faaCredentials").unique(),
    ))!.key!;
    expect(stored).not.toContain(args.key);
    expect(stored).toMatch(/^enc:v2:/);
    expect(await openSecret(stored, FAA_SECRET)).toBe(args.key);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

async function setupAdmin() {
  const t = convexTest(schema, modules);
  const subject = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", { active: true, isAdmin: true });
    const session = await ctx.db.insert("authSessions", {
      userId: id,
      expirationTime: Date.now() + 86400000,
    });
    return `${id}|${session}`;
  });
  return { t, admin: t.withIdentity({ subject }) };
}

function stubFaa(body: string) {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(body));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("needs a renewal date after today in the records time zone, before contacting the FAA", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // 20:30 on 3 Nov in New York, the default records time zone; already
  // 4 Nov in UTC and in the runtime's own zone.
  vi.setSystemTime(new Date("2026-11-04T01:30:00Z"));
  vi.stubEnv("TZ", "Pacific/Auckland");
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", ENCRYPTION_KEY);
  const { admin } = await setupAdmin();
  const fetchMock = stubFaa(JSON.stringify({ summary: {}, documents: [] }));
  const args = { key: "synthetic-test-key-000001", version: 0 };
  await expect(
    admin.action(api.faaCredentials.replace, {
      ...args,
      expiresOn: "2026-11-03",
    }),
  ).rejects.toThrow("The renewal date must be in the future.");
  expect(fetchMock).not.toHaveBeenCalled();
  await admin.action(api.faaCredentials.replace, {
    ...args,
    expiresOn: "2026-11-04",
  });
});

it("keeps the previous key when the FAA answers without results", async () => {
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", ENCRYPTION_KEY);
  const { t, admin } = await setupAdmin();
  for (const body of [
    "null",
    JSON.stringify({ summary: {}, documents: {} }),
    JSON.stringify({ summary: {}, documents: [], errorMessage: "Denied" }),
  ]) {
    stubFaa(body);
    await expect(
      admin.action(api.faaCredentials.replace, {
        key: "synthetic-test-key-000001",
        expiresOn: "2099-10-14",
        version: 0,
      }),
    ).rejects.toThrow(
      "FAA returned an unexpected response. The previous key is unchanged.",
    );
  }
  expect(
    await t.run((ctx) => ctx.db.query("faaCredentials").collect()),
  ).toEqual([]);
});

it("shows the FAA's refusal of a new key to the administrator", async () => {
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", ENCRYPTION_KEY);
  const { admin } = await setupAdmin();
  const replace = () =>
    admin.action(api.faaCredentials.replace, {
      key: "synthetic-test-key-000001",
      expiresOn: "2099-10-14",
      version: 0,
    });
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () => new Response("Rejected", { status: 403 }),
      ),
  );
  await expect(replace()).rejects.toMatchObject({
    name: "ConvexError",
    data: "FAA could not verify the new key (403). The previous key is unchanged.",
  });
  stubFaa("null");
  await expect(replace()).rejects.toMatchObject({
    name: "ConvexError",
    data: "FAA returned an unexpected response. The previous key is unchanged.",
  });
});

it("uses the deployment key until an administrator saves one", async () => {
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", ENCRYPTION_KEY);
  vi.stubEnv("FAA_DRS_API_KEY", "deployment-key");
  const { t, admin } = await setupAdmin();
  expect(await t.action((ctx) => faaSecret(ctx))).toEqual({
    key: "deployment-key",
    expiresOn: "",
  });
  await t.mutation(internal.faaCredentials.initializeExpiry, {
    expiresOn: "2099-01-31",
  });
  expect(await t.action((ctx) => faaSecret(ctx))).toEqual({
    key: "deployment-key",
    expiresOn: "2099-01-31",
  });
  stubFaa(JSON.stringify({ summary: {}, documents: [] }));
  await admin.action(api.faaCredentials.replace, {
    key: "synthetic-saved-key-0001",
    expiresOn: "2099-10-14",
    version: 1,
  });
  expect(await t.action((ctx) => faaSecret(ctx))).toEqual({
    key: "synthetic-saved-key-0001",
    expiresOn: "2099-10-14",
  });
});

it("records an expiry only in YYYY-MM-DD form and only once", async () => {
  const { t } = await setupAdmin();
  await expect(
    t.mutation(internal.faaCredentials.initializeExpiry, {
      expiresOn: "2099-1-31",
    }),
  ).rejects.toThrow("Invalid date.");
  for (const expiresOn of ["2099-01-31", "2099-12-31"])
    await t.mutation(internal.faaCredentials.initializeExpiry, { expiresOn });
  expect(
    await t.run((ctx) => ctx.db.query("faaCredentials").unique()),
  ).toMatchObject({ expiresOn: "2099-01-31", version: 1 });
});
