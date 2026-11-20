# Risks

The risk register for Angel One, as of 20 November 2026. Review it with the quarterly restore rehearsal ([checklists](../3-running-it/checklists.md)).

- **Likelihood** and **impact** are judgements: Low, Medium or High.
- **Who acts** on it: mostly Aaron, the one Convex administrator.
- **Status:** Open (nothing done yet), Reduced (partly handled), Accepted (a decision to live with it), Closed.

## The five to watch first

1. **No working off-site backup yet**, and backups will be unencrypted when they start (R1, R2).
2. **One person** holds the Convex account and maintains the app (R3, R4).
3. **No second factor** on app accounts, and 2FA not yet confirmed on every operator account (R14).
4. **Convex can't roll back**, and the app has no other backend (R5, R6).
5. **Devices hold a readable copy for seven days**, protected only by a screen lock nobody checks (R10, R12).

## The register

### R1. Off-site backups are not running yet

- **Risk:** the nightly job fails until its set-up is finished, so only Convex's own 7-day backups exist.
- **Likelihood · Impact:** High until set up · High: losing the Convex account would lose every record.
- **What reduces it:** finishing the [backup set-up](../../go-live-checklist.md#backup-setup-remaining) and the first [restore rehearsal](../../runbooks/backup-restore.md#quarterly-restore-rehearsal).
- **Who acts:** Aaron.
- **Status:** Open.

### R2. Unencrypted backups

- **Risk:** anyone holding the R2 token, the Cloudflare login or a downloaded copy can read every record ([ADR-0014](../../adr/0014-backups-stored-unencrypted.md)).
- **Likelihood · Impact:** Low · High.
- **What reduces it:** a private, locked bucket and a one-bucket token, with encryption one secret away ([backup runbook](../../runbooks/backup-restore.md#to-turn-encryption-on)).
- **Who acts:** Aaron.
- **Status:** Accepted.

### R3. A single Convex administrator

- **Risk:** only Aaron can reach production data, deploy keys and the dashboard ([ADR-0010](../../adr/0010-one-convex-administrator.md)).
- **Likelihood · Impact:** Medium · High: if he is unavailable nobody can repair, restore or rotate.
- **What reduces it:** the break-glass account and sealed credentials ([runbook](../../runbooks/break-glass-admin.md)), which also needs Convex's account-recovery steps written down.
- **Who acts:** Aaron, with the organisation contact.
- **Status:** Open: names and sealed copies not set up yet.

### R4. A single maintainer

- **Risk:** one person knows the code, the release process and the accounts.
- **Likelihood · Impact:** High · High.
- **What reduces it:** this handbook, the [runbooks](../../runbooks/), a filled-in [accounts list](../../runbooks/accounts.md) and [incident contacts](../../runbooks/incident-response.md#who-to-notify), and a named deputy.
- **Who acts:** Aaron.
- **Status:** Open.

### R5. Convex can't roll back

- **Risk:** a bad backend release can only be fixed forward, and damaged data needs a restore ([release runbook](../../runbooks/release.md#backend-no-rollback-fix-forward)).
- **Likelihood · Impact:** Low · High.
- **What reduces it:** green CI before every deploy, additive schema changes and a Convex backup before merging.
- **Who acts:** Aaron.
- **Status:** Reduced.

### R6. Vendor lock-in to Convex

- **Risk:** functions, sign-in, files and data all live on Convex, so moving would mean rewriting `convex/`.
- **Likelihood · Impact:** Low · High.
- **What reduces it:** business rules kept in `src/domain` and plain ZIP backups ([ADR-0007](../../adr/0007-convex-pro-single-seat.md)).
- **Who acts:** Aaron.
- **Status:** Accepted.

### R7. Expiring FAA key and `security.txt`

- **Risk:** the FAA DRS key expires 14 Oct 2027 and `security.txt` on 4 Oct 2027, and dates are easy to miss.
- **Likelihood · Impact:** Medium · Medium: AD monitoring stops, or a stale disclosure file.
- **What reduces it:** the app's expiring-date warnings and the dated [checklists](../3-running-it/checklists.md#one-off-and-dated).
- **Who acts:** Aaron.
- **Status:** Reduced: add `security.txt` under Settings → System → Expiring dates.

### R8. GitHub stops scheduled workflows

- **Risk:** GitHub turns off a public repository's schedules after 60 days without activity, which stops the nightly backup ([GitHub docs](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/disabling-and-enabling-a-workflow)).
- **Likelihood · Impact:** Medium: the app is meant to run for years with little change · High: backups stop silently.
- **What reduces it:** the Better Stack heartbeat, the digest's 26-hour warning and [re-enabling the workflow](../../runbooks/backup-restore.md#who-is-told-when-it-fails).
- **Who acts:** Aaron.
- **Status:** Reduced.

### R9. Accepting a very old held flight is slow

- **Risk:** accepting a held flight from years back passes one second at about 20 years of history (S9, deferred by Aaron on 20 Nov).
- **Likelihood · Impact:** Low · Low: that one review fails and nothing is lost.
- **What reduces it:** reviewing held flights promptly, or building S9 if it ever matters ([history paging](../../history-paging.md#measured-at-20-fleet-years-s8-h5-release)).
- **Who acts:** Aaron.
- **Status:** Accepted.

### R10. Offline devices without a screen lock

- **Risk:** the device copy is readable, unencrypted, for seven days ([offline](../../offline.md#signing-out-and-shared-devices), finding S6).
- **Likelihood · Impact:** Medium · Medium.
- **What reduces it:** a required screen lock (users still to be told), sign-out wiping the device and five-minute file links.
- **Who acts:** Aaron; Flight Program administrators tell users.
- **Status:** Reduced.

### R11. The file sweep deletes a needed file

- **Risk:** the sweep removes stored files no record refers to, and could remove one still needed ([runbook](../../runbooks/file-sweep.md)).
- **Likelihood · Impact:** Low · Medium: the file is gone until restored from a backup.
- **What reduces it:** report mode until `FILE_SWEEP=delete`, and an independent review that found no unsafe path.
- **Who acts:** Aaron.
- **Status:** Reduced: review the first report before switching to delete.

### R12. A lost or stolen device

- **Risk:** as R10, plus entries not yet sent.
- **Likelihood · Impact:** Medium · Medium.
- **What reduces it:** resetting the password and remote-erasing ([incident runbook](../../runbooks/incident-response.md#lost-or-stolen-device)).
- **Who acts:** Aaron.
- **Status:** Reduced. Gap: the app cannot wipe a device that stays offline.

### R13. Public repository

- **Risk:** anyone can read the code, docs and runbooks and find a weakness first.
- **Likelihood · Impact:** Medium · Medium.
- **What reduces it:** no secrets in the repository, CodeQL, server-side permission checks and a [disclosure policy](../../../SECURITY.md); private would cost a paid plan ([costs](services-and-costs.md#github)).
- **Who acts:** Aaron.
- **Status:** Accepted.

### R14. No second factor (2FA)

- **Risk:** app accounts have no second factor ([ADR-0009](../../adr/0009-password-for-everyone-plus-google-and-microsoft.md)), and two-step sign-in on operator accounts is not yet confirmed.
- **Likelihood · Impact:** Medium · High for an administrator or operator account.
- **What reduces it:** 15-character passwords, lockout after 10 failures, and 2FA on every operator account.
- **Who acts:** Aaron.
- **Status:** Open.

### R15. Open security findings

- **Risk:** A3, A4, S2, S11 (partly), C8 and A10 from the [4 Nov review](../../security/review-2026-11-04.md) are still open.
- **Likelihood · Impact:** Low to Medium · Low to Medium.
- **What reduces it:** the decision or small fix the review lists for each.
- **Who acts:** Aaron.
- **Status:** Open.

### R16. Account inventory and incident contacts are blank

- **Risk:** nobody else knows who holds the registrar, Cloudflare, Resend or the FAA key.
- **Likelihood · Impact:** High · Medium.
- **What reduces it:** filling in [accounts](../../runbooks/accounts.md), [incident response](../../runbooks/incident-response.md) and [break-glass](../../runbooks/break-glass-admin.md).
- **Who acts:** Aaron.
- **Status:** Open.

### R17. The auth library is pre-release

- **Risk:** `@convex-dev/auth` is 0.0.x, and a flaw in 0.0.95 let anyone delete records (S1, fixed).
- **Likelihood · Impact:** Medium · High.
- **What reduces it:** merging its security updates at once ([recurring tasks](../../go-live-checklist.md#recurring-tasks)) and the dependency audit in CI.
- **Who acts:** Aaron.
- **Status:** Reduced.

### R18. Personal data kept forever

- **Risk:** monthly backups are kept for good, so a deletion request can't reach them.
- **Likelihood · Impact:** Low · Low.
- **What reduces it:** saying in the privacy notice that records retention comes first ([ADR-0008](../../adr/0008-daily-backups-off-site-90-days-monthly-forever.md)).
- **Who acts:** Aaron.
- **Status:** Accepted: privacy notice still to write.

### R19. No error reporting

- **Risk:** Sentry is off, so problems surface through users, failed-workflow emails, Better Stack and the digest.
- **Likelihood · Impact:** Medium · Low.
- **What reduces it:** Better Stack, with Sentry ready to switch on ([monitoring runbook](../../runbooks/monitoring.md)).
- **Who acts:** Aaron.
- **Status:** Accepted (20 Nov).

### R20. Unknown file storage growth

- **Risk:** uploaded files go into every nightly export and every monthly copy kept forever.
- **Likelihood · Impact:** Medium · Low (cost).
- **What reduces it:** a yearly look at Convex usage and R2 size ([costs](services-and-costs.md#how-the-load-test-figure-is-estimated)).
- **Who acts:** Aaron.
- **Status:** Open.

### R21. Branch protection is off

- **Risk:** branch protection on `main` is off for now (Aaron, 19 Nov), and a push to `main` deploys after green CI.
- **Likelihood · Impact:** Low · High.
- **What reduces it:** limited write access, required CI, and Deploy releasing only the newest commit on `main`.
- **Who acts:** Aaron.
- **Status:** Accepted.

### R22. Cloudflare's Git build publishes the site

- **Risk:** a connected Git build (Workers Builds) publishes a site without the backend address, as it did for about 30 minutes on 20 Nov 2026 ([changelog](../5-history/changelog.md#incident-configuration-error-after-the-merge)).
- **Likelihood · Impact:** Low now · High: every user sees "Configuration error".
- **What reduces it:** a production build that refuses to run there, and the Git build kept disconnected ([release runbook](../../runbooks/release.md#cloudflare)).
- **Who acts:** Aaron.
- **Status:** Reduced: confirm the Git build is disconnected.

## Where the rest is tracked

- Open code follow-ups: [REFACTOR_ROADMAP.md](../../../REFACTOR_ROADMAP.md).
- What is left before real records: [go-live checklist](../../go-live-checklist.md).
- Security findings and their status: [2 Nov review](../../security/review-2026-11-02.md), [4 Nov review](../../security/review-2026-11-04.md).
