---
status: accepted
date: 2026-11-20
---

# Google and Microsoft sign-in are removed; everyone signs in with a password

> Supersedes in part [ADR-0009](0009-password-for-everyone-plus-google-and-microsoft.md) (its Google and Microsoft sign-in) and [ADR-0001](0001-sso-in-app-not-cloudflare-access.md) (its last sentence, on where Google and Microsoft sign-in go). The rest of both stands.

ADR-0009 added Google and Microsoft sign-in beside the password every user keeps. It was built and tested, but never switched on in production: no Google sign-in client or Microsoft Entra app registration was created, and the deployment never had their environment variables. On 20 Nov 2026 Aaron decided to remove it ("don't think we'll ever use it"). Code that is never used still has to be reviewed, upgraded and defended: it carried its own sign-in callback, an account-linking rule, a refusal log, a Microsoft discovery workaround (convex-auth #457) and screens in Settings and Administration.

## Decision

- **Every user signs in with email and password only.** Password sign-in is unchanged: administrator-provisioned accounts (ADR-0002), the 15-character rule, the lockout after 10 failed sign-ins an hour, 7-day sessions, the disabled-account guards and the `user.signed_in` change-log entry with its method.
- **The code is removed, not switched off**: the providers (`convex/ssoProviders.ts`), linked identities and the refusal log (`convex/identities.ts`), the callback wrapper in `convex/http.ts`, the domain rules (`src/domain/signInMethods.ts`), the sign-in buttons and notice, and the sign-in methods lists in Settings and Administration. `convex/auth.ts` refuses any sign-in that is not a password one.
- **The schema is unchanged.** Google and Microsoft sign-in had no tables of their own: linked identities were rows in Convex Auth's `authAccounts`, and one-time codes and verifiers sat in its other tables, which password sign-in uses too. Removing nothing means no deploy can fail on existing rows.
- **Older rows stay.** Production has none, but a development deployment may hold an `authAccounts` row with provider `google` or `microsoft-entra-id`. Nothing reads it as a password login (`emailInUse` and the password lookup both match provider `password`), so it changes nothing for its user. Change-log entries `user.identity_linked`, `user.identity_removed` and `user.sign_in_refused` are kept, as every change-log row is (ADR-0005); the weekly summary still counts a refused sign-in if one exists.
- **The deployment's `AUTH_GOOGLE_*` and `AUTH_MICROSOFT_ENTRA_ID_*` variables** are no longer read, and can be deleted wherever they were set.

## Consequences

- No user has a second factor. ADR-0009 offered Google or Microsoft two-step verification as the way to get one; that route is gone. Revisit when `@convex-dev/auth` ships passkeys or authenticator codes, or the program adopts a hosted identity provider.
- A program that later wants single sign-on starts from ADR-0002's rule, that an outside identity only ever links to an administrator-created user, and from the removed code in git history (before this ADR).
- The weekly summary's refused sign-in count will read zero unless an older entry exists.

## Considered options

- **Keep the code, switched off**: rejected; it is attack surface and upkeep for a feature Aaron does not expect to use.
- **Also drop `authAccounts` rows with a provider other than `password`**: not needed; production has none, and the auth tables are the library's, not ours.
