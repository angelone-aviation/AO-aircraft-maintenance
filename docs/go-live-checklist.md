# Go-live checklist

The remaining work before Angel One is used for real records. Decisions are recorded in [`docs/adr/`](adr/); this list tracks what is still to do. Issue numbers such as "#34" in other docs refer to the earlier tracker and are kept for traceability.

## Status

- [x] Code moved to the organization repository `angelone-aviation/AO-aircraft-maintenance`.
- [x] Convex plan: Pro, **one** member, the technical owner ([ADR-0010](adr/0010-one-convex-administrator.md)).
- [x] Hosting: the website runs on **Cloudflare** (`ops.angeloneaviation.org`); the backend stays on Convex.
- [x] New Convex Pro account created.
- [x] Old production deployment retired (2026-11-03): deleted, with nothing migrated. It held only test data and still ran the auth library with the critical flaw (security review S1). Production starts fresh on the new Convex Pro account. Still to do if not done yet: remove the old site files from A2 Hosting and revoke any API keys only the old deployment used.
- [ ] Accounts inventory: fill in [`docs/runbooks/accounts.md`](runbooks/accounts.md) after connecting the new Convex account.
- [ ] Backups: the nightly backup job is built; finish the setup below.
- [ ] File clean-up: the hourly sweep of stored files no record refers to starts in report-only mode (`FILE_SWEEP` unset) and deletes nothing. Review its first report, then set `FILE_SWEEP=delete` ([file sweep runbook](runbooks/file-sweep.md#review-the-first-pass-then-switch-to-delete)).
- [x] Release process: CI checks, Cloudflare hosting with security headers, the Deploy workflow (it starts after a green CI push to `main`, or by hand), rollback steps and Dependabot updates are in the repository and in use ([release runbook](runbooks/release.md)).
  - [x] Cloudflare, the Convex deploy key and the GitHub `production` environment are set up, and the first release was made on 2026-11-03.
  - [ ] Preview deployments per change are not built yet ([release runbook](runbooks/release.md#not-set-up-yet)).
- [ ] Error monitoring: service, alerts and who receives them.
- [ ] Ownership and runbooks: technical owner, plus onboarding, release and incident-response runbooks.
  - [ ] Fill in the names and places left blank in [incident response](runbooks/incident-response.md) (including who reads accounts@angeloneonline.org, the [`SECURITY.md`](../SECURITY.md) contact) and [break-glass administrator access](runbooks/break-glass-admin.md), and set up the break-glass account.
- [ ] Data on shared or lost devices: offline copy, sign-out, device unlock. Decided 2026-11-19: the seven-day offline copy stays as it is, signing out clears the device after warning about unsynced work ([signing out](offline.md#signing-out-and-shared-devices)), and phones and tablets need a screen lock. File links now expire after five minutes ([file links](file-links.md)). Still to do: tell users about the screen lock, and the release step in [file links](file-links.md#what-is-left).
- [x] Per-aircraft records export (FAA inspection access and aircraft sale): [records package](records-export.md).
- [x] FAA scope changes: inspection sign-off certificate, "Performed by" line, Form 337 attachments.
- [x] Architecture cleanups: one command transaction on the server, one flight-submission module.
- [ ] Google and Microsoft sign-in (built): create the Google Cloud sign-in client and the Microsoft Entra app registration, set their environment variables on production and test each with a real account ([accounts runbook](runbooks/accounts.md#google-and-microsoft-sign-in)).
- [ ] Replace the placeholder aircraft drawing (`public/branding/cessna-oblique.svg`, see `public/branding/SOURCE.txt`).
- [x] Deploy: the fresh production deployment was set up and first deployed on 2026-11-03 ([First-time setup (no terminal)](runbooks/release.md#first-time-setup-no-terminal)), and every green CI push to `main` has deployed since. The README's one-off data-repair commands are not needed on a fresh deployment.
- [ ] Upload the reference manuals to the app's Reference library (optimize large PDFs first).
  - [ ] On each hangar tablet and phone, add the app to the Home Screen, use **Keep on this device** for the manuals that crew needs, and confirm they open in airplane mode.
- [ ] Acceptance testing on real phones and tablets (iOS 16.4 or Chrome 111 and newer), real aircraft data checked against logbooks, and training.

## Backup setup (remaining)

Policy: [ADR-0008](adr/0008-daily-backups-off-site-90-days-monthly-forever.md). Runbook: [backup and restore](runbooks/backup-restore.md).

- [x] Convex Pro account.
- [ ] Turn on the **daily scheduled backup, including file storage**, on the production deployment (Convex dashboard → Backups).
- [ ] Create a Cloudflare R2 bucket `angelone-backups` in the organization's Cloudflare account.
- [ ] Add R2 bucket lock rules: `daily/` 90 days; `monthly/` and `env/` indefinite. Leave `state/` unlocked (the job replaces a small file there). Add a lifecycle rule deleting `daily/` objects after 91 days.
- [ ] In GitHub, Settings → Environments → **New environment** `backups`. Deployment branches: `main` only. No required reviewers (they would hold every nightly run). The secrets below go into this environment as **environment secrets**, not repository secrets.
- [ ] Create an R2 API token with object read and write on that bucket only; save it as `backups` environment secrets `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_ACCOUNT_ID`. If the bucket is not `angelone-backups`, add the environment variable `R2_BUCKET`.
- [ ] Generate an `age` key pair (`age-keygen -o key.txt`). Public key → `backups` environment secret `BACKUP_AGE_PUBLIC_KEY`. Private key → the technical owner's password manager plus a sealed copy held by the organization (ADR-0010); then delete `key.txt`.
- [ ] Create a production deploy key for backups → `backups` environment secret `CONVEX_BACKUP_DEPLOY_KEY`. It must be able to export data, read environment variables and run functions.
- [ ] Make sure failed runs email the technical owner ([runbook](runbooks/backup-restore.md#who-is-told-when-it-fails)).
- [ ] The technical owner turns on **Email me a daily alert digest** (Settings → Alerts). The app's "no off-site backup for over 26 hours" warning goes only to system administrators with this switch on, and it is off by default for a system administrator who is not also a Flight Program administrator.
- [ ] Optional readable copy in Dropbox ([runbook](runbooks/dropbox-records-copy.md), ADR-0011): from an **organization** Dropbox account with two-step sign-in, create an App-folder app, get its refresh token, and add `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET` and `DROPBOX_REFRESH_TOKEN` as `backups` environment secrets (and the variable `RECORDS_TIME_ZONE` if the program is not on US Eastern time). Decide who may open the folder: the workbook is readable, not encrypted.
- [ ] Run the workflow by hand once (Actions → **Nightly backup** → **Run workflow**), confirm the object appears in R2 under `daily/` (and `monthly/` and `env/`), and do the first [restore rehearsal](runbooks/backup-restore.md#quarterly-restore-rehearsal).

## Recurring tasks

The app is meant to run for years with little attention. The built website keeps working untouched, but three things rot if nobody looks: the sign-in library (pre-release, with security fixes every few months), the GitHub Actions runners that run CI, deploys and the nightly backup (GitHub retires old Node versions and runner images), and the keys and dates below. Budget about one to two hours a quarter. Merging a Dependabot pull request into `main` deploys it once CI is green, so merge one at a time and watch the Deploy run.

| When                  | Task                                                                                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| At once               | Merge a Dependabot update that GitHub marks High or Critical, the sign-in library (`@convex-dev/auth`) first. Read its release notes; a green CI run is the gate ([release runbook](runbooks/release.md#what-runs-where)).                                          |
| Every quarter (1–2 h) | Merge the open Dependabot pull requests whose CI is green, one at a time. Confirm last night's **Nightly backup** run succeeded and that a **Deploy** still works.               |
| Every quarter         | [Restore rehearsal](runbooks/backup-restore.md#quarterly-restore-rehearsal).                                                                                                                                                                                        |
| Twice a year          | [Test break-glass administrator access](runbooks/break-glass-admin.md#test-twice-a-year).                                                                                                                                                                           |
| Every year            | Raise `node-version` in all four workflows to the current Node LTS before the pinned one reaches end of life (Node 22: April 2027). Rebuild from a clean checkout (`npm ci && npm run check`) to prove the project still builds.                                    |
| Every year            | Rotate the Cloudflare API token, the Microsoft Entra client secret and the Dropbox tokens, and record the new expiry dates in [accounts](runbooks/accounts.md). Decrypt one backup with the organization's sealed key copy ([runbook](runbooks/backup-restore.md)). |
| Before 2027-09-04     | Renew `public/.well-known/security.txt`: set `Expires` about 11 months ahead (it now expires 2027-10-04, and RFC 9116 treats an expired file as stale), check `Contact` still reaches someone, and deploy.                                                          |
| Before 2027-10-14     | Renew the FAA DRS API key (Settings → System shows the date and warns from 60 days out).                                                                                                                                                                            |
