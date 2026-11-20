# Checklists

What to check, how often, who does it, and how. Copy a section into an issue or a notebook and tick it off.

- **Sources:** [recurring tasks](../../go-live-checklist.md#recurring-tasks), the [runbooks](../../runbooks/), [ADR-0008](../../adr/0008-daily-backups-off-site-90-days-monthly-forever.md).
- **Times** are rough. The go-live checklist budgets one to two hours a quarter for upkeep.
- **Aaron** runs the app. "An administrator" means a Flight Program administrator unless it says system administrator.

## Daily

### In the hangar

- [ ] **Aircraft status.** An administrator or mechanic, 5 min. Overview: any aircraft **Not OK to fly**, and what is due soon ([maintenance workflows](../../maintenance-workflows.md)).
- [ ] **Alerts.** Everyone, 2 min. The bell or the **Alerts** page; urgent ones also arrive by email or push ([alerts](../../alerts.md)).
- [ ] **Held flights.** An administrator, 5 min. Flight log → **Review** each **Needs review** flight; accept (with corrections) or reject. Until then the aircraft's totals leave it out ([offline](../../offline.md#flights-held-for-review)).
- [ ] **Open problem reports.** A mechanic or administrator, 5 min. **Discrepancies**: anything grounding, deferrals near their deadline, reports with no work order ([maintenance workflows](../../maintenance-workflows.md)).
- [ ] **Sync center.** Each pilot, 1 min. No entries left in **Needs attention** ([offline](../../offline.md#pending-entries-and-the-sync-center)).

### For Aaron

- [ ] **Read any failure email.** 2 min each. A failed Nightly backup (GitHub email), a Better Stack alert (site down, Convex sign-in down, missed heartbeat). Fix by the matching table: [nightly backup errors](../../runbooks/backup-restore.md#when-a-nightly-run-fails), [monitoring](../../runbooks/monitoring.md).
- [ ] **The 13:00 UTC digest.** 2 min. An "Off-site backups" warning means no good backup for 26 hours.

## Weekly

- [ ] **Parts on order.** An inventory administrator, 15 min. **Purchase orders**: overdue deliveries, shipments to receive, cores and repairs still out ([purchase orders](../../purchase-orders.md), [parts requests](../../parts-and-repair-requests.md)).
- [ ] **Work orders.** A mechanic or administrator, 10 min. Tasks **delayed for parts**; orders ready to close ([work orders](../../work-orders.md)).
- [ ] **Planning.** An administrator, 10 min. What falls due across the fleet in the coming weeks; open work orders for it.
- [ ] **Dependabot.** Aaron, 5 min. Merge any update GitHub marks High or Critical at once, the sign-in library (`@convex-dev/auth`) first. Merging deploys once CI is green ([release runbook](../../runbooks/release.md#what-runs-where)).
- [ ] **Summary.** An administrator, 10 min. Change history → **Summary** for the last 7 days ([change history](../../change-history.md)).

## Monthly

- [ ] **Paper check.** An administrator, 15–30 min per aircraft, while paper logbooks run beside the app. Tick each recorded flight and completed work order against the paper logbook ([paper check](../../reconciliation.md)).
- [ ] **Expiring dates.** An administrator, 5 min. Settings → Flight Program and Settings → System → Expiring dates: insurance, registration, keys, `security.txt`. Alerts start 60 days out ([alerts](../../alerts.md)).
- [ ] **Keep `main` active.** Aaron, 2 min. GitHub stops scheduled workflows in a public repository after **60 days without activity**, which stops the nightly backup. Check Actions → Nightly backup is enabled and ran last night; if it was disabled, **Enable workflow** ([backup runbook](../../runbooks/backup-restore.md#who-is-told-when-it-fails), [GitHub docs](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/disabling-and-enabling-a-workflow)).

## Quarterly

Budget 1–2 hours.

- [ ] **Merge Dependabot pull requests** whose CI is green, one at a time, watching each Deploy. Aaron, 30 min ([recurring tasks](../../go-live-checklist.md#recurring-tasks)).
- [ ] **Confirm last night's backup** succeeded and that a Deploy still works. Aaron, 5 min.
- [ ] **Restore rehearsal.** Aaron, about 1 hour. Newest monthly copy into a scratch deployment; table counts match; an administrator signs in; an aircraft and an attachment open; run the four migrations; **Load older** works. Log it in the runbook ([quarterly rehearsal](../../runbooks/backup-restore.md#quarterly-restore-rehearsal)).
- [ ] **Convex log check.** Aaron, 10 min. Convex dashboard → Logs: search "Many bytes read" and "took a long time" on `operations:snapshot`, `operations:reviewFlight` and the saves. Warnings mean roadmap findings 74a or 74d are due ([capacity](../2-how-it-works/capacity-and-limits.md#when-to-look-again)).
- [ ] **Access review.** Aaron, 15 min. The Convex team's members and deploy keys match [accounts](../../runbooks/accounts.md#production-dashboard-administrators); every "Audit · manual entry" since last time matches an issue or a restore ([database access](../../runbooks/database-access.md#checks)); who can open the Dropbox folder ([Dropbox copy](../../runbooks/dropbox-records-copy.md#who-may-have-access-to-the-folder)).
- [ ] **Risk register.** Aaron, 10 min. Update [risks](../4-money-and-risk/risks.md).

## Twice a year

- [ ] **Test break-glass access.** Aaron with the sealed-copy holder, 30 min, during two rehearsals six months apart. Check the sealed copy; sign in with the break-glass account in a private window; check its sign-ins are all logged tests; practise the dashboard repair in the scratch deployment ([break-glass](../../runbooks/break-glass-admin.md#test-twice-a-year)).

## Yearly

- [ ] **Node version.** Aaron, 30 min. Raise `node-version` in all four workflows to the current Node LTS before the pinned one ends (Node 22: April 2027). Rebuild from a clean checkout: `npm ci && npm run check`.
- [ ] **Rotate tokens.** Aaron, 30 min. The Cloudflare API token, the Microsoft Entra client secret (if SSO is on) and the Dropbox tokens; record new expiry dates in [accounts](../../runbooks/accounts.md) and under Expiring dates ([incident runbook: leaked secret](../../runbooks/incident-response.md#leaked-secret) has the steps for each).
- [ ] **VAPID key review.** Aaron, 5 min. The push key pair's yearly review date under Expiring dates. Rotating it signs every device out of alerts ([monitoring](../../runbooks/monitoring.md#alerts-by-email-and-on-devices)).
- [ ] **Backup key.** Aaron, 15 min. If backup encryption is switched on, decrypt one backup with the organisation's sealed key copy ([backup runbook](../../runbooks/backup-restore.md)).
- [ ] **Cost review.** Aaron, 15 min. Convex usage, R2 size and the Dropbox folder against [services and costs](../4-money-and-risk/services-and-costs.md). Monthly archives grow forever by design ([ADR-0008](../../adr/0008-daily-backups-off-site-90-days-monthly-forever.md)).

## One-off and dated

- [ ] **Review the file sweep, then switch it on.** Aaron, 10 min, from 21 Nov 2026. Convex Logs → search `fileSweep would delete`; check a few ids are referenced nowhere; then `FILE_SWEEP=delete` ([file sweep](../../runbooks/file-sweep.md#review-the-first-pass-then-switch-to-delete)).
- [ ] **Finish the backup set-up.** Aaron, about 1 hour: backup deploy key, time zone, failure email, heartbeat secret, a manual run, the first rehearsal ([go-live checklist](../../go-live-checklist.md#backup-setup-remaining)).
- [ ] **Add `security.txt` to Expiring dates.** Aaron, 5 min. Settings → System → Expiring dates, expiring 2027-10-04.
- [ ] **Renew `security.txt` before 2027-09-04.** Aaron, 15 min. It expires **2027-10-04**. Set `Expires` about 11 months ahead in [`public/.well-known/security.txt`](../../../public/.well-known/security.txt), check `Contact` still reaches someone, deploy.
- [ ] **Renew the FAA DRS key before 2027-10-14.** Aaron, 15 min. Renew on the FAA website, then Settings → System → **FAA API key and renewal** with the new expiry ([airworthiness](../../airworthiness.md)).
- [ ] **Keep the credential key safe.** Aaron, 5 min, once unencrypted backups ship (`work/backup-plain`). Save `CREDENTIALS_ENCRYPTION_KEY` in his password manager: the unencrypted job saves no environment variables, and without the key a restore onto a new Convex account can't open the saved FAA, Geoapify and Aircraft Spruce credentials.

## Whenever it happens

- [ ] **After any restore:** run, each until it reports 0: `migrations:backfillHistoryColumns`, `migrations:rebuildRecordNumbers`, `migrations:rebuildCostLedger`; then `migrations:reconcileCostLedger` must answer `differing: 0` ([operations](operations.md#after-a-release-or-a-restore-the-migrations)). Then record the restore with `audit:recordManualEntry`.
- [ ] **After a release that names a one-off command:** run it as the pull request says ([README](../../../README.md#one-off-steps-for-deployments-with-older-data)).
- [ ] **After changing a Convex environment variable, with backup encryption on:** run the Nightly backup by hand so `env/` holds the new set; after changing the backup key, check the next run's summary lists an `env/` object.
- [ ] **When the reconcile logs "The cost ledger differs from its records.":** run `migrations:rebuildCostLedger` until 0.
- [ ] **When a person leaves:** a system administrator disables their account; remove them from the Dropbox folder; if they held a Convex key, rotate it ([accounts](../../runbooks/accounts.md#disabling-a-user)).
- [ ] **When a device is lost:** follow [lost or stolen device](../../runbooks/incident-response.md#lost-or-stolen-device).
- [ ] **A red Deploy saying "is not the newest commit on main"** after two quick merges is expected, not a failure.
