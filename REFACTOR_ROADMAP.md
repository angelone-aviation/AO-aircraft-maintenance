# Refactor roadmap

Brings the whole codebase up to [CONSTRAINTS.md](CONSTRAINTS.md) in small, safe, dependency-ordered batches. Read [CONTEXT.md](CONTEXT.md) and [CLAUDE.md](CLAUDE.md) first. The audit behind this plan (2026-11-03) is in [docs/architecture/metrics-2026-11-03.md](docs/architecture/metrics-2026-11-03.md) (size, churn, dependency graph, function metrics, duplication) and [docs/architecture/tier2-candidates.md](docs/architecture/tier2-candidates.md) (the deep-module review).

**Progress:** 400 of 432 batches done; 28 deferred on purpose (cosmetic Tier 3 splits, and Batches 259, 311 and 312; see each line); 4 to go (Batches 427, 428, 430 and 431). Tier 1: 251 · Tier 2: 90 · Tier 3: 85. Batches 410–432 (T21, T22, and follow-ups to T10, T20 and T8) are numbered after Tier 3, so batches 1–409 keep their numbers. Owner decisions are collected in findings 33, 34, 44, 52, 60, 62 and 67.

## How to run a batch

One batch is one to three closely related files. For each batch:

1. Apply 100% of the standards: architectural header, TSDoc on every export (`@param`, `@returns`, `@throws`, side effects), WHY-only comments, guard clauses (nesting of 2 or less), functions of 40 lines or fewer through verb-first private helpers, `SCREAMING_SNAKE_CASE` constants for magic values, explicit errors, no suppressions.
2. Preserve every exported name, signature and runtime behaviour. A real bug found on the way gets a failing test and its own commit, and a line under [Findings](#findings).
3. Prove it: `npx tsc --noEmit`, `npx oxlint <files>`, `npx vitest related <files> --run` (or the colocated test), `node .claude/hooks/check-standards.mjs <files>`, and `npx prettier --check <files>`. Tier 3 parts 2 and 3 of a screen also run that screen's Playwright spec.
4. Commit: `refactor: Batch N (<lane>): <short description>`. Tick the box here.

Repeatable prompt for one batch:

```text
Read CONTEXT.md, CLAUDE.md, and REFACTOR_ROADMAP.md.

Execute the next unchecked `[ ]` batch in REFACTOR_ROADMAP.md:
1. Apply 100% of our Robust Engineering Standards (top-of-file architectural header, complete docstrings on all exports, high-signal WHY-only inline comments, early-return guard clauses, max 40-line functions, and SCREAMING_SNAKE_CASE constants).
2. Preserve 100% of external function signatures, public exports, and runtime behavior.
3. Run the type-checker, linter, and relevant unit tests to prove zero regressions.
4. Check off the batch as `[x]` in REFACTOR_ROADMAP.md and summarize the changes made.
```

## Execution plan

- **Lanes.** Tier 1 and Tier 3 batches carry a lane: `domain-a`, `domain-b`, `server`, `ui-a`, `ui-b` or `platform`. Lanes own disjoint files, so they run in parallel, each in its own git worktree and branch. Within a lane, take batches in order.
- **Phase A:** Tier 1 and Tier 3, all six lanes at once. Tier 3 files are decomposed behind barrels, so no importer in another lane has to change.
- **Phase B:** Tier 2, in the order listed below (it follows each candidate's dependencies), at most three batches at a time and never two that touch the same file. The files Tier 2 rewrites most heavily are owned by Tier 2 and left out of Phase A entirely: `src/data/demoBackend.ts`, `convex/operations.ts` (and its test, `convex/operations.test.ts`), `convex/runCommand.ts` (and its test), `scripts/backup/recordsWorkbook.ts` (and its test) and `scripts/backup/exportFixture.ts`. Other files that a Tier 2 batch also restructures keep their Tier 1 batch or Tier 3 part 1 in Phase A.
- **Tier 3 parts that wait:** a Tier 3 part 2 or 3 marked `(after Tn bm)` restructures a file that this Tier 2 batch also changes, so lanes skip it until that batch lands, while the file's part 1 standards pass still runs in Phase A.
- **Exception:** Tier 2 batches 252 and 253 (T10 b1–b2, so production shows users the real rejection message instead of "Server Error") run first, alongside Phase A, because they matter for go-live. Their files are locked in the lanes until they merge.
- **Checkpoints,** every few hours: merge the lanes, run `npm run check`, the full Playwright suite, the bug-hunt repro scripts and `npm run test:backup`, then push to `main`.

## Baseline (2026-11-03)

| Measure | Value |
|---|---|
| Files in scope (code, tests, styles, scripts) | 534; 317 source files outside tests |
| Files passing the header and suppression check | 2 of 570 checked |
| Functions over 40 lines | 499 in source (224 over 80), across 206 files |
| Functions nested deeper than 2 | 118 in source |
| Exported declarations without TSDoc | 1,133 of 1,314 (86%) |
| Numeric literals outside constants | 1,768 in source |
| Inline suppressions | 7 (plus 3 `shellcheck disable`, not yet checked) |
| Import cycles | 5 strongly connected groups; the largest holds 40 `src/domain` modules around `model.ts` |
| Copy-paste clusters (5+ lines) | 34 in source, 36 in tests |
| Largest files | `src/styles.css` 2,844; `src/domain/commonPasswords.ts` 2,502 (data); `scripts/backup/recordsWorkbook.ts` 2,289; `src/components/Components.tsx` 1,966; `Management.tsx` 1,838; `WorkOrders.tsx` 1,720; `scripts/backup/exportFixture.ts` 1,713; `PurchaseOrders.tsx` 1,705; `TaskCards.tsx` 1,664; `PartsRequests.tsx` 1,619; `Airworthiness.tsx` 1,526; `src/data/demoBackend.ts` 1,459 |
| Most-changed files (6 months, including the `legacy/main` history; `main` alone has 30 commits) | `src/data/store.ts` 24 commits; `store.test.ts` 17; `backend.ts` 15; `convex/schema.ts` 14; `src/styles.css` 13; `convex/operations.ts` 11 |

Scope: the 534 files are the code, tests, styles, scripts, workflows and config outside `docs/` and `.claude/`; each is in a batch or owned by Tier 2. The header-check and metrics figures (570 files) use the metrics report's scope: `.ts .tsx .mjs .js .css .sh` only, including 41 bug-hunt repro scripts under `docs/qa/`. `docs/` (the architecture HTML and the bug-hunt repro scripts) is out of scope for this roadmap.

## Findings

Raised by the audit; not batches. Update as batches find more.

1. **Production may show "Server Error" instead of rejection messages.** 14 of the 21 `runCommand` mutations set no `expose`, and Convex production hides plain `Error` messages. convex-test does not, so the suites pass either way. Confirm once on a preview deployment; T10 (batches 252–253) fixes it.
2. **The owner portal and alerts may list ADs on removed Components** that the Dispatch gate excludes (`aircraftStatus.ts:107`), and some callers of `requirementStatus` do not catch its throw. Unconfirmed; T13 adds the test.
3. **The demo's Conflict review and discrepancy resolution lack server rules** (administrator check, crew checks, `validateFlight`, the `resolve` permission, the 5,000-character limit). T11 and T2 fix them.
4. **Guided flight skips the tenths-of-an-hour rule** (`GuidedFlight.tsx:451-456`). T7.
5. **ADR-0006's real-Convex browser tests are not in the automated checks.** `tests/e2e/live.spec.ts` has two tests against a real local Convex backend (sign-in, offline reload, discrepancy sync, offline sign-out), but it skips itself unless `npm run test:local` has provisioned a local administrator, so CI runs the demo build only. Logging a flight and closing a work order are not covered.
6. **Owner-only items in `.claude/hooks/`** (agents may not edit it): `check-standards.mjs` nests three levels in one function; the suppression check has no rule for `shellcheck disable`; the hook reminder still lists `improve-codebase-architecture`, which only a person can start. **Update 2026-11-20:** the repository's last `shellcheck disable` is gone (commit dca6fca), ready for the D23 patch that adds the rule.
7. **The architecture report's counts are out of date** (`docs/architecture/README.md`): 54 specs, 52 convex-test suites, about 91 domain modules and 90 component files today.
8. **Address lookup refuses valid stored addresses** (Batch 1). `addressLookupSchema` (`src/domain/addressLookup.ts:4-8`) caps the postal code at 100 characters and the country at 150, but `addressSchema` allows 300, so `lookupInput` throws on an address the app has already saved. **Fixed 2026-11-19 (commit b958c3e).**
9. **ZIP and Canadian postal codes are checked untrimmed** (Batch 1). `addressIssues` refuses " 20500" although the schema trims it on save. A characterization test in `src/domain/addresses.test.ts` pins this; fix it as a small bug fix in its own commit, updating that test. **Fixed 2026-11-19 (commit 5c53457).**
10. **The phone message promises more than the check** (Batch 1). It asks for an area or country code, but any 7 digits pass. A product decision: tighten the check or change the message. **Fixed 2026-11-19 (commit a241bb6):** the message states the rule, at least seven digits.
11. **The street length limit is redundant** (Batch 1). The 2,000-character street limit never decides on its own: the 1,900-character combined cap already rejects a street over about 1,890 characters.
12. **`addressFromForm` is form shaping in the domain** (Batch 1). It reads `FormData` for `Fleet.tsx` and `Management.tsx` only, and the input name `"addressDetails"` is written separately in `Fleet.tsx:799` and `Management.tsx:1646`. It belongs with the components (CONTEXT.md §5).
13. **`src/domain/addresses.test.ts` also holds the address-lookup tests** (Batch 1): `lookupInput`, `fetchAddressSuggestions`, `parseAddressSuggestions`. Move them to a new `src/domain/addressLookup.test.ts` when that module's batch (Batch 44) runs.
14. **Production started empty on 2026-11-03; no data was migrated** (README "Deployment", `docs/go-live-checklist.md`). Code that only migrates or repairs data written by earlier versions may now be removable; T21 inventories it.

15. **Logbook PDFs drop text after a tab** (`src/data/logbookPdf.ts`; jsPDF writes only the characters before a tab), and a lone carriage return joins two words. Pinned by a characterization test; fixing it (expand tabs to spaces) changes the document a mechanic signs, so it needs a yes. **Fixed in part 2026-11-19 (commit e466087):** a tab prints as one space; a lone carriage return still joins two words.
16. **Expected refusals still show "Server Error" in production** until each throw site uses `Rejection` (domain) or `ConvexError` (server). Batch 415 covers the server's own checks; lanes convert domain refusals as part of each file's standards pass (see the lane brief), and T10 b3+ covers what remains.
17. **`deleteBlobIfUnused` checks 5 tables, `STORAGE_REFERENCES` lists 10** (`convex/attachments.ts`): a blob shared with an unchecked table could be deleted while in use. T4 b1 fixes it.
18. **A rate-limit check can be half-applied** (`identities.recordRefusal`): the per-identity count is saved even when the global cap then refuses. **Fixed 2026-11-19 (commit 759b5a6).**
19. **Convex validators repeat the domain's zod schemas** (`convex/validators.ts` against `src/domain/model.ts` and others), with nothing checking they agree.
20. **Small messages and limits that disagree:** the aircraft photo limit is 5 MiB but the message says 5 MB; the months-in-service message caps at 11991.786 but accepts up to 11991.802; `parseHours` says "positive" but accepts 0; ATA chapter 67 reads "Rotory". **Fixed 2026-11-19 (commits a9f723e, 1faa729).**
21. **Duplicated values:** the $1 billion price cap in four files; the tenth-of-an-hour rule in `flightChecklistSchema.ts` and `model.ts` with different messages (T7); on-order arithmetic in `programs.ts` and `purchaseOrders.ts`; the default "Performed" phrase in `LogbookWording.tsx`.
22. **Dead or legacy code:** `assertPassword` has no caller; `resolveExplicitEvents` in `flights.ts` handles counter events from before the fresh start (T21); unused CSS (`.ad-register-toolbar`, `.po-history`, `.flight-fluid-fields p`) and orphaned comments in `src/styles.css`.
23. **Test gaps** where docs now promise behaviour no test pins: `model.ts` (date limits, offline window, `can`), `flights.ts` (`version + 1`, chronology boundaries), `rateLimits.consume`, `sampleDocuments.upload` clean-up, `secretsMigration` partial re-seal, and `dropboxUpload.test.ts` (retries, upload-session resume, refusals).
24. **Screens showed Convex's wrapper text** (`[CONVEX M(…)] … Server Error`) instead of the message. Batch 324 fixed 39 screens with one `errorText` helper. Still to adopt it: `Components.tsx:465` and `Management.tsx:1119` (UI lanes), The Sync center is fixed by Batch 418.
25. **Bug: an unusual file type crashed the file checks** (`"constructor"` looked up in a plain object), showing "Server Error". Fixed in `2f8e917` (the MIME tables are `Map`s).
26. **Escape never closes a dialog from the aircraft make or model field** (`DrsComboBox` swallows it even when its list is closed). Confirmed on the old code. **Fixed 2026-11-19 (commit 98ac55f).**
27. **History paging can return a cursor taken from a row the caller cannot see** (`convex/auditHistory.ts`): only a timestamp, but it contradicts the S12 rule. Decide: fix, or relax S12. Pinned by a test. **Fixed 2026-11-19 (commit 9448647):** a cut-short page resumes from the hidden row's opaque id.
28. **Unconfirmed drift:** copying a flight plan whose source is on another aircraft is likely refused by the server and accepted by the demo. Needs a convex-test.
29. **Logic in the wrong layer:** `KeepOnDevice.tsx` holds a store and the download logic (belongs in `src/data`); photo resize rules (1024 px, quality 0.85) sit in `AircraftPhoto.tsx` (belong in `src/domain/aircraftPhotos.ts`).
30. **Messages say MB where the limit is MiB:** manuals 200, attachments 7, licence copies 5, flight-plan PDFs 10, template batches 2 (see also 20). **Fixed 2026-11-19 (commit a9f723e).**
31. **More duplicates:** `strokeWidthFor` in three icon components, a class-name join helper in four files, three near-identical icon select components, `addDays` in four domain modules, the same enums in `inspectionTemplates`, `maintenanceCsv` and `components`.
32. **Still "Server Error" after Batch 417:** `convex/fleet.ts` `assertAvailableAircraft` ("Aircraft belongs to another Flight Program.", "This registration cannot be used.") reaches `admin.createAircraft` as a plain `Error`: convert in Batch 161, after T9 b3. Batch 416 wraps `validateAircraftPhoto`, `fetchAddressSuggestions` and the Spruce parsers, which show once their domain modules throw `Rejection`. **Update:** Batch 262 converted `assertAvailableAircraft`.
33. **Owner decision: PO uploads write no change-log row** (`convex/poFiles.ts` `finish`), nor do the copies it files on received items. Inventory and aircraft uploads are audited, and so are PO file removals. **Fixed 2026-11-19 (commit 20c43b6).**
34. **Owner decision: a blank close-out wording prints as an empty line** in the logbook entry, not the placeholder (`""` is not nullish). Changing it changes signed text. Pinned in `src/domain/logbook.test.ts`. **Fixed 2026-11-19 (commit dd1fa28):** a blank wording prints the prompt.
35. **Wording:** the FAA key notice says "(1 days remaining)"; more than two oil readings show zod's "Too big: expected array to have <=2 items"; the domain says "Template belongs to another program." where the server says "…another Flight Program." (see also 20). **Fixed in part 2026-11-19 (commit 257ceac):** the day count and the template refusal.
36. **Bug: validation errors show zod's JSON** ("Look up address" with a blank street; `logbookPhrasesSchema` in LogbookWording; `licenseSchema` in LogbookEntry). `errorText` passes a ZodError's message through. Batch 419. Batch 419 fixes `errorText`. Batch 425 covers task CSV row errors, which embed zod's JSON in a `Rejection` message ("CSV row N: [ … ]"), and zod's default wording.
37. **Possible crash:** `flightLogImport` `loggedFlights` assumes every logged flight's aircraft is in the snapshot (`find(...)!`). Under review in domain-b. **Resolved: not reachable.** `scopedSnapshot` filters flights by the same visible aircraft, and no code deletes an aircraft.
38. **Duplicates found in Batches 65–261:**
    - the job-card reset in `convex/workOrderCopies.ts` and `src/domain/workOrderCards.ts`, which also choose templates differently (the server matches `workTaskUuid` too);
    - the "AD no longer applies" list in `adRemaining`, `forecast` and `airworthiness`;
    - each meter's start and end readings in `forecast`, `costs`, `flightLogImport` and `FlightFluids.tsx`;
    - the 400-document limit in `faaSearch`, `faaMonitoringSearch` and `faa` (see 21);
    - "Job cards are still being prepared…" in `convex/workOrders.ts` and `convex/workOrderCopies.ts`;
    - the "Certificate / license:" line and the "Performed" default copied into `LogbookEntry.tsx`;
    - the 2 MB CSV limit in `TaskCsvImport.tsx` and `parseTaskCsv`, and a second BOM strip and byte check in `componentTemplates`;
    - the PO and parts-request PDF text flow (T17 b2);
    - the demo's `":all"` snapshot suffix in three files;
    - `runCommand`'s private `exposed()` beside `convex/userErrors.ts`;
    - `deletePermissionGroup` repeating `groupDeletion.remove`'s "changed" check.
39. **Kept long, for later batches:** `src/data/store.ts` (the store literal is 211 lines, `initialize` 58, `enqueue` 62, and `flushPass` nests 3 deep); `scripts/backup/recordsWorkbook.ts` (Batch 420); `scripts/backup/exportFixture.ts` (Batch 421).
40. **Smaller notes:**
    - `local.readFavorites` and `saveFavorites` are general string-list settings that `alerts.ts` also uses;
    - ~~`importADDocx` would list a nested table's rows twice~~ (fixed 2026-11-19, commit dff6963);
    - the "correction would change lifetime tracking" refusal can't be reached with today's fixtures;
    - `InventoryAttachments.tsx` has an old `set-state-in-effect` lint warning;
    - `.github/workflows/first-time-setup.yml` has no batch (it already passes the header check);
    - `validateComponent`'s TSDoc still says `@throws {Error}`.
41. **Tooling (owner only):** `check-standards.mjs --changed-since` diffs against the ref's tip, so locally a branch that is behind main reports main's files. It should diff from the merge base. CI is unaffected.
42. **Flaky only when lanes saturate the CPUs:** `convex/manuals.test.ts`, and the records-workbook command-line test (5 s timeout).
43. **Over the ~50% size guide, from splitting long functions or documenting bare exports:** Batches 73, 80, 82 and 165; `faaSearch`, `poFiles`, `inventoryFiles`, `inventoryPrintDocument`, `local`, `poPdf` and `partsRequestPdf`.
44. **Owner decision: job cards imported from a CSV write no change-log rows** (`convex/taskImports.ts` replays `snapshot.audit` only), while `taskCards.save` logs `taskCard.save`. This is pinned in `src/domain/taskCsv.test.ts`. Decide together with 33. **Fixed 2026-11-19 (commit 20c43b6).**
45. **Still "Server Error":**
    - "Report not found." for discrepancy resolve and defer;
    - the generic add-work-item "Work item is unavailable for this aircraft." (Batch 254);
    - `taskCards.upload`'s file check, which isn't wrapped in `exposeRejections` (T4 b4);
    - `reviewFlight`'s checklist-link refusal (T11 b3).
46. **Duplicates found in Batches 90–357:**
    - PR numbering in `recurringParts` (`createNumberer`) and `partsRequests`;
    - the 2 MiB CSV limit in four modules, some counting bytes and some characters, with messages that say "MB";
    - the `/inventory` label path in `inventoryPrinting` and `inventoryScan`;
    - the component lookup in `airworthiness` and `adOwnership`;
    - the status strings in `alerts`, `ownerDue` and `aircraftStatus`;
    - the payload-only patch loops `patchStock` and `patchRequests`;
    - the 5,000-character limit in `operations.ts` and `deferrals.ts`;
    - email pattern, name limit and Observers match in `convex/admin.ts` and `convex/programUsers.ts` (admin counts the untrimmed name; T16);
    - domain limits copied into components because they aren't exported (`OVERRIDE_REASON_MAX`, rating kinds, certificate-number and name lengths, budget years, correction limits);
    - `dispatchBlocked` in `AircraftStatus.tsx` repeating `dispatchGate`'s reason rule;
    - `ui.tsx`'s `useBusyAction` copied as `useTask` in `FaaSearchImport.tsx`;
    - the 500-assignment limit;
    - the repair and overhaul reset rule in `LogbookSample.tsx`;
    - `faaMonitoringSearch` repeating `faa.ts`'s 400 cap and batch size of 10.
47. **Dead or unreachable code:**
    - `assertNewManagementUuid` (delete in 266);
    - `ownerDueCounts` (no callers);
    - management's "Select an existing stock location." and "Aircraft not found.";
    - the audit guard in `convex/costs.ts`;
    - `admin.ts` had two unreachable checks, removed in Batch 357, with the refusals pinned.
48. **Bug (not fixed): the records workbook can crash on a damaged record** it is meant to show "as stored": 16 of 40 deliberately damaged exports crash, on the old code and the new (for example "TypeError r.history is not iterable"). Needs a failing test and a fix in T8.
49. **Decisions for Batch 319 (T15 b3):** `addInspectionTask` leaves the duplicate check to `saveWorkOrder`, after the component-movement checks, while `startCopy` checks duplicates first and never runs those movement checks. Moving the server onto the domain path changes which message wins when both apply.
50. **Test coverage gaps:**
    - no browser spec covers `/planning`, the work-order costs panel, the inventory scanner or the close-out correction;
    - `flightTimeLog.test.ts` and `helicopter.test.ts` are near copies;
    - 52 specs repeat the demo sign-in line (a shared fixture is a separate decision);
    - `aircraft-status-export.spec.ts` writes a PDF that nothing reads.
51. **Notes:**
52. **Owner decisions (new):**
    - **Batch 311:** redesigning the AD worksheet, which copies CompReport_N626KB.docx, needs sign-off.
    - **Test tooling:** add `happy-dom` and Testing Library (`package.json`), so component tests stop mocking React internals.
    - **`credentialMigrations` table:** it is unused since Batch 411. Dropping it needs the table to be empty in production.
53. **Still "Server Error":**
    - licence, certificate and other server zod refusals (Batch 422);
    - on the add-inspection and copy-templates commands, the component-movement and completion refusals (plain `Error` from `src/domain/workOrders.ts`). After finding 49 the movement message wins, so production shows "Server Error" when both apply. The T10 sweep (254) covers it.
54. **Leftovers from Batches 264–424:**
    - the `openStoredSecret` pass-through (Batch 322 is in, so it can go);
    - `faaCredentials.verifyWithFaa`, a second DRS client;
    - `memberships:backfill`, kept because three suites seed with it;
    - `resolveExplicitEvents`, dead on fresh data;
    - Batch 414 also spans `admin.ts`, `demoBackend.ts` and `PermissionGroupForm.tsx`;
    - `recurringParts.ts`, now a pass-through, and the demo loop after `applyRequestCommand`, now dead (315 and 316);
    - `convex/recurringParts.ts` restating the matching rule (315);
    - `Command.delegate`, unused after 319;
    - `convex/workOrders.ts` re-throwing three refusals as `ConvexError` (T10 b3 deletes it);
    - T18's contract step must copy `managementRequests` rows first, and `exportFixture` has no `commandRequests` row;
    - `assertEditable` repeating "Job cards are still being prepared…".
55. **Records workbook:**
    - ~~damaged-record notes are generic, because `decodeLenient` drops zod's issues~~ (fixed 2026-11-19, commit ae51364);
    - aircraft, flights, discrepancies, inspections and groups are cast without validation;
    - ~~Change history loses a damaged record's name~~ (fixed 2026-11-19, commit ae51364);
    - Change history used to print licence and account numbers held in change-log values. Batch 307's fix hides them.
56. **Duplicates found in Batches 182–424:**
    - the UTC formatter in `statusSheet` and `aircraftStatusReport`;
    - `patchStock` and `patchRequests`;
    - `addresses.ts`'s own copy of the "each message once" rule;
    - `useBusyAction` copied as `useTask`;
    - specs repeating the manual upload (5), the jsPDF builder (2), the demo with the service worker ready (2), `becomeMember`, `createLocation`, Issue then Finalize PO, and `delete s.partsInventory` (6).
57. **Coverage and quirks:**
58. **Fixed during Batches 254–426:**
    - the server's \"add missing job card templates\" on a completed item (a regression from 319, fixed before main);
    - a flight review couldn't clear the copilot;
    - the identical repair-request resend;
    - unsealed credentials were accepted at save time;
    - the address directory kept a stale error;
    - the owner portal failed on one unreadable inspection;
    - one unreadable item failed the parts plan;
    - flight-plan flags measured component inspections on aircraft hours;
    - AD status and counters read the clock;
    - the logbook preview differed from the signed entry;
    - the records workbook crashed on damaged records;
    - the demo let anyone resolve a discrepancy or review a flight.
59. **Still open:**
    - ~~`PermissionGroupForm.tsx:124` keeps the retired unscoped-group note~~ (fixed 2026-11-19, commit 1edf2f4);
    - `src/domain/work-order-closeout/closeout.ts:58` and `readings.ts:36` say `@throws {Error}` for `Rejection`s;
    - the \"Applicable / PCW\" list is defined in `airworthiness`, `partsPlanning`, `workOrders` and `adWorkOrders`;
    - the component label formula appears twice;
    - the preview of a completed order;
    - ~~the demo still differs from the server on: audit rows for saved addresses, FAA and program select; FAA wording and the monitor cap; the demo's `createUser` admin check; unknown group ids; PO attach wording; the evidence audit shape~~ (fixed 2026-11-19, commit cd5f091: `runFaaCommand`, `selectProgram`, `assertAccountAdministrator`, `assertKnownGroups`; saved addresses were already audited);
    - the file-to-data-URL conversion is written four times in `demoBackend.ts`.
60. **User-visible suggestion:** Dashboard search ignores the aircraft make (\"cessna\" finds nothing). **Fixed 2026-11-19 (commit d4bf151).**
61. **`Field` gives its label's `id` to its child through `cloneElement`,** so a wrapped control silently loses the label. Two lanes hit this; the markup comparison caught both times.
62. **Owner decisions from Batches 266–426:**
    - **Job-card sign-offs:** the list and the editor offer different sign-offs. A signed card set back to Draft keeps its sign-offs, and the editor then offers an Inspection sign-off the server refuses. The editor also allows re-signing. Both rules are pinned as `signoffsOfferedInList` and `signoffsOfferedInEditor`. **Fixed 2026-11-19 (commit e72c57a):** both offer exactly the signoffs the server accepts, and Draft clears them.
    - **Dashboard AD panel vs alerts and digest:** the panel lists ADs that are \"Needs review\", \"Due not set\" or \"Counter unavailable\"; the alerts and the digest only alert overdue or due-soon actions. Both lists are pinned: `DASHBOARD_SETTLED_AD_STATUSES` and `ALERTS_SKIPPED_AD_STATUSES`. **Fixed 2026-11-19 (commit 7602179):** one list, `SETTLED_AD_STATUSES`, with a For review alert.
    - **AD register:** it hides the work-order button when the AD's overall status is \"Due not set\" or \"Counter unavailable\", even if one of its actions is due. **Fixed 2026-11-19 (commit f13ecef).**
    - **\"Check FAA now\":** the button blocks for 5 minutes, against the server's 1-minute rule. **Fixed 2026-11-19 (commit a2257dc).**
    - **Status sheet PDF colours:** cells are coloured by their text, so an AD's \"Due soon\" prints in plain ink. **Fixed 2026-11-19 (commit 9bfd107).**
    - **Records workbook:** the AD sheet leaves Not applicable and Superseded ADs uncoloured. **Fixed 2026-11-19 (commit 9bfd107).**
    - **Correction addendum:** no full stop after a description that lacks one. This is record text. **Fixed 2026-11-19 (commit 8662242).**
    - **Dashboard search:** it ignores the make. **Fixed 2026-11-19 (commit d4bf151).**
    - **Planning CSV:** the Status column exports raw codes. **Fixed 2026-11-19 (commit 31d336b).**
    - **Scanner:** a camera no-match shows its refusal under the typed-code form, and the camera keeps running. **Fixed 2026-11-19 (commit ebe8ef5).**
    - **Idempotency:** whether parts requests and purchase orders should join `commandRequests`.
63. **Robustness in damaged data only** (the aircraft form refuses this state): an aircraft meter with no reading still breaks the flight-plan queue, the Aircraft page, the Inspections page, the owner portal, the Dashboard with a time-limited component, and the status sheet. They read the total directly. A `model.ts` helper returning \"total time, or undefined without a reading\" would serve them all. 26 damaged exports still stop the workbook with TypeErrors, unchanged.
64. **Small duplicates left after the final round:**
65. **Final round (after checkpoint 7):**
    - **Shared definitions:** the serviceable conditions, the currency-code pattern (`src/domain/currencyCode.ts`), `MAX_CORE_DUE_DAYS`, `CSV_MAX_BYTES`, `SECONDS_PER_HOUR` in five screens, and `TASK_TEXT_MAX_LENGTH` each have one definition.
    - **Downloads:** they go through `download()` and `downloadBlankCsv()`.
    - **Records workbook:** its unreachable AD workaround is gone (byte-identical output).
    - **Change log:** flight submission, flight review, work-order summary and management transfer rows carry `programUuid`, built by `auditEntry`. There is one oldest-first replay helper.
    - **Damaged data:** an aircraft meter without a reading no longer breaks flight plans, the owner portal, the status sheet (an aircraft with no inspections) or the Inspections page. It shows \"Not recorded\" or Unknown, and completing an inspection on it is still refused.
66. **Safety note (damaged data only), fixed 2026-11-09 (RM-66):** `inspectionCounters` read the aircraft total even for a calendar-only inspection, so on an aircraft meter without a reading an inspection overdue by date showed as Unknown and didn't ground the aircraft. `aircraftSecondsFor` now tolerates the unreadable meter when the inspection sets no hours limit; completing an inspection still needs the reading, since it becomes the next baseline. Pinned by `withoutMeterReading` (`i-calendar-unread`) in `tests/fixtures/dueFleet.ts`.
67. **Owner decisions, from this checkpoint:**
    - `activateTemplate` gives new requirements warnings of 10 h, 10 cycles and 1 month; the Components form starts at 25 h, 10 cycles, 10 landings and 1 month (`REQUIREMENT_WARNING_DEFAULTS`). **Fixed 2026-11-19 (commit 3053bfd):** templates use the same defaults.
    - The transfer reason's 2,000-character limit is enforced only in the form; `TRANSFER_REASON_MAX_LENGTH` is exported, and the server accepts longer reasons. **Fixed 2026-11-19 (commit d7a1a66).**
68. **Leftovers for a later pass:**
    - `SECONDS_PER_HOUR` copies in about 20 more modules, including a second export in `costs/units.ts`;
    - screens re-implementing `readings.ts` helpers;
    - total-time reads still direct in `Fleet.tsx`, `FlightSession.tsx`, `Components.tsx`, `LogbookSample.tsx`, `WorkOrders.tsx` and `adReport.ts`;
    - change-log rows written through `access.audit()` (accounts, attachments, manuals, FAA) carry no program, and `inspection.*` rows' `before` still holds Convex system fields;
    - the work-order summary row is composed twice (mutation and demo);
    - `COMPONENT_TYPES` is listed twice;
    - the inspection description and materials limits aren't exported;
    - the manual-candidate and template duplicate-schedule checks are near twins;
    - `adLevel` no longer needs exporting;
    - `InventoryAttachments` `saveCopy` could use `download()`.
    - the low-stock rule in `Dashboard.tsx`, to use `needsReorder`;
    - `assertWritable` and `workItemCompletionIssue` restating `isPreparingJobCards`;
    - `PlannedNeeds` matching in `Management.tsx`;
    - `SECONDS_PER_HOUR` copies in screens;
    - copies of `SERVICEABLE_CONDITIONS`;
    - the currency regex, written four times;
    - CSV limits;
    - the remaining blank-CSV and download call sites;
    - limits copied into `Components.tsx`, `ManualDiscovery.tsx` and `Fleet.tsx` (the part 2s);
    - the workbook's now-unreachable AD workaround in `dueList`;
    - ~~a request uuid kept for the life of the inspection form, so an edited retry is refused~~ (fixed 2026-11-19, commit a3d0ea5).
    - no browser spec covers `/planning`, the work-order costs panel, the inventory scanner or the close-out correction;
    - `tests/fixtures/componentMovement.ts` has an unreachable guard;
    - `inventory-printing.spec.ts` writes a PNG outside `test-results`;
    - ~~`resequenceReason` labels an offset start time as UTC~~ (fixed 2026-11-19, commit 8675ab6; the held-flight review's "Flight time (UTC)" had the same fault, fixed 2026-11-20, commit 468d37a);
    - ~~flight review now shows administrators "Inspection component not found." (a data-integrity message)~~ (fixed 2026-11-19, commit 60d7cd3);
    - ~~an unknown sign-in provider gets the Microsoft logo~~ (fixed 2026-11-19, commit 1ffc486).
    - the common-password list is loaded on the server's sign-in path; its header is corrected;
    - the `users` table drops Convex Auth's `phone` index, which is safe and now commented;
    - ~~an unknown sign-in provider gets the Microsoft logo~~ (fixed 2026-11-19, commit 1ffc486);
    - the logbook preview passes "[completion date]" as a licence as-of date (harmless).
69. **Snapshot cost, left after the size fixes (SZ-1, 2026-11-10):** measured by `convex/snapshotCost.test.ts`; the real fix is the retention window in the size design.
    - `inventoryAttachments` (`convex/operations.ts`) still looks files up once per stock or component record for administrators (about 900 lookups at the test volume). Its count follows the inventory, not the years, and transfers re-tag stock, so a stored program key could go stale; key the rows by program only together with the transfer path.
    - `filesByRecord` reads evidence and work-order files stored without an aircraft once more on every snapshot, across programs. Remove that read once `attachments:backfillAircraft` has run on every deployment.
    - `adAircraftUuid` (`src/domain/adOwnership.ts`) and `partsInventory` (`src/domain/requiredParts.ts`) still scan the managed records once per AD or record while the snapshot is scoped.
    - The board view reads every job card so its cost totals can price parts issued against them; a stored per-work-order cost total would remove that read. **Update 2026-11-20 (D13):** each issue since D13 is on its work order's cost record (`issuedParts`: request, time, date, quantity, unit cost), so the totals no longer need the job cards or parts requests for those; issues made before D13 still do. The board, which cannot read stock costs, leaves those older issues out of its totals unless a manual unit cost prices them, so its totals can be lower than the Costs screen's for the same period. **Done 2026-11-20 (history paging S4):** the board totals from the cost ledger and reads no job card, request or work-order cost record. Issues from before D13 still count only at a manual unit cost, on the board and in the ledger.
70. **Shared design layer, left after the redesign foundation (2026-11-11):**
    - `src/components/design.tsx` is about 1,250 lines with two responsibilities: presentational building blocks, and the dialog with its discard guard and history blocker. The dialog (`Dialog`, `DialogFrame`, `markFormFilled`, `setDialogHistory` and their hooks) passes the deletion test as its own module, `dialog.tsx`, re-exported from `design.tsx` so imports stay as they are.
    - `--navy`, `--brand-blue`, the `--on-navy-*` tokens (`src/styles/tokens.css`) and `RoundButton`'s `onNavy` are kept only for the dark panels of screens not yet moved to the white language (`dashboard.css`, `operations.css`, `checklists.css`). Remove them when no screen sheet uses them.
    - `.tabs`, `.search`, `.stats`/`.stat`, `.row-icon` and `.empty` in `src/styles.css` duplicate `Segmented`, `SearchField`, `KpiStrip`, `IconTile` and `EmptyState`; move their callers to the components and delete the classes.
71. **Runtime import cycles among domain modules (D13, 2026-11-20):** `programs.ts` imports `partsRequests.ts` and `reducedViews.ts`, and both lead back to it (`partsRequests.ts` directly; `reducedViews.ts` through `boardView.ts` and `costs/workOrderCosts.ts`). These cycles work only because the modules read each other inside functions. `partsRequests.ts` cannot import the `./costs` barrel (through `costs/report.ts` it reaches `flights.ts`, whose top-level label table reads a module still loading) nor `costs/commands.ts` (through `workOrders.ts` it reaches `taskCards.ts`, whose schema reads a module still loading), so it imports `costs/issuePrices.ts` directly, and `saveCostRecord` moved to `costs/save.ts` for it. Moving `isOpenWorkOrder` and the closed-status list (also copied as `CLOSED_WORK_STATUSES` in `partsRequests.ts`) into a small work-order status module would let the cost appliers stop loading `workOrders.ts`.

72. **The Costs report reads the cost ledger (history paging S4, S6).** **Done 2026-11-20:** the Costs page, its budget bar and an aircraft's cost summary read `history.costReport` (`src/data/costReports.ts`), so they and the board total spending alike. Left: the client's change-log visibility rule for cost rows (`src/domain/programs.ts:493`) still reads the workspace's cost records, while the server's reads them by uuid (S4); and `aircraftCostReport`, `budgetStatus` and `costReportCsvRows` (`src/domain/costs/report.ts`) now serve only their tests and the work-order panel's pricing rules they pin, so retire or narrow them now that S7 has landed (2026-11-20). See [history paging](docs/history-paging.md#the-windowed-workspace-s7).

73. **What the windowed workspace still reads more of than it needs (history paging S7, 2026-11-20).** (a) Job card evidence and work-order files are read by kept record, one index range per kept job card: 2,474 ranges for an administrator at the size test's volume, of Convex's 4,096. A `workOrderUuid` column on `taskEvidence` (set on upload, patched when a card joins an order) would read them per kept order. **Done 2026-11-20 (S8):** evidence carries its card's work order and an inventory file its item's program (`convex/fileColumns.ts`), read by order and by program: 580 ranges for an administrator at that volume, 404 in the load test. (b) Job cards changed in the window are read twice, once to find their orders and again with every card of each order (`convex/historyWindow.ts`); about 0.7 MiB at that volume. (c) Parts requests, purchase orders and flight plans stay complete (H5) and grow the snapshot by 0.64 MiB a year there, past 16 MiB at about 13 years: the size target needs H5 revisited. **Measured 2026-11-20 (S8):** the load test at 20 fleet-years puts it at 0.85 MiB a year and about 11 years, with the parts request and purchase order saves over 4 MiB from about five; the costed option is in the history-paging plan, for Aaron (H5). **Done 2026-11-20 (H5 option A):** closed requests, orders and plans leave the workspace (`src/domain/purchasingWindow.ts`, `convex/windowedPurchasing.ts`); at the size test's volume the administrator's snapshot reads 7.94 MiB at one, two and three fleet-years (7.98 to 9.33 before), the pilot's 4.37 (4.75 to 6.10). **Measured on the H5 release (load test, 20 Nov):** 7.27 MiB at one fleet-year and 8.84 at twenty, every snapshot succeeding. (d) A record's request list cannot match a request raised on a work-order task whose order the window left out, and says so (`OlderOrderRequests`, `src/components/PartsRequests.tsx`); storing the task's source on the request would remove the lookup. **Partly done 2026-11-20 (H5):** a record's older requests page in matched on the server (`history.partsRequests` with a `source`), so the note counts only the requests the workspace keeps. See [history paging](docs/history-paging.md#the-windowed-workspace-s7).

74. **Reads the S8 load test found growing or near a limit, outside H5 (2026-11-20).** (a) ADs keep their whole compliance history in the record, and component movements stay complete: about 0.1 MB a year at the size test's volume in every view, the owner's and board's included (0.24 to 0.63 MiB returned over 20 years for an owner). A compliance-history page, like the window's, would flatten them. (b) The Weekly summary loads the complete collections and scans up to 4,000 change-log rows: 5.7 MiB for seven days at one year, about 15 MiB whenever a period reaches the 4,000-row cut, at 90 to 94% of Convex's 16 MiB; a byte budget beside the row budget would end such a period short instead of failing. **Done 2026-11-20 (Aaron's option A):** it read each row up to seven times (the program's index and each aircraft's, round after round, past the period's start); it now reads each once within the period, an aircraft's index only when the program's misses rows of it (new `audit` index `aircraftProgram`), and stops at 3 MiB read (`SUMMARY_READ_BUDGET`). In the unit fixture a week reads 1.88 → 0.84 MiB, a month 5.23 → 1.26 MiB, and a year, cut short, 7.34 → 3.01 MiB. In the load test (H5 release) a week reads 1.75 to 2.90 MiB from one to twenty fleet-years, never cut short; a month is cut short at 20 years, where what (a) grows leaves less of the 3 MiB for rows. Left: History's program-wide pages (`auditHistory.page`) still read every readable aircraft's index beside the program's and re-read rows round by round; the summary's merge (`PeriodMerge`) would serve them too. The records the visibility rule loads whole grow with component movements (a). (c) A page of older work orders carries every job card of each order: 3.4 MiB and up to 317 ms for 50 orders (H5 release sweep); a smaller page for work orders would halve both. (d) Accepting a held flight replays every flight of its aircraft: refused at one second at 20 years (S9), measured again on the H5 release. See [history paging](docs/history-paging.md#measured-at-20-fleet-years-s8-h5-release).

75. **What the purchasing window (H5) still reads more of than it keeps (2026-11-20).** (a) A repair, or a restock received rather than issued, is settled by its orders' receipts, which its own row cannot show, so it has no `settledAt` and the snapshot reads it, with an allocation lookup and its orders, for good: reads grow by every such request. A `suppliedAt` column the order's receipt writes onto the request row (kept by `writeChanged`, filled by the backfill) would settle them. (b) The orders whose lines name a kept work order are not kept; a screen listing a work order's orders would need them, through a key of its own in `purchasingKeys`. (c) Offline, History filters the device's recent entries by what it holds, so entries about older purchase orders and requests for stock drop out there, as finding 72's cost rows do. (d) Vendor names typed only on older orders or requests drop out of the vendor suggestions until saved as vendors. (e) **Done in the H5 release:** the parts request and purchase order saves read by lookup key (finding 76), and the window's own allocation table was folded into those keys, so one derived table holds the request ↔ order link. See [history paging](docs/history-paging.md#the-purchasing-window-h5).

76. **What the bounded purchasing saves (H5, 2026-11-20) leave.** **Done:** every parts-request and purchase-order command reads the requests and orders it names, by uuid or by a derived lookup key (`convex/purchasingKeys.ts`), and reads the same at one to three fleet-years ([history paging](docs/history-paging.md#parts-requests-and-purchase-orders-h5)). Left: (a) both still load stock, components with their movement records, and inspections whole, and a request the ADs too, which ADR-0013 keeps complete; an AD found by its task's uuid would need a key of its own. (b) The work order save's recurring parts (`convex/recurringParts.ts`) still find lists among the requests on its items' records (`[sourceUuid]`), which also reads every request raised directly on those inspections or tasks; the `list` key would bound it. (c) Which records each purchasing rule reads is now known twice: by the rule in `src/domain/partsRequests.ts` and `purchaseOrders.ts`, and by the loaders in `convex/partsRequests.ts` and `convex/purchaseOrders.ts`. A rule that starts reading another request or order needs its loader changed too; `convex/purchasingCommands.test.ts` holds today's rules. A domain-declared "needs" function, as `recurringPartsNeeds` is for recurring lists, would keep it in one place. (d) **Measured on the H5 release (load test, 20 Nov):** the parts request and purchase order saves read 1.22 and 0.86 MiB at one fleet-year and 3.33 and 1.69 at twenty (S8: 13.29 and 11.66), all of the growth from (a): about 0.11 and 0.04 MiB a year.
77. **`signTaskCard`'s "save today's date, then sign" branch cannot be reached from a button (docs review, 2026-11-20).** `src/domain/signTaskCard.ts` saves today's local date on a card with a blank completion date before a technician or inspection signoff, and `signTaskCard.test.ts` pins it. Since `e72c57a` (2026-11-19) both job-card screens disable those signoffs whenever `signoffRefusals` gives a reason, and a blank date is one ("Enter a completion date (today or earlier) before signing or completing this job card."), so no caller passes a card without a date (`src/components/TaskCards.tsx`, both sign buttons; `tests/e2e/task-cards.spec.ts` pins the disabled buttons). The Completion date hint and the docs say the date is required, which matches the screens. Options: delete the branch and its test case, leaving `signTaskCard` a single `sign` command; or restore the fill-in by not treating a blank date as a refusal on the screens (a future date still refused) and changing the hint and docs back. **Done 2026-11-20 (Aaron's decision 1A):** the branch is deleted with `signTaskCard.ts` and its test, since a single `sign` command left nothing to hide; both screens send the `sign` command directly. A date must be entered before signing, as the screens already required.
78. **The logbook photo control's file picker hides PDFs the upload rule accepts (docs review, 2026-11-20).** `LogbookPhotoControl` (`src/components/LogbookPhotos.tsx`) has `accept="image/*"` with `capture="environment"`, and `LogbookPhotos.test.ts` pins the pair as "offers the rear camera". `validateLogbookPhoto` (`src/domain/aircraftFiles.ts`) accepts PDF, JPEG, PNG and WebP, so on a computer a PDF is chosen only after switching the picker to "All files" (the wiki says so). Listing the rule's types in `accept` is not a text fix: Chrome on Android is believed to open the camera directly only for `image/*` alone and to show a Camera-or-Files chooser otherwise, and iOS may differ; neither was tested on a phone. Options: (1) leave it; (2) set `accept` to the rule's types and accept the extra tap on Android, after a phone test; (3) keep the camera button and add a second "Choose a file" input with the rule's types. Aaron's decision; the code is unchanged.
79. **Two commands that can create an urgent state still wait for the daily alert check (SE-15, open part; docs review, 2026-11-20).** `ff5c564` made template activation and transfers schedule the urgent check, and `82987da` an FAA key renewal-date change. `apply` in `convex/componentTemplates.ts` (applying a component template) and `command` in `convex/faa.ts` (accepting FAA candidates) still do not call `scheduleUrgentAlerts`, so an overdue component or AD they create is emailed and pushed only after the next daily run. Low: the daily run bounds the delay. The fix is one call in each after the write, with a test like `convex/faaCredentials.test.ts`'s. The code is unchanged.

## Tier 1: foundation and leaf modules

Dependency order: modules with no internal imports first, most-imported first. Each batch is a module with its colocated test, or up to three small sibling modules.

- [x] Batch 1 (domain-a): `src/domain/addresses.ts`, `src/domain/addresses.test.ts`
- [x] Batch 2 (domain-b): `src/domain/ata.ts`, `src/domain/csv.ts`, `src/domain/accountRules.ts`
- [x] Batch 3 (domain-a): `src/domain/aircraftSpruce.ts`, `src/domain/aircraftSpruce.test.ts`
- [x] Batch 4 (server): `convex/memberships.ts`, `convex/memberships.test.ts`
- [x] Batch 5 (server): `convex/secrets.ts`, `convex/secrets.test.ts`
- [x] Batch 6 (domain-b): `src/domain/signInMethods.ts`, `src/domain/signInMethods.test.ts`
- [x] Batch 7 (domain-a): `src/domain/logbookWording.ts`, `src/domain/logbookWording.test.ts`
- [x] Batch 8 (domain-b): `src/domain/componentCalendar.ts`, `src/domain/componentCalendar.test.ts`
- [x] Batch 9 (domain-a): `src/domain/offsiteBackups.ts`, `src/domain/offsiteBackups.test.ts`
- [x] Batch 10 (ui-a): `src/styles/screens/maintenance.css`
- [x] Batch 11 (server): `convex/validators.ts`
- [x] Batch 12 (domain-b): `src/domain/releaseStatements.ts`, `src/domain/aircraftPhotos.ts`, `src/domain/flightChecklistSchema.ts`
- [x] Batch 13 (ui-b): `src/styles/screens/dashboard.css`
- [x] Batch 14 (ui-a): `src/styles/screens/operations.css`
- [x] Batch 15 (server): `convex/rateLimits.ts`, `convex/attachments.ts`, `convex/storageReferences.ts`
- [x] Batch 16 (ui-b): `src/components/costs.css`, `src/components/engineTrends.css`, `src/components/ScheduleTracking.tsx`
- [x] Batch 17 (platform): `src/data/flightPlanDiagnostics.ts`, `src/data/flightPlanDiagnostics.test.ts`
- [x] Batch 18 (ui-a): `src/styles/screens/admin.css`
- [x] Batch 19 (platform): `scripts/backup/convexExport.ts`
- [x] Batch 20 (ui-b): `src/components/adRegister.css`
- [x] Batch 21 (ui-a): `src/components/checklists.css`
- [x] Batch 22 (ui-b): `src/components/ComponentIcon.tsx`, `src/components/drsComboBox.css`, `src/components/faaSearch.css`
- [x] Batch 23 (ui-a): `src/components/InspectionIcon.tsx`, `src/components/MissionSlogan.tsx`, `src/components/partsRequests.css`
- [x] Batch 24 (ui-b): `src/components/pdfReader.css`, `src/components/planning.css`, `src/components/purchaseOrders.css`
- [x] Batch 25 (platform): `src/data/pdfText.ts`, `src/data/logbookPdf.ts`, `src/data/pdfCompatibility.js`
- [x] Batch 26 (ui-a): `src/styles.css`
- [x] Batch 27 (ui-b): `src/styles/design.css`
- [x] Batch 28 (ui-a): `src/styles/screens/flight.css`
- [x] Batch 29 (ui-b): `src/styles/screens/records.css`
- [x] Batch 30 (ui-a): `src/styles/screens/settings.css`
- [x] Batch 31 (ui-b): `src/styles/screens/shop.css`
- [x] Batch 32 (ui-a): `src/styles/tokens.css`
- [x] Batch 33 (server): `convex/auth.config.ts`, `convex/crons.ts`, `convex/sampleDocuments.ts`
- [x] Batch 34 (platform): `scripts/backup/dropbox-upload.mjs`
- [x] Batch 35 (platform): `scripts/backup/nightly.sh`
- [x] Batch 36 (platform): `scripts/backup/nightly.test.sh`
- [x] Batch 37 (platform): `scripts/bootstrap-admin.mjs`, `scripts/check-csp-origin.mjs`, `scripts/configure-auth.mjs`
- [x] Batch 38 (platform): `scripts/peer-testing-transfer.mjs`
- [x] Batch 39 (platform): `scripts/serve-dist.mjs`
- [x] Batch 40 (platform): `scripts/setup-peer-testing.sh`
- [x] Batch 41 (platform): `scripts/smoke-local.mjs`
- [x] Batch 42 (ui-b): `src/components/FlightParts.tsx`
- [x] Batch 43 (domain-a): `src/domain/passwordRules.ts`, `src/domain/passwordRules.test.ts`
- [x] Batch 44 (domain-b): `src/domain/workOrderCloseoutSchema.ts`, `src/domain/savedAddresses.ts`, `src/domain/addressLookup.ts`
- [x] Batch 45 (server): `convex/secretsMigration.ts`
- [x] Batch 46 (domain-a): `src/domain/model.ts`
- [x] Batch 47 (domain-b): `src/domain/programs.ts`
- [x] Batch 48 (domain-a): `src/domain/flights.ts`
- [x] Batch 49 (domain-b): `src/domain/inspectionTemplates.ts`, `src/domain/inspectionTemplates.test.ts`
- [x] Batch 50 (domain-a): `src/domain/checklists.ts`, `src/domain/checklists.test.ts`
- [x] Batch 51 (domain-b): `src/domain/requiredParts.ts`, `src/domain/requiredParts.test.ts`
- [x] Batch 52 (domain-a): `src/domain/fleet.ts`, `src/domain/fleet.test.ts`
- [x] Batch 53 (domain-b): `src/domain/aircraftStatus.ts`, `src/domain/aircraftStatus.test.ts`
- [x] Batch 54 (domain-a): `src/domain/certifications.ts`, `src/domain/certifications.test.ts`
- [x] Batch 55 (domain-b): `src/domain/faa.ts`
- [x] Batch 56 (domain-a): `src/domain/flightPlans.ts`, `src/domain/flightPlans.test.ts`
- [x] Batch 57 (domain-b): `src/domain/shelfLife.ts`, `src/domain/shelfLife.test.ts`
- [x] Batch 58 (domain-a): `src/domain/maintenance.ts`, `src/domain/manuals.ts`, `src/domain/inventoryAttachments.ts`
- [x] Batch 59 (domain-b): `src/domain/maintenanceCsv.ts`, `src/domain/maintenanceCsv.test.ts`
- [x] Batch 60 (domain-a): `src/domain/aircraftFiles.ts`, `src/domain/aircraftFiles.test.ts`
- [x] Batch 61 (domain-b): `src/domain/deferrals.ts`, `src/domain/deferrals.test.ts`
- [x] Batch 62 (domain-a): `src/domain/workOrderComponentWork.ts`, `src/domain/workOrderComponentWork.test.ts`
- [x] Batch 63 (domain-b): `src/domain/engineTrends.ts`, `src/domain/engineTrends.test.ts`
- [x] Batch 64 (domain-a): `src/domain/manualDiscovery.ts`, `src/domain/manualDiscovery.test.ts`
- [x] Batch 65 (domain-b): `src/domain/ownerView.ts`, `src/domain/ownerView.test.ts`
- [x] Batch 66 (domain-a): `src/domain/componentInventory.ts`, `src/domain/componentInventory.test.ts`
- [x] Batch 67 (domain-b): `src/domain/flightFluids.ts`, `src/domain/flightFluids.test.ts`
- [x] Batch 68 (domain-a): `src/domain/workOrderCards.ts`, `src/domain/workOrderCards.test.ts`
- [x] Batch 69 (domain-b): `src/domain/componentTemplates.ts`, `src/domain/componentTemplates.test.ts`
- [x] Batch 70 (ui-a): `src/components/WorkOrderIcon.tsx`, `src/components/ShopList.tsx`, `src/components/OpsList.tsx`
- [x] Batch 71 (domain-a): `src/domain/faaCredential.ts`, `src/domain/faaCredential.test.ts`
- [x] Batch 72 (server): `convex/ssoProviders.ts`, `convex/spruceHttp.ts`, `convex/accountGuards.ts`
- [x] Batch 73 (domain-b): `src/domain/workOrderComponentCorrections.ts`, `src/domain/workOrderComponentCorrections.test.ts`
- [x] Batch 74 (platform): `src/data/flightPlanPdf.ts`, `src/data/flightPlanPdf.test.ts`
- [x] Batch 75 (domain-a): `src/domain/workOrderTaskRemoval.ts`, `src/domain/workOrderTaskRemoval.test.ts`
- [x] Batch 76 (ui-b): `src/components/PdfReader.tsx`
- [x] Batch 77 (server): `convex/aircraftSpruceActions.ts`
- [x] Batch 78 (platform): `src/data/demo.ts`
- [x] Batch 79 (server): `convex/programContext.ts` (done with Batch 415)
- [x] Batch 80 (domain-b): `src/domain/auditHistory.ts`, `src/domain/auditHistory.test.ts`
- [x] Batch 81 (domain-a): `src/domain/logbook.ts`
- [x] Batch 82 (domain-b): `src/domain/activateTemplate.ts`, `src/domain/activateTemplate.test.ts`
- [x] Batch 83 (domain-a): `src/domain/groupAircraft.ts`, `src/domain/groupAircraft.test.ts`
- [x] Batch 84 (platform): `src/data/deviceManuals.ts`, `src/data/deviceManuals.test.ts`
- [x] Batch 85 (domain-b): `src/domain/faaSearch.ts`, `src/domain/faaSearch.test.ts`
- [x] Batch 86 (domain-a): `src/domain/deleteInspectionTemplates.ts`, `src/domain/deleteInspectionTemplates.test.ts`
- [x] Batch 87 (domain-b): `src/domain/inventoryPrinting.ts`, `src/domain/inventoryPrinting.test.ts`
- [x] Batch 88 (domain-a): `src/domain/partsPlanning.ts`
- [x] Batch 89 (domain-b): `src/domain/pilotView.ts`, `src/domain/pilotView.test.ts`
- [x] Batch 90 (domain-a): `src/domain/programTransfers.ts`, `src/domain/programTransfers.test.ts`
- [x] Batch 91 (domain-b): `src/domain/adRemaining.ts`, `src/domain/adRemaining.test.ts`
- [x] Batch 92 (domain-a): `src/domain/adOwnership.ts`, `src/domain/adCompliance.ts`, `src/domain/flightChecklistLink.ts`
- [x] Batch 93 (domain-b): `src/domain/forecast.ts`, `src/domain/forecast.test.ts`
- [x] Batch 94 (domain-a): `src/domain/taskCsv.ts`, `src/domain/taskCsv.test.ts`
- [x] Batch 95 (domain-b): `src/domain/oilInventory.ts`, `src/domain/oilInventory.test.ts`
- [x] Batch 96 (domain-a): `src/domain/recurringParts.ts`, `src/domain/recurringParts.test.ts`
- [x] Batch 97 (domain-b): `src/domain/vendors.ts`, `src/domain/vendors.test.ts`
- [x] Batch 98 (platform): `src/data/adReport.ts`, `src/data/adReport.test.ts`
- [x] Batch 99 (platform): `src/data/pdfRuntime.ts`, `src/data/pdfOffline.ts`, `src/data/fmd.ts`
- [x] Batch 100 (domain-a): `src/domain/workOrderCleanup.ts`, `src/domain/workOrderCleanup.test.ts`
- [x] Batch 101 (ui-a): `src/components/PreflightMaintenance.tsx`, `src/components/PreflightMaintenance.test.ts`
- [x] Batch 102 (platform): `src/data/manualPdf.ts`, `src/data/adImport.ts`, `src/data/partsRequestPdf.ts`
- [x] Batch 103 (domain-b): `src/domain/flightLogImport.ts`, `src/domain/flightLogImport.test.ts`
- [x] Batch 104 (domain-a): `src/domain/flightSession.ts`, `src/domain/flightSession.test.ts`
- [x] Batch 105 (domain-b): `src/domain/defaultPermissionGroups.ts`, `src/domain/groupDeletion.ts`, `src/domain/guidedFlight.ts`
- [x] Batch 106 (domain-a): `src/domain/inventoryScan.ts`, `src/domain/inventoryScan.test.ts`
- [x] Batch 107 (domain-b): `src/domain/signTaskCard.ts`, `src/domain/signTaskCard.test.ts` (both deleted 2026-11-20, finding 77)
- [x] Batch 108 (domain-a): `src/domain/taskCardValidation.ts`, `src/domain/taskCardValidation.test.ts`
- [x] Batch 109 (domain-b): `src/domain/taskCardZone.ts`, `src/domain/taskCardZone.test.ts`
- [x] Batch 110 (platform): `src/data/local.ts`, `src/data/local.test.ts`
- [x] Batch 111 (domain-a): `src/domain/groupAccessReview.ts`, `src/domain/groupAccessReview.test.ts`
- [x] Batch 112 (server): `convex/faaCredentials.ts`, `convex/faaCredentials.test.ts`
- [x] Batch 113 (domain-b): `src/domain/faaCandidateReview.ts`, `src/domain/faaCandidateReview.test.ts`
- [x] Batch 114 (domain-a): `src/domain/faaMonitoringSearch.ts`, `src/domain/faaMonitoringSearch.test.ts`
- [x] Batch 115 (domain-b): `src/domain/flightSubmission.ts`, `src/domain/flightSubmission.test.ts` (done with Batch 252)
- [x] Batch 116 (server): `convex/identities.ts`
- [x] Batch 117 (server): `convex/recurringParts.ts`, `convex/recurringParts.test.ts`
- [x] Batch 118 (platform): `src/data/demoAircraftFiles.ts`, `src/data/poPdf.ts`, `src/data/inventoryPrintDocument.ts`
- [x] Batch 119 (server): `convex/aircraftFiles.ts`, `convex/aircraftFiles.test.ts`
- [x] Batch 120 (server): `convex/aircraftSpruce.ts`, `convex/aircraftSpruce.test.ts`
- [x] Batch 121 (server): `convex/manuals.ts`, `convex/manuals.test.ts`
- [x] Batch 122 (platform): `src/data/aircraftStatusReport.ts`
- [x] Batch 123 (server): `convex/addressVerification.ts`, `convex/addressVerification.test.ts`
- [x] Batch 124 (server): `convex/aircraftPhotos.ts`, `convex/aircraftPhotos.test.ts`
- [x] Batch 125 (server): `convex/audit.ts`, `convex/audit.test.ts`
- [x] Batch 126 (server): `convex/auditHistory.ts`, `convex/auditHistory.test.ts`
- [x] Batch 127 (server): `convex/backups.ts`, `convex/backups.test.ts`
- [x] Batch 128 (server): `convex/certifications.ts`, `convex/certifications.test.ts`
- [x] Batch 129 (server): `convex/counterEvents.ts`, `convex/counterEvents.test.ts`
- [x] Batch 130 (server): `convex/groupDeletion.ts`, `convex/groupDeletion.test.ts`
- [x] Batch 131 (server): `convex/inventoryFiles.ts`, `convex/inventoryFiles.test.ts`
- [x] Batch 132 (server): `convex/programUsers.ts`, `convex/programUsers.test.ts`
- [x] Batch 133 (server): `convex/savedAddresses.ts`, `convex/savedAddresses.test.ts`
- [x] Batch 134 (server): `convex/workOrderCleanup.ts`, `convex/workOrderCleanup.test.ts`
- [x] Batch 135 (platform): `src/data/store.ts`, `src/data/store.test.ts`
- [x] Batch 136 (domain-a): `src/domain/alerts.ts`, `src/domain/alerts.test.ts`
- [x] Batch 137 (server): `convex/defaultGroups.ts`, `convex/defaultGroups.test.ts`
- [x] Batch 138 (server): `convex/access.ts`, `convex/poFiles.ts`, `convex/auth.ts`
- [x] Batch 139 (server): `convex/faaSearch.ts`, `convex/faaSearch.test.ts`
- [x] Batch 140 (server): `convex/management.ts`, `convex/management.test.ts`
- [x] Batch 141 (server): `convex/workOrderCopies.ts`, `convex/workOrderCopies.test.ts`
- [x] Batch 142 (server): `convex/airworthiness.ts`, `convex/airworthiness.test.ts` (done by Batch 262)
- [x] Batch 143 (server): `convex/checklists.ts`, `convex/checklists.test.ts`
- [x] Batch 144 (server): `convex/componentTemplates.ts`, `convex/componentTemplates.test.ts`
- [x] Batch 145 (server): `convex/costs.ts`, `convex/costs.test.ts`
- [x] Batch 146 (server): `convex/engineTrends.ts`, `convex/engineTrends.test.ts`
- [x] Batch 147 (server): `convex/groupAudit.ts`, `convex/groupAudit.test.ts`
- [x] Batch 148 (server): `convex/inspectionTemplates.ts`, `convex/inspectionTemplates.test.ts`
- [x] Batch 149 (server): `convex/partsRequests.ts`, `convex/partsRequests.test.ts`
- [x] Batch 150 (server): `convex/programs.ts`, `convex/programs.test.ts`
- [x] Batch 151 (server): `convex/taskCards.ts`, `convex/taskCards.test.ts` (done by Batch 262)
- [x] Batch 152 (server): `convex/taskImports.ts`, `convex/taskImports.test.ts`
- [x] Batch 153 (ui-b): `src/components/ui.tsx`
- [x] Batch 154 (ui-a): `src/components/DrsComboBox.tsx`
- [x] Batch 155 (ui-b): `src/components/AircraftFiles.tsx`
- [x] Batch 156 (ui-a): `src/components/MaintenanceUi.tsx`, `src/components/ExportAircraftStatus.tsx`, `src/components/GroupAccessReview.tsx`
- [x] Batch 157 (ui-b): `src/components/KeepOnDevice.tsx`
- [x] Batch 158 (server): `convex/faa.ts`
- [x] Batch 159 (ui-a): `src/components/OilInventoryFields.tsx`
- [x] Batch 160 (platform): `src/data/demoBackup.ts`, `src/data/auditHistory.ts`, `src/data/alerts.ts`
- [x] Batch 161 (server): `convex/flightPlans.ts`, `convex/fleet.ts`, `convex/http.ts`
- [x] Batch 162 (server): `convex/purchaseOrders.ts`, `convex/purchaseOrders.test.ts`
- [x] Batch 163 (server): `convex/workOrders.ts`, `convex/workOrders.test.ts`
- [x] Batch 164 (ui-b): `src/components/AircraftPhoto.tsx`, `src/components/DemoBackup.tsx`, `src/components/ManagementShared.tsx`
- [x] Batch 165 (ui-a): `src/components/AddressFields.tsx`
- [x] Batch 166 (ui-b): `src/components/SignInMethods.tsx`, `src/components/SignInMethods.test.ts`
- [x] Batch 167 (ui-a): `src/components/TaskCsvImport.tsx`
- [x] Batch 168 (ui-b): `src/components/AircraftStatus.tsx`, `src/components/AtaChapterField.tsx`, `src/components/FaaKeySettings.tsx`
- [x] Batch 169 (ui-a): `src/components/FlightFluids.tsx`
- [x] Batch 170 (ui-b): `src/components/InventoryScanner.tsx`
- [x] Batch 171 (ui-a): `src/components/LogbookWording.tsx`, `src/components/LogbookWording.test.ts`
- [x] Batch 172 (ui-b): `src/components/UserProfile.tsx`
- [x] Batch 173 (ui-a): `src/components/Alerts.tsx`
- [x] Batch 174 (ui-b): `src/components/Costs.tsx`
- [x] Batch 175 (ui-a): `src/components/InventoryAttachments.tsx`
- [x] Batch 176 (ui-b): `src/components/InventoryPrinting.tsx`
- [x] Batch 177 (ui-a): `src/components/LogbookEntry.tsx`
- [x] Batch 178 (ui-b): `src/components/PermissionGroupForm.tsx`
- [x] Batch 179 (ui-a): `src/components/DeleteGroupButton.tsx`, `src/components/AddressVerificationSettings.tsx`, `src/components/ADTrackingFields.tsx`
- [x] Batch 180 (ui-b): `src/components/ComponentCloseoutCorrection.tsx`
- [x] Batch 181 (ui-a): `src/components/CoreReturns.tsx`
- [x] Batch 182 (ui-b): `src/components/AircraftInspectionSchedules.tsx`, `src/components/CalendarExemptionFields.tsx`, `src/components/Deferrals.tsx`
- [x] Batch 183 (ui-a): `src/components/FaaSearchImport.tsx`
- [x] Batch 184 (ui-b): `src/components/FlightLogImport.tsx`
- [x] Batch 185 (ui-a): `src/components/LogbookSample.tsx`
- [x] Batch 186 (ui-b): `src/components/PlanComponentMovement.tsx`
- [x] Batch 187 (ui-a): `src/components/Planning.tsx`
- [x] Batch 188 (ui-b): `src/components/ReleaseStatements.tsx`
- [x] Batch 189 (ui-a): `src/components/RequestedComponentMovement.tsx`
- [x] Batch 190 (ui-b): `src/components/WorkOrderComponentWork.tsx`
- [x] Batch 191 (ui-a): `src/components/WorkOrderCosts.tsx`
- [x] Batch 192 (server): `convex/alerts.ts`, `convex/alerts.test.ts`
- [x] Batch 193 (ui-b): `src/components/SavedAddresses.tsx`
- [x] Batch 194 (ui-a): `src/components/Vendors.tsx`
- [x] Batch 195 (ui-b): `src/components/WorkOrderRevisions.tsx`
- [x] Batch 196 (ui-a): `src/components/OwnerPortal.tsx`
- [x] Batch 197 (ui-b): `src/components/FlightSession.tsx`
- [x] Batch 198 (ui-a): `src/components/ActivateTemplate.tsx`
- [x] Batch 199 (ui-b): `src/components/ComponentTemplates.tsx`
- [x] Batch 200 (ui-a): `src/components/ADRegister.tsx`
- [x] Batch 201 (ui-b): `src/components/Admin.tsx`
- [x] Batch 202 (platform): `src/App.tsx`
- [x] Batch 203 (platform): `src/main.tsx`
- [x] Batch 204 (platform): `.github/workflows/backup.yml`, `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`
- [x] Batch 205 (platform): `compose.yaml`, `index.html`, `playwright.config.ts`
- [x] Batch 206 (platform): `vite.config.ts`
- [x] Batch 207 (domain-b): `src/domain/pdf/icao.ts`
- [x] Batch 208 (ui-a): `src/styles/screens/signin.css`
- [x] Batch 209 (platform): `scripts/backup/decrypt.sh`, `scripts/backup/records-workbook.mjs`
- [x] Batch 210 (platform): `scripts/icons.mjs`
- [x] Batch 211 (platform): `src/cspSafeZod.ts`, `src/vite-env.d.ts`
- [x] Batch 212 (domain-a): `src/domain/ownerDue.ts`, `src/domain/alertDigest.ts`
- [x] Batch 213 (ui-b): `src/components/RequiredParts.tsx`, `src/components/ADWorkOrderButton.tsx`
- [x] Batch 214 (platform): `.github/dependabot.yml`
- [x] Batch 215 (platform): `public/theme-init.js`
- [x] Batch 216 (platform): `vitest.config.ts`
- [x] Batch 217 (domain-b): `src/domain/commonPasswords.ts` (data list: header and docstring only)

### Tier 1, continued: test files without a module of their own

Header, a docstring on shared helpers, WHY comments, named constants for magic values, and no suppressions. Assertions stay exactly as they are.

- [x] Batch 218 (server): `convex/accountSecurity.test.ts`, `convex/authRefreshToken.test.ts`, `convex/dispatch.test.ts`
- [x] Batch 219 (server): `convex/faaMonitoring.test.ts`, `convex/flightChronology.test.ts`, `convex/groupAccess.test.ts`
- [x] Batch 220 (server): `convex/inventoryShelfLife.test.ts`, `convex/oilMarkerBackfill.test.ts`, `convex/ownerPortal.test.ts`
- [x] Batch 221 (server): `convex/requiredParts.test.ts`, `convex/signInMethods.test.ts`, `convex/signInProviders.test.ts`
- [x] Batch 222 (platform): `scripts/backup/dropboxUpload.test.ts`
- [x] Batch 223 (platform): `src/data/demoGroupAccess.test.ts`, `src/data/demoGroups.test.ts`, `src/data/workOrderCache.test.ts`
- [x] Batch 224 (domain-a): `src/domain/adCorrections.test.ts`, `src/domain/adDueBoundaries.test.ts`, `src/domain/c441Import.test.ts`
- [x] Batch 225 (domain-b): `src/domain/calendarExemption.test.ts`, `src/domain/componentAssembly.test.ts`, `src/domain/componentMovements.test.ts`
- [x] Batch 226 (domain-a): `src/domain/domain.test.ts`, `src/domain/dueBoundaries.test.ts`, `src/domain/flightChronology.test.ts`
- [x] Batch 227 (domain-b): `src/domain/flightOptions.test.ts`, `src/domain/flightTimeLog.test.ts`, `src/domain/helicopter.test.ts`
- [x] Batch 228 (domain-a): `src/domain/landingSchedules.test.ts`, `src/domain/logbookPerformers.test.ts`, `src/domain/unlinkTaskCard.test.ts`
- [x] Batch 229 (domain-b): `src/domain/workOrderRevisions.test.ts`
- [x] Batch 230 (platform): `tests/csp-report.ts`
- [x] Batch 231 (platform): `tests/e2e/ad-work-order.spec.ts`, `tests/e2e/addresses.spec.ts`, `tests/e2e/admin-layout.spec.ts`
- [x] Batch 232 (platform): `tests/e2e/aircraft-photos.spec.ts`, `tests/e2e/aircraft-spruce.spec.ts`, `tests/e2e/aircraft-status-export.spec.ts`
- [x] Batch 233 (platform): `tests/e2e/airworthiness.spec.ts`, `tests/e2e/alerts.spec.ts`, `tests/e2e/calendar-exemption.spec.ts`
- [x] Batch 234 (platform): `tests/e2e/checklists.spec.ts`, `tests/e2e/component-create-attachments.spec.ts`, `tests/e2e/component-inventory.spec.ts`
- [x] Batch 235 (platform): `tests/e2e/component-templates.spec.ts`, `tests/e2e/delete-templates.spec.ts`, `tests/e2e/drs-fields.spec.ts`
- [x] Batch 236 (platform): `tests/e2e/fleet.spec.ts`, `tests/e2e/flight-options.spec.ts`, `tests/e2e/flight-plans.spec.ts`
- [x] Batch 237 (platform): `tests/e2e/flight-time-log.spec.ts`, `tests/e2e/guided-flight.spec.ts`, `tests/e2e/initial-component.spec.ts`
- [x] Batch 238 (platform): `tests/e2e/inspection-remaining.spec.ts`, `tests/e2e/inspection-templates.spec.ts`, `tests/e2e/interface.spec.ts`
- [x] Batch 239 (platform): `tests/e2e/inventory-attachments.spec.ts`, `tests/e2e/inventory-printing.spec.ts`, `tests/e2e/landing-schedules.spec.ts`
- [x] Batch 240 (platform): `tests/e2e/live.spec.ts`, `tests/e2e/logbook-wording.spec.ts`, `tests/e2e/maintenance-csv.spec.ts`
- [x] Batch 241 (platform): `tests/e2e/management.spec.ts`, `tests/e2e/manual-discovery.spec.ts`, `tests/e2e/manuals-on-device.spec.ts`
- [x] Batch 242 (platform): `tests/e2e/manuals.spec.ts`, `tests/e2e/parts-requests.spec.ts`, `tests/e2e/pdf-reader.spec.ts`
- [x] Batch 243 (platform): `tests/e2e/permission-groups.spec.ts`, `tests/e2e/pilot-view.spec.ts`, `tests/e2e/program-users.spec.ts`
- [x] Batch 244 (platform): `tests/e2e/purchase-orders.spec.ts`, `tests/e2e/records-layout.spec.ts`, `tests/e2e/requested-component-movement.spec.ts`
- [x] Batch 245 (platform): `tests/e2e/required-parts.spec.ts`, `tests/e2e/requirement-tracking-options.spec.ts`, `tests/e2e/security-headers.spec.ts`
- [x] Batch 246 (platform): `tests/e2e/settings.spec.ts`, `tests/e2e/sign-in-methods.spec.ts`, `tests/e2e/task-cards.spec.ts`
- [x] Batch 247 (platform): `tests/e2e/task-csv.spec.ts`, `tests/e2e/user-certifications.spec.ts`, `tests/e2e/vendors.spec.ts`
- [x] Batch 248 (platform): `tests/e2e/work-order-template-cards.spec.ts`, `tests/e2e/work-orders.spec.ts`, `tests/e2e/workspace.spec.ts`
- [x] Batch 249 (platform): `tests/fixtures/cacheStorage.ts`, `tests/fixtures/componentMovement.ts`, `tests/fixtures/localDateTime.ts`
- [x] Batch 250 (platform): `tests/fixtures/requiredParts.ts`, `tests/fixtures/savedAddress.ts`, `tests/fixtures/taskCards.ts`
- [x] Batch 251 (platform): `tests/fixtures/templateDeletion.ts`, `tests/fixtures/workOrderTasks.ts`, `tests/fixtures/workOrders.ts`

## Tier 2: shallow pass-throughs and tangled services

From the deep-module review in [docs/architecture/tier2-candidates.md](docs/architecture/tier2-candidates.md), which has each candidate's evidence, interface sketch, risk and tests. Do the batches in this order: it follows each candidate's dependencies. A batch also brings every file it touches up to the standards.


### T10. One rejection type, exposed by default, with a stale-version guard

- [x] Batch 252 (T10 b1): `src/domain/rejection.ts` (new), `src/domain/flightSubmission.ts`, `src/domain/components.ts` (the classes; existing errors re-parented)
- [x] Batch 253 (T10 b2): `convex/runCommand.ts`, `convex/runCommand.test.ts` (default `expose` = `Rejection`, from `load` too)
- [x] Batch 254 (T10 b3, b4…): ≤3 domain modules each, leaf first: `src/domain/taskCards.ts`, `src/domain/flightPlans.ts`, `src/domain/inspectionTemplates.ts`; then `src/domain/workOrders.ts`, `src/domain/partsRequests.ts`, `src/domain/fleet.ts`; then the rest (`assertCurrent` and `Rejection` at each site)

- [x] Batch 415 (T10 b-server): `convex/programContext.ts`, `convex/access.ts`, `convex/runCommand.ts`: expected refusals raised by the server itself reach users as `ConvexError` (stale Flight Program, read-only owner access, permission denied, no active session, record not found, request-id reuse, and the collision messages thrown in `persist`). Bugs stay hidden. Found by Batch 253's survey; the server lane leaves these files to this batch.

- [x] Batch 416 (T10 b-functions): `convex/userErrors.ts` (new), `convex/certifications.ts`, `convex/aircraftFiles.ts`, `convex/inventoryFiles.ts`, `convex/poFiles.ts`, `convex/manuals.ts`, `convex/faaSearch.ts`: server functions that call domain checks without `runCommand` show a `Rejection` as `ConvexError`; their own expected refusals too. Never the session error, never `convex/operations.ts`. Runs in the server lane.
- [x] Batch 417 (T10 b-follow-up): `convex/admin.ts` (wraps its domain checks; header only), `convex/programUsers.ts`, `convex/accountGuards.ts`, `convex/faaCredentials.ts`, `convex/identities.ts`, `convex/auditHistory.ts`: the remaining expected refusals reach users as `ConvexError`. `EMAIL_UNAVAILABLE` is one class and message on every path, and `HISTORY_NOT_FOUND` stays uniform (S12).
- [x] Batch 429 (T10 b-stale): `src/domain/rejection.ts` (`StaleRecordRejection`, `STALE_RECORD_MESSAGE`), `src/data/errors.ts` (`isStaleSave`), the stale checks in `management/checks.ts`, `airworthiness.ts`, `fleet.ts`, `purchaseOrders.ts`, `workOrders.ts`, `componentTemplates.ts`, `inspectionTemplates.ts`, `activateTemplate.ts`, `workOrderComponentCorrections.ts` and the address, FAA key and Aircraft Spruce settings: one class and one message for a stale save, so screens open the review (`StaleSave.tsx`) instead of printing it. Docs: `docs/offline.md`.
- [ ] Batch 430 (T10 b-stale-2): the stale checks still worded on their own, `src/domain/taskCards.ts`, `partsRequests.ts`, `savedAddresses.ts`, `flightPlans.ts`, `checklists.ts`, `requiredParts.ts`, `workOrderComponentWork.ts`, `deleteInspectionTemplates.ts` and `convex/groupDeletion.ts`, onto `StaleRecordRejection`, and their forms onto `useStaleSave`. The `aircraftSpruce` "Search again" and "Reload before disconnecting" checks guard a read and a disconnect, not a save, and keep their wording.

### T1. Collection codec: a stored row ⇄ a Snapshot collection, once

- [x] Batch 255 (T1 b1): `convex/collections.ts` (new), `convex/runCommand.ts` (`hydrate` decodes through the codec)
- [x] Batch 256 (T1 b2): `convex/operations.ts` (`snapshot` decodes through the codec)
- [x] Batch 257 (T1 b3): `convex/costs.ts`, `convex/programs.ts`, `convex/recurringParts.ts` (ad-hoc decoders go through the codec)
- [x] Batch 258 (T1 b4): `scripts/backup/recordsWorkbook.ts`, `scripts/backup/exportFixture.ts` (decode and encode through the codec; the scripts already bundle `src/` with esbuild)
- [ ] Batch 259 (T1 b5): `convex/runCommand.ts`, `src/domain/model.ts` (`undefined` for collections that are not loaded, and `Pick<Snapshot, …>` as the applier parameter (G). This changes behaviour, so it needs its own ADR status note.) Needs its own ADR status note; behaviour changes. **Deferred:** a typing change with behaviour risk and no user benefit; it needs its own ADR.

### T9. Changed-row writer: `runCommand` owns persist

- [x] Batch 260 (T9 b1): `convex/runCommand.ts`: `writeChanged` plus its tests in `convex/runCommand.test.ts` (after T1 b1)
- [x] Batch 261 (T9 b2): `convex/partsRequests.ts`, `convex/purchaseOrders.ts`, `convex/costs.ts`
- [x] Batch 262 (T9 b3): `convex/airworthiness.ts`, `convex/taskCards.ts`, `convex/fleet.ts`
- [x] Batch 263 (T9 b4): `convex/management.ts`, `convex/inspectionTemplates.ts`; adds the missing guard, a behaviour change recorded in a test
- [x] Batch 264 (T9 b5): `convex/workOrders.ts` (after T15)
- [x] Batch 265 (T9 b6): `convex/programs.ts`
- [x] Batch 266 (T9 b7): the seven collision messages unified into one; client-visible

### T2. Discrepancy resolution as a domain command

- [x] Batch 267 (T2 b1): `src/domain/deferrals.ts`, with its test (the new applier and its tests)
- [x] Batch 268 (T2 b2): `convex/operations.ts` (`resolveDiscrepancy` moves onto `runCommand` with the applier; stored data unchanged)
- [x] Batch 269 (T2 b3): `src/data/demoBackend.ts` (the demo uses the applier; this is an explicit behaviour fix)

### T3. Attachment rules shared by both adapters

- [x] Batch 270 (T3 b1): `src/domain/taskCards.ts`, `src/domain/attachments.ts` (new), with tests (the new domain rules)
- [x] Batch 271 (T3 b2): `convex/taskCards.ts`, `convex/attachments.ts` (the server uses the domain rules; output unchanged)
- [x] Batch 272 (T3 b3): `convex/workOrders.ts` (one shared "open work order" access check)
- [x] Batch 273 (T3 b4): `src/data/demoBackend.ts` (the demo applies the cap and the evidence rule)

### T4. Server upload pipeline and one blob-reference list

- [x] Batch 274 (T4 b1): `convex/attachments.ts`, `convex/storageReferences.ts` (`deleteBlobIfUnused` goes through `storageReferenced`)
- [x] Batch 275 (T4 b2): `convex/attachments.ts`, `convex/inventoryFiles.ts`, `convex/poFiles.ts` (adds `storeThenFinish` and moves the first two actions onto it)
- [x] Batch 276 (T4 b3): `convex/aircraftPhotos.ts`, `convex/aircraftFiles.ts`, `convex/certifications.ts` (moves three more actions)
- [x] Batch 277 (T4 b4): `convex/taskCards.ts`, `convex/workOrders.ts` (moves the last two; coordinate with T3 b2–b3)

### T5. Retire the second aircraft-creation path

- [x] Batch 278 (T5 b1): `src/data/backend.ts`, `src/data/demoBackend.ts`, `src/data/store.test.ts` (drop the dead method)
- [x] Batch 279 (T5 b2): `scripts/smoke-local.mjs`, `convex/programUsers.test.ts` (move both callers to `fleet.save`)
- [x] Batch 280 (T5 b3): `convex/admin.ts` (delete the mutation, or make it the wrapper)

### T6. Leftover mutations with no domain applier

- [x] Batch 281 (T6 b1): `src/domain/manuals.ts`, `convex/manuals.ts`
- [x] Batch 282 (T6 b2): `src/domain/savedAddresses.ts`, `convex/savedAddresses.ts`
- [x] Batch 283 (T6 b3): `src/domain/faa.ts`, `convex/faa.ts`
- [x] Batch 284 (T6 b4): `src/domain/programs.ts`, `convex/programs.ts` (`select`)
- [x] Batch 285 (T6 b5): `src/data/demoBackend.ts`: all four demo methods

### T7. Meter-reading value module

- [x] Batch 286 (T7 b1): `src/domain/readings.ts` (new, with test), `src/domain/model.ts` (`parseHours` and the refine move into the module)
- [x] Batch 287 (T7 b2): `src/components/GuidedFlight.tsx`, `src/domain/guidedFlight.ts` (the guided flight uses the module; this is the bug-shaped case)
- [x] Batch 288 (T7 b3): `src/components/FlightParts.tsx`, `src/components/ManualDiscovery.tsx`, `src/components/Fleet.tsx` (the remaining conversions)

### T16. Membership and permission-group rules into the domain

- [x] Batch 289 (T16 b1): `src/domain/accountRules.ts` (with test) (the new rules)
- [x] Batch 290 (T16 b2): `convex/programUsers.ts` (uses the rules)
- [x] Batch 291 (T16 b3): `convex/admin.ts` (`saveGroup`, `createUser`)
- [x] Batch 292 (T16 b4): `src/data/demoBackend.ts` (membership and group methods)

### T12. Change-log rows composed once, in the domain, with `programUuid` stamped

- [x] Batch 293 (T12 b1): `src/domain/changeLog.ts` (new, with tests) (the constructor)
- [x] Batch 294 (T12 b2): `src/domain/fleet.ts`, `src/domain/costs.ts`, `src/domain/recurringParts.ts` (existing literals use the constructor)
- [x] Batch 295 (T12 b3): `src/domain/purchaseOrders.ts`, `src/domain/partsRequests.ts` (existing literals use the constructor)
- [x] Batch 296 (T12 b4, b5…): ≤3 at a time: the applier (domain), its Convex `audit` hook, and the demo method (appliers start pushing their own entries: AD, then deferral and parts, then checklist, task card and plan, then templates)

### T11. Conflict review (flight review) as a domain command

- [x] Batch 297 (T11 b1): `src/domain/flights.test.ts` (new) (characterization only)
- [x] Batch 298 (T11 b2): `src/domain/flightReview.ts` (new, with tests) (the domain sequence)
- [x] Batch 299 (T11 b3): `convex/operations.ts` (onto `runCommand`; stored output unchanged)
- [x] Batch 300 (T11 b4): `src/data/demoBackend.ts` (the demo uses the domain sequence; explicit behaviour fix)

### T13. Maintenance due list: one module for "what is due on this aircraft"

- [x] Batch 301 (T13 b1): `src/domain/dueItems.ts` (new, with tests), `src/domain/ownerDue.ts` (the module; the owner view uses it)
- [x] Batch 302 (T13 b2): `src/domain/partsPlanning.ts`, `src/domain/alerts.ts`
- [x] Batch 303 (T13 b3): `src/components/Dashboard.tsx`, `src/components/Components.tsx`
- [x] Batch 304 (T13 b4): `src/domain/forecast.ts`, `src/domain/flightPlans.ts`
- [x] Batch 305 (T13 b5): `src/domain/aircraftStatus.ts` (must produce identical grounded and due-soon reasons on the characterization fleet; any difference needs sign-off)

### T8. Split the records workbook

- [x] Batch 306 (T8 b1): `scripts/backup/xlsxWriter.ts` (new), `scripts/backup/recordsWorkbook.ts` (moves the writer out)
- [x] Batch 307 (T8 b2): `scripts/backup/exportSnapshot.ts` (new), `scripts/backup/recordsWorkbook.ts` (moves decoding out)
- [x] Batch 308 (T8 b3): `scripts/backup/recordsWorkbook.ts` (`dueItems` replaced by the domain module)
- [x] Batch 420 (T8 b4, after T8 b1–b3 and T17 b4): `scripts/backup/recordsWorkbook.ts`: the standards pass on what remains (23 functions over 40 lines before T8; `dueItems` is 195 lines with 3 levels of nesting).
- [ ] Batch 421 (T8 b5): `scripts/backup/exportFixture.ts`: split `fixtureExport` (1,676 lines) into per-collection builders in a sibling folder; the fixture ZIP stays byte-identical. **Deferred (scope, 2026-11-04):** a cosmetic split with no rule to move; pick it up only if wanted. The Discrepancies screen and its dialogs moved to `Discrepancies.tsx` in the redesign (2026-11-12), with the shared date formats in `recordDates.ts`; the flight log, Sync center and Change history remain.

### T17. Status-record documents: content separate from PDF layout

- [x] Batch 309 (T17 b1): `src/domain/statusSheet.ts` (new, with test), `src/data/aircraftStatusReport.ts` (content moves to the domain)
- [x] Batch 310 (T17 b2): `src/data/pdfLayout.ts` (new), `src/data/poPdf.ts`, `src/data/partsRequestPdf.ts` (the shared paragraph layout)
- [ ] Batch 311 (T17 b3): `src/data/aircraftStatusReport.ts`, `src/data/adReport.ts` (both use `tablePdf`) **Deferred:** the AD worksheet copies the customer's CompReport layout; sharing `tablePdf` would change the PDF and needs the owner's sign-off.
- [ ] Batch 312 (T17 b4): `scripts/backup/recordsWorkbook.ts` (`aircraftSheet` reads `statusSheet`) **Deferred (closed):** reading `statusSheet` would build a whole sheet per aircraft and add a way for the nightly workbook to fail, all for three strings; it fails the deletion test. The shared content is the due list (Batch 308).

### T14. Recurring-parts occurrences generated inside the appliers

- [x] Batch 313 (T14 b1): `src/domain/recurringParts.ts`, `src/domain/partsRequests.ts` (the applier generates occurrences; adds `recurringPartsNeeds`) **Partial:** `recurringPartsNeeds` is in the domain; the applier wiring landed with Batch 314.
- [x] Batch 314 (T14 b2): `convex/partsRequests.ts` (the generation moves out of `persist`)
- [x] Batch 315 (T14 b3): `convex/recurringParts.ts`, `convex/workOrders.ts`, `convex/workOrderCopies.ts`
- [x] Batch 316 (T14 b4): `src/data/demoBackend.ts`

### T15. Work-order "add inspection" fast path onto the applier, plus the ADR-0003 post-apply hook

- [x] Batch 317 (T15 b1): `src/domain/workOrders.ts` (extract `addInspectionTask`)
- [x] Batch 318 (T15 b2): `convex/runCommand.ts`, `convex/runCommand.test.ts` (adds `afterApply`)
- [x] Batch 319 (T15 b3): `convex/workOrders.ts`, `convex/workOrderCopies.ts` (drops `delegate` and `startCopy`'s checks; scheduling moves to `afterApply`)

### T18. Request ids on every command

- [x] Batch 320 (T18 b1): `convex/schema.ts`, `convex/runCommand.ts` (the new table, written alongside the old one (expand))
- [x] Batch 321 (T18 b2…): ≤3 command schemas and their mutations at a time (the client generates `requestUuid` in `src/data/backend.ts`)

### T19. Network calls out of the business-rules layer

Found by the boundary check in CONTEXT.md §5: five functions in `src/domain` call `fetch`. Convex actions call `fetchAddressSuggestions`, `searchFAA` and `fetchMonitoringCandidates`; `fetchDrsFiltered` is called only from those domain functions; `fetchDrsCandidates` has no production caller (only `src/domain/airworthiness.test.ts`). Move the called ones into the Convex module that uses them and delete `fetchDrsCandidates`; the parsing and validation stay in the domain.

- [x] Batch 322 (T19 b1): `src/domain/addressLookup.ts`, `convex/addressVerification.ts` (`fetchAddressSuggestions` moves to the server)
- [x] Batch 323 (T19 b2): `src/domain/faa.ts`, `src/domain/faaSearch.ts`, `src/domain/faaMonitoringSearch.ts` (`fetchDrsFiltered`, `searchFAA` and `fetchMonitoringCandidates` move behind one server module; `fetchDrsCandidates` and its tests in `src/domain/airworthiness.test.ts` are deleted; coordinate with T6 b3)

### T20. One server-error message helper for the UI

The same `ConvexError` message extraction is written five times in components: `ui.tsx`, `EngineTrends.tsx`, `SavedAddresses.tsx` and `SignInMethods.tsx`, each with its own fallback text, and a variant in `AircraftSpruce.tsx`. Export one helper from `ui.tsx` that takes the fallback text as a parameter, so each screen keeps its current message, and import it everywhere. `src/data/store.ts:317` keeps its own copy, because the data layer may not import `src/components`.

- [x] Batch 324 (T20 b1): `src/components/ui.tsx`, `src/components/EngineTrends.tsx`, `src/components/SavedAddresses.tsx`, `src/components/SignInMethods.tsx` (and `src/components/AircraftSpruce.tsx` in the same commit if it is still separate)
- [x] Batch 418 (T20 b2): `src/data/errors.ts` (new), `src/components/ui.tsx` (re-exports it), `src/data/store.ts`: `errorText` moves to the data layer and the outbox stores its text, so the Sync center shows refusals, not Convex wrapper text.
- [x] Batch 419 (T20 b3): `src/data/errors.ts`, `src/data/alerts.ts`: zod validation errors show their issue messages, not zod's JSON (finding 36); the Alerts page uses `errorText`.

### T22. Follow-ups found during the refactor

- [x] Batch 422 (T22 b1): `convex/userErrors.ts`, `convex/runCommand.ts`, `src/domain/validationText.ts` (new), `src/data/errors.ts`: a zod refusal on the server reaches users as `ConvexError` with the same issue text the browser shows (one formatter, shared by both). Today `certificationsSchema`, `licenseSchema`, `logbookPhrasesSchema`, `releaseStatementsSchema` and `aircraftInputSchema` refusals show "Server Error".
- [x] Batch 423 (T22 b2): `src/components/LogbookSample.tsx`, `src/domain/workOrders.ts`, `src/domain/workOrderCloseout.ts`: the logbook preview builds its readings and component lines with the same domain functions as the saved close-out, so the preview matches the signed entry. Before saving, the preview labels a component without its install position.
- [x] Batch 424 (T22 b3): `convex/flightPlans.ts`: decode through the codec and persist through `writeChanged` (no T1 or T9 batch covered it).
- [x] Batch 425 (T22 b4): `src/domain/taskCsv.ts`, `src/domain/addressLookup.ts`, `src/domain/certifications.ts`, `src/domain/flightFluids.ts`: task CSV row errors use the shared issue text; the address-lookup, licence and oil-readings schemas get their own messages instead of zod's defaults.
- [x] Batch 426 (T22 b5): `src/domain/activateTemplate.ts`, `src/domain/componentTemplates.ts`, `src/domain/adWorkOrders.ts` (new), with the screens `ActivateTemplate.tsx`, `ComponentTemplates.tsx`, `ADRegister.tsx` and `ADWorkOrderButton.tsx`: rules that lived only in screens move into the domain.
- [ ] Batch 427 (T22 b6): `src/components/ui.tsx`, `src/components/ComponentTemplates.tsx` (`CsvFileField`, `importCsv`), `src/components/AircraftSetupHistory.tsx` (`readCsvFile`), `src/components/MaintenanceCsvImport.tsx`, `src/components/TaskCsvImport.tsx`: one CSV file field (size check against `CSV_MAX_BYTES`, read as text, error beside the field) shared by every CSV import; today each screen reads the file its own way. Found while adding the aircraft setup wizard (2026-11-09).
- [ ] Batch 428 (T22 b7): `src/components/InventoryAttachments.tsx` (`saveCopy`, `dataUrlBlob`), `src/data/recordsPackage.ts` (`fileBytes`, `dataUrlBytes`), `src/components/ui.tsx` (`download`): a stored file's bytes are read in two places (demo `data:` URLs decoded by hand because the Content-Security-Policy keeps `fetch()` from reading them; storage URLs fetched) and a Blob is saved in two places. One data-layer module should own both, used by attachment downloads and the records package. Found while adding the records package (2026-11-09).
- [ ] Upload follow-ups (found with the 2026-11-19 upload fixes): `src/domain/inventoryAttachments.ts` holds the first-bytes check (`assertFileContents`, `matchesFileType`, `FILE_SIGNATURE_LENGTH`) and `MAX_ACTION_FILE_BYTES` that every upload path now uses; move them into `src/domain/attachments.ts`, beside the other shared attachment rules. Separately, `deleteRemovedCards` in `convex/workOrders.ts` deletes a work order's removed job cards but keeps their `taskEvidence` rows, so those rows and their files outlive the card (`deleteTemplates` in `convex/inspectionTemplates.ts` removes both); decide whether removed cards' evidence should be kept as a record or deleted with them.
- [x] Batch 432 (T22 b8): `src/domain/checklists.ts` (`saveChecklist`), `src/domain/workOrderComponentCorrections.ts` (`replayAtCompletion`), `src/domain/work-order-closeout/compliance.ts` (`completeInspectionItem`), with characterization tests in `src/domain/checklists.test.ts` and `src/domain/workOrderCloseout.test.ts`; then `PaperCheck.tsx`, `Records.tsx`, `LogbookPhotos.tsx`, `OpsList.tsx`, `DrsComboBox.tsx`, `ExportRecordsPackage.tsx`, `TaskCards.tsx` and `SavedAddresses.tsx` in `src/components`; and TSDoc on the second overloads of `runCommand` and `exposeRejections`. The 15 functions over 40 lines in files the 10 Nov bug-hunt round did not change, split into named helpers, subcomponents and hooks in the same file; component markup compared with react-dom/server before and after. Still over 40 outside that round: `fixtureExport` (Batch 421, deferred), `AlertEmailBlock` in `Settings.tsx` (changing on another branch); `demoBackend` stays deferred. `Records.tsx` (1,790 lines) is still Batch 399's to split.
- [ ] D7 option b (follow-up to the offline-legs change, 2026-11-10): `convex/operations.ts` `submit` with `src/domain/flightSubmission.ts` (`submitFlight`, `heldReason`): accept a version change only when every change since the leg's base version is an earlier accepted flight by the same author that leads to this leg. Today the device chains each leg's version (`aircraftAfterPendingFlights`); if an earlier leg is held or refused and another device's flight happens to move the aircraft on by exactly one version, a later leg can still be accepted. The server check closes that gap.

### T21. Fresh start: remove migration-only code

Production started empty on 2026-11-03 and no data was migrated (Finding 14), so code that exists only to migrate or repair data written by earlier versions may be dead. Every removal needs the b1 inventory first. A removal batch takes at most 3 source files, removes or updates their tests, and drops the README's one-off data-repair step for what it removes.

- [x] Batch 410 (T21 b1): read-only inventory, no code change. For each candidate, confirm that it touches stored server data only, not data on devices or demo seeds, and record keep or remove: the reseal path in `convex/secretsMigration.ts` and the plaintext and `enc:v1` acceptance in `convex/secrets.ts`; `convex/workOrderCleanup.ts` and `src/domain/workOrderCleanup.ts`; `management:backfillOilMarker` (`convex/management.ts`); `memberships:backfill` (`convex/memberships.ts`); `counterEvents:recordChanges` (`convex/counterEvents.ts`); `groupAudit:findWidenedGroups` (`convex/groupAudit.ts`); legacy unscoped-group handling (`src/domain/groupAircraft.ts`); legacy job-card steps (`src/domain/taskCards.ts`); cached-snapshot format checks such as `programScopeVersion` (`src/data/store.ts`, `src/domain/model.ts`).
- [x] Batch 411 (T21 b2, needs b1): `convex/secretsMigration.ts`, `convex/secrets.ts`, `convex/secrets.test.ts` (the reseal path; plaintext and `enc:v1` acceptance)
- [x] Batch 412 (T21 b3, needs b1): `convex/workOrderCleanup.ts`, `src/domain/workOrderCleanup.ts`, with `convex/workOrderCleanup.test.ts` and `src/domain/workOrderCleanup.test.ts`
- [x] Batch 413 (T21 b4, needs b1): `convex/management.ts` (`backfillOilMarker`), `convex/memberships.ts` (`backfill`), `convex/counterEvents.ts` (`recordChanges`), with `convex/oilMarkerBackfill.test.ts`, `convex/memberships.test.ts` and `convex/counterEvents.test.ts`
- [x] Batch 414 (T21 b5, needs b1): `convex/groupAudit.ts` (`findWidenedGroups`), `src/domain/groupAircraft.ts` (legacy unscoped-group handling), `src/domain/taskCards.ts` (legacy job-card steps), with their tests. The cached-snapshot format checks guard snapshots cached on devices, so expect b1 to keep them; any it clears for removal get a batch of their own.

## Tier 3: monoliths and god files (over 500 lines)

Each file is decomposed behind a backward-compatible barrel: the original path keeps exporting everything it exports today, so no importer changes. Parts run in order.

- [x] Batch 325 (server): `convex/schema.ts` (599 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 326 (server): `convex/schema.ts` (599 lines), part 2 of 2 (after T18 b1): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them. **Deferred (scope, 2026-11-04):** a cosmetic split with no rule to move; pick it up only if wanted. The Discrepancies screen and its dialogs moved to `Discrepancies.tsx` in the redesign (2026-11-12), with the shared date formats in `recordDates.ts`; the flight log, Sync center and Change history remain.
- [x] Batch 327 (ui-a): `src/components/design.tsx` (906 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 328 (ui-a): `src/components/design.tsx` (906 lines), part 2 of 2: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them. **Deferred (scope, 2026-11-04):** a cosmetic split with no rule to move; pick it up only if wanted. The Discrepancies screen and its dialogs moved to `Discrepancies.tsx` in the redesign (2026-11-12), with the shared date formats in `recordDates.ts`; the flight log, Sync center and Change history remain.
- [x] Batch 329 (domain-a): `src/domain/management.ts`, `src/domain/management.test.ts` (789 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [x] Batch 330 (domain-a): `src/domain/management.ts` (789 lines), part 2 of 2: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [x] Batch 331 (domain-b): `src/domain/components.ts`, `src/domain/components.test.ts` (837 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin. (done with Batch 252)
- [x] Batch 332 (domain-b): `src/domain/components.ts` (837 lines), part 2 of 2 (after T10 b1): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [x] Batch 333 (domain-a): `src/domain/workOrders.ts`, `src/domain/workOrders.test.ts` (704 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 334 (domain-a): `src/domain/workOrders.ts` (704 lines), part 2 of 2 (after T10 b4, T15 b1): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them. **Deferred (scope, 2026-11-04):** a cosmetic split with no rule to move; pick it up only if wanted. The Discrepancies screen and its dialogs moved to `Discrepancies.tsx` in the redesign (2026-11-12), with the shared date formats in `recordDates.ts`; the flight log, Sync center and Change history remain.
- [x] Batch 335 (domain-b): `src/domain/airworthiness.ts`, `src/domain/airworthiness.test.ts` (737 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 336 (domain-b): `src/domain/airworthiness.ts` (737 lines), part 2 of 2 (after T12 b4): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them. **Deferred (scope, 2026-11-04):** a cosmetic split with no rule to move; pick it up only if wanted. The Discrepancies screen and its dialogs moved to `Discrepancies.tsx` in the redesign (2026-11-12), with the shared date formats in `recordDates.ts`; the flight log, Sync center and Change history remain.
- [x] Batch 337 (domain-a): `src/domain/taskCards.ts`, `src/domain/taskCards.test.ts` (696 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 338 (domain-a): `src/domain/taskCards.ts` (696 lines), part 2 of 2 (after T10 b3, T3 b1, T12 b4, T21 b5): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them. **Deferred (scope, 2026-11-04):** a cosmetic split with no rule to move; pick it up only if wanted. The Discrepancies screen and its dialogs moved to `Discrepancies.tsx` in the redesign (2026-11-12), with the shared date formats in `recordDates.ts`; the flight log, Sync center and Change history remain.
- [x] Batch 339 (domain-b): `src/domain/partsRequests.ts`, `src/domain/partsRequests.test.ts` (784 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 340 (domain-b): `src/domain/partsRequests.ts` (784 lines), part 2 of 2 (after T10 b4, T12 b3, T14 b1): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them. **Deferred (scope, 2026-11-04):** a cosmetic split with no rule to move; pick it up only if wanted. The Discrepancies screen and its dialogs moved to `Discrepancies.tsx` in the redesign (2026-11-12), with the shared date formats in `recordDates.ts`; the flight log, Sync center and Change history remain.
- [x] Batch 341 (domain-a): `src/domain/purchaseOrders.ts`, `src/domain/purchaseOrders.test.ts` (989 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 342 (domain-a): `src/domain/purchaseOrders.ts` (989 lines), part 2 of 2 (after T12 b3): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them. **Deferred (scope, 2026-11-04):** a cosmetic split with no rule to move; pick it up only if wanted. The Discrepancies screen and its dialogs moved to `Discrepancies.tsx` in the redesign (2026-11-12), with the shared date formats in `recordDates.ts`; the flight log, Sync center and Change history remain.
- [x] Batch 343 (domain-b): `src/domain/costs.ts`, `src/domain/costs.test.ts` (597 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [x] Batch 344 (domain-b): `src/domain/costs.ts` (597 lines), part 2 of 2 (after T12 b2): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [x] Batch 345 (domain-a): `src/domain/workOrderCloseout.ts`, `src/domain/workOrderCloseout.test.ts` (522 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [x] Batch 346 (domain-a): `src/domain/workOrderCloseout.ts` (522 lines), part 2 of 2: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [x] Batch 347 (platform): `src/data/backend.ts` (680 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 348 (platform): `src/data/backend.ts` (680 lines), part 2 of 2 (after T5 b1, T18 b2): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them. **Deferred (scope, 2026-11-04):** a cosmetic split with no rule to move; pick it up only if wanted. The Discrepancies screen and its dialogs moved to `Discrepancies.tsx` in the redesign (2026-11-12), with the shared date formats in `recordDates.ts`; the flight log, Sync center and Change history remain.
- [x] Batch 349 (server): `convex/sampleProgram.ts`, `convex/sampleProgram.test.ts` (680 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 350 (server): `convex/sampleProgram.ts` (680 lines), part 2 of 2: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them. **Deferred (scope, 2026-11-04):** a cosmetic split with no rule to move; pick it up only if wanted. The Discrepancies screen and its dialogs moved to `Discrepancies.tsx` in the redesign (2026-11-12), with the shared date formats in `recordDates.ts`; the flight log, Sync center and Change history remain.
- [x] Batch 351 (ui-b): `src/components/AircraftSpruce.tsx` (522 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [x] Batch 352 (ui-b): `src/components/AircraftSpruce.tsx` (522 lines), part 2 of 2 (after T20 b1): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [x] Batch 353 (ui-a): `src/components/ChecklistEditor.tsx` (526 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 354 (ui-a): `src/components/ChecklistEditor.tsx` (526 lines), part 2 of 2: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them. **Deferred (scope, 2026-11-04):** a cosmetic split with no rule to move; pick it up only if wanted. The Discrepancies screen and its dialogs moved to `Discrepancies.tsx` in the redesign (2026-11-12), with the shared date formats in `recordDates.ts`; the flight log, Sync center and Change history remain.
- [x] Batch 355 (ui-b): `src/components/EngineTrends.tsx` (507 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [x] Batch 356 (ui-b): `src/components/EngineTrends.tsx` (507 lines), part 2 of 2 (after T20 b1): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [x] Batch 357 (server): `convex/admin.ts` (531 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 358 (server): `convex/admin.ts` (531 lines), part 2 of 2 (after T5 b3, T16 b3): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them. **Deferred (scope, 2026-11-04):** a cosmetic split with no rule to move; pick it up only if wanted. The Discrepancies screen and its dialogs moved to `Discrepancies.tsx` in the redesign (2026-11-12), with the shared date formats in `recordDates.ts`; the flight log, Sync center and Change history remain.
- [x] Batch 359 (ui-a): `src/components/FlightForm.tsx`, `src/components/FlightForm.test.ts` (745 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [x] Batch 360 (ui-a): `src/components/FlightForm.tsx` (745 lines), part 2 of 2: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [x] Batch 361 (ui-b): `src/components/PurchaseOrders.tsx` (1705 lines), part 1 of 3: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [x] Batch 362 (ui-b): `src/components/PurchaseOrders.tsx` (1705 lines), part 2 of 3: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 363 (ui-b): `src/components/PurchaseOrders.tsx` (1705 lines), part 3 of 3: split the remaining sections or sub-components into sibling modules; the original file becomes the entry point plus a barrel. **Deferred (scope, 2026-11-04):** a cosmetic split with no rule to move; pick it up only if wanted. The Discrepancies screen and its dialogs moved to `Discrepancies.tsx` in the redesign (2026-11-12), with the shared date formats in `recordDates.ts`; the flight log, Sync center and Change history remain.
- [x] Batch 364 (ui-a): `src/components/AppShell.tsx` (743 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 365 (ui-a): `src/components/AppShell.tsx` (743 lines), part 2 of 2: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them. **Deferred (scope, 2026-11-04):** a cosmetic split with no rule to move; pick it up only if wanted. The Discrepancies screen and its dialogs moved to `Discrepancies.tsx` in the redesign (2026-11-12), with the shared date formats in `recordDates.ts`; the flight log, Sync center and Change history remain.
- [x] Batch 366 (ui-b): `src/components/Checklists.tsx` (627 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 367 (ui-b): `src/components/Checklists.tsx` (627 lines), part 2 of 2: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them. **Deferred (scope, 2026-11-04):** a cosmetic split with no rule to move; pick it up only if wanted. The Discrepancies screen and its dialogs moved to `Discrepancies.tsx` in the redesign (2026-11-12), with the shared date formats in `recordDates.ts`; the flight log, Sync center and Change history remain.
- [x] Batch 368 (ui-a): `src/components/GuidedFlight.tsx` (944 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [x] Batch 369 (ui-a): `src/components/GuidedFlight.tsx` (944 lines), part 2 of 2 (after T7 b2): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [x] Batch 370 (ui-b): `src/components/PartsRequests.tsx` (1619 lines), part 1 of 3: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [x] Batch 371 (ui-b): `src/components/PartsRequests.tsx` (1619 lines), part 2 of 3: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 372 (ui-b): `src/components/PartsRequests.tsx` (1619 lines), part 3 of 3: split the remaining sections or sub-components into sibling modules; the original file becomes the entry point plus a barrel. **Deferred (scope, 2026-11-04):** a cosmetic split with no rule to move; pick it up only if wanted. The Discrepancies screen and its dialogs moved to `Discrepancies.tsx` in the redesign (2026-11-12), with the shared date formats in `recordDates.ts`; the flight log, Sync center and Change history remain.
- [x] Batch 373 (ui-a): `src/components/FlightPlans.tsx` (729 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [x] Batch 374 (ui-a): `src/components/FlightPlans.tsx` (729 lines), part 2 of 2: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [x] Batch 375 (ui-b): `src/components/Manuals.tsx` (646 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 376 (ui-b): `src/components/Manuals.tsx` (646 lines), part 2 of 2: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them. **Deferred (scope, 2026-11-04):** a cosmetic split with no rule to move; pick it up only if wanted. The Discrepancies screen and its dialogs moved to `Discrepancies.tsx` in the redesign (2026-11-12), with the shared date formats in `recordDates.ts`; the flight log, Sync center and Change history remain.
- [x] Batch 377 (ui-a): `src/components/TaskCards.tsx` (1664 lines), part 1 of 3: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [x] Batch 378 (ui-a): `src/components/TaskCards.tsx` (1664 lines), part 2 of 3: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 379 (ui-a): `src/components/TaskCards.tsx` (1664 lines), part 3 of 3: split the remaining sections or sub-components into sibling modules; the original file becomes the entry point plus a barrel. **Deferred (scope, 2026-11-04):** a cosmetic split with no rule to move; pick it up only if wanted. The Discrepancies screen and its dialogs moved to `Discrepancies.tsx` in the redesign (2026-11-12), with the shared date formats in `recordDates.ts`; the flight log, Sync center and Change history remain.
- [x] Batch 380 (ui-b): `src/components/WorkOrders.tsx` (1720 lines), part 1 of 3: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [x] Batch 381 (ui-b): `src/components/WorkOrders.tsx` (1720 lines), part 2 of 3: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 382 (ui-b): `src/components/WorkOrders.tsx` (1720 lines), part 3 of 3: split the remaining sections or sub-components into sibling modules; the original file becomes the entry point plus a barrel. **Deferred (scope, 2026-11-04):** a cosmetic split with no rule to move; pick it up only if wanted. The Discrepancies screen and its dialogs moved to `Discrepancies.tsx` in the redesign (2026-11-12), with the shared date formats in `recordDates.ts`; the flight log, Sync center and Change history remain.
- [x] Batch 383 (ui-a): `src/components/Components.tsx` (1966 lines), part 1 of 3: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [x] Batch 384 (ui-a): `src/components/Components.tsx` (1966 lines), part 2 of 3 (after T13 b3): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 385 (ui-a): `src/components/Components.tsx` (1966 lines), part 3 of 3 (after T13 b3): split the remaining sections or sub-components into sibling modules; the original file becomes the entry point plus a barrel. **Deferred (scope, 2026-11-04):** a cosmetic split with no rule to move; pick it up only if wanted. The Discrepancies screen and its dialogs moved to `Discrepancies.tsx` in the redesign (2026-11-12), with the shared date formats in `recordDates.ts`; the flight log, Sync center and Change history remain.
- [x] Batch 386 (ui-b): `src/components/InspectionTemplates.tsx` (847 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [x] Batch 387 (ui-b): `src/components/InspectionTemplates.tsx` (847 lines), part 2 of 2: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [x] Batch 388 (ui-a): `src/components/ManualDiscovery.tsx` (930 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [x] Batch 389 (ui-a): `src/components/ManualDiscovery.tsx` (930 lines), part 2 of 2 (after T7 b3): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [x] Batch 390 (ui-b): `src/components/MaintenanceCsvImport.tsx` (738 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [x] Batch 391 (ui-b): `src/components/MaintenanceCsvImport.tsx` (738 lines), part 2 of 2: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [x] Batch 392 (ui-a): `src/components/Fleet.tsx` (918 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [x] Batch 393 (ui-a): `src/components/Fleet.tsx` (918 lines), part 2 of 2 (after T7 b3): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [x] Batch 394 (ui-b): `src/components/Management.tsx` (1838 lines), part 1 of 3: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [x] Batch 395 (ui-b): `src/components/Management.tsx` (1838 lines), part 2 of 3: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 396 (ui-b): `src/components/Management.tsx` (1838 lines), part 3 of 3: split the remaining sections or sub-components into sibling modules; the original file becomes the entry point plus a barrel. **Deferred (scope, 2026-11-04):** a cosmetic split with no rule to move; pick it up only if wanted. The Discrepancies screen and its dialogs moved to `Discrepancies.tsx` in the redesign (2026-11-12), with the shared date formats in `recordDates.ts`; the flight log, Sync center and Change history remain.
- [x] Batch 397 (ui-a): `src/components/Records.tsx` (1069 lines), part 1 of 3: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [x] Batch 398 (ui-a): `src/components/Records.tsx` (1069 lines), part 2 of 3: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 399 (ui-a): `src/components/Records.tsx` (1069 lines), part 3 of 3: split the remaining sections or sub-components into sibling modules; the original file becomes the entry point plus a barrel. **Deferred (scope, 2026-11-04):** a cosmetic split with no rule to move; pick it up only if wanted. The Discrepancies screen and its dialogs moved to `Discrepancies.tsx` in the redesign (2026-11-12), with the shared date formats in `recordDates.ts`; the flight log, Sync center and Change history remain.
- [x] Batch 400 (ui-b): `src/components/ProgramUsers.tsx` (504 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [x] Batch 401 (ui-b): `src/components/ProgramUsers.tsx` (504 lines), part 2 of 2: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [x] Batch 402 (ui-a): `src/components/Airworthiness.tsx` (1526 lines), part 1 of 3: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [x] Batch 403 (ui-a): `src/components/Airworthiness.tsx` (1526 lines), part 2 of 3: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 404 (ui-a): `src/components/Airworthiness.tsx` (1526 lines), part 3 of 3: split the remaining sections or sub-components into sibling modules; the original file becomes the entry point plus a barrel. **Deferred (scope, 2026-11-04):** a cosmetic split with no rule to move; pick it up only if wanted. The Discrepancies screen and its dialogs moved to `Discrepancies.tsx` in the redesign (2026-11-12), with the shared date formats in `recordDates.ts`; the flight log, Sync center and Change history remain.
- [x] Batch 405 (ui-b): `src/components/Settings.tsx` (838 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 406 (ui-b): `src/components/Settings.tsx` (838 lines), part 2 of 2: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them. **Deferred (scope, 2026-11-04):** a cosmetic split with no rule to move; pick it up only if wanted. The Discrepancies screen and its dialogs moved to `Discrepancies.tsx` in the redesign (2026-11-12), with the shared date formats in `recordDates.ts`; the flight log, Sync center and Change history remain.
- [x] Batch 407 (ui-a): `src/components/Dashboard.tsx`, `src/components/Dashboard.test.ts` (1012 lines), part 1 of 3: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [x] Batch 408 (ui-a): `src/components/Dashboard.tsx` (1012 lines), part 2 of 3 (after T13 b3): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 409 (ui-a): `src/components/Dashboard.tsx` (1012 lines), part 3 of 3 (after T13 b3): split the remaining sections or sub-components into sibling modules; the original file becomes the entry point plus a barrel. **Deferred (scope, 2026-11-04):** a cosmetic split with no rule to move; pick it up only if wanted. The Discrepancies screen and its dialogs moved to `Discrepancies.tsx` in the redesign (2026-11-12), with the shared date formats in `recordDates.ts`; the flight log, Sync center and Change history remain.
- [ ] Batch 431 (data): `src/data/paperCheckReport.ts` copies the private table writer of `src/data/aircraftStatusReport.ts` (`writeTable`, `wrapCells`, `drawPageHeader`, `writeFooters`). Once the shared table helper (`src/data/tablePdf.ts`, in progress on another branch) lands, move both reports onto it and delete the copies.
- [ ] Batch 432 (ui): `ShopPill` in `src/components/ShopList.tsx` picks a pill's icon from its tone, which every screen's `StatusPill` wants: move the tone-to-icon map into `StatusPill` (`src/components/design.tsx`) and delete `ShopPill`. The job card and work order editor rules (`.job-card-*`, `.work-order-*`) still sit in `src/styles.css`, which loads on every screen; move them to `src/styles/screens/shop.css`, which only the shop screens load.
- [ ] Batch 433 (data): `readFavorites` and `saveFavorites` in `src/data/local.ts` hold every per-user list in device settings (favorites, the device copy of read alerts, the demo's read marks), so their names mislead. Rename them to `readSettingList` and `saveSettingList`, with their callers in `src/data/store.ts`, `src/data/alerts.ts` and `src/data/demoBackend.ts`. The move of every stored file onto expiring links is tracked in [file links](docs/file-links.md#what-is-left), not here.
