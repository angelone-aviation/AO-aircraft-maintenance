# Offline entries, the Sync center and changes that collide

Pilots log flights and report problems without a connection; everything else needs one. This page covers what happens to those entries afterwards, and what the app does when two people change the same record. Setup for offline use (installing the app, the seven-day access window) is in the [README](../README.md#offline-and-installation).

## Pending entries and the Sync center

A flight or problem report saved without a connection is a pending entry: it is kept on the device and sent when the app is online and connected. **Sync center** lists the signed-in user's entries, oldest first, with **Sync now** and **Export pending entries** (a JSON file of the entries, for a record or for support). An entry recorded under another Flight Program syncs only once that program is active again.

The server checks every entry again when it arrives. An entry it refuses for good (a dispatch gate it cannot pass, a pilot no longer in the program, oil drawn from stock that is not there) stays in the Sync center as **Needs attention** with the server's reason; a dropped connection is retried on the next sync without any action. A failed entry offers two actions:

- **Edit and retry** opens the flight or report form prefilled from the entry. Saving replaces the failed entry with a new one under its own request id, so the server sees a fresh entry rather than a repeat of the refused one. A flight starts from the aircraft's readings as they are now; if the aircraft was grounded in the meantime, an administrator records the dispatch override in the same form. If the edited entry cannot be queued (for example the aircraft is no longer in reach), the failed entry stays as it was. [Logbook page photos](logbook-photos.md) waiting on a replaced flight move to the new entry and upload once it has synced.
- **Discard entry** removes it from the device after confirmation. It never reached the server and cannot be recovered; export first if a copy is needed.

## When the workspace cannot be opened

If the server cannot load the Flight Program's records (an outage, or a program too large to load in one go), the app shows **Your workspace could not be opened.** instead of a blank page. It says the records are safe and entries saved on the device stay queued, and asks the user to contact their Flight Program administrator if it keeps happening. **Try again** reloads and asks the server again. **View the copy on this device** opens the copy kept from the last sync, but only after the server confirms it belongs to the account now signed in. The copy behaves as it does offline: direct edits are off, and flights and problem reports wait in the Sync center until the workspace opens. **Export my pending entries** and **Sign out** are offered too. Any other unexpected screen error shows **Something went wrong.** with a reload, never a blank page.

## Flights held for review

A flight that reaches the server after the aircraft moved on is not applied. It is stored as a held flight (status **Needs review**) and the aircraft's totals stay unchanged until an administrator reviews it. The reasons are checked in this order: the aircraft changed after the entry was started; the flight predates a counter change; it is backdated or duplicates a time; a meter reading is lower than the current counter.

**Review** in the flight log opens the held entry. The review reason is shown on top, and under it the held entry's readings, landings, cycles and flight time appear beside the aircraft's current totals, one row per field that differs, so the reviewer sees what the reason refers to before deciding. The administrator then accepts the entry (with corrections if needed; totals and later flights are rebuilt) or rejects it (excluded from totals). Both decisions keep the original values and the explanation in the change log. The rules of the review itself are unchanged by this page; see [flight log options](flight-log-options.md).

## When two people change the same record

Every record edited online carries a version. A form saves against the version it loaded; if someone else saved in between, the server refuses the save with one message, "This record was changed by someone else. Review the differences." Nothing is merged and the last writer does not win silently.

The inspection, component, AD, work order and purchase order forms catch that refusal and open a review instead of printing it. The review names who saved the record last and when (from the change log) and lists only the fields on which the two copies differ, yours beside theirs, each marked as changed by you, by them or by both. It offers three choices:

- **Keep mine** saves your form as it stands against the current version. Every field shown takes your value, including a field the other person changed, so their change is replaced; both saves remain in the change log with their reasons.
- **Use theirs** reloads the form from the record as it is now, after confirmation. Your typed changes are dropped.
- **Cancel** returns to the form with your changes still in it, for example to copy a value before deciding.

Other versioned records (task cards, parts requests, saved addresses, flight plans, checklists, settings keys) refuse a stale save with the same message but still show it as text; their forms do not open the review yet.

The demo behaves the same. Two tabs share the demo's stored records, so saving the same inspection from both shows the review in the second tab.
