# Incident response

For anything that puts production records or accounts at risk: an account taken over, a leaked secret, records shown to the wrong Flight Program, a bad release, lost or damaged data, a vulnerable dependency, a lost device. The **incident lead** is Aaron, the one Convex administrator ([ADR-0010](../adr/0010-one-convex-administrator.md)). Vulnerability reports arrive at accounts@angeloneonline.org ([SECURITY.md](../../SECURITY.md)).

Keep a timeline from the first minute, in UTC: what you saw, what you did, when.

## Severity

| Level | Means                                                                              | Examples                                                                                                                                                                                                                                                                                                                                                                                                  | Start                                                  |
| ----- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| SEV1  | Records exposed, changed or lost beyond one account, or control of production lost | A system administrator account, or the Convex, Cloudflare or GitHub account, taken over; a production deploy key, the sign-in token key (`JWT_PRIVATE_KEY`), the backup private key, or (while backups are unencrypted, ADR-0014) the R2 token or the Cloudflare login leaked; one Flight Program's records shown to another; production data lost or corrupted; the site serving code we did not publish | At once; tell the organization contact within the hour |
| SEV2  | One account or a lower-impact secret compromised, or the app unusable              | A pilot's or mechanic's account taken over; an OAuth client secret, Dropbox, R2 or Resend key leaked; an administrator's device lost; a release that stops work; a High or Critical dependency advisory reachable in production                                                                                                                                                                           | The same day                                           |
| SEV3  | Contained, or a weakness with no sign of use                                       | A credible vulnerability report; a lost pilot device with a screen lock; an advisory not reachable in production                                                                                                                                                                                                                                                                                          | The next business day                                  |

When unsure, pick the higher level; lower it when the facts allow.

## First 15 minutes: contain

1. Open the timeline in the incident folder (______), never in a public issue.
2. Set the severity.
3. Contain with the matching playbook. The fastest controls:
   - one account: a system administrator disables it (Administration → Users → the user's **Edit access** → untick **Account active** → **Save user**), which ends all its sessions;
   - a leaked secret: revoke it at its source ([Leaked secret](#leaked-secret));
   - a bad website release: roll back in Cloudflare ([Bad deploy](#bad-deploy));
   - further releases: GitHub → Actions → **Deploy** → **···** → **Disable workflow**. Until you do, every green CI run for a push to `main` deploys by itself.
4. Keep the evidence: GitHub → Actions → **Nightly backup** → **Run workflow** makes a copy that the R2 lock rules keep for 90 days ([Evidence to keep](#evidence-to-keep)).
5. Notify as [Who to notify](#who-to-notify) says for the level.

Contain without editing or deleting production data or change-log rows: records are append-only ([ADR-0005](../adr/0005-audit-log-protection-by-access-and-backups.md)). Answer a wrong record with a correction; repair outside the app only as [Production database access](database-access.md) allows.

Gap: there is no tested way to take the whole app offline. Rehearse one (for example pausing a preview deployment in the Convex dashboard) before relying on it.

## Suspected account compromise

Signs: a sign-in or a change the user did not make; many recent rows in the `authRateLimits` table.

1. **Disable the user.** A system administrator: Administration → Users → the user's **Edit access** → untick **Account active** → **Save user**. Today this (`convex/admin.ts` `updateUser`, `convex/accountGuards.ts` `endSessions`, `convex/auth.ts`):
   - deletes every session and refresh token of the user. Every app function checks the session, so each of their devices loses access at its next request, although the last access token it holds (valid up to an hour) is not revoked as such;
   - refuses every later sign-in, by password, Google or Microsoft, before a session is made;
   - writes `user.permissions_changed` and `user.sessions_ended` (with the number of sessions) to the change log;
   - makes a device that next connects with the app open delete its cached snapshot and kept manuals. Its pending entries stay.

   It does not wipe a device that stays offline (the cached snapshot opens until 7 days after that device's sign-in), remove linked Google or Microsoft accounts, or expire attachment links saved in a cached snapshot (review finding S7).

   Flight Program administrators cannot disable accounts: removing the user from their program cuts that program's access but leaves the sessions. Call a system administrator.

   The app will not disable the last active system administrator ("Keep at least one active administrator."). Instead, that administrator uses **Reset password** on their own account, which ends every session of the account, the intruder's and their own included; they sign in again with the new password. If they cannot sign in, use [Break-glass administrator access](break-glass-admin.md).

2. If the person's Google or Microsoft account was the way in: Administration → Users → the user's **Sign-in methods** → **Remove** it, and have them secure that account with the provider.
3. **Read the sign-in log and the change log.** User events have no Flight Program: a system administrator sees them in **Change history** with **Unassigned records** chosen in the Flight Program switcher, as "User · signed in" (with the method), "User · sign in refused" (Google and Microsoft only), "User · identity linked", "User · password reset" and "User · permissions changed". For one user's full trail, Aaron filters the `audit` table in the Convex dashboard (Data; looking is not an edit): `entityUuid` equal to the user's `_id` (from `users`) for events about them, `actorId` equal to it for everything they did. `at` is the time in milliseconds, UTC.
4. **Judge the damage.** The change log records writes, not reads: assume the intruder saw everything the account's groups allowed. For a system administrator account, also check what it created or changed in users, groups, linked identities, Settings → System and each program's Aircraft Spruce account. Answer each wrong record with a correction and a reason.
5. **Recover.** Confirm who the person is out of band, then use **Reset password** on their row and give them the new one over a channel other than their email ([accounts runbook](accounts.md#a-user-is-locked-out-after-failed-sign-ins)). Tick **Account active** again; old sessions do not come back.

Gap: the sign-in log records the method and time, not the IP address or device.

## Leaked secret

1. Revoke or replace the secret at its source (table below), then update where it is stored.
2. Ask the provider's audit or access log what the secret was used for.
3. After changing a Convex environment variable, update the copy Aaron keeps, or, while backup encryption is on, run the Nightly backup by hand so `env/` holds the new set ([backup runbook](backup-restore.md#when-an-environment-variable-changes)). The old value stays in older `env/` copies; that is harmless once it is revoked.

Convex commands run with the production deploy key in the shell only, as in the [release runbook](release.md#convex-production-deployment): `read -rs CONVEX_DEPLOY_KEY && export CONVEX_DEPLOY_KEY` before, `unset CONVEX_DEPLOY_KEY` after.

| Secret                                                                     | Where it lives                                                                                                  | A holder can                                                                                                                                                                                                                                    | Rotate                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONVEX_DEPLOY_KEY`                                                        | GitHub `production` environment                                                                                 | Push functions, read and write all data, read every Convex variable                                                                                                                                                                             | Convex dashboard → Production → Settings → URL & Deploy Key: generate a key, replace the GitHub secret, delete the old key. Treat the Convex variables below as leaked, look for pushes or variable changes you did not make, and run **Deploy** from `main`                                                |
| `CONVEX_BACKUP_DEPLOY_KEY`                                                 | GitHub `backups` environment                                                                                    | Export all data and files, read every Convex variable, run functions                                                                                                                                                                            | As above, in the `backups` environment; then run the Nightly backup by hand                                                                                                                                                                                                                                 |
| `JWT_PRIVATE_KEY`, `JWKS`                                                  | Convex variables; R2 `env/`                                                                                     | Sign access tokens (the app's session check also needs a live session id)                                                                                                                                                                       | `npx convex env remove JWT_PRIVATE_KEY`, `npx convex env remove JWKS`, then `SITE_URL=https://ops.angeloneaviation.org npm run setup:auth`, which makes both and keeps the other keys; without `SITE_URL` it keeps the address already set. Old tokens stop working; sessions refresh onto the new key      |
| `CREDENTIALS_ENCRYPTION_KEY`, `CREDENTIALS_ENCRYPTION_KEYS`                | Convex variables; R2 `env/`                                                                                     | Decrypt the saved FAA, Geoapify and Aircraft Spruce credentials in any copy of the data                                                                                                                                                         | [Rotating the key](credentials-key.md#rotating-the-key), then replace those credentials with each provider                                                                                                                                                                                                  |
| `AUTH_GOOGLE_SECRET`                                                       | Convex variable                                                                                                 | Act as the app's Google client; signing in as a user still needs their Google account                                                                                                                                                           | Google Cloud console → Google Auth Platform → **Clients** → "Angel One production": add a secret, set `AUTH_GOOGLE_SECRET`, delete the old secret                                                                                                                                                           |
| `AUTH_MICROSOFT_ENTRA_ID_SECRET`                                           | Convex variable                                                                                                 | As for Google                                                                                                                                                                                                                                   | Entra admin center → App registrations → Angel One → **Certificates & secrets**: new secret, set the variable, delete the old secret, note the expiry in [accounts.md](accounts.md)                                                                                                                         |
| `RESEND_API_KEY`                                                           | Convex variable                                                                                                 | Send email from the verified domain                                                                                                                                                                                                             | Resend: create a key, set `RESEND_API_KEY`, delete the old key                                                                                                                                                                                                                                              |
| FAA DRS key, Geoapify key, Aircraft Spruce login                           | Sealed in the database (Settings → System, Settings → Flight Program), or `FAA_DRS_API_KEY`, `GEOAPIFY_API_KEY` | Use those services as the program                                                                                                                                                                                                               | Replace with the provider, then save the new value in Settings (or the variable)                                                                                                                                                                                                                            |
| `CLOUDFLARE_API_TOKEN`                                                     | GitHub `production` environment                                                                                 | Publish any website at ops.angeloneaviation.org                                                                                                                                                                                                 | Cloudflare → Manage Account → Account API Tokens (or My Profile → API Tokens): roll or delete it, make a new one as in [Cloudflare setup](release.md#cloudflare), replace the GitHub secret. In `npx wrangler deployments list`, look for versions without a `main` commit tag; roll back or run **Deploy** |
| R2 token (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`)                      | GitHub `backups` environment                                                                                    | Read every backup: while they are unencrypted (ADR-0014) that is every record, user, password hash and file (not sessions), so treat a leak as SEV1. Also add objects and change `state/`; the lock rules stop it deleting or replacing backups | Cloudflare → R2 → API tokens: a new token with object read and write on `angelone-backups` only, replace both secrets, delete the old token, run the Nightly backup by hand                                                                                                                                 |
| Backup private key (`age`)                                                 | Aaron's password manager; the organization's sealed copy                                                        | Decrypt every backup made with it, including the `monthly/` copies kept forever                                                                                                                                                                 | [Changing the backup key](backup-restore.md#changing-the-backup-key). Existing backups are locked and stay readable with the leaked key: treat it as exposure of all records to date (SEV1)                                                                                                                 |
| Dropbox (`DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`) | GitHub `backups` environment                                                                                    | Read, add and delete the readable workbooks: names, emails, costs and change history                                                                                                                                                            | Dropbox App Console → the app → **Settings**: regenerate the app secret, which stops the refresh token; repeat [steps 2 and 3](dropbox-records-copy.md#2-get-a-refresh-token). Review who the folder is shared with                                                                                         |
| `FIRST_ADMIN_PASSWORD`                                                     | GitHub `production` environment, until first-time setup is green                                                | Sign in as the first administrator, until their password changes                                                                                                                                                                                | Delete the secret; reset that administrator's password                                                                                                                                                                                                                                                      |
| `SENTRY_AUTH_TOKEN`                                                        | GitHub `production` environment                                                                                 | Upload source maps and releases to the Sentry project, and read its errors (no app data)                                                                                                                                                        | Sentry → Settings → Auth Tokens: revoke it, create a new one, and replace the secret ([monitoring](monitoring.md))                                                                                                                                                                                          |
| `BACKUP_HEARTBEAT_URL`                                                     | GitHub `backups` environment                                                                                    | Send fake "backup succeeded" pings, hiding a missed backup from the alert                                                                                                                                                                       | Better Stack → the heartbeat: delete it and create a new one; replace the secret ([monitoring](monitoring.md))                                                                                                                                                                                              |
| A maintainer's GitHub login or token                                       | GitHub                                                                                                          | Change `main`, which deploys after green CI; with admin rights, change environments and secrets                                                                                                                                                 | Revoke the token or sessions; review the organization audit log and recent commits on `main`                                                                                                                                                                                                                |

Gap: no command ends every user's sessions at once. After a signing-key leak, rotation is the fix; to end sessions as well, reset or disable users one by one.

## Cross-tenant data exposure

A member of one Flight Program saw or changed another program's records, or an owner view showed more than its whitelist. The server enforces every permission ([CONTEXT.md](../../CONTEXT.md) §5), so this is a server bug or a wrong permission group: SEV1.

1. **Wrong group or bug?** Check the user's permission groups (Administration → Users). A group opened to all aircraft by mistake is fixed in the app ([accounts runbook](accounts.md#permission-groups-opened-to-all-aircraft-before-the-34-fix)); then go to step 4.
2. **Contain a bug.** Disable any account that used it on purpose. Find the release that brought it (the reporter's steps, the Deploy runs) and revert it on `main` (pull request, CI, Deploy). Rolling back the website alone does not help: the data comes from Convex functions, which have no rollback ([release runbook](release.md#backend-no-rollback-fix-forward)).
3. **Prove the fix**: a `convex-test` case that crosses programs and fails before the fix, then the fix, then deploy.
4. **Find the extent.** Writes: Change history in each program, or the `audit` table filtered by `programUuid` and `actorId`. Reads are not logged: assume everything the faulty path returned was seen, from the release that brought it to the fix.
5. **Correct** wrong writes with corrections in the right program. Never re-tag or delete change-log rows.
6. **Notify** the affected program's Flight Program administrators and the organization contact; they decide whether to tell the people whose data was exposed.

## Bad deploy

From the [release runbook](release.md#rollback):

1. Stop further releases: Actions → **Deploy** → **···** → **Disable workflow**.
2. **Screens broken**: roll the website back. Cloudflare dashboard → Workers & Pages → **angel-one** → **Deployments** → the previous version (its tag is the commit) → **Rollback**, or:

   ```sh
   npx wrangler deployments list
   npx wrangler rollback <version-id> --message "Reason"
   ```

   Installed apps show the update prompt; **Reload** loads the older version.

3. **Data or functions broken**: Convex has no rollback. Revert the commit on `main` with a pull request; when CI is green, enable the Deploy workflow and run it from `main`. If the reverted schema rejects documents the newer code wrote, write a forward fix instead.
4. If data was damaged, go on to [Data loss or corruption](#data-loss-or-corruption).
5. Enable the Deploy workflow again once `main` is good.

## Data loss or corruption

Records are append-only: a wrong entry is answered with a correction, never by editing history. The signed aircraft logbooks stay the maintenance record ([ADR-0004](../adr/0004-logbook-generator-and-status-record-system.md)).

1. Ask users to stop entering records for the affected aircraft or program.
2. Keep the damaged state: Convex dashboard → Backups → **Backup now** (with file storage), and run the Nightly backup by hand.
3. Only a few records wrong: correct each in the app, with a reason. Stop here.
4. Otherwise restore, following [Real restore](backup-restore.md#real-restore-production): the Convex dashboard for the last 7 days, R2 for anything older. A restore replaces everything written since its snapshot, so first list those entries (Change history, the step 2 backup) to enter them again.
5. Pending entries still on devices sync after the restore; flights that no longer match the aircraft counters wait for administrator review. Entries that had synced after the snapshot are gone and must be entered again.
6. Record the restore with `audit:recordManualEntry` ([how](database-access.md#recording-the-hand-written-change-log-entry)).
7. Check the status records of each affected aircraft against its logbooks.

## Vulnerable dependency

1. **Where does it run?** `npm audit` lists advisories and `npm ls <package>` shows what pulls it in. Code reached from `src/` ships to browsers, from `convex/` runs on Convex; the rest is build and test tooling. `jsqr` ships but is a dev dependency (review finding S21), so `npm audit --omit=dev` misses it. The `wrangler` version pinned in `deploy.yml` is outside Dependabot.
2. **Is it reachable?** Is the vulnerable code called, with input an outsider controls? The 2026-11-02 review found DOMPurify and seroval unreachable, and `@convex-dev/auth` 0.0.95 open to anyone (SEV1).
3. **Fix** on a branch: the Dependabot pull request, or `npm install <package>@<fixed version>`. Run `npm run check` and `npm run test:e2e`, and for the auth library the auth `convex-test` suites. Merge; a green CI push deploys.
4. **No fix yet**: turn off the feature that reaches it if you can (removing a provider's `AUTH_*` variables hides that sign-in button) and record the decision in the security review.
5. Look in the change log for unexpected entries while it was exposed.

## Lost or stolen device

On the device: the cached snapshot of the user's active Flight Program, stored unencrypted in browser storage (review finding S6), with aircraft, records, change log, costs and members; pending entries; kept manuals. The app opens the snapshot without a password until 7 days after the user signed in on that device. After that it refuses to open it, but the data stays in browser storage until the app next connects. Sessions have no idle timeout (Aaron's decision, 2026-11-04).

1. Ask which device and account, when they last signed in on it, whether it has a screen lock, and what was not synced.
2. End the account's sessions: a system administrator resets the user's password (Administration → Users → the user's **Reset password**), so the user can carry on elsewhere. Disable the user instead if the person is the risk. Either way the device can no longer load data or sync, and if it connects with the app open, the app deletes the cached snapshot and kept manuals.
3. Use the device's own remote lock or erase (Apple Find My, Google Find My Device, or the program's device management, if any).
4. Ask the user to enter again anything that had not synced.
5. Severity: SEV2 for an administrator's device or one without a screen lock, otherwise SEV3. Tell the user's Flight Program administrator.

Gap: the app cannot wipe a device that stays offline, and its cached data is not encrypted at rest (review finding S6).

## Evidence to keep

Keep it in the incident folder (______), not in the repository or any shared or public place. Write no passwords, keys or tokens into it.

- **The timeline**, in UTC.
- **A locked backup**: run the Nightly backup by hand; the R2 lock rules keep it for 90 days. For longer, download the backup file into the incident folder.
- **The change log**: never edited, and in every backup. Note the rows that matter (time, action, actor id).
- **Convex function logs**: dashboard → Logs. Copy the lines you need at once: no log stream keeps them longer yet.
- **GitHub**: the run logs of the Deploy and backup runs involved, and the organization audit log.
- **Cloudflare**: `npx wrangler deployments list`, and the account audit log.
- **Provider logs** for a leaked secret.
- **Messages** from the reporter or users.

Gap: no error monitoring or alerting is set up ([go-live checklist](../go-live-checklist.md)), so detection relies on users, failed workflow emails and the daily digest.

## Who to notify

Names and how to reach each person live in the incident contact sheet (______), not in this file.

| Role                                                                       | Who                    | When                                                                                                  |
| -------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------- |
| Incident lead: Aaron                                                       | ______                 | Every incident                                                                                        |
| Deputy, when the lead cannot be reached                                    | ______                 | After ______ without an answer                                                                        |
| Organization contact (holds the sealed backup key, ADR-0010)               | ______                 | SEV1 within the hour; SEV2 the same day                                                               |
| Reader of accounts@angeloneonline.org                                      | ______                 | Every report: acknowledge within 3 business days, triage within 10 ([SECURITY.md](../../SECURITY.md)) |
| Flight Program administrators of affected programs                         | Administration → Users | When their program's records or members are affected                                                  |
| Affected users                                                             |                        | When their account or data was exposed; the organization contact decides, with advice                 |
| Legal or insurance adviser                                                 | ______                 | A SEV1 that exposed personal data                                                                     |
| Providers (Convex, Cloudflare, GitHub, Google, Microsoft, Dropbox, Resend) | Their support          | When their service was the way in, or must act                                                        |

## After the incident

Within 5 business days the incident lead writes a blameless review, `docs/security/incident-YYYY-MM-DD.md`, with no personal data, no secrets and no detail of a weakness still open:

- what happened and its impact: which accounts and records, for how long;
- the timeline, in UTC;
- the cause, asking "why" until you reach something you can change;
- what went well and what did not;
- actions, each with an owner and a date, including fixes to this runbook.

Rotate any break-glass credential that was used ([break-glass runbook](break-glass-admin.md#rotate-after-use)), and enable the Deploy workflow again if it was disabled.
