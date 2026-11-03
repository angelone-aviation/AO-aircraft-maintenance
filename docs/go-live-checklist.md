# Go-live checklist

The remaining work before Angel One is used for real records. Decisions are recorded in [`docs/adr/`](adr/); this list tracks what is still to do. Issue numbers such as "#34" in other docs refer to the earlier tracker and are kept for traceability.

## Status

- [x] Code moved to the organization repository `angelone-aviation/AO-aircraft-maintenance`.
- [x] Convex plan: Pro, **one** member, the technical owner ([ADR-0010](adr/0010-one-convex-administrator.md)).
- [x] Hosting: the website will run on **Cloudflare**; the backend stays on Convex.
- [x] New Convex Pro account created.
- [ ] Old production deployment (owned by the original project owner): deploy the security fixes there if it stays in use before the cutover, or retire it.
- [ ] Accounts inventory: fill in [`docs/runbooks/accounts.md`](runbooks/accounts.md) after connecting the new Convex account.
- [ ] Backups: finish the setup below, then build the nightly backup job.
- [ ] Release process: CI checks, preview deployments, Cloudflare hosting with security headers, rollback, dependency updates.
- [ ] Error monitoring: service, alerts and who receives them.
- [ ] Ownership and runbooks: technical owner, plus onboarding, release and incident-response runbooks.
- [ ] Data on shared or lost devices: offline copy, sign-out, device unlock.
- [ ] Per-aircraft records export (FAA inspection access and aircraft sale).
- [ ] Ready to build: Google and Microsoft sign-in (needs a Google Cloud sign-in client and a Microsoft Entra app registration); FAA scope changes (inspection sign-off certificate, "Performed by" line, Form 337 attachments); two architecture cleanups.
- [ ] Replace the placeholder aircraft drawing (`public/branding/cessna-oblique.svg`, see `public/branding/SOURCE.txt`).
- [ ] Deploy and run the post-deploy commands in the README "Deployment" section.
- [ ] Upload the reference manuals to the app's Reference library (optimize large PDFs first).
- [ ] Acceptance testing on real phones and tablets (iOS 16.4 or Chrome 111 and newer), real aircraft data checked against logbooks, and training.

## Backup setup (remaining)

Policy: [ADR-0008](adr/0008-daily-backups-off-site-90-days-monthly-forever.md). Runbook: [backup and restore](runbooks/backup-restore.md).

- [x] Convex Pro account.
- [ ] Turn on the **daily scheduled backup, including file storage**, on the production deployment (Convex dashboard → Backups).
- [ ] Create a Cloudflare R2 bucket `angelone-backups` in the organization's Cloudflare account.
- [ ] Add R2 bucket lock rules: `daily/` 90 days; `monthly/` and `env/` indefinite. Add a lifecycle rule deleting `daily/` objects after 91 days.
- [ ] Create an R2 API token with object read and write on that bucket only; save it as GitHub repository secrets `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_ACCOUNT_ID`.
- [ ] Generate an `age` key pair. Public key → GitHub secret `BACKUP_AGE_PUBLIC_KEY`. Private key → the technical owner's password manager plus a sealed copy held by the organization (ADR-0010).
- [ ] Create a production deploy key for backups → GitHub secret `CONVEX_BACKUP_DEPLOY_KEY`.
- [ ] Export the production environment variables once, encrypted, as the runbook describes.
- [ ] Then: build the nightly backup workflow and its freshness alert, and run the first restore rehearsal.
