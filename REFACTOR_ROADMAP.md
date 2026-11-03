# Refactor roadmap

Brings the whole codebase up to [CONSTRAINTS.md](CONSTRAINTS.md) in small, safe, dependency-ordered batches. Read [CONTEXT.md](CONTEXT.md) and [CLAUDE.md](CLAUDE.md) first. The audit behind this plan (2026-11-03) is in [docs/architecture/metrics-2026-11-03.md](docs/architecture/metrics-2026-11-03.md) (size, churn, dependency graph, function metrics, duplication) and [docs/architecture/tier2-candidates.md](docs/architecture/tier2-candidates.md) (the deep-module review).

**Progress:** 1 of 414 batches done. Tier 1: 251 · Tier 2: 78 · Tier 3: 85. Batches 410–414 (T21) close Tier 2 but are numbered after Tier 3, so batches 1–409 keep their numbers.

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
4. **Guided flight skips the tenths-of-an-hour rule** (`GuidedFlight.tsx:441-446`). T7.
5. **ADR-0006's real-Convex browser tests are not in the automated checks.** `tests/e2e/live.spec.ts` has two tests against a real local Convex backend (sign-in, offline reload, discrepancy sync, offline sign-out), but it skips itself unless `npm run test:local` has provisioned a local administrator, so CI runs the demo build only. Logging a flight and closing a work order are not covered.
6. **Owner-only items in `.claude/hooks/`** (agents may not edit it): `check-standards.mjs` nests three levels in one function; the suppression check has no rule for `shellcheck disable`; the hook reminder still lists `improve-codebase-architecture`, which only a person can start.
7. **The architecture report's counts are out of date** (`docs/architecture/README.md`): 54 specs, 52 convex-test suites, about 91 domain modules and 90 component files today.
8. **Address lookup refuses valid stored addresses** (Batch 1). `addressLookupSchema` (`src/domain/addressLookup.ts:4-8`) caps the postal code at 100 characters and the country at 150, but `addressSchema` allows 300, so `lookupInput` throws on an address the app has already saved.
9. **ZIP and Canadian postal codes are checked untrimmed** (Batch 1). `addressIssues` refuses " 20500" although the schema trims it on save. A characterization test in `src/domain/addresses.test.ts` pins this; fix it as a small bug fix in its own commit, updating that test.
10. **The phone message promises more than the check** (Batch 1). It asks for an area or country code, but any 7 digits pass. A product decision: tighten the check or change the message.
11. **The street length limit is redundant** (Batch 1). The 2,000-character street limit never decides on its own: the 1,900-character combined cap already rejects a street over about 1,890 characters.
12. **`addressFromForm` is form shaping in the domain** (Batch 1). It reads `FormData` for `Fleet.tsx` and `Management.tsx` only, and the input name `"addressDetails"` is written separately in `Fleet.tsx:799` and `Management.tsx:1646`. It belongs with the components (CONTEXT.md §5).
13. **`src/domain/addresses.test.ts` also holds the address-lookup tests** (Batch 1): `lookupInput`, `fetchAddressSuggestions`, `parseAddressSuggestions`. Move them to a new `src/domain/addressLookup.test.ts` when that module's batch (Batch 44) runs.
14. **Production started empty on 2026-11-03; no data was migrated** (README "Deployment", `docs/go-live-checklist.md`). Code that only migrates or repairs data written by earlier versions may now be removable; T21 inventories it.

## Tier 1: foundation and leaf modules

Dependency order: modules with no internal imports first, most-imported first. Each batch is a module with its colocated test, or up to three small sibling modules.

- [x] Batch 1 (domain-a): `src/domain/addresses.ts`, `src/domain/addresses.test.ts`
- [ ] Batch 2 (domain-b): `src/domain/ata.ts`, `src/domain/csv.ts`, `src/domain/accountRules.ts`
- [ ] Batch 3 (domain-a): `src/domain/aircraftSpruce.ts`, `src/domain/aircraftSpruce.test.ts`
- [ ] Batch 4 (server): `convex/memberships.ts`, `convex/memberships.test.ts`
- [ ] Batch 5 (server): `convex/secrets.ts`, `convex/secrets.test.ts`
- [ ] Batch 6 (domain-b): `src/domain/signInMethods.ts`, `src/domain/signInMethods.test.ts`
- [ ] Batch 7 (domain-a): `src/domain/logbookWording.ts`, `src/domain/logbookWording.test.ts`
- [ ] Batch 8 (domain-b): `src/domain/componentCalendar.ts`, `src/domain/componentCalendar.test.ts`
- [ ] Batch 9 (domain-a): `src/domain/offsiteBackups.ts`, `src/domain/offsiteBackups.test.ts`
- [ ] Batch 10 (ui-a): `src/styles/screens/maintenance.css`
- [ ] Batch 11 (server): `convex/validators.ts`
- [ ] Batch 12 (domain-b): `src/domain/releaseStatements.ts`, `src/domain/aircraftPhotos.ts`, `src/domain/flightChecklistSchema.ts`
- [ ] Batch 13 (ui-b): `src/styles/screens/dashboard.css`
- [ ] Batch 14 (ui-a): `src/styles/screens/operations.css`
- [ ] Batch 15 (server): `convex/rateLimits.ts`, `convex/attachments.ts`, `convex/storageReferences.ts`
- [ ] Batch 16 (ui-b): `src/components/costs.css`, `src/components/engineTrends.css`, `src/components/ScheduleTracking.tsx`
- [ ] Batch 17 (platform): `src/data/flightPlanDiagnostics.ts`, `src/data/flightPlanDiagnostics.test.ts`
- [ ] Batch 18 (ui-a): `src/styles/screens/admin.css`
- [ ] Batch 19 (platform): `scripts/backup/convexExport.ts`
- [ ] Batch 20 (ui-b): `src/components/adRegister.css`
- [ ] Batch 21 (ui-a): `src/components/checklists.css`
- [ ] Batch 22 (ui-b): `src/components/ComponentIcon.tsx`, `src/components/drsComboBox.css`, `src/components/faaSearch.css`
- [ ] Batch 23 (ui-a): `src/components/InspectionIcon.tsx`, `src/components/MissionSlogan.tsx`, `src/components/partsRequests.css`
- [ ] Batch 24 (ui-b): `src/components/pdfReader.css`, `src/components/planning.css`, `src/components/purchaseOrders.css`
- [ ] Batch 25 (platform): `src/data/pdfText.ts`, `src/data/logbookPdf.ts`, `src/data/pdfCompatibility.js`
- [ ] Batch 26 (ui-a): `src/styles.css`
- [ ] Batch 27 (ui-b): `src/styles/design.css`
- [ ] Batch 28 (ui-a): `src/styles/screens/flight.css`
- [ ] Batch 29 (ui-b): `src/styles/screens/records.css`
- [ ] Batch 30 (ui-a): `src/styles/screens/settings.css`
- [ ] Batch 31 (ui-b): `src/styles/screens/shop.css`
- [ ] Batch 32 (ui-a): `src/styles/tokens.css`
- [ ] Batch 33 (server): `convex/auth.config.ts`, `convex/crons.ts`, `convex/sampleDocuments.ts`
- [ ] Batch 34 (platform): `scripts/backup/dropbox-upload.mjs`
- [ ] Batch 35 (platform): `scripts/backup/nightly.sh`
- [ ] Batch 36 (platform): `scripts/backup/nightly.test.sh`
- [ ] Batch 37 (platform): `scripts/bootstrap-admin.mjs`, `scripts/check-csp-origin.mjs`, `scripts/configure-auth.mjs`
- [ ] Batch 38 (platform): `scripts/peer-testing-transfer.mjs`
- [ ] Batch 39 (platform): `scripts/serve-dist.mjs`
- [ ] Batch 40 (platform): `scripts/setup-peer-testing.sh`
- [ ] Batch 41 (platform): `scripts/smoke-local.mjs`
- [ ] Batch 42 (ui-b): `src/components/FlightParts.tsx`
- [ ] Batch 43 (domain-a): `src/domain/passwordRules.ts`, `src/domain/passwordRules.test.ts`
- [ ] Batch 44 (domain-b): `src/domain/workOrderCloseoutSchema.ts`, `src/domain/savedAddresses.ts`, `src/domain/addressLookup.ts`
- [ ] Batch 45 (server): `convex/secretsMigration.ts`
- [ ] Batch 46 (domain-a): `src/domain/model.ts`
- [ ] Batch 47 (domain-b): `src/domain/programs.ts`
- [ ] Batch 48 (domain-a): `src/domain/flights.ts`
- [ ] Batch 49 (domain-b): `src/domain/inspectionTemplates.ts`, `src/domain/inspectionTemplates.test.ts`
- [ ] Batch 50 (domain-a): `src/domain/checklists.ts`, `src/domain/checklists.test.ts`
- [ ] Batch 51 (domain-b): `src/domain/requiredParts.ts`, `src/domain/requiredParts.test.ts`
- [ ] Batch 52 (domain-a): `src/domain/fleet.ts`, `src/domain/fleet.test.ts`
- [ ] Batch 53 (domain-b): `src/domain/aircraftStatus.ts`, `src/domain/aircraftStatus.test.ts`
- [ ] Batch 54 (domain-a): `src/domain/certifications.ts`, `src/domain/certifications.test.ts`
- [ ] Batch 55 (domain-b): `src/domain/faa.ts`
- [ ] Batch 56 (domain-a): `src/domain/flightPlans.ts`, `src/domain/flightPlans.test.ts`
- [ ] Batch 57 (domain-b): `src/domain/shelfLife.ts`, `src/domain/shelfLife.test.ts`
- [ ] Batch 58 (domain-a): `src/domain/maintenance.ts`, `src/domain/manuals.ts`, `src/domain/inventoryAttachments.ts`
- [ ] Batch 59 (domain-b): `src/domain/maintenanceCsv.ts`, `src/domain/maintenanceCsv.test.ts`
- [ ] Batch 60 (domain-a): `src/domain/aircraftFiles.ts`, `src/domain/aircraftFiles.test.ts`
- [ ] Batch 61 (domain-b): `src/domain/deferrals.ts`, `src/domain/deferrals.test.ts`
- [ ] Batch 62 (domain-a): `src/domain/workOrderComponentWork.ts`, `src/domain/workOrderComponentWork.test.ts`
- [ ] Batch 63 (domain-b): `src/domain/engineTrends.ts`, `src/domain/engineTrends.test.ts`
- [ ] Batch 64 (domain-a): `src/domain/manualDiscovery.ts`, `src/domain/manualDiscovery.test.ts`
- [ ] Batch 65 (domain-b): `src/domain/ownerView.ts`, `src/domain/ownerView.test.ts`
- [ ] Batch 66 (domain-a): `src/domain/componentInventory.ts`, `src/domain/componentInventory.test.ts`
- [ ] Batch 67 (domain-b): `src/domain/flightFluids.ts`, `src/domain/flightFluids.test.ts`
- [ ] Batch 68 (domain-a): `src/domain/workOrderCards.ts`, `src/domain/workOrderCards.test.ts`
- [ ] Batch 69 (domain-b): `src/domain/componentTemplates.ts`, `src/domain/componentTemplates.test.ts`
- [ ] Batch 70 (ui-a): `src/components/WorkOrderIcon.tsx`, `src/components/ShopList.tsx`, `src/components/OpsList.tsx`
- [ ] Batch 71 (domain-a): `src/domain/faaCredential.ts`, `src/domain/faaCredential.test.ts`
- [ ] Batch 72 (server): `convex/ssoProviders.ts`, `convex/spruceHttp.ts`, `convex/accountGuards.ts`
- [ ] Batch 73 (domain-b): `src/domain/workOrderComponentCorrections.ts`, `src/domain/workOrderComponentCorrections.test.ts`
- [ ] Batch 74 (platform): `src/data/flightPlanPdf.ts`, `src/data/flightPlanPdf.test.ts`
- [ ] Batch 75 (domain-a): `src/domain/workOrderTaskRemoval.ts`, `src/domain/workOrderTaskRemoval.test.ts`
- [ ] Batch 76 (ui-b): `src/components/PdfReader.tsx`
- [ ] Batch 77 (server): `convex/aircraftSpruceActions.ts`
- [ ] Batch 78 (platform): `src/data/demo.ts`
- [ ] Batch 79 (server): `convex/programContext.ts`
- [ ] Batch 80 (domain-b): `src/domain/auditHistory.ts`, `src/domain/auditHistory.test.ts`
- [ ] Batch 81 (domain-a): `src/domain/logbook.ts`
- [ ] Batch 82 (domain-b): `src/domain/activateTemplate.ts`, `src/domain/activateTemplate.test.ts`
- [ ] Batch 83 (domain-a): `src/domain/groupAircraft.ts`, `src/domain/groupAircraft.test.ts`
- [ ] Batch 84 (platform): `src/data/deviceManuals.ts`, `src/data/deviceManuals.test.ts`
- [ ] Batch 85 (domain-b): `src/domain/faaSearch.ts`, `src/domain/faaSearch.test.ts`
- [ ] Batch 86 (domain-a): `src/domain/deleteInspectionTemplates.ts`, `src/domain/deleteInspectionTemplates.test.ts`
- [ ] Batch 87 (domain-b): `src/domain/inventoryPrinting.ts`, `src/domain/inventoryPrinting.test.ts`
- [ ] Batch 88 (domain-a): `src/domain/partsPlanning.ts`
- [ ] Batch 89 (domain-b): `src/domain/pilotView.ts`, `src/domain/pilotView.test.ts`
- [ ] Batch 90 (domain-a): `src/domain/programTransfers.ts`, `src/domain/programTransfers.test.ts`
- [ ] Batch 91 (domain-b): `src/domain/adRemaining.ts`, `src/domain/adRemaining.test.ts`
- [ ] Batch 92 (domain-a): `src/domain/adOwnership.ts`, `src/domain/adCompliance.ts`, `src/domain/flightChecklistLink.ts`
- [ ] Batch 93 (domain-b): `src/domain/forecast.ts`, `src/domain/forecast.test.ts`
- [ ] Batch 94 (domain-a): `src/domain/taskCsv.ts`, `src/domain/taskCsv.test.ts`
- [ ] Batch 95 (domain-b): `src/domain/oilInventory.ts`, `src/domain/oilInventory.test.ts`
- [ ] Batch 96 (domain-a): `src/domain/recurringParts.ts`, `src/domain/recurringParts.test.ts`
- [ ] Batch 97 (domain-b): `src/domain/vendors.ts`, `src/domain/vendors.test.ts`
- [ ] Batch 98 (platform): `src/data/adReport.ts`, `src/data/adReport.test.ts`
- [ ] Batch 99 (platform): `src/data/pdfRuntime.ts`, `src/data/pdfOffline.ts`, `src/data/fmd.ts`
- [ ] Batch 100 (domain-a): `src/domain/workOrderCleanup.ts`, `src/domain/workOrderCleanup.test.ts`
- [ ] Batch 101 (ui-a): `src/components/PreflightMaintenance.tsx`, `src/components/PreflightMaintenance.test.ts`
- [ ] Batch 102 (platform): `src/data/manualPdf.ts`, `src/data/adImport.ts`, `src/data/partsRequestPdf.ts`
- [ ] Batch 103 (domain-b): `src/domain/flightLogImport.ts`, `src/domain/flightLogImport.test.ts`
- [ ] Batch 104 (domain-a): `src/domain/flightSession.ts`, `src/domain/flightSession.test.ts`
- [ ] Batch 105 (domain-b): `src/domain/defaultPermissionGroups.ts`, `src/domain/groupDeletion.ts`, `src/domain/guidedFlight.ts`
- [ ] Batch 106 (domain-a): `src/domain/inventoryScan.ts`, `src/domain/inventoryScan.test.ts`
- [ ] Batch 107 (domain-b): `src/domain/signTaskCard.ts`, `src/domain/signTaskCard.test.ts`
- [ ] Batch 108 (domain-a): `src/domain/taskCardValidation.ts`, `src/domain/taskCardValidation.test.ts`
- [ ] Batch 109 (domain-b): `src/domain/taskCardZone.ts`, `src/domain/taskCardZone.test.ts`
- [ ] Batch 110 (platform): `src/data/local.ts`, `src/data/local.test.ts`
- [ ] Batch 111 (domain-a): `src/domain/groupAccessReview.ts`, `src/domain/groupAccessReview.test.ts`
- [ ] Batch 112 (server): `convex/faaCredentials.ts`, `convex/faaCredentials.test.ts`
- [ ] Batch 113 (domain-b): `src/domain/faaCandidateReview.ts`, `src/domain/faaCandidateReview.test.ts`
- [ ] Batch 114 (domain-a): `src/domain/faaMonitoringSearch.ts`, `src/domain/faaMonitoringSearch.test.ts`
- [ ] Batch 115 (domain-b): `src/domain/flightSubmission.ts`, `src/domain/flightSubmission.test.ts`
- [ ] Batch 116 (server): `convex/identities.ts`
- [ ] Batch 117 (server): `convex/recurringParts.ts`, `convex/recurringParts.test.ts`
- [ ] Batch 118 (platform): `src/data/demoAircraftFiles.ts`, `src/data/poPdf.ts`, `src/data/inventoryPrintDocument.ts`
- [ ] Batch 119 (server): `convex/aircraftFiles.ts`, `convex/aircraftFiles.test.ts`
- [ ] Batch 120 (server): `convex/aircraftSpruce.ts`, `convex/aircraftSpruce.test.ts`
- [ ] Batch 121 (server): `convex/manuals.ts`, `convex/manuals.test.ts`
- [ ] Batch 122 (platform): `src/data/aircraftStatusReport.ts`
- [ ] Batch 123 (server): `convex/addressVerification.ts`, `convex/addressVerification.test.ts`
- [ ] Batch 124 (server): `convex/aircraftPhotos.ts`, `convex/aircraftPhotos.test.ts`
- [ ] Batch 125 (server): `convex/audit.ts`, `convex/audit.test.ts`
- [ ] Batch 126 (server): `convex/auditHistory.ts`, `convex/auditHistory.test.ts`
- [ ] Batch 127 (server): `convex/backups.ts`, `convex/backups.test.ts`
- [ ] Batch 128 (server): `convex/certifications.ts`, `convex/certifications.test.ts`
- [ ] Batch 129 (server): `convex/counterEvents.ts`, `convex/counterEvents.test.ts`
- [ ] Batch 130 (server): `convex/groupDeletion.ts`, `convex/groupDeletion.test.ts`
- [ ] Batch 131 (server): `convex/inventoryFiles.ts`, `convex/inventoryFiles.test.ts`
- [ ] Batch 132 (server): `convex/programUsers.ts`, `convex/programUsers.test.ts`
- [ ] Batch 133 (server): `convex/savedAddresses.ts`, `convex/savedAddresses.test.ts`
- [ ] Batch 134 (server): `convex/workOrderCleanup.ts`, `convex/workOrderCleanup.test.ts`
- [ ] Batch 135 (platform): `src/data/store.ts`, `src/data/store.test.ts`
- [ ] Batch 136 (domain-a): `src/domain/alerts.ts`, `src/domain/alerts.test.ts`
- [ ] Batch 137 (server): `convex/defaultGroups.ts`, `convex/defaultGroups.test.ts`
- [ ] Batch 138 (server): `convex/access.ts`, `convex/poFiles.ts`, `convex/auth.ts`
- [ ] Batch 139 (server): `convex/faaSearch.ts`, `convex/faaSearch.test.ts`
- [ ] Batch 140 (server): `convex/management.ts`, `convex/management.test.ts`
- [ ] Batch 141 (server): `convex/workOrderCopies.ts`, `convex/workOrderCopies.test.ts`
- [ ] Batch 142 (server): `convex/airworthiness.ts`, `convex/airworthiness.test.ts`
- [ ] Batch 143 (server): `convex/checklists.ts`, `convex/checklists.test.ts`
- [ ] Batch 144 (server): `convex/componentTemplates.ts`, `convex/componentTemplates.test.ts`
- [ ] Batch 145 (server): `convex/costs.ts`, `convex/costs.test.ts`
- [ ] Batch 146 (server): `convex/engineTrends.ts`, `convex/engineTrends.test.ts`
- [ ] Batch 147 (server): `convex/groupAudit.ts`, `convex/groupAudit.test.ts`
- [ ] Batch 148 (server): `convex/inspectionTemplates.ts`, `convex/inspectionTemplates.test.ts`
- [ ] Batch 149 (server): `convex/partsRequests.ts`, `convex/partsRequests.test.ts`
- [ ] Batch 150 (server): `convex/programs.ts`, `convex/programs.test.ts`
- [ ] Batch 151 (server): `convex/taskCards.ts`, `convex/taskCards.test.ts`
- [ ] Batch 152 (server): `convex/taskImports.ts`, `convex/taskImports.test.ts`
- [ ] Batch 153 (ui-b): `src/components/ui.tsx`
- [ ] Batch 154 (ui-a): `src/components/DrsComboBox.tsx`
- [ ] Batch 155 (ui-b): `src/components/AircraftFiles.tsx`
- [ ] Batch 156 (ui-a): `src/components/MaintenanceUi.tsx`, `src/components/ExportAircraftStatus.tsx`, `src/components/GroupAccessReview.tsx`
- [ ] Batch 157 (ui-b): `src/components/KeepOnDevice.tsx`
- [ ] Batch 158 (server): `convex/faa.ts`
- [ ] Batch 159 (ui-a): `src/components/OilInventoryFields.tsx`
- [ ] Batch 160 (platform): `src/data/demoBackup.ts`, `src/data/auditHistory.ts`, `src/data/alerts.ts`
- [ ] Batch 161 (server): `convex/flightPlans.ts`, `convex/fleet.ts`, `convex/http.ts`
- [ ] Batch 162 (server): `convex/purchaseOrders.ts`, `convex/purchaseOrders.test.ts`
- [ ] Batch 163 (server): `convex/workOrders.ts`, `convex/workOrders.test.ts`
- [ ] Batch 164 (ui-b): `src/components/AircraftPhoto.tsx`, `src/components/DemoBackup.tsx`, `src/components/ManagementShared.tsx`
- [ ] Batch 165 (ui-a): `src/components/AddressFields.tsx`
- [ ] Batch 166 (ui-b): `src/components/SignInMethods.tsx`, `src/components/SignInMethods.test.ts`
- [ ] Batch 167 (ui-a): `src/components/TaskCsvImport.tsx`
- [ ] Batch 168 (ui-b): `src/components/AircraftStatus.tsx`, `src/components/AtaChapterField.tsx`, `src/components/FaaKeySettings.tsx`
- [ ] Batch 169 (ui-a): `src/components/FlightFluids.tsx`
- [ ] Batch 170 (ui-b): `src/components/InventoryScanner.tsx`
- [ ] Batch 171 (ui-a): `src/components/LogbookWording.tsx`, `src/components/LogbookWording.test.ts`
- [ ] Batch 172 (ui-b): `src/components/UserProfile.tsx`
- [ ] Batch 173 (ui-a): `src/components/Alerts.tsx`
- [ ] Batch 174 (ui-b): `src/components/Costs.tsx`
- [ ] Batch 175 (ui-a): `src/components/InventoryAttachments.tsx`
- [ ] Batch 176 (ui-b): `src/components/InventoryPrinting.tsx`
- [ ] Batch 177 (ui-a): `src/components/LogbookEntry.tsx`
- [ ] Batch 178 (ui-b): `src/components/PermissionGroupForm.tsx`
- [ ] Batch 179 (ui-a): `src/components/DeleteGroupButton.tsx`, `src/components/AddressVerificationSettings.tsx`, `src/components/ADTrackingFields.tsx`
- [ ] Batch 180 (ui-b): `src/components/ComponentCloseoutCorrection.tsx`
- [ ] Batch 181 (ui-a): `src/components/CoreReturns.tsx`
- [ ] Batch 182 (ui-b): `src/components/AircraftInspectionSchedules.tsx`, `src/components/CalendarExemptionFields.tsx`, `src/components/Deferrals.tsx`
- [ ] Batch 183 (ui-a): `src/components/FaaSearchImport.tsx`
- [ ] Batch 184 (ui-b): `src/components/FlightLogImport.tsx`
- [ ] Batch 185 (ui-a): `src/components/LogbookSample.tsx`
- [ ] Batch 186 (ui-b): `src/components/PlanComponentMovement.tsx`
- [ ] Batch 187 (ui-a): `src/components/Planning.tsx`
- [ ] Batch 188 (ui-b): `src/components/ReleaseStatements.tsx`
- [ ] Batch 189 (ui-a): `src/components/RequestedComponentMovement.tsx`
- [ ] Batch 190 (ui-b): `src/components/WorkOrderComponentWork.tsx`
- [ ] Batch 191 (ui-a): `src/components/WorkOrderCosts.tsx`
- [ ] Batch 192 (server): `convex/alerts.ts`, `convex/alerts.test.ts`
- [ ] Batch 193 (ui-b): `src/components/SavedAddresses.tsx`
- [ ] Batch 194 (ui-a): `src/components/Vendors.tsx`
- [ ] Batch 195 (ui-b): `src/components/WorkOrderRevisions.tsx`
- [ ] Batch 196 (ui-a): `src/components/OwnerPortal.tsx`
- [ ] Batch 197 (ui-b): `src/components/FlightSession.tsx`
- [ ] Batch 198 (ui-a): `src/components/ActivateTemplate.tsx`
- [ ] Batch 199 (ui-b): `src/components/ComponentTemplates.tsx`
- [ ] Batch 200 (ui-a): `src/components/ADRegister.tsx`
- [ ] Batch 201 (ui-b): `src/components/Admin.tsx`
- [ ] Batch 202 (platform): `src/App.tsx`
- [ ] Batch 203 (platform): `src/main.tsx`
- [ ] Batch 204 (platform): `.github/workflows/backup.yml`, `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`
- [ ] Batch 205 (platform): `compose.yaml`, `index.html`, `playwright.config.ts`
- [ ] Batch 206 (platform): `vite.config.ts`
- [ ] Batch 207 (domain-b): `src/domain/pdf/icao.ts`
- [ ] Batch 208 (ui-a): `src/styles/screens/signin.css`
- [ ] Batch 209 (platform): `scripts/backup/decrypt.sh`, `scripts/backup/records-workbook.mjs`
- [ ] Batch 210 (platform): `scripts/icons.mjs`
- [ ] Batch 211 (platform): `src/cspSafeZod.ts`, `src/vite-env.d.ts`
- [ ] Batch 212 (domain-a): `src/domain/ownerDue.ts`, `src/domain/alertDigest.ts`
- [ ] Batch 213 (ui-b): `src/components/RequiredParts.tsx`, `src/components/ADWorkOrderButton.tsx`
- [ ] Batch 214 (platform): `.github/dependabot.yml`
- [ ] Batch 215 (platform): `public/theme-init.js`
- [ ] Batch 216 (platform): `vitest.config.ts`
- [ ] Batch 217 (domain-b): `src/domain/commonPasswords.ts` (data list: header and docstring only)

### Tier 1, continued: test files without a module of their own

Header, a docstring on shared helpers, WHY comments, named constants for magic values, and no suppressions. Assertions stay exactly as they are.

- [ ] Batch 218 (server): `convex/accountSecurity.test.ts`, `convex/authRefreshToken.test.ts`, `convex/dispatch.test.ts`
- [ ] Batch 219 (server): `convex/faaMonitoring.test.ts`, `convex/flightChronology.test.ts`, `convex/groupAccess.test.ts`
- [ ] Batch 220 (server): `convex/inventoryShelfLife.test.ts`, `convex/oilMarkerBackfill.test.ts`, `convex/ownerPortal.test.ts`
- [ ] Batch 221 (server): `convex/requiredParts.test.ts`, `convex/signInMethods.test.ts`, `convex/signInProviders.test.ts`
- [ ] Batch 222 (platform): `scripts/backup/dropboxUpload.test.ts`
- [ ] Batch 223 (platform): `src/data/demoGroupAccess.test.ts`, `src/data/demoGroups.test.ts`, `src/data/workOrderCache.test.ts`
- [ ] Batch 224 (domain-a): `src/domain/adCorrections.test.ts`, `src/domain/adDueBoundaries.test.ts`, `src/domain/c441Import.test.ts`
- [ ] Batch 225 (domain-b): `src/domain/calendarExemption.test.ts`, `src/domain/componentAssembly.test.ts`, `src/domain/componentMovements.test.ts`
- [ ] Batch 226 (domain-a): `src/domain/domain.test.ts`, `src/domain/dueBoundaries.test.ts`, `src/domain/flightChronology.test.ts`
- [ ] Batch 227 (domain-b): `src/domain/flightOptions.test.ts`, `src/domain/flightTimeLog.test.ts`, `src/domain/helicopter.test.ts`
- [ ] Batch 228 (domain-a): `src/domain/landingSchedules.test.ts`, `src/domain/logbookPerformers.test.ts`, `src/domain/unlinkTaskCard.test.ts`
- [ ] Batch 229 (domain-b): `src/domain/workOrderRevisions.test.ts`
- [ ] Batch 230 (platform): `tests/csp-report.ts`
- [ ] Batch 231 (platform): `tests/e2e/ad-work-order.spec.ts`, `tests/e2e/addresses.spec.ts`, `tests/e2e/admin-layout.spec.ts`
- [ ] Batch 232 (platform): `tests/e2e/aircraft-photos.spec.ts`, `tests/e2e/aircraft-spruce.spec.ts`, `tests/e2e/aircraft-status-export.spec.ts`
- [ ] Batch 233 (platform): `tests/e2e/airworthiness.spec.ts`, `tests/e2e/alerts.spec.ts`, `tests/e2e/calendar-exemption.spec.ts`
- [ ] Batch 234 (platform): `tests/e2e/checklists.spec.ts`, `tests/e2e/component-create-attachments.spec.ts`, `tests/e2e/component-inventory.spec.ts`
- [ ] Batch 235 (platform): `tests/e2e/component-templates.spec.ts`, `tests/e2e/delete-templates.spec.ts`, `tests/e2e/drs-fields.spec.ts`
- [ ] Batch 236 (platform): `tests/e2e/fleet.spec.ts`, `tests/e2e/flight-options.spec.ts`, `tests/e2e/flight-plans.spec.ts`
- [ ] Batch 237 (platform): `tests/e2e/flight-time-log.spec.ts`, `tests/e2e/guided-flight.spec.ts`, `tests/e2e/initial-component.spec.ts`
- [ ] Batch 238 (platform): `tests/e2e/inspection-remaining.spec.ts`, `tests/e2e/inspection-templates.spec.ts`, `tests/e2e/interface.spec.ts`
- [ ] Batch 239 (platform): `tests/e2e/inventory-attachments.spec.ts`, `tests/e2e/inventory-printing.spec.ts`, `tests/e2e/landing-schedules.spec.ts`
- [ ] Batch 240 (platform): `tests/e2e/live.spec.ts`, `tests/e2e/logbook-wording.spec.ts`, `tests/e2e/maintenance-csv.spec.ts`
- [ ] Batch 241 (platform): `tests/e2e/management.spec.ts`, `tests/e2e/manual-discovery.spec.ts`, `tests/e2e/manuals-on-device.spec.ts`
- [ ] Batch 242 (platform): `tests/e2e/manuals.spec.ts`, `tests/e2e/parts-requests.spec.ts`, `tests/e2e/pdf-reader.spec.ts`
- [ ] Batch 243 (platform): `tests/e2e/permission-groups.spec.ts`, `tests/e2e/pilot-view.spec.ts`, `tests/e2e/program-users.spec.ts`
- [ ] Batch 244 (platform): `tests/e2e/purchase-orders.spec.ts`, `tests/e2e/records-layout.spec.ts`, `tests/e2e/requested-component-movement.spec.ts`
- [ ] Batch 245 (platform): `tests/e2e/required-parts.spec.ts`, `tests/e2e/requirement-tracking-options.spec.ts`, `tests/e2e/security-headers.spec.ts`
- [ ] Batch 246 (platform): `tests/e2e/settings.spec.ts`, `tests/e2e/sign-in-methods.spec.ts`, `tests/e2e/task-cards.spec.ts`
- [ ] Batch 247 (platform): `tests/e2e/task-csv.spec.ts`, `tests/e2e/user-certifications.spec.ts`, `tests/e2e/vendors.spec.ts`
- [ ] Batch 248 (platform): `tests/e2e/work-order-template-cards.spec.ts`, `tests/e2e/work-orders.spec.ts`, `tests/e2e/workspace.spec.ts`
- [ ] Batch 249 (platform): `tests/fixtures/cacheStorage.ts`, `tests/fixtures/componentMovement.ts`, `tests/fixtures/localDateTime.ts`
- [ ] Batch 250 (platform): `tests/fixtures/requiredParts.ts`, `tests/fixtures/savedAddress.ts`, `tests/fixtures/taskCards.ts`
- [ ] Batch 251 (platform): `tests/fixtures/templateDeletion.ts`, `tests/fixtures/workOrderTasks.ts`, `tests/fixtures/workOrders.ts`

## Tier 2: shallow pass-throughs and tangled services

From the deep-module review in [docs/architecture/tier2-candidates.md](docs/architecture/tier2-candidates.md), which has each candidate's evidence, interface sketch, risk and tests. Do the batches in this order: it follows each candidate's dependencies. A batch also brings every file it touches up to the standards.


### T10. One rejection type, exposed by default, with a stale-version guard

- [ ] Batch 252 (T10 b1): `src/domain/rejection.ts` (new), `src/domain/flightSubmission.ts`, `src/domain/components.ts` (the classes; existing errors re-parented)
- [ ] Batch 253 (T10 b2): `convex/runCommand.ts`, `convex/runCommand.test.ts` (default `expose` = `Rejection`, from `load` too)
- [ ] Batch 254 (T10 b3, b4…): ≤3 domain modules each, leaf first: `src/domain/taskCards.ts`, `src/domain/flightPlans.ts`, `src/domain/inspectionTemplates.ts`; then `src/domain/workOrders.ts`, `src/domain/partsRequests.ts`, `src/domain/fleet.ts`; then the rest (`assertCurrent` and `Rejection` at each site)

### T1. Collection codec: a stored row ⇄ a Snapshot collection, once

- [ ] Batch 255 (T1 b1): `convex/collections.ts` (new), `convex/runCommand.ts` (`hydrate` decodes through the codec)
- [ ] Batch 256 (T1 b2): `convex/operations.ts` (`snapshot` decodes through the codec)
- [ ] Batch 257 (T1 b3): `convex/costs.ts`, `convex/programs.ts`, `convex/recurringParts.ts` (ad-hoc decoders go through the codec)
- [ ] Batch 258 (T1 b4): `scripts/backup/recordsWorkbook.ts`, `scripts/backup/exportFixture.ts` (decode and encode through the codec; the scripts already bundle `src/` with esbuild)
- [ ] Batch 259 (T1 b5): `convex/runCommand.ts`, `src/domain/model.ts` (`undefined` for collections that are not loaded, and `Pick<Snapshot, …>` as the applier parameter (G). This changes behaviour, so it needs its own ADR status note.) Needs its own ADR status note; behaviour changes.

### T9. Changed-row writer: `runCommand` owns persist

- [ ] Batch 260 (T9 b1): `convex/runCommand.ts`: `writeChanged` plus its tests in `convex/runCommand.test.ts` (after T1 b1)
- [ ] Batch 261 (T9 b2): `convex/partsRequests.ts`, `convex/purchaseOrders.ts`, `convex/costs.ts`
- [ ] Batch 262 (T9 b3): `convex/airworthiness.ts`, `convex/taskCards.ts`, `convex/fleet.ts`
- [ ] Batch 263 (T9 b4): `convex/management.ts`, `convex/inspectionTemplates.ts`; adds the missing guard, a behaviour change recorded in a test
- [ ] Batch 264 (T9 b5): `convex/workOrders.ts` (after T15)
- [ ] Batch 265 (T9 b6): `convex/programs.ts`
- [ ] Batch 266 (T9 b7): the seven collision messages unified into one; client-visible

### T2. Discrepancy resolution as a domain command

- [ ] Batch 267 (T2 b1): `src/domain/deferrals.ts`, with its test (the new applier and its tests)
- [ ] Batch 268 (T2 b2): `convex/operations.ts` (`resolveDiscrepancy` moves onto `runCommand` with the applier; stored data unchanged)
- [ ] Batch 269 (T2 b3): `src/data/demoBackend.ts` (the demo uses the applier; this is an explicit behaviour fix)

### T3. Attachment rules shared by both adapters

- [ ] Batch 270 (T3 b1): `src/domain/taskCards.ts`, `src/domain/attachments.ts` (new), with tests (the new domain rules)
- [ ] Batch 271 (T3 b2): `convex/taskCards.ts`, `convex/attachments.ts` (the server uses the domain rules; output unchanged)
- [ ] Batch 272 (T3 b3): `convex/workOrders.ts` (one shared "open work order" access check)
- [ ] Batch 273 (T3 b4): `src/data/demoBackend.ts` (the demo applies the cap and the evidence rule)

### T4. Server upload pipeline and one blob-reference list

- [ ] Batch 274 (T4 b1): `convex/attachments.ts`, `convex/storageReferences.ts` (`deleteBlobIfUnused` goes through `storageReferenced`)
- [ ] Batch 275 (T4 b2): `convex/attachments.ts`, `convex/inventoryFiles.ts`, `convex/poFiles.ts` (adds `storeThenFinish` and moves the first two actions onto it)
- [ ] Batch 276 (T4 b3): `convex/aircraftPhotos.ts`, `convex/aircraftFiles.ts`, `convex/certifications.ts` (moves three more actions)
- [ ] Batch 277 (T4 b4): `convex/taskCards.ts`, `convex/workOrders.ts` (moves the last two; coordinate with T3 b2–b3)

### T5. Retire the second aircraft-creation path

- [ ] Batch 278 (T5 b1): `src/data/backend.ts`, `src/data/demoBackend.ts`, `src/data/store.test.ts` (drop the dead method)
- [ ] Batch 279 (T5 b2): `scripts/smoke-local.mjs`, `convex/programUsers.test.ts` (move both callers to `fleet.save`)
- [ ] Batch 280 (T5 b3): `convex/admin.ts` (delete the mutation, or make it the wrapper)

### T6. Leftover mutations with no domain applier

- [ ] Batch 281 (T6 b1): `src/domain/manuals.ts`, `convex/manuals.ts`
- [ ] Batch 282 (T6 b2): `src/domain/savedAddresses.ts`, `convex/savedAddresses.ts`
- [ ] Batch 283 (T6 b3): `src/domain/faa.ts`, `convex/faa.ts`
- [ ] Batch 284 (T6 b4): `src/domain/programs.ts`, `convex/programs.ts` (`select`)
- [ ] Batch 285 (T6 b5): `src/data/demoBackend.ts`: all four demo methods

### T7. Meter-reading value module

- [ ] Batch 286 (T7 b1): `src/domain/readings.ts` (new, with test), `src/domain/model.ts` (`parseHours` and the refine move into the module)
- [ ] Batch 287 (T7 b2): `src/components/GuidedFlight.tsx`, `src/domain/guidedFlight.ts` (the guided flight uses the module; this is the bug-shaped case)
- [ ] Batch 288 (T7 b3): `src/components/FlightParts.tsx`, `src/components/ManualDiscovery.tsx`, `src/components/Fleet.tsx` (the remaining conversions)

### T16. Membership and permission-group rules into the domain

- [ ] Batch 289 (T16 b1): `src/domain/accountRules.ts` (with test) (the new rules)
- [ ] Batch 290 (T16 b2): `convex/programUsers.ts` (uses the rules)
- [ ] Batch 291 (T16 b3): `convex/admin.ts` (`saveGroup`, `createUser`)
- [ ] Batch 292 (T16 b4): `src/data/demoBackend.ts` (membership and group methods)

### T12. Change-log rows composed once, in the domain, with `programUuid` stamped

- [ ] Batch 293 (T12 b1): `src/domain/changeLog.ts` (new, with tests) (the constructor)
- [ ] Batch 294 (T12 b2): `src/domain/fleet.ts`, `src/domain/costs.ts`, `src/domain/recurringParts.ts` (existing literals use the constructor)
- [ ] Batch 295 (T12 b3): `src/domain/purchaseOrders.ts`, `src/domain/partsRequests.ts` (existing literals use the constructor)
- [ ] Batch 296 (T12 b4, b5…): ≤3 at a time: the applier (domain), its Convex `audit` hook, and the demo method (appliers start pushing their own entries: AD, then deferral and parts, then checklist, task card and plan, then templates)

### T11. Conflict review (flight review) as a domain command

- [ ] Batch 297 (T11 b1): `src/domain/flights.test.ts` (new) (characterization only)
- [ ] Batch 298 (T11 b2): `src/domain/flightReview.ts` (new, with tests) (the domain sequence)
- [ ] Batch 299 (T11 b3): `convex/operations.ts` (onto `runCommand`; stored output unchanged)
- [ ] Batch 300 (T11 b4): `src/data/demoBackend.ts` (the demo uses the domain sequence; explicit behaviour fix)

### T13. Maintenance due list: one module for "what is due on this aircraft"

- [ ] Batch 301 (T13 b1): `src/domain/dueItems.ts` (new, with tests), `src/domain/ownerDue.ts` (the module; the owner view uses it)
- [ ] Batch 302 (T13 b2): `src/domain/partsPlanning.ts`, `src/domain/alerts.ts`
- [ ] Batch 303 (T13 b3): `src/components/Dashboard.tsx`, `src/components/Components.tsx`
- [ ] Batch 304 (T13 b4): `src/domain/forecast.ts`, `src/domain/flightPlans.ts`
- [ ] Batch 305 (T13 b5): `src/domain/aircraftStatus.ts` (must produce identical grounded and due-soon reasons on the characterization fleet; any difference needs sign-off)

### T8. Split the records workbook

- [ ] Batch 306 (T8 b1): `scripts/backup/xlsxWriter.ts` (new), `scripts/backup/recordsWorkbook.ts` (moves the writer out)
- [ ] Batch 307 (T8 b2): `scripts/backup/exportSnapshot.ts` (new), `scripts/backup/recordsWorkbook.ts` (moves decoding out)
- [ ] Batch 308 (T8 b3): `scripts/backup/recordsWorkbook.ts` (`dueItems` replaced by the domain module)

### T17. Status-record documents: content separate from PDF layout

- [ ] Batch 309 (T17 b1): `src/domain/statusSheet.ts` (new, with test), `src/data/aircraftStatusReport.ts` (content moves to the domain)
- [ ] Batch 310 (T17 b2): `src/data/pdfLayout.ts` (new), `src/data/poPdf.ts`, `src/data/partsRequestPdf.ts` (the shared paragraph layout)
- [ ] Batch 311 (T17 b3): `src/data/aircraftStatusReport.ts`, `src/data/adReport.ts` (both use `tablePdf`)
- [ ] Batch 312 (T17 b4): `scripts/backup/recordsWorkbook.ts` (`aircraftSheet` reads `statusSheet`)

### T14. Recurring-parts occurrences generated inside the appliers

- [ ] Batch 313 (T14 b1): `src/domain/recurringParts.ts`, `src/domain/partsRequests.ts` (the applier generates occurrences; adds `recurringPartsNeeds`)
- [ ] Batch 314 (T14 b2): `convex/partsRequests.ts` (the generation moves out of `persist`)
- [ ] Batch 315 (T14 b3): `convex/recurringParts.ts`, `convex/workOrders.ts`, `convex/workOrderCopies.ts`
- [ ] Batch 316 (T14 b4): `src/data/demoBackend.ts`

### T15. Work-order "add inspection" fast path onto the applier, plus the ADR-0003 post-apply hook

- [ ] Batch 317 (T15 b1): `src/domain/workOrders.ts` (extract `addInspectionTask`)
- [ ] Batch 318 (T15 b2): `convex/runCommand.ts`, `convex/runCommand.test.ts` (adds `afterApply`)
- [ ] Batch 319 (T15 b3): `convex/workOrders.ts`, `convex/workOrderCopies.ts` (drops `delegate` and `startCopy`'s checks; scheduling moves to `afterApply`)

### T18. Request ids on every command

- [ ] Batch 320 (T18 b1): `convex/schema.ts`, `convex/runCommand.ts` (the new table, written alongside the old one (expand))
- [ ] Batch 321 (T18 b2…): ≤3 command schemas and their mutations at a time (the client generates `requestUuid` in `src/data/backend.ts`)

### T19. Network calls out of the business-rules layer

Found by the boundary check in CONTEXT.md §5: five functions in `src/domain` call `fetch`. Convex actions call `fetchAddressSuggestions`, `searchFAA` and `fetchMonitoringCandidates`; `fetchDrsFiltered` is called only from those domain functions; `fetchDrsCandidates` has no production caller (only `src/domain/airworthiness.test.ts`). Move the called ones into the Convex module that uses them and delete `fetchDrsCandidates`; the parsing and validation stay in the domain.

- [ ] Batch 322 (T19 b1): `src/domain/addressLookup.ts`, `convex/addressVerification.ts` (`fetchAddressSuggestions` moves to the server)
- [ ] Batch 323 (T19 b2): `src/domain/faa.ts`, `src/domain/faaSearch.ts`, `src/domain/faaMonitoringSearch.ts` (`fetchDrsFiltered`, `searchFAA` and `fetchMonitoringCandidates` move behind one server module; `fetchDrsCandidates` and its tests in `src/domain/airworthiness.test.ts` are deleted; coordinate with T6 b3)

### T20. One server-error message helper for the UI

The same `ConvexError` message extraction is written five times in components: `ui.tsx`, `EngineTrends.tsx`, `SavedAddresses.tsx` and `SignInMethods.tsx`, each with its own fallback text, and a variant in `AircraftSpruce.tsx`. Export one helper from `ui.tsx` that takes the fallback text as a parameter, so each screen keeps its current message, and import it everywhere. `src/data/store.ts:317` keeps its own copy, because the data layer may not import `src/components`.

- [ ] Batch 324 (T20 b1): `src/components/ui.tsx`, `src/components/EngineTrends.tsx`, `src/components/SavedAddresses.tsx`, `src/components/SignInMethods.tsx` (and `src/components/AircraftSpruce.tsx` in the same commit if it is still separate)

### T21. Fresh start: remove migration-only code

Production started empty on 2026-11-03 and no data was migrated (Finding 14), so code that exists only to migrate or repair data written by earlier versions may be dead. Every removal needs the b1 inventory first. A removal batch takes at most 3 source files, removes or updates their tests, and drops the README's one-off data-repair step for what it removes.

- [ ] Batch 410 (T21 b1): read-only inventory, no code change. For each candidate, confirm that it touches stored server data only, not data on devices or demo seeds, and record keep or remove: the reseal path in `convex/secretsMigration.ts` and the plaintext and `enc:v1` acceptance in `convex/secrets.ts`; `convex/workOrderCleanup.ts` and `src/domain/workOrderCleanup.ts`; `management:backfillOilMarker` (`convex/management.ts`); `memberships:backfill` (`convex/memberships.ts`); `counterEvents:recordChanges` (`convex/counterEvents.ts`); `groupAudit:findWidenedGroups` (`convex/groupAudit.ts`); legacy unscoped-group handling (`src/domain/groupAircraft.ts`); legacy job-card steps (`src/domain/taskCards.ts`); cached-snapshot format checks such as `programScopeVersion` (`src/data/store.ts`, `src/domain/model.ts`).
- [ ] Batch 411 (T21 b2, needs b1): `convex/secretsMigration.ts`, `convex/secrets.ts`, `convex/secrets.test.ts` (the reseal path; plaintext and `enc:v1` acceptance)
- [ ] Batch 412 (T21 b3, needs b1): `convex/workOrderCleanup.ts`, `src/domain/workOrderCleanup.ts`, with `convex/workOrderCleanup.test.ts` and `src/domain/workOrderCleanup.test.ts`
- [ ] Batch 413 (T21 b4, needs b1): `convex/management.ts` (`backfillOilMarker`), `convex/memberships.ts` (`backfill`), `convex/counterEvents.ts` (`recordChanges`), with `convex/oilMarkerBackfill.test.ts`, `convex/memberships.test.ts` and `convex/counterEvents.test.ts`
- [ ] Batch 414 (T21 b5, needs b1): `convex/groupAudit.ts` (`findWidenedGroups`), `src/domain/groupAircraft.ts` (legacy unscoped-group handling), `src/domain/taskCards.ts` (legacy job-card steps), with their tests. The cached-snapshot format checks guard snapshots cached on devices, so expect b1 to keep them; any it clears for removal get a batch of their own.

## Tier 3: monoliths and god files (over 500 lines)

Each file is decomposed behind a backward-compatible barrel: the original path keeps exporting everything it exports today, so no importer changes. Parts run in order.

- [ ] Batch 325 (server): `convex/schema.ts` (599 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 326 (server): `convex/schema.ts` (599 lines), part 2 of 2 (after T18 b1): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 327 (ui-a): `src/components/design.tsx` (906 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 328 (ui-a): `src/components/design.tsx` (906 lines), part 2 of 2: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 329 (domain-a): `src/domain/management.ts`, `src/domain/management.test.ts` (789 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 330 (domain-a): `src/domain/management.ts` (789 lines), part 2 of 2: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 331 (domain-b): `src/domain/components.ts`, `src/domain/components.test.ts` (837 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 332 (domain-b): `src/domain/components.ts` (837 lines), part 2 of 2 (after T10 b1): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 333 (domain-a): `src/domain/workOrders.ts`, `src/domain/workOrders.test.ts` (704 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 334 (domain-a): `src/domain/workOrders.ts` (704 lines), part 2 of 2 (after T10 b4, T15 b1): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 335 (domain-b): `src/domain/airworthiness.ts`, `src/domain/airworthiness.test.ts` (737 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 336 (domain-b): `src/domain/airworthiness.ts` (737 lines), part 2 of 2 (after T12 b4): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 337 (domain-a): `src/domain/taskCards.ts`, `src/domain/taskCards.test.ts` (696 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 338 (domain-a): `src/domain/taskCards.ts` (696 lines), part 2 of 2 (after T10 b3, T3 b1, T12 b4, T21 b5): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 339 (domain-b): `src/domain/partsRequests.ts`, `src/domain/partsRequests.test.ts` (784 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 340 (domain-b): `src/domain/partsRequests.ts` (784 lines), part 2 of 2 (after T10 b4, T12 b3, T14 b1): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 341 (domain-a): `src/domain/purchaseOrders.ts`, `src/domain/purchaseOrders.test.ts` (989 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 342 (domain-a): `src/domain/purchaseOrders.ts` (989 lines), part 2 of 2 (after T12 b3): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 343 (domain-b): `src/domain/costs.ts`, `src/domain/costs.test.ts` (597 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 344 (domain-b): `src/domain/costs.ts` (597 lines), part 2 of 2 (after T12 b2): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 345 (domain-a): `src/domain/workOrderCloseout.ts`, `src/domain/workOrderCloseout.test.ts` (522 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 346 (domain-a): `src/domain/workOrderCloseout.ts` (522 lines), part 2 of 2: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 347 (platform): `src/data/backend.ts` (680 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 348 (platform): `src/data/backend.ts` (680 lines), part 2 of 2 (after T5 b1, T18 b2): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 349 (server): `convex/sampleProgram.ts`, `convex/sampleProgram.test.ts` (680 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 350 (server): `convex/sampleProgram.ts` (680 lines), part 2 of 2: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 351 (ui-b): `src/components/AircraftSpruce.tsx` (522 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 352 (ui-b): `src/components/AircraftSpruce.tsx` (522 lines), part 2 of 2 (after T20 b1): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 353 (ui-a): `src/components/ChecklistEditor.tsx` (526 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 354 (ui-a): `src/components/ChecklistEditor.tsx` (526 lines), part 2 of 2: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 355 (ui-b): `src/components/EngineTrends.tsx` (507 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 356 (ui-b): `src/components/EngineTrends.tsx` (507 lines), part 2 of 2 (after T20 b1): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 357 (server): `convex/admin.ts` (531 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 358 (server): `convex/admin.ts` (531 lines), part 2 of 2 (after T5 b3, T16 b3): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 359 (ui-a): `src/components/FlightForm.tsx`, `src/components/FlightForm.test.ts` (745 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 360 (ui-a): `src/components/FlightForm.tsx` (745 lines), part 2 of 2: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 361 (ui-b): `src/components/PurchaseOrders.tsx` (1705 lines), part 1 of 3: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 362 (ui-b): `src/components/PurchaseOrders.tsx` (1705 lines), part 2 of 3: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 363 (ui-b): `src/components/PurchaseOrders.tsx` (1705 lines), part 3 of 3: split the remaining sections or sub-components into sibling modules; the original file becomes the entry point plus a barrel.
- [ ] Batch 364 (ui-a): `src/components/AppShell.tsx` (743 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 365 (ui-a): `src/components/AppShell.tsx` (743 lines), part 2 of 2: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 366 (ui-b): `src/components/Checklists.tsx` (627 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 367 (ui-b): `src/components/Checklists.tsx` (627 lines), part 2 of 2: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 368 (ui-a): `src/components/GuidedFlight.tsx` (944 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 369 (ui-a): `src/components/GuidedFlight.tsx` (944 lines), part 2 of 2 (after T7 b2): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 370 (ui-b): `src/components/PartsRequests.tsx` (1619 lines), part 1 of 3: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 371 (ui-b): `src/components/PartsRequests.tsx` (1619 lines), part 2 of 3: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 372 (ui-b): `src/components/PartsRequests.tsx` (1619 lines), part 3 of 3: split the remaining sections or sub-components into sibling modules; the original file becomes the entry point plus a barrel.
- [ ] Batch 373 (ui-a): `src/components/FlightPlans.tsx` (729 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 374 (ui-a): `src/components/FlightPlans.tsx` (729 lines), part 2 of 2: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 375 (ui-b): `src/components/Manuals.tsx` (646 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 376 (ui-b): `src/components/Manuals.tsx` (646 lines), part 2 of 2: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 377 (ui-a): `src/components/TaskCards.tsx` (1664 lines), part 1 of 3: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 378 (ui-a): `src/components/TaskCards.tsx` (1664 lines), part 2 of 3: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 379 (ui-a): `src/components/TaskCards.tsx` (1664 lines), part 3 of 3: split the remaining sections or sub-components into sibling modules; the original file becomes the entry point plus a barrel.
- [ ] Batch 380 (ui-b): `src/components/WorkOrders.tsx` (1720 lines), part 1 of 3: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 381 (ui-b): `src/components/WorkOrders.tsx` (1720 lines), part 2 of 3: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 382 (ui-b): `src/components/WorkOrders.tsx` (1720 lines), part 3 of 3: split the remaining sections or sub-components into sibling modules; the original file becomes the entry point plus a barrel.
- [ ] Batch 383 (ui-a): `src/components/Components.tsx` (1966 lines), part 1 of 3: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 384 (ui-a): `src/components/Components.tsx` (1966 lines), part 2 of 3 (after T13 b3): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 385 (ui-a): `src/components/Components.tsx` (1966 lines), part 3 of 3 (after T13 b3): split the remaining sections or sub-components into sibling modules; the original file becomes the entry point plus a barrel.
- [ ] Batch 386 (ui-b): `src/components/InspectionTemplates.tsx` (847 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 387 (ui-b): `src/components/InspectionTemplates.tsx` (847 lines), part 2 of 2: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 388 (ui-a): `src/components/ManualDiscovery.tsx` (930 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 389 (ui-a): `src/components/ManualDiscovery.tsx` (930 lines), part 2 of 2 (after T7 b3): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 390 (ui-b): `src/components/MaintenanceCsvImport.tsx` (738 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 391 (ui-b): `src/components/MaintenanceCsvImport.tsx` (738 lines), part 2 of 2: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 392 (ui-a): `src/components/Fleet.tsx` (918 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 393 (ui-a): `src/components/Fleet.tsx` (918 lines), part 2 of 2 (after T7 b3): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 394 (ui-b): `src/components/Management.tsx` (1838 lines), part 1 of 3: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 395 (ui-b): `src/components/Management.tsx` (1838 lines), part 2 of 3: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 396 (ui-b): `src/components/Management.tsx` (1838 lines), part 3 of 3: split the remaining sections or sub-components into sibling modules; the original file becomes the entry point plus a barrel.
- [ ] Batch 397 (ui-a): `src/components/Records.tsx` (1069 lines), part 1 of 3: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 398 (ui-a): `src/components/Records.tsx` (1069 lines), part 2 of 3: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 399 (ui-a): `src/components/Records.tsx` (1069 lines), part 3 of 3: split the remaining sections or sub-components into sibling modules; the original file becomes the entry point plus a barrel.
- [ ] Batch 400 (ui-b): `src/components/ProgramUsers.tsx` (504 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 401 (ui-b): `src/components/ProgramUsers.tsx` (504 lines), part 2 of 2: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 402 (ui-a): `src/components/Airworthiness.tsx` (1526 lines), part 1 of 3: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 403 (ui-a): `src/components/Airworthiness.tsx` (1526 lines), part 2 of 3: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 404 (ui-a): `src/components/Airworthiness.tsx` (1526 lines), part 3 of 3: split the remaining sections or sub-components into sibling modules; the original file becomes the entry point plus a barrel.
- [ ] Batch 405 (ui-b): `src/components/Settings.tsx` (838 lines), part 1 of 2: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 406 (ui-b): `src/components/Settings.tsx` (838 lines), part 2 of 2: extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 407 (ui-a): `src/components/Dashboard.tsx`, `src/components/Dashboard.test.ts` (1012 lines), part 1 of 3: standards pass: header, TSDoc on every export, WHY comments, named constants, guard clauses. Write characterization tests first where coverage is thin.
- [ ] Batch 408 (ui-a): `src/components/Dashboard.tsx` (1012 lines), part 2 of 3 (after T13 b3): extract pure logic (data shaping, formatting, validation, rules) into sibling modules; the original file re-exports them.
- [ ] Batch 409 (ui-a): `src/components/Dashboard.tsx` (1012 lines), part 3 of 3 (after T13 b3): split the remaining sections or sub-components into sibling modules; the original file becomes the entry point plus a barrel.
