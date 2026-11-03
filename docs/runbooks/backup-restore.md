# Backup and restore

Policy: [ADR-0008](../adr/0008-daily-backups-off-site-90-days-monthly-forever.md). Plan and deployments: [ADR-0007](../adr/0007-convex-pro-single-seat.md). This runbook is a draft until the backup workflow is built; steps marked **(to build)** do not exist yet.

## What is backed up, where

| Copy | Where | Kept |
|---|---|---|
| Convex scheduled backup | Convex dashboard > Backups (production) | 7 days |
| Nightly export (encrypted) | R2 bucket `angelone-backups`, `daily/` | 90 days, locked |
| Monthly archive (encrypted) | Same bucket, `monthly/` | Forever, locked |
| Environment variables (encrypted) | Same bucket, `env/` | Forever, locked |

Who holds the decryption key: the technical owner (named in `accounts.md`) in their password manager, plus a sealed copy held by the organization, not by a Convex user (ADR-0010), at: _______.

## Daily checks (automatic)

- The nightly workflow **(to build)** emails the technical owner when it fails.
- The alert digest **(to build)** warns administrators when the newest off-site copy is older than 36 hours.

## When an environment variable changes

Run the "export environment" workflow **(to build)**, or by hand:

```sh
npx convex env list --prod --include-values > env.txt
age -r "$BACKUP_PUBLIC_KEY" -o env-$(date +%F).txt.age env.txt && rm env.txt
# upload env-YYYY-MM-DD.txt.age to the bucket's env/ folder
```

## Quarterly restore rehearsal

1. Download the newest `monthly/` archive and the newest `env/` file; decrypt both with the escrowed key.
2. Create a scratch deployment (a preview deployment, per ADR-0007). Never use one other people can sign in to.
3. Set its environment variables from the decrypted env file (change `SITE_URL` to the scratch site).
4. `npx convex import --deployment <scratch> --replace-all -y snapshot.zip`
5. Check: per-table row counts match the export, an administrator can sign in, one aircraft's records and one attachment open.
6. Delete the scratch deployment and the decrypted files.
7. Log it below.

| Date | Snapshot used | Passed? | Time taken | By |
|---|---|---|---|---|
| | | | | |

## Real restore (production)

1. Stop writes: tell users, and take the site offline if needed.
2. Take a fresh Convex backup first. Restores are destructive.
3. Restore from the Convex dashboard (last 7 days) or `npx convex import --prod --replace-all snapshot.zip` (older, from R2).
4. Re-apply environment variables if the deployment is new.
5. Verify as in the rehearsal.
6. Record the restore in the app's change log by hand (ADR-0005): what was restored, from which snapshot, and why. Use `audit:recordManualEntry` as described in [Production database access](database-access.md#recording-the-hand-written-change-log-entry).
