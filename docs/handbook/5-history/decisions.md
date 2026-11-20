# Decisions

Every standing decision, with its date and the choice made. Where an ADR exists it holds the reasons; this page is the index.

- Aaron chose option A for every one of D1–D25 (19 Nov 2026; D13's price record on 20 Nov) and H1–H7 (19 Nov; H5 revised 20 Nov). Each row says what that choice does in the code now.
- Questions, options and recommendations for D1–D25: [bug hunt 10 Nov, Decisions for Aaron](../../qa/bug-hunt-2026-11-10/README.md#decisions-for-aaron).

## Architecture decision records

| ADR                                                                       | Date        | Decision                                                                                              |
| ------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------- |
| [0001](../../adr/0001-sso-in-app-not-cloudflare-access.md)                | 1 Nov 2026  | Access control stays in the app; Cloudflare Access is not the gate                                    |
| [0002](../../adr/0002-administrator-provisioned-accounts.md)              | 1 Nov 2026  | Administrators create accounts; no public sign-up or self-service reset                               |
| [0003](../../adr/0003-server-writes-through-one-command-transaction.md)   | 1 Nov 2026  | Server writes go through one command transaction (`runCommand`)                                       |
| [0004](../../adr/0004-logbook-generator-and-status-record-system.md)      | 1 Nov 2026  | The app writes logbook wording and keeps the 91.417(a)(2) status records; it is not the signed record |
| [0005](../../adr/0005-audit-log-protection-by-access-and-backups.md)      | 1 Nov 2026  | The change log is protected by limited access and off-site backups, not hash chaining                 |
| [0006](../../adr/0006-architecture-cleanup-priorities-before-launch.md)   | 1 Nov 2026  | Which clean-ups happen before launch                                                                  |
| [0007](../../adr/0007-convex-pro-single-seat.md)                          | 2 Nov 2026  | Convex Pro, one seat, one project                                                                     |
| [0008](../../adr/0008-daily-backups-off-site-90-days-monthly-forever.md)  | 2 Nov 2026  | Daily off-site backups, kept 90 days; one a month kept forever                                        |
| [0009](../../adr/0009-password-for-everyone-plus-google-and-microsoft.md) | 2 Nov 2026  | Everyone keeps a password; Google and Microsoft alongside                                             |
| [0010](../../adr/0010-one-convex-administrator.md)                        | 3 Nov 2026  | One Convex administrator, no second dashboard user                                                    |
| [0011](../../adr/0011-readable-records-copy-in-dropbox.md)                | 3 Nov 2026  | A readable Excel copy in Dropbox, alongside the backup                                                |
| [0012](../../adr/0012-urgent-alerts-by-web-push-and-immediate-email.md)   | 9 Nov 2026  | Urgent alerts by Web Push and immediate email; expiring dates are records                             |
| [0013](../../adr/0013-history-retention-window.md)                        | 19 Nov 2026 | The workspace keeps a retention window; older history loads page by page                              |

## 20 Nov 2026

| Decision                                                    | Choice                                                                                                                                 | Where it shows                                                                                                             |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Release                                                     | Option A: released (history paging at `12bc9af`; the purchasing window, saves and Summary at `e99058c`)                                | [Changelog](changelog.md)                                                                                                  |
| H5: closed parts requests, purchase orders and flight plans | Option A: window them like other history, with Load older                                                                              | [ADR-0013](../../adr/0013-history-retention-window.md), [history paging](../../history-paging.md#the-purchasing-window-h5) |
| The Summary's reads                                         | Option A: bound it (each row read once, stop at 3 MiB)                                                                                 | [History paging](../../history-paging.md#weekly-summary-reads-roadmap-74b)                                                 |
| S9: held-flight review from a checkpoint                    | Option A: set aside                                                                                                                    | [Capacity](../2-how-it-works/capacity-and-limits.md)                                                                       |
| Monitoring                                                  | Better Stack only; no Sentry for now                                                                                                   | [Monitoring runbook](../../runbooks/monitoring.md)                                                                         |
| Backup encryption                                           | Backups work **without encryption**; encryption optional and off by default ([ADR-0014](../../adr/0014-backups-stored-unencrypted.md)) | [Risks R2](../4-money-and-risk/risks.md)                                                                                   |
| Certificate approval                                        | Nobody approves their own certificate, administrators included; another administrator approves                                         | [User certifications](../../user-certifications.md), review S20/A5                                                         |
| D13: the price of an issued part                            | Kept in the work order's administrator-only cost record                                                                                | [Parts and repair requests](../../parts-and-repair-requests.md)                                                            |

## History paging, H1–H7 (19 Nov 2026)

From [ADR-0013](../../adr/0013-history-retention-window.md).

| No. | Choice                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------- |
| H1  | A three-month window, with flights kept six months                                                               |
| H2  | The server filters the flight log by aircraft and status; text search covers loaded rows, with a label saying so |
| H3  | The Discrepancies total reads "in the last 3 months"                                                             |
| H4  | The records package always pages full history; one made offline is marked partial                                |
| H5  | Parts requests, purchase orders and flight plans stay complete for now. Revised 20 Nov to option A (above)       |
| H6  | The Summary's fix is part of the bounded saves                                                                   |
| H7  | D2 keeps detect-and-alert, plus a limit on what one member can have open                                         |

## Bug-hunt decisions, D1–D25

| No. | Question                                                                                                                    | Choice                                                                                                                                                                     | Date   |
| --- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| D1  | The 24-hour hold, and limits for the aircraft form's readings and fuel and oil                                              | Option A. The code keeps the 24-hour hold ([offline](../../offline.md#flights-held-for-review)). The aircraft-form and fuel and oil limits are not built yet (UI-9, UI-11) | 19 Nov |
| D2  | Stop one member's flood of problem reports locking a program out                                                            | A per-member limit (200 open, 512 KiB) and an alert at half                                                                                                                | 19 Nov |
| D3  | When to build the retention window                                                                                          | Built and released 20 Nov (ADR-0013)                                                                                                                                       | 19 Nov |
| D4  | Count an MEL repair interval from the day the defect was found                                                              | Yes                                                                                                                                                                        | 19 Nov |
| D5  | Should a newly set-up aircraft read Grounded?                                                                               | No: it reads "Setup incomplete" and does not block flights                                                                                                                 | 10 Nov |
| D6  | Can a pilot log a flight on an aircraft grounded mid-flight?                                                                | Yes, as a flight held for review                                                                                                                                           | 10 Nov |
| D7  | Accept a pilot's consecutive offline legs in order?                                                                         | Yes, by tracking the version on the device                                                                                                                                 | 10 Nov |
| D8  | Should a system administrator in no group get every program's urgent alerts?                                                | No; join a group for a program's alerts                                                                                                                                    | 19 Nov |
| D9  | Share the 60 urgent emails a day between programs                                                                           | A fair share per program, at least 10, with a warning when a share is used                                                                                                 | 19 Nov |
| D10 | How soon to report a missed backup                                                                                          | At the next day's digest (26 hours); the heartbeat a go-live item                                                                                                          | 19 Nov |
| D11 | Refuse a duplicate inspection from setup?                                                                                   | Yes, for setup saves only                                                                                                                                                  | 19 Nov |
| D12 | Caps and rate limits for aircraft documents                                                                                 | Separate caps for photos and Form 337 copies; 30 uploads per user an hour                                                                                                  | 19 Nov |
| D13 | Should a stock price edit re-price parts already issued?                                                                    | No; the price is kept at issue, on the work order's cost record                                                                                                            | 20 Nov |
| D14 | Keep cost records with the program that paid on a transfer?                                                                 | Yes                                                                                                                                                                        | 19 Nov |
| D15 | Which compliance fields owners see                                                                                          | Named fields only, without internal user ids                                                                                                                               | 19 Nov |
| D16 | "Records package for mechanics": convenience or confidentiality?                                                            | A convenience rule: the package refuses others, the server doesn't hide the records ([records package](../../records-export.md#who-can-export))                            | 19 Nov |
| D17 | Add queued photos and permanent file links to the device-data decision                                                      | Yes: sign-out wipes the device; links expire after five minutes ([file links](../../file-links.md))                                                                        | 19 Nov |
| D18 | Is a restock request complete when its parts arrive?                                                                        | Yes                                                                                                                                                                        | 19 Nov |
| D19 | Refuse a receipt dated before its order?                                                                                    | Yes                                                                                                                                                                        | 19 Nov |
| D20 | A Settings page for owners and board members?                                                                               | No; one line in their More sheet                                                                                                                                           | 19 Nov |
| D21 | Glossary to follow the screens' "Job card"?                                                                                 | Yes                                                                                                                                                                        | 19 Nov |
| D22 | How "Report a problem" relates to "Discrepancy"                                                                             | "Problem report" added to the glossary                                                                                                                                     | 19 Nov |
| D23 | Should `check:standards` check uncommitted files?                                                                           | Option A. The patch is ready; it changes a hook only Aaron may edit, so he applies it                                                                                      | 19 Nov |
| D24 | Wrangler and esbuild into the lockfile?                                                                                     | Yes                                                                                                                                                                        | 19 Nov |
| D25 | Confirm the conservative choices made during the fixes (AC-3, AC-8, NB-11, NA-5, NA-18, OP-3, OP-6, NB-6, FL-7, FL-9, UI-4) | Option A: keep them. The choices remain in the code                                                                                                                        | 19 Nov |

## Security and device decisions

| Date        | Decision                                                                                                                    | Source                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 2 Nov 2026  | The pre-launch security review is in-house, with no external penetration test at this stage                                 | [Review 2 Nov](../../security/review-2026-11-02.md)                                     |
| 3 Nov 2026  | Retire the old test deployment and the A2 Hosting site; production starts empty, nothing migrated                           | [Go-live checklist](../../go-live-checklist.md), [accounts](../../runbooks/accounts.md) |
| 4 Nov 2026  | No idle sign-out timeout                                                                                                    | [Incident runbook](../../runbooks/incident-response.md#lost-or-stolen-device)           |
| 19 Nov 2026 | The offline copy stays seven days, unencrypted; phones and tablets need a screen lock; sign-out clears the device (S6, S10) | [Offline](../../offline.md#signing-out-and-shared-devices)                              |
| 19 Nov 2026 | File links expire after five minutes (S7, SE-12, D17)                                                                       | [File links](../../file-links.md)                                                       |
| 19 Nov 2026 | Google and Microsoft sign-in stay off until A3 (first link trusts the provider) is fixed                                    | [Review 4 Nov](../../security/review-2026-11-04.md)                                     |
| 19 Nov 2026 | Store a hash of refused SSO emails instead of the email, once SSO is on (A10)                                               | same                                                                                    |
| 19 Nov 2026 | Backup-age warning after 26 hours instead of 36 (D10)                                                                       | [ADR-0008](../../adr/0008-daily-backups-off-site-90-days-monthly-forever.md)            |
| 19 Nov 2026 | CodeQL default set-up on (P4)                                                                                               | [Review 4 Nov](../../security/review-2026-11-04.md)                                     |
| —           | Security contact: accounts@angeloneonline.org                                                                               | [SECURITY.md](../../../SECURITY.md)                                                     |

## Things Aaron decided not to do, for now

From Aaron's to-do of 20 Nov 2026:

| Not doing                   | Why or until                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| Sentry                      | Better Stack only, for now                                                                      |
| GitHub billing              | Actions are free while the repository is public                                                 |
| Branch protection on `main` | For now ([risks R21](../4-money-and-risk/risks.md))                                             |
| HSTS preload                | Hard to undo; not now                                                                           |
| Idle sign-out timeout       | Not now                                                                                         |
| A second Convex seat        | Rejected in [ADR-0010](../../adr/0010-one-convex-administrator.md)                              |
| SMS alerts                  | Rejected for now in [ADR-0012](../../adr/0012-urgent-alerts-by-web-push-and-immediate-email.md) |
