import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { it, expect, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import { blankSearch, searchAssets } from "../src/domain/faaSearch";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
it("authorizes FAA search by aircraft, rejects detached components, and imports selected results for review", async () => {
  const t = convexTest(schema, modules),
    s = demoSnapshot();
  const ids = await t.run(async (ctx) => {
    for (const a of s.aircraft) await ctx.db.insert("aircraft", a);
    await ctx.db.insert("programs", s.programs![0]);
    await ctx.db.insert("faaCredentials", {
      key: "synthetic-key",
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
