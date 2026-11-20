# What everyone must know

[Handbook](../README.md)

The few rules that matter most, by who you are. Each links to the page with the detail. How to do each task is in the user guide, [Using the app](../../wiki/Home.md).

## Everyone

- **Records are corrected, never edited.** A change to a completed record is a correction with a reason, added to the change log. The original stays ([how it works](../2-how-it-works/how-it-works.md#the-change-log-appended-never-edited)).
- **The paper logbook is the signed record.** The app keeps the status records and writes logbook wording for signature; it is not the signature ([ADR-0004](../../adr/0004-logbook-generator-and-status-record-system.md)). Paper logbooks run beside the app for the first year.
- **Decimals use a point.** "2342,5" is refused, so a slip can't be saved as ten times too much ([README](../../../README.md#the-look)).
- **Signing out clears the device.** Your copy, unsynced entries and photos, drafts and kept manuals are deleted. If anything hasn't synced, it asks first: **Stay signed in** or **Delete and sign out** ([offline](../../offline.md#signing-out-and-shared-devices)).
- **Your phone or tablet needs a screen lock.** The app keeps a readable copy of the program on it for seven days ([offline](../../offline.md#signing-out-and-shared-devices)).
- **Sign-in lasts seven days.** Then sign in again; pending entries wait and sync after ([README](../../../README.md#offline-and-installation)).
- **Passwords are 15 to 128 characters.** Ten wrong tries in an hour lock the account; one try returns every 6 minutes, and a system administrator's reset clears it at once ([accounts runbook](../../runbooks/accounts.md#a-user-is-locked-out-after-failed-sign-ins)).
- **A half-filled form asks before closing.** Save before you tap **Reload now** for a new version.
- **Two people saving one record:** the second sees "This record was changed by someone else. Review the differences." and chooses ([offline](../../offline.md#when-two-people-change-the-same-record)).
- **A copied file link stops working after five minutes.** Open the file again from the app ([file links](../../file-links.md)).

### If the app is down

| You see                                   | Do this                                                                                                                                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No connection, or the app won't load data | Pilots keep logging flights and problem reports; they wait in the **Sync center** and send themselves later                                                                        |
| **Your workspace could not be opened.**   | **Try again**, or **View the copy on this device**. Tell your Flight Program administrator if it keeps happening ([offline](../../offline.md#when-the-workspace-cannot-be-opened)) |
| **Something went wrong.**                 | Reload. Tell your administrator what you were doing                                                                                                                                |
| The website doesn't open at all           | An installed app still opens from the device. Tell your administrator; they tell Aaron                                                                                             |

## Pilots

- **Check the starting Hobbs and tach** on the flight form against the aircraft before you start.
- **A grounded aircraft is refused** at the dispatch gate. Only an administrator can record an override with a reason.
- **A flight over 24 hours waits for review.** So does a flight that no longer fits the aircraft (it changed since you started, readings lower than the counter, a backdated time). Nothing is lost; an administrator accepts or rejects it ([offline](../../offline.md#flights-held-for-review)).
- **Several legs offline on one aircraft are fine.** They are sent oldest first and accepted in order.
- **Watch the Sync center.** An entry marked **Needs attention** was refused; use **Edit and retry** ([offline](../../offline.md#pending-entries-and-the-sync-center)).
- **Report every problem** with **Report a problem**, also offline. A grounding report grounds the aircraft and alerts maintenance.
- **Keep the manuals you need offline** with **Keep on this device**, and check they open in airplane mode ([reference library](../../reference-library.md#keep-on-this-device)).
- **Photograph the paper logbook line** for each flight while paper logbooks are kept ([logbook photos](../../logbook-photos.md)).

## Mechanics and inspectors

- **Signoffs are internal work tracking**, not return to service. The signed logbook entry is the record ([job cards](../../task-cards.md)).
- **Technician signoff first.** Where a card requires an inspection signoff, a different person gives it, and needs an approved mechanic certificate.
- **Nobody approves their own certificate,** administrators included. A new or changed certificate waits for another administrator ([user certifications](../../user-certifications.md)).
- **Editing a signed card's content or adding evidence clears its signoffs.** So does setting it back to Draft. The cleared signoffs stay in the change log.
- **Close-out confirms the readings** and records inspection compliance in one step. A closed work order is read-only; fix it with a correction ([work orders](../../work-orders.md)).
- **An overdue item grounds the aircraft.** A usage limit at 0 remaining is overdue; a calendar limit is overdue the day after its due date ([due soon and overdue](../../maintenance-workflows.md#due-soon-and-overdue)).
- **Older records** (more than 3 months closed) are behind **Load older** and need a connection ([history paging](../2-how-it-works/how-it-works.md#history-paging-and-the-3-month-window)).

## Administrators

- **Accounts are created by administrators.** There is no self sign-up or self-service reset. Only a system administrator resets passwords or disables accounts ([ADR-0002](../../adr/0002-administrator-provisioned-accounts.md)).
- **Confirm who is asking** before a password reset, by phone or in person, and give the new password another way than their email ([accounts runbook](../../runbooks/accounts.md)).
- **Review held flights promptly.** Their hours count only once accepted.
- **Approve certificates** for others; you can't approve your own.
- **One member may hold 200 open problem reports** (or 512 KiB of text). You are alerted at half; resolve or defer to clear it ([maintenance workflows](../../maintenance-workflows.md)).
- **Keep expiring dates current:** insurance, registration, keys. They alert from 60 days out ([alerts](../../alerts.md)).
- **Do the monthly paper check** while paper logbooks are kept ([paper check](../../reconciliation.md)).
- **When someone leaves,** a system administrator disables the account; that ends every session at once ([accounts runbook](../../runbooks/accounts.md#disabling-a-user)).
- **A lost device:** a system administrator resets that user's password; lock or erase the device remotely if you can; tell Aaron ([incident runbook](../../runbooks/incident-response.md#lost-or-stolen-device)).
- **Transfers between programs** are for system administrators, need a reason, and leave cost records with the program that paid ([Flight Program access](../../flight-program-access.md#explicit-transfers)).

## Owners and board members

- **Your view is read-only** and shows recorded status only. It is not a maintenance release ([board view](../../board-view.md)).
- **Owners** see their aircraft's status records, current Form 337 copies and recent completed work.
- **Board members** see fleet status, what falls due, open problem reports, spend against budget and the last backup, with a PDF for meetings.
- **Questions about a record** go to the Flight Program administrator; only they can correct it.

## Whoever maintains the app (Aaron)

- **Merging to `main` is the release.** Take a Convex backup first ([operations](../3-running-it/operations.md#releasing)).
- **Convex can't roll back.** Revert on `main` and let Deploy release it; the website rolls back in Cloudflare.
- **After any restore, and after a deploy that adds derived columns or keys, run the three migrations** (`backfillHistoryColumns`, `rebuildRecordNumbers`, `rebuildCostLedger`) until each returns `missing: 0`; then `reconcileCostLedger` must return `differing: 0` ([operations](../3-running-it/operations.md#after-a-release-or-a-restore-the-migrations)).
- **Never edit production data directly,** except a restore or a written repair, recorded at once with `audit:recordManualEntry`. Never touch a change-log row ([database access](../../runbooks/database-access.md)).
- **Secrets never go in the repository.** It is public. A leaked secret is rotated first ([incident runbook](../../runbooks/incident-response.md#leaked-secret)).
- **Get the nightly backup working, then keep it alive.** Its set-up is not finished, so no off-site copy exists yet ([go-live checklist](../../go-live-checklist.md#backup-setup-remaining)). After that: read failure emails, and keep the repository active, because GitHub stops scheduled runs after 60 days without a commit ([checklists](../3-running-it/checklists.md)).
- **Never reconnect Cloudflare's own Git build.** Only the GitHub Deploy workflow publishes the website ([risks R22](../4-money-and-risk/risks.md#r22-cloudflares-git-build-publishes-the-site)).
- **Dated renewals:** renew `security.txt` before 2027-09-04 (it expires 2027-10-04); the FAA DRS key before 2027-10-14 ([checklists](../3-running-it/checklists.md#one-off-and-dated)).
- **Follow [CONSTRAINTS.md](../../../CONSTRAINTS.md)** and run `npm run check` and `npm run test:e2e` before a change ships.
