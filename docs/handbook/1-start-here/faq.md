# Technical FAQ

Questions Aaron and the program ask about running Angel One. Questions from pilots and mechanics about using it are in the user guide, [Using the app](../../wiki/Home.md).

## Records

**Why can't I edit a record?**
Completed records are FAA maintenance and status records. A change is a **correction**: a new entry with a reason, and the original stays. No code edits or deletes a change-log row ([how it works](../2-how-it-works/how-it-works.md#the-change-log-appended-never-edited), [ADR-0005](../../adr/0005-audit-log-protection-by-access-and-backups.md)).

**Is the app the legal maintenance record?**
No. It keeps the six status records of 14 CFR 91.417(a)(2) and writes unsigned logbook wording. The signed logbook entry is the record ([ADR-0004](../../adr/0004-logbook-generator-and-status-record-system.md)).

**How do we give an FAA inspector or a buyer the records?**
**Export records package** on the aircraft: one ZIP with every record, the change log and files ([records package](../../records-export.md)).

**Why don't I see older flights or work orders?**
The workspace keeps three months of closed history (six of flights). Use **Load older**, online ([how it works](../2-how-it-works/how-it-works.md#history-paging-and-the-3-month-window)).

**Can a record be deleted?**
No. Records are kept for the life of the aircraft (14 CFR 91.417(b)(2)); old ones are archived and hidden.

## Releases

**Why did Deploy say "is not the newest commit on main"?**
Deploy only moves production forward. When two merges land close together, the older one's run stops with that message and the newer one's run releases both. Nothing is wrong ([release runbook](../../runbooks/release.md#what-runs-where)).

**How do I undo a bad release?**
Screens: roll the website back in Cloudflare, instantly. Data or functions: Convex can't roll back, so revert the commit on `main` and let Deploy release the revert ([operations](../3-running-it/operations.md#rolling-back)).

**Do I need to run anything after a deploy?**
Normally no. A release that needs a one-off command names it in its pull request and in the README ([README](../../../README.md#one-off-steps-for-deployments-with-older-data)). After any restore, run the four history migrations ([operations](../3-running-it/operations.md#after-a-release-or-a-restore-the-migrations)).

**Deploy refused because of the Content-Security-Policy. Why?**
The Convex URL (or a Sentry host, if Sentry is ever switched on) is not allowed by `public/_headers`. It stops before anything changes in production ([release runbook](../../runbooks/release.md#security-headers)).

## Outages

**What if Convex is down?**
Nobody can sign in, load data or sync. Installed apps still open their copy: pilots keep logging flights and problem reports, which wait in the Sync center and send themselves later. Everything else waits. Check [Convex status](https://status.convex.dev) and Better Stack. If Convex lost the data, restore from the latest R2 backup ([backup runbook](../../runbooks/backup-restore.md#real-restore-production)).

**What if Cloudflare is down?**
The website doesn't load for new visits. Installed apps open from their cache and still reach Convex, so they keep working.

**What if GitHub is down?**
No CI, no deploys, no nightly backup that night. Production keeps running.

**What if the nightly backup fails?**
GitHub emails whoever last enabled the workflow, Better Stack alerts on the missed heartbeat, and system administrators get "Off-site backups" in the next digest. Running it again is always safe ([backup runbook](../../runbooks/backup-restore.md#when-a-nightly-run-fails)).

## People and access

**How do I add an administrator?**
In the app, a system administrator: Administration → Users → **Add user** or **Edit access**. Tick **Flight Program administrator** in a group for one program, or **Global administrator** for a system administrator ([Flight Program access](../../flight-program-access.md)). Convex dashboard access is different: it stays with Aaron alone ([ADR-0010](../../adr/0010-one-convex-administrator.md)).

**Someone is locked out.**
Ten wrong passwords in an hour lock the account; it clears within the hour. A system administrator's **Reset password** clears it at once and ends their sessions ([accounts runbook](../../runbooks/accounts.md#a-user-is-locked-out-after-failed-sign-ins)).

**No administrator can sign in.**
Use the break-glass account ([break-glass runbook](../../runbooks/break-glass-admin.md)). It is not set up yet.

**Can people sign in with Google or Microsoft?**
It is built but off until security finding A3 is fixed ([4 Nov review](../../security/review-2026-11-04.md)).

**Is there two-factor sign-in?**
Not in the app; the sign-in library has none ([ADR-0009](../../adr/0009-password-for-everyone-plus-google-and-microsoft.md), [risks](../4-money-and-risk/risks.md)).

**What happens to a lost phone's data?**
The copy is readable for seven days from sign-in if the phone is unlocked. Reset the user's password and remote-erase the phone ([incident runbook](../../runbooks/incident-response.md#lost-or-stolen-device)).

## Money and the long run

**How much will this cost us?**
About **$25 a month** (Convex Pro) plus the domain, so about $311 a year, at today's size. At 20 years of a six-aircraft fleet, an estimated $25 to $40 a month, depending mostly on uploaded files ([services and costs](../4-money-and-risk/services-and-costs.md)).

**How long will it last?**
The load test held 20 years of a six-aircraft fleet: every load and save succeeded except accepting a held flight from the oldest year. At that rate the main limit is about a hundred years away ([capacity and limits](../2-how-it-works/capacity-and-limits.md)). What wears out sooner is the software around it: the sign-in library, Node versions and keys need about one to two hours a quarter ([checklists](../3-running-it/checklists.md)).

**What if Aaron is unavailable?**
That is the biggest risk ([risks R3, R4](../4-money-and-risk/risks.md)). The break-glass account and the organisation's sealed credentials are planned but not set up yet; this handbook and the runbooks say what to do. Fill in the [accounts](../../runbooks/accounts.md) and [incident contacts](../../runbooks/incident-response.md#who-to-notify).

**Could we move off Convex?**
Yes, but it is a rewrite of `convex/`. The business rules in `src/domain` and the exported data would carry over ([risks R6](../4-money-and-risk/risks.md#r6-vendor-lock-in-to-convex)).

**Are the backups encrypted?**
No ([ADR-0014](../../adr/0014-backups-stored-unencrypted.md)); they sit in a private, locked R2 bucket ([risks R2](../4-money-and-risk/risks.md#r2-unencrypted-backups)).

**Why is the repository public?**
GitHub Actions and security features are free for public repositories. No secrets are in it; a scan checks every push ([risks R13](../4-money-and-risk/risks.md#r13-public-repository)).
