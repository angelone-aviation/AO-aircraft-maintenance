# Convex backup & restore options for the Angel One production deployment

Researched 2026-11-01 against docs.convex.dev, convex.dev, news.convex.dev and the `convex` CLI 1.46.0 bundled in this repo (`npx convex export|import|env --help`). No deployment was contacted.

## Summary

Convex gives small teams two primary-source backup paths: dashboard **Backups** (on-demand on every plan, scheduled daily/weekly only on Pro, retained 7/14 days, destructive restore) and the **CLI snapshot export/import** (`npx convex export` produces the same consistent-snapshot ZIP a backup does; `npx convex import --replace` restores it into the same or a different deployment, preserving `_id`/`_creationTime`, atomically). Neither includes code, env vars, or pending scheduled functions, so secrets such as `CREDENTIALS_ENCRYPTION_KEY`, `JWT_PRIVATE_KEY`/`JWKS`, `SITE_URL` and `RESEND_*` must be backed up separately via `npx convex env list` or the dashboard. There is no point-in-time recovery or undo; recovery is limited to whichever snapshot predates the bad write. Data is AES-256 encrypted at rest, replicated across AZs with 11-nines backup durability, SOC 2 Type 2, in a region chosen at deployment creation (US East default). Streaming export (Fivetran / Data Sync API) needs Pro and is not a backup. Off-platform copies via CI are feasible with a scoped deploy key, but Convex publishes no official GitHub Actions backup example.

## Facts table

| Capability | What Convex provides | Plan | Source |
|---|---|---|---|
| Snapshot export (CLI) | `npx convex export --path <dir|file.zip> [--include-file-storage]`; creates a backup server-side and downloads `snapshot_{ts}.zip`; only one export may run at a time | All | [CLI help (1.46.0)](https://docs.convex.dev/cli); [backup-restore](https://docs.convex.dev/database/backup-restore) |
| Consistency | "A backup is a consistent snapshot of your table data made at the time of your request" | All | [backup-restore](https://docs.convex.dev/database/backup-restore) |
| ZIP layout | `<table>/documents.jsonl`; `generated_schema.jsonl` preserves Int64/Bytes; `_storage/documents.jsonl` + `_storage/<id>` when files included | All | [import](https://docs.convex.dev/database/import-export/import); [backup-restore](https://docs.convex.dev/database/backup-restore) |
| Import / restore | `npx convex import <zip> [--replace|--append|--replace-all] [--prod|--deployment <ref>]`; atomic (except `--append`); keeps `_id`, `_creationTime`, `_storage` ids | All | [import](https://docs.convex.dev/database/import-export/import); CLI help |
| Dashboard on-demand backup | "Backup Now"; kept 7 days; Free/Starter: max 2 backups per deployment | All | [backup-restore](https://docs.convex.dev/database/backup-restore) |
| Scheduled backups | Daily (7-day retention) or weekly (14-day) at chosen time, optional file storage | Pro | [backup-restore](https://docs.convex.dev/database/backup-restore); [pricing](https://www.convex.dev/pricing) |
| Restore semantics | "destructive operation that wipes your existing data"; existing files not deleted; can restore from another deployment on same team | All | [backup-restore](https://docs.convex.dev/database/backup-restore) |
| Not in backups | Code/config (`schema.ts`, `crons.ts`, `auth.config`), **environment variables**, pending scheduled functions | — | [backup-restore](https://docs.convex.dev/database/backup-restore) |
| Env var export | `npx convex env list --include-values > .env.convex`; restore `npx convex env set --force < .env.convex`; `--prod` to target prod | All | [CLI env](https://docs.convex.dev/cli); [env vars](https://docs.convex.dev/production/environment-variables) |
| Deploy keys for CI | `CONVEX_DEPLOY_KEY` makes CLI non-interactive; key pins the deployment (`--prod`/`--deployment` ignored with a warning); permissions scoped per key | All | [deploy-key-types](https://docs.convex.dev/cli/deploy-key-types); CLI source |
| Scoped permissions | `deployment:backups:view/download/create/import/delete/configurePeriodic`, `deployment:data:view`, `deployment:env:view/write` | All (custom roles: Business) | [role-actions](https://docs.convex.dev/team-management/role-actions) |
| PITR / undo | None documented | — | [backup-restore](https://docs.convex.dev/database/backup-restore) |
| Durability / encryption | Multi-AZ replication; backups 99.999999999% durable; AES-256 at rest, TLS in transit; SOC 2 Type 2; HIPAA BAA available | All | [production/state](https://docs.convex.dev/production/state/); [security](https://www.convex.dev/security) |
| Region | Chosen at deployment creation: `aws-us-east-1` (default), `aws-eu-west-1`, `aws-ap-southeast-2`, `aws-ca-central-1` (non-US +30%); cannot be changed | All | [regions](https://docs.convex.dev/production/regions) |
| Streaming export | Fivetran connector / `POST /data/sync` (beta), needs `deployment:data:view` | Pro | [streaming](https://docs.convex.dev/production/integrations/streaming-import-export); [data-sync](https://docs.convex.dev/deployment-api/data-sync) |
| Billing of backups | Reads all docs (DB bandwidth), files (file bandwidth); stored backups billed at file-storage rates; egress incl. backups 1 GB/mo Free, 50 GB Pro | — | [limits](https://docs.convex.dev/production/state/limits) |

## 1. Snapshot export (`npx convex export`)

- Flags in 1.46.0: `--path <dir|zip>`, `--include-file-storage`, `--prod`, `--deployment <name|ref|dev|prod|local|team:project:ref>`. Default target is the dev deployment. ([CLI help](https://docs.convex.dev/cli))
- Implementation (CLI source `src/cli/lib/convexExport.ts`): `POST /api/export/request/zip?includeStorage=…`, subscribe to `_system/cli/exports:getLatest` until `completed`, then `GET /api/export/zip/{start_ts}`. If another export is pending the server returns `ExportInProgress` and the CLI exits: "Only one can run at a time." Output name `snapshot_<ns-timestamp>.zip`. ([backup-restore](https://docs.convex.dev/database/backup-restore))
- Consistency: identical mechanism to dashboard backups, which are a consistent snapshot at request time. A manual backup "may take a few seconds to a few hours" depending on data size. ([backup-restore](https://docs.convex.dev/database/backup-restore))
- Auth: with `CONVEX_DEPLOY_KEY` set the CLI uses that key's deployment and logs "Ignoring `--prod` … using deployment from CONVEX_DEPLOY_KEY" (CLI source). Use a production deploy key generated in dashboard Settings > Deploy keys or `npx convex deployment token create <name> --deployment prod`. ([deploy-key-types](https://docs.convex.dev/cli/deploy-key-types))
- Limits: no documented max export size; counts against data egress (1 GB/mo Free, 50 GB Pro). ([limits](https://docs.convex.dev/production/state/limits))

## 2. Snapshot import (`npx convex import`)

- Modes: default fails if any target table has data; `--replace` replaces only tables in the ZIP; `--append` adds; `--replace-all` (CLI 1.46.0, not on the docs page) also deletes tables absent from the import and clears schema tables absent from the ZIP. `-y` skips the deletion confirmation. `--table` only for CSV/JSONL/JSON, not ZIP. ([CLI help](https://docs.convex.dev/cli))
- Preserves `_id` and `_creationTime` ("the only way to create documents with pre-existing `_id`"); `_storage` docs and files restored with ids and `contentType`. Atomic per import; indexes and schema apply "without needing time for re-backfilling or re-validating". ([import](https://docs.convex.dev/database/import-export/import))
- Cross-deployment: documented use cases include seeding dev/preview from prod backups and `--prod --replace` for prod restore; "a backup from its own deployment always works"; deployments created before Convex 1.7 may not be fully supported. A restore-rehearsal deployment is therefore supported (`--deployment <scratch-ref>`). ([import](https://docs.convex.dev/database/import-export/import))
- Gotchas: do not edit the ZIP; imports use DB/file bandwidth (`_cli/import`); 16 MiB/line and 1 MiB/document limits; Fivetran syncs must be reset after a restore. `@convex-dev/auth` tables (`authSessions`, `authRefreshTokens`, etc.) are ordinary tables in the ZIP, but sessions are only valid if the restored deployment has the same `JWT_PRIVATE_KEY`/`JWKS` env vars.

## 3. Dashboard Backups

Covered in the table. Pro adds scheduling; Free/Starter is capped at two stored backups. Restore wipes data first (take a fresh backup before restoring, as Convex recommends). Backups are downloadable as the same ZIP the CLI produces, so they can be moved off-platform. Dedicated-hardware physical backups cannot be downloaded. ([backup-restore](https://docs.convex.dev/database/backup-restore); [news vol. 12](https://news.convex.dev/product-updates-volume-12/))

## 4. Environment variables & secrets

Explicitly **not included** in backups/exports. Per-deployment limits: 512 vars, 8 KiB/value. Export with `npx convex env list --include-values --prod > .env.convex` (CLI docs' own backup recipe), store encrypted (e.g. age/1Password/GitHub secret), and restore with `npx convex env set --force --prod < .env.convex`. Project-level defaults (`npx convex env default`) seed only new deployments. This app's critical set per `.env.example`: `CREDENTIALS_ENCRYPTION_KEY` (never rotate on a deployment with saved credentials), `JWT_PRIVATE_KEY`, `JWKS`, `SITE_URL`, `RESEND_API_KEY`, `RESEND_FROM`, `GEOAPIFY_API_KEY`, `FAA_DRS_API_KEY`. ([env vars](https://docs.convex.dev/production/environment-variables); [CLI](https://docs.convex.dev/cli))

## 5. PITR / durability

No PITR, row history or undo is documented; recovery granularity equals snapshot cadence (max 1/day scheduled, retained 7 days). Durability/encryption/SOC 2 as in table; data location is the deployment's region (this project's existing deployment cannot be moved; migration = export + import into a new deployment). ([production/state](https://docs.convex.dev/production/state/); [regions](https://docs.convex.dev/production/regions))

## 6. Automating off-platform copies

Pattern: GitHub Actions `schedule:` cron, `CONVEX_DEPLOY_KEY` repo secret (scoped key with backup create/download permission), `npx convex export --include-file-storage --path backup.zip`, then upload to S3/R2/B2 with the provider CLI. The deploy-key docs describe CI use generally; Convex has **no official scheduled-backup workflow example**. Rate limit: one export in flight per deployment; cost = egress + DB bandwidth per run (whole dataset each time). ([deploy-key-types](https://docs.convex.dev/cli/deploy-key-types))

## 7. Streaming export

Fivetran (export) and `POST /data/sync` require Pro and `deployment:data:view`; Airbyte is import-only. Beta; cursor-based, not a snapshot, and the docs do not position it as a backup. ([streaming](https://docs.convex.dev/production/integrations/streaming-import-export); [data-sync](https://docs.convex.dev/deployment-api/data-sync))

## Draft backup/restore policy options

| Option | Shape | Cost / effort | Gap |
|---|---|---|---|
| A. Free-tier minimum | Weekly manual "Backup Now" (+ files) in dashboard; monthly `npx convex export` to encrypted team storage; env vars exported once and after each change | $0; ~10 min/week manual | 7-day RPO, human-dependent, 2-backup cap |
| B. Pro + CI off-platform (recommended) | Pro daily scheduled backup with files; weekly GitHub Actions export (`--include-file-storage`) to S3/R2 with 90-day retention; env-var export on change; quarterly restore rehearsal into a scratch deployment | $25/dev/mo + minutes of CI + cents of storage; ~1 day setup | 24 h RPO; no PITR |
| C. Pro + daily CI | As B but daily CI export, retained 30 daily / 12 monthly | Same plus more egress (dataset size × 30/mo vs 50 GB included) | Still 24 h RPO |

Restore runbook for any option: fresh backup → `npx convex import --deployment prod --replace snapshot.zip` (or dashboard Restore) → verify env vars → verify `_scheduled_functions`/crons.

## Open questions

1. Which exact role action a deploy key needs for `npx convex export` (likely `deployment:backups:create` + `download`); not stated in docs — verify by creating a scoped key.
2. Whether a `_tables` manifest exists in the ZIP (docs name only `documents.jsonl`, `generated_schema.jsonl`, `_storage`).
3. Behaviour when the ZIP violates the current `schema.ts` (import docs say indexes/schema apply without re-validation; failure mode undocumented).
4. Confirm current Angel One prod deployment region and plan tier in the dashboard.
