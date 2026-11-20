# Bug hunt, 2026-11-10

The second bug hunt found 132 defects and no Critical one. Every one now has an outcome: 111 are fixed and merged on `main`, 19 are open questions that Aaron is reviewing, 1 is not done and 1 was not a bug.

The status columns were updated on 2026-11-20 for the fixes and decisions merged into `release/combined`. The counts, the verification and the "Repro re-run" results are still those of 2026-11-10.

Fourteen of the 132 repeat another finding from a second angle, so there are about 118 distinct defects. UI-13 was found by the interface testing as a repro script only and written up after the fixes. Each table below says "same as" where two ids describe one defect. The stale-screen audit's 59 items and the one bug found in the clean-up round are counted separately.

| Severity  | Found   | Fixed   | Decision | Not a bug | Not done |
| --------- | ------- | ------- | -------- | --------- | -------- |
| Critical  | 0       | 0       | 0        | 0         | 0        |
| High      | 21      | 19      | 2        | 0         | 0        |
| Medium    | 61      | 50      | 11       | 0         | 0        |
| Low       | 41      | 36      | 4        | 0         | 1        |
| Info      | 9       | 6       | 2        | 1         | 0        |
| **Total** | **132** | **111** | **19**   | **1**     | **1**    |

Severity scale, as on 3 Nov: **Critical** means wrong safety data, data loss or a permission leak with no user error involved. **High** means wrong or hidden maintenance data, lost work, an authorization gap on an unusual path, or a missing audit entry on a record change. **Medium** means a wrong figure outside safety data, a broken secondary flow or a limited security weakness. **Low** means cosmetic, wording or minor accessibility. **Info** means an observation, a hardening idea or a test gap.

How the statuses are counted:

- **Fixed** items are on `main`. Each code fix has a regression test that failed before it; AC-7 changed a document only.
- **Fixed in part** is counted as Fixed: AC-5, AC-11, NA-19, SE-8, SE-15 and UI-11. Each open part is listed under [Decisions for Aaron](#decisions-for-aaron) or in the to-do list.
- **SZ-1** is counted as a Decision. Its fixes cut the cost of loading the workspace, but the size limit still stands.
- **Not done:** UI-12, the quantity and cost fields in purchasing. It needs a change to those inputs of its own.

## Verification

All nine fix batches, the three clean-up branches and the NB-15 follow-up, `d620018`, are merged on `main`. Nothing is pushed yet.

| Check                     | Result on `main`                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `npm run check`           | Passed: 3,978 tests in 371 files, with typecheck, lint and build, on the final code |
| `npm run check:standards` | All clear: 370 files                                                                |
| `npm run test:e2e`        | Passed: 167 tests, 4 skipped. The 4 need a real local backend, as before            |
| `npm run test:backup`     | Passed                                                                              |
| Secret scan               | No leaks found                                                                      |
| `npm audit --omit=dev`    | 0 vulnerabilities                                                                   |
| Every repro script re-run | 132 findings: see the table below                                                   |

The repros were re-run on `main` at `883bd34`. UI-1, UI-2, UI-5, UI-6, UI-13 and NB-15 were checked again on the final code.

| Repro result                                                      | Findings |
| ----------------------------------------------------------------- | -------- |
| NOT REPRODUCED                                                    | 84       |
| REPRODUCED, expected: open decision or not done                   | 15       |
| REPRODUCED, by design                                             | 8        |
| ERROR: the script could not reach its own check after a later fix | 9        |
| Not re-run: SZ-1 and SZ-2                                         | 2        |
| No repro script                                                   | 13       |
| UI-13: re-run with its fix, NOT REPRODUCED                        | 1        |
| **Total**                                                         | **132**  |

- **NOT REPRODUCED** includes AC-12 and NA-20, which other scripts exercise. Four scripts were adjusted as their fix reports describe: a real push host for three push scripts, real JPEG bytes for NA-4, a file-storage listing for OP-1 and the agreed expectation for PT-7. The adjusted copies are in `repro-adjusted/<area>/`.
- **UI-5** was checked by a search of every user-facing text. Its script timed out because Settings moved the text it looks for, and no "reminder" or "notification" wording is left.
- **ERROR** means a later fix changed what the script drives, so it stopped before its own check. Each note says what a diagnostic run then showed. In every case but SE-5, the diagnostic showed the bug gone or, for AC-10, the open decision.
- **SE-5** is untested: its fake PDF bytes are now refused by the NA-20 check, so the upload rate limit it asks about was never reached.
- **SZ-1 and SZ-2** were not re-run. The size test needs its generated data and a local backend. SZ-1 is still expected to reproduce at three years; SZ-2 was verified by unit and render tests only.

## What was tested and how

Ten areas were tested in parallel on `main` at `73e51a9`. Every finding was reproduced or traced in code: 126 are confirmed by a running repro and 6 are rated likely. The six likely ones rest on reading code, or need GitHub Actions or an outside host, which the rules excluded.

All of the testing was local. Nothing touched production, a Convex cloud deployment or an outside service.

- **Demo build:** a production build with production security headers and the demo allowed, served on port 4400. Browser scripts drove it with Playwright.
- **Server tests:** convex-test runs the real Convex functions and schema in memory. Anything about permissions, audit entries or server validation was proven this way, not only in the demo.
- **Local backend:** a real local Convex backend was used for the backup and restore round trip, live sessions and tokens, storage links, the SE-13 lockout and the size test.
- **Size test:** one to twenty years of realistic records loaded into a local backend, measured against Convex's per-function limits.

| Area                                                | Ids | What was covered                                                                                                                                                       |
| --------------------------------------------------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Flights and offline                                 | FL  | Offline legs and the Sync center, Edit and retry, the stale-save review on five forms, the seven-day window, the service worker, logbook import                        |
| Maintenance                                         | MX  | Due rules for inspections, ADs and components, eight aircraft states compared across every screen, the status sheet, close-out, logbook wording, inspection completion |
| Inventory and purchasing                            | PT  | Purchase orders from draft to receipt, parts requests, transfers against open orders, the PO PDF, stock moves, label scanning                                          |
| Access and isolation                                | AC  | 106 public functions for 8 roles, cross-program isolation with 175 cases per attacker role, history integrity, owner portal and board view fields                      |
| Setup, records package, paper check, logbook photos | NA  | About 35 CSV cases, 20 adversarial setup plans, offline packages, month and time-zone edges, the photo queue                                                           |
| Alerts, expiring dates, Weekly summary              | NB  | Bell against digest against urgent email at seven dates, real push messages to the built service worker, the email cap, scheduled jobs run twice                       |
| Security                                            | SE  | New public functions since 4 Nov, sessions and tokens on a live backend, storage links, hostile import files, demo mode in a production build                          |
| Interface                                           | UI  | 31 routes at 3 sizes in both themes, axe checks, 49 dialogs, keyboard paths, long and right-to-left text, number entry                                                 |
| Operations                                          | OP  | A real backup and restore, the nightly job, the release workflows by reading, 72 documents checked for links, times and limits                                         |
| Size                                                | SZ  | Workspace load and eight other operations at 1, 2, 3, 5, 8, 10, 15 and 20 years of records                                                                             |

A separate stale-screen audit checked Settings and the other screens for out-of-date text, structure, naming and phone layouts, role by role. Its results are under [Stale-screen audit](#stale-screen-audit).

## What held up

- **Isolation between Flight Programs:** a program administrator, a technician, a pilot and an administrator who was also an observer each attacked a second, fully populated program. Across 175 cases per role, nothing was read, written or linked. The existing isolation suite passed all 324 cases, and both probes pass again on the fixed code.
- **Backup and restore:** a real export with files, a change to the data, then a full import gave back identical tables and byte-identical files. Sign-in, the workspace and every stored file link worked after the restore.
- **Roles:** no role got past a permission it lacks in any of the 106 public functions. Anonymous and disabled callers were refused everywhere. Owners and board members were refused every program call except their own view.
- **Sessions:** after sign-out, a password reset or disabling an account, the old token was refused at once. A removed member's live data emptied within about 100 ms. Demo mode could not be reached in a production build.
- **History:** the audit table has one insert and no update or delete anywhere. Signers, reviewers and recorders are always taken from the session, never from the client.
- **The 3 Nov fixes:** the flight and inventory repros from 3 Nov were re-run and none reproduces. The RM-66 suites pass, and nested Escape and footer focus held.
- **Screens agree:** for eight aircraft states, every screen and the dispatch gate showed the same level and reason. The status sheet was the exception, and MX-6 to MX-8 fix it.
- **Inputs and output:** email and CSV output is escaped, ZIP paths cannot leave their folder, and the CSV and file importers resisted hostile files apart from SE-11 and SE-14.

## Findings by area

Each table lists every finding in the area by severity. The full steps, expected and actual results for each id are in `findings/<area>.jsonl` in this folder. The "Repro re-run" column records each script's result on the fixed code, as summarised under [Verification](#verification).

### Flights and offline

| ID    | Severity | Finding                                                                   | Status                          | Repro re-run                                                                        |
| ----- | -------- | ------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------- |
| FL-3  | High     | Stale save on an AD: Keep mine puts back an old next-due limit            | Fixed `e60f2b6`                 | NOT REPRODUCED                                                                      |
| FL-4  | High     | Edit and retry drops the discrepancy typed on a refused flight            | Fixed `f25e4fa`                 | NOT REPRODUCED                                                                      |
| FL-8  | High     | Stale save on a work order: Keep mine reverts a task status               | Fixed `e60f2b6`                 | NOT REPRODUCED                                                                      |
| FL-1  | Medium   | A pilot's second offline leg on one aircraft is always held for review    | Decision D7                     | REPRODUCED (expected: open decision)                                                |
| FL-2  | Medium   | Some server refusals of queued flights read "Something went wrong"        | Fixed `4246290`                 | NOT REPRODUCED                                                                      |
| FL-5  | Medium   | A pilot cannot end a flight once the aircraft is grounded mid-flight      | Decision D6                     | REPRODUCED (expected: open decision)                                                |
| FL-6  | Medium   | A discrepancy filed from the flight form writes no audit entry of its own | Fixed `49d5a01`                 | NOT REPRODUCED                                                                      |
| FL-9  | Medium   | A device clock behind the server locks the user out after sign-in         | Fixed `5a70abb`; confirm in D25 | NOT REPRODUCED                                                                      |
| FL-7  | Low      | A resent entry id with different contents is answered "accepted"          | Fixed `35cf81f`; confirm in D25 | NOT REPRODUCED                                                                      |
| FL-10 | Low      | Stale-save review on inspections shows a false "Changed by both"          | Fixed `e60f2b6`                 | NOT REPRODUCED                                                                      |
| FL-12 | Low      | A removed checklist refuses a queued flight with a generic message        | Fixed `4246290`                 | NOT REPRODUCED                                                                      |
| FL-11 | Info     | Server proof of FL-3                                                      | Fixed `e60f2b6`                 | ERROR: the new AD guard refuses the stale save; the stored next due stays at 2440 h |

### Maintenance

| ID    | Severity | Finding                                                                  | Status          | Repro re-run                         |
| ----- | -------- | ------------------------------------------------------------------------ | --------------- | ------------------------------------ |
| MX-1  | High     | A repeating AD action without an interval reads "Due not set" forever    | Fixed `8542d4e` | NOT REPRODUCED                       |
| MX-6  | High     | The status sheet printed no component limits                             | Fixed `fefa47d` | NOT REPRODUCED                       |
| MX-14 | High     | Set baseline accepted totals below a requirement's last compliance       | Fixed `a48a6e0` | NOT REPRODUCED                       |
| MX-16 | High     | Total time could be corrected below a recorded AD compliance             | Fixed `a48a6e0` | NOT REPRODUCED                       |
| MX-2  | Medium   | A reached AD cycles or landings limit read "Counter unavailable"         | Fixed `8542d4e` | NOT REPRODUCED                       |
| MX-3  | Medium   | An MEL repair interval counts from the deferral day, not the report day  | Fixed 2026-11-19 (commit 8facd81), D4 | REPRODUCED (expected: open decision) |
| MX-4  | Medium   | Urgent alerts judged calendar limits on the UTC date                     | Fixed `e8977e8` | NOT REPRODUCED                       |
| MX-5  | Medium   | The Aircraft page crashed when one aircraft had no meter reading         | Fixed `2cbe42e` | NOT REPRODUCED                       |
| MX-7  | Medium   | The status sheet listed a grounding discrepancy as plain "Open"          | Fixed `fefa47d` | NOT REPRODUCED                       |
| MX-8  | Medium   | An AD limit without a repeat interval showed "Not set" while Overdue     | Fixed `fefa47d` | NOT REPRODUCED                       |
| MX-10 | Medium   | With no meter reading, passed dates and limits did not ground            | Fixed `8542d4e` | NOT REPRODUCED                       |
| MX-11 | Medium   | An overdue inspection of a removed component kept grounding the aircraft | Fixed `8c1a6d7` | NOT REPRODUCED                       |
| MX-12 | Medium   | Component work at close-out wrote no audit entry for the component       | Fixed `6ea25c7` | NOT REPRODUCED                       |
| MX-13 | Medium   | Component service in the US evening was dated the next day               | Fixed `467e6dc` | NOT REPRODUCED                       |
| MX-9  | Low      | View aircraft printed "airworthy" under the Grounded badge               | Fixed `2cbe42e` | NOT REPRODUCED                       |
| MX-15 | Low      | Overview understated a limit at 0 and an expired deferral                | Fixed `2cbe42e` | NOT REPRODUCED                       |

### Inventory and purchasing

| ID    | Severity | Finding                                                               | Status          | Repro re-run                                                  |
| ----- | -------- | --------------------------------------------------------------------- | --------------- | ------------------------------------------------------------- |
| PT-1  | Medium   | A component out for repair could be transferred, stranding its order  | Fixed `ffdee7f` | NOT REPRODUCED                                                |
| PT-2  | Medium   | An aircraft on an issued order line could be transferred              | Fixed `ffdee7f` | NOT REPRODUCED                                                |
| PT-3  | Medium   | Correcting a stock part number blocked shipping and receiving         | Fixed `92b568e` | NOT REPRODUCED                                                |
| PT-4  | Medium   | Editing a component on a repair order blocked every order command     | Fixed `92b568e` | NOT REPRODUCED                                                |
| PT-5  | Medium   | A parts request could not be re-sourced after its order was cancelled | Fixed `521336e` | NOT REPRODUCED                                                |
| PT-9  | Medium   | A stock-replenishment parts request can never be completed            | Fixed 2026-11-19 (commit e61bfe5), D18 | REPRODUCED (expected: open decision)                          |
| PT-10 | Medium   | The purchase-order PDF replaced characters outside Latin-1            | Fixed `97c3d49` | NOT REPRODUCED                                                |
| PT-12 | Medium   | Editing a stock item's unit cost re-prices past issues                | Decided 2026-11-20 (D13): keep the issued price in the work order's administrator-only cost record; fix to follow | REPRODUCED (expected: open decision)                          |
| PT-6  | Low      | A receipt can be dated years before its order existed                 | Fixed 2026-11-19 (commit b01803d), D19 | REPRODUCED (expected: open decision)                          |
| PT-7  | Low      | Board view and Costs put issued parts in different periods            | Fixed `1a9afe8` | NOT REPRODUCED, adjusted copy expecting both screens to agree |
| PT-8  | Low      | "Create PO for parts" counted expired and reserved stock              | Fixed `1c3d54a` | NOT REPRODUCED                                                |
| PT-11 | Low      | Correcting a stock part number blocked job cards using that lot       | Fixed `92b568e` | NOT REPRODUCED                                                |

### Access and isolation

| ID    | Severity | Finding                                                                 | Status                                           | Repro re-run                                                                                                      |
| ----- | -------- | ----------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| AC-1  | High     | Access changes were written to the change log but shown to nobody       | Fixed `fccf1a1`                                  | NOT REPRODUCED                                                                                                    |
| AC-3  | High     | An owner group plus a board group opened the full workspace             | Fixed `b10cba5`; confirm in D25                  | NOT REPRODUCED                                                                                                    |
| AC-2  | Medium   | Expiring-date changes missing from paged history and the Weekly summary | Fixed `4ef62cb`                                  | ERROR: its summary total is fixed at 5, and AC-1 now adds 6 rows; the expiring-date save is counted               |
| AC-4  | Medium   | Owners received every logbook page photo, not only Form 337 copies      | Fixed `f32e11a`                                  | NOT REPRODUCED                                                                                                    |
| AC-5  | Medium   | The board view passed AD, deferral and compliance free text             | Fixed `5e61c92` for the board; owner half fixed 2026-11-19 (commit 87eca56), D15 | NOT REPRODUCED                                                                                                    |
| AC-6  | Medium   | Saved-address edits recorded no before or after, readable by no one     | Fixed `fccf1a1`                                  | NOT REPRODUCED                                                                                                    |
| AC-9  | Medium   | A transferred aircraft left its expiring dates in the old program       | Fixed `6b2f77a`                                  | ERROR: the PT-2 gate refuses the transfer; without the sample orders both cases pass                              |
| AC-10 | Medium   | A transferred aircraft takes the old program's cost records with it     | Fixed 2026-11-19 (commit aa87fe7), D14           | ERROR: the PT-2 gate refuses the transfer; without the sample orders it still reproduces, as the decision expects |
| AC-7  | Low      | Saved-addresses page said any member can add an address                 | Fixed `0745bcb`, doc; the screens offer saving an address to administrators only since 2026-11-19 (commit c701917) and 2026-11-20 (commit 481f95e) | No repro script; doc only                                                                                         |
| AC-8  | Low      | Refused sign-ins always counted 0 for a program administrator           | Fixed `30486de`; confirm in D25                  | REPRODUCED (by design, see note): refused sign-ins stay with system administrators                                |
| AC-12 | Low      | Any https address accepted as a push endpoint                           | Fixed `e9453d3`                                  | NOT REPRODUCED, through the SE-1 and NB-5 scripts                                                                 |
| AC-11 | Info     | Field list of what the board view and owner portal pass                 | Fixed `5e61c92` for the board; owner half fixed 2026-11-19 (commit 87eca56), D15 | REPRODUCED (by design, see note): the fixed phrase for a terminating action                                       |

### Setup, records package, paper check and logbook photos

| ID    | Severity | Finding                                                                | Status                                         | Repro re-run                                                                                    |
| ----- | -------- | ---------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| NA-1  | High     | The setup wizard skipped rows of a replaced or edited CSV              | Fixed `53c212b`                                | NOT REPRODUCED                                                                                  |
| NA-17 | High     | Leaving and reopening the Save step could save inspections twice       | Fixed `53c212b`                                | ERROR: no Save button is offered on return; 300 rows saved, none twice                          |
| NA-2  | Medium   | The paper check dated flights by UTC, not the local date               | Fixed `49437ee`                                | NOT REPRODUCED                                                                                  |
| NA-3  | Medium   | An offline records package did not say its change log was partial      | Fixed `3a19165`                                | NOT REPRODUCED                                                                                  |
| NA-4  | Medium   | A second queued photo with the same file name replaced the first       | Fixed `982613b`                                | NOT REPRODUCED, adjusted copy with real JPEG bytes                                              |
| NA-5  | Medium   | An AD number rewritten as a date by Excel was saved silently           | Fixed `53c212b`; confirm in D25                | REPRODUCED (by design, see note): the row now waits for a confirmation the script does not read |
| NA-7  | Medium   | Logbook photos share the 200-document cap with Form 337 copies         | Fixed 2026-11-19 (commit 73be318), D12         | REPRODUCED (expected: open decision)                                                            |
| NA-8  | Medium   | The records package left out logbook page photos                       | Fixed `3105814`                                | NOT REPRODUCED                                                                                  |
| NA-10 | Medium   | An inspection without a Reference grounded with a blank reason         | Fixed `8c1a6d7`                                | NOT REPRODUCED                                                                                  |
| NA-11 | Medium   | Two setup runs at once can save every inspection twice                 | Fixed 2026-11-19 (commit 01a15d5), D11         | REPRODUCED (expected: open decision)                                                            |
| NA-12 | Medium   | Due total time was labelled "h Hobbs"                                  | Fixed `2cbe42e`                                | NOT REPRODUCED                                                                                  |
| NA-13 | Medium   | Template rows without an ID were skipped after an insert               | Fixed `9bfba5f`                                | NOT REPRODUCED                                                                                  |
| NA-14 | Medium   | Owners received logbook page photos; same as AC-4                      | Fixed `f32e11a`                                | NOT REPRODUCED                                                                                  |
| NA-15 | Medium   | An aircraft created by the setup wizard reads "Airworthy"              | Decision D5 (decided): reads Setup incomplete  | REPRODUCED (expected: open decision)                                                            |
| NA-6  | Low      | A Windows-1252 CSV was read with replacement characters                | Fixed `d3a945f`                                | ERROR: the file is now refused, so no rows appear; the message names UTF-8                      |
| NA-9  | Low      | Offline exports failed with a raw browser error                        | Fixed `a0032dc`                                | NOT REPRODUCED                                                                                  |
| NA-16 | Low      | A running wizard commit wrote old CSV text over new typing             | Fixed `53c212b`                                | ERROR: the text box is now read-only during a commit                                            |
| NA-18 | Low      | The records package mixed UTC and local dates without labels           | Fixed `e3ad3aa`; confirm in D25                | ERROR: the column is now "Uploaded (UTC)"; with that name it passes                             |
| NA-19 | Info     | The records package rule for mechanics existed only as a hidden button | Fixed in the app `3a19165`; server side is D16 | No repro script; unit tests                                                                     |
| NA-20 | Info     | Uploads trusted the declared file type                                 | Fixed `14850d6`                                | NOT REPRODUCED, through `sec/live-storage.mjs`                                                  |

### Alerts, expiring dates and the Weekly summary

| ID    | Severity | Finding                                                                   | Status                          | Repro re-run                                                       |
| ----- | -------- | ------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------ |
| NB-2  | High     | An urgent alert that cleared and came back was never sent again           | Fixed `46f777b`                 | NOT REPRODUCED                                                     |
| NB-9  | High     | Non-administrators could read aircraft expiring dates in Change history   | Fixed `4ef62cb`                 | NOT REPRODUCED                                                     |
| NB-13 | High     | An aircraft grounded by a discrepancy sent no urgent alert or digest line | Fixed `ff5c564`                 | NOT REPRODUCED                                                     |
| NB-1  | Medium   | Failed urgent emails used up the daily cap of 60                          | Fixed `2f5af9d`                 | NOT REPRODUCED                                                     |
| NB-3  | Medium   | The digest never listed a returning alert again                           | Fixed `46f777b`                 | NOT REPRODUCED                                                     |
| NB-4  | Medium   | Urgent check judged calendar limits on the UTC date; same as MX-4         | Fixed `e8977e8`                 | NOT REPRODUCED                                                     |
| NB-6  | Medium   | A device kept receiving urgent alerts after sign-out                      | Fixed `f742de0`; confirm in D25 | REPRODUCED (by design, see note): ends sessions on the server only |
| NB-7  | Medium   | A system administrator in no group got no email or push                   | Fixed `a20a1a8`                 | NOT REPRODUCED                                                     |
| NB-10 | Medium   | Expiring-date changes hidden from everyone; same as AC-2                  | Fixed `4ef62cb`                 | NOT REPRODUCED                                                     |
| NB-11 | Medium   | The Weekly summary could not show what it promised to administrators      | Fixed `30486de`; confirm in D25 | REPRODUCED (by design, see note): same rule as AC-8                |
| NB-18 | Medium   | A returning alert came back already marked read                           | Fixed `46f777b`                 | NOT REPRODUCED                                                     |
| NB-5  | Low      | Any https address accepted as a push endpoint; same as AC-12              | Fixed `e9453d3`                 | NOT REPRODUCED                                                     |
| NB-8  | Low      | A deployment-wide date was sent once per Flight Program                   | Fixed `a20a1a8`                 | NOT REPRODUCED                                                     |
| NB-14 | Low      | Each urgent push added a new card instead of replacing it                 | Fixed `b542f38`                 | NOT REPRODUCED                                                     |
| NB-15 | Low      | "Last 7 days" in the Weekly summary ended at 00:00 UTC                    | Fixed `30486de` `d620018`       | NOT REPRODUCED after `d620018`                                     |
| NB-16 | Low      | A push subscription the service refuses was retried forever               | Fixed `d36d1cb`                 | NOT REPRODUCED                                                     |
| NB-17 | Low      | One failing program stopped every later program's digest                  | Fixed `98e79db`                 | NOT REPRODUCED                                                     |
| NB-19 | Low      | A failed email or push was never retried by itself                        | Fixed `2f5af9d`                 | NOT REPRODUCED                                                     |

### Security

| ID    | Severity | Finding                                                              | Status                                 | Repro re-run                                                                      |
| ----- | -------- | -------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------- |
| SE-4  | High     | Discrepancy grounding sent no urgent alert; same as NB-13            | Fixed `ff5c564`                        | NOT REPRODUCED                                                                    |
| SE-13 | High     | 800 long discrepancies lock every member out of a program            | Fixed 2026-11-19 (commits d418aff, 00df9dc), D2: a per-member limit and an alert at half of it; the retention window is D3 | REPRODUCED (expected: open decision)                                              |
| SE-1  | Medium   | Server-side request forgery through the push endpoint; same as AC-12 | Fixed `e9453d3`                        | NOT REPRODUCED                                                                    |
| SE-2  | Medium   | Push subscriptions survived sign-out; same as NB-6                   | Fixed `f742de0`; confirm in D25        | REPRODUCED (by design, see note): ends sessions on the server only                |
| SE-3  | Medium   | One program can spend the deployment's 60 urgent emails a day        | Fixed 2026-11-19 (commit fde4c67), D9  | REPRODUCED (expected: open decision)                                              |
| SE-5  | Medium   | Aircraft document uploads have no rate limit                         | Fixed 2026-11-19 (commit bac2be5), D12 | ERROR: the fake PDF bytes are now refused by NA-20; the rate limit was not tested |
| SE-8  | Medium   | A system administrator in no group got no alerts; same as NB-7       | Fixed `a20a1a8`; program alerts decided 2026-11-19, D8: through a group only (commit 6e82622) | REPRODUCED (expected: open decision): the program-alerts half                     |
| SE-9  | Medium   | Server "today" was UTC for urgent alerts; same as MX-4               | Fixed `e8977e8`                        | NOT REPRODUCED                                                                    |
| SE-10 | Low      | A deployment-wide date was emailed once per program; same as NB-8    | Fixed `a20a1a8`                        | REPRODUCED (by design, see note): skips the system check                          |
| SE-11 | Low      | A crafted engine-monitor CSV froze the tab                           | Fixed `bebd1a7`                        | NOT REPRODUCED                                                                    |
| SE-12 | Low      | A file link works for anyone, with no session, indefinitely          | Fixed after D17 (2026-11-19)           | Not re-run; `convex/fileLinks.test.ts` pins expiry, signature and access          |
| SE-14 | Low      | A crafted AD Word report froze the tab                               | Fixed `bebd1a7`                        | NOT REPRODUCED                                                                    |
| SE-15 | Low      | Template activation and transfers did not schedule the urgent check  | Fixed in part `ff5c564`                | No repro script; unit tests                                                       |
| SE-6  | Info     | The public push key needs no session                                 | Not a bug; documented `184916f`        | REPRODUCED (by design, see note): the public key is public                        |
| SE-7  | Info     | Queued logbook photos stay on the device after sign-out              | Fixed after D17 (2026-11-19)           | No repro script; `src/data/store.test.ts` and `tests/e2e/sign-out.spec.ts`        |

### Interface

| ID    | Severity | Finding                                                                         | Status                                              | Repro re-run                                                   |
| ----- | -------- | ------------------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| UI-3  | High     | A decimal comma in Ending Hobbs is saved as a 21,000-hour flight                | Fixed `9b972bb`; aircraft form limit is D1          | NOT REPRODUCED                                                 |
| UI-8  | High     | The server accepts a flight with an ending Hobbs 10 times too high              | Fixed `1e60a89`; confirm the limit in D1            | NOT REPRODUCED                                                 |
| UI-9  | High     | Number fields drop a decimal comma; the aircraft form saves 10x                 | Fixed `9b972bb`; aircraft form limit is D1          | NOT REPRODUCED                                                 |
| UI-1  | Medium   | A 45-character word widens five screens past a phone                            | Fixed `7f88050`                                     | NOT REPRODUCED                                                 |
| UI-4  | Medium   | Escape or Back closes a filled-in form without asking                           | Fixed `a98820d`; confirm in D25                     | NOT REPRODUCED                                                 |
| UI-10 | Medium   | Money fields store a decimal comma 100 times too large                          | Fixed `9b972bb`                                     | NOT REPRODUCED                                                 |
| UI-13 | Medium   | After a refused save, the message hides under the Save footer and focus is lost | Fixed 8e2c752                                       | NOT REPRODUCED with the fix; REPRODUCED on `883bd34` before it |
| UI-2  | Low      | Inventory location select has no accessible name                                | Fixed `84d75ec`                                     | NOT REPRODUCED                                                 |
| UI-5  | Low      | Screen text uses words the glossary avoids for alerts; "1 open discrepancies"   | Fixed `281b5d5` `b0d222a`                           | NOT REPRODUCED; text search, the old script timed out          |
| UI-6  | Low      | Sidebar brand link name does not match its visible text                         | Fixed `b0d222a`                                     | NOT REPRODUCED                                                 |
| UI-7  | Low      | An empty record history showed as a red error                                   | Fixed `78c1a78`                                     | NOT REPRODUCED                                                 |
| UI-11 | Low      | Fuel and oil fields store whatever the control holds                            | Fixed in part `9b972bb`; fuel and oil limits are D1 | NOT REPRODUCED; the fuel and oil limits are not tested         |
| UI-12 | Low      | Quantity and cost fields cannot be emptied and turn -5 into 5                   | Fixed 2026-11-19 (commit 1e56398)                   | REPRODUCED (expected: not done)                                |

### Operations

| ID    | Severity | Finding                                                               | Status                                | Repro re-run                                              |
| ----- | -------- | --------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------- |
| OP-1  | Medium   | After a backup key change, the env copy was not re-encrypted          | Fixed `702a3b3`                       | NOT REPRODUCED, adjusted copy with a file-storage listing |
| OP-6  | Medium   | Deploy could release an older commit over production                  | Fixed `283c70c`; confirm in D25       | No repro script; workflow tests                           |
| OP-2  | Low      | Sample flights had start and end readings swapped                     | Fixed `c1f1748`                       | No repro script; unit test                                |
| OP-3  | Low      | Re-running setup:auth replaced the production SITE_URL with localhost | Fixed `f91ac40`; confirm in D25       | No repro script; unit tests                               |
| OP-4  | Low      | .gitignore missed the secret files the backup runbook creates         | Fixed `0df0cfb`                       | No repro script; unit test                                |
| OP-5  | Low      | The "36-hour" stale-backup warning arrives after about 52 hours       | Fixed 2026-11-19 (commit 1434b27): 26-hour limit, D10 | REPRODUCED (expected: open decision)                      |
| OP-7  | Low      | A manual Deploy ignored CI                                            | Fixed `283c70c`; confirm in D25       | No repro script; workflow tests                           |
| OP-8  | Low      | check:standards ignores uncommitted files and some file types         | Decision D23                          | No repro script; open decision                            |
| OP-9  | Low      | Release runbook and README disagreed on memberships:backfill          | Fixed `283c70c`                       | No repro script; doc only                                 |
| OP-10 | Info     | The nightly job accepted an export without files or users             | Fixed `b45447c`                       | NOT REPRODUCED                                            |
| OP-11 | Info     | The recorded backup hash was the plaintext ZIP's                      | Fixed `b45447c`                       | No repro script; backup job test                          |
| OP-12 | Info     | Deploy resolves wrangler's dependencies outside the lockfile          | Fixed 2026-11-19 (commit 7a1b577): locked devDependencies, D24 | No repro script; open decision                            |

### Size

| ID   | Severity | Finding                                                          | Status                                                   | Repro re-run                                             |
| ---- | -------- | ---------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| SZ-1 | High     | The workspace stops loading after about 2 fleet-years of records | Cost cut `0267d9c` `9ce0ba7` `13a9ebc`; limit stands, D3 | Not re-run: needs the generated data and a local backend |
| SZ-2 | High     | A failed workspace load showed a blank page                      | Fixed `1ab6b0f`                                          | Not re-run: needs the generated data and a local backend |

## Stale-screen audit

The audit listed 59 items, and both High items are fixed. Settings no longer says certifications change nothing, since an inspection signoff needs one. The CSV downloads are now called partial extracts, not backups.

| Severity  | Found  | Fixed  | Decision | Not a bug | Not done |
| --------- | ------ | ------ | -------- | --------- | -------- |
| High      | 2      | 2      | 0        | 0         | 0        |
| Medium    | 17     | 17     | 0        | 0         | 0        |
| Low       | 40     | 25     | 3        | 1         | 11       |
| **Total** | **59** | **44** | **3**    | **1**     | **11**   |

The severities are those of each item's own heading in the audit; its summary table counted one Medium more.

| Group              | Items  | Fixed  | Decision | Not a bug | Not done |
| ------------------ | ------ | ------ | -------- | --------- | -------- |
| Stale text         | 14     | 13     | 0        | 0         | 1        |
| Settings structure | 12     | 10     | 1        | 0         | 1        |
| Naming drift       | 11     | 8      | 2        | 0         | 1        |
| Leftovers          | 7      | 3      | 0        | 1         | 3        |
| Visual consistency | 6      | 3      | 0        | 0         | 3        |
| Phones and tablets | 9      | 7      | 0        | 0         | 2        |
| **Total**          | **59** | **44** | **3**    | **1**     | **11**   |

Settings is reorganised into My account, Alerts, This device, Flight Program and System. The System section now says which deployment features are turned on: alert email, alerts on devices, Google and Microsoft sign-in, and browser error reporting.

| ID  | Severity | Item                                                                                                        | Status                             |
| --- | -------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| A1  | High     | "Certifications do not change what you can do" is false                                                     | Fixed `7609264`                    |
| A2  | Medium   | The FAA key panel describes renewal warnings as they worked before expiring dates and urgent alerts existed | Fixed `281b5d5`                    |
| A3  | Medium   | "Set by your deployment" is incomplete and points developers at the README                                  | Fixed `281b5d5`                    |
| A4  | Medium   | The Alerts page describes the alerts that existed before 9 Nov                                              | Fixed `281b5d5`                    |
| A5  | Low      | "Moved to Settings" notices are migration text                                                              | Fixed `281b5d5`                    |
| A6  | Low      | Developer paths shown to administrators                                                                     | Fixed `281b5d5`                    |
| A7  | Low      | The off-site backup promise depends on things the text does not mention                                     | Fixed `281b5d5`                    |
| A8  | Low      | The demo backup panel offers a "cloud transfer" that does not exist                                         | Fixed `281b5d5`                    |
| A9  | Low      | The password line names the wrong person                                                                    | Fixed `281b5d5` `b0d222a`          |
| A10 | Low      | The Flight Programs page tells phone and tablet users to use "the sidebar"                                  | Fixed `b0d222a`                    |
| A11 | Low      | Alert email text omits the time, the cap and the default                                                    | Fixed `281b5d5`                    |
| A12 | Low      | Service worker notices are out of step with the new service worker                                          | Not done; proposal in the report   |
| A13 | Low      | Settings intro and the Flight Program section summaries are behind the content                              | Fixed `281b5d5`                    |
| A14 | Low      | Docs that contradict the screens                                                                            | Fixed `0a20bc7`                    |
| B1  | Medium   | The daily digest is the same setting in two places, with two names                                          | Fixed `281b5d5`                    |
| B2  | Medium   | Dormant features show controls that do nothing, or hide without a word                                      | Fixed `281b5d5`                    |
| B3  | Medium   | The FAA key lives in three places, and the expiring-dates row is a cross-reference                          | Fixed `281b5d5`                    |
| B4  | Medium   | The System section is a pile                                                                                | Fixed `281b5d5`                    |
| B5  | High     | "Download data backup" is not a backup                                                                      | Fixed `c915ccf`                    |
| B6  | Medium   | The FAA renewal callout on the Overview goes to people who cannot act                                       | Fixed `281b5d5`                    |
| B7  | Low      | Settings for owners and board members does not exist, and nobody tells them                                 | Fixed 2026-11-19 (commit 36d1c16), D20 |
| B8  | Medium   | "This device" leaves out most of what the device keeps                                                      | Fixed in part `281b5d5`            |
| B9  | Low      | The theme has no "match this device" option                                                                 | Fixed 2026-11-19 (commit 224c24f)  |
| B10 | Low      | "Edit my certifications" is reachable from three places                                                     | Fixed `281b5d5`                    |
| B11 | Low      | The Flight Program section puts navigation between content                                                  | Fixed `281b5d5`                    |
| B12 | Low      | A role name that tells a mechanic nothing                                                                   | Fixed in part `b0d222a`            |
| C1  | Medium   | Role labels disagree between the sidebar and Settings                                                       | Fixed `b0d222a`                    |
| C2  | Low      | The same action has three names                                                                             | Fixed `281b5d5` `b0d222a`          |
| C3  | Low      | The top-bar title falls back to "Overview" on pages it does not know                                        | Fixed `b0d222a`                    |
| C4  | Low      | The browser tab title never changes                                                                         | Fixed `b0d222a`                    |
| C5  | Low      | "Job card" in the UI against "Task card / Task template" in the glossary                                    | Fixed 2026-11-19 (commit 5d340c5), D21; docs 2026-11-20 (commit b0c6465) |
| C6  | Low      | "Report a problem" against "Discrepancy"                                                                    | Fixed 2026-11-19 (commit 7a674ae), D22 |
| C7  | Low      | "sign-off" against the glossary's "Signoff"                                                                 | Fixed `b0d222a`                    |
| C8  | Medium   | Pilots see the raw code "unknown" as the aircraft status in Start flight                                    | Fixed `b0d222a`                    |
| C9  | Low      | "Weekly summary" offers 30-day and custom periods                                                           | Fixed 2026-11-19 (commit 24cbaf4): the tab is "Summary" |
| C10 | Low      | The demo restriction is worded three ways                                                                   | Fixed `281b5d5`                    |
| C11 | Low      | "Transfer Flight Program" transfers records, not the program                                                | Fixed `b0d222a`                    |
| D1  | Low      | Console warnings on every load once the new service worker controls the page                                | Not done                           |
| D2  | Low      | The update path ignores the service worker's SKIP_WAITING handler                                           | Not done; with A12                 |
| D3  | Low      | The "Full demo backup for cloud transfer" panel is an A2-era leftover                                       | Fixed `281b5d5`; with A8           |
| D4  | Low      | Legacy single-license and legacy address paths show text to users                                           | Not done; needs a production query |
| D5  | Low      | The aircraft drawing placeholder                                                                            | Not a bug: known placeholder       |
| D6  | Medium   | The tablet rail cuts off "All sections" on a landscape phone                                                | Fixed `7f88050`; with F2           |
| D7  | Low      | The "Page not found" screen is a bare paragraph                                                             | Fixed `b0d222a`                    |
| E1  | Medium   | The two alert-email switches run into each other                                                            | Fixed `7f88050`                    |
| E2  | Low      | The owner portal still uses the old Badge, so one card shows two spellings                                  | Fixed in part `03396da`            |
| E3  | Low      | Settings mixes old "panel" components with the new block layout                                             | Fixed in part `281b5d5`            |
| E4  | Low      | Two primary buttons on the Flight log                                                                       | Not done                           |
| E5  | Low      | Unformatted numbers next to formatted ones                                                                  | Not done                           |
| E6  | Low      | Demo preview buttons look like page actions                                                                 | Not done                           |
| F1  | Medium   | The setup wizard's Review step overflows every phone                                                        | Fixed `7f88050`                    |
| F2  | Medium   | Landscape phone: "All sections" is below the fold of the rail, and squashed                                 | Fixed `7f88050`                    |
| F3  | Medium   | On-screen keyboard: the Start flight sheet leaves no room for the field being typed in                      | Fixed `7f88050`                    |
| F4  | Low      | On-screen keyboard: the page shell keeps 140 px of chrome                                                   | Not done; proposal only            |
| F5  | Medium   | The stale-save review table does not wrap, on phones or in dialogs                                          | Fixed `7f88050`                    |
| F6  | Low      | The setup wizard's CSV step file input overflows at 360                                                     | Fixed `7f88050`                    |
| F7  | Low      | Unwrapped tables elsewhere: the same risk as F1                                                             | Fixed `7f88050`                    |
| F8  | Low      | Tap targets                                                                                                 | Fixed `7f88050`                    |
| F9  | Low      | The board view's phone tab bar is a lone "More"                                                             | Not done; part of D20              |

## Clean-up round

After the fixes merged, three parts ran side by side under a zero-behaviour-change rule. One reviewed this round's code, one shortened long functions elsewhere, and one added tests. Where a module had thin tests, a characterization test came first. The rendered markup of each screen that was split was compared before and after, and it was identical.

| Measure                 | 3 Nov audit    | Before the clean-up, `479eb4b` | After, `4628f39` |
| ----------------------- | -------------- | ------------------------------ | ---------------- |
| Functions over 40 lines | 499            | 48                             | 9                |
| Functions over 80 lines | 224            | 3                              | 3                |
| Nesting above 2 levels  | 118            | 5                              | 0                |
| Exports without TSDoc   | 1,133 of 1,314 | 4                              | 2 of 1,902       |

The 3 Nov audit used a different script over 354 files, including the repro scripts under `docs/qa/`. Today's script reads 380 source files in `src`, `convex` and `scripts`, so compare the two columns loosely.

- **The 9 long functions left:** four are deferred in `REFACTOR_ROADMAP.md`: the demo backend, the workspace store, the backup test fixture and a function inside it. The other five are screen functions of 41 to 47 lines in Settings, Alerts, device alerts and Users and access, which the stale-screen batch changed.
- **The 2 undocumented exports** are overload implementation signatures. Callers see the documented overloads.

Test coverage, from two full runs with v8 coverage:

| Coverage                                     | Before, 3,875 tests | After, 3,960 tests |
| -------------------------------------------- | ------------------- | ------------------ |
| Statements                                   | 82.65%              | 83.13%             |
| Branches                                     | 79.47%              | 80.04%             |
| Functions                                    | 77.59%              | 77.84%             |
| Lines                                        | 83.30%              | 83.69%             |
| Lines in the 118 files this round changed    | 83.62%              | 84.44%             |
| Branches in the 118 files this round changed | 78.42%              | 79.54%             |

- **Where it moved most:** the service worker went from 0% to 100% of lines, the number-entry guard from 0% to 100%, and the board summary's branches from 46% to 97%.
- **What was left on purpose:** screen markup, which the browser suite covers, and demo-only paths.
- **Every new test was checked** by breaking the rule it pins once: about 70 mutations, each turning a test red apart from two redundant guards.

The new tests found one more bug, now fixed. The board's "Due in the next 30 days" list showed an AD closed by a terminating action as "ok" with negative days. It was Low and display-only. The fix is `883bd34`, pinned by `src/domain/boardSummaryTerminatedAd.test.ts`.

## Decisions for Aaron

Aaron is reviewing these. Each one has a plain question, the options and a recommendation in `decisions.md`. They are ordered by importance to safety and launch.

| No. | Question                                                                                       | Ids                                                                | Recommendation                                                    |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| D1  | Confirm the 24-hour hold, and set limits for the aircraft form's readings and for fuel and oil | UI-8, UI-9, UI-11                                                  | Keep 24 hours; ask before a ten-times change on the aircraft form |
| D2  | How should one member's flood of long discrepancies be stopped from locking everyone out?      | SE-13                                                              | Detect and alert now; fix with the retention window               |
| D3  | When should the retention-window work be scheduled?                                            | SZ-1                                                               | First quarter after launch, before 1,500 fleet flights            |
| D4  | Should an MEL repair interval count from the day the defect was found?                         | MX-3                                                               | Yes, with a required date defaulting to the report date           |
| D5  | Should a newly set-up aircraft read Grounded until its setup is finished?                      | NA-15                                                              | Decided by Aaron 2026-11-10: it reads "Setup incomplete", not Grounded; flights are not blocked |
| D6  | Can a pilot log a flight on an aircraft grounded during the flight?                            | FL-5                                                               | Yes, as an entry held for review                                  |
| D7  | Should a pilot's own consecutive offline legs be accepted in order?                            | FL-1                                                               | Yes, by tracking the version on the device                        |
| D8  | Should a system administrator in no group get every program's urgent alerts?                   | SE-8                                                               | No; join a group for a program's alerts                           |
| D9  | How should the 60 urgent emails a day be shared between programs?                              | SE-3                                                               | Per-program share, plus a warning when the cap is hit             |
| D10 | How soon should a missed backup be reported?                                                   | OP-5                                                               | Make the backup heartbeat a required go-live item                 |
| D11 | Should the server refuse a duplicate inspection from setup?                                    | NA-11                                                              | Yes, for setup saves only                                         |
| D12 | How should aircraft documents be capped and rate-limited?                                      | NA-7, SE-5                                                         | Separate caps for photos and Form 337 copies                      |
| D13 | Should a stock price edit re-price parts already issued?                                       | PT-12                                                              | No; store the price on each issue                                 |
| D14 | Should cost records stay with the program that paid on a transfer?                             | AC-10                                                              | Yes                                                               |
| D15 | Which compliance fields should owners see on their own aircraft?                               | AC-5, AC-11                                                        | Named fields only, without internal user ids                      |
| D16 | Is "records package for mechanics" a convenience or a confidentiality rule?                    | NA-19                                                              | A convenience rule                                                |
| D17 | Add queued photos and permanent file links to the device-data decision?                        | SE-7, SE-12                                                        | Yes, decide with S6, S7 and S10                                   |
| D18 | Is a stock-replenishment request complete when its parts arrive?                               | PT-9                                                               | Yes                                                               |
| D19 | Should a receipt dated before its order be refused?                                            | PT-6                                                               | Yes                                                               |
| D20 | Should owners and board members get a Settings page?                                           | Stale B7, F9                                                       | No; one line in their More sheet for launch                       |
| D21 | Should the glossary follow the screens' "Job card" wording?                                    | Stale C5                                                           | Yes, change the glossary                                          |
| D22 | How should "Report a problem" relate to "Discrepancy"?                                         | Stale C6                                                           | Add "Problem report" to the glossary                              |
| D23 | Should `check:standards` also check uncommitted files?                                         | OP-8                                                               | Yes, before launch                                                |
| D24 | Should wrangler and esbuild move into the lockfile?                                            | OP-12                                                              | Yes, after launch week                                            |
| D25 | Confirm the conservative choices made during the fixes                                         | AC-3, AC-8, NB-11, NA-5, NA-18, OP-3, OP-6, NB-6, FL-7, FL-9, UI-4 | Keep them                                                         |

## Not tested

These need real devices, real accounts or the production deployment, which the rules excluded.

- **Real phones and tablets:** iOS and Android keyboards, the Home Screen install, camera capture and screen readers. Phone keyboards were simulated by shrinking the viewport.
- **Real email and push delivery:** Resend, Apple, Google and Mozilla push services, and opening the app from an alert on a phone.
- **Real Google and Microsoft sign-in:** only the code was read. The A3 question stands.
- **Convex cloud timing:** the 1-second and 16 MiB limits were measured on a local backend. Whether the cloud hits them at the same size is not known.
- **Production settings:** Cloudflare headers, R2, Dropbox, Better Stack and the GitHub Actions workflows were read, not run. The Deploy guard's call to the GitHub API has not run against GitHub.
- **Some screens:** second-level dialogs, and printing through the browser's print dialog.

## Size test

The workspace stops loading once a Flight Program holds about two fleet-years of records at the model's flying rate. After the size fixes, owners keep loading far longer and board members somewhat longer.

The model fleet has 6 aircraft. Each aircraft flies 300 flights a year, with 12 work orders of 15 job cards, 30 discrepancies, 60 flight plans, 30 parts requests and 20 purchase orders. The test ran on `main` at `cdbddf2`, before the fixes.

| Years   | Fleet flights   | Job cards       | Administrator       | Pilot               | Owner               | Board               | Data read    |
| ------- | --------------- | --------------- | ------------------- | ------------------- | ------------------- | ------------------- | ------------ |
| 1       | 1,800           | 1,080           | ok                  | over 1 s            | ok                  | ok                  | 9.5 MB       |
| 2       | 3,600           | 2,160           | over 1 s            | over 1 s            | ok                  | ok                  | 16.0 MB      |
| 3       | 5,400           | 3,240           | over 16 MiB         | over 16 MiB         | over 16 MiB         | over 16 MiB         | at the limit |
| 5 to 15 | 9,000 to 27,000 | 5,400 to 16,200 | over 16 MiB         | over 16 MiB         | over 16 MiB         | over 16 MiB         | at the limit |
| 20      | 36,000          | 21,600          | too many operations | too many operations | too many operations | too many operations | none         |

Other operations, at the size where each first fails:

| Operation               | First fails at | Time at 20 years |
| ----------------------- | -------------- | ---------------- |
| Weekly summary, 31 days | 5 years        | fails            |
| Weekly summary, 7 days  | 15 years       | fails            |
| Work order save         | 5 years        | fails            |
| Job card save           | 5 years        | fails            |
| Held flight review      | 15 years       | fails            |
| History page            | does not fail  | 8.2 s            |
| New flight              | does not fail  | 0.6 s            |
| Records export          | does not fail  | 210 s and 68 MB  |

The size fixes cut what the workspace reads. Measured at one year with convex-test, every role still receives exactly the same data.

| Caller        | Documents read, before and after | MB read, before and after | Lookups, before and after |
| ------------- | -------------------------------- | ------------------------- | ------------------------- |
| Administrator | 6,097 and 6,097                  | 8.25 and 8.26             | 2,156 and 1,018           |
| Pilot         | 5,945 and 5,945                  | 8.21 and 8.21             | 481 and 103               |
| Owner         | 5,886 and 1,711                  | 8.19 and 1.20             | 106 and 40                |
| Board         | 5,876 and 3,045                  | 8.19 and 5.05             | 94 and 59                 |

### Runway

The read limit falls at about 4,000 fleet flights with their job cards. The 1-second limit came at 1,800 to 3,600 fleet flights under load, and the fixes may have moved it; cloud timing is unmeasured. Count from the first real records.

| Fleet flights a year | 1-second limit, roughly | 16 MiB limit, roughly |
| -------------------- | ----------------------- | --------------------- |
| 900                  | 2 to 4 years            | 4.4 years             |
| 1,800, the model     | 1 to 2 years            | 2.2 years             |
| 3,600                | 6 months to 1 year      | 1.1 years             |

- **Owners:** read about 0.7 MB more per fleet-year, so they keep loading for well over a decade.
- **Board members:** still read job cards for cost totals, so they reach the limit around year 3.
- **Administrators and pilots:** the limit is unchanged, at about 2.2 fleet-years.
- **When the load fails:** the app now shows "Your workspace could not be opened." with the copy on the device, not a blank page. That is SZ-2.

The real fix is the retention window in decision D3. The workspace would hold open items, current records and three months of closed history, and older records would load page by page. The estimate is 9 to 12 working days. The window must also cover the work order and job card saves that fail from five years.

## How to reproduce

The scripts are in `repro.zip` in this folder. They are kept as one archive because the repository's standards check requires a header on every code file, and these scripts are evidence, not part of the app. Unpack it here to get `repro/<area>/`, one folder per area (`acl`, `flights`, `mx`, `newa`, `newb`, `ops`, `parts`, `sec`, `size` and `ui`), and `repro-adjusted/` with the adjusted copies:

```sh
cd docs/qa/bug-hunt-2026-11-10 && unzip repro.zip
```

A script prints `REPRODUCED: …` and exits with code 1 while the bug exists. It prints `NOT REPRODUCED` and exits 0 once it is fixed.

1. **Browser scripts,** the `.js` and `.cjs` files: build and serve the app with the demo enabled, then run a script.
   ```sh
   VITE_ALLOW_DEMO=true npm run build
   node scripts/serve-dist.mjs --port 4400
   node docs/qa/bug-hunt-2026-11-10/repro/mx/mx-5-aircraft-page-crashes-without-meter-reading.cjs
   ```
   - Set `ANGELONE_URL` to test another address. Set `CHROMIUM_PATH` if Playwright cannot find its browser.
2. **Server and domain tests,** the `zz-hunt-*.test.ts` files: each asserts the correct behaviour. Copy it into `convex/` or `src/domain/` as its header says, run it with `npx vitest run <path>`, then delete the copy. The `acl` tests also need `zzHuntAclWorld.ts` beside them.
3. **Live backend scripts,** `repro/sec/live-*.mjs` and `repro/size/run.sh`, need a local Convex backend and refuse any other address. `run.sh` wipes that checkout's local database first, and `live-snapshot-lockout.mjs` leaves its local program unusable.
4. **The OP-1 script,** `repro/ops/*.sh`, runs the nightly backup job twice against a fake Convex CLI and a folder bucket.

Some scripts still report `REPRODUCED` or stop with an error on the fixed code, on purpose:

- **Open decisions:** the repros for FL-1, FL-5, MX-3, NA-7, NA-11, NA-15, OP-5, PT-6, PT-9, PT-12, SE-3, SE-12, SE-13, the program-alerts half of SE-8 and the AC-10 case stay red until Aaron decides.
- **Not done:** UI-12.
- **AC-8 and NB-11:** they expect a program administrator to count refused sign-ins, which was left to system administrators.
- **SE-2 and NB-6:** they end sessions on the server only, a path that never knows the device.
- **SE-10:** it runs the two program checks directly, never the system check that saving a date schedules.
- **AC-11:** it flags the fixed phrase "Terminating action recorded", which the board view keeps on purpose.
- **SE-6:** the public push key answers without a session by design.
- **NA-5:** the row is now planned and waits for an administrator's confirmation, which the script does not read.
- **AC-2, AC-9, FL-11, NA-6, NA-16, NA-17, NA-18 and SE-5:** later fixes changed what these scripts drive, so they stop with an error. The table notes say what a diagnostic run showed.
- **Original scripts for NA-4, OP-1, PT-7 and the push scripts:** they rely on inputs the fixes now refuse or expectations the fixes superseded. Use the adjusted copies.
- **3 Nov acl-2:** still red by design, as its entry in `../bug-hunt-2026-11-03/README.md` says.
