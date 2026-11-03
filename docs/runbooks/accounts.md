# External accounts the app depends on

Fill in each row. Names or roles only: never passwords, keys or card numbers here. When every row is filled, close the tracker task "Inventory of external accounts and their ownership".

| Account | What it does for the app | Owner today (name/role) | Must move to the program before launch? | How hard is the move / notes |
|---|---|---|---|---|
| Convex (team + production project) | Database, backend functions, auth, file storage | | | Transfer = invite program owner to the Convex team as admin, then remove the old owner; deploy keys must be re-issued |
| Domain registrar | Owns the web address | | | Registrar transfer or just move the login |
| DNS | Points the address at the site | | | Will move to Cloudflare if the hosting decision goes that way |
| Cloudflare account and API token | Hosts the website; the "Edit Cloudflare Workers" token in the GitHub `production` environment publishes it | | | Token expiry: ____ ([release runbook](release.md)) |
| cPanel at A2 Hosting | Publishes the website today | | | Retired once Cloudflare hosting is live; keep until then |
| GitHub `angelone-aviation/AO-aircraft-maintenance` | Source code and issue tracker | Angel One (organization) | Done | Moved from a personal test fork on 2026-11-03 |
| Resend | Sends the daily alert email digest | | | Which sending domain is verified? |
| FAA DRS API key | Daily airworthiness-directive checks | | | Who requested it; expiry date; renewal path |
| Geoapify | Address lookup for purchase orders | | | Login stored encrypted in the app settings |
| Aircraft Spruce | Parts catalogue and ordering | | | Login stored encrypted in the app settings |
| Google Workspace or Microsoft 365 | Would provide Google/Microsoft sign-in and enforce MFA | | | Does the program have its own tenant staff already sign in to? |
| Google Cloud project with the sign-in client | Google sign-in ([setup](#google-cloud-sign-in-client)) | | | Owned by an organization account, not a personal one |
| Microsoft Entra app registration | Microsoft sign-in ([setup](#microsoft-entra-app-registration)) | | | Client secret expiry date: |
| Billing | One card or budget for all of the above | | | |

Unknowns to find out: (list who to ask for each blank row)

## Production dashboard administrators

The only person who may hold production Convex dashboard access or its deploy key ([database access](database-access.md), [ADR-0010](../adr/0010-one-convex-administrator.md)): one administrator, the technical owner.

| Name / role | Access (standing seat or break-glass only) | Since |
|---|---|---|
| | Standing seat | |
| | Break-glass only | |

# User accounts: lockout, disabling and adding existing users

Only system administrators and Flight Program administrators manage users (ADR-0002). These rules come from issue #29 (security review findings S2, S3, S9, S11).

## A user is locked out after failed sign-ins

After **10 failed password sign-ins within an hour** an account refuses every password sign-in, including the right one, and the sign-in screen shows the same generic error as for a wrong password (production hides the reason). One attempt is restored every 6 minutes, so the lock clears by itself within the hour. The counter is per account; a successful sign-in resets it.

To unlock at once, a **system administrator resets the user's password** (Administration → the user → Reset password):

1. Confirm who is asking, out of band (phone or in person). Anyone who knows an email can lock that account, so a lockout is not itself evidence the user forgot their password.
2. Reset the password. The reset sets the new password, ends every session the user has on any device, and clears the failed-sign-in counter. The change log entry `user.password_reset` records `signInLockoutCleared: true` when a lock was cleared.
3. Give the user the new password over a different channel from the email address.

If many accounts lock at the same time, someone is guessing passwords across accounts (password spraying). The app has no global failed-sign-in alarm yet (see below); look in the Convex dashboard's `authRateLimits` table for many rows with a recent `lastAttemptTime`, and raise it with the technical owner. Limiting sign-in attempts per IP address belongs at the Cloudflare edge and is part of the release-process decision.

Why no global budget in the app: `@convex-dev/auth` 0.0.96 has no hook that runs on a failed sign-in, the Password provider's `profile()` runs synchronously before the password is checked, and attempts against unknown emails are not recorded anywhere. Counting failures would mean wrapping the library's internal provider options, which can break silently on upgrade.

## Disabling a user

A system administrator unticks **Active** on the user. Saving:

- deletes every session and refresh token the user has, so every device they are signed in on loses access at its next request (the change log records `user.sessions_ended` with the number of sessions);
- refuses every later sign-in, by password or by Google or Microsoft, without creating a session.

Re-enabling the user does not bring old sessions back; they sign in again. Removing a user from one Flight Program (Flight Program administrators can do this) does not end sessions, because the user may still belong to other programs.

## Creating accounts

Creating an account never touches an existing one. If the email is already used by any account, active or not, creation stops with "This email cannot be used for a new account…" before the password is processed, whatever password was typed. Each administrator may make **20 account requests an hour** (refusals count), after which they must wait.

A password an administrator sets, on creation or reset, must have **15 to 128 characters**; there are no rules about letters, digits or symbols ([ADR-0009](../adr/0009-password-for-everyone-plus-google-and-microsoft.md), following NIST SP 800-63B). Common passwords from a bundled list (`src/domain/commonPasswords.ts`), a short phrase typed repeatedly and passwords containing the account's email are refused. A short phrase of four or five unrelated words is a good choice. Existing shorter passwords keep working until the user's next reset.

## Adding an existing user to a Flight Program

A Flight Program administrator can add a person who already has an active account (Administration → Add existing user). The app answers "If an active account uses this email, it now has access to this Flight Program." whether or not such an account exists, so the form cannot be used to check which emails have accounts. Each administrator gets **20 lookups an hour**, found or not. If the person does not appear in the user list afterwards, check the email address with them, or create a new user. Every addition writes a `user.program_access_added` change-log entry that names the program and groups.

## Permission groups opened to all aircraft before the #34 fix

Until the fix for #34, editing a permission group whose selected aircraft had all moved to another Flight Program silently saved it with no aircraft, which means every aircraft in the program. Its members could then see, and depending on the group's permissions fly or work on, aircraft they were never given. How the check decides is in [Flight Program access](../flight-program-access.md#groups-opened-to-all-aircraft-before-the-fix). Do this once per deployment, after the deploy that adds the check and after `memberships:backfill` (members are read from its index):

1. Run the read-only check. It changes no group and writes no change-log entry:

   ```bash
   npx convex run groupAudit:findWidenedGroups
   ```

   It reads 50 groups per run. While the result says `isDone: false`, run it again with the cursor it returned: `npx convex run groupAudit:findWidenedGroups '{"cursor": "<continueCursor>"}'`. Keep every result with the change record.

2. For each entry under `widened`, read its `summary`. `aircraftBefore` lists the aircraft the group was limited to; `transferredAway: true` marks those no longer in the group's program (or no longer in Angel One). `savedBy` and `savedAt` say who saved it empty and when; `members` are its current members. Ask the program's Flight Program administrator which aircraft the group should cover. If it matters, check the flight log and History of the program's other aircraft for entries by those members since `savedAt`.
3. For each entry under `review`, the change log cannot show whether all aircraft was intended. Ask the Flight Program administrator.
4. In **Administration → Permission groups** the same groups are listed for system administrators. Use **Edit group** on each and choose **Only selected aircraft** (and the aircraft) or **All aircraft in this program**, then save. The form starts with neither chosen. Saving records the choice in the change log, and the group leaves the list and the command's result.
5. Run the check again; it should return empty `widened` and `review` lists.

Groups confirmed after the #34 fix reached production but before this check was deployed are listed once more, because their saves did not record the choice; one more save clears them.

## Google and Microsoft sign-in

Every user keeps their password. A user may also sign in with a Google or Microsoft account whose **verified** email is exactly their Angel One email ([ADR-0009](../adr/0009-password-for-everyone-plus-google-and-microsoft.md)). The first such sign-in links that account to the user; afterwards it is recognized by the provider's account id, whatever email it reports. Sign-in never creates an account: an email without exactly one active Angel One user gets "Accounts are managed by your administrator." Google emails count only when Google marks them verified; Microsoft emails only for personal Microsoft accounts or work accounts whose organization verified the email's domain (`xms_edov`). Disabling a user refuses every method.

Each button appears on the sign-in screen only when all of its provider's environment variables are set on the deployment, so nothing changes until the clients below exist. You need the deployment's **HTTP Actions URL**, `https://<deployment>.convex.site` (Convex dashboard → Settings → URL & Deploy Key), and `SITE_URL` already set (`npm run setup:auth`). Paste client secrets into the Convex dashboard (Settings → Environment Variables) rather than on a command line, and never into the repository or this document. Record who owns each client in the table at the top.

### Google Cloud sign-in client

1. In the [Google Cloud console](https://console.cloud.google.com/), signed in with an organization account, create a project such as "Angel One sign-in".
2. Open **Google Auth Platform**. Under **Branding**, enter the app name (Angel One), a support email, the site's address as the home page, and add the site's domain and `convex.site` as authorized domains. Under **Audience**, choose **External** (any Google account, as ADR-0009 allows) and **Publish app**; while it is in testing only listed test users can sign in. Under **Data access**, keep only `openid`, `email` and `profile`; these need no Google review.
3. Under **Clients**, create a client of type **Web application** named "Angel One production", with the authorized redirect URI `https://<deployment>.convex.site/api/auth/callback/google`. No JavaScript origins are needed.
4. Set `AUTH_GOOGLE_ID` (the client ID) and `AUTH_GOOGLE_SECRET` (the client secret) on the deployment.
5. Deploy (`npx convex deploy`) so the sign-in routes are registered, then check that **Sign in with Google** appears and test it with a real account whose email matches a test user.

### Microsoft Entra app registration

1. In the [Microsoft Entra admin center](https://entra.microsoft.com/), signed in with an account that may register applications, open **Applications → App registrations → New registration**.
2. Name it "Angel One". Under **Supported account types**, choose **Accounts in any organizational directory and personal Microsoft accounts** (multi-tenant, as ADR-0009 allows). Set the redirect URI to platform **Web**, `https://<deployment>.convex.site/api/auth/callback/microsoft-entra-id`.
3. Under **Token configuration → Add optional claim**, choose token type **ID** and add `email` and `xms_edov` (accept adding the Microsoft Graph `email` permission if asked). If `xms_edov` is not offered, add it in **Manifest** under `optionalClaims.idToken` as `{ "name": "xms_edov", "essential": false }`. Without it, work and school accounts are refused as unverified; personal accounts still work.
4. Under **Certificates & secrets**, add a client secret (description "Angel One production", longest expiry offered). Write its expiry date in the table at the top and set a reminder to replace it before then.
5. Set on the deployment: `AUTH_MICROSOFT_ENTRA_ID_ID` (the **Application (client) ID** from Overview), `AUTH_MICROSOFT_ENTRA_ID_SECRET` (the secret's **Value**, not its ID) and `AUTH_MICROSOFT_ENTRA_ID_ISSUER` = `https://login.microsoftonline.com/common/v2.0`.
6. Deploy, then test with a personal Microsoft account and with a work or school account. If Microsoft sign-in fails (an `AADSTS` error in the browser, or an error under the callback route in the Convex logs), Google can go live alone: remove the three Microsoft variables and deploy, and the button disappears. The app works around the library's known Microsoft issue (convex-auth #457) and Microsoft's per-tenant token issuer; see `convex/ssoProviders.ts`.

### Single tenant, multi-tenant, and restricting sign-in later

The setup above accepts any Google account and any Microsoft account (any organization, or personal) whose verified email matches. If the program later adopts its own Google Workspace or Microsoft 365 for everyone, an administrator of that tenant can restrict sign-in to it:

- **Microsoft**: change the registration's supported account types to **Accounts in this organizational directory only** and set `AUTH_MICROSOFT_ENTRA_ID_ISSUER` to `https://login.microsoftonline.com/<directory (tenant) id>/v2.0`, then deploy. Tokens from other organizations and personal accounts are then refused.
- **Google**: move the Google Cloud project into the Workspace organization and set **Audience** to **Internal**; only that organization's accounts can then sign in.

Identities linked from outside the new restriction stop working; remove them for tidiness (below). Passwords keep working either way.

### Seeing, removing and auditing linked identities

- Users see their own sign-in methods under **Settings → My account → Sign-in methods**.
- System administrators see any user's under **Administration → Users → Sign-in methods** (the sign-in icon on the user's row) and can **Remove** a Google or Microsoft account there. Removing it does not change the password or end sessions, and the person can link it again by signing in with it while its verified email still matches. To stop someone signing in at all, disable the user.
- The change log records, without any token or secret: `user.identity_linked` (provider, email) the first time an identity links; `user.signed_in` (method `password`, `google` or `microsoft-entra-id`) for every successful sign-in; `user.sign_in_refused` (method, reason `no_account`, `disabled`, `ambiguous` or `email_not_verified`, email) for each refused Google or Microsoft attempt, at most 10 per provider account and 300 in all per hour; and `user.identity_removed` (provider, email, link date) with the administrator who removed it.
- `ambiguous` means two active users share the email. Fix the duplicate before the person tries again.

### Second factor

The app has no second factor of its own (ADR-0009). Users who want one sign in with Google or Microsoft with that account's two-step verification turned on; administrators are expected to.
