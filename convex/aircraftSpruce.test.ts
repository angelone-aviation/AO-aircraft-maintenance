/**
 * Responsibility: Pins the Aircraft Spruce account per Flight Program: sealed
 *   credentials, versioned writes, allowances, catalog and order snapshots,
 *   and the download checks.
 * Layer: Test. convex-test suite with a stubbed fetch; never shipped.
 * Dependencies: convex/aircraftSpruce, convex/aircraftSpruceActions,
 *   convex/spruceHttp, convex/secrets, src/domain/aircraftSpruce.
 */
import { convexTest } from "convex-test";
import { it, expect, vi, afterEach } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import { downloadSpruce } from "./spruceHttp";
import { orderFields } from "../src/domain/aircraftSpruce";
import { SPRUCE_RATE_LIMITS } from "./aircraftSpruce";
import { sealSecret } from "./secrets";
import { STALE_RECORD_MESSAGE } from "../src/domain/rejection";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const credentials = {
  userid: "private-user",
  password: "private-password",
  apikey: "private-key",
  currency: "USD",
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const ENCRYPTION_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
// What link passes to commitAccount: each field sealed for this program.
async function sealedCredentials(programUuid: string, c = credentials) {
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", ENCRYPTION_KEY);
  const seal = (field: "userid" | "password" | "apikey") =>
    sealSecret(c[field], { table: "spruceAccounts", programUuid, field });
  return {
    userid: await seal("userid"),
    password: await seal("password"),
    apikey: await seal("apikey"),
    currency: c.currency,
  };
}
it("accepts the longest valid credentials and stores only sealed values", async () => {
  const { admin } = await setup();
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", ENCRYPTION_KEY);
  const fetcher = vi.fn().mockImplementation(async (input: string | URL) =>
    String(input).includes("/api/download/")
      ? new Response(
          JSON.stringify({
            status: true,
            url: "https://www.aircraftspruce.com/downloads/test.csv",
          }),
        )
      : new Response("ORN\n"),
  );
  vi.stubGlobal("fetch", fetcher);
  const longest = {
    userid: "u".repeat(100),
    password: "p".repeat(500),
    apikey: "k".repeat(500),
    currency: "USD",
  };
  await expect(
    admin.action(api.aircraftSpruceActions.link, {
      programUuid: "demo-program",
      version: 0,
      ...longest,
      userid: "u".repeat(101),
    }),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  await admin.action(api.aircraftSpruceActions.link, {
    programUuid: "demo-program",
    version: 0,
    ...longest,
  });
  expect(
    await admin.query(api.aircraftSpruce.status, {
      programUuid: "demo-program",
    }),
  ).toMatchObject({ configured: true, version: 1 });
  // The commit step accepts only sealed values, checked against sealed lengths.
  for (const bad of [
    { ...(await sealedCredentials("demo-program")), userid: "plaintext" },
    {
      ...(await sealedCredentials("demo-program")),
      apikey: `enc:v2:k1:${"A".repeat(16)}:${"A".repeat(5000)}`,
    },
  ])
    await expect(
      admin.mutation(internal.aircraftSpruce.commitAccount, {
        programUuid: "demo-program",
        version: 1,
        credentials: bad,
      }),
    ).rejects.toThrow();
});

async function setup() {
  const t = convexTest(schema, modules);
  const identities = await t.run(async (ctx) => {
    const program = demoSnapshot().programs![0];
    await ctx.db.insert("programs", program);
    await ctx.db.insert("programs", {
      ...program,
      uuid: "second",
      name: "Second",
    });
    async function user(admin: boolean, activeProgramUuid: string) {
      const userId = await ctx.db.insert("users", {
        name: "User",
        active: true,
        isAdmin: admin,
        activeProgramUuid,
        groupIds: [],
      });
      const session = await ctx.db.insert("authSessions", {
        userId,
        expirationTime: Date.now() + 86400000,
      });
      return { subject: `${userId}|${session}` };
    }
    return {
      admin: await user(true, "demo-program"),
      second: await user(true, "second"),
      other: await user(false, "demo-program"),
    };
  });
  return {
    t,
    admin: t.withIdentity(identities.admin),
    second: t.withIdentity(identities.second),
    other: t.withIdentity(identities.other),
  };
}
it("isolates accounts by active program, never exposes secrets, and rejects stale writes", async () => {
  const { t, admin, second, other } = await setup();
  await admin.mutation(internal.aircraftSpruce.commitAccount, {
    programUuid: "demo-program",
    version: 0,
    credentials: await sealedCredentials("demo-program"),
  });
  expect(
    await admin.query(api.aircraftSpruce.status, {
      programUuid: "demo-program",
    }),
  ).toMatchObject({ configured: true, version: 1, currency: "USD" });
  expect(
    JSON.stringify(
      await admin.query(api.aircraftSpruce.status, {
        programUuid: "demo-program",
      }),
    ),
  ).not.toContain("private");
  expect(
    await second.query(api.aircraftSpruce.status, { programUuid: "second" }),
  ).toMatchObject({ configured: false });
  await expect(
    second.query(api.aircraftSpruce.status, { programUuid: "demo-program" }),
  ).rejects.toThrow(/Program changed/);
  await expect(
    other.query(api.aircraftSpruce.status, { programUuid: "demo-program" }),
  ).rejects.toThrow();
  await expect(
    admin.mutation(internal.aircraftSpruce.commitAccount, {
      programUuid: "demo-program",
      version: 0,
      credentials: await sealedCredentials("demo-program"),
    }),
  ).rejects.toThrow(STALE_RECORD_MESSAGE);
  expect(
    JSON.stringify(await t.run((ctx) => ctx.db.query("audit").collect())),
  ).not.toContain("private");
  await admin.mutation(api.aircraftSpruce.disconnect, {
    programUuid: "demo-program",
    version: 1,
  });
  const audit = await t.run((ctx) => ctx.db.query("audit").collect());
  expect(audit.map((a) => a.action)).toEqual([
    "spruce.account.linked",
    "spruce.account.disconnected",
  ]);
  expect(audit[1]).toMatchObject({
    programUuid: "demo-program",
    entityUuid: "demo-program",
  });
  expect(JSON.stringify(audit)).not.toContain("private");
  await expect(
    admin.mutation(internal.aircraftSpruce.commitOrders, {
      programUuid: "demo-program",
      poUuid: "po",
      version: 1,
      fetchedAt: 1,
      order: "",
      rows: [],
    }),
  ).rejects.toThrow("Account changed. Sync again.");
});
it("denies unauthorized actions before contacting the provider", async () => {
  const { other } = await setup();
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(
    other.action(api.aircraftSpruceActions.link, {
      programUuid: "demo-program",
      version: 0,
      ...credentials,
    }),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it("rate-limits link, refresh and sync per Flight Program before contacting the provider", async () => {
  const { t, admin, second } = await setup();
  vi.stubEnv(
    "CREDENTIALS_ENCRYPTION_KEY",
    "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  );
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const now = Date.now();
  await t.run(async (ctx) => {
    for (const [kind, { limit }] of Object.entries(SPRUCE_RATE_LIMITS))
      await ctx.db.insert("rateLimits", {
        key: `spruce:${kind}:program:demo-program`,
        windowStart: now - (now % 3600000),
        count: limit,
      });
  });
  await expect(
    admin.action(api.aircraftSpruceActions.link, {
      programUuid: "demo-program",
      version: 0,
      ...credentials,
    }),
  ).rejects.toThrow(/Too many Aircraft Spruce/);
  await admin.mutation(internal.aircraftSpruce.commitAccount, {
    programUuid: "demo-program",
    version: 0,
    credentials: await sealedCredentials("demo-program"),
  });
  await expect(
    admin.action(api.aircraftSpruceActions.refresh, {
      programUuid: "demo-program",
    }),
  ).rejects.toThrow(/Too many Aircraft Spruce/);
  await expect(
    admin.action(api.aircraftSpruceActions.sync, {
      programUuid: "demo-program",
      poUuid: "po",
      order: "1",
    }),
  ).rejects.toThrow(/Too many Aircraft Spruce/);
  expect(fetcher).not.toHaveBeenCalled();
  // Another program's allowance is separate.
  fetcher.mockImplementation(async (input: string | URL) =>
    String(input).includes("/api/download/")
      ? new Response(
          JSON.stringify({
            status: true,
            url: "https://www.aircraftspruce.com/downloads/test.csv",
          }),
        )
      : new Response("ORN\n"),
  );
  await second.action(api.aircraftSpruceActions.link, {
    programUuid: "second",
    version: 0,
    ...credentials,
  });
  expect(fetcher).toHaveBeenCalled();
});
it("rejects untrusted download URLs and redacts provider errors", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        status: true,
        url: "https://evil.example/downloads/file.csv",
      }),
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  await expect(downloadSpruce("products", credentials)).rejects.toThrow(
    /download failed/,
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockResolvedValue(
    new Response(
      JSON.stringify({ status: 0, error: "private-key private-password" }),
    ),
  );
  await expect(downloadSpruce("products", credentials)).rejects.not.toThrow(
    /private/,
  );
});
it("replaces supplier snapshots on repeated sync without changing inventory or PO shipments", async () => {
  const { t, admin } = await setup();
  await admin.mutation(internal.aircraftSpruce.commitAccount, {
    programUuid: "demo-program",
    version: 0,
    credentials: await sealedCredentials("demo-program"),
  });
  await t.run((ctx) =>
    ctx.db.insert("purchaseOrders", {
      uuid: "po",
      programUuid: "demo-program",
      payload: "unchanged",
    }),
  );
  const args = {
    programUuid: "demo-program",
    poUuid: "po",
    version: 1,
    fetchedAt: 100,
    order: "123",
    rows: [
      Object.fromEntries(orderFields.map((k) => [k, k === "ORN" ? "123" : ""])),
    ],
  };
  await admin.mutation(internal.aircraftSpruce.commitOrders, args);
  await admin.mutation(internal.aircraftSpruce.commitOrders, {
    ...args,
    fetchedAt: 200,
  });
  expect(
    await t.run((ctx) => ctx.db.query("spruceOrders").collect()),
  ).toHaveLength(1);
  expect(
    (
      await admin.query(api.aircraftSpruce.orders, {
        programUuid: "demo-program",
        poUuid: "po",
      })
    )?.rows,
  ).toHaveLength(1);
  expect(
    await t.run((ctx) => ctx.db.query("management").collect()),
  ).toHaveLength(0);
  expect(
    (await t.run((ctx) => ctx.db.query("purchaseOrders").unique()))?.payload,
  ).toBe("unchanged");
  await expect(
    admin.mutation(internal.aircraftSpruce.commitOrders, args),
  ).rejects.toThrow(/newer sync/);
  await admin.mutation(api.aircraftSpruce.disconnect, {
    programUuid: "demo-program",
    version: 1,
  });
  expect(
    await admin.query(api.aircraftSpruce.orders, {
      programUuid: "demo-program",
      poUuid: "po",
    }),
  ).toBeNull();
});

it("validates an account and searches only its server-stored catalog", async () => {
  const { t, admin, second } = await setup();
  vi.stubEnv(
    "CREDENTIALS_ENCRYPTION_KEY",
    "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  );
  const fetcher = vi.fn().mockImplementation(async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/api/download/"))
      return new Response(
        JSON.stringify({
          status: true,
          url: "https://www.aircraftspruce.com/downloads/test.csv",
        }),
      );
    return new Response("ORN\n");
  });
  vi.stubGlobal("fetch", fetcher);
  await admin.action(api.aircraftSpruceActions.link, {
    programUuid: "demo-program",
    version: 0,
    ...credentials,
  });
  // Credentials are encrypted at rest; refresh below proves they still decrypt.
  expect(
    JSON.stringify(
      await t.run((ctx) => ctx.db.query("spruceAccounts").collect()),
    ),
  ).not.toContain("private");
  fetcher.mockImplementation(async (input: string | URL) => {
    if (String(input).includes("/api/download/"))
      return new Response(
        JSON.stringify({
          status: true,
          url: "https://www.aircraftspruce.com/downloads/test.csv",
        }),
      );
    return new Response("PN,DESCRIPTION,NETPRICE,UOM\nABC,Test bolt,1.25,EA\n");
  });
  expect(
    await admin.action(api.aircraftSpruceActions.refresh, {
      programUuid: "demo-program",
    }),
  ).toBe(1);
  expect(
    await admin.action(api.aircraftSpruceActions.search, {
      programUuid: "demo-program",
      search: "abc",
    }),
  ).toMatchObject([{ partNumber: "ABC", netPrice: "1.25" }]);
  await expect(
    second.action(api.aircraftSpruceActions.search, {
      programUuid: "second",
      search: "abc",
    }),
  ).rejects.toThrow(/Refresh/);
  const before = await admin.query(api.aircraftSpruce.status, {
    programUuid: "demo-program",
  });
  fetcher.mockImplementation(async (input: string | URL) => {
    if (String(input).includes("/api/download/"))
      return new Response(
        JSON.stringify({
          status: true,
          url: "https://www.aircraftspruce.com/downloads/test.csv",
        }),
      );
    return new Response("PN,DESCRIPTION,NETPRICE,UOM\n");
  });
  await expect(
    admin.action(api.aircraftSpruceActions.refresh, {
      programUuid: "demo-program",
    }),
  ).rejects.toThrow(/empty/);
  expect(
    await admin.query(api.aircraftSpruce.status, {
      programUuid: "demo-program",
    }),
  ).toEqual(before);
  await admin.mutation(internal.aircraftSpruce.commitAccount, {
    programUuid: "demo-program",
    version: 1,
    credentials: {
      ...(await sealedCredentials("demo-program")),
      currency: "CAD",
    },
  });
  const after = await admin.query(api.aircraftSpruce.status, {
    programUuid: "demo-program",
  });
  expect(after.catalogAt).toBeUndefined();
  expect(after.currency).toBe("CAD");
});

it("returns a public actionable error when a linked account has no catalog", async () => {
  const { admin } = await setup();
  await admin.mutation(internal.aircraftSpruce.commitAccount, {
    programUuid: "demo-program",
    version: 0,
    credentials: await sealedCredentials("demo-program"),
  });
  await expect(
    admin.action(api.aircraftSpruceActions.search, {
      programUuid: "demo-program",
      search: "an3",
    }),
  ).rejects.toMatchObject({
    data: "Refresh this program's Aircraft Spruce catalog under Vendors first.",
  });
});

it("accepts a cached export URL without status but still rejects explicit failure", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          url: "https://www.aircraftspruce.com/downloads/cached.csv",
          expires: "later",
          size: 4,
        }),
      ),
    )
    .mockResolvedValueOnce(new Response("ORN\n"));
  vi.stubGlobal("fetch", fetcher);
  expect(await downloadSpruce("orders", credentials)).toBe("ORN\n");
  fetcher.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        status: 0,
        url: "https://www.aircraftspruce.com/downloads/cached.csv",
      }),
    ),
  );
  await expect(downloadSpruce("orders", credentials)).rejects.toThrow(
    /rejected/,
  );
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("deletes a catalog file once a refresh, relink or disconnect replaces it", async () => {
  const { t, admin } = await setup();
  const link = (version: number) =>
    sealedCredentials("demo-program").then((credentials) =>
      admin.mutation(internal.aircraftSpruce.commitAccount, {
        programUuid: "demo-program",
        version,
        credentials,
      }),
    );
  const catalog = async (version: number, at: number) => {
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["PN"])));
    await admin.mutation(internal.aircraftSpruce.commitCatalog, {
      programUuid: "demo-program",
      version,
      storageId,
      count: 1,
      at,
    });
    return storageId;
  };
  const stored = () =>
    t.run(async (ctx) =>
      (await ctx.db.system.query("_storage").collect()).map((f) => f._id),
    );
  await link(0);
  await catalog(1, 100);
  const second = await catalog(1, 200);
  expect(await stored()).toEqual([second]);
  await link(1);
  expect(await stored()).toEqual([]);
  await catalog(2, 300);
  await admin.mutation(api.aircraftSpruce.disconnect, {
    programUuid: "demo-program",
    version: 2,
  });
  expect(await stored()).toEqual([]);
});

it("refuses another program's PO and hides orders synced under an earlier login", async () => {
  const { t, admin } = await setup();
  await expect(
    admin.mutation(api.aircraftSpruce.disconnect, {
      programUuid: "demo-program",
      version: 0,
    }),
  ).rejects.toThrow("Account changed. Reload before disconnecting.");
  await admin.mutation(internal.aircraftSpruce.commitAccount, {
    programUuid: "demo-program",
    version: 0,
    credentials: await sealedCredentials("demo-program"),
  });
  await t.run(async (ctx) => {
    await ctx.db.insert("purchaseOrders", {
      uuid: "po",
      programUuid: "demo-program",
      payload: "unparsed",
    });
    await ctx.db.insert("purchaseOrders", {
      uuid: "foreign-po",
      programUuid: "second",
      payload: "unparsed",
    });
  });
  await expect(
    admin.query(internal.aircraftSpruce.access, {
      programUuid: "demo-program",
      poUuid: "foreign-po",
    }),
  ).rejects.toThrow("PO not found in this Flight Program.");
  const sync = {
    programUuid: "demo-program",
    version: 1,
    fetchedAt: 100,
    order: "",
    rows: [{ ORN: "1" }],
  };
  await expect(
    admin.mutation(internal.aircraftSpruce.commitOrders, {
      ...sync,
      poUuid: "foreign-po",
    }),
  ).rejects.toThrow("PO not found.");
  await admin.mutation(internal.aircraftSpruce.commitOrders, {
    ...sync,
    poUuid: "po",
  });
  const orders = () =>
    admin.query(api.aircraftSpruce.orders, {
      programUuid: "demo-program",
      poUuid: "po",
    });
  expect(await orders()).toEqual({
    fetchedAt: 100,
    order: "",
    rows: [{ ORN: "1" }],
  });
  await admin.mutation(internal.aircraftSpruce.commitAccount, {
    programUuid: "demo-program",
    version: 1,
    credentials: await sealedCredentials("demo-program"),
  });
  expect(await orders()).toBeNull();
});
