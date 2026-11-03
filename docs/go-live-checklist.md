# Go-live checklist

The remaining work before Angel One is used for real records. Decisions are recorded in [`docs/adr/`](adr/); this list tracks what is still to do. Issue numbers such as "#34" in other docs refer to the earlier tracker and are kept for traceability.

## Status

- [x] Code moved to the organization repository `angelone-aviation/AO-aircraft-maintenance`.
- [x] Convex plan: Pro, **one** member, the technical owner ([ADR-0010](adr/0010-one-convex-administrator.md)).
- [x] Hosting: the website will run on **Cloudflare**; the backend stays on Convex.
- [x] New Convex Pro account created.
- [ ] Old production deployment (owned by the original project owner): deploy the security fixes there if it stays in use before the cutover, or retire it.
- [ ] Accounts inventory: fill in [`docs/runbooks/accounts.md`](runbooks/accounts.md) after connecting the new Convex account.
- [ ] Backups: the nightly backup job is built; finish the setup below.
- [ ] Release process: CI checks, preview deployments, Cloudflare hosting with security headers, rollback, dependency updates.
  - [ ] Set up Cloudflare, the Convex deploy key and the GitHub `production` environment, then make the first release, following the [release runbook](runbooks/release.md). CI, the security headers, the manual Deploy workflow, rollback steps and Dependabot are already in the repository; preview deployments are not built yet.
- [ ] Error monitoring: service, alerts and who receives them.
- [ ] Ownership and runbooks: technical owner, plus onboarding, release and incident-response runbooks.
- [ ] Data on shared or lost devices: offline copy, sign-out, device unlock.
- [ ] Per-aircraft records export (FAA inspection access and aircraft sale).
- [x] FAA scope changes: inspection sign-off certificate, "Performed by" line, Form 337 attachments.
- [x] Architecture cleanups: one command transaction on the server, one flight-submission module.
- [ ] Google and Microsoft sign-in (built): create the Google Cloud sign-in client and the Microsoft Entra app registration, set their environment variables on production and test each with a real account ([accounts runbook](runbooks/accounts.md#google-and-microsoft-sign-in)).
- [ ] Replace the placeholder aircraft drawing (`public/branding/cessna-oblique.svg`, see `public/branding/SOURCE.txt`).
- [ ] Deploy and run the post-deploy commands in the README "Deployment" section.
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
- [ ] The technical owner turns on **Email me a daily alert digest** (Settings → My account). The app's "no off-site backup for over 36 hours" warning goes only to system administrators with this switch on, and it is off by default for a system administrator who is not also a Flight Program administrator.
- [ ] Run the workflow by hand once (Actions → **Nightly backup** → **Run workflow**), confirm the object appears in R2 under `daily/` (and `monthly/` and `env/`), and do the first [restore rehearsal](runbooks/backup-restore.md#quarterly-restore-rehearsal).
