# Break-glass administrator access

How the technical owner gets system administrator access back when no administrator can sign in. It uses only what the app and Convex offer today; what is missing is marked "Gap:". If an intruder may be involved, run [incident response](incident-response.md) alongside this.

## What exists today

- Every account signs in with a password, the only sign-in method ([ADR-0015](../adr/0015-remove-google-and-microsoft-sign-in.md)); no outside identity provider can lock anyone out.
- 10 failed password sign-ins within an hour lock an account; one attempt returns every 6 minutes, and a system administrator's **Reset password** clears the lock at once ([accounts runbook](accounts.md#a-user-is-locked-out-after-failed-sign-ins)). Anyone who knows the email can cause a lock.
- The app will not disable or demote the last active system administrator ("Keep at least one active administrator.").
- `npm run setup:admin` (`scripts/bootstrap-admin.mjs`, which runs the internal `admin:bootstrap`) creates an administrator only on an empty user database. Once any account exists it stops with "Bootstrap is only available on an empty user database.", so it cannot recover production.
- No function or command resets a password or restores administrator rights from outside the app.
- The technical owner is the only member of the Convex account ([ADR-0010](../adr/0010-one-convex-administrator.md)) and can edit production data in the Convex dashboard. That is a direct edit: allowed only as a repair the app cannot make, and recorded in the change log ([Production database access](database-access.md)).

## The break-glass credentials

| Credential                                                                                  | Kept in                                                                   | Held by                                      |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------- |
| The break-glass account: a system administrator account used only for this, with a password | The technical owner's password manager, and a sealed paper copy at ______ | The technical owner; the sealed copy: ______ |
| The Convex account's sign-in details and recovery codes                                     | The technical owner's password manager, and a sealed paper copy at ______ | The technical owner only (ADR-0010)          |

Owner decision: ADR-0010 gives the organization only the sealed backup key, never production credentials. If the organization holds the sealed copy of the break-glass account, record that as an amendment to ADR-0010.

### Set up once

1. A system administrator: Administration → Users → **Add user**. Name "Break-glass administrator"; an email address the organization controls and publishes nowhere (anyone who knows it can lock the account for an hour); a password of six or more random words from the password manager, which is easy to type from paper. Tick **Global administrator (all aircraft and settings)**, add no Flight Program groups, then **Create account**.
2. Save it in the technical owner's password manager. Write the email and password on paper, seal it in an envelope, sign and date it across the flap, and hand it to the holder named above.
3. [Test it](#test-twice-a-year) and log the test.

Use the account only for this runbook and its tests. Any other "User · signed in" entry for it is an incident.

## When no administrator can sign in

Start at the first row that fits.

| Situation                                            | Do this                                                                                                                                                               |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An administrator is locked out after failed sign-ins | Another system administrator resets their password. If there is none, stop trying and wait: one attempt returns every 6 minutes and the lock is gone within the hour. |
| An administrator forgot their password               | Another system administrator resets it.                                                                                                                               |
| No administrator can sign in                         | [Use the break-glass account](#use-the-break-glass-account).                                                                                                          |
| The break-glass account fails too                    | [Repair in the Convex dashboard](#repair-in-the-convex-dashboard).                                                                                                    |

### Use the break-glass account

1. Take its password from the password manager. Only if that is unavailable, open the sealed copy, and note who opened it, when and why.
2. Sign in at <https://ops.angeloneaviation.org> on a device you control.
3. Restore access in Administration → Users: **Reset password** on the administrator's row (it also clears a lock and ends their sessions), or their **Edit access** to tick **Account active** or **Global administrator**. Give a new password over a channel other than their email.
4. Sign out of the break-glass account.
5. Note what you did in the incident timeline. The change log already holds the sign-in and every change.
6. [Rotate after use](#rotate-after-use).

### Repair in the Convex dashboard

The last resort, by the technical owner.

1. Sign in to the Convex dashboard. If you cannot, use the Convex account's recovery.

   Gap: what Convex needs to recover the account, or to move it to a new owner (ADR-0010), is not written down. Ask Convex support and record the answer here.

2. Write down the problem and the exact change, in an issue or the incident timeline ([direct edits](database-access.md#direct-edits-to-production-data-are-banned)).

   Gap: that runbook asks a second administrator to agree in writing, but ADR-0010 left one. The owner decides who agrees instead.

3. Take a backup: Convex dashboard → Backups → **Backup now**, and note its time.
4. Make the smallest edit, in Production → Data. Copy each document's JSON before you change it.
   - **Locked only**: no edit. Wait an hour. If the lock keeps coming back, someone is guessing: run [incident response](incident-response.md#suspected-account-compromise).
   - **Someone can still sign in**: in `users`, open the active account of a person who can still sign in and set `isAdmin` to `true`. That person signs in, resets the administrator's password in Administration, and then unticks **Global administrator** on their own account, which the change log records.
   - **An administrator was disabled**: set `active` to `true` on their `users` document. Their sessions ended when they were disabled; they sign in again.
   - **Nobody can sign in to any account**: Gap: there is no supported path. The dashboard cannot set a password (`authAccounts` holds only its hash), and `npm run setup:admin` refuses a database with accounts. A reviewed internal function that resets one account's password from the Convex CLI would close this.

5. As soon as your own administrator account works again, record the edit with it (`actorEmail` must be your own active system administrator account; [details](database-access.md#recording-the-hand-written-change-log-entry)):

   ```sh
   npx convex run --prod audit:recordManualEntry '{
     "actorEmail": "<your administrator email>",
     "reason": "Break-glass: no system administrator could sign in (incident YYYY-MM-DD)",
     "description": "Set isAdmin to true on users <_id> in the Convex dashboard.",
     "entityUuid": "<_id of the user changed>",
     "before": { "isAdmin": false },
     "after": { "isAdmin": true }
   }'
   ```

6. [Rotate after use](#rotate-after-use).

## Rotate after use

After any use, and whenever a holder changes:

1. From another administrator account, **Reset password** on the break-glass account with a new phrase from the password manager. This also ends its sessions.
2. Make a new sealed copy, shred the old one and log the date below.
3. If you used Convex recovery codes, create new ones and store them the same way.
4. Remove administrator rights given in a dashboard repair, in the app.

## Test twice a year

Do it during two quarterly restore rehearsals six months apart ([backup runbook](backup-restore.md#quarterly-restore-rehearsal)), with the holder of the sealed copy.

1. Check the sealed copy is where the table says, with its seal and date intact.
2. Sign in with the break-glass account from the password manager, in a private browser window; open Administration; sign out. Once a year use the sealed copy instead, then [rotate](#rotate-after-use), since it has been opened.
3. In Change history, with **Unassigned records** chosen, check every "User · signed in" entry for the account is a logged test or use. Any other is an [account compromise](incident-response.md#suspected-account-compromise).
4. Check the technical owner can sign in to the Convex dashboard, and the recovery codes are where the table says.
5. In the rehearsal's scratch deployment, never production, practise the repair: set `isAdmin` to `false` on your own restored account, check Administration disappears after reloading, set it back to `true`, then record it with `npx convex run --deployment <scratch> audit:recordManualEntry` as in [the repair](#repair-in-the-convex-dashboard), step 5.
6. Log it:

| Date | Copy used | Sign-in worked | Repair practised | Rotated | By  |
| ---- | --------- | -------------- | ---------------- | ------- | --- |
|      |           |                |                  |         |     |
