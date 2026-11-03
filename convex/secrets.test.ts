/**
 * Responsibility: Pins credential sealing: v1 and v2 formats, the binding to
 *   table, program and field, key rotation, configuration errors, and the
 *   migration that re-seals old values.
 * Layer: Test. Vitest and convex-test suite; never shipped in the build.
 * Dependencies: convex/secrets.ts, convex/schema.ts, convex/_generated,
 *   src/data/demo.ts (fixture).
 */
import { convexTest } from "convex-test";
import { afterEach, expect, it, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import {
  activeKeyId,
  isSealed,
  needsReseal,
  openSecret,
  sealSecret,
  SEALED_V2,
  type SecretContext,
} from "./secrets";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const K1 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const K2 = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=";
const faa: SecretContext = {
  table: "faaCredentials",
  programUuid: "",
  field: "key",
};
const spruce = (programUuid: string, field: string): SecretContext => ({
  table: "spruceAccounts",
  programUuid,
  field,
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
// The pre-v2 format: AES-GCM without additional data, `enc:v1:<iv>:<data>`.
async function sealV1(plain: string, rawKey = K1) {
  const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(rawKey), (c) => c.charCodeAt(0)),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plain),
  );
  return `enc:v1:${b64(iv)}:${b64(new Uint8Array(data))}`;
}

it("still opens v1 values sealed with the original key", async () => {
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", K1);
  expect(await openSecret(await sealV1("legacy-secret"), faa)).toBe(
    "legacy-secret",
  );
});

it("opens a v2 value sealed by an earlier release", async () => {
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", K1);
  const stored =
    "enc:v2:k1:USfuXPteXSoUsAxW:px6cnPx1olZ0UfP/HWwXYy/Pe0hF/7nXCvc=";
  expect(await openSecret(stored, spruce("a", "apikey"))).toBe("golden-key");
});

it("round-trips v2 values bound to their table, program and field", async () => {
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", K1);
  const sealed = await sealSecret("private-key", spruce("a", "apikey"));
  expect(sealed).toMatch(/^enc:v2:k1:/);
  expect(sealed).not.toContain("private");
  expect(await openSecret(sealed, spruce("a", "apikey"))).toBe("private-key");
  // Moved to another program, another field or another table: rejected.
  for (const elsewhere of [
    spruce("b", "apikey"),
    spruce("a", "password"),
    { ...faa },
  ])
    await expect(openSecret(sealed, elsewhere)).rejects.toThrow(
      /could not be decrypted/,
    );
});

it("seals with the active key id and still opens values under retired-but-present keys", async () => {
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", K1);
  const old = await sealSecret("rotated", faa);
  const v1 = await sealV1("older");
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEYS", `k2=${K2}`);
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY_ID", "k2");
  const fresh = await sealSecret("rotated", faa);
  expect(fresh).toMatch(/^enc:v2:k2:/);
  expect(await openSecret(fresh, faa)).toBe("rotated");
  expect(await openSecret(old, faa)).toBe("rotated");
  expect(await openSecret(v1, faa)).toBe("older");
  // Once k1 is retired its values no longer open.
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", "");
  await expect(openSecret(old, faa)).rejects.toThrow(/key k1/);
  expect(await openSecret(fresh, faa)).toBe("rotated");
});

it("rejects unprefixed values unless legacy plaintext is explicitly allowed", async () => {
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", K1);
  await expect(openSecret("plain", faa)).rejects.toThrow(/not encrypted/);
  expect(await openSecret("plain", faa, { legacyPlaintext: true })).toBe(
    "plain",
  );
});

it("tells sealed values from plaintext, and which ones need re-sealing", async () => {
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", K1);
  const v1 = await sealV1("older");
  const k1 = await sealSecret("current", faa);
  expect(k1).toMatch(SEALED_V2);
  expect([v1, k1, "plain"].map(isSealed)).toEqual([true, true, false]);
  expect([v1, k1, "plain"].map(needsReseal)).toEqual([true, false, true]);
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEYS", `k2=${K2}`);
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY_ID", " k2 ");
  expect(activeKeyId()).toBe("k2");
  expect(needsReseal(k1)).toBe(true);
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY_ID", " ");
  expect(activeKeyId()).toBe("k1");
});

it("names the misconfigured key setting", async () => {
  const seal = () => sealSecret("value", faa);
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", "");
  await expect(seal()).rejects.toThrow(
    "Credential encryption is not configured. Set CREDENTIALS_ENCRYPTION_KEY in the Convex environment (see README) before saving third-party credentials.",
  );
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", btoa("too short"));
  await expect(seal()).rejects.toThrow(
    "Credential encryption key k1 must be 32 random bytes, base64-encoded.",
  );
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", K1);
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY_ID", "k2");
  await expect(seal()).rejects.toThrow(
    "Credential encryption key k2 is not configured (see docs/runbooks/credentials-key.md).",
  );
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY_ID", "K2");
  expect(activeKeyId).toThrow(
    "CREDENTIALS_ENCRYPTION_KEY_ID must be a short lowercase key id.",
  );
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY_ID", "");
  for (const keys of ["k2", `k1=${K2}`, `K2=${K2}`, `k2=${K2},k2=${K2}`]) {
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEYS", keys);
    await expect(seal()).rejects.toThrow(
      "CREDENTIALS_ENCRYPTION_KEYS must list distinct key ids as id=base64 pairs (see docs/runbooks/credentials-key.md).",
    );
  }
});

it("warns on accepted plaintext without logging the value", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await openSecret("hunter2", faa, { legacyPlaintext: true });
    expect(warn).toHaveBeenCalledWith(
      "Unencrypted legacy credential read from faaCredentials.key; run secretsMigration:reseal.",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("hunter2");
  } finally {
    warn.mockRestore();
  }
});

it("re-seals v1 and plaintext rows to v2, then refuses plaintext", async () => {
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", K1);
  const t = convexTest(schema, modules);
  const identity = await t.run(async (ctx) => {
    await ctx.db.insert("programs", demoSnapshot().programs![0]);
    await ctx.db.insert("faaCredentials", {
      key: "faa-plaintext",
      expiresOn: "2099-01-01",
      version: 1,
      updatedAt: 0,
    });
    await ctx.db.insert("addressVerificationSettings", {
      key: await sealV1("geoapify-v1-key"),
      version: 1,
      day: "",
      used: 0,
      lastLookupAt: 0,
    });
    await ctx.db.insert("spruceAccounts", {
      programUuid: "demo-program",
      version: 1,
      credentials: {
        userid: await sealV1("spruce-user"),
        password: "spruce-plaintext-password",
        apikey: await sealSecret(
          "spruce-key",
          spruce("demo-program", "apikey"),
        ),
        currency: "USD",
      },
    });
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
  });
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ results: [] })));
  vi.stubGlobal("fetch", fetcher);
  const result = await t.action(internal.secretsMigration.reseal, {});
  expect(result).toEqual({ resealed: 4, remaining: 0, complete: true });
  const rows = await t.run(async (ctx) => ({
    faa: (await ctx.db.query("faaCredentials").unique())!.key!,
    address: (await ctx.db.query("addressVerificationSettings").unique())!.key!,
    spruce: (await ctx.db.query("spruceAccounts").unique())!.credentials!,
  }));
  for (const value of [
    rows.faa,
    rows.address,
    rows.spruce.userid,
    rows.spruce.password,
    rows.spruce.apikey,
  ])
    expect(value).toMatch(/^enc:v2:k1:/);
  expect(await openSecret(rows.faa, faa)).toBe("faa-plaintext");
  expect(
    await openSecret(rows.address, {
      table: "addressVerificationSettings",
      programUuid: "",
      field: "key",
    }),
  ).toBe("geoapify-v1-key");
  expect(
    await openSecret(rows.spruce.password, spruce("demo-program", "password")),
  ).toBe("spruce-plaintext-password");
  expect(
    await openSecret(rows.spruce.userid, spruce("demo-program", "userid")),
  ).toBe("spruce-user");
  // Running again changes nothing.
  expect(await t.action(internal.secretsMigration.reseal, {})).toEqual({
    resealed: 0,
    remaining: 0,
    complete: true,
  });
  // After the migration, a plaintext value written behind the app's back is refused.
  await t.run(async (ctx) => {
    const row = (await ctx.db.query("addressVerificationSettings").unique())!;
    await ctx.db.patch(row._id, { key: "injected-plaintext-key" });
  });
  await expect(
    t.withIdentity(identity).action(api.addressVerification.lookup, {
      payload: JSON.stringify({
        street: "1600 Pennsylvania Avenue NW",
        city: "Washington",
        region: "DC",
        postalCode: "20500",
        country: "United States",
      }),
      programUuid: "demo-program",
    }),
  ).rejects.toThrow(/not encrypted/);
  expect(fetcher).not.toHaveBeenCalled();
});
