# External accounts the app depends on

Fill in each row. Names or roles only: never passwords, keys or card numbers here. When every row is filled, close the tracker task "Inventory of external accounts and their ownership".

| Account | What it does for the app | Owner today (name/role) | Must move to the program before launch? | How hard is the move / notes |
|---|---|---|---|---|
| Convex (team + production project) | Database, backend functions, auth, file storage | | | Transfer = invite program owner to the Convex team as admin, then remove the old owner; deploy keys must be re-issued |
| Domain registrar | Owns the web address | | | Registrar transfer or just move the login |
| DNS | Points the address at the site | | | Will move to Cloudflare if the hosting decision goes that way |
| cPanel at A2 Hosting | Publishes the website today | | | Retired once Cloudflare hosting is live; keep until then |
| GitHub `angelone-aviation/AO-aircraft-maintenance` | Source code and issue tracker | Angel One (organization) | Done | Moved from a personal test fork on 2026-11-03 |
| Resend | Sends the daily alert email digest | | | Which sending domain is verified? |
| FAA DRS API key | Daily airworthiness-directive checks | | | Who requested it; expiry date; renewal path |
| Geoapify | Address lookup for purchase orders | | | Login stored encrypted in the app settings |
| Aircraft Spruce | Parts catalogue and ordering | | | Login stored encrypted in the app settings |
| Google Workspace or Microsoft 365 | Would provide Google/Microsoft sign-in and enforce MFA | | | Does the program have its own tenant staff already sign in to? |
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
