---
status: accepted
date: 2026-11-02
---

# Every user keeps a password; Google and Microsoft sign-in are offered alongside it

Every account, administrator-created as before (ADR-0002), signs in with an **email and password**. Users may also sign in with a **Google or Microsoft account** whose email matches their Angel One account. Single sign-on is a convenience and a route to a second factor, not a replacement: the program does not yet control a Google Workspace or Microsoft 365 tenant for all its pilots and mechanics, so a password must remain the method that always works. One-time email codes are not used.

## Rules

- **Existing accounts only.** A Google or Microsoft identity is attached to an Angel One user only when an account with that exact email already exists; otherwise sign-in is refused with "Accounts are managed by your administrator." No account is ever created by single sign-on.
- **Only verified email links.** Google sign-ins must carry `email_verified = true`. Microsoft sign-ins are accepted from personal Microsoft accounts, or from work accounts whose email is domain-verified (`xms_edov`); Microsoft's plain `email` claim is not trusted. After the first successful link, the identity is matched by the provider's account id, never by email again.
- **Any Google or Microsoft account** with a matching verified email is allowed. If the program later adopts its own Workspace or Microsoft 365 tenant, administrators may restrict sign-in to that domain or tenant.
- **Administrators see and can remove** a user's linked Google or Microsoft identities. Disabling a user blocks every method.
- **Second factor**: the app has none of its own at launch; `@convex-dev/auth` has no multi-factor support. Users who want one sign in with Google or Microsoft with that provider's two-step verification turned on. Administrators are expected to do so. Revisit when the library ships passkeys or authenticator codes.
- **Passwords**: at least 15 characters with no composition rules, checked against a list of common passwords, following NIST SP 800-63B for a password used as a single factor. Existing shorter passwords are accepted until the user's next administrator reset.
- **Sign-in log**: successful sign-ins (with method) and refused single-sign-on attempts are written to the change log.
- **Session lifetime** stays at 7 days, matching the offline window.
- **Library version**: `@convex-dev/auth` is upgraded to 0.0.96 or later before launch (fixes advisory GHSA-579h-4cfp-fh53).

## Consequences

- Password-only users have no second factor. This is accepted for launch because the app is a status-record system, not the signed maintenance record (ADR-0004), and every write is attributed and logged (ADR-0005).
- Microsoft sign-in has an open library issue (convex-auth #457, PKCE) that may block it; it is tested early, and Google ships alone if Microsoft is blocked.
- The Google consent screen shows the `*.convex.site` callback domain unless a custom domain is set up.

## Considered options

- **Single sign-on only, passwords for break-glass administrators**: rejected; the program cannot yet put every user in one tenant.
- **Hosted identity provider (Clerk, WorkOS, Better Auth)** for built-in multi-factor: deferred; it moves users out of Convex and conflicts with ADR-0001's keep-it-in-app choice.
- **Home-built authenticator codes**: rejected; building multi-factor on a beta library is riskier than relying on Google and Microsoft.
- **Link by explicit "connect your Google account" step while signed in with a password**: the fallback if verified-email linking proves unreliable for Microsoft work accounts.
