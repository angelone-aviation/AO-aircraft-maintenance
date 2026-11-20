# Go-live checklist

The remaining work before Angel One is used for real records. Decisions are recorded in [`docs/adr/`](adr/); this list tracks what is still to do. Issue numbers such as "#34" in other docs refer to the earlier tracker and are kept for traceability.

## Status

- [x] Code moved to the organization repository `angelone-aviation/AO-aircraft-maintenance`.
- [x] Convex plan: Pro, **one** member, Aaron ([ADR-0010](adr/0010-one-convex-administrator.md)).
- [x] Hosting: the website runs on **Cloudflare** (`ops.angeloneaviation.org`); the backend stays on Convex.
- [x] New Convex Pro account created.
- [x] Old production deployment retired (2026-11-03): deleted, with nothing migrated. It held only test data and still ran the auth library with the critical flaw (security review S1). Production starts fresh on the new Convex Pro account. Still to do if not done yet: remove the old site files from A2 Hosting and revoke any API keys only the old deployment used.
- [ ] Accounts inventory: [`docs/runbooks/accounts.md`](runbooks/accounts.md) was mostly filled in on 2026-11-20; finish the rows its "Unknowns to find out" lists. First, two-step sign-in on the shared `accounts@angeloneonline.org` login ([risks R24](handbook/4-money-and-risk/risks.md#r24-one-mailbox-can-reset-cloudflare-and-better-stack)).
- [ ] Backups: the nightly backup job is set up and runs; its first run, by hand, passed on 2026-11-20. Left: the first restore rehearsal ([below](#backup-setup-remaining)).
- [ ] File clean-up: the hourly sweep of stored files no record refers to starts in report-only mode (`FILE_SWEEP` unset) and deletes nothing. Review its first report, then set `FILE_SWEEP=delete` ([file sweep runbook](runbooks/file-sweep.md#review-the-first-pass-then-switch-to-delete)).
- [x] Release process: CI checks, Cloudflare hosting with security headers, the Deploy workflow (it starts after a green CI push to `main`, or by hand), rollback steps and Dependabot updates are in the repository and in use ([release runbook](runbooks/release.md)).
  - [x] Cloudflare, the Convex deploy key and the GitHub `production` environment are set up, and the first release was made on 2026-11-03.
  - [x] Cloudflare's Git build for the `angel-one` Worker was disconnected on 2026-11-20 (Workers & Pages → `angel-one` → Settings → Build), so only Deploy publishes. Never reconnect it ([release runbook](runbooks/release.md#cloudflare), [risks R22](handbook/4-money-and-risk/risks.md#r22-cloudflares-git-build-publishes-the-site)).
  - [x] CodeQL code scanning: on (default set-up, enabled 2026-11-20).
  - [ ] Preview deployments per change are not built yet ([release runbook](runbooks/release.md#not-set-up-yet)).
- [x] Monitoring: Better Stack (two uptime monitors and a backup heartbeat), set up on 2026-11-20. Sentry error reporting is supported by the code but not used ([monitoring runbook](runbooks/monitoring.md)). The heartbeat secret was added on 2026-11-20.
- [ ] Ownership and runbooks: Aaron, plus onboarding, release and incident-response runbooks.
  - [ ] Fill in the names and places left blank in [incident response](runbooks/incident-response.md) (including who reads accounts@angeloneonline.org, the [`SECURITY.md`](../SECURITY.md) contact) and [break-glass administrator access](runbooks/break-glass-admin.md), and set up the break-glass account.
- [ ] Data on shared or lost devices: offline copy, sign-out, device unlock. Decided 2026-11-19: the seven-day offline copy stays as it is, signing out clears the device after warning about unsynced work ([signing out](offline.md#signing-out-and-shared-devices)), and phones and tablets need a screen lock. File links now expire after five minutes ([file links](file-links.md)). Still to do: tell users about the screen lock.
- [x] Per-aircraft records export (FAA inspection access and aircraft sale): [records package](records-export.md).
- [x] FAA scope changes: inspection sign-off certificate, "Performed by" line, Form 337 attachments.
- [x] Architecture cleanups: one command transaction on the server, one flight-submission module.
- [x] Google and Microsoft sign-in: removed on 2026-11-20 before they were switched on; everyone signs in with a password ([ADR-0015](adr/0015-remove-google-and-microsoft-sign-in.md)).
- [x] The placeholder aircraft drawing was replaced on 2026-11-11 by the supplied Cessna picture (`public/branding/aircraft.webp`, see `public/branding/SOURCE.txt`).
- [x] Deploy: the fresh production deployment was set up and first deployed on 2026-11-03 ([First-time setup (no terminal)](runbooks/release.md#first-time-setup-no-terminal)), and every green CI push to `main` has deployed since. The README's two older data-repair commands are not needed on a fresh deployment; the history [migrations](handbook/3-running-it/operations.md#after-a-release-or-a-restore-the-migrations) are, after a release that adds derived columns or keys and after any restore.
- [ ] Upload the reference manuals to the app's Reference library (optimize large PDFs first).
  - [ ] On each hangar tablet and phone, add the app to the Home Screen, use **Keep on this device** for the manuals that crew needs, and confirm they open in airplane mode.
- [ ] Acceptance testing on real phones and tablets (iOS 16.4 or Chrome 111 and newer), real aircraft data checked against logbooks, and training.

## Backup setup (remaining)

Policy: [ADR-0008](adr/0008-daily-backups-off-site-90-days-monthly-forever.md). Runbook: [backup and restore](runbooks/backup-restore.md). How to do each step: [set up from scratch, section 7](handbook/3-running-it/setup-from-scratch.md#7-backups).

Backups are unencrypted ([ADR-0014](adr/0014-backups-stored-unencrypted.md)), so there is no key step ([to turn encryption on](runbooks/backup-restore.md#to-turn-encryption-on)). `BACKUP_AGE_PUBLIC_KEY` stays unset, and only accounts that may read every record should hold the R2 token or the Cloudflare login.

Done, as of 2026-11-20:

- [x] Convex Pro account.
- [x] The **daily scheduled backup, including file storage**, is on for the production deployment (Convex dashboard → Backups).
- [x] The Cloudflare R2 bucket `angelone-backups` exists in the organization's Cloudflare account, with **Public access** off: no `r2.dev` address and no custom domain. Keep it so: the copies are readable by anyone who can fetch them.
- [x] R2 bucket lock rules: `daily/` 90 days; `monthly/` and `env/` indefinite. `state/` is unlocked (with encryption on, the job replaces a small file there). A lifecycle rule deletes `daily/` objects after 91 days.
- [x] The GitHub environment `backups`: deployment branches `main` only, and no required reviewers (they would hold every nightly run). Its secrets are **environment secrets**, not repository secrets.
- [x] An R2 API token with object read and write on that bucket only, saved as the `backups` secrets `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_ACCOUNT_ID`.
- [x] A scoped production deploy key for backups, saved as the `backups` secret `CONVEX_BACKUP_DEPLOY_KEY`. It can export the data and files and run internal mutations; it cannot deploy or read environment variables ([its permissions](handbook/3-running-it/setup-from-scratch.md#7-backups)).
- [x] The time zone: `RECORDS_TIME_ZONE` is `America/Edmonton` on the Convex production deployment (set 2026-11-19) and as the `backups` environment variable (set 2026-11-20).
- [x] Failed runs email Aaron ([runbook](runbooks/backup-restore.md#who-is-told-when-it-fails)).
- [x] The Better Stack heartbeat URL is the `backups` secret `BACKUP_HEARTBEAT_URL` ([monitoring](runbooks/monitoring.md#better-stack-uptime-and-the-backup-heartbeat)).
- [x] The first run by hand: Nightly backup run #19 passed export, upload, record and the heartbeat ([check that it worked](runbooks/backup-restore.md#check-that-it-worked)). A manual run before it failed on a wrong `R2_ACCOUNT_ID`, since corrected.

Still to do:

- [ ] Do the first [restore rehearsal](runbooks/backup-restore.md#quarterly-restore-rehearsal) and log it in the runbook. Until it passes, the off-site backup is not proven.
- [ ] Aaron turns on **Email me a daily alert digest** (Settings → Alerts). The app's "no off-site backup for over 26 hours" warning goes only to system administrators with this switch on, and it is off by default for a system administrator who is not also a Flight Program administrator.
- [ ] Recommended: keep `CREDENTIALS_ENCRYPTION_KEY` in Aaron's password manager. The job saves no environment variables while encryption is off, and without that key a restore onto a new Convex account cannot open the saved FAA, Geoapify and Aircraft Spruce credentials.
- [ ] Optional readable copy in Dropbox ([runbook](runbooks/dropbox-records-copy.md), ADR-0011): from an **organization** Dropbox account with two-step sign-in, create an App-folder app, get its refresh token, and add `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET` and `DROPBOX_REFRESH_TOKEN` as `backups` environment secrets. Decide who may open the folder: the workbook is readable, not encrypted.

## Recurring tasks

The daily, weekly, monthly, quarterly and yearly tasks, with who does each and how long it takes, are in the handbook's [checklists](handbook/3-running-it/checklists.md). The dated renewals (`security.txt` before 2027-09-04, because RFC 9116 treats an expired file as stale; the FAA DRS API key before 2027-10-14) are under [One-off and dated](handbook/3-running-it/checklists.md#one-off-and-dated).

Budget about one to two hours a quarter. The built website keeps working untouched, but three things rot if nobody looks: the sign-in library (pre-release, with security fixes every few months), the GitHub Actions runners that run CI, deploys and the nightly backup (GitHub retires old Node versions and runner images), and the keys and dates that expire.
