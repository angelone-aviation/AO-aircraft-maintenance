# Glossary

The words Angel One uses, and the words it avoids. This page is a copy of [GLOSSARY.md](../../../GLOSSARY.md) from its first section on, kept identical by a test: change both together. In the app, the **Glossary** page and term tips explain them in plain words ([reading and shortcuts](../../reading-and-shortcuts.md)).

## Access

**Administration**:
The screen that decides who can do what: users, permission groups and aircraft access.

**Certificate approval**:
A Flight Program administrator's or system administrator's check of a certificate a member filed or changed, under **Administration → Users**. Until it is approved the certificate is not printed on records, not offered under **Use saved certification** and does not allow an inspection signoff; nobody approves their own.

**Flight Program**:
The organization unit that owns aircraft, inventory locations, stock and memberships. The first access boundary: every record belongs to exactly one, or is unassigned.
_Avoid_: tenant, organization, customer

**Flight Program administrator**:
A member whose group grants management of an entire Flight Program, its people included: they create its accounts, change members' access to it and edit its permission groups.

**Membership**:
A user's belonging to a Flight Program through at least one permission group.
_Avoid_: account (for the belonging), seat

**Permission group**:
A named bundle of permissions (read, flight, discrepancy, resolve, maintenance) over all or selected aircraft of one Flight Program.
_Avoid_: role

**Settings**:
The screen that changes how the app behaves, from your own account, your alerts and this device to a Flight Program's details and the system's integration keys, each section shown only to those allowed to change it.

**System administrator**:
The account kind that manages every Flight Program, user and group, and the only one that sees unassigned records, creates programs, resets passwords and disables accounts.
_Avoid_: superuser, root

**Unassigned records**:
Aircraft, locations or components with no owning Flight Program; visible only to system administrators.

## Aircraft and flying

**Aircraft**:
A registered airframe owned by one Flight Program, carrying Hobbs, tach, total time, cycle and landing counters.

**Aircraft setup**:
Loading an aircraft's existing history in one guided pass: identity and baseline readings, installed components, inspections with their last-done values and AD compliance, from CSV templates, with a dry run before the inspection and AD rows are saved.
_Avoid_: onboarding, initial load, migration

**Aircraft status**:
The computed level of an aircraft, airworthy, due soon or grounded, together with the reasons that produced it. Screens show **Setup incomplete** in place of airworthy or due soon while the aircraft's setup has gaps.

**Conflict review**:
An administrator's decision on a held flight, opened with **Review** in the flight log: accept it, with corrections if needed, or reject it. Totals are not changed until then, and both decisions keep the original values in the change log.

**Deferral**:
Postponement of a discrepancy under a Minimum Equipment List (MEL) item and category, with placard text and a repair deadline counted from the day the defect was found, not the day it was deferred.

**Discrepancy**:
A reported defect on an aircraft, open until resolved or deferred. A problem report raises one.
_Avoid_: squawk, issue, defect (in records)

**Dispatch gate**:
The check that blocks releasing a grounded aircraft for a flight. A flight whose aircraft was grounded only by problems reported after it began is not refused: it can still be logged and is held for conflict review ("The aircraft was grounded during this flight.").

**Dispatch override**:
A recorded, reasoned decision to fly despite the dispatch gate; the reason is kept with the flight.

**Flight**:
A logged flight with starting and ending meter readings; the unit of usage that advances aircraft counters.

**Held flight**:
A synced flight the server stored with the status **Needs review** instead of applying it, because the aircraft moved on after the entry was started, a reading is lower than the current counter or more than 24 hours past it, or the aircraft was grounded during the flight. Its hours, landings and cycles wait for conflict review.
_Avoid_: rejected flight, failed sync

**OK to fly**:
The one-line verdict on an aircraft card and detail: "Not OK to fly" exactly when the aircraft is grounded (the dispatch gate would refuse a flight), otherwise "OK to fly", with the single most important reason.
_Avoid_: cleared, released

**Outbox**:
The device's store of pending entries, sent oldest first when the app is online and connected and the seven-day offline window has not run out. Only flights and problem reports wait in it; every other change needs a connection.
_Avoid_: queue (in user-facing text)

**Pending entry**:
A flight or discrepancy recorded offline and waiting in the outbox to sync, listed in the Sync center. A user's later pending flight on an aircraft starts from the readings and version their earlier pending flights on it will leave, so the legs sync in order.
_Avoid_: queued operation (in user-facing text), draft

**Problem report**:
How a pilot or other member raises a discrepancy: **Report a problem**, or the flight form's "Any problem observed during this flight?". Once saved, the report is the discrepancy, so the two words name one record: the screens say "problem" for the act of reporting and "discrepancy" for the record (the Discrepancies list, the Sync center, deferrals and work orders). A report made without a connection is a pending entry until it syncs.
_Avoid_: squawk, issue, defect report

**Setup incomplete** (aircraft status):
The status shown for an aircraft that is not grounded while any step of its aircraft setup holds no data (baseline readings, an installed component, an inspection schedule, an AD with its applicability decided). The missing steps are its reasons. It never reads as airworthy, but it does not ground the aircraft or close the dispatch gate. Also the label of a component added from a template that still waits for its serial and readings.

**Sync center**:
The screen that lists the signed-in user's pending entries, oldest first, with **Sync now** and **Export pending entries**. An entry the server refused for good stays there as **Needs attention**, with the server's reason.

**Total time**:
Aircraft time in service: the selected meter (Hobbs or tach) plus the total time adjustment.

## Maintenance

**Airworthiness directive (AD)**:
An FAA-mandated action tracked per aircraft or component: applicability review, required actions, recurrence, and compliance history.

**Audit entry**:
The record of who changed what and when, with before and after state and the reason.
_Avoid_: log (bare), history (bare)

**Close-out**:
Completing a work order: applies planned component movements, freezes the recorded readings and produces the work summary.
_Avoid_: closing, completion (of the order)

**Command**:
A validated request to change records in one step, carrying a request id so that repeating it has no further effect.
_Avoid_: mutation (for the request), action, operation (reserved for offline flight and discrepancy entries)

**Compliance record**:
An append-only entry that an AD action was performed: method, date and counters, mechanic and certificate, evidence reference. Never overwritten by editing the AD; a Flight Program administrator corrects one by appending a correction that keeps the original.

**Component**:
A serialized, time- or life-tracked part (quantity one) that is either installed on an aircraft at a position or held in inventory. It moves between the two only through a work order, applied when the order closes.
_Avoid_: part (for a tracked component), unit

**Component requirement**:
A service or life limit on a component expressed in hours, cycles or calendar time.
_Avoid_: service requirement, limit (bare)

**Correction**:
An audited change to a completed record that keeps the original and records a reason.
_Avoid_: edit, amendment, update (for a record change)

**Independent inspector**:
A signer other than the person who performed the work, required where a step demands independent inspection.
_Avoid_: RII (bare), second signer

**Inspection**:
A recurring or one-time maintenance requirement on an aircraft or one of its components, due by hours, cycles or calendar, with last-compliance values.
_Avoid_: schedule (bare), check

**Inspection template**:
A reusable definition of an inspection's headers and tasks, activated onto an aircraft to create inspections.

**Job card**:
The executable card where findings, actual work, parts used, evidence and signoffs are recorded (`TC-YYYY-NNNN`). A job card in a work order is the order's own copy of a job card template, and later template edits do not change it; a job card can also stand on its own.
_Avoid_: task card

**Job card template**:
A job card kept on an inspection, component requirement or discrepancy, outside any work order, as reusable instructions, notes and required parts. It is never worked or signed: adding its source to a work order copies it into the order as a job card.
_Avoid_: task template, task card

**Logbook entry**:
Generated text or unsigned PDF of the record 14 CFR 43.9 or 43.11 requires for completed work, produced for signature in the aircraft's logbook. The signed logbook, not the app, is the maintenance record.
_Avoid_: log entry, record (bare)

**Logbook page photo**:
A photo of the paper logbook attached to the app record it answers to: the handwritten line on a flight, or the signed page on a completed work order. Kept on the aircraft record with the Form 337 copies, never deleted, only archived with a reason.
_Avoid_: attachment (for the photo), scan, image (bare)

**Overdue**:
A maintenance limit that has been reached. A usage limit (hours, cycles or landings) is reached at 0 remaining, because the next flight would exceed it; a calendar limit stays valid through the end of its due date, so it is due soon on that date and overdue from the next day. An overdue inspection, component requirement or AD action grounds the aircraft. Component screens label a usage limit at exactly 0 "Due now" and one beyond it "Past due"; both are overdue.
_Avoid_: expired (for maintenance limits; stock expires)

**Record numbers**:
The rows that hold the work order and job card numbers in use, so a save finds the next free `WO-YYYY-NNNN` or `TC-YYYY-NNNN` without reading every record. `migrations:rebuildRecordNumbers` rebuilds them after a restore.
_Avoid_: counter, sequence

**Records package**:
The on-demand ZIP of everything Angel One holds for one aircraft: the status sheet, flights, discrepancies, work orders with their frozen logbook entries, AD compliance history, components, Form 337 copies and the change log, as a printable PDF, one CSV per table and the stored files. For an FAA inspector (14 CFR 91.417(c)), a buyer (91.419) or an insurer; the signed logbooks remain the maintenance record.
_Avoid_: export bundle, dump, records dump

**Release statement**:
The return-to-service wording attached to completed work.

**Requested work**:
One line of a work order: a discrepancy, inspection, component requirement, AD action or free text.
_Avoid_: task (bare), item

**Signoff**:
A named person's recorded completion of a required step on a job card. Required signoffs gate completion.
_Avoid_: approval, sign-off, check-off

**Stale save**:
A save refused because the record changed since the form loaded it: someone else saved in between. Nothing is overwritten silently; the user reviews every field either person changed and keeps their changes (only the fields they changed are saved on top of the current record, and only when the two saves can be combined), uses the saved record, or cancels.
_Avoid_: conflict, collision, race, version mismatch

**Status record**:
One of the six permanent records 14 CFR 91.417(a)(2) requires an operator to keep and transfer with the aircraft: total time in service, life-limited part status, time since overhaul, inspection status, AD compliance status, and Form 337 copies. Angel One is the system of record for them.
_Avoid_: permanent record, aircraft history

**Summary**:
The tab of Change history that shows the Weekly summary, beside **Change log**; only Flight Program administrators see it.

**Weekly summary**:
The Flight Program administrator's review of a period of the change log: entries counted by person and action family, the notable events (dispatch overrides, permission and account changes, archives, corrections) and the number of refused sign-ins. On screen it is the **Summary** tab. A period with more change log than one request can read (3 MiB) is cut short, and the summary says so.
_Avoid_: audit report, activity digest

**Work order**:
A numbered container (`WO-YYYY-NNNN`) of requested work on one aircraft, opened with a snapshot of aircraft readings and finished by close-out.
_Avoid_: WO (in prose), job, ticket

## Parts and purchasing

**Core return**:
Return of a removed unit to a vendor for credit after an exchange.

**Inventory location**:
A storage place owned by a Flight Program, with optional shelf, bin or room.
_Avoid_: warehouse, store

**Parts request**:
An internal request for parts or for a repair, raised against an aircraft or work and tracked to fulfilment.

**Purchase order**:
An order to a vendor with line items, attachments and receipt tracking.
_Avoid_: PO (in prose), order (bare)

**Purchasing keys**:
The lookup rows a parts request or purchase order is found by: the request ids in its history, the components its lines repair, the requests an order line is allocated to and an active recurring list's aircraft. A purchasing save reads only the records these keys name; `migrations:backfillHistoryColumns` fills them for older records.

**Shelf life**:
The expiry date after which a stock item may not be used.

**Stock item**:
A quantity-tracked part or supply at an inventory location.
_Avoid_: inventory (for one item), SKU

**Vendor**:
A supplier or repair station from which parts or services are bought.
_Avoid_: supplier

## Operations

**Alert**:
An in-app notice about due or overdue maintenance, expiring dates and documents to review, optionally emailed as a daily digest; the urgent ones also go out at once.
_Avoid_: notification, reminder

**Board view**:
The read-only fleet summary for a Flight Program's board members: aircraft status, due items, discrepancy counts, cost totals against budget and the last off-site backup, with a PDF board summary.
_Avoid_: executive dashboard, read-only dashboard

**Checklist**:
A ForeFlight-compatible aircraft checklist set with normal, abnormal and emergency categories; progress is personal.

**Cost**:
A recorded expense attributed to an aircraft, work order or purchase.

**Cost ledger**:
Each work order's labor, parts and other costs by day, for the program that paid, kept in step with every cost write. The board view and the Costs report total from it; a nightly reconcile logs any work order whose ledger differs from its records.

**Demo mode**:
An explicitly labelled in-browser mode with fictional aircraft and data persisted locally, isolated from live data.
_Avoid_: sandbox, test mode

**Engine trend**:
A summary of one imported engine-monitor file for an aircraft, compared against limits.

**Expiring date**:
A renewal a Flight Program or the deployment must not miss (insurance, registration, a service key, a client secret), with a warning window; it alerts from the window and when the date passes.
_Avoid_: reminder, expiry item, deadline

**Owner portal**:
A read-only view of an aircraft's status and due items for the aircraft's owner. With a board group as well, the owner gets the board view beside it, never the workspace.

**Paper check**:
The monthly list of one aircraft's flights and completed work orders as the app recorded them, with an empty Checked column to tick against the paper logbook. A checklist for the comparison, not a record: the signed paper logbook governs.
_Avoid_: reconciliation report, audit of paper, logbook audit

**Urgent alert**:
An alert that needs action now and reaches people as soon as it arises, by email and on their devices: an aircraft grounded, an inspection or AD overdue, a component past its limit, an expiring date passed, or, for a program's administrators, one member's open problem reports reaching half their limit.
_Avoid_: notification, critical alert, immediate alert (the channel is immediate; the alert is urgent)

## Platform and safeguards

**Backup**:
A consistent snapshot of every table and uploaded file at one moment. Does not include environment variables.

**Disabled user**:
A user whose account a system administrator has switched off: every session ends at once and they cannot sign in until it is enabled again.

**Escrowed secrets**:
The encrypted copy of production environment variables (encryption and sign-in keys) kept with the backups, without which a restore cannot decrypt credentials or keep sessions. Made only while a backup key is set: they are never stored unencrypted (ADR-0014).

**File link**:
A signed link to one stored file that stops working five minutes after it is issued, given only to a signed-in member who may see the record the file belongs to. Records and the offline copy hold file ids, never file links.
_Avoid_: storage URL, download link

**File sweep**:
The hourly job that finds stored files no record refers to and that are more than a day old. It only reports them until `FILE_SWEEP=delete` is set, and never reads a file stored before its first run.

**History page**:
One page of the older records the retention window leaves out, loaded newest first under **Load older**: flights, problem reports, work orders, parts requests, purchase orders, flight plans and the change log. It needs a connection.
_Avoid_: archive

**Monthly archive**:
The first off-site copy of each month, kept forever for life-of-aircraft retention and tamper evidence.

**Off-site copy**:
A backup stored outside Convex, in the program's R2 bucket, locked against deletion for its retention period; unencrypted unless a backup key is set (ADR-0014).

**Preview deployment**:
A short-lived Convex deployment for testing a change or a restore rehearsal, deleted afterwards. Previews for each change are not set up yet.
_Avoid_: staging server

**Production deployment**:
The one Convex deployment that holds real records. Every other deployment (development, preview, scratch) holds test data or a short-lived restored copy.
_Avoid_: live server, prod database

**Restore rehearsal**:
The quarterly practice restore of a monthly archive into a scratch deployment, with recorded pass criteria.

**Retention window**:
The part of a Flight Program's history the workspace holds: open items, three months of closed records, six months of flights and the five latest completed work orders per aircraft. Inspections, ADs, components' records, checklists and templates stay complete (ADR-0013); older records load as history pages.
_Avoid_: archive, cutoff (bare)

**Sign-in lockout**:
An account refusing sign-in after 10 failed password attempts within an hour, regaining one attempt every 6 minutes; a system administrator's password reset clears it at once.

**Unencrypted backup**:
An off-site copy stored without encryption, named `.unencrypted.zip`, the default since 20 Nov 2026 (ADR-0014). Its sign-in session and token rows are emptied.

**Workspace**:
What the server sends a signed-in device: the active Flight Program's records the user may see, within the retention window. The device keeps a copy, which opens offline for seven days from sign-in.
_Avoid_: snapshot (in user-facing text), dataset

## Project shorthand

**D1–D25**:
The 10 Nov 2026 bug hunt's decisions for Aaron, listed in the handbook's decisions page.

**Fleet-year**:
One year of records for the size test's fleet of six aircraft; capacity is measured at 1, 3, 10 and 20 fleet-years.

**H1–H7**:
Aaron's answers of 19 Nov 2026 on history paging.

**MiB**:
1,048,576 bytes. Convex states its read and write limits in MiB.

**S0–S9**:
The history-paging stages, from the multi-year test fixture (S0) to the slow path left open (S9): accepting a held flight from long ago, which passes Convex's one-second limit at about 20 years.
