# Angel One

Maintenance-records and operations tracker for a mission flight program's aircraft. It holds the records a US operator must keep under 14 CFR Part 91 and the day-to-day work that produces them. Seeded 2026-11-01 from `docs/*.md` and the code; sharpen terms with `/domain-modeling` as decisions land.

## Access

**Flight Program**:
The organization unit that owns aircraft, inventory locations, stock and memberships. The first access boundary: every record belongs to exactly one, or is unassigned.
_Avoid_: tenant, organization, customer

**Permission group**:
A named bundle of permissions (read, flight, discrepancy, resolve, maintenance) over all or selected aircraft of one Flight Program.
_Avoid_: role

**Flight Program administrator**:
A member whose group grants management of an entire Flight Program.

**System administrator**:
The account kind that manages every Flight Program, user and group, and the only one that sees unassigned records.
_Avoid_: superuser, root

**Membership**:
A user's belonging to a Flight Program through at least one permission group.
_Avoid_: account (for the belonging), seat

**Unassigned records**:
Aircraft, locations or components with no owning Flight Program; visible only to system administrators.

**Administration**:
The screen that decides who can do what: users, permission groups and aircraft access.

**Settings**:
The screen that changes how the app behaves, from your own account, your alerts and this device to a Flight Program's details and the system's integration keys, each section shown only to those allowed to change it.

## Aircraft and flying

**Aircraft**:
A registered airframe owned by one Flight Program, carrying Hobbs, tach, total time, cycle and landing counters.

**Total time**:
Aircraft time in service: the selected meter (Hobbs or tach) plus the total time adjustment.

**Aircraft setup**:
Loading an aircraft's existing history in one guided pass: identity and baseline readings, installed components, inspections with their last-done values and AD compliance, from CSV templates, with a dry run before the inspection and AD rows are saved.
_Avoid_: onboarding, initial load, migration

**Flight**:
A logged flight with starting and ending meter readings; the unit of usage that advances aircraft counters.

**Discrepancy**:
A reported defect on an aircraft, open until resolved or deferred.
_Avoid_: squawk, issue, defect (in records)

**Deferral**:
Postponement of a discrepancy under a Minimum Equipment List (MEL) item and category, with placard text and a repair deadline.

**Aircraft status**:
The computed level of an aircraft, airworthy, due soon or grounded, together with the reasons that produced it.

**Dispatch gate**:
The check that blocks releasing a grounded aircraft for a flight.

**OK to fly**:
The one-line verdict on an aircraft card and detail: "Not OK to fly" exactly when the aircraft is grounded (the dispatch gate would refuse a flight), otherwise "OK to fly", with the single most important reason.
_Avoid_: cleared, released

**Dispatch override**:
A recorded, reasoned decision to fly despite the dispatch gate; the reason is kept with the flight.

**Pending entry**:
A flight or discrepancy recorded offline and waiting in the outbox to sync.
_Avoid_: queued operation (in user-facing text), draft

**Conflict review**:
Administrator review of a synced flight whose readings disagree with the aircraft's current counters, or that is longer than 24 hours on a meter (longer than any single flight); totals are not changed until reviewed.

## Maintenance

**Inspection**:
A recurring or one-time maintenance requirement on an aircraft or one of its components, due by hours, cycles or calendar, with last-compliance values.
_Avoid_: schedule (bare), check

**Inspection template**:
A reusable definition of an inspection's headers and tasks, activated onto an aircraft to create inspections.

**Component**:
A serialized, time- or life-tracked part (quantity one) that is either installed on an aircraft at a position or held in inventory.
_Avoid_: part (for a tracked component), unit

**Component requirement**:
A service or life limit on a component expressed in hours, cycles or calendar time.
_Avoid_: service requirement, limit (bare)

**Overdue**:
A maintenance limit that has been reached. A usage limit (hours, cycles or landings) is reached at 0 remaining, because the next flight would exceed it; a calendar limit stays valid through the end of its due date, so it is due soon on that date and overdue from the next day. An overdue inspection, component requirement or AD action grounds the aircraft. Component screens label a usage limit at exactly 0 "Due now" and one beyond it "Past due"; both are overdue.
_Avoid_: expired (for maintenance limits; stock expires)

**Airworthiness directive (AD)**:
An FAA-mandated action tracked per aircraft or component: applicability review, required actions, recurrence, and compliance history.

**Status record**:
One of the six permanent records 14 CFR 91.417(a)(2) requires an operator to keep and transfer with the aircraft: total time in service, life-limited part status, time since overhaul, inspection status, AD compliance status, and Form 337 copies. Angel One is the system of record for them.
_Avoid_: permanent record, aircraft history

**Records package**:
The on-demand ZIP of everything Angel One holds for one aircraft: the status sheet, flights, discrepancies, work orders with their frozen logbook entries, AD compliance history, components, Form 337 copies and the change log, as a printable PDF, one CSV per table and the stored files. For an FAA inspector (14 CFR 91.417(c)), a buyer (91.419) or an insurer; the signed logbooks remain the maintenance record.
_Avoid_: export bundle, dump, records dump

**Compliance record**:
An append-only entry that an AD action was performed: method, date and counters, mechanic and certificate, evidence reference. Never overwritten by editing the AD; a Flight Program administrator corrects one by appending a correction that keeps the original.

**Work order**:
A numbered container (`WO-YYYY-NNNN`) of requested work on one aircraft, opened with a snapshot of aircraft readings and finished by close-out.
_Avoid_: WO (in prose), job, ticket

**Requested work**:
One line of a work order: a discrepancy, inspection, component requirement, AD action or free text.
_Avoid_: task (bare), item

**Task template**:
Reusable instructions, notes and required parts attached to an inspection, component requirement or discrepancy.
_Avoid_: task card (for the template)

**Task card**:
The executable card where findings, actual work, parts used, evidence and signoffs are recorded (`TC-YYYY-NNNN`).

**Job card**:
A task card copied into, and owned by, one work order. Later template edits do not change it.

**Signoff**:
A named person's recorded completion of a required step on a task card. Required signoffs gate completion.
_Avoid_: approval, sign-off, check-off

**Independent inspector**:
A signer other than the person who performed the work, required where a step demands independent inspection.
_Avoid_: RII (bare), second signer

**Close-out**:
Completing a work order: applies planned component movements, freezes the recorded readings and produces the work summary.
_Avoid_: closing, completion (of the order)

**Release statement**:
The return-to-service wording attached to completed work.

**Logbook entry**:
Generated text or unsigned PDF of the record 14 CFR 43.9 or 43.11 requires for completed work, produced for signature in the aircraft's logbook. The signed logbook, not the app, is the maintenance record.
_Avoid_: log entry, record (bare)

**Logbook page photo**:
A photo of the paper logbook attached to the app record it answers to: the handwritten line on a flight, or the signed page on a completed work order. Kept on the aircraft record with the Form 337 copies, never deleted, only archived with a reason.
_Avoid_: attachment (for the photo), scan, image (bare)

**Correction**:
An audited change to a completed record that keeps the original and records a reason.
_Avoid_: edit, amendment, update (for a record change)

**Audit entry**:
The record of who changed what and when, with before and after state and the reason.
_Avoid_: log (bare), history (bare)

**Weekly summary**:
The Flight Program administrator's review of a period of the change log: entries counted by person and action family, the notable events (dispatch overrides, permission and account changes, archives, corrections) and the number of refused sign-ins.
_Avoid_: audit report, activity digest

**Command**:
A validated request to change records in one step, carrying a request id so that repeating it has no further effect.
_Avoid_: mutation (for the request), action, operation (reserved for offline flight and discrepancy entries)

**Stale save**:
A save refused because the record changed since the form loaded it: someone else saved in between. Nothing is overwritten silently; the user reviews every field either person changed and keeps their changes (only the fields they changed are saved on top of the current record, and only when the two saves can be combined), uses the saved record, or cancels.
_Avoid_: conflict, collision, race, version mismatch

## Parts and purchasing

**Inventory location**:
A storage place owned by a Flight Program, with optional shelf, bin or room.
_Avoid_: warehouse, store

**Stock item**:
A quantity-tracked part or supply at an inventory location.
_Avoid_: inventory (for one item), SKU

**Shelf life**:
The expiry date after which a stock item may not be used.

**Parts request**:
An internal request for parts or for a repair, raised against an aircraft or work and tracked to fulfilment.

**Purchase order**:
An order to a vendor with line items, attachments and receipt tracking.
_Avoid_: PO (in prose), order (bare)

**Core return**:
Return of a removed unit to a vendor for credit after an exchange.

**Vendor**:
A supplier or repair station from which parts or services are bought.
_Avoid_: supplier

## Operations

**Demo mode**:
An explicitly labelled in-browser mode with fictional aircraft and data persisted locally, isolated from live data.
_Avoid_: sandbox, test mode

**Alert**:
An in-app notice about due or overdue maintenance, expiring dates and documents to review, optionally emailed as a daily digest; the urgent ones also go out at once.
_Avoid_: notification, reminder

**Urgent alert**:
An alert that needs action now and reaches people as soon as it arises, by email and on their devices: an aircraft grounded, an inspection or AD overdue, a component past its limit, an expiring date passed.
_Avoid_: notification, critical alert, immediate alert (the channel is immediate; the alert is urgent)

**Expiring date**:
A renewal a Flight Program or the deployment must not miss (insurance, registration, a service key, a client secret), with a warning window; it alerts from the window and when the date passes.
_Avoid_: reminder, expiry item, deadline

**Owner portal**:
A read-only view of an aircraft's status and due items for the aircraft's owner. With a board group as well, the owner gets the board view beside it, never the workspace.

**Board view**:
The read-only fleet summary for a Flight Program's board members: aircraft status, due items, discrepancy counts, cost totals against budget and the last off-site backup, with a PDF board summary.
_Avoid_: executive dashboard, read-only dashboard

**Checklist**:
A ForeFlight-compatible aircraft checklist set with normal, abnormal and emergency categories; progress is personal.

**Engine trend**:
A summary of one imported engine-monitor file for an aircraft, compared against limits.

**Cost**:
A recorded expense attributed to an aircraft, work order or purchase.

**Paper check**:
The monthly list of one aircraft's flights and completed work orders as the app recorded them, with an empty Checked column to tick against the paper logbook. A checklist for the comparison, not a record: the signed paper logbook governs.
_Avoid_: reconciliation report, audit of paper, logbook audit

## Platform and safeguards

**Production deployment**:
The one Convex deployment that holds real records. Every other deployment (development, preview, scratch) holds test data or a short-lived restored copy.
_Avoid_: live server, prod database

**Preview deployment**:
A short-lived Convex deployment created for one change and deleted after 14 days; used for testing and restore rehearsals.
_Avoid_: staging server

**Backup**:
A consistent snapshot of every table and uploaded file at one moment. Does not include environment variables.

**Off-site copy**:
An encrypted backup stored outside Convex, in the program's R2 bucket, locked against deletion for its retention period.

**Monthly archive**:
The first off-site copy of each month, kept forever for life-of-aircraft retention and tamper evidence.

**Restore rehearsal**:
The quarterly practice restore of a monthly archive into a scratch deployment, with recorded pass criteria.

**Escrowed secrets**:
The encrypted copy of production environment variables (encryption and sign-in keys) kept with the backups, without which a restore cannot decrypt credentials or keep sessions.

**Sign-in method**:
How a user proves who they are: password, Google account or Microsoft account. Every user has a password; the other two are optional.

**Linked identity**:
A Google or Microsoft account attached to an Angel One user after a verified-email match; afterwards matched by the provider's account id.
_Avoid_: SSO account, social login

**Sign-in lockout**:
An account refusing password sign-in after 10 failed attempts within an hour, regaining one attempt every 6 minutes; a system administrator's password reset clears it at once.

**Disabled user**:
A user whose account a system administrator has switched off: every session ends at once and no sign-in method creates a new one until it is enabled again.
