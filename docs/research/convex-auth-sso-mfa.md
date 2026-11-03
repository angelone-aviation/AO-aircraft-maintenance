# Convex Auth: Google/Microsoft SSO and MFA with admin-only accounts

Researched 2026-11-01 against primary sources only. App today: `@convex-dev/auth` ^0.0.95, Password provider only, signup blocked in `profile()`, admins provision via `createAccount`, `session.totalDurationMs` = 7 days, no MFA.

## Summary

Convex Auth wraps Auth.js provider configs, so Google and Microsoft Entra ID OAuth are usable now (Google officially supported; Entra "unsupported but works", with one open PKCE issue). Admin-only gating is straightforward: supply `callbacks.createOrUpdateUser`, which replaces the library's user creation entirely, look up the pre-created user by email, and throw when none exists. Organization restriction is done by a single-tenant Entra issuer and by checking Google's `hd` claim in the provider `profile()` override. Convex Auth has no native MFA (TOTP/passkeys are only draft PRs in the WIP v2 branch), so the realistic MFA path is to let Google Workspace / Entra enforce it at the IdP and retire password sign-in for non-admin users. Convex Auth is still beta, with two High advisories in the last three months (fixed in 0.0.95/0.0.96); the app must upgrade to 0.0.96 regardless.

## Facts table

| Capability | Supported? | How | Source |
|---|---|---|---|
| Google OAuth | Yes (official) | `providers: [Google]`, `AUTH_GOOGLE_ID/SECRET`, redirect `https://<dep>.convex.site/api/auth/callback/google` | https://labs.convex.dev/auth/config/oauth/google |
| Microsoft Entra ID OAuth | Works, unsupported by Convex | Auth.js `MicrosoftEntraID` provider id `microsoft-entra-id`; `AUTH_MICROSOFT_ENTRA_ID_ID/SECRET/ISSUER` | https://labs.convex.dev/auth/config/oauth ; https://authjs.dev/getting-started/providers/microsoft-entra-id |
| Provider auth params (e.g. `hd`) | Yes | `provider.authorization.params` spread into the authorize URL | https://github.com/convex/convex-auth/blob/main/src/server/oauth/authorizationUrl.ts |
| Reject unknown email | Yes | `callbacks.createOrUpdateUser` throws; default create/link skipped | https://labs.convex.dev/auth/api_reference/server |
| Link OAuth to existing password user | Yes | Default: trusted method + exactly one user with `emailVerificationTime`; or do it yourself in `createOrUpdateUser` | https://labs.convex.dev/auth/advanced ; `src/server/implementation/users.ts` |
| Native MFA / TOTP / passkeys | No | Only draft PRs (#352, #441, #633, #652) on v2 branch; TOTP made internal (#766) | https://github.com/convex/convex-auth/issues/77 |
| Session config | Yes | `session.totalDurationMs` (30d default), `inactiveDurationMs` (30d), `jwt.durationMs` (1h) | https://labs.convex.dev/auth/api_reference/server |
| Audit data | Partial | `authSessions`, `authAccounts`, `authRefreshTokens` tables; no IP/UA/provider-of-session | `src/server/implementation/types.ts` |
| Status | Beta, v0.0.96 | "may change in backward-incompatible ways"; 186 stars, 201 open issues, pushed 2026-10-29 | https://docs.convex.dev/auth ; https://registry.npmjs.org/@convex-dev/auth/latest |

## 1. OAuth support and wiring

Convex Auth documents GitHub, Google and Apple; other Auth.js providers "can be tried" without support ([oauth](https://labs.convex.dev/auth/config/oauth)). The callback origin is the HTTP Actions URL (`.convex.site`), path `/api/auth/callback/<providerId>` ([google](https://labs.convex.dev/auth/config/oauth/google)). `SITE_URL` "is used when redirecting back to your site during OAuth sign-in" ([manual setup](https://labs.convex.dev/auth/setup/manual)); `scripts/configure-auth.mjs` already sets it.

Env vars (Auth.js naming): `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` ([google](https://labs.convex.dev/auth/config/oauth/google)); `AUTH_MICROSOFT_ENTRA_ID_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_ISSUER="https://login.microsoftonline.com/<tenant id>/v2.0"` ([authjs entra](https://authjs.dev/getting-started/providers/microsoft-entra-id)). The Entra provider's issuer defaults to `/common/v2.0` (any account) if unset; its default scope is `openid profile email User.Read` and `email` is mapped only from the `email` claim ([source](https://github.com/nextauthjs/next-auth/blob/main/packages/core/src/providers/microsoft-entra-id.ts)).

Known Entra bug: issue [#457](https://github.com/convex/convex-auth/issues/457) (open, 2026-08) reports AADSTS501481 because a "decoy" code verifier is sent when discovery omits PKCE; `authorizationUrl.ts` skips PKCE for discovered OIDC providers that do not list S256 and falls back to nonce. Test against the real tenant early.

## 2. Gating and linking

Default linking: OAuth is "trusted" unless `allowDangerousEmailAccountLinking: false`; a trusted sign-in links to a user only when exactly one user has that email with `emailVerificationTime` set ([advanced](https://labs.convex.dev/auth/advanced); `users.ts`: `uniqueUserWithVerifiedEmail`). Admin-created password users have no `emailVerificationTime` today, so default linking would create a duplicate user. Fix by setting `emailVerificationTime` on admin-created users, or by owning linking entirely:

```ts
// adapted from labs.convex.dev/auth/advanced "createOrUpdateUser"
callbacks: {
  async createOrUpdateUser(ctx, args) {
    if (args.existingUserId) return args.existingUserId;
    const email = String(args.profile.email ?? "").toLowerCase();
    const user = await ctx.db.query("users").withIndex("email", q => q.eq("email", email)).unique();
    if (!user) throw new Error("Accounts are managed by your administrator.");
    return user._id;
  },
},
```

The callback is called with no try/catch, so throwing aborts the sign-in before any account or token is written (`users.ts`). The `profile` it receives is whatever the provider's `profile()` returned minus `id` (`implementation/index.ts`), so put claim checks (below) in `profile()`.

Email-verification pitfalls: Convex Auth never reads `email_verified` itself; `profile.emailVerified` wins if set, otherwise OAuth is assumed verified (`users.ts`). Google supplies `email_verified` ([Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect)). Microsoft says the `email` claim "isn't guaranteed to be correct and is mutable over time. Never use it for authorization" ([id-token claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference)); the optional `xms_edov` claim indicates a domain-verified email ([optional claims](https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference)). With a single-tenant issuer the risk is bounded to your own tenant admins, which is acceptable here; still prefer linking on first sign-in and then relying on `authAccounts.providerAccountId` (`sub`).

## 3. Restricting to the organization

Google: pass `hd` to pre-select the Workspace domain, but "Don't rely on this UI optimization to control who can access your app ... validate that the returned ID token has an hd claim value that matches" ([Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect)). Convex Auth spreads `provider.authorization.params` into the authorize URL and, for OIDC, passes the ID-token claims to `profile()` (`authorizationUrl.ts`, `callback.ts`):

```ts
Google({
  authorization: { params: { hd: "example.com" } },
  profile(p) {
    if (p.hd !== "example.com" || p.email_verified !== true) throw new Error("Unauthorized domain");
    return { id: p.sub, name: p.name, email: p.email, image: p.picture, emailVerified: true };
  },
}),
```

Microsoft: register the app as "Accounts in this organizational directory only" (single tenant) and set the tenant-ID issuer; single-tenant apps "are only available in the tenant they were registered in" ([single/multi-tenant](https://learn.microsoft.com/en-us/entra/identity-platform/single-and-multi-tenant-apps)). Microsoft also says to validate `tid` and identify users by `oid`/`sub`, never `email` ([claims validation](https://learn.microsoft.com/en-us/entra/identity-platform/claims-validation)); add a `tid` check in `profile()` as defense in depth.

## 4. MFA

Convex Auth lists only magic links/OTP, OAuth and passwords; MFA/passkeys appear nowhere in the docs ([intro](https://labs.convex.dev/auth)). Issue #77 "Passkey support?" (2024) is still open; TOTP/passkey work exists only as draft PRs on the v2 "reboot" branch, and PR #766 made the TOTP component internal ([search](https://github.com/convex/convex-auth/issues?q=passkey+OR+TOTP)). Convex's own guidance: third-party providers add "passkeys, two-factor auth" and Convex Auth "doesn't provide as many features" ([docs.convex.dev/auth](https://docs.convex.dev/auth)).

Options:
- (a) IdP-enforced MFA. Google Workspace admins enforce 2-Step Verification per OU, including "Only security key" (keys and passkeys) ([Workspace 2SV](https://knowledge.workspace.google.com/admin/security/deploy-2-step-verification)). Entra: security defaults give app-based MFA on the free tier; Conditional Access "Require MFA for all users" needs P1 ([licensing](https://learn.microsoft.com/en-us/entra/identity/authentication/concept-mfa-licensing), [policy](https://learn.microsoft.com/en-us/entra/identity/conditional-access/policy-all-users-mfa-strength)). Entra emits `amr` containing `mfa` when MFA was completed ([optional claims](https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference)); Convex Auth can check it in `profile()` if the claim is requested. Then remove Password for non-admins (keep a break-glass admin password or drop it).
- (b) Custom TOTP step in-app: no library hook exists; you would gate `createOrUpdateUser` on a separate verified-TOTP record and build enrollment, backup codes and rate limiting yourself. The maintainers' own attempt is still draft.
- (c) Hosted IdP via `convex/auth.config.ts` custom JWT (`{ domain, applicationID: "convex" }`, [Clerk guide](https://docs.convex.dev/auth/clerk)). Clerk: MFA on Pro ($25/mo), 1 SSO connection included, extra $75/mo each ([pricing](https://clerk.com/pricing)). WorkOS AuthKit: first 1M MAU free, MFA included, enterprise SSO $125/connection ([pricing](https://workos.com/pricing)) — plain Google/Microsoft OAuth are not SSO connections. Convex also ships a Better Auth component whose supported-plugins page lists Two Factor ([supported plugins](https://labs.convex.dev/better-auth/supported-plugins)); migration cost is comparable to (c).

## 5. Session lifetime

Defaults: `totalDurationMs` 30d, `inactiveDurationMs` 30d, `jwt.durationMs` 1h ([server API](https://labs.convex.dev/auth/api_reference/server)). The app sets `totalDurationMs` to 7d so the server session dies with the UI's `OFFLINE_WINDOW`. Offline, the client cannot refresh, so the 1h JWT lapses and the Convex client is unauthenticated; the local snapshot carries the user for the remaining 7 days, and the refresh token (still inside the 7d session) re-authenticates on reconnect. Deleting a session does not sign out until the JWT expires, so admin-disable has up to 1h latency unless functions also check the session ([advanced](https://labs.convex.dev/auth/advanced)). OAuth does not change any of this.

## 6. Maturity and advisories

Latest 0.0.96 (peer `@auth/core` ^0.41.1); repo now `convex/convex-auth`, "stable release (v1)" on main, WIP v2 on `reboot`. Advisories: GHSA-579h-4cfp-fh53 (High 7.5, unauthenticated deletion of any document by ID, fixed 0.0.96) and GHSA-c3rg-jwq9-3233 (High 7.4, OTP rate-limit bypass, fixed 0.0.95) ([advisories](https://github.com/convex/convex-auth/security/advisories)). Open OAuth issues: #513 callback swallows token-exchange failures (Safari), #185 PKCE in Safari, #619 Apple form_post cookies, #322 cookie SameSite change, #549 pending `@auth/core` 0.41.3 security bump. Convex's advice: Convex Auth is "the quickest way to get auth up and running" but third-party providers are "the most comprehensive" ([docs.convex.dev/auth](https://docs.convex.dev/auth)).

## 7. Audit data

`authSessions {userId, expirationTime}`, `authAccounts {userId, provider, providerAccountId, emailVerified?}`, `authRefreshTokens {sessionId, expirationTime, firstUsedTime?, parentRefreshTokenId?}` (`types.ts`). `_creationTime` on a session is the sign-in time; `getAuthSessionId` exposes it to functions ([authz](https://labs.convex.dev/auth/authz)). Nothing records IP, user agent, provider used for a session, or failures, and sessions are deleted on expiry ("store both the session ID and the user ID" if you need history). Write an `audit` row (existing table) from `createOrUpdateUser` (success, provider) and from the thrown-rejection path to get a usable sign-in log.

## Decision inputs

| | A: Convex Auth + Google/Microsoft OAuth, IdP MFA, password admin-only | B: Convex Auth + custom TOTP | C: Hosted IdP (Clerk / WorkOS / Better Auth) |
|---|---|---|---|
| Effort | Low-medium: 2 providers, `createOrUpdateUser`, `profile()` checks, upgrade to 0.0.96, UI buttons, Entra PKCE testing | High: build enrollment, verify, backup codes, rate limits, recovery; no library hook | Medium: swap `auth.config.ts`, rewrite sign-in UI, migrate admin provisioning to IdP API, re-link users |
| Security | MFA quality equals IdP policy; residual risk is Convex Auth beta OAuth bugs and unverified Entra email (bounded by single tenant) | Home-grown crypto/ratelimit on a beta lib; weakest | Strongest, audited MFA/passkeys, breach detection |
| Cost | $0 extra (Workspace/M365 already paid; Entra P1 only if Conditional Access wanted) | $0 extra, developer time | Clerk $25/mo+; WorkOS free to 1M MAU; vendor fees later |
| Lock-in | Low: data stays in Convex tables | Low | Medium-high: users and MFA live in vendor |

Recommendation: A. It satisfies "no self-signup" with ~40 lines, gets real MFA from IdPs the customer already runs, and keeps the earlier stay-in-app decision.

## Open questions

- Does the customer actually run Google Workspace and/or Microsoft 365 with admin control to enforce 2SV / security defaults? If not, option A yields SSO without MFA.
- Keep a password login for admins (break-glass) or move admins to SSO too? If kept, admin passwords remain MFA-less.
- Should `profile()` require Entra `amr` to contain `mfa` (needs the optional `amr` claim) so the app refuses non-MFA sessions rather than trusting tenant policy?
- Existing admin-created users lack `emailVerificationTime`; backfill or rely solely on custom linking?
- Entra issue #457 (PKCE decoy) may block Microsoft sign-in on 0.0.96; verify against the tenant before committing.
- Google Pro-only custom callback domain: acceptable that the consent screen shows `*.convex.site`?
