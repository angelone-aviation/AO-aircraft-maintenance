# Bug hunt, 2026-11-03

Five testers exercised a production build of `main` (commit f2f2a8b, the redesign, speed changes and Settings page) by area: flights and offline sync, maintenance records, inventory and purchasing, accounts and permissions, and cross-cutting interface checks. Every bug below has a script that reproduces it. Each script was run at least twice by its tester and twice more by the reviewer, and its cited code was read to confirm the cause. Nothing was reported that did not reproduce.

| Severity  | Count  |
| --------- | ------ |
| Critical  | 2      |
| High      | 6      |
| Medium    | 10     |
| Low       | 9      |
| **Total** | **27** |

Severity scale: **Critical** means wrong safety data, data loss or a permission leak with no user error involved; **High** means wrong or hidden maintenance data, or lost work; **Medium** means a wrong figure, missing audit trail or blocked workflow; **Low** means cosmetic, documentation or demo-only.

## Status: all 27 fixed (2026-11-03)

All bugs below were fixed on branch `fix/bug-hunt` and merged to `main`. On the merged code, every repro script prints `NOT REPRODUCED`, `npm run check` passes (696 unit tests), and the Playwright suite passes (108 passed, 4 skipped). The scripts stay here as regression checks.

After deploying, run the new post-deploy step `npx convex run counterEvents:recordChanges` (see README "Deployment"); it repairs aircraft totals that a counter change had already corrupted (#35).

Follow-ups noticed while fixing were also resolved (2026-11-03, branch `fix/follow-ups`):

- **Job-card stock picker** now shows usable stock (on hand less reserved) and refuses expired lots, also on the server.
- **Empty Job cards list** shows only the empty state, so no unreachable scrolling region remains (axe clean at all widths).
- **One due-today rule:** usage limits (hours, cycles, landings) are reached at 0 remaining and ground the aircraft; a calendar limit is due soon on its due date and overdue from the next day. Components, inspections and ADs now all follow it (GLOSSARY "Overdue", docs/maintenance-workflows.md).
- **Stale initial AD limits** from compliance recorded before #42 are flagged in the AD register, AD details and AD alerts, with an audited "Clear initial limit" action; nothing is cleared automatically.
- **Groups widened by #34:** run the read-only check `npx convex run groupAudit:findWidenedGroups` after deploying; system administrators also see flagged groups in Administration → Permission groups.
- **#21:** every correction to a completed record requires a reason (including AD edits and the new AD compliance corrections), AD compliance corrections are administrator-only and append-only, and docs/runbooks/database-access.md defines dashboard access with `audit:recordManualEntry` for hand-written audit entries.

## How to reproduce

1. Build and serve the app with the demo enabled:
   ```sh
   VITE_ALLOW_DEMO=true npm run build
   npx vite preview --port 4200 --strictPort --host 127.0.0.1
   ```
2. In another terminal, from this folder, run a script, for example `node repro/mx/mx-1-overview-hides-calendar-overdue.js`.
   - It prints `REPRODUCED: …` and exits with code 1 while the bug exists, and prints `NOT REPRODUCED` and exits 0 once it is fixed. Screenshots go to the area's `shots/` folder, which git ignores.
   - Set `ANGELONE_URL` to test another address. Set `CHROMIUM_PATH` if your Playwright version cannot find its browser.
3. Server-side repros (`repro/acl/*-server.js` and `acl-disabled-admin-not-editable.js`) copy a convex-test file from `repro/acl/server/` into `convex/`, run it with vitest, and remove it again. `repro/acl/server/zz-bughunt-probes.test.ts` holds the cross-role probes that passed.

## Bugs

| Severity | Bug                                                                                                                                         | Area                     | Issue |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ----- |
| Critical | [Editing a permission group whose aircraft was transferred out silently opens it to every aircraft in the program](#acl-1)                  | Accounts and permissions | #34   |
| Critical | [After any aircraft counter change, accepted corrections and accepted held flights never reach aircraft totals](#flight-1)                  | Flights                  | #35   |
| High     | [Overview shows hours remaining for an inspection that is overdue by calendar](#mx-1)                                                       | Maintenance              | #36   |
| High     | [Editing an AD's due limits records no before/after values or reason in Change history](#mx-2)                                              | Maintenance              | #37   |
| High     | [A component exactly at its life limit does not ground the aircraft or trigger the dispatch gate](#mx-4)                                    | Maintenance              | #38   |
| High     | [Switching aircraft in Log a flight keeps the typed ending readings and saves them against the new aircraft](#flight-2)                     | Flights                  | #39   |
| High     | [Expired stock is counted as available in parts requests, hiding the shortage](#inv-1)                                                      | Inventory and purchasing | #40   |
| High     | [Escape in a nested dialog also closes the parent dialog and discards its unsaved form](#ui-1)                                              | Interface                | #41   |
| Medium   | [Recording compliance on a recurring AD keeps its stale one-time initial due date, so it stays Overdue](#mx-3)                              | Maintenance              | #42   |
| Medium   | [Job cards that still carry a required legacy step can never be signed off or completed](#mx-5)                                             | Maintenance              | #43   |
| Medium   | [Accepting a backdated flight records a wrong starting reading in Change history, and the later flight's change is not recorded](#flight-4) | Flights                  | #44   |
| Medium   | [An unscoped (legacy) permission group cannot be assigned to a Flight Program](#acl-2)                                                      | Accounts and permissions | #45   |
| Medium   | [Labor hours are rounded to whole minutes, so labor amounts are wrong](#inv-2)                                                              | Inventory and purchasing | #46   |
| Medium   | [Flight-line oil usage draws down an expired oil lot](#inv-3)                                                                               | Inventory and purchasing | #47   |
| Medium   | [Transferring a storage location carries reserved stock away from the source program's requests](#inv-4)                                    | Inventory and purchasing | #48   |
| Medium   | [Issuing stock through a parts request leaves no entry in the stock item's history](#inv-5)                                                 | Inventory and purchasing | #49   |
| Medium   | [Fields reached with Tab end up hidden behind the sticky Save/Cancel footer in dialog forms](#ui-3)                                         | Interface                | #50   |
| Medium   | [Tabbing down the desktop sidebar hides focused links under the profile footer](#ui-7)                                                      | Interface                | #51   |
| Low      | [The only active system administrator cannot edit or demote an already-disabled administrator](#acl-3)                                      | Accounts and permissions | #52   |
| Low      | [A disabled administrator is labelled "Administrator" instead of "Disabled"](#acl-4)                                                        | Accounts and permissions | #53   |
| Low      | [Demo only: "Renew demo access" does not stick after the next change](#flight-3)                                                            | Flights                  | #54   |
| Low      | [A request still says "Received / awaiting issue" after all received parts were issued](#inv-6)                                             | Inventory and purchasing | #55   |
| Low      | [Attachment size limit is 7 MB but the docs promise 10 MB](#inv-7)                                                                          | Inventory and purchasing | #56   |
| Low      | [A light frame flashes on reload when dark theme is saved](#ui-2)                                                                           | Interface                | #57   |
| Low      | [The Job cards screen (/task-cards) cannot be reached from the navigation](#ui-4)                                                           | Interface                | #58   |
| Low      | [The All sections sheet reopens by itself after rotating to desktop width and back](#ui-5)                                                  | Interface                | #59   |
| Low      | [Sidebar focus ring is clipped, and low contrast in light theme](#ui-6)                                                                     | Interface                | #60   |

### acl-1

**Critical: Editing a permission group whose aircraft was transferred out silently opens it to every aircraft in the program** (#34)

Steps:

1. Flight Programs: add a second program.
2. Administration → Permission groups: add group "N206 crew" in Mission operations with only N206MA checked and flight permission.
3. Give Jordan Lee only that group.
4. Flight Programs → Transfer: move N206MA to the second program.
5. Edit group "N206 crew", change only its name, save.

- **Expected:** The group keeps its restriction; Jordan still has no Mission operations aircraft.
- **Actual:** The group list changes from "1 aircraft" to "All program aircraft". Jordan now sees N208MA and N182MA and can log flights on them. The form gives no warning.
- **Repro:** `repro/acl/acl-group-widens-after-transfer.js`
- **Cause:** `src/components/PermissionGroupForm.tsx:33` rebuilds `aircraftIds` only from checkboxes, and `:88` lists only aircraft still in the program, so the transferred id is dropped. An empty list means all program aircraft (`src/domain/programs.ts:13`). `transferProgram` (`src/domain/programTransfers.ts:41`) leaves groups untouched, and `convex/admin.ts` accepts the widened empty list. Affects the server and the demo.

### flight-1

**Critical: After any aircraft counter change, accepted corrections and accepted held flights never reach aircraft totals** (#35)

Steps:

1. Log a flight for N206MA ending at Hobbs 2342.2 with 1 landing.
2. Aircraft → edit N206MA → enable Flight time log (100) → save. This records a counter event.
3. Flight log → Correct that flight: ending Hobbs 2342.6, 3 landings, accept and recalculate.

- **Expected:** Totals show Hobbs 2342.6 and 2,197 landings, or the review is refused as an inconsistent chronology.
- **Actual:** The flight shows Accepted with the new values, but totals stay at Hobbs 2342.2 and 2,195 landings; total time and inspection remaining are unchanged. An accepted flight held for predating the counter change is likewise never added, and rejecting such a flight leaves it in the totals.
- **Repro:** `repro/flight/bug1-correction-lost-after-counter-event.js (also flight/bug1b-accepted-held-flight-ignored.js)`
- **Cause:** `rebuildFlights` (`src/domain/flights.ts:125-129`) replays each counter event as an absolute snapshot (`current = { ...current, ...readings }`), overwriting the effect of earlier flights; `counterEvents: []` at `:109` disables the predates check during rebuild. The Convex review path calls the same function (`convex/operations.ts:689`), so the live backend is affected by the same code; reproduced in the demo.

### mx-1

**High: Overview shows hours remaining for an inspection that is overdue by calendar** (#36)

Steps:

1. Inspections → New inspection on N182MA tracking Hours (every 100, last 1600) and Calendar (every 12 months, last complied 13 months ago).
2. Open Overview.

- **Expected:** Overview shows the inspection overdue by date, as the Inspections list does.
- **Actual:** The Inspections list says "days overdue · Overdue". The N182MA card (marked Grounded) says "49.6 h remaining · Due 1,700.0 h" and the maintenance outlook shows "49.6 h".
- **Repro:** `repro/mx/mx-1-overview-hides-calendar-overdue.js`
- **Cause:** `nextDue` and `dueShort` in `src/components/Dashboard.tsx` (around lines 164 and 230) always prefer the hours dimension when it exists, ignoring which limit drives the status.

### mx-2

**High: Editing an AD's due limits records no before/after values or reason in Change history** (#37)

Steps:

1. Airworthiness directives → Add AD, applicable, one-time action due at 2300 h (shows Overdue).
2. Review / edit AD: change next due hours to 3000, save (Overdue clears).
3. Open Change history.

- **Expected:** The edit appears with before and after values and a reason (Glossary: audit entry).
- **Actual:** Two bare "Ad · save" rows with no recorded values. An overdue AD can be made not overdue with no trace.
- **Repro:** `repro/mx/mx-2-ad-edit-no-audit.js`
- **Cause:** Server `convex/airworthiness.ts:51-62` stores only `{number, version, applicability}` as after; the demo `src/data/store.ts:893` stores nothing. Related to issue #21 (audit-log decisions).

### mx-4

**High: A component exactly at its life limit does not ground the aircraft or trigger the dispatch gate** (#38)

Steps:

1. Install a propeller on N206MA at 110.0 h TSN with a 110 h TSN life limit.
2. Open Overview, Alerts and Log flight for N206MA.

- **Expected:** Treated like an inspection at 0 h remaining: aircraft Grounded and flight logging needs an override.
- **Actual:** Alerts says "Action required · Component due now" and Planning/Owner portal say overdue, but the N206MA card says "Due soon" and Log flight asks for no override. An inspection at 0 h grounds N208MA.
- **Repro:** `repro/mx/mx-4-component-at-limit-not-grounded.js`
- **Cause:** `src/domain/aircraftStatus.ts:86` maps component "Due now" (exactly 0 remaining, `src/domain/components.ts:340`) to due-soon, which also feeds the dispatch gate; `alerts.ts:183`, `ownerDue.ts:79` and `forecast.ts` treat it as past due.

### flight-2

**High: Switching aircraft in Log a flight keeps the typed ending readings and saves them against the new aircraft** (#39)

Steps:

1. Log a completed flight with N206MA; type Ending Hobbs 2342.2 and Ending tach 2262.0.
2. Change Aircraft to N182MA (starting Hobbs 1650.4).
3. Save flight.

- **Expected:** Ending readings reset (docs/flight-log-options.md: switching aircraft resets aircraft-specific inputs).
- **Actual:** Both values stay, the strip shows "691.8 h" and the flight is saved as Accepted; N182MA's total jumps to 2,342.2 h.
- **Repro:** `repro/flight/bug2-ending-readings-carry-over-on-aircraft-switch.js`
- **Cause:** The aircraft select's `onChange` in `src/components/FlightForm.tsx` (around line 320) only resets fluids; the ending inputs are uncontrolled and not keyed by aircraft.

### inv-1

**High: Expired stock is counted as available in parts requests, hiding the shortage** (#40)

Steps:

1. Stock SEAL-EXP: quantity 5, expired 2 days ago.
2. Parts / repair requests → New request for 3 of it; open the request.
3. Try to reserve 3.

- **Expected:** Available 0, Shortage 3.
- **Actual:** "Available: 5 · Shortage: 0"; reserving then fails with "Expired stock cannot be issued or reserved."
- **Repro:** `repro/inv/bug-expired-available.js`
- **Cause:** `StockAvailability` in `src/components/PartsRequests.tsx` (around 1146-1152) filters only by part number and condition; `partsInventory` in `src/domain/requiredParts.ts` carries no expiry.

### ui-1

**High: Escape in a nested dialog also closes the parent dialog and discards its unsaved form** (#41)

Steps:

1. Purchase orders → New PO; fill vendor and a part number.
2. Add new address (second dialog opens).
3. Press Escape.

- **Expected:** Only the address dialog closes.
- **Actual:** Both close and the PO draft is lost. Same for nested confirms in work orders, task cards, parts requests, logbook entry, manuals and My certifications inside the More sheet.
- **Repro:** `repro/ui/repro-ui-1-nested-escape.js`
- **Cause:** `Dialog`'s `onCancel` in `src/components/design.tsx` (around line 793) does not check `e.target === e.currentTarget`; React propagates `cancel` through portals to every ancestor dialog. Introduced with the redesign's shared Dialog.

### mx-3

**Medium: Recording compliance on a recurring AD keeps its stale one-time initial due date, so it stays Overdue** (#42)

Steps:

1. Add AD, applicable, recurring action: initial due date yesterday, hours due 2400 repeating every 100.
2. Record compliance at 2341.2 h.

- **Expected:** Next due 2441.2 h and status Scheduled (docs/airworthiness.md: repeating thresholds advance from completion).
- **Actual:** Hours advance to 2441.2 but the initial date stays; the AD stays Overdue and N206MA stays Grounded.
- **Repro:** `repro/mx/mx-3-ad-compliance-keeps-stale-date.js`
- **Cause:** `src/domain/airworthiness.ts:392-401` rewrites `dueDate` only when `intervalDays` is set; a one-time initial date is never cleared on compliance.

### mx-5

**Medium: Job cards that still carry a required legacy step can never be signed off or completed** (#43)

Steps:

1. Open an in-progress job card stored with a step marked signoffRequired (data created before steps were retired).

- **Expected:** Technician signoff works; docs/task-cards.md:9 says previous step data is no longer a signoff prerequisite.
- **Actual:** Technician signoff is disabled with "Sign off required steps first", no step-signoff control exists, and saving as Completed is refused.
- **Repro:** `repro/mx/mx-5-legacy-step-blocks-signoff.js`
- **Cause:** `src/domain/taskCards.ts:438` and `:630` still enforce `stepSignoffIssue`; `src/components/TaskCards.tsx:1517` disables the button. Affects only records created before steps were retired.

### flight-4

**Medium: Accepting a backdated flight records a wrong starting reading in Change history, and the later flight's change is not recorded** (#44)

Steps:

1. Log flight LATER (1 h ago) ending at Hobbs 2342.2.
2. Log flight EARLIER (3 h ago) ending at 2341.7; it needs review.
3. Accept EARLIER; open Change history → Flight · reviewed.

- **Expected:** After shows start 2341.2 / end 2341.7, and LATER's start change 2341.2 → 2341.7 is recorded.
- **Actual:** After shows hobbsOff 2342.2 with hobbsOn 2341.7 (ends before it starts); LATER's start is rewritten with no entry.
- **Repro:** `repro/flight/bug4-review-audit-wrong-starting-reading.js`
- **Cause:** `src/data/store.ts` (around 1352-1372) and `convex/operations.ts:738` audit the pre-rebuild object; flights changed by the rebuild are not audited.

### acl-2

**Medium: An unscoped (legacy) permission group cannot be assigned to a Flight Program** (#45)

Steps:

1. Have a permission group with no program (pre-program data).
2. Choose Unassigned records; edit the group and set Flight Program to Mission operations; save.

- **Expected:** The group is assigned (docs/flight-program-access.md step 5).
- **Actual:** "A permission group cannot be moved to another Flight Program." It also cannot be saved without a program, so it can only be deleted.
- **Repro:** `repro/acl/acl-unscoped-group-cannot-be-assigned.js (server: acl/acl-unscoped-group-server.js)`
- **Cause:** `convex/admin.ts:314` treats undefined → program as a move; the demo mirror does the same.
- **Retired (2026-11-04, Batch 414):** production started with no data, so no unscoped group can exist (T21, `docs/architecture/t21-inventory.md`). The assignment path was removed from the server and the demo, and the refusal above is now the intended behaviour. Both repro scripts report "REPRODUCED" by design; leave them out of repro runs.

### inv-2

**Medium: Labor hours are rounded to whole minutes, so labor amounts are wrong** (#46)

Steps:

1. Work order → Costs: Hours 1.33, Rate 100, Add labor.
2. Costs → Export CSV.

- **Expected:** $133.00.
- **Actual:** $133.33 on the work order and Costs; CSV labor hours 1.3333333333333333.
- **Repro:** `repro/inv/bug-labor-rounding.js`
- **Cause:** `parseLaborHours` stores `Math.round(hours * 60)` minutes (`src/domain/costs.ts:125`); `laborCents` (`:148`) computes from minutes.

### inv-3

**Medium: Flight-line oil usage draws down an expired oil lot** (#47)

Steps:

1. Oil-marked stock OIL-15W50, quantity 5, expired 30 days ago (Issue stock refuses it).
2. Log a flight adding 1 unit of oil from that lot.

- **Expected:** Refused or at least flagged.
- **Actual:** The flight saves and stock drops from 5 to 4 with a stock.oil_used entry; the picker shows no warning.
- **Repro:** `repro/inv/bug-expired-oil.js`
- **Cause:** `oilInventoryDeductions` (`src/domain/oilInventory.ts`) never calls `assertNotExpired`; the server uses the same function.

### inv-4

**Medium: Transferring a storage location carries reserved stock away from the source program's requests** (#48)

Steps:

1. FILTER-1 quantity 5; PR-00001 reserves 3.
2. Flight Programs → Transfer "Main hangar" location to a second program.

- **Expected:** Refused while stock is reserved, like aircraft transfers with open requests.
- **Actual:** Transfer succeeds; the source request shows Reserved 3 but cannot release or issue; the destination shows Reserved 3 and cannot adjust below it.
- **Repro:** `repro/inv/bug-location-transfer-reservation.js`
- **Cause:** The location branch of `src/domain/programTransfers.ts` (around 79-90) checks only components, not parts-request reservations or open PO lines.

### inv-5

**Medium: Issuing stock through a parts request leaves no entry in the stock item's history** (#49)

Steps:

1. FILTER-1 at 5; Move stock → Receive 1 (6).
2. A parts request reserves and issues 2.
3. FILTER-1 → Details → Record history.

- **Expected:** The issue appears ("Quantity changes are saved in history").
- **Actual:** Quantity shows 4 but history ends at 6 with only stock.move.receive.
- **Repro:** `repro/inv/bug-stock-history-missing-issue.js`
- **Cause:** `applyRequestCommand` changes stock directly (`src/domain/partsRequests.ts:546`, `:561`) and audits only the request (`:590`); same on the server.

### ui-3

**Medium: Fields reached with Tab end up hidden behind the sticky Save/Cancel footer in dialog forms** (#50)

Steps:

1. Open Log a flight at 320×640 (or New PO at 1280×800) and Tab through fields.

- **Expected:** The focused field is visible.
- **Actual:** Landings, fuel and oil fields (phone) and part fields (desktop New PO) scroll fully under the footer.
- **Repro:** `repro/ui/repro-ui-3-footer-hides-focus.js`
- **Cause:** Sticky footers (`src/styles.css` around 1430, `src/styles/screens/flight.css` around 49) without `scroll-padding-bottom` on `.ds-dialog-body` (`src/styles/design.css`).

### ui-7

**Medium: Tabbing down the desktop sidebar hides focused links under the profile footer** (#51)

Steps:

1. At 1280×800, Tab down the sidebar.

- **Expected:** Each focused link is visible.
- **Actual:** Components, Scan label, Sync center and Change history are fully covered by the profile footer when focused.
- **Repro:** `repro/ui/repro-ui-7-sidebar-profile-hides-focus.js`
- **Cause:** Sticky profile footer inside the scrolling `.sidebar` (`src/styles.css`, around 147 and 350) with no scroll padding.

### acl-3

**Low: The only active system administrator cannot edit or demote an already-disabled administrator** (#52)

Steps:

1. Admin X active, admin Y disabled.
2. As X, edit Y: uncheck Global administrator (or rename), save.

- **Expected:** Saved; X remains the last active admin either way.
- **Actual:** "Keep at least one active administrator."
- **Repro:** `repro/acl/acl-disabled-admin-not-editable.js (server test)`
- **Cause:** `convex/admin.ts:194` checks `before.isAdmin` but not `before.active`.

### acl-4

**Low: A disabled administrator is labelled "Administrator" instead of "Disabled"** (#53)

Steps:

1. Administration → add a global administrator → Edit access → uncheck Account active → save.

- **Expected:** Badge says Disabled.
- **Actual:** Badge says Administrator (neutral colour).
- **Repro:** `repro/acl/acl-disabled-admin-shown-active.js`
- **Cause:** `src/components/Admin.tsx:139` checks `isAdmin` before `active`.

### flight-3

**Low: Demo only: "Renew demo access" does not stick after the next change** (#54)

Steps:

1. Age the demo snapshot past 7 days; reload; click Renew demo access.
2. Log a flight.

- **Expected:** Access stays renewed.
- **Actual:** "Time to reconnect." returns immediately.
- **Repro:** `repro/flight/bug3-renew-demo-access-reexpires.js`
- **Cause:** `src/main.tsx` (around 285) renews only the scoped snapshot; demo changes rebuild it from `demo:all`, which keeps the old time (`src/data/store.ts` around 441).

### inv-6

**Low: A request still says "Received / awaiting issue" after all received parts were issued** (#55)

Steps:

1. PR for 4 on an issued PO; receive 2 (auto-reserved); issue those 2.

- **Expected:** Partially issued.
- **Actual:** Received / awaiting issue; missing from the Partially issued filter.
- **Repro:** `repro/inv/bug-request-status-awaiting-issue.js`
- **Cause:** `requestStatus` checks received before issued and ignores reservations (`src/domain/partsRequests.ts:302`).

### inv-7

**Low: Attachment size limit is 7 MB but the docs promise 10 MB** (#56)

Steps:

1. Inventory item → Details → upload an 8 MB PDF.

- **Expected:** Accepted (docs/inventory-attachments.md:5, docs/purchase-orders.md:15).
- **Actual:** "Attachments must be between 1 byte and 7 MB."
- **Repro:** `repro/inv/bug-attachment-limit.js`
- **Cause:** `MAX_ACTION_FILE_BYTES = 7 * 1024 * 1024` (`src/domain/inventoryAttachments.ts:5`). Fix the docs or the limit.

### ui-2

**Low: A light frame flashes on reload when dark theme is saved** (#57)

Steps:

1. Switch to dark theme; reload (CPU throttled).

- **Expected:** Dark from the first frame.
- **Actual:** Light background for about 130–180 ms before dark applies.
- **Repro:** `repro/ui/repro-ui-2-theme-flash.js`
- **Cause:** The theme is applied by `initTheme()` in `src/main.tsx` after the module graph loads; `index.html` has no early theme script.

### ui-4

**Low: The Job cards screen (/task-cards) cannot be reached from the navigation** (#58)

Steps:

1. Look through the sidebar, rail, tab bar, More sheet and their pages.

- **Expected:** A way in; docs/task-cards.md describes Task cards → New task card.
- **Actual:** No entry or link (only a conditional link on a parts request). Predates the redesign.
- **Repro:** `repro/ui/repro-ui-4-task-cards-orphaned.js`
- **Cause:** No entry in `useNavigation()` (`src/components/AppShell.tsx`).

### ui-5

**Low: The All sections sheet reopens by itself after rotating to desktop width and back** (#59)

Steps:

1. At 1024×1366 open All sections; rotate to 1366×1024; go to Vendors; rotate back.

- **Expected:** Sheet stays closed.
- **Actual:** It pops open on /vendors.
- **Repro:** `repro/ui/repro-ui-5-sheet-reopens.js`
- **Cause:** `src/components/AppShell.tsx` hides the sheet with `more && breakpoint !== "desktop"` but never resets `more`.

### ui-6

**Low: Sidebar focus ring is clipped, and low contrast in light theme** (#60)

Steps:

1. Light theme, 1280×800, Tab onto sidebar links.

- **Expected:** Full ring with at least 3:1 contrast (WCAG 1.4.11).
- **Actual:** Sides of the ring are cut off; remaining ring is 2.42:1 on the navy sidebar.
- **Repro:** `repro/ui/repro-ui-6-sidebar-focus-ring.js`
- **Cause:** `.nav-group-items > div { overflow: hidden }` in `src/styles.css` (for the collapse animation) clips the outline; ring colour from the global focus style.

## What was tested and works

- **Flights:** every meter variant (Hobbs/tach, turbine starts and cycles, sea/land, helicopter collective hourmeter, flight time log), boundary values, the live flight-time strip, totals after flights, corrections and rejections without counter events, conflict holds, offline queueing across reloads, Sync center counts, the 7-day expiry, Start/End flight sessions, discrepancies from the flight form, oil inventory deduction, and time zones including a daylight-saving fold.
- **Maintenance:** inspection limits and due-soon thresholds, end-of-month calendar dues, cross-screen agreement for combined limits, AD create/review/not-applicable/recurring hours compliance, append-only compliance history, the independent-inspector rule, work-order close-out validation and revisions, MEL deferral expiry and the dispatch gate (by code review).
- **Inventory and purchasing:** shelf-life badges and filters at date edges, issue refusing expired lots, purchase-order totals across editor/list/PDF, multi-vendor split, partial and full receipt, core returns, request reserve/issue and repair round trip, parts costs on work orders, Scan label manual lookup.
- **Accounts and permissions:** server probes rejecting pilots, owners, restricted and other-program users across user/group admin, settings, transfers and integrations; per-role snapshots; aircraft transfer visibility; the Settings page by role; program-admin Administration; owner portal preview.
- **Interface:** no horizontal overflow on 28 routes at four widths; phone tab bar never hides the last control; dialog focus in and out; keyboard sidebar groups, switches and segmented controls; axe-core serious/critical checks clean in light and dark; offline reload of all routes; PDF tools cached on first use; update prompt; reduced motion; performance on a throttled phone (dashboard 1.5 s after sign-in).

## Observations not confirmed as bugs

These were noticed but not reproduced as defects against documented behaviour, so they are not counted above:

- The MEL expiry clock starts on the deferral date, not the discovery date, although a code comment says "excluding the day of discovery".
- `adStatus` ranks "Counter unavailable" above "Overdue", so an AD with one overdue action can show as counter unavailable.
- On the Overview card, schedules with the same status are picked by list order, not by least remaining.
- After an aircraft transfer, closed parts requests stay tagged to the old program and may drop out of both programs' cost totals.
- Expired-stock refusal uses the latest calendar date anywhere in the world, so in western time zones a lot is refused on its expiry day while its badge still says "Expires soon".
- A purchase order's "Total ordered" still includes cancelled quantities; a $0 budget shows "(0%)" while over budget.
