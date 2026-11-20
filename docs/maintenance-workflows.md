# Maintenance and inventory workflows

This phase deliberately skips entering real aircraft and users. The local demo stays separate from operational data. Existing records remain available through Flight Program ownership or the system administrator’s unassigned-records view. Older caches require an online refresh.

## Access and connectivity

System administrators can manage every module; Flight Program administrators manage their active program. A group's **Manage inspections and components online** permission grants maintenance writes for that group's aircraft, alongside its required read permission. Aircraft readers can view the corresponding maintenance records. Inventory locations, stock, and stock history belong to a Flight Program and are visible only to its program administrators and system administrators. See [Flight Program access](flight-program-access.md).

All maintenance and inventory mutations require a live authenticated connection. Authorized cached records remain readable offline within the existing login lease. Only flights and discrepancy additions enter the offline outbox.

One member may have at most 200 open problem reports in a Flight Program, holding at most 512 KiB of text (`src/domain/reportBacklog.ts`). Deferred and resolved reports do not count. A new report past either limit, from **Report a problem** or a flight's discrepancy field, is refused with "You have too many open problem reports. Ask an administrator to resolve or defer some of your open reports, then send this one again."; an offline entry stays in the Sync center with that message until it is retried or edited. Resolving and deferring are never limited. The limits sit far above real use and exist because the workspace loads every report in one read that Convex caps at 16 MiB: without them one member could lock everyone out of the program (bug hunt SE-13, decision D2).

## Inspections

Create an aircraft schedule with a reference, description, and optional required-parts/supplies notes. Usage may follow the aircraft or one of its serialized components. Each recurrence can use hours, cycles, months, or a combination. Supply last-compliance values for each recurring interval; calendar deadlines fall on the last day of the target month. One-time due values are available when that limit has no recurrence.

Completion captures date, tracked total hours, tracked cycles, work description, actor, and before/after values. It advances recurring limits and archives one-time schedules. Archived schedules remain available through **Show archived**. Schedule creation and editing record change history automatically. Component-targeted schedules stay tied to that serial, including while the component is in storage; create another schedule for a replacement component. While the component is in storage its schedules still show their status and alerts, but they no longer ground the aircraft it came off or block its flights.

Each limit's remaining amount has a small meter beside it on the Inspections screen, in the aircraft's inspection schedules and in the Overview's maintenance outlook. The meter shows how much of the current interval is left: the recurring interval when one is recorded, else the span from the last compliance to the due value (for a calendar limit, from the last compliance date to the due date). It is green while the limit is scheduled, amber when due soon and an empty red track with the word **Overdue** once the limit is reached, by the rule in [Due soon and overdue](#due-soon-and-overdue). A limit with no known interval shows its amount only.

**Maintenance calendar** (Maintain menu, for everyone who sees the maintenance outlook) shows a month of inspections, component requirements and AD actions on the day each falls due: calendar limits on their due date, usage limits on the date Planning projects from recent flights, and overdue items on today marked **Overdue**. Items with a usage limit but too little flight history to project are listed beside the month under **Due by hours, no date**. Previous and next month, **Today** and an aircraft filter change the view; on phones the month becomes a list by day. Each item opens its screen. The calendar changes no records, and its projections are estimates for planning, not compliance records.

Inspections and components have an optional **ATA Chapter** dropdown using the supplied chapter catalog. The selected two-digit code (including leading zeroes) is stored for future filtering and shown with its description in each table. Existing records remain unassigned; selecting **Unassigned** clears the classification. Chapter changes are included in the audit history and CSV exports.

## Components

The component module now follows the legacy v19 component, service-requirement, and movement records. It includes free-text type, ATA, manufacturer, part/serial, notes, independent tracking switches, aircraft/inventory location, installation position, historical installation readings, TSN and nullable TSO/TSR baselines, cycles, and accumulated service days.

Use **Details** to view requirements and history, **Edit component** for identity/location details, **Set baseline** for verified readings, and **Move / service** to plan an installation or removal or to record a workshop overhaul or repair. Installations and removals go through a work order: **Move / service**, **Install / service** (inventory) and **Work orders → Requested work → Install/remove component** each plan the movement on an open order, and it applies when that order closes ([component inventory](component-inventory.md)). **Set baseline** is refused when the new totals fall below the last compliance recorded on one of the component's inspections, service requirements or ADs, and the message names the record: correct that record first, so no limit is left with more remaining than its interval. A correction of aircraft total time, cycles or landings (Edit aircraft or a flight review) is refused the same way below an inspection's or an aircraft AD's recorded compliance. **Add service requirement** supports separate life, overhaul, and inspection requirements with TSN/TSO/TSR bases, absolute or relative limits, calendar units, and warning thresholds.

See [the legacy comparison and field mapping](component-legacy-alignment.md) for calculations, the clean component schema, and access behavior.

## Due soon and overdue

Inspections, component requirements and AD actions share one rule for when a limit is reached:

- **Usage limits** (hours, cycles, landings) are reached at 0 remaining. The next flight would exceed the limit, so the item is overdue and the aircraft is grounded.
- **Calendar limits** stay valid through the end of the due date. On the due date the item is due soon; from the next day it is overdue and the aircraft is grounded.

A limit that is reached decides the status even when another limit of the same item cannot be judged. If the aircraft's time source has no reading, or a component does not track the counter a limit needs, a passed due date or a reached cycles or landings limit still makes the item overdue. A limit that cannot be read is never counted as time remaining: until one of the other limits is reached the item stays unknown (**Counter unavailable** on an AD action, **Review** on a component limit).

Aircraft status, the dispatch gate, alerts, the owner portal, Planning and Overview all apply this rule. Component screens label a usage limit at exactly 0 **Due now** and one beyond it **Past due**; both ground the aircraft. The server checks the dispatch gate against the earliest local date anywhere, so a calendar limit is not treated as overdue until its due date has ended in every time zone.

Each aircraft card on Overview and the aircraft detail open with an **OK to fly** line. It reads **Not OK to fly** exactly when the aircraft is grounded, the same rule the dispatch gate uses, and stays **OK to fly** with an amber note when something is due soon. It names one reason, chosen in this order: grounded in the aircraft profile, an open grounding discrepancy, an expired deferral, then inspections, ADs and component limits; "+N more" counts the rest, which the status notes list in full.

## Inventory

Create a storage location with address/contact details, then add parts or consumables with part/alternate numbers, description, condition, location, and reorder threshold. Stock items also have optional Vendor, Invoice #, PO Ref, and Cost fields. Cost accepts a nonnegative amount with up to two decimal places; it is a recorded value, with no currency conversion or automatic valuation. These fields can be edited or cleared and appear in the inventory list, history, and CSV export. The Qty field accepts an opening quantity when creating stock and a corrected counted balance when editing. It defaults to zero and requires a nonnegative whole number. Quantity edits retain before/after balances in audit history. **Move stock** supports receipts, issues, and adjustments to a counted balance. Every movement automatically records the action, actor, time, and previous/new balances. Stock cannot become negative. Location is fixed for a lot; automatic transfers between lots are not included.

Component installation and inspection completion do not automatically consume stock. Required materials are schedule notes, not a reserved-stock bill of materials. Record consumed items through stock issues. The dashboard flags stock at or below its reorder threshold and installed components at their recorded limits. Inventory and component records are included in the administration CSV backups; movement and completion histories are in the audit export.

## Consistency

All writes validate records on the server, check the current record version, and record an audit entry in the same transaction. A request UUID makes retries idempotent. Stale forms must be refreshed before resubmission. Records are retained; inspection archiving replaces destructive deletion. The demo uses the same validation/calculation functions with local persistence.

Every correction to a completed record requires a reason, which its change-history entry keeps: work-order revisions, component close-out corrections, changes to an AD whose applicability is decided, and AD compliance corrections (Flight Program administrators only; see [Airworthiness directives](airworthiness.md#work-orders-and-compliance)).

The **Work performed / reason** field is required only for component Move / Service events and inspection completions. Component details, inspection setup, stock items, stock movements, and storage locations record automatic history without requesting a reason.
