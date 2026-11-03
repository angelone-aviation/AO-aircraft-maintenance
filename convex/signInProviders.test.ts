// Without a sign-in client's credentials the provider does not exist: the app
// runs password-only until the organization configures Google or Microsoft.
import { convexTest } from "convex-test";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import {
  EXPECTED_ISSUER,
  enabledSsoProviders,
  microsoftTenantIssuer,
} from "./ssoProviders";
import { MICROSOFT_PERSONAL_TENANT } from "../src/domain/signInMethods";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
beforeAll(() => {
  vi.stubEnv("CONVEX_SITE_URL", "https://test.convex.site");
  vi.stubEnv("SITE_URL", "https://app.example.test");
  // Half-configured counts as not configured.
  vi.stubEnv("AUTH_GOOGLE_ID", "google-client");
  vi.stubEnv("AUTH_GOOGLE_SECRET", "");
  vi.stubEnv("AUTH_MICROSOFT_ENTRA_ID_ID", "microsoft-client");
  vi.stubEnv("AUTH_MICROSOFT_ENTRA_ID_SECRET", "microsoft-secret");
  vi.stubEnv("AUTH_MICROSOFT_ENTRA_ID_ISSUER", "");
});
afterAll(() => vi.unstubAllEnvs());

it("offers no Google or Microsoft sign-in until both are configured", async () => {
  const t = convexTest(schema, modules);
  expect(await t.query(api.identities.providers, {})).toEqual([]);
  for (const provider of ["google", "microsoft-entra-id"])
    await expect(t.action(api.auth.signIn, { provider })).rejects.toThrow(
      /not configured/,
    );
  // Nor do their routes exist.
  expect(
    (await t.fetch("/api/auth/callback/google?code=x", { method: "GET" }))
      .status,
  ).toBe(404);
  expect(await t.run((ctx) => ctx.db.query("authVerifiers").collect())).toEqual(
    [],
  );
});

it("enables each provider only with all of its credentials", () => {
  expect(enabledSsoProviders({})).toEqual([]);
  expect(
    enabledSsoProviders({ AUTH_GOOGLE_ID: "id", AUTH_GOOGLE_SECRET: "secret" }),
  ).toEqual(["google"]);
  expect(
    enabledSsoProviders({
      AUTH_MICROSOFT_ENTRA_ID_ID: "id",
      AUTH_MICROSOFT_ENTRA_ID_SECRET: "secret",
      AUTH_MICROSOFT_ENTRA_ID_ISSUER:
        "https://login.microsoftonline.com/common/v2.0",
    }),
  ).toEqual(["microsoft-entra-id"]);
  expect(
    enabledSsoProviders({
      AUTH_MICROSOFT_ENTRA_ID_ID: "id",
      AUTH_MICROSOFT_ENTRA_ID_SECRET: " ",
      AUTH_MICROSOFT_ENTRA_ID_ISSUER:
        "https://login.microsoftonline.com/common/v2.0",
    }),
  ).toEqual([]);
});

it("expects a Microsoft token's issuer from its own tenant", () => {
  // The hook Microsoft multi-tenant sign-in relies on; a dependency update
  // that drops it must fail here, not at the first real sign-in.
  expect(typeof EXPECTED_ISSUER).toBe("symbol");
  expect(microsoftTenantIssuer({ tid: MICROSOFT_PERSONAL_TENANT })).toBe(
    `https://login.microsoftonline.com/${MICROSOFT_PERSONAL_TENANT}/v2.0`,
  );
  expect(microsoftTenantIssuer({ tid: "common" })).toBeUndefined();
  expect(microsoftTenantIssuer({ tid: "../evil" })).toBeUndefined();
  expect(microsoftTenantIssuer({})).toBeUndefined();
});
