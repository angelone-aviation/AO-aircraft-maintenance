# T21 inventory: migration-only code after the fresh start

Batch 410 (T21 b1), 2026-11-04. Read-only: no code changed. For each candidate on the roadmap line, this records what data it touches, the evidence, and whether to keep or remove it. Batches 411–414 remove only what this marks **remove**.

## The facts every decision rests on

- **Production started empty on 2026-11-03; no data was migrated.** The old test deployment was deleted, with nothing carried over ([go-live checklist](../go-live-checklist.md) line 11; README "Deployment").
- **No backup holds older data.** The old deployment's Convex backups went with it, and the off-site copy has not been set up yet: the R2 bucket and the daily Convex backup are still open items ([go-live checklist](../go-live-checklist.md) lines 34–35). Every backup that can ever be restored is a copy of the fresh deployment.
- **No scheduled job runs a candidate.** `convex/crons.ts` schedules only `faa.daily`, `manuals.cleanupUploads` and `alerts.sendDigests`. No workflow in `.github/workflows/` runs a one-off command; they appear only in README "Deployment" and `docs/runbooks/release.md` "After every deploy".
- **Devices hold their own data.** Snapshots and the outbox live in IndexedDB (`src/data/local.ts`) across deploys and server resets, and the demo keeps its full snapshot there too. Code that reads or upgrades that data is not migration-only, whatever the server holds.

## Summary

| Candidate                                                                             | Touches                            | Decision                                                         | Batch         |
| ------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------- | ------------- |
| Plaintext and `enc:v1` acceptance (`convex/secrets.ts`, `convex/secretsMigration.ts`) | Server only                        | **Remove**                                                       | 411           |
| `secretsMigration:reseal` (the re-seal itself)                                        | Server only                        | **Keep**: it is the key-rotation step                            | 411 keeps it  |
| `workOrderCleanup:removeAuthorization` (`convex/workOrderCleanup.ts`)                 | Server only                        | **Remove**                                                       | 412           |
| `src/domain/workOrderCleanup.ts`                                                      | Devices (and the server migration) | **Keep** the cache cleaning; **remove** `retiredWorkOrderFields` | 412           |
| `management:backfillOilMarker`                                                        | Server only                        | **Remove**                                                       | 413           |
| `memberships:backfill`                                                                | Server only                        | **Keep for now**: three test suites use it as their fixture      | follow-up     |
| `counterEvents:recordChanges`                                                         | Server only                        | **Remove**                                                       | 413           |
| `groupAudit:findWidenedGroups`                                                        | Server only                        | **Remove** (not this round)                                      | 414           |
| Unscoped-group handling (`src/domain/groupAircraft.ts`)                               | Server only                        | **Remove**, but the path spans more files than 414 lists         | 414 and later |
| Job-card steps (`src/domain/taskCards.ts`)                                            | Server and devices                 | **Keep**: not migration-only                                     | none          |
| Cached-snapshot format checks (`programScopeVersion`)                                 | Devices                            | **Keep**                                                         | none          |

## Candidates

### Plaintext and `enc:v1` credentials; the re-seal

What it does: `openSecret` (`convex/secrets.ts:123`) still decrypts `enc:v1:` values with key `k1`, and accepts a value without a prefix as plaintext when `legacyPlaintext` is set (`:127`). `openStoredSecret` (`convex/secretsMigration.ts:88`) sets it until `legacyPlaintextAccepted` (`:68`) finds the `credentialMigrations` row that `complete` (`:168`) writes when `reseal` (`:199`) leaves nothing to re-seal.

Evidence:

- Server data only. Credentials live in `faaCredentials`, `addressVerificationSettings` and `spruceAccounts`. No query returns one: status queries say whether a key is set (CONTEXT.md §5, invariant 5). Neither the demo seed (`src/data/demo.ts`, `src/data/demoBackend.ts`) nor `convex/sampleProgram.ts` holds a credential.
- Nothing writes the old formats. Every save seals a v2 value with `sealSecret` before its commit mutation (`faaCredentials.replace`, `addressVerification.setKey`, the Spruce account action), and the Spruce commit refuses anything but `SEALED_V2` (`convex/aircraftSpruce.ts:34`). A fresh deployment has never held plaintext or v1.
- No backup can bring them back (see the facts above).
- `scripts/backup/exportFixture.ts` contains `enc:v1:FIXTURE-…` strings. They are opaque probes that the records workbook must never print. They never reach `convex/secrets.ts`, so they are unaffected.

Decision:

- **Remove** the `enc:v1` branch, the plaintext acceptance with its warning, `legacyPlaintextAccepted`, `complete`, and `isSealed`. A plaintext or v1 value is then refused with "A saved credential is not encrypted. An administrator must enter it again.", which Batch 411 pins.
- **Keep** `reseal`, `stored`, `replace` and `needsReseal`. Re-sealing v2 values under a new key is step 3 of [rotating the key](../runbooks/credentials-key.md#rotating-the-key), which every deployment needs, fresh or not.
- Keep `openStoredSecret` with its signature: `faaCredentials.ts:78`, `addressVerification.ts:154` and `aircraftSpruceActions.ts:267` call it, and `addressVerification.ts` belongs to Batch 322. After 411 it only calls `openSecret`, so inlining it at those three callers is a follow-up.
- Keep the `credentialMigrations` table in `convex/schema.ts`, which is not in 411's files. A schema push that drops a table must not meet a deployment that still holds a row; whether to drop it is a separate decision.

### Work-order authorization fields (`workOrderCleanup`)

What it does: `removeAuthorization` (`convex/workOrderCleanup.ts`) strips `customerApproval`, `approvedScope`, `estimate` and `additionalWorkApproval` from stored work orders and appends one change-log entry for each order it changes. In the domain module, `removeWorkOrderAuthorization` and `cleanWorkOrderSnapshot` strip the same fields from cached snapshots, and `retiredWorkOrderFields` lists them for the server's change-log entry.

Evidence:

- Nothing writes the fields. No code names them outside the cleanup module. `workOrderSchema` and the command schemas are plain `z.object`s, which drop unknown keys, and the demo seed has none. A fresh deployment has no order to clean.
- **Devices use the domain module.** `src/data/local.ts:18` imports `cleanWorkOrderSnapshot`. The IndexedDB upgrade to version 2 (`local.ts:36-42`) cleans every cached snapshot, and `readSnapshot` and `saveSnapshot` clean on each read and write. A device that ran an older build keeps its cache across deploys, and nothing here can show that no such device exists. `src/data/workOrderCache.test.ts` pins the behaviour.

Decision:

- **Remove** `convex/workOrderCleanup.ts` and `convex/workOrderCleanup.test.ts`, and `retiredWorkOrderFields` (only the server migration uses it) with its test lines.
- **Keep** `removeWorkOrderAuthorization` and `cleanWorkOrderSnapshot`, for devices.
- The ADR-0005 note about the migration is history and stays.

### `management:backfillOilMarker`

What it does: it pages through the whole change log and marks as engine oil every stock item with a `stock.oil_used` entry, appending `stock.oil_marker_backfill`. It schedules its own next page.

Evidence:

- Server data only. Every `stock.oil_used` entry written today is for marked stock: `oilInventoryDeductions` (`src/domain/oilInventory.ts`), which flight submission calls, refuses stock without `oil: true` (`:113`).
- On a fresh deployment the backfill finds nothing to mark. Its only possible effect is to re-mark an item that an administrator later un-marked, which nothing should do.
- It schedules only itself (`ctx.scheduler.runAfter` on its own next page). No cron or workflow runs it.

Decision: **remove** it, with `markOilStock`, `OIL_BACKFILL_BATCH`, `convex/oilMarkerBackfill.test.ts`, and the README and runbook steps (`docs/runbooks/release.md`, `docs/checklists.md`).

### `memberships:backfill`

What it does: it rebuilds every account's `memberships` rows from `users.groupIds`, one page at a time.

Evidence:

- Production does not need it. Every write to `groupIds` resyncs the index in the same transaction: `admin.updateUser` (`convex/admin.ts:340`), `programUsers` at its three patches (`:121`, `:237`, `:278`), group deletion (`removeGroupMemberships`), and a group's first program assignment (`recordProgramAssigned`). New accounts start with `groupIds: []`.
- **Tests use it as a fixture.** Three suites seed users directly and call it to build the index: `convex/alerts.test.ts:81` and `:283`, `convex/groupDeletion.test.ts:64`, and `convex/ownerPortal.test.ts:143`. None of them is in Batch 413's files.

Decision: **keep it for now.** Remove it once those three suites seed the index through `syncMemberships` (a follow-up batch). The README step can go now, because no deployment needs it run.

### `counterEvents:recordChanges`

What it does: for an aircraft with a counter event that lacks `changed`, it works out which counters the event set, rebuilds the totals from the flight log, and appends entries for every aircraft and flight it changes. `convex/counterEvents.ts` holds nothing else.

Evidence:

- Server data only. The only writer of counter events, `recordCounterChange` (`src/domain/fleet.ts:409`), always records `changed` and `previous`. `admin.createAircraft` writes no events, and a flight review saves the events `rebuildFlights` returns, which always carry `changed`. The demo seed and `convex/sampleProgram.ts` have no counter events.
- On a fresh deployment every event is explicit, so the mutation skips every aircraft.

Decision: **remove** `convex/counterEvents.ts` and `convex/counterEvents.test.ts`, and the README and runbook steps. Not in this candidate: the domain still resolves events without `changed` in `resolveExplicitEvents` (`src/domain/flights.ts:354`, Finding 22, pinned by `convex/flightChronology.test.ts`). It is dead on fresh data too, but it is in `flights.ts`, which needs its own batch.

### `groupAudit:findWidenedGroups`

What it does: it is a read-only, paged command over the same `reviewGroups` check that serves Administration → Permission groups through `groupAudit.groupsToReview` (`src/data/backend.ts:980`).

Evidence: server data only. It was the one-time check after the fix for #34, and no group on a fresh deployment was saved before that fix. Anything it could still find, the Administration list shows. It is not scheduled.

Decision: **remove** the command (Batch 414, not this round), with its README, release-runbook, accounts-runbook and `docs/flight-program-access.md` mentions. **Keep** `groupsToReview`: it is a live screen, not a candidate.

### Unscoped permission groups (`src/domain/groupAircraft.ts`)

What it does: `assertGroupProgramChange` allows a system administrator to give a group with no Flight Program its first one. `groupAircraftLabel` counts an unscoped group's aircraft without a fleet. Around them are `recordProgramAssigned` (`convex/admin.ts`), the demo's copy (`src/data/demoBackend.ts:1380-1414`), and the form's note (`src/components/PermissionGroupForm.tsx:124`).

Evidence:

- Server data only, and none exists. `admin.saveGroup` refuses a group without an existing program: "Select a Flight Program for this group." (`convex/admin.ts:659`).
- `convex/defaultGroups.ts` and `convex/sampleProgram.ts` always set `programUuid`, and so do the demo seed's groups.
- The group form's program select is required, so the demo cannot create an unscoped group either.

Decision: **remove**, but not in one batch. The path spans `convex/admin.ts`, `src/data/demoBackend.ts` (Tier 2) and `PermissionGroupForm.tsx` as well as the file on 414's line. `groups.programUuid` stays optional in `convex/schema.ts` either way.

### Job-card steps (`src/domain/taskCards.ts`)

Evidence that it is not migration-only:

- `steps` and `stepSignoffs` are required fields of every stored job card (`taskCardFieldsSchema`, `src/domain/taskCards.ts:93` and `:123`). Every snapshot carries them, and devices cache them.
- `taskCards.save` still accepts steps with `signoffRequired: true` from any client; only the screens stopped creating them. `tests/fixtures/taskCards.ts:28` builds one, so the step signoff path is reachable on fresh data.

Decision: **keep.** Retiring steps would change a stored format and a command contract, which is a decision for the owner, not fresh-start cleanup. The file belongs to domain-a this round in any case.

### Cached-snapshot format checks (`programScopeVersion`)

What it does: the workspace shows a cached snapshot only when its `programScopeVersion` is 1 (`src/data/store.ts:226`, `PROGRAM_SCOPE_VERSION`). One cached before Flight Program scoping is dropped until the server sends a new one. `scopedSnapshot` sets the field (`src/domain/programs.ts:418`), and the golden snapshots in `convex/__golden__/` pin it.

Evidence: it guards data on devices, which a fresh server does not reset, and it is the mechanism for the next change to the cached format.

Decision: **keep.** The same holds for the IndexedDB upgrade in `src/data/local.ts`.

## Seen on the way, not candidates

- `faaCredentials.initializeExpiry` is run once by hand, but it is setup for a key held in `FAA_DRS_API_KEY`, not a repair of old data.
- Other old-format readers are inputs users may still hold or have entered, not stored server data: older task CSV files (`taskCsv.ts`), legacy certificate rows (`certifications.ts`), and legacy free-text addresses (`addresses.ts`).
