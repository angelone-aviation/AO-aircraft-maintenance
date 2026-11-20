---
status: accepted
date: 2026-11-02
---

# Daily backups copied off-site automatically, kept 90 days, with one per month kept forever

> Encryption and the `env/` copy are changed by [ADR-0014](0014-backups-stored-unencrypted.md): since 20 Nov 2026 the copies are stored unencrypted unless a backup key is set.

Production data is backed up **every day**. Daily copies are kept for **90 days**, and the first copy of each month is kept **forever**. Copies leave Convex automatically: a scheduled job exports a full snapshot, including uploaded files, every night and uploads it to **Cloudflare R2** object storage, which the program will already use for website hosting. Nobody has to remember to do it, and a missed night alerts the technical owner.

Maintenance records must survive for the life of the aircraft (14 CFR 91.417(b)(2)), and ADR-0005 relies on independent off-site copies to prove the change log was not tampered with. Convex's own scheduled backups only reach back 7 days, so they cannot meet either need alone.

## The policy

| Layer | What | Kept | Purpose |
|---|---|---|---|
| Convex scheduled backup (Pro) | Daily, with file storage | 7 days (Convex limit) | Fast restore of a recent mistake from the dashboard |
| Nightly off-site export | Full snapshot ZIP with files, uploaded to R2 `daily/`; encrypted only while a backup key is set (ADR-0014) | 90 days, then deleted by a lifecycle rule | Recovery from loss of the Convex account or deployment; tamper evidence |
| Monthly archive | The first nightly export of each month, copied to R2 `monthly/` | Forever | Life-of-aircraft retention; long-range tamper evidence |
| Environment variables | `npx convex env list` output, encrypted, uploaded to R2 `env/`; not saved while no backup key is set (ADR-0014) | Every version, forever | Backups do not contain secrets; without `CREDENTIALS_ENCRYPTION_KEY`, `JWT_PRIVATE_KEY` and `JWKS`, a restored deployment cannot decrypt saved credentials or keep sessions |

## How it runs

- A GitHub Actions workflow on a nightly schedule runs `npx convex export --include-file-storage` with a production deploy key scoped to backups, encrypts the ZIP with `age` to a public key when one is set (ADR-0014), and uploads it to R2. The job runs on GitHub's scheduler, not inside the app: Convex functions cannot run the export themselves.
- **Encryption**: superseded by ADR-0014; since 20 Nov 2026 the archives are stored unencrypted unless a backup key is set. While one is set, archives are encrypted before upload. The private key is held by the technical owner in a password manager, plus a sealed copy held by the organization (ADR-0010; originally "two people … plus a sealed paper copy"). Losing every copy of the key makes every archive unreadable, so escrow is checked at each rehearsal.
- **Tamper resistance**: R2 bucket lock rules stop deletion or overwrite of `daily/` objects for 90 days and of `monthly/` and `env/` objects indefinitely. The CI token can write but cannot shorten retention, so a stolen CI token cannot erase history.
- **Freshness alarm**: on success the job records the snapshot time in the app; the daily alert digest warns administrators when the newest off-site copy is older than 26 hours (36 until 2026-11-19, see Status), and a failed workflow run emails the technical owner.

## Restore

- **Rehearsal every quarter** (and after any schema change that renames or removes tables): restore the newest monthly archive into a scratch deployment (ADR-0007) with the escrowed environment variables. It passes when the import succeeds, per-table row counts match the export, an administrator can sign in, and one aircraft's records and one attachment open. Record the date, the snapshot used and the time taken in the backup runbook.
- **Real restore**: take a fresh backup first (restores are destructive), restore, re-apply environment variables, then record the restore in the change log by hand (ADR-0005).

## Consequences

- Cost: R2 storage at about US$0.015 per GB-month with no download fees; small at today's data size. Convex egress grows with dataset plus files; see ADR-0007.
- The monthly archive grows forever by design. Revisit storage cost yearly.
- Archives contain personal data of program members; deletion requests cannot reach the locked monthly archive. The records-retention duty takes precedence, and the privacy notice should say so.
- There is still no point-in-time recovery: the worst case loses up to one day of entries.

## Considered options

- **Convex scheduled backups only**: rejected; 7-day retention, and a lost Convex account loses the backups too.
- **Google Drive or OneDrive** as the off-site store: workable but harder to lock against deletion from automation; R2 chosen because the program will already hold a Cloudflare account. Any S3-compatible store can replace R2 without changing the policy.
- **Weekly instead of daily off-site copies**: rejected; a day is the most entries the program is willing to re-key.

## Status

- 2026-11-03: the nightly job is built. `.github/workflows/backup.yml` runs `scripts/backup/nightly.sh` at 08:41 UTC with the secrets of the GitHub `backups` environment; the app records each copy and warns after 36 hours. The monthly copy is the first successful night of each month, so a missed 1st is covered the next night. Environment variables are uploaded only when they change; the job keeps their fingerprint in an unlocked `state/` folder. It is not live until the bucket, lock rules, key pair and environment are set up by hand and the first restore rehearsal passes ([go-live checklist](../go-live-checklist.md#backup-setup-remaining), [runbook](../runbooks/backup-restore.md)).
- 2026-11-19: the app warns after 26 hours instead of 36 (decision D10). The digest checks once a day at 13:00 UTC, so the 36-hour limit first warned about 52 hours after the last good copy; 26 hours reports one missed night at the next day's digest ([runbook](../runbooks/backup-restore.md#who-is-told-when-it-fails)).
- 2026-11-20: backups are not encrypted, by Aaron's decision ([ADR-0014](0014-backups-stored-unencrypted.md)). Anyone holding the R2 keys or the Cloudflare login can read every record, user, password hash and file in them, but cannot sign in with a copied session. Without `BACKUP_AGE_PUBLIC_KEY` the job stores the export as `.unencrypted.zip` and does not save the environment variables; adding the key turns encryption, and the `env/` copy, back on.
