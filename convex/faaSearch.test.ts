/**
 * Responsibility: Pins FAA search: who may search, the key and allowance
 *   checks, the access recheck after the FAA answers, and which refusals reach
 *   the user.
 * Layer: Test. convex-test suite with a stubbed FAA; never shipped.
 * Dependencies: convex/faaSearch.ts, convex/airworthiness.ts,
 *   convex/faaCredentials.ts, convex/secrets.ts, convex/schema.ts,
 *   src/domain/faaSearch, src/data/demo.ts (fixture).
 */
import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { it, expect, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import { blankSearch, searchAssets } from "../src/domain/faaSearch";
import { FAA_GLOBAL_DAILY } from "./faaSearch";
import { FAA_SECRET } from "./faaCredentials";
import { sealSecret } from "./secrets";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);

// Seals the stored FAA key, as saving one does.
const CREDENTIALS_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

// An editor with maintenance on the first demo aircraft and a reader, sharing
// one FAA key that expires in 2099.
async function fixture() {
  const t = convexTest(schema, modules),
    s = demoSnapshot();
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", CREDENTIALS_KEY);
  const key = await sealSecret("synthetic-key", FAA_SECRET);
  const ids = await t.run(async (ctx) => {
    for (const a of s.aircraft) await ctx.db.insert("aircraft", a);
    await ctx.db.insert("programs", s.programs![0]);
    await ctx.db.insert("faaCredentials", {
      key,
      expiresOn: "2099-01-01",
      version: 1,
      updatedAt: 0,
    });
    async function user(maintenance: boolean) {
      const group = await ctx.db.insert("groups", {
        programUuid: "demo-program",
        name: "FAA users",
        aircraftIds: [s.aircraft[0].uuid],
        permissions: maintenance ? ["read", "maintenance"] : ["read"],
      });
      const id = await ctx.db.insert("users", {
        active: true,
        isAdmin: false,
        name: "FAA user",
        activeProgramUuid: "demo-program",
        groupIds: [group],
      });
      const session = await ctx.db.insert("authSessions", {
        userId: id,
        expirationTime: Date.now() + 86400000,
      });
      return { subject: `${id}|${session}` };
    }
    return { editor: await user(true), reader: await user(false) };
  });
  const editor = t.withIdentity(ids.editor),
    reader = t.withIdentity(ids.reader);
  const input = blankSearch(
    s.aircraft[0].uuid,
    searchAssets(s, s.aircraft[0].uuid),
  );
  input.emergency = false;
  const args = { payload: JSON.stringify(input), programUuid: "demo-program" };
  return { t, s, ids, editor, reader, input, args };
}

it("authorizes FAA search by aircraft, rejects detached components, and imports selected results for review", async () => {
  const { t, editor, reader, input, args } = await fixture();
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        summary: { hasMoreItems: false },
        documents: [
          {
            documentGuid: "test-ad",
            "drs:documentNumber": "2026-01-01",
            "drs:status": "Current",
            "drs:adfrawdSubject": "Inspect fittings",
            documentURL: "https://drs.faa.gov/test",
          },
        ],
      }),
    ),
  );
  vi.stubGlobal("fetch", request);
  try {
    await expect(reader.action(api.faaSearch.search, args)).rejects.toThrow(
      "maintenance permission",
    );
    expect(request).not.toHaveBeenCalled();
    await expect(
      editor.action(api.faaSearch.search, {
        ...args,
        payload: JSON.stringify({
          ...input,
          assets: [{ ...input.assets[0], id: "detached" }],
        }),
      }),
    ).rejects.toThrow("no longer installed");
    const results = await editor.action(api.faaSearch.search, args);
    expect(results).toHaveLength(1);
    await editor.mutation(api.airworthiness.save, {
      programUuid: "demo-program",
      payload: JSON.stringify({
        kind: "import",
        aircraftUuid: input.aircraftUuid,
        entries: [{ source: results[0].candidate.source, componentUuid: "" }],
      }),
    });
    const docs = await t.run((ctx) => ctx.db.query("airworthiness").collect());
    const ad = JSON.parse(docs[0].payload);
    expect(ad.reviewRequired).toBe(true);
    expect(ad.history).toEqual([]);
    const credentialId = await t.run(async (ctx) => {
      const credential = (await ctx.db.query("faaCredentials").unique())!;
      await ctx.db.patch(credential._id, { expiresOn: "2000-01-01" });
      return credential._id;
    });
    await expect(
      editor.action(api.faaSearch.search, args),
    ).rejects.toMatchObject({
      data: "Renew the FAA API key before searching.",
    });
    await t.run((ctx) => ctx.db.delete(credentialId));
    await expect(
      editor.action(api.faaSearch.search, args),
    ).rejects.toBeInstanceOf(ConvexError);
    await expect(
      editor.action(api.faaSearch.search, args),
    ).rejects.toMatchObject({
      data: "Configure the FAA API key in FAA connection and renewal settings before searching.",
    });
  } finally {
    vi.unstubAllGlobals();
  }
});
it("limits FAA searches per user so one tenant cannot drain the shared key", async () => {
  const t = convexTest(schema, modules),
    s = demoSnapshot();
  const identity = await t.run(async (ctx) => {
    for (const a of s.aircraft) await ctx.db.insert("aircraft", a);
    await ctx.db.insert("programs", s.programs![0]);
    const group = await ctx.db.insert("groups", {
      programUuid: "demo-program",
      name: "FAA users",
      aircraftIds: [],
      permissions: ["read"],
    });
    const id = await ctx.db.insert("users", {
      active: true,
      isAdmin: false,
      name: "FAA user",
      activeProgramUuid: "demo-program",
      groupIds: [group],
    });
    const session = await ctx.db.insert("authSessions", {
      userId: id,
      expirationTime: Date.now() + 86400000,
    });
    return { subject: `${id}|${session}` };
  });
  const user = t.withIdentity(identity);
  for (let i = 0; i < 10; i++)
    await user.mutation(internal.faaSearch.reserve, {
      programUuid: "demo-program",
    });
  await expect(
    user.mutation(internal.faaSearch.reserve, { programUuid: "demo-program" }),
  ).rejects.toThrow(/Wait a minute/);
});

const DAY = 86400000;

// One DRS document, as the FAA lists a final rule.
const drsDocument = (n: number) => ({
  documentGuid: `ad-${n}`,
  "drs:documentNumber": `2026-01-${n}`,
  "drs:status": "Current",
  "drs:adfrawdSubject": "Inspect fittings",
  documentURL: "https://drs.faa.gov/test",
});

// A stubbed FAA answering every request with one page, after `first` runs.
function stubFaa(
  count: number,
  first: () => Promise<unknown> = async () => {},
) {
  const request = vi.fn<typeof fetch>().mockImplementation(async () => {
    await first();
    const documents = Array.from({ length: count }, (_, n) => drsDocument(n));
    return new Response(
      JSON.stringify({ summary: { hasMoreItems: false }, documents }),
    );
  });
  vi.stubGlobal("fetch", request);
  return request;
}

const shown = (message: string) => ({ name: "ConvexError", data: message });

it("shows the search's refusals as ConvexErrors, including one from the FAA search itself", async () => {
  const { t, editor, input, args } = await fixture();
  stubFaa(401);
  try {
    await expect(
      editor.action(api.faaSearch.search, args),
    ).rejects.toMatchObject(
      shown(
        "More than 400 matching documents. Narrow the aircraft/component search terms.",
      ),
    );
    await expect(
      editor.action(api.faaSearch.search, {
        ...args,
        payload: JSON.stringify({
          ...input,
          assets: [{ ...input.assets[0], id: "detached" }],
        }),
      }),
    ).rejects.toMatchObject(
      shown(
        "A selected component is no longer installed on this aircraft. Refresh the search form.",
      ),
    );
    await t.run(async (ctx) => {
      const credential = (await ctx.db.query("faaCredentials").unique())!;
      await ctx.db.patch(credential._id, {
        expiresOn: new Date().toISOString().slice(0, 10),
      });
    });
    await expect(
      editor.action(api.faaSearch.search, args),
    ).rejects.toMatchObject(shown("Renew the FAA API key before searching."));
  } finally {
    vi.unstubAllGlobals();
  }
});

it("checks access again after the FAA answers", async () => {
  const { t, editor, args } = await fixture();
  const request = stubFaa(1, () =>
    t.run(async (ctx) => {
      for (const group of await ctx.db.query("groups").collect())
        await ctx.db.patch(group._id, { permissions: ["read"] });
    }),
  );
  try {
    await expect(
      editor.action(api.faaSearch.search, args),
    ).rejects.toMatchObject(shown("Aircraft maintenance permission required."));
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("refuses past the global daily allowance, keeping the program's count unspent", async () => {
  const { t, editor } = await fixture();
  const now = Date.now();
  await t.run((ctx) =>
    ctx.db.insert("rateLimits", {
      key: "faa:global",
      windowStart: now - (now % DAY),
      count: FAA_GLOBAL_DAILY,
    }),
  );
  await expect(
    editor.mutation(internal.faaSearch.reserve, {
      programUuid: "demo-program",
    }),
  ).rejects.toMatchObject(
    shown("Today's FAA search allowance is used. Try again tomorrow."),
  );
  const keys = await t.run(async (ctx) =>
    (await ctx.db.query("rateLimits").collect()).map((r) => r.key),
  );
  expect(keys).toEqual(["faa:global"]);
});
