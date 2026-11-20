# Offline entries, the Sync center and changes that collide

Pilots log flights and report problems without a connection; everything else needs one. This page covers what happens to those entries afterwards, and what the app does when two people change the same record. Setup for offline use (installing the app, the seven-day access window) is in the [README](../README.md#offline-and-installation).

## Pending entries and the Sync center

A flight or problem report saved without a connection is a pending entry: it is kept on the device and sent when the app is online and connected. **Sync center** lists the signed-in user's entries, oldest first, with **Sync now** and **Export pending entries** (a JSON file of the entries, for a record or for support). An entry recorded under another Flight Program syncs only once that program is active again.

While any of the signed-in user's entries wait, a line under the top bar says how many, such as **3 entries waiting to send**, adds **Offline** when there is no connection, and links to the Sync center (**See entries**). It stays in view as the screen scrolls, is read out once by screen readers when it appears or its count changes, and disappears when the last entry is sent. The connection pill in the top bar says only **Connected** or **Offline**.

The server checks every entry again when it arrives. An entry it refuses for good (a dispatch gate it cannot pass because the aircraft was grounded before the flight began, a pilot no longer in the program, oil drawn from stock that is not there) stays in the Sync center as **Needs attention** with the server's reason; a dropped connection is retried on the next sync without any action. A retry of an entry the server already stored is answered with the stored result; a copy that reuses the entry's id with different contents is refused, with that reason, so it is never removed from the device as if it had been saved. A failed entry offers two actions:

- **Edit and retry** opens the flight or report form prefilled from the entry, including a flight's discrepancy text, which files its open report when the retried flight syncs. Saving replaces the failed entry with a new one under its own request id, so the server sees a fresh entry rather than a repeat of the refused one. A flight starts from the aircraft's readings as they are now; if the aircraft was grounded in the meantime, an administrator records the dispatch override in the same form. If the edited entry cannot be queued (for example the aircraft is no longer in reach), the failed entry stays as it was. [Logbook page photos](logbook-photos.md) waiting on a replaced flight move to the new entry and upload once it has synced.
- **Discard entry** removes it from the device after confirmation. It never reached the server and cannot be recovered; export first if a copy is needed.

## Signing out and shared devices

Signing out removes everything the app keeps on the device for the person signing out: the copy of the Flight Program, their pending entries and waiting [logbook page photos](logbook-photos.md), their favorite aircraft and which alerts they have read, every unsent form draft (preflight sessions, checklist progress, guided-flight and aircraft-setup drafts) and every [manual kept on the device](reference-library.md#keep-on-this-device). Device settings stay: the theme, large text, which menu groups are collapsed, the label printer settings and, in the demo, its fictional records.

If any of their entries or photos have not synced, signing out first says how many, such as **2 entries and 1 photo haven't synced**, and that signing out deletes them from the device and they cannot be recovered. **Stay signed in** (or Escape) keeps everything, to sync once connected; only **Delete and sign out** deletes them. Every way out asks: **Sign out**, **Return to sign in** after offline access expired, and **Sign out** on the page shown when the workspace cannot be opened. Entries and photos someone else left on the device are not the signer's to delete and stay until their author signs in.

A session that ends without signing out (seven days after sign-in, or when an administrator resets the password or disables the account) removes the copy of the Flight Program and the kept manuals once the device is next connected. Pending entries and photos stay, since nobody chose to delete them, and sync when the same person signs in again.

The copy of the Flight Program stays on the device for seven days from sign-in, unencrypted, so pilots can work without a connection. Phones and tablets used for the app must have a screen lock (a passcode, fingerprint or face unlock).

## What the device keeps

The copy on the device is the workspace as the server sends it: the retention window ([history paging](history-paging.md), ADR-0013), not the program's whole history.

- **Kept:** the aircraft, their inspections, ADs, components and inventory; checklists; every open item however old (held flights, open and deferred problem reports, open work orders and their job cards, open parts requests and purchase orders, and recurring request lists); six months of flights, and the flight plans still to fly or departed in those six months; three months of closed maintenance and purchasing; the five latest completed work orders on each aircraft, with the requests they count; the program's members.
- **That is what logging a flight offline needs:** the aircraft and its counters, what is due, open problem reports and the dispatch gate, checklists, queued plans and the crew. `tests/e2e/history-paging.spec.ts` logs one offline from the windowed copy.
- **Not kept:** older flights, problem reports, work orders, settled parts requests, closed purchase orders and older flight plans. **Load older** needs a connection and says so offline, on Parts requests, Purchase orders, Flight plans and a vendor's orders as on the other lists; a records package made offline says which tables are partial; the paper check refuses a month older than the window; a form that names an older record (a job card's report, a request's source, a purchase-order line's work order or request, a request's purchase order, a removal tag's work order, a plan flown long ago) loads it when connected and says it needs a connection otherwise. A purchase order naming an older request cannot be printed offline, rather than print without it.
- **History offline** lists the recent entries kept on the device, filtered by what it holds, so an entry about an older purchase order or a request for stock may be missing there; connected, History reads every entry from the server.

## When the workspace cannot be opened

If the server cannot load the Flight Program's records (an outage, or a program too large to load in one go), the app shows **Your workspace could not be opened.** instead of a blank page. It says the records are safe and entries saved on the device stay queued, and asks the user to contact their Flight Program administrator if it keeps happening. **Try again** reloads and asks the server again. **View the copy on this device** opens the copy kept from the last sync, but only after the server confirms it belongs to the account now signed in. The copy behaves as it does offline: direct edits are off, and flights and problem reports wait in the Sync center until the workspace opens. **Export my pending entries** and **Sign out** are offered too. Any other unexpected screen error shows **Something went wrong.** with a reload, never a blank page.

## Several legs logged offline

A pilot who logs more than one flight on the same aircraft without a connection does not have the later legs held. Each later leg opens on the readings the earlier ones end at (leg 2 starts at leg 1's ending Hobbs), and the device queues it with the aircraft version the earlier legs will leave behind. When the entries sync, oldest first, the server accepts them in order and the totals include every leg. The server's checks are the same as for any flight: if an earlier leg is held or refused, the aircraft is left behind the version the later legs expect, so every later leg is held too, with the reason "Aircraft totals changed after this entry was started." Only the signed-in user's own pending flights on that aircraft count; a leg logged in a form that opened before the aircraft changed keeps the version it opened with and is held as before.

## Flights held for review

A flight that reaches the server after the aircraft moved on is not applied. It is stored as a held flight (status **Needs review**) and the aircraft's totals stay unchanged until an administrator reviews it. A flight whose aircraft was grounded only by problems reported after the flight began (a pilot reports a hard landing, then ends the flight) is held with the reason "The aircraft was grounded during this flight." instead of being refused, so its hours, landings and cycles are kept for the administrator to accept; anything that grounded the aircraft before the flight began still refuses it at the dispatch gate. A problem report takes its time when it reaches the server, so one reported offline counts as reported after any flight queued behind it: that flight is held, not refused. Otherwise the reasons are checked in this order: the aircraft changed after the entry was started; the flight predates a counter change; it is backdated or duplicates a time; a meter reading is lower than the current counter; a meter reading is more than 24 hours past the current counter. That last one is longer than any single flight and is almost always a typing slip (a missed decimal point turns 2342.5 into 23425); nothing is refused or lost, and an administrator who confirms the readings can accept the flight as logged. The same check holds such a row in a logbook import.

**Review** in the flight log opens the held entry. The review reason is shown on top, and under it the held entry's readings, landings, cycles and flight time appear beside the aircraft's current totals, one row per field that differs, so the reviewer sees what the reason refers to before deciding. The administrator then accepts the entry (with corrections if needed; totals and later flights are rebuilt) or rejects it (excluded from totals). Both decisions keep the original values and the explanation in the change log. The rules of the review itself are unchanged by this page; see [flight log options](flight-log-options.md).

## When two people change the same record

Every record edited online carries a version. A form saves against the version it loaded; if someone else saved in between, the server refuses the save with one message, "This record was changed by someone else. Review the differences." Nothing is merged and the last writer does not win silently.

The inspection, component, AD, work order and purchase order forms catch that refusal and open a review instead of printing it. The review names who saved the record last and when (from the change log) and lists every field either person changed since the form opened, in plain words, nested fields included: a required action's next due hours, a work item's status or parts delay, a purchase order line's quantity. Each row shows your value beside theirs and says who changed it and what Keep mine does with it. The review offers three choices:

- **Keep mine** saves only the fields you changed, on top of the record as it is now. A field only the other person changed keeps their value; a field you both changed takes yours, and its row says so. List items (required actions, work items, order lines) are combined one by one: an item either of you added is kept, and an item one of you removed stays removed unless the other changed it. Both saves remain in the change log.
- **Use theirs** reloads the form from the record as it is now, after confirmation. Your typed changes are dropped.
- **Cancel** returns to the form with your changes still in it, for example to copy a value before deciding.

Keep mine is not offered, and the review says why, when the two saves describe one fact differently and cannot be combined safely:

- an inspection's last compliance or due limits (for example a completion recorded by each of you), or its calendar exemption;
- an AD action's due limits or intervals after compliance was recorded on that action, or the AD's applicability decision;
- where a component is installed or stored, or its time, cycle and calendar baselines;
- a work item's status and parts delay, or the order's status and completion date;
- a purchase order's vendor;
- a list item one of you removed and the other changed.

Use theirs and make the change again in that case. Parts of a record that only the server writes are never taken from a form: an AD's compliance history and earlier FAA source versions, a component sent out for repair, an inspection's calendar-exemption stamp, and the due values a recurring interval sets. The server also refuses an AD save that changes an action's due limits without having seen compliance recorded on that action since, so a re-sent old copy cannot put back a due point that compliance moved.

Other versioned records (task cards, parts requests, saved addresses, flight plans, checklists, settings keys) refuse a stale save with the same message but still show it as text; their forms do not open the review yet.

The demo behaves the same. Two tabs share the demo's stored records, so saving the same inspection from both shows the review in the second tab.
