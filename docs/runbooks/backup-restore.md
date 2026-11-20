# Backup and restore

Policy: [ADR-0008](../adr/0008-daily-backups-off-site-90-days-monthly-forever.md), changed by [ADR-0014](../adr/0014-backups-stored-unencrypted.md). Plan and deployments: [ADR-0007](../adr/0007-convex-pro-single-seat.md). The nightly job is built; the bucket, R2 token and GitHub environment are set up by hand ([go-live checklist](../go-live-checklist.md#backup-setup-remaining)).

**Backups are not encrypted, by Aaron's decision on 20 Nov 2026. Anyone holding the R2 keys or the Cloudflare login can read every record, user, password hash and file in them, but cannot sign in with a copied session.** A copy also holds emails, certificate numbers, licence copies and the saved (still sealed) third-party credentials. Its sessions, refresh tokens, sign-in codes and OAuth verifiers are emptied before upload. Keep the bucket private and the R2 token and Cloudflare login to people who may read all of that. Encryption comes back by adding one secret: [To turn encryption on](#to-turn-encryption-on).

## What is backed up, where

| Copy | Where | Kept |
|---|---|---|
| Convex scheduled backup | Convex dashboard > Backups (production) | 7 days |
| Nightly export (**not** encrypted) | R2 bucket `angelone-backups`, `daily/` | 90 days, locked |
| Monthly archive (**not** encrypted) | Same bucket, `monthly/` | Forever, locked |
| Environment variables | **Not saved** while encryption is off; `env/`, encrypted, once a key is set | Forever, locked |
| Readable records workbook (Excel, **not** encrypted or locked), optional | Dropbox app folder, `/Daily/` and `/Monthly/` ([runbook](dropbox-records-copy.md), [ADR-0011](../adr/0011-readable-records-copy-in-dropbox.md)) | 90 days daily; monthly forever |

## The nightly job

The **Nightly backup** workflow (`.github/workflows/backup.yml`) runs `scripts/backup/nightly.sh` every day at 08:41 UTC (about 3:41 am US Eastern). It:

1. exports production with its uploaded files (`npx convex export --include-file-storage`) and checks that the ZIP is valid, includes file storage and holds at least one user account. It does not compare the table counts with earlier nights; the manifest keeps them so a person can;
2. with no `BACKUP_AGE_PUBLIC_KEY` (the set-up today), empties the sign-in tables `authSessions`, `authRefreshTokens`, `authVerificationCodes` and `authVerifiers` (they stay in the ZIP, with no rows; `users` and `authAccounts` stay whole) and names the ZIP `.unencrypted.zip`; with the key, keeps the full export and encrypts it with `age` to that public key (`.zip.age`);
3. uploads it to `daily/` with a manifest, and checks that the object is there at the right size;
4. on the first successful night of each month, uploads the same file to `monthly/` (if the 1st was missed, the next good night counts);
5. only with the key: saves the environment variables, encrypted, to `env/` when they or the backup key have changed since the last copy. Without the key it neither reads nor uploads them: they hold the credential and sign-in keys, and are never stored unencrypted;
6. records the copy in the app (`backups:recordOffsiteCopy`: the stored object's key, size and SHA-256), which shows it under Settings → System → Off-site backups;
7. if Dropbox is set up (`DROPBOX_REFRESH_TOKEN` in the `backups` environment), builds the readable Excel workbook from the same export and adds it to Dropbox ([Dropbox records copy](dropbox-records-copy.md)). This runs after step 6, so a Dropbox problem fails the run without hiding a good R2 copy.

The job never deletes or overwrites a backup in R2; deletion after 90 days is the bucket's lifecycle rule. It only reads and writes objects with the R2 token, and never changes the bucket's access. Two readable copies leave the runner: the R2 copy itself while encryption is off, readable by anyone with the R2 token or the Cloudflare login (ADR-0014); and the optional Dropbox workbook, readable by anyone with access to that folder (ADR-0011). Its secrets are in the GitHub environment `backups`. To test the script without credentials: `npm run test:backup` (needs `age`, `zip`, `unzip` and `jq`).

### What is in the bucket

```text
angelone-backups/
  daily/2026/11/20/angelone-20261120T084112Z.unencrypted.zip             export, NOT encrypted (90 days)
  daily/2026/11/20/angelone-20261120T084112Z.unencrypted.manifest.json   its manifest
  monthly/2026-11/angelone-20261120T084112Z.unencrypted.zip              first good night of November (forever)
  monthly/2026-11/angelone-20261120T084112Z.unencrypted.manifest.json
```

The time in each name is when the export started, in UTC, so names sort by time. The **manifest** holds no personal data or secrets: `"encrypted": false`, a `notice` that starts `NOT ENCRYPTED`, `signInRecordsRemoved` (the emptied tables and why), `exportStartedAt`, `gitCommit`, `convexCliVersion`, the SHA-256 and size of the uploaded ZIP (after the tables were emptied), and the document count per table. The run's summary heading ends `NOT ENCRYPTED`; it says who can read the copy and which tables were emptied.

With a backup key the names end `.zip.age` and `.manifest.json`, and `env/` and `state/` appear ([To turn encryption on](#to-turn-encryption-on)).

### Run it by hand

GitHub → **Actions** → **Nightly backup** → **Run workflow** → branch `main` → **Run workflow**. It is safe at any time: every run makes a new daily copy and never replaces one. Do this after changing an environment variable, before a release (with the Convex dashboard backup in the [release checklist](release.md#release)), and to check the setup.

### Check that it worked

1. The run is green. Its summary lists each object it uploaded with its size.
2. Settings → System → **Off-site backups** in the app shows the new copy's time.
3. Cloudflare dashboard → **R2** → `angelone-backups` → `daily/<year>/<month>/<day>/`: the `.unencrypted.zip` and `.unencrypted.manifest.json` are there, with the sizes from the run summary.

### Who is told when it fails

- **GitHub emails failed scheduled runs** to the account that last changed the `cron` line in `backup.yml`, or, if the workflow was disabled and enabled again, to the account that enabled it. To make that the technical owner without editing the file, the technical owner opens Actions → Nightly backup → **···** → **Disable workflow**, then **Enable workflow**. Manual runs notify whoever started them.
- That account must have Actions emails on: profile picture → **Settings** → **Notifications** → **System** → **Actions**: choose **Email** and tick **Only notify for failed workflows**. The email goes to the address under **Default notifications email** on the same page.
- **The app warns** system administrators in the daily alert digest when the newest off-site copy is older than 26 hours (decision D10). The digest (13:00 UTC) is the only time the app checks. A normal run finishes about 08:45 UTC, so the copy is about 4 hours old at that day's digest. After one failed night it is about 28 hours old, and that day's digest warns. Two edge cases: a run GitHub starts more than about 4 hours late is reported as missed at that day's digest and clears the next day; and if the last good copy itself finished after 11:00 UTC, one missed night is reported only at the following day's digest. The email needs `RESEND_API_KEY` and `RESEND_FROM` on the deployment and reaches only system administrators whose alert email is on ([go-live checklist](../go-live-checklist.md#backup-setup-remaining)); Settings → System shows the newest copy at any time. For a same-day signal rely on GitHub's email above and the Better Stack heartbeat ([monitoring](monitoring.md#better-stack-uptime-and-the-backup-heartbeat)). The app's warning also catches a schedule that stopped running (GitHub turns off scheduled workflows in public repositories after 60 days without activity; re-enable it under Actions).

### When a nightly run fails

Open the failed run and read the red error line. Running the workflow again is always safe.

| Error says | Do this |
|---|---|
| `CONVEX_DEPLOY_KEY must be a production deploy key` | The `backups` environment secret `CONVEX_BACKUP_DEPLOY_KEY` is missing or not a `prod:` key. |
| `BACKUP_AGE_PUBLIC_KEY holds an age private key` | The private key was saved in GitHub by mistake. Delete that secret, then [change the key](#changing-the-backup-key). |
| `BACKUP_AGE_PUBLIC_KEY must be an age public key` | The secret is set but is not an `age1…` key. Delete it to store unencrypted copies, or put the right public key in it. |
| `objectKey must start with "daily/" and end with ".zip.age"` (in the recording step) | The app is older than ADR-0014 and refuses an `.unencrypted.zip` copy. Deploy the current `main`, then run again. |
| `The export has no documents in any table`, `… no file storage` or `… no user accounts` | The export is incomplete, or the deploy key belongs to a deployment nobody uses. Nothing was uploaded. Check that `CONVEX_BACKUP_DEPLOY_KEY` is the key of the production deployment people sign in to, then run again. |
| `npx convex export failed` | Check Convex status and that the deploy key still exists (Convex dashboard → Settings). Convex allows one export at a time per deployment, so a dashboard backup running at the same time can block it; run again later. |
| `Upload to s3://… failed` or `Could not check s3://…` | The R2 token expired, was deleted, or lacks object read and write on the bucket; or `R2_BUCKET` / `R2_ACCOUNT_ID` is wrong. |
| `… after upload, expected … bytes` | The upload was cut short. Run again. |
| `The backup itself succeeded … but recording it in the app failed` | The copy is in R2. Deploy the app if `backups:recordOffsiteCopy` is not live yet, then run again so the app sees a fresh copy. |
| `The R2 backup succeeded and is recorded, but the readable workbook could not be made` or `… the Dropbox copy failed` | The R2 copy is safe. See [Dropbox records copy](dropbox-records-copy.md) for the Dropbox error table. Running again adds the day's workbook if it is still missing. |

## When an environment variable changes

While encryption is off, the job does not save the environment variables, and a restore onto a new Convex account starts without them ([ADR-0014](../adr/0014-backups-stored-unencrypted.md)). After changing `CREDENTIALS_ENCRYPTION_KEY` or `CREDENTIALS_ENCRYPTION_KEYS`, update the copy in Aaron's password manager if he keeps one; without it, saved credentials cannot be opened after such a restore. With a key set, the next nightly run saves the new set to `env/` by itself.

## Download and check

1. Download the export and its manifest: Cloudflare dashboard → **R2** → `angelone-backups` → open the folder → the object → **Download**, then the `.unencrypted.manifest.json` beside it. Keep both in the same folder, on an encrypted disk: the ZIP holds every record and password hash. For a large file, the AWS CLI works with an R2 token that can read the bucket:

   ```sh
   aws s3 cp s3://angelone-backups/monthly/2026-11/angelone-20261120T084112Z.unencrypted.zip . \
     --endpoint-url "https://<account-id>.r2.cloudflarestorage.com" --region auto
   ```

2. Check it against its manifest. The helper checks the SHA-256, prints the document count per table, reminds you that the sign-in records were removed, and leaves the ZIP as it is, ready to import:

   ```sh
   scripts/backup/decrypt.sh angelone-20261120T084112Z.unencrypted.zip
   ```

   A copy made while encryption was on ends `.zip.age`: [Decrypt an encrypted copy](#decrypt-an-encrypted-copy). In the repository's top folder, `.gitignore` covers the names this runbook uses (`key.txt`, `new-key.txt`, `env.txt`, `angelone-env-….txt`, `*.age`, `*.manifest.json`, `*.zip`), so they cannot be committed by accident; a file with another name or in a subfolder is not covered.

## Quarterly restore rehearsal

Use the newest monthly copy.

1. In R2, open `monthly/`, then the newest month (for example `monthly/2026-11/`). Download `angelone-20261120T084112Z.unencrypted.zip` and `angelone-20261120T084112Z.unencrypted.manifest.json`.
2. Check it ([above](#download-and-check)): `scripts/backup/decrypt.sh angelone-20261120T084112Z.unencrypted.zip` checks the hash and lists the counts.
3. Create a scratch deployment (a preview deployment, per ADR-0007). Never use one other people can sign in to.
4. Set its variables. With no `env/` copy, make new sign-in keys and the site address with `SITE_URL=<scratch site> npm run setup:auth` against the scratch deployment, and set `CREDENTIALS_ENCRYPTION_KEY` from Aaron's password manager if he keeps it (`npx convex env set --deployment <scratch> CREDENTIALS_ENCRYPTION_KEY '<value>'`) before `setup:auth`, so that it does not make a new one. For a copy made while encryption was on, use the matching `env/` file as in [Decrypt an encrypted copy](#decrypt-an-encrypted-copy).
5. `npx convex import --deployment <scratch> --replace-all -y angelone-20261120T084112Z.unencrypted.zip`
6. Check: the document count of each table in the Convex dashboard (scratch deployment → Data) matches the counts `decrypt.sh` printed from the manifest; an administrator can sign in with their password; one aircraft's records and one attachment open. Without the credential key, saved FAA, Geoapify and Aircraft Spruce credentials do not open; that is expected while encryption is off. Nobody is signed in after the import: the copy has no sessions.
7. Run the history paging steps, each until it reports 0: `npx convex run --deployment <scratch> migrations:backfillHistoryColumns`, then `migrations:rebuildRecordNumbers`, then `migrations:rebuildCostLedger`; then `migrations:reconcileCostLedger` must answer `differing: 0`. Check that **Load older** on the Flight log loads older flights.
8. Delete the scratch deployment and the downloaded files (and `key.txt`, for an encrypted copy).
9. Log it below.

| Date | Snapshot used | Passed? | Time taken | By |
|---|---|---|---|---|
| | | | | |

## Real restore (production)

1. Stop writes: tell users, and take the site offline if needed.
2. Take a fresh Convex backup first. Restores are destructive.
3. Restore from the Convex dashboard (last 7 days), or from R2 for anything older: download and check the `daily/` or `monthly/` copy ([above](#download-and-check)), then `npx convex import --prod --replace-all angelone-<time>.unencrypted.zip` (or the decrypted `angelone-<time>.zip`).
4. If the deployment is new, set its environment variables: from the matching `env/` file for a copy made while encryption was on; otherwise as in step 4 of the [rehearsal](#quarterly-restore-rehearsal), then the other variables in the README's "Settings that live on the deployment". Administrators re-enter saved credentials that no longer open. After restoring an unencrypted copy everyone must sign in again with their password (or Google or Microsoft), which is harmless: the copy holds no sessions or refresh tokens.
5. Re-apply access changes made since the backup. A restore brings accounts, passwords, memberships and sessions back as they were: disable again anyone disabled since, reset again any password reset since, and remove again any member removed since.
6. Rebuild what the workspace's history window reads, in this order and each until it reports 0: `npx convex run --prod migrations:backfillHistoryColumns` (rows from before a column or a lookup key carry none), `migrations:rebuildRecordNumbers`, `migrations:rebuildCostLedger`; then `migrations:reconcileCostLedger` must answer `differing: 0` ([history paging](../history-paging.md#before-deploying-s7)). Until the backfill reaches 0 the workspace loads more than it needs, the history pages refuse, and a parts-request or purchase-order save can miss a reused request id, an open repair or an allocation on an older record; until the rebuilds do, a blank number can repeat an older one and the board can show less than was spent.
7. Verify as in the rehearsal.
8. Record the restore in the app's change log by hand (ADR-0005): what was restored, from which snapshot, and why. Use `audit:recordManualEntry` as described in [Production database access](database-access.md#recording-the-hand-written-change-log-entry).

## To turn encryption on

Encryption is off by Aaron's decision ([ADR-0014](../adr/0014-backups-stored-unencrypted.md)). To turn it back on:

1. Generate an `age` key pair: `age-keygen -o key.txt` prints the public key (`age1…`). Store the private key in the technical owner's password manager plus a sealed copy held by the organization, not by a Convex user (ADR-0010), at: _______. Then delete `key.txt`.
2. Add the public key as the `backups` environment secret `BACKUP_AGE_PUBLIC_KEY` (GitHub → Settings → Environments → `backups`). Never the private key: the job refuses it.
3. Add R2 lock rules for `env/` (indefinite), and leave `state/` unlocked (the job replaces `state/env-fingerprint.txt` there).
4. Run the workflow by hand. Its copy ends `.zip.age`, its summary no longer says `NOT ENCRYPTED`, and it lists an `env/` object. From then on the manifest holds `encryptedTo`, the public key used, and the SHA-256 of both the ZIP and the encrypted file.
5. The unencrypted copies already made stay as they are: locked, and readable by anyone with the R2 token or the Cloudflare login, for 90 days in `daily/` and forever in `monthly/`.

With encryption on, a restore needs the private key, at least once a year use the organization's sealed copy, and the [incident response runbook](incident-response.md) treats a leaked private key as SEV1.

### Decrypt an encrypted copy

1. Download the `.zip.age` and its `.manifest.json` as in [Download and check](#download-and-check). For a restore of a new deployment, also download from `env/` the newest `angelone-env-….txt.age` whose time is not later than the snapshot's.
2. Put the private key in a file only for as long as you need it, on an encrypted disk (for example `key.txt`, pasted from the password manager), and delete it afterwards.
3. Decrypt. The helper writes the file beside the `.age` file without `.age`, and for an export also checks the SHA-256 against the manifest and prints the document count per table:

   ```sh
   scripts/backup/decrypt.sh key.txt angelone-20261104T084112Z.zip.age
   scripts/backup/decrypt.sh key.txt angelone-env-20261101T084109Z.txt.age
   ```

   If `age` reports no matching identity, compare the manifest's `encryptedTo` with `age-keygen -y key.txt`: the file was encrypted to a different key.
4. For the environment file, change `SITE_URL` to the target site if it is a scratch deployment, then: `npx convex env set --deployment <target> --force --from-file angelone-env-20261101T084109Z.txt`. Delete the file afterwards.

### Changing the backup key

Do this if the private key may have been exposed, or when the holders change.

1. `age-keygen -o new-key.txt` prints the new public key (`age1…`). Store the private key as in step 1 above. Delete `new-key.txt`.
2. Replace the `backups` environment secret `BACKUP_AGE_PUBLIC_KEY` with the new public key, and run the workflow by hand. That run encrypts the export and a new `env/` copy to the new key, even when no variable changed; check that its summary lists an `env/` object.
3. **Keep every old private key** for as long as archives encrypted to it exist, which for `monthly/` and `env/` is forever. Label each with its public key; the manifest's `encryptedTo` says which one a file needs.

To turn encryption off again, delete `BACKUP_AGE_PUBLIC_KEY`; that is a decision to record in an ADR, as ADR-0014 did.
