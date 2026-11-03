import { convexTest } from "convex-test";
import { it, expect, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { openSecret } from "./secrets";
import { FAA_SECRET } from "./faaCredentials";
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
