/**
 * Responsibility: Pins Google and Microsoft sign-in for existing accounts
 *   (ADR-0009): linking, refusals, disabled users, linked identities and the
 *   change log, and the password rules on create and reset.
 * Layer: Test. convex-test suite through the real sign-in library and HTTP
 *   routes, against stand-ins for the providers' endpoints; never shipped.
 * Dependencies: @convex-dev/auth, jose, convex (auth, admin, identities,
 *   schema), src/domain (signInMethods, passwordRules).
 */
import { convexTest } from "convex-test";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { exportPKCS8, generateKeyPair } from "jose";
import { createAccount } from "@convex-dev/auth/server";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  GOOGLE,
  MICROSOFT,
  MICROSOFT_PERSONAL_TENANT,
} from "../src/domain/signInMethods";
import {
  PASSWORD_COMMON_MESSAGE,
  PASSWORD_LENGTH_MESSAGE,
} from "../src/domain/passwordRules";

vi.setConfig({ testTimeout: 30_000 });
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);

const GOOGLE_METADATA = {
  issuer: "https://accounts.google.com",
  authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  token_endpoint: "https://oauth2.googleapis.com/token",
  userinfo_endpoint: "https://openidconnect.googleapis.com/v1/userinfo",
  jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["plain", "S256"],
  id_token_signing_alg_values_supported: ["RS256"],
};
// Microsoft's multi-tenant document: a templated issuer and no PKCE methods.
const MICROSOFT_METADATA = {
  issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
  authorization_endpoint:
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  token_endpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  userinfo_endpoint: "https://graph.microsoft.com/oidc/userinfo",
  jwks_uri: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
  response_types_supported: ["code", "id_token", "code id_token"],
  id_token_signing_alg_values_supported: ["RS256"],
};
const WORK_TENANT = "4f1c2b7a-0d3e-4b5c-9a8f-112233445566";

// Claims of the next ID token the stand-in token endpoint returns, and the
// last token request it received.
let idToken: Record<string, unknown> = {};
let tokenRequest: URLSearchParams | undefined;
const b64u = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
const part = (value: unknown) =>
  b64u(new TextEncoder().encode(JSON.stringify(value)));
const providerFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (url === "https://accounts.google.com/.well-known/openid-configuration")
    return Response.json(GOOGLE_METADATA);
  if (
    url ===
    "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration"
  )
    return Response.json(MICROSOFT_METADATA);
  if (
    url === GOOGLE_METADATA.token_endpoint ||
    url === MICROSOFT_METADATA.token_endpoint
  ) {
    tokenRequest = new URLSearchParams(String(init?.body ?? ""));
    return Response.json({
      access_token: "provider-access-token",
      token_type: "Bearer",
      expires_in: 3600,
      id_token: `${part({ alg: "RS256", typ: "JWT" })}.${part(idToken)}.c2ln`,
    });
  }
  return new Response("Not found", { status: 404 });
};

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  vi.stubEnv("JWT_PRIVATE_KEY", await exportPKCS8(privateKey));
  vi.stubEnv("CONVEX_SITE_URL", "https://test.convex.site");
  vi.stubEnv("SITE_URL", "https://app.example.test");
  vi.stubEnv("AUTH_GOOGLE_ID", "google-client");
  vi.stubEnv("AUTH_GOOGLE_SECRET", "google-secret");
  vi.stubEnv("AUTH_MICROSOFT_ENTRA_ID_ID", "microsoft-client");
  vi.stubEnv("AUTH_MICROSOFT_ENTRA_ID_SECRET", "microsoft-secret");
  vi.stubEnv(
    "AUTH_MICROSOFT_ENTRA_ID_ISSUER",
    "https://login.microsoftonline.com/common/v2.0",
  );
  vi.stubGlobal("fetch", providerFetch);
});
afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const PASSWORD = "correct-horse-battery-1";
const DAY_MS = 86_400_000;

/**
 * A signed-in system administrator, and a helper that provisions a password
 * account the supported way.
 */
async function fixture() {
  const t = convexTest(schema, modules);
  const admin = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", {
      name: "System administrator",
      email: "system@example.test",
      active: true,
      isAdmin: true,
      groupIds: [],
    });
    const session = await ctx.db.insert("authSessions", {
      userId: user,
      expirationTime: Date.now() + DAY_MS,
    });
    return { user, identity: { subject: `${user}|${session}` } };
  });
  const system = t.withIdentity(admin.identity);
  const provision = async (email: string) =>
    (await system.action(api.admin.createUser, {
      email,
      name: "Pat Pilot",
      password: PASSWORD,
    })) as Id<"users">;
  return { t, system, adminId: admin.user, provision };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const issuers: Record<string, (claims: Record<string, unknown>) => string> = {
  [GOOGLE]: () => "https://accounts.google.com",
  [MICROSOFT]: (claims) =>
    `https://login.microsoftonline.com/${String(claims.tid)}/v2.0`,
};
const audiences: Record<string, string> = {
  [GOOGLE]: "google-client",
  [MICROSOFT]: "microsoft-client",
};

/** One sign-in through the provider, as a browser makes it: start, the
 * library's redirect route, the provider's answer to the callback route, then
 * the one-time code exchange when one was issued. */
async function sso(
  { t }: Fixture,
  provider: string,
  claims: Record<string, unknown>,
) {
  const start = (await t.action(api.auth.signIn, { provider })) as {
    redirect: string;
    verifier: string;
  };
  const begin = new URL(start.redirect);
  const toProvider = await t.fetch(begin.pathname + begin.search);
  expect(toProvider.status).toBe(302);
  const authorize = new URL(toProvider.headers.get("Location")!);
  const cookie = toProvider.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const now = Math.floor(Date.now() / 1000);
  const nonce = authorize.searchParams.get("nonce");
  idToken = {
    iss: issuers[provider](claims),
    aud: audiences[provider],
    iat: now,
    exp: now + 600,
    ...(nonce ? { nonce } : {}),
    ...claims,
  };
  tokenRequest = undefined;
  const back = await t.fetch(
    `/api/auth/callback/${provider}?code=provider-code`,
    { headers: { Cookie: cookie } },
  );
  expect(back.status).toBe(302);
  const location = new URL(back.headers.get("Location")!);
  const code = location.searchParams.get("code");
  const exchange = () =>
    t.action(api.auth.signIn, {
      params: { code },
      verifier: start.verifier,
    }) as Promise<{ tokens: { token: string } | null }>;
  return { authorize, location, code, exchange };
}
async function signedIn(f: Fixture, provider: string, claims: object) {
  const result = await sso(f, provider, claims as Record<string, unknown>);
  expect(result.location.searchParams.get("signInError")).toBeNull();
  expect(result.code).toBeTruthy();
  const { tokens } = await result.exchange();
  expect(tokens?.token).toBeTruthy();
  return result;
}
async function refused(f: Fixture, provider: string, claims: object) {
  const result = await sso(f, provider, claims as Record<string, unknown>);
  expect(result.code).toBeNull();
  return result.location;
}
const passwordSignIn = (f: Fixture, email: string, password = PASSWORD) =>
  f.t.action(api.auth.signIn, {
    provider: "password",
    params: { flow: "signIn", email, password },
  }) as Promise<{ tokens: { token: string } | null }>;
const rows = (f: Fixture) =>
  f.t.run(async (ctx) => ({
    users: await ctx.db.query("users").collect(),
    accounts: await ctx.db.query("authAccounts").collect(),
    sessions: await ctx.db.query("authSessions").collect(),
    codes: await ctx.db.query("authVerificationCodes").collect(),
    audit: await ctx.db.query("audit").collect(),
  }));
const ssoAccounts = (f: Fixture) =>
  rows(f).then((r) => r.accounts.filter((a) => a.provider !== "password"));

it("refuses an email with no account, writing nothing but the change-log entry", async () => {
  const f = await fixture();
  await f.provision("pilot@example.test");
  const before = await rows(f);
  const location = await refused(f, GOOGLE, {
    sub: "google-stranger",
    email: "Nobody@Example.test",
    email_verified: true,
  });
  expect(location.origin).toBe("https://app.example.test");
  expect(location.searchParams.get("signInError")).toBe("account");
  expect(location.searchParams.get("signInProvider")).toBe(GOOGLE);
  const after = await rows(f);
  expect(after.users).toEqual(before.users);
  expect(after.accounts).toEqual(before.accounts);
  expect(after.sessions).toEqual(before.sessions);
  expect(after.codes).toHaveLength(0);
  const added = after.audit.slice(before.audit.length);
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({
    action: "user.sign_in_refused",
    actorId: "system",
    entityUuid: "google:google-stranger",
  });
  expect(JSON.parse(added[0].after!)).toEqual({
    method: GOOGLE,
    reason: "no_account",
    email: "nobody@example.test",
  });
  // No token or secret reaches the change log.
  expect(JSON.stringify(after.audit)).not.toMatch(/provider-access-token|c2ln/);
});

it("links a verified Google email to the one active user with it, and logs the link and the sign-in", async () => {
  const f = await fixture();
  const pilot = await f.provision("pilot@example.test");
  const before = (await rows(f)).users.find((u) => u._id === pilot);
  await signedIn(f, GOOGLE, {
    sub: "google-pat",
    email: "Pilot@Example.test",
    email_verified: true,
    name: "Somebody Else",
  });
  const after = await rows(f);
  // The user is the administrator's, untouched; no user was created.
  expect(after.users.find((u) => u._id === pilot)).toEqual(before);
  expect(after.users).toHaveLength(2);
  expect(await ssoAccounts(f)).toMatchObject([
    {
      userId: pilot,
      provider: GOOGLE,
      providerAccountId: "google-pat",
      emailVerified: "pilot@example.test",
    },
  ]);
  expect(
    after.sessions.filter((s) => s.userId === pilot).length,
  ).toBeGreaterThan(0);
  const linked = after.audit.find((a) => a.action === "user.identity_linked");
  expect(linked).toMatchObject({ actorId: pilot, entityUuid: pilot });
  expect(JSON.parse(linked!.after!)).toEqual({
    provider: GOOGLE,
    email: "pilot@example.test",
  });
  const signIns = after.audit.filter((a) => a.action === "user.signed_in");
  expect(signIns.map((a) => [a.actorId, JSON.parse(a.after!)])).toEqual([
    [pilot, { method: GOOGLE }],
  ]);
  expect(await f.t.query(api.identities.providers, {})).toEqual([
    GOOGLE,
    MICROSOFT,
  ]);
});

it("refuses an unverified Google email and a Microsoft work email without xms_edov", async () => {
  const f = await fixture();
  await f.provision("pilot@example.test");
  const google = await refused(f, GOOGLE, {
    sub: "google-unverified",
    email: "pilot@example.test",
    email_verified: false,
  });
  expect(google.searchParams.get("signInError")).toBe("unverified");
  const microsoft = await refused(f, MICROSOFT, {
    sub: "ms-work",
    tid: WORK_TENANT,
    email: "pilot@example.test",
  });
  expect(microsoft.searchParams.get("signInError")).toBe("unverified");
  expect(microsoft.searchParams.get("signInProvider")).toBe(MICROSOFT);
  const r = await rows(f);
  expect(await ssoAccounts(f)).toHaveLength(0);
  expect(
    r.audit
      .filter((a) => a.action === "user.sign_in_refused")
      .map((a) => JSON.parse(a.after!).reason),
  ).toEqual(["email_not_verified", "email_not_verified"]);
});

it("accepts Microsoft personal accounts and domain-verified work accounts, with PKCE and the token's own tenant", async () => {
  const f = await fixture();
  const personal = await f.provision("pat@outlook.test");
  const work = await f.provision("pat@company.test");
  const first = await signedIn(f, MICROSOFT, {
    sub: "ms-personal",
    tid: MICROSOFT_PERSONAL_TENANT,
    email: "Pat@Outlook.test",
  });
  // Microsoft does not list PKCE, but the request carries it and the token
  // request proves it (convex-auth #457).
  const challenge = first.authorize.searchParams.get("code_challenge");
  expect(challenge).toBeTruthy();
  const verifier = tokenRequest?.get("code_verifier");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier!)),
  );
  expect(b64u(digest)).toBe(challenge);
  expect(first.authorize.searchParams.get("scope")).toBe(
    "openid profile email",
  );
  await signedIn(f, MICROSOFT, {
    sub: "ms-work",
    tid: WORK_TENANT,
    email: "pat@company.test",
    xms_edov: true,
  });
  expect(
    (await ssoAccounts(f)).map((a) => [a.userId, a.providerAccountId]),
  ).toEqual([
    [personal, "ms-personal"],
    [work, "ms-work"],
  ]);
  // A token naming another tenant than its own is not accepted.
  const before = await rows(f);
  const location = await refused(f, MICROSOFT, {
    sub: "ms-mixup",
    tid: WORK_TENANT,
    iss: `https://login.microsoftonline.com/${MICROSOFT_PERSONAL_TENANT}/v2.0`,
    email: "pat@company.test",
    xms_edov: true,
  });
  expect(location.searchParams.get("signInError")).toBe("failed");
  const after = await rows(f);
  expect(after.accounts).toEqual(before.accounts);
  expect(after.audit).toEqual(before.audit);
});

it("matches a linked identity by the provider's account id, even after its email changes", async () => {
  const f = await fixture();
  const pilot = await f.provision("pilot@example.test");
  const other = await f.provision("other@example.test");
  await signedIn(f, GOOGLE, {
    sub: "google-pat",
    email: "pilot@example.test",
    email_verified: true,
  });
  // The Google account now reports another user's email, unverified even.
  await signedIn(f, GOOGLE, {
    sub: "google-pat",
    email: "other@example.test",
    email_verified: false,
  });
  const r = await rows(f);
  const sessions = r.sessions.filter((s) => s.userId === pilot);
  expect(sessions.length).toBeGreaterThan(0);
  expect(r.sessions.filter((s) => s.userId === other)).toHaveLength(0);
  expect(await ssoAccounts(f)).toHaveLength(1);
  expect(
    r.audit.filter((a) => a.action === "user.identity_linked"),
  ).toHaveLength(1);
  expect(
    r.audit.filter((a) => a.action === "user.signed_in").map((a) => a.actorId),
  ).toEqual([pilot, pilot]);
});

it("refuses a disabled user by every sign-in method", async () => {
  const f = await fixture();
  const pilot = await f.provision("pilot@example.test");
  await signedIn(f, GOOGLE, {
    sub: "google-pat",
    email: "pilot@example.test",
    email_verified: true,
  });
  // Started while the user is active, disabled before the code is redeemed.
  const pending = await sso(f, GOOGLE, {
    sub: "google-pat",
    email: "pilot@example.test",
    email_verified: true,
  });
  expect(pending.code).toBeTruthy();
  await f.system.mutation(api.admin.updateUser, {
    id: pilot,
    active: false,
    isAdmin: false,
    groupIds: [],
  });
  await expect(pending.exchange()).rejects.toThrow();
  await expect(passwordSignIn(f, "pilot@example.test")).rejects.toThrow();
  const google = await refused(f, GOOGLE, {
    sub: "google-pat",
    email: "pilot@example.test",
    email_verified: true,
  });
  expect(google.searchParams.get("signInError")).toBe("account");
  const microsoft = await refused(f, MICROSOFT, {
    sub: "ms-pat",
    tid: MICROSOFT_PERSONAL_TENANT,
    email: "pilot@example.test",
  });
  expect(microsoft.searchParams.get("signInError")).toBe("account");
  const r = await rows(f);
  expect(r.sessions.filter((s) => s.userId === pilot)).toHaveLength(0);
  expect(
    r.audit
      .filter((a) => a.action === "user.sign_in_refused")
      .map((a) => [a.entityUuid, JSON.parse(a.after!).reason]),
  ).toEqual([
    [pilot, "disabled"],
    [pilot, "disabled"],
  ]);
});

it("logs password sign-ins with their method, but not token refreshes", async () => {
  const f = await fixture();
  const pilot = await f.provision("pilot@example.test");
  const { tokens } = (await passwordSignIn(f, "pilot@example.test")) as {
    tokens: { token: string; refreshToken: string };
  };
  await f.t.action(api.auth.signIn, { refreshToken: tokens.refreshToken });
  const signIns = (await rows(f)).audit.filter(
    (a) => a.action === "user.signed_in",
  );
  expect(signIns.map((a) => [a.actorId, JSON.parse(a.after!)])).toEqual([
    [pilot, { method: "password" }],
  ]);
});

it("shows linked identities to their user and to system administrators, who can remove them", async () => {
  const f = await fixture();
  const pilot = await f.provision("pilot@example.test");
  await signedIn(f, GOOGLE, {
    sub: "google-pat",
    email: "pilot@example.test",
    email_verified: true,
  });
  const session = (await rows(f)).sessions.find((s) => s.userId === pilot)!;
  const asPilot = f.t.withIdentity({ subject: `${pilot}|${session._id}` });
  const mine = await asPilot.query(api.identities.mine, {});
  expect(mine).toMatchObject([
    { provider: GOOGLE, email: "pilot@example.test" },
  ]);
  expect(
    await f.system.query(api.identities.forUser, { userId: pilot }),
  ).toEqual(mine);
  await expect(
    asPilot.query(api.identities.forUser, { userId: pilot }),
  ).rejects.toThrow(/Administrator/);
  await expect(
    asPilot.mutation(api.identities.remove, { userId: pilot, id: mine[0].id }),
  ).rejects.toThrow(/Administrator/);
  // The password login is not a linked identity and cannot be removed here.
  const password = (await rows(f)).accounts.find(
    (a) => a.userId === pilot && a.provider === "password",
  )!;
  await expect(
    f.system.mutation(api.identities.remove, {
      userId: pilot,
      id: password._id,
    }),
  ).rejects.toThrow(/not found/);
  await f.system.mutation(api.identities.remove, {
    userId: pilot,
    id: mine[0].id,
  });
  expect(await ssoAccounts(f)).toHaveLength(0);
  const entry = (await rows(f)).audit.find(
    (a) => a.action === "user.identity_removed",
  );
  expect(entry).toMatchObject({ actorId: f.adminId, entityUuid: pilot });
  expect(JSON.parse(entry!.before!)).toMatchObject({
    provider: GOOGLE,
    email: "pilot@example.test",
  });
});

it("refuses short and common passwords when an administrator creates or resets one", async () => {
  const f = await fixture();
  const message = (p: Promise<unknown>) =>
    p.then(
      () => "",
      (e: Error) => e.message,
    );
  const create = (password: string) =>
    message(
      f.system.action(api.admin.createUser, {
        email: "new@example.test",
        name: "New user",
        password,
      }),
    );
  expect(await create("fourteen-chars")).toBe(PASSWORD_LENGTH_MESSAGE);
  expect(await create("123456789012345")).toBe(PASSWORD_COMMON_MESSAGE);
  expect(await create("PasswordPassword")).toBe(PASSWORD_COMMON_MESSAGE);
  expect((await rows(f)).users).toHaveLength(1);
  const pilot = await f.provision("pilot@example.test");
  const reset = (password: string) =>
    message(f.system.action(api.admin.resetPassword, { id: pilot, password }));
  expect(await reset("short-pass-1")).toBe(PASSWORD_LENGTH_MESSAGE);
  expect(await reset("qwertyuiopasdfgh")).toBe(PASSWORD_COMMON_MESSAGE);
  expect(await reset("xx-pilot@example.test-xx")).toBe(PASSWORD_COMMON_MESSAGE);
  expect((await passwordSignIn(f, "pilot@example.test")).tokens).toBeTruthy();
  await f.system.action(api.admin.resetPassword, {
    id: pilot,
    password: "a long unusual phrase",
  });
  expect(
    (await passwordSignIn(f, "pilot@example.test", "a long unusual phrase"))
      .tokens,
  ).toBeTruthy();
});

it("keeps an existing shorter password working until its next reset", async () => {
  const f = await fixture();
  const { user } = await f.t.action(async (ctx) =>
    createAccount(ctx, {
      provider: "password",
      account: { id: "legacy@example.test", secret: "twelve-chars" },
      profile: {
        email: "legacy@example.test",
        name: "Legacy",
        active: true,
        isAdmin: false,
        groupIds: [],
      },
    }),
  );
  expect(user.email).toBe("legacy@example.test");
  expect(
    (await passwordSignIn(f, "legacy@example.test", "twelve-chars")).tokens,
  ).toBeTruthy();
});
