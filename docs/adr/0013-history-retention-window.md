---
status: accepted; implemented 2026-11-20 (stage S7 turned the window on; H5 revised the same day, option A)
date: 2026-11-19
---

# The workspace keeps a retention window and pages older history

One reactive query (`operations.snapshot`) sends a Flight Program's whole history to every device: every flight, problem report, work order, job card and cost record of every aircraft. The size test of the 10 Nov bug hunt (SZ-1) found that the workspace stops loading after about two fleet-years at the model's flying rate, and that the work order and job card saves, which load the same history, fail from about five. The size fixes cut what owners and board members read; the limit stands for administrators and pilots. Measured with convex-test, an administrator's snapshot reads 7.1 MiB at one fleet-year and 16.7 MiB at three, past Convex's 16 MiB per-function limit ([history paging](../history-paging.md)).

The records themselves must be kept for the life of the aircraft (14 CFR 91.417(b)(2)), so nothing is deleted. The decision is where older history lives and how it reaches a screen.

## Decision

- **The workspace keeps a retention window**, defined once in `src/domain/retention.ts`:
  - open items however old: held flights, open and deferred problem reports, open work orders and any order with an open job card;
  - closed history changed in the last 90 days, and flights from the last six months;
  - the five latest completed work orders on each aircraft, which the owner portal lists;
  - templates, budgets and the labor rate;
  - job cards, archived job cards and work-order costs with their work order;
  - since H5's revision (option A, 20 Nov 2026), of parts requests, purchase orders and flight plans: open requests and orders (an order with a repair out or a core owed is open), plans departing within the six months of flights or later, anything changed or filed in the last 90 days, requests a kept work order counts with every order allocating them, the requests a draft or issued order allocates, and recurring request lists always.

  Inspections, ADs, management records, checklists and templates stay complete. The change log keeps its 250 rows and its existing paging. The cutoff is rounded down to the start of the UTC day, so the window is never shorter than its days and a record crossing the boundary is at worst in both the workspace and a history page, never in neither.

- **Older history loads page by page** through paged queries (`convex/history.ts`): flights, problem reports and work orders, since H5's revision parts requests, purchase orders and flight plans too, plus one work order with everything on it, records by uuid, flights in a date range and a cost report. Each checks the Flight Program first and pages only aircraft the caller may read, and its rows pass through `scopedSnapshot`, so redaction matches the workspace exactly. Owners and board members need no paging. Five screens get "Showing the last 3 months · Load older".
- **Saves load only what they touch:** the record, its work order's job cards, templates, open problem reports and what it references by uuid. Record numbers come from a `recordNumbers` table and totals from a `costLedger` table, both keyed by aircraft so they move with transfers. These derived rows are not records, so the change log stays append-only; a nightly reconcile checks the ledger.
- **One rule pages everything.** `historyPage` returns what the window leaves out, newest first with a uuid tie-break, from a cursor that survives newer records arriving. The demo pages its fictional data with it, and the server's paged queries are tested against it.
- **Offline,** a device keeps the windowed workspace, which is all a pilot needs to log flights. "Load older" needs a connection.

Aaron's answers (19 Nov 2026) set the details:

| No. | Answer                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| H1  | A three-month window, with flights kept six months.                                                                                                                                                                |
| H2  | The server filters the flight log by aircraft and status; text search covers the loaded rows, with a label saying so.                                                                                              |
| H3  | The Discrepancies total is relabelled "in the last 3 months".                                                                                                                                                      |
| H4  | The records package always pages full history; one made offline is marked partial.                                                                                                                                 |
| H5  | Parts requests, purchase orders and flight plans stay complete for now, with a size-guard test. Revised 20 Nov 2026 to option A: closed ones leave the workspace like other history, with Load older for the rest. |
| H6  | The Weekly summary's fix is part of the bounded saves.                                                                                                                                                             |
| H7  | D2 keeps detect-and-alert, plus a limit on how much one member can have open at once, since open items are always kept.                                                                                            |

The work is staged S0 to S9 in the history-paging plan; the window is turned on only after the bounded saves, the ledger and every screen's paging are in.

## Consequences

- What the workspace reads of the windowed history stops growing with history. The target was a 20-year snapshot within 10% of year 1, with four times headroom on every Convex limit; `convex/historyCost.test.ts` holds the baseline and flipped stage by stage. Since S7 the window's reads are flat. The load test at 20 fleet-years (S8) measured the administrator's snapshot at 7.47 MiB read in year 1 and 0.85 MiB more a year, refused past 16 MiB at about 11 years; about 85% of the growth came from the parts requests, purchase orders and flight plans H5 then kept complete, the rest from the ADs' compliance history and component movements, which also grow the owner's and board's views. H5's revision windows the first three: at the size test's volume every view now reads the same at one, two and three fleet-years (the administrator's 7.94 MiB, against 7.98 to 9.33 before). What still grows is the AD and component history this decision keeps complete, about 0.1 MB a year, and a repair or restock settled by its order's receipt, which its own record cannot show, so the snapshot reads it and its orders for good. The 4 MiB headroom target is missed from year 1 either way ([history paging](../history-paging.md#the-purchasing-window-h5)).
- 42 lookups by uuid, in 24 files, need work before the window is turned on: a record outside it must be loaded on demand, or the command refused. They are listed in [history paging](../history-paging.md), with what each should do. A screen that silently showed nothing would be the failure mode. H5's revision added its own: an order's allocated requests, a request's order, a vendor's orders, and a record's request list, each loaded on demand or answered on the server.
- A purchase order's allocations live in its lines, so a derived table finds a request's orders: the `allocation` keys of `purchasingKeys`, which also serve the bounded purchasing saves (one table, not two: H5's window and its saves first added one each). Like `recordNumbers` it is filled by the backfill and never written to the change log.
- Lists, counts and text search on the five screens cover the loaded rows, with labels saying so (H2, H3). The Job cards screen also loses older cards and needs the same treatment.
- No record carries one "changed at" time, so "changed in the window" is read from the dated events each record holds: close-outs, revisions, corrections, removed items, job card and cost entry times. A part's unit cost carries no time, so changing one does not keep an older work order in the workspace.
- A device offline holds six months of flights and three months of closed maintenance. An offline records package is marked partial (H4).
- `recordNumbers` and `costLedger` must be rebuilt after a backup is restored, before the reconcile shows no differences.
- Open items stay in the workspace however many there are; H7's limit per member is what bounds them.
- More moving parts: paged queries, their `Backend` methods in both adapters, the demo's paging, and browser tests with aged records, since the demo's records are all dated now.

## Considered options

- **Keep the full snapshot:** the simplest, and every record is offline. Rejected: it fails at about 2.2 fleet-years at the model's flying rate, and earlier on the one-second limit under load, so a busy program has months, not years.
- **Raise the limits:** the 16 MiB read and one-second limits are Convex's per-function limits, which a deployment does not set. Splitting the snapshot across several queries multiplies the runway by the number of queries, but each still grows with history, and the saves that load history fail regardless. Rejected.
- **Page on the client only:** keep loading full history and page it in the browser. Rejected: it cuts rendering, not what the query reads or sends, and the read is the limit.
- **Move old records to archive tables:** bounds the live tables, but moves FAA records between tables, which transfers, backups, the change log and every lookup would have to follow. A window over the same tables bounds the reads without moving a record.
