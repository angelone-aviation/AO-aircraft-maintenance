# External accounts the app depends on

Fill in each row. Names or roles only: never passwords, keys or card numbers here. When every row is filled, close the tracker task "Inventory of external accounts and their ownership".

| Account | What it does for the app | Owner today (name/role) | Must move to the program before launch? | How hard is the move / notes |
|---|---|---|---|---|
| Convex (new Pro account and production project) | Database, backend functions, auth, file storage | | Created new; one administrator (ADR-0010) | The old test project is retired, not transferred (go-live checklist). Deploy keys come from the new account only |
| Domain registrar | Owns `angeloneaviation.org` | | | Find which registrar holds it and who has the login |
| DNS | `angeloneaviation.org` zone, including `ops` for the app | | Already on Cloudflare (nameservers `nancy`, `rustam.ns.cloudflare.com`) | The Worker must deploy into the same Cloudflare account as the zone; the app's `ops` record and certificate are created by the deploy |
| Cloudflare account and API token | Hosts the website; the "Edit Cloudflare Workers" token in the GitHub `production` environment publishes it | | | Token expiry: ____ ([release runbook](release.md)); record it under Settings → System → Expiring dates so it alerts before it lapses |
| cPanel at A2 Hosting | Published the old test website | | No: retire it | Decided 2026-11-03: the old site and its Convex project are retired, not migrated (test data only). Remove the site files; cancel the hosting when nothing else uses it |
| GitHub `angelone-aviation/AO-aircraft-maintenance` | Source code and issue tracker | Angel One (organization) | Done | Moved from a personal test fork on 2026-11-03 |
| Resend | Sends the daily alert email digest and the immediate urgent-alert emails | | | Which sending domain is verified? Free tier: 100 emails a day; the app caps immediate emails at 60 ([monitoring runbook](monitoring.md#alerts-by-email-and-on-devices)) |
| VAPID key pair (Convex environment) | Signs the push messages that alert members' devices | | Generated for the deployment; never in the repository | Rotation signs every device out of alerts ([monitoring runbook](monitoring.md#alerts-by-email-and-on-devices)); record the review date under Settings → System → Expiring dates |
| FAA DRS API key | Daily airworthiness-directive checks | | | Who requested it; expiry date; renewal path |
| Geoapify | Address lookup for purchase orders | | | Login stored encrypted in the app settings |
| Aircraft Spruce | Parts catalogue and ordering | | | Login stored encrypted in the app settings |
| Google Workspace | Organization email (`angeloneaviation.org` MX is Google) | | | Not used for signing in to the app (ADR-0015) |
| Dropbox account with the "Angel One records" app | Holds the readable records copy ([ADR-0011](../adr/0011-readable-records-copy-in-dropbox.md), [setup](dropbox-records-copy.md)) | | | Organization account with two-step sign-in; refresh token in the GitHub `backups` environment |
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
2. Reset the password. The reset sets the new password, ends every session the user has on any device, forgets every device they turned urgent alerts on for, and clears the failed-sign-in counter. The change log entry `user.password_reset` records `signInLockoutCleared: true` when a lock was cleared.
3. Give the user the new password over a different channel from the email address.

If many accounts lock at the same time, someone is guessing passwords across accounts (password spraying). The app has no global failed-sign-in alarm yet (see below); look in the Convex dashboard's `authRateLimits` table for many rows with a recent `lastAttemptTime`, and raise it with the technical owner. Limiting sign-in attempts per IP address belongs at the Cloudflare edge and is part of the release-process decision.

Why no global budget in the app: `@convex-dev/auth` 0.0.96 has no hook that runs on a failed sign-in, the Password provider's `profile()` runs synchronously before the password is checked, and attempts against unknown emails are not recorded anywhere. Counting failures would mean wrapping the library's internal provider options, which can break silently on upgrade.

## Disabling a user

A system administrator unticks **Account active** on the user. Saving:

- deletes every session and refresh token the user has, so every device they are signed in on loses access at its next request (the change log records `user.sessions_ended` with the number of sessions), and forgets every device the user turned urgent alerts on for;
- refuses every later sign-in without creating a session.

Re-enabling the user does not bring old sessions back; they sign in again. Removing a user from one Flight Program (Flight Program administrators can do this) does not end sessions, because the user may still belong to other programs.

## Creating accounts

Creating an account never touches an existing one. If the email is already used by any account, active or not, creation stops with "This email cannot be used for a new account…" before the password is processed, whatever password was typed. Each administrator may make **20 account requests an hour** (refusals count), after which they must wait.

A password an administrator sets, on creation or reset, must have **15 to 128 characters**; there are no rules about letters, digits or symbols ([ADR-0009](../adr/0009-password-for-everyone-plus-google-and-microsoft.md), following NIST SP 800-63B). Common passwords from a bundled list (`src/domain/commonPasswords.ts`), a short phrase typed repeatedly and passwords containing the account's email are refused. A short phrase of four or five unrelated words is a good choice. Existing shorter passwords keep working until the user's next reset.

## Adding an existing user to a Flight Program

A Flight Program administrator can add a person who already has an active account (Administration → Add existing user). The app answers "If an active account uses this email, it now has access to this Flight Program." whether or not such an account exists. The answer itself reveals nothing, but a person who is added then appears in the user list, so an administrator can still learn that an email has an account (security review 2026-11-04, S11). Each administrator gets **20 lookups an hour**, found or not. If the person does not appear in the user list afterwards, check the email address with them, or create a new user. Every addition writes a `user.program_access_added` change-log entry that names the program and groups.

## Permission groups opened to all aircraft before the #34 fix

Until the fix for #34, editing a permission group whose selected aircraft had all moved to another Flight Program silently saved it with no aircraft, which means every aircraft in the program. Its members could then see, and depending on the group's permissions fly or work on, aircraft they were never given. How the check decides is in [Flight Program access](../flight-program-access.md#groups-opened-to-all-aircraft-before-the-fix). System administrators see the groups it finds in **Administration → Permission groups**, above the group cards; it changes no group and writes no change-log entry. Members are read from the `memberships` index, so on a deployment with older data run `memberships:backfill` first.

1. For a group marked **Opened to all aircraft**, the list shows the aircraft it was limited to and the program each is in now, who saved it with no aircraft and when, and its current members. Ask the program's Flight Program administrator which aircraft the group should cover. If it matters, check the flight log and History of the program's other aircraft for entries by those members since that save.
2. For a group marked **Review** ("Cannot determine: …"), the change log cannot show whether all aircraft was intended. Ask the Flight Program administrator.
3. Use **Edit group** on each and choose **Only selected aircraft** (and the aircraft) or **All aircraft in this program**, then save. The form starts with neither chosen. Saving records the choice in the change log, and the group leaves the list.

Groups confirmed after the #34 fix reached production but before this check was deployed are listed once more, because their saves did not record the choice; one more save clears them.

## Sign-in and the change log

Everyone signs in with email and password. Google and Microsoft sign-in were built but removed before launch ([ADR-0015](../adr/0015-remove-google-and-microsoft-sign-in.md)); the deployment reads no `AUTH_GOOGLE_*` or `AUTH_MICROSOFT_ENTRA_ID_*` variables, and any left set can be deleted.

- The change log records `user.signed_in` (method `password`) for every successful sign-in, without any token or secret. Token refreshes are not logged.
- Older entries named `user.identity_linked`, `user.identity_removed` or `user.sign_in_refused` came from the removed Google and Microsoft sign-in; none are written now.

### Second factor

The app has no second factor of its own. `@convex-dev/auth` has none yet; revisit when it ships passkeys or authenticator codes (ADR-0015).
