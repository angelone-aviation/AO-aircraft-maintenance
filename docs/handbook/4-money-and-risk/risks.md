# Risks

[Handbook](../README.md)

The risk register for Angel One, as of 20 November 2026. Review it with the quarterly restore rehearsal ([checklists](../3-running-it/checklists.md)).

- **Likelihood** and **impact** are judgements: Low, Medium or High, each with its reason.
- **Who acts** on it: mostly Aaron, the one Convex administrator.
- **Status:** Open (nothing done yet), Reduced (partly handled), Accepted (a decision to live with it), Closed.
- Production holds no real records yet, so "impact" means the impact once it does.

## The risks at a glance

Each risk by its number, placed by likelihood and impact. Top right is worst.

| Likelihood | Impact: Low | Impact: Medium    | Impact: High          |
| ---------- | ----------- | ----------------- | --------------------- |
| **High**   |             | R16               | R1, R4                |
| **Medium** | R19, R20    | R7, R10, R12, R13 | R3, R8, R14, R17, R23 |
| **Low**    | R9, R18     | R11, R15          | R2, R5, R6, R21, R22  |

## The five to watch first

1. **Off-site backups are set up but not proven yet.** When copies start they are unencrypted, and a broad token from another project can reach them (R1, R2, R23).
2. **One person** holds the Convex account and maintains the app (R3, R4).
3. **No second factor** on app accounts, and 2FA not yet confirmed on every operator account (R14).
4. **Convex can't roll back**, and the app has no other backend (R5, R6).
5. **Devices hold a readable copy for seven days**, protected only by a screen lock nobody checks (R10, R12).

## The register

### R1. Off-site backups are set up but not proven yet

- **Risk:** no nightly backup has succeeded (every run up to 20 Nov failed, before the set-up was finished) and no restore has been rehearsed. Until both, the only copies known good are Convex's own daily backups (on since 20 Nov, with file storage), kept 7 days in the same account as the data.
- **Likelihood:** High until a run and a rehearsal have worked: an untested backup often fails when needed.
- **Impact:** High: losing the Convex account or project would lose every record.
- **What reduces it:** the bucket, its lock and lifecycle rules, the R2 token, the scoped deploy key, the time zone and failure emails are in place. Left: the heartbeat secret, a first run by hand and the first [restore rehearsal](../../runbooks/backup-restore.md#quarterly-restore-rehearsal) ([go-live checklist](../../go-live-checklist.md#backup-setup-remaining)).
- **Who acts:** Aaron.
- **Status:** Open.

### R2. Unencrypted backups

- **Risk:** anyone holding an R2 token for the bucket, the Cloudflare login or a downloaded copy can read every record, name, email, file and password hash ([ADR-0014](../../adr/0014-backups-stored-unencrypted.md)).
- **Likelihood:** Low: the bucket is private, with no public address. It rests on few people holding those credentials, which R23 breaks today.
- **Impact:** High: every record to date, and copies under `monthly/` can never be removed.
- **What reduces it:** a private, locked bucket; a backup token limited to that one bucket; sign-in sessions emptied from each copy; encryption one secret away ([backup runbook](../../runbooks/backup-restore.md#to-turn-encryption-on)).
- **Who acts:** Aaron.
- **Status:** Accepted (Aaron, 20 Nov).

### R3. A single Convex administrator

- **Risk:** only Aaron can reach production data, deploy keys and the dashboard ([ADR-0010](../../adr/0010-one-convex-administrator.md)).
- **Likelihood:** Medium: over years, one person is sometimes ill, travelling or gone.
- **Impact:** High: while he is unavailable nobody can repair, restore or rotate a key.
- **What reduces it:** the break-glass account and its sealed paper copy ([runbook](../../runbooks/break-glass-admin.md)). With backups unencrypted there is no backup key to seal ([ADR-0014](../../adr/0014-backups-stored-unencrypted.md)). To recover without Aaron the organisation needs instead: the Cloudflare login (it reaches the R2 copies), Convex's account-recovery steps written down, and an owner of the GitHub organisation.
- **Who acts:** Aaron, with the organisation contact.
- **Status:** Open: who holds each of the three is not recorded, and the break-glass account and its sealed copy are not set up yet.

### R4. A single maintainer

- **Risk:** one person knows the code, the release process and the accounts.
- **Likelihood:** High: the app is meant to run for years, and no deputy is named.
- **Impact:** High: without him nobody can release a fix, renew a key or restore.
- **What reduces it:** this handbook, the [runbooks](../../runbooks/), a filled-in [accounts list](../../runbooks/accounts.md) and [incident contacts](../../runbooks/incident-response.md#who-to-notify), and a named deputy.
- **Who acts:** Aaron.
- **Status:** Open.

### R5. Convex can't roll back

- **Risk:** a bad backend release can only be fixed forward, and damaged data needs a restore ([release runbook](../../runbooks/release.md#backend-no-rollback-fix-forward)).
- **Likelihood:** Low: a release follows a green CI run, and a schema change must accept the documents already stored or the push fails.
- **Impact:** High: a release that damages records leaves a restore as the only way back, and R1 is open.
- **What reduces it:** the [release checklist](../../runbooks/release.md#release): green CI, schema changes that widen before they tighten, and a Convex backup before merging.
- **Who acts:** Aaron.
- **Status:** Reduced.

### R6. Vendor lock-in to Convex

- **Risk:** functions, sign-in, files and data all live on Convex, so moving would mean rewriting `convex/`.
- **Likelihood:** Low: nothing forces a move today.
- **Impact:** High: a move is a rewrite of the server, not a configuration change.
- **What reduces it:** business rules kept in `src/domain` and plain ZIP backups ([ADR-0007](../../adr/0007-convex-pro-single-seat.md)).
- **Who acts:** Aaron.
- **Status:** Accepted.

### R7. Expiring FAA key and `security.txt`

- **Risk:** the FAA DRS key expires 14 Oct 2027 and `security.txt` on 4 Oct 2027.
- **Likelihood:** Medium: dates a year away are easy to miss.
- **Impact:** Medium: automatic AD monitoring stops (ADs can still be entered by hand), or the disclosure file goes stale.
- **What reduces it:** the app warns about the FAA key from 60 days before, and both dates are on the dated [checklists](../3-running-it/checklists.md#one-off-and-dated).
- **Who acts:** Aaron.
- **Status:** Reduced. Left: add `security.txt` under Settings → System → **Deployment expiring dates**, so the app warns about it too.

### R8. GitHub stops scheduled workflows

- **Risk:** GitHub turns off a public repository's schedules after 60 days without activity, which stops the nightly backup ([GitHub docs](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/disabling-and-enabling-a-workflow)).
- **Likelihood:** Medium: the app is meant to run for years with little change, and the quarterly upkeep is 90 days apart.
- **Impact:** High: backups stop without an error.
- **What reduces it:** the Better Stack heartbeat, the digest's 26-hour warning and [re-enabling the workflow](../../runbooks/backup-restore.md#who-is-told-when-it-fails).
- **Who acts:** Aaron.
- **Status:** Reduced. Left: add the heartbeat's URL to GitHub as `BACKUP_HEARTBEAT_URL`; until then only the digest warns.

### R9. Accepting a very old held flight is refused

- **Risk:** accepting a held flight dated in the oldest year takes over one second at about 20 fleet-years of history, so Convex refuses it. The fix, history-paging stage S9, was deferred by Aaron on 20 Nov.
- **Likelihood:** Low: it needs 20 years of history and a flight held from the oldest of them.
- **Impact:** Low: that one review fails and nothing is lost.
- **What reduces it:** reviewing held flights promptly, or building S9 if it ever matters ([history paging](../../history-paging.md#measured-at-20-fleet-years-s8-h5-release)).
- **Who acts:** Aaron.
- **Status:** Accepted.

### R10. Offline devices without a screen lock

- **Risk:** the device copy is readable, unencrypted, for seven days ([offline](../../offline.md#signing-out-and-shared-devices), finding S6).
- **Likelihood:** Medium: phones and tablets are shared and left in hangars, and nobody checks their locks.
- **Impact:** Medium: one Flight Program's records, costs and members as that user sees them; no other program.
- **What reduces it:** a required screen lock (users still to be told), sign-out wiping the device and five-minute file links.
- **Who acts:** Aaron; Flight Program administrators tell users.
- **Status:** Reduced.

### R11. The file sweep deletes a needed file

- **Risk:** the sweep removes stored files no record refers to, and could remove one still needed ([runbook](../../runbooks/file-sweep.md)).
- **Likelihood:** Low: it deletes nothing until `FILE_SWEEP=delete` is set, and then skips files under a day old and files stored before its first run.
- **Impact:** Medium: the file is gone until restored from a backup (R1).
- **What reduces it:** report mode until `FILE_SWEEP=delete`, and checking the first report against the tables the [runbook](../../runbooks/file-sweep.md#review-the-first-pass-then-switch-to-delete) lists.
- **Who acts:** Aaron.
- **Status:** Reduced: in report mode today. Review the first report before switching to delete.

### R12. A lost or stolen device

- **Risk:** as R10, plus entries not yet sent, and the device stays signed in.
- **Likelihood:** Medium: devices get lost.
- **Impact:** Medium: as R10, until the password is reset.
- **What reduces it:** resetting the password, which ends the sessions, and the device's own remote erase ([incident runbook](../../runbooks/incident-response.md#lost-or-stolen-device)).
- **Who acts:** a system administrator.
- **Status:** Reduced. Gap: the app cannot wipe a device that stays offline.

### R13. Public repository

- **Risk:** anyone can read the code, docs and runbooks and find a weakness first.
- **Likelihood:** Medium: the code shows where to look, though no secret is in it.
- **Impact:** Medium: a weakness still has to get past permission checks that run on the server.
- **What reduces it:** no secrets in the repository, a secret scan and dependency audit in CI, server-side permission checks and a [disclosure policy](../../../SECURITY.md); private would cost a paid plan ([costs](services-and-costs.md#github)).
- **Who acts:** Aaron.
- **Status:** Accepted. Left: CodeQL default set-up. Reported done on 2026-11-19; on 2026-11-20 GitHub shows it not configured. Aaron to re-check, and to turn it on ([GitHub docs](https://docs.github.com/en/code-security/code-scanning/enabling-code-scanning/configuring-default-setup-for-code-scanning)).

### R14. No second factor (2FA)

- **Risk:** app accounts have no second factor, and with password-only sign-in no outside provider can add one ([ADR-0015](../../adr/0015-remove-google-and-microsoft-sign-in.md)); two-step sign-in on operator accounts is not yet confirmed.
- **Likelihood:** Medium: passwords are phished and reused.
- **Impact:** High for an administrator's account or an operator account (Convex, Cloudflare, GitHub): every record.
- **What reduces it:** 15-character passwords, lockout after 10 failed sign-ins in an hour, and 2FA on every operator account.
- **Who acts:** Aaron.
- **Status:** Open.

### R15. Open security findings

- **Risk:** A4, S2, S11 (partly) and C8 from the [4 Nov review](../../security/review-2026-11-04.md) are still open. A7, C7 and the rest of T4 are accepted there; S6 is kept by design (R10).
- **Likelihood:** Low: none gives access to records. A4, S2 and S11 turn on whether an email has an account, and C8 has no effect today.
- **Impact:** Medium at most: S2 lets someone who knows an email keep that account locked out; the others are rated Low or Info.
- **What reduces it:** the decision or small fix the review lists for each.
- **Who acts:** Aaron.
- **Status:** Open.

### R16. Account inventory and incident contacts are blank

- **Risk:** nobody else knows who holds the registrar, Cloudflare, Resend or the FAA key.
- **Likelihood:** High: the rows are blank today.
- **Impact:** Medium: it slows every incident and renewal, and makes R3 and R4 worse.
- **What reduces it:** filling in [accounts](../../runbooks/accounts.md), [incident response](../../runbooks/incident-response.md) and [break-glass](../../runbooks/break-glass-admin.md).
- **Who acts:** Aaron.
- **Status:** Open.

### R17. The auth library is pre-release

- **Risk:** `@convex-dev/auth` is 0.0.x, and a flaw in 0.0.95 let anyone delete records (S1, fixed in 0.0.96).
- **Likelihood:** Medium: a pre-release library that has already had one critical flaw.
- **Impact:** High: sign-in guards every record.
- **What reduces it:** merging its security updates at once ([recurring tasks](../../go-live-checklist.md#recurring-tasks)) and the dependency audit in CI.
- **Who acts:** Aaron.
- **Status:** Reduced.

### R18. Personal data kept forever

- **Risk:** monthly backups are kept for good, so a deletion request can't reach them.
- **Likelihood:** Low: requests are rare in a small program.
- **Impact:** Low: names, emails and certificate numbers of members, kept under the records-retention duty.
- **What reduces it:** saying in the privacy notice that records retention comes first ([ADR-0008](../../adr/0008-daily-backups-off-site-90-days-monthly-forever.md)).
- **Who acts:** Aaron.
- **Status:** Accepted: privacy notice still to write.

### R19. No error reporting

- **Risk:** Sentry is not used, so problems surface through users, failed-workflow emails, Better Stack and the digest.
- **Likelihood:** Medium: some errors will go unreported.
- **Impact:** Low: a fault is found later, not missed for good.
- **What reduces it:** Better Stack, with Sentry ready to switch on ([monitoring runbook](../../runbooks/monitoring.md)).
- **Who acts:** Aaron.
- **Status:** Accepted (Aaron, 20 Nov).

### R20. Unknown file storage growth

- **Risk:** uploaded files go into every nightly export and every monthly copy kept forever.
- **Likelihood:** Medium: nobody knows yet how many files the program will upload.
- **Impact:** Low: cost only, a few dollars a month for each GB of files ([costs](services-and-costs.md#how-the-load-test-figure-is-estimated)).
- **What reduces it:** a yearly look at Convex usage and R2 size ([checklists](../3-running-it/checklists.md)).
- **Who acts:** Aaron.
- **Status:** Open.

### R21. Branch protection is off

- **Risk:** branch protection on `main` is off for now (Aaron, 19 Nov), and a push to `main` deploys after green CI.
- **Likelihood:** Low: write access is limited, and CI must pass first.
- **Impact:** High: a mistaken or hostile push reaches production unreviewed.
- **What reduces it:** limited write access, required CI, and Deploy releasing only the newest commit on `main`.
- **Who acts:** Aaron.
- **Status:** Accepted.

### R22. Cloudflare's Git build publishes the site

- **Risk:** Cloudflare's own Git build (Workers Builds), if connected, publishes a site without the backend address, as it did for about 30 minutes on 20 Nov 2026 ([changelog](../5-history/changelog.md#incident-configuration-error-after-the-merge)).
- **Likelihood:** Low: Aaron disconnected it that day (about 20:15 UTC); it would have to be connected again by mistake.
- **Impact:** High: every user sees "Configuration error" until Deploy publishes again.
- **What reduces it:** the Git build kept disconnected, and since release 5 a production build that refuses to run there ([release runbook](../../runbooks/release.md#cloudflare)).
- **Who acts:** Aaron.
- **Status:** Reduced. Never reconnect it.

### R23. A broad R2 token from another project

- **Risk:** the Cloudflare account holds an R2 token made for another project, "order-health-dashboard build token", with **Admin Read & Write on all buckets**. It can read and write every object in `angelone-backups`, and Cloudflare lists "edit bucket configuration" and "delete buckets" among that permission's rights ([R2 token permissions](https://developers.cloudflare.com/r2/api/tokens/)).
- **Likelihood:** Medium: the token lives in another project's build set-up, outside this app's controls.
- **Impact:** High: every record in the unencrypted copies (R2), and possibly the bucket's own settings.
- **What reduces it:** nothing yet. Replace it with a token limited to that project's own bucket (Object Read & Write), then delete it.
- **Who acts:** Aaron.
- **Status:** Open.

## Where the rest is tracked

- Open code follow-ups: [REFACTOR_ROADMAP.md](../../../REFACTOR_ROADMAP.md).
- What is left before real records: [go-live checklist](../../go-live-checklist.md).
- Security findings and their status: [2 Nov review](../../security/review-2026-11-02.md), [4 Nov review](../../security/review-2026-11-04.md).
