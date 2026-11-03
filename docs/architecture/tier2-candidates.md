# Angel One: Tier 2 deepening candidates

Date: 2026-11-03. This is a read-only review: no file in the repository was changed. It builds on `docs/architecture/README.md`, the 2026-11-01 report, and its "Done since this report" section. A, B, C and the move half of D are done: `convex/runCommand.ts` and `src/domain/flightSubmission.ts`. It respects the decisions in ADR-0003 and ADR-0006:

- **F** (narrowing the `Backend` interface) is not pursued.
- **E** (form-to-command shaping) is after launch and limited to the close-out readings.
- The second half of **D** (a shared command table) waits.

New evidence about E, F and D is in §4.

**Vocabulary.** The terms come from the `codebase-design` skill: **module**, **interface**, **implementation**, **depth**, **seam**, **adapter**, **leverage**, **locality**, and **the deletion test**. Domain nouns follow `GLOSSARY.md`: Command, Audit entry, Conflict review, Dispatch gate, Status record, Close-out, Job card, Signoff, and so on. In this report, "Component" always means the GLOSSARY's tracked part, never a React file.

**Method.** I used `rg` and `wc` to count call sites and line numbers, and read representative code in each area. Each `file:line` was checked against the tree as it stood on 2026-11-03. Some counts come from regex and are approximate; they are marked with "≈".

**Scoring.** Impact and Risk are each scored H=3, M=2 or L=1. Candidates are ranked by Impact ÷ Risk. Ties are broken in this order:

1. higher impact;
2. fewer batches that must come first;
3. relevance to safety records.

---

## 1. Ranking

| Rank | ID | Candidate | Impact | Risk | Score | Depends on |
|---|---|---|---|---|---|---|
| 1 | T1 | Collection codec: a stored row ⇄ a Snapshot collection, once | H | L | 3.0 | none |
| 2 | T2 | Discrepancy resolution as a domain command | M | L | 2.0 | none (T12 helps) |
| 3 | T3 | Attachment rules shared by both adapters (new evidence clears signoffs) | M | L | 2.0 | none |
| 4 | T4 | Server upload pipeline and one blob-reference list | M | L | 2.0 | none |
| 5 | T5 | Retire the second aircraft-creation path | M | L | 2.0 | none |
| 6 | T6 | Leftover non-command mutations: manuals ×3, saved address, FAA monitor, program select | M | L | 2.0 | none (T12 helps) |
| 7 | T7 | Meter-reading value module (hours ⇄ seconds, tenths rule) | M | L | 2.0 | none; inside E's perimeter, see §4 |
| 8 | T8 | Split the records workbook | M | L | 2.0 | T1 b1, T13 b1 |
| 9 | T9 | Changed-row writer: `runCommand` owns persist | H | M | 1.5 | T1 b1–b2 |
| 10 | T10 | One rejection type, exposed by default, with a stale-version guard | H | M | 1.5 | none |
| 11 | T11 | Conflict review (flight review) as a domain command | H | M | 1.5 | T10 b1 helps |
| 12 | T12 | Change-log rows composed once, in the domain, with `programUuid` stamped | H | M | 1.5 | none |
| 13 | T13 | Maintenance due list: one module for "what is due on this aircraft" | H | H | 1.0 | none |
| 14 | T14 | Recurring-parts occurrences generated inside the appliers | M | M | 1.0 | T9 helps |
| 15 | T15 | Work-order "add inspection" fast path onto the applier, plus the ADR-0003 post-apply hook | M | M | 1.0 | none |
| 16 | T16 | Membership and permission-group rules into the domain | M | M | 1.0 | none |
| 17 | T17 | Status-record documents: content separate from PDF layout | M | M | 1.0 | T13 b1 |
| 18 | T18 | Request ids on every command (`commandRequests`) | M | H | 0.67 | T9, T12 |

**Suggested order of work.** The order differs from the ranking because some candidates depend on others:

1. T1 b1–b2, then T9.
2. In parallel, the small domain moves: T2, T3, T5, T6.
3. T10 b1, then T12.
4. T11.
5. T13, then T8 and T17.
6. T14 and T15.
7. T18 last, because it changes stored data and every command schema.

---

## 2. Candidates

### T1. Collection codec: a stored row ⇄ a Snapshot collection, once

**Files**

| File | Lines | What it holds |
|---|---|---|
| `convex/runCommand.ts` | 295 | `hydrate`, 205–295 |
| `convex/operations.ts` | 709 | the `snapshot` query, 119–286 |
| `convex/programContext.ts` | 296 | the scoped loaders |
| `convex/costs.ts` | 85 | load, 28–56 |
| `convex/programs.ts` | 190 | transfer load |
| `convex/recurringParts.ts` | 88 | |
| `convex/sampleProgram.ts` | 680 | |
| `scripts/backup/recordsWorkbook.ts` | 2,289 | `decode`, 343–450 |
| `scripts/backup/exportFixture.ts` | 1,713 | |

**Problem.** Each payload-blob table has two rules: how a stored row decodes into its Snapshot collection (zod schema plus `JSON.parse`), and how a record encodes back into a row (which indexed columns are lifted out of the payload). Neither rule has a home. Every reader and writer restates them, so the knowledge has no **locality**. `programContext.ts` holds the scoped *loaders*, which are deep, but it holds no codecs. This is also why the ADR-0003 invariant "unloaded collections are `undefined`" and the partial-Snapshot typing (G) have nowhere to live.

**Evidence**

- **Decoders.** There are ≈90 payload decodes (`schema.parse(JSON.parse(x.payload))` or `JSON.parse(d.payload)`) in 26 Convex files: `operations.ts` 22, `faa.ts` 8, `workOrderCopies.ts` 6, `costs.ts` 6, `programs.ts` 5, `workOrders.ts` 5, and so on.
- **Encoders.** There are 46 `payload: JSON.stringify(` row encodes in 21 Convex files; `sampleProgram.ts` alone has 8.
- **The same collection is decoded in three places.**
  - `hydrate`, as `payload(recordSchema)`: `runCommand.ts:206-209` and 227.
  - The `snapshot` query: `operations.ts:141-189`; `management` itself at 180–182.
  - The workbook's `decode`: `recordsWorkbook.ts:402-437`.
  - `costs.ts:40-53` hand-decodes four more collections for one action.
- **`componentTemplates` and `componentSetups` are never schema-checked.** They are decoded with a bare `JSON.parse` in both `runCommand.ts:275, 281` and `operations.ts:170-175`.
- **The `management` row encoder has six copies, and they disagree about `aircraftUuid`.**

  | File:line | `aircraftUuid` written as |
  |---|---|
  | `management.ts:36-39` | `\|\| undefined` |
  | `programs.ts:133` | `\|\| undefined` |
  | `purchaseOrders.ts:52` | keeps `""` |
  | `workOrders.ts:170/177` | keeps `""`; the patch also omits `kind` and `programUuid` |
  | `inspectionTemplates.ts:68-74` | |
  | `sampleProgram.ts:115-121` | |

  The column has no index (`schema.ts:486-487`), so the disagreement is cosmetic today. It is still drift.
- **The deletion test.** No codec module exists. Deleting the scattered copies is impossible, because the knowledge reappears at every call site. A codec module would earn its keep across about 136 sites in Convex and the backup scripts.

**Proposed deepening.** The codec is in-process, has no I/O, and needs no port or adapter. It goes in a new `convex/collections.ts`, which imports only types from `convex/_generated`, so that `scripts/backup` can import it too. The loaders stay in `programContext.ts`. `hydrate`, the `snapshot` query and the workbook all read through the codec.

```ts
// convex/collections.ts: pure; no ctx.
export interface Collection<R, Row> {
  decode(row: { payload: string }): R;  // schema-checked, always
  encode(record: R): Row;               // the indexed columns and the payload
}
export const COLLECTIONS: { [N in Need]: Collection<Item<N>, RowFields<N>> };
```

**Tests today**

- `convex/runCommand.test.ts` (294 lines);
- `convex/operations.test.ts` (974), which covers the `snapshot` query;
- `scripts/backup/recordsWorkbook.test.ts` (544), with `exportFixture.ts`;
- the 38 convex-test suites, seeded from `demoSnapshot()`.

**Characterization tests first**

1. A golden JSON of the `snapshot` query output for the demo seed: one admin view and one member view.
2. For every table, a round trip over the export fixture: `encode(decode(row))` equals the row with its system fields removed.
3. A test that pins the current `management.aircraftUuid` column per writer, so that normalising it is a deliberate, recorded change.

**Risk: Low.** The module is pure, and the decoders already produce the same results; the golden JSON proves it.

**Impact: High.** It is the precondition for T9 (persist), for G and the `undefined` invariant (ADR-0003), and for T8. It gives **locality** to rules that are now spread across about 136 sites.

**Batches**

| Batch | Files | What |
|---|---|---|
| b1 | `convex/collections.ts` (new), `convex/runCommand.ts` | `hydrate` decodes through the codec |
| b2 | `convex/operations.ts` | `snapshot` decodes through the codec |
| b3 | `convex/costs.ts`, `convex/programs.ts`, `convex/recurringParts.ts` | ad-hoc decoders go through the codec |
| b4 | `scripts/backup/recordsWorkbook.ts`, `scripts/backup/exportFixture.ts` | decode and encode through the codec; the scripts already bundle `src/` with esbuild |
| b5 (later, ADR-0003) | `convex/runCommand.ts`, `src/domain/model.ts` | `undefined` for collections that are not loaded, and `Pick<Snapshot, …>` as the applier parameter (G). This changes behaviour, so it needs its own ADR status note. |

---

### T2. Discrepancy resolution as a domain command

**Files**

| File | Lines | What |
|---|---|---|
| `convex/operations.ts` | 709 | `resolveDiscrepancy`, 445–477 |
| `src/data/demoBackend.ts` | 1,459 | `resolve`, 943–964 |
| `src/domain/deferrals.ts` | 127 | |

**Problem.** Resolving a Discrepancy closes a maintenance record, but the rule has no domain module. Each adapter writes it inline, and the two copies have drifted. The server mutation sits outside `runCommand`, which the report lists as one of the leftovers.

**Evidence: the drift.**

| Rule | Convex (`operations.ts`) | Demo (`demoBackend.ts`) |
|---|---|---|
| "resolve" permission | checked, `:458` | missing |
| Length limit | 1–5000 characters, `:459-460` | none; message is "Describe the repair." |
| Stored text | trimmed, `:465` | untrimmed |
| Already resolved | "This report is already resolved.", `:461-462` | "Already resolved." |
| Missing report | "Report not found.", `:457` | `!` non-null assertion, then a crash, `:946` |
| Audit row | values `{status, resolution, resolvedBy, resolvedAt}`, no `programUuid` | the whole record before and after |

All 59 Playwright specs run against the demo, so none of these server rules is exercised end to end. The deletion test is the same as for C: delete the rule, and it reappears in two adapters.

**Proposed deepening.** The seam is the domain applier interface `(s, command) => void`, which both adapters already use. Convex then runs it through `runCommand` with a load of one discrepancy, the way `deferDiscrepancy` does at `operations.ts:478-507`.

```ts
// src/domain/deferrals.ts (or a new discrepancies.ts)
export function resolveDiscrepancy(
  s: Snapshot, uuid: string, resolution: string, now = Date.now(),
): Discrepancy; // checks can(s, aircraft, "resolve"); 1–5000 chars, trimmed;
                // not already resolved; pushes the "discrepancy.resolved" entry
```

**Tests today.** `convex/operations.test.ts` (3 references to `resolveDiscrepancy`), and e2e on the demo. There is no domain test.

**Characterization tests first.** One case table, run against both adapters: no permission, an empty text, a 5001-character text, already resolved, a missing uuid, and the stored and audit shapes. The demo fails four of the cases, which is the drift being fixed.

**Risk: Low.** The domain is pure, and the server's stored fields do not change.

**Impact: Medium.** It closes a records path and brings the demo, which e2e exercises, in line with the server.

**Batches**

| Batch | Files | What |
|---|---|---|
| b1 | `src/domain/deferrals.ts`, with its test | the new applier and its tests |
| b2 | `convex/operations.ts` | `resolveDiscrepancy` moves onto `runCommand` with the applier; stored data unchanged |
| b3 | `src/data/demoBackend.ts` | the demo uses the applier; this is an explicit behaviour fix |

---

### T3. Attachment rules shared by both adapters

**Files**

| File | Lines | What |
|---|---|---|
| `convex/taskCards.ts` | 213 | `finishUpload`, 122–159 |
| `src/data/demoBackend.ts` | 1,459 | 326–366, 469–533 |
| `convex/attachments.ts` | 41 | |
| `convex/workOrders.ts` | 305 | 209–305 |
| `src/domain/taskCards.ts` | 696 | |

**Problem.** "New evidence is part of the record being signed" is a Signoff-integrity rule. Adding evidence clears the technician, inspector and step Signoffs and bumps the version. The rule lives in two adapters and not in the domain. The attachment cap and the "open record" checks are also adapter-only.

**Evidence**

- **Signoff clearing has two copies,** in `convex/taskCards.ts:144-148` and `demoBackend.ts:350-355`. The domain already clears Signoffs on step signing (`src/domain/taskCards.ts:461-462`), but nothing exposes it for evidence.
- **The demo has no attachment cap.** `MAX_ATTACHMENTS` is enforced through `assertAttachmentRoom` at four Convex sites (`poFiles.ts:60`, `taskCards.ts:135`, `inventoryFiles.ts:53`, `workOrders.ts:241`). The demo never applies it.
- **The work-order "open and writable" check has four copies.** Three are in `convex/workOrders.ts` (`checkUpload` 209–222, `finishUpload` 224–256, `removeFile` 283–305), each looking the order up, authorizing and testing `isOpenWorkOrder`. The fourth is in the demo, `demoBackend.ts:508-512`.
- **The audit values differ.** The server writes `before: t, after: {...t, evidenceName, category}` (`taskCards.ts:154-158`); the demo writes `after: {name, category}` (`demoBackend.ts:356-364`).

**Proposed deepening.** These are domain rules over the card or work order that both adapters call. The seam is the domain interface; the storage write stays in each adapter.

```ts
// src/domain/taskCards.ts
export function withNewEvidence(card: TaskCard, now: number): TaskCard; // clears signoffs, version + 1
// src/domain/attachments.ts (new; the cap moves here from convex/attachments.ts)
export const MAX_ATTACHMENTS = 25;
export function assertAttachmentRoom(count: number): void;
export function assertWorkOrderWritable(s: Snapshot, order: WorkOrder): void;
```

**Tests today.** `convex/taskCards.test.ts` (381), `convex/workOrders.test.ts` (642), `convex/inventoryFiles.test.ts` (197), and e2e for the demo upload. There is no vitest suite for the demo methods.

**Characterization tests first.** On both adapters, uploading evidence to a signed card leaves it unsigned at version + 1, and a 26th attachment is refused. The demo fails the second case today.

**Risk: Low.** The domain is pure; the server's output is unchanged.

**Impact: Medium.** It protects a record-integrity rule and gives the demo the server's cap.

**Batches**

| Batch | Files | What |
|---|---|---|
| b1 | `src/domain/taskCards.ts`, `src/domain/attachments.ts`, with tests | the new domain rules |
| b2 | `convex/taskCards.ts`, `convex/attachments.ts` | the server uses the domain rules; output unchanged |
| b3 | `convex/workOrders.ts` | one shared "open work order" access check |
| b4 | `src/data/demoBackend.ts` | the demo applies the cap and the evidence rule |

---

### T4. Server upload pipeline and one blob-reference list

**Files**

| File | Lines |
|---|---|
| `convex/attachments.ts` | 41 |
| `convex/storageReferences.ts` | 39 |
| `convex/aircraftPhotos.ts` | 102 |
| `convex/inventoryFiles.ts` | 117 |
| `convex/poFiles.ts` | 130 |
| `convex/taskCards.ts` | 213 |
| `convex/certifications.ts` | 140 |
| `convex/aircraftFiles.ts` | 193 |
| `convex/workOrders.ts` | 305 |

**Problem.** Seven upload actions repeat the same transaction-shaped sequence by hand:

1. validate;
2. `runQuery(check)`;
3. `storage.store`;
4. `try { runMutation(finish) } catch { storage.delete; rethrow }`.

Separately, two modules each hold "which tables refer to a blob", with different lists.

**Evidence**

- **The upload sequence has seven copies:** `aircraftPhotos.ts:59-80`, `inventoryFiles.ts:71-92`, `poFiles.ts:85-110`, `taskCards.ts:161-191`, `certifications.ts:104-129`, `aircraftFiles.ts:118-149`, `workOrders.ts:258-282`. Each also pairs a `check` query with a `finish` mutation that re-runs the same access function.
- **The two blob-reference lists differ.**

  | | `STORAGE_REFERENCES` (`storageReferences.ts:6-17`) | `deleteBlobIfUnused` (`attachments.ts:14-41`) |
  |---|---|---|
  | Tables checked | 10 | 5: `inventoryFiles`, `poFiles`, `taskEvidence`, `workOrderFiles`, `manuals` |
  | Tested against `schema.ts` | yes, `manuals.test.ts:441` | no |

  `deleteBlobIfUnused` is used at six sites. The blobs shared today (`sampleProgram.ts:631-677`) all live in the five tables it checks, so nothing is lost yet. A new file table would be caught by the tested list and missed by the other. Deleting a blob cannot be undone.
- **The deletion test.** `deleteBlobIfUnused` collapses to `if (!(await storageReferenced(ctx, id))) await ctx.storage.delete(id)`. Its own list is a pass-through copy of knowledge another module already owns and tests.

**Proposed deepening.** One module owns the action-side seam. Manuals keep their own ticket flow (`manuals.ts:25-182`), which is already deep (see §5).

```ts
// convex/attachments.ts
export async function storeThenFinish<T>(
  ctx: ActionCtx, file: { bytes: ArrayBuffer; type: string },
  finish: (storageId: Id<"_storage">) => Promise<T>,
): Promise<T>; // the blob is deleted if `finish` throws
export async function deleteBlobIfUnused(ctx: MutationCtx, id: Id<"_storage">): Promise<void>;
// = storageReferenced(ctx, id) over STORAGE_REFERENCES
```

**Tests today**

- `inventoryFiles.test.ts` (197), `aircraftFiles.test.ts` (216), `aircraftPhotos.test.ts`, `certifications.test.ts` (186);
- `manuals.test.ts` (443), which includes the schema check on `STORAGE_REFERENCES`;
- `taskCards.test.ts`, `workOrders.test.ts`.

**Characterization tests first.** For each action: when `finish` throws, no blob remains. For removal: a blob shared by two tables survives deleting one row, and a blob in `aircraftFiles` is never deleted through `deleteBlobIfUnused`.

**Risk: Low.** The change is mechanical and the deletion rule becomes strictly safer.

**Impact: Medium.** It removes seven copies, and it closes a gap in a deletion path that cannot be undone.

**Batches**

| Batch | Files | What |
|---|---|---|
| b1 | `convex/attachments.ts`, `convex/storageReferences.ts` | `deleteBlobIfUnused` goes through `storageReferenced` |
| b2 | `convex/attachments.ts`, `convex/inventoryFiles.ts`, `convex/poFiles.ts` | adds `storeThenFinish` and moves the first two actions onto it |
| b3 | `convex/aircraftPhotos.ts`, `convex/aircraftFiles.ts`, `convex/certifications.ts` | moves three more actions |
| b4 | `convex/taskCards.ts`, `convex/workOrders.ts` | moves the last two; coordinate with T3 b2–b3 |

---

### T5. Retire the second aircraft-creation path

**Files**

| File | Lines | What |
|---|---|---|
| `convex/admin.ts` | 531 | `createAircraft`, 394–493: 100 lines |
| `src/data/backend.ts` | 680 | 235, 652–655 |
| `src/data/demoBackend.ts` | 1,459 | 1413–1424 |
| `src/domain/fleet.ts` | 341 | 176–260 |
| `scripts/smoke-local.mjs` | | 99 |

**Problem.** An Aircraft can be created two ways:

- `fleet.save` → `applyFleet`, which is what the UI uses (`Fleet.tsx:71`);
- `admin.createAircraft`, a public mutation with its own 100 lines of validation.

`Backend.createAircraft` has **no UI caller**: the only reference is the mock in `store.test.ts:105`. The server mutation is reached only by `scripts/smoke-local.mjs:99` and `convex/programUsers.test.ts:225-245, 428-431`. Yet any Flight Program administrator's client can call it.

**Evidence**

- **The rules are duplicated, with different conditions and messages.**

  | Rule | `admin.ts` | `fleet.ts` |
  |---|---|---|
  | Meter source | 481–484: "Cyclic Hobbs Meter requires Helicopter." | 196–208: also requires a reading |
  | Registration | `assertAvailableAircraft`, 458 | in-snapshot uniqueness, 210–216 |
  | Baselines | tenths and non-negative checks, 435–455 | |

- **The audit row has no `programUuid`** (`admin.ts:488-491`).
- **The demo adapter's `createAircraft`** (`demoBackend.ts:1413-1424`) checks only the admin permission and that the registration is unique: no tenths rule and no upper-casing.
- **The deletion test.** Delete `Backend.createAircraft` and both of its adapters, and nothing in the app changes. That is a pass-through with no callers. The server mutation is a second, divergent implementation of `applyFleet`'s creation rules.
- **Relation to F.** This is not a narrowing of the `Backend` interface for its width. It removes one method that has no callers.

**Proposed deepening.** There is one creation path: `applyFleet` behind `fleet.save`. Choose one of:

- (a) delete `admin.createAircraft` and switch the smoke script and the tests to `fleet.save`; or
- (b) keep `admin.createAircraft` as a thin wrapper that runs `applyFleet` through `runCommand`, with the baselines mapped into `currentHobbs` and the other readings.

**Tests today.** `convex/programUsers.test.ts`, `convex/memberships.test.ts`, and the fleet suites.

**Characterization tests first.** Port the `programUsers.test.ts` `createAircraft` cases to `fleet.save` and record any case whose result differs, such as the cyclic meter without a reading.

**Risk: Low.** No UI uses the path; the only callers are a script and tests.

**Impact: Medium.** It removes a public write path that bypasses the fleet rules for the record that carries the total-time baselines.

**Batches**

| Batch | Files | What |
|---|---|---|
| b1 | `src/data/backend.ts`, `src/data/demoBackend.ts`, `src/data/store.test.ts` | drop the dead method |
| b2 | `scripts/smoke-local.mjs`, `convex/programUsers.test.ts` | move both callers to `fleet.save` |
| b3 | `convex/admin.ts` | delete the mutation, or make it the wrapper |

---

### T6. Leftover mutations with no domain applier

The mutations are three manual edits, saved address, FAA monitor command and program select.

**Files**

| File | Lines | What |
|---|---|---|
| `convex/manuals.ts` | 295 | 194–295 |
| `convex/savedAddresses.ts` | 116 | 53–116 |
| `convex/faa.ts` | 258 | 72–125 |
| `convex/programs.ts` | 190 | 20–41 |
| `src/data/demoBackend.ts` | 1,459 | 199–268, 544–572, 681–708, 818–829 |
| `src/domain/manuals.ts` | 70 | |
| `src/domain/savedAddresses.ts` | 30 | |
| `src/domain/faa.ts` | 252 | |
| `src/domain/programs.ts` | 397 | |

**Problem.** The report lists these as left outside `runCommand` because they have "no domain applier". The underlying problem is that their rules live in both adapters, so each pair can drift. `prepareSavedAddress` is a shallow parser; every rule sits around it.

**Evidence: one row per mutation.**

| Mutation | Server | Demo | Drift |
|---|---|---|---|
| Manual edit, rename, applicability | `manuals.ts:194-295` | `demoBackend.ts:199-268` | Rules are identical: same-program target aircraft and maintenance access. Messages are copied. The audit `before` differs: the server picks 6 fields (`manuals.ts:284-291`), the demo writes the whole record (`demoBackend.ts:222`). |
| Saved address | `savedAddresses.ts:57-77, 78-89, 96-103` | `demoBackend.ts:681-708` | The demo has no administrator check, no `MAX_SAVED_ADDRESSES` limit and no audit row (the server's row is at `savedAddresses.ts:105-112`). Messages differ, for example "Address changed." against "Address changed. Reopen it before saving." |
| FAA monitor command | `faa.ts:86-99` | `demoBackend.ts:556-565` | On configure, the server resets `runId` and `error`. On review, it throws "Candidate not found." for an unknown id, where the demo ignores it silently. The demo writes no `faa.*` audit row. |
| Program select | `programs.ts:24-32` | `demoBackend.ts:818-829` | The access rule is copied word for word in both adapters. |

The deletion test holds for each rule: delete it, and it reappears in two adapters.

**Proposed deepening.** One domain applier per command, called by both adapters. On Convex, each runs through `runCommand` with a custom `load` and `persist`, because none of these tables is a payload blob.

```ts
editManual(s, uuid, raw): { before: ManualAudit; next: Manual }   // and renameManual, setManualApplicability
saveAddress(s, programUuid, input, existingCount): SavedAddress     // admin, version, unique name, limit
applyFaaCommand(monitor: FaaMonitor, cmd: FaaCommand, now): FaaMonitor // configure resets runId/error; review needs the candidate
assertProgramSelectable(s, programUuid): void
```

**Tests today**

- `convex/manuals.test.ts` (443), `convex/savedAddresses.test.ts` (230), `convex/faaMonitoring.test.ts` (221), `convex/programs.test.ts` (980);
- no domain tests for `manuals.ts`, `savedAddresses.ts`, `faa.ts` or `programs.ts`; the report notes `programs.ts` and `faa.ts` as gaps.

**Characterization tests first.** For each command, a parity case table run against both adapters, built from the current Convex tests.

**Risk: Low.** The changes are small and independent, and the server's output is unchanged.

**Impact: Medium.** No single command matters much, but six mutations are affected, and the demo is the e2e target.

**Batches.** Each batch is independent; each applier then gets a matching demo batch.

| Batch | Files |
|---|---|
| b1 | `src/domain/manuals.ts`, `convex/manuals.ts` |
| b2 | `src/domain/savedAddresses.ts`, `convex/savedAddresses.ts` |
| b3 | `src/domain/faa.ts`, `convex/faa.ts` |
| b4 | `src/domain/programs.ts`, `convex/programs.ts` (`select`) |
| b5 | `src/data/demoBackend.ts`: all four demo methods |

---

### T7. Meter-reading value module

This candidate falls inside E's perimeter; §4 explains why it is listed.

**Files**

| File | Lines | What |
|---|---|---|
| `src/domain/model.ts` | 374 | 80, 360–375 |
| `src/components/GuidedFlight.tsx` | 944 | 405–446 |
| `src/components/FlightParts.tsx` | 223 | 203 |
| `src/components/ManualDiscovery.tsx` | 930 | 543 |
| `src/components/Fleet.tsx` | 918 | 91–123 |
| `convex/admin.ts` | 531 | 449–455 |

**Problem.** The rule that a meter reading is entered in decimal hours and stored as whole seconds in tenths of an hour has three homes, and some flight-entry paths bypass all of them.

**Evidence**

- **The rule's three homes:**
  - the schema's `.refine(n % 360 === 0)` at `model.ts:80`;
  - `parseHours`'s regex at `model.ts:366-374`;
  - an inline check at `admin.ts:449-455`.
- **Flight-entry paths that bypass it.**
  - `FlightForm.tsx:148-152` uses `parseHours`.
  - `GuidedFlight.tsx:441-446` stores `Math.round(Number(value) * 3600)`, so an entry such as "1.25" becomes 4500 s.
  - `guidedFlight.ts:60-63` types the readings as plain `z.number()`.

  Where the guided path first meets the tenths rule (in the outbox, on the server, or never) has to be confirmed by a test. If it is the server, the entry is a permanent rejection in the outbox.
- **More conversions skip `parseHours` and its rounding:** `FlightParts.tsx:203` and `ManualDiscovery.tsx:543`, which does not round at all.
- **There are 51 raw `3600` literals in 14 React files.** The deletion test on `hours` and `parseHours`: they earn their keep, but half the callers do not use them.

**Proposed deepening.** One small, deep value module with a tested interface. Display and parsing go through it.

```ts
// src/domain/readings.ts
export function readingText(seconds?: number): string;            // "1234.5"
export function parseReading(text: string): number | undefined;   // tenths, safe integer; throws with the user message
export const meterReadingSchema: z.ZodNumber;                      // the model.ts:80 refine, defined once
```

**Tests today.** None for `model.ts`, as the report notes. `tests/e2e/guided-flight.spec.ts` covers the guided flight against the demo.

**Characterization tests first.** Pin `parseHours` on "1", "1.2", "1.25", "abc" and a very large value. Pin what a guided shutdown entry of 1.25 h does today, from entry through the outbox to submission, against the demo.

**Risk: Low.** The module is pure and the callers change one at a time.

**Impact: Medium.** Flight readings feed total time and the Dispatch gate.

**Batches**

| Batch | Files | What |
|---|---|---|
| b1 | `src/domain/readings.ts` (new, with test), `src/domain/model.ts` | `parseHours` and the refine move into the module |
| b2 | `src/components/GuidedFlight.tsx`, `src/domain/guidedFlight.ts` | the guided flight uses the module; this is the bug-shaped case |
| b3 | `src/components/FlightParts.tsx`, `src/components/ManualDiscovery.tsx`, `src/components/Fleet.tsx` | the remaining conversions |
| — | `WorkOrders.tsx:814-829` | stays with E after launch; it will reuse the module |

---

### T8. Split the records workbook

**Files.** `scripts/backup/recordsWorkbook.ts` (2,289 lines), `recordsWorkbook.test.ts` (544), `exportFixture.ts` (1,713) and `convexExport.ts` (183).

**Problem.** One module holds four responsibilities, each behind the single `buildRecordsWorkbook` interface:

1. Export decoding, at 343–450. This copies T1's knowledge.
2. Cross-kind due-item derivation, `dueItems` at 585–779. This is a fourth copy of T13's knowledge.
3. Fourteen sheet builders, at 806–1665.
4. The xlsx styling and writer, at 1875–2133.

The interface is deep, which is good. The implementation has no internal seams, so maintainers get no **locality**.

**Evidence**

- `dueItems` re-maps three status vocabularies into levels: lines 649, 699 and 758.
- It re-derives AD hours remaining (`Math.round((task.dueHours - counters.hours) * 3600) / 3600`, line 737), which is the same calculation as `adRemaining.ts:43-46`.
- It applies its own filter for ADs on removed Components: `c && !c.installed`, line 724.
- `decode` hand-builds `Member`, `Group` and `Aircraft` objects (351–373) and five payload collections (397–437).

**Proposed deepening.** Internal seams only; the external interface stays.

- `exportSnapshot.ts`: decodes through T1.
- `sheets.ts`: builds the sheets on T13's `dueItems`.
- `xlsxWriter.ts`: `writeSheet`, `style` and `pageOptions`.

**Tests today.** `recordsWorkbook.test.ts`, run with `npm run test:backup`.

**Characterization tests first.** A cell-value snapshot of the fixture workbook: every sheet and every row, with formatting left out.

**Risk: Low.** It is a convenience copy (ADR-0011), and it is well tested.

**Impact: Medium.** **Locality** for 2,289 lines. It also removes the fourth copy of the due-list rules.

**Batches**

| Batch | Files | What | Dependency |
|---|---|---|---|
| b1 | `scripts/backup/xlsxWriter.ts` (new), `recordsWorkbook.ts` | moves the writer out | none |
| b2 | `scripts/backup/exportSnapshot.ts` (new), `recordsWorkbook.ts` | moves decoding out | after T1 b1 |
| b3 | `recordsWorkbook.ts` | `dueItems` replaced by the domain module | after T13 b1 |

---

### T9. Changed-row writer: `runCommand` owns persist

**Files.** `convex/runCommand.ts` (295) and the persist hooks of:

| File | Lines |
|---|---|
| `partsRequests.ts` | 62 |
| `purchaseOrders.ts` | 97 |
| `costs.ts` | 85 |
| `management.ts` | 170 |
| `airworthiness.ts` | 56 |
| `workOrders.ts` | 305 |
| `programs.ts` | 190 |
| `taskCards.ts` | 213 |
| `inspectionTemplates.ts` | 147 |
| `fleet.ts` | 86 |

**Problem.** ADR-0003 says "`runCommand` owns hydrate, diff and persist". Today it owns hydrate, and only partly; each command still writes its own diff and upsert. The `Command` interface has nine hooks (`parse`, `request`, `delegate`, `load`, `apply`, `expose`, `persist`, `audit`, `returns`). Callers must learn all of them, so `runCommand` is shallow exactly where its callers spend their lines.

**Evidence**

- **≈444 lines of hand-written persist in 10 files.** `workOrders.ts` has ≈90 lines, `programs.ts` ≈71, `management.ts` ≈49.
- **The tenant-isolation guard, "a uuid outside the active Flight Program is never overwritten", is written at seven sites, with six messages and two error classes.**

  | File:line | Message | Class |
  |---|---|---|
  | `partsRequests.ts:33-38` | "Request identifier already used." | Error |
  | `purchaseOrders.ts:35-41` | "PO not found." | ConvexError |
  | `costs.ts:66-75` | "Cost record belongs to another Flight Program." | ConvexError |
  | `management.ts:97-105` (`assertNewManagementUuid`) | "Record belongs to another Flight Program." | Error |
  | `management.ts:66-72` | same message, for inspections | Error |
  | `airworthiness.ts:30-36` | "AD record belongs to another Flight Program." | Error |
  | `inspectionTemplates.ts:30-36` | "Template belongs to another Flight Program." | Error |

  `inspectionTemplates.ts:66-74` (`activate`) inserts `management` rows with **no** guard at all.
- **Inspection metadata stripping has three copies:** the `inspectionSchema.parse({...i, materials ?? "", archived ?? false})` pattern at `management.ts:60-64` and `workOrders.ts:150-154`, and a bare `inspectionSchema.parse(r)` at `inspectionTemplates.ts:75`.
- **The deletion test.** Delete the persist hooks, and the same diff-and-upsert reappears in every file. That diff-and-upsert is the module that is missing.

**Proposed deepening.** A deep writer behind `runCommand`'s interface, built on T1's codecs. `persist` becomes optional: by default, every declared `need` is written by `writeChanged`. Commands with special persistence keep a hook: deletes in `inspectionTemplates.remove`, scheduling in `workOrders.save`, and the audit mapping in `programs.transfer`.

```ts
// convex/runCommand.ts
export async function writeChanged<N extends Need>(
  tx: Transaction, need: N, loaded: Doc<Table<N>>[], records: Item<N>[],
): Promise<void>;
// Replaces rows whose encoded payload changed; inserts new rows after the
// tenant-collision check (one message, one ConvexError); never deletes.
```

**Tests today.** `runCommand.test.ts` (294) and the per-command suites: `management.test.ts` 642, `workOrders.test.ts` 642, `purchaseOrders.test.ts` 359, `partsRequests.test.ts` 294, `costs.test.ts` 276, `programs.test.ts` 980, `inspectionTemplates.test.ts` 214, `airworthiness.test.ts` 261.

**Characterization tests first**

1. A table-dump golden for each command: all touched tables, without `_id` or `_creationTime`, compared before and after each batch.
2. A collision case for each table. The `inspectionTemplates.activate` case documents today's missing guard.
3. Pin the seven collision messages. Unifying them is a client-visible change, so it gets its own batch with a note under ADR-0003.

**Risk: Medium.** The batches write stored rows, though the convex-test coverage is strong.

**Impact: High.** It removes ≈444 lines and centralises the tenant-isolation check. It also delivers the persist half of ADR-0003's interface and makes ADR-0003's "~10-line mutation" possible.

**Batches**

| Batch | Files | Dependency |
|---|---|---|
| b1 | `convex/runCommand.ts`: `writeChanged` plus its tests in `runCommand.test.ts` | after T1 b1 |
| b2 | `convex/partsRequests.ts`, `convex/purchaseOrders.ts`, `convex/costs.ts` | |
| b3 | `convex/airworthiness.ts`, `convex/taskCards.ts`, `convex/fleet.ts` | |
| b4 | `convex/management.ts`, `convex/inspectionTemplates.ts`; adds the missing guard, a behaviour change recorded in a test | |
| b5 | `convex/workOrders.ts` | after T15 |
| b6 | `convex/programs.ts` | |
| b7 | the seven collision messages unified into one; client-visible | |

---

### T10. One rejection type, exposed by default, with a stale-version guard

**Files**

| File | Lines | What |
|---|---|---|
| `convex/runCommand.ts` | 295 | 62–67, 117–123, 185–197 |
| `src/domain/flightSubmission.ts` | 256 | `FlightRejection`, 24 |
| `src/domain/components.ts` | 837 | `ComponentUsageError`, 19 |
| ≈20 domain modules | | the version checks |

**Problem.** Whether a domain error reaches the user is a per-mutation choice, the `expose` hook, not a property of the error. Per `docs/research/error-monitoring-options.md:33`, Convex production deployments show any non-`ConvexError` as a generic "Server Error". Fourteen of the 21 `runCommand` mutations set no `expose`, so their expected rejections reach users as "Server Error":

- `fleet.save`, `workOrders.save`, `partsRequests.execute`, `airworthiness.save`, `flightPlans.save`, `taskImports.save`, `checklists.save`, `programs.transfer`, `taskCards.save`;
- `inspectionTemplates.save`, `activate` and `remove`;
- `operations.deferDiscrepancy` and `saveDiscrepancyParts`.

Errors thrown in `load` never pass through `expose` at all, for example "Work order not found." at `workOrders.ts:66`.

This is the ADR-0003 open invariant "uniform stale-version rejection".

**Evidence**

- **Stale-version rejections lost this way:**
  - "Work order changed. Reopen it before saving." (`domain/workOrders.ts:309`)
  - "Job card changed…" (`taskCards.ts:441`)
  - "Plan changed…" (`flightPlans.ts:65`)
  - "Template changed…" (`inspectionTemplates.ts:151`)
  - "Request changed…" (`partsRequests.ts:394`)
  - "Aircraft changed. Refresh before saving." (`fleet.ts:195`)
  - "Parts changed…" (`requiredParts.ts:173`)
- **About 20 stale-version checks in the domain use 15 message variants and no shared helper.** Examples: `management.ts:261`, `components.ts:508`, `componentTemplates.ts:120/189`, `activateTemplate.ts:40`, `workOrderComponentCorrections.ts:76/115`. The server repeats them: `workOrderCopies.ts:154`, `savedAddresses.ts:76`, `aircraftSpruce.ts:154/174/212`.
- **Three policies exist side by side:** `plainErrors` (`runCommand.ts:185`), `allErrors` and `errorsOf(...)`. `componentTemplates` uses `allErrors`, which would expose a zod error's text.
- **Error counts:** 572 plain `throw Error` in `src/domain`, 187 in `convex/`, and 51 `ConvexError`.
- **Caveat.** convex-test does not redact errors, so the suites pass either way. Confirm the claim once on a preview deployment.

**Proposed deepening.** The rejection becomes a property of the error class, so the seam sits in the domain. `runCommand` loses its `expose` hook and exposes `Rejection` from both `load` and `apply`.

```ts
// src/domain/rejection.ts
export class Rejection extends Error {}          // FlightRejection and ComponentUsageError extend it
export class StaleRecord extends Rejection {}
export function assertCurrent(actual: number | undefined, expected: number, what: string): void;
// throws StaleRecord(`${what} changed. Reopen it before saving.`)
```

**Tests today.** `runCommand.test.ts`, which covers `expose`, and the per-command suites, which assert messages but not error classes.

**Characterization tests first.** For each `runCommand` mutation, assert that a stale command rejects and record *which class* it rejects with. Today that documents a plain `Error` in 14 of them. Add a production-mode check on one preview deployment.

**Risk: Medium.** Users will see messages they did not see before, which is a client-visible change. Internal errors must stay hidden, which is why a dedicated class is used rather than `allErrors`.

**Impact: High.** Users would see why a save failed. This gives ADR-0003's uniform rejection invariant a single home.

**Batches**

| Batch | Files | What | Dependency |
|---|---|---|---|
| b1 | `src/domain/rejection.ts` (new), `src/domain/flightSubmission.ts`, `src/domain/components.ts` | the classes; existing errors re-parented | none |
| b2 | `convex/runCommand.ts`, `convex/runCommand.test.ts` | default `expose` = `Rejection`, from `load` too | |
| b3, b4… | ≤3 domain modules each, leaf first: `taskCards.ts`, `flightPlans.ts`, `inspectionTemplates.ts`; then `workOrders.ts`, `partsRequests.ts`, `fleet.ts`; then the rest | `assertCurrent` and `Rejection` at each site | |
| last | | drop each per-mutation `expose` | |

---

### T11. Conflict review (flight review) as a domain command

**Files**

| File | Lines | What |
|---|---|---|
| `convex/operations.ts` | 709 | `reviewFlight`, 509–664: 156 lines |
| `src/data/demoBackend.ts` | 1,459 | `review`, 965–1013 |
| `src/domain/flightSubmission.ts` | 256 | |
| `src/domain/flights.ts` | 319 | no tests |
| `src/domain/management.ts` | | `validateMaintenanceTotals` |

**Problem.** Conflict review (GLOSSARY) rewrites aircraft totals and re-sequences later flights. It is the next safety-relevant write that exists twice. The report names it "the next candidate for `flightSubmission.ts`", and the two copies have drifted the way submission had.

**Evidence: seven server rules the demo lacks.**

| Rule | Server (`operations.ts`) | Demo |
|---|---|---|
| Flight Program administrator required | 519–520 | missing |
| Reason at most 5000 characters | 522–523 | missing |
| "A correction cannot change aircraft." | 558–559 | missing |
| "Use the discrepancy workflow…" | 560–563 | missing |
| Pilot and copilot exist | 564–572 | missing |
| Crew belong to the Flight Program (new crew only) | 573–588 | missing |
| `validateFlight(aircraft, input)` | 590 | missing |
| Plan check on accept of a rejected flight | only with `input.flightPlanUuid` (533–556) | unconditional (`demoBackend.ts:975-976`) |

The rebuild, `validateMaintenanceTotals`, the resequence audit and the action names are written twice: `operations.ts:591-663` and `demoBackend.ts:977-1012`. The e2e suite exercises only the demo copy.

**The deletion test.** The same as for C: about 70 lines of sequence reappear in both adapters.

**Proposed deepening.** Follow C's pattern exactly. The domain owns the sequence and throws `FlightRejection`. Convex loads the `ReviewState` (the flight, the aircraft's flights, the plan and its flights, the crew directory entries, management records and inspections), persists, and runs through `runCommand`. The demo applies the result to its snapshot.

```ts
// src/domain/flightReview.ts (or flightSubmission.ts)
export function reviewFlight(
  s: ReviewState, review: { uuid; decision: "accept" | "reject"; reason; input: FlightInput },
  now: number,
): { flight: Flight; flights: Flight[]; aircraft: Aircraft; audit: AuditEntry[] };
```

**Tests today.** `convex/operations.test.ts` (11 references to `reviewFlight`), `convex/flightChronology.test.ts` (237), and e2e on the demo. `flights.ts`, which holds `rebuildFlights`, `resequencedFlights` and `resequenceReason`, has no vitest suite.

**Characterization tests first**

1. Vitest tests for `rebuildFlights` and `resequencedFlights` on the demo fleet.
2. A case table of the server's review rules, run against both adapters. The demo fails seven cases.
3. A golden of the aircraft counter fields and the flight rows after an accepted correction.

**Risk: Medium.** The work rewrites aircraft totals, but C's pattern is proven and the server's tests are good.

**Impact: High.** Totals drive the Dispatch gate and Component life.

**Batches**

| Batch | Files | What |
|---|---|---|
| b1 | `src/domain/flights.test.ts` (new) | characterization only |
| b2 | `src/domain/flightReview.ts` (new, with tests) | the domain sequence |
| b3 | `convex/operations.ts` | onto `runCommand`; stored output unchanged |
| b4 | `src/data/demoBackend.ts` | the demo uses the domain sequence; explicit behaviour fix |

---

### T12. Change-log rows composed once, in the domain, with `programUuid` stamped

**Files**

| File | Lines | What |
|---|---|---|
| 13 domain modules | | 24 inline `AuditEntry` literals: `purchaseOrders.ts` ×5, `partsRequests.ts` ×4, `fleet.ts` ×3, … |
| `src/data/demoBackend.ts` | 1,459 | its own `audit()` helper, 140–160, with 39 calls |
| `convex/runCommand.ts` | 295 | `CommandLog` |
| `convex/access.ts` | 134 | `auditRow` |
| ≈10 mutation files | | `audit` hooks |

**Problem.** A Command's change-log rows (Audit entries) are composed in three places:

- by the applier, which some appliers do;
- by each Convex mutation's `audit` hook;
- by the demo adapter's `audit()` helper.

Two ADR-0003 invariants are open here: dropping the per-mutation summary rows, and stamping `programUuid`. The demo helper never sets `programUuid`.

**Evidence: the same row composed in both adapters for at least ten Commands.**

| Command | Convex | Demo |
|---|---|---|
| AD save (`"ad." + kind`, `adCommandReason`, `adAuditRecord`) | `airworthiness.ts:40-53` | 573–588 |
| Inspection template delete | `inspectionTemplates.ts:127-141` | 167–190 |
| Work order (`"workOrder." + action`) | `workOrders.ts:192-200` | 457–466 |
| Discrepancy deferral | `operations.ts:499-506` | 926–941 |
| Discrepancy parts | `operations.ts:701-707` | 910–924 |
| Checklist save | `checklists.ts:43-53` | 786–802 |
| Task card | `taskCards.ts:94-99` | 312–325 |
| Flight plan | `flightPlans.ts:58` | 803–816 |
| Component templates | | |
| Engine trends | | |

- **Programs are stamped inconsistently.** Of the ≈41 `audit()` calls in Convex, ≈29 pass no `programUuid`. Some are system rows by design (admin, identities, auth). Aircraft-scoped rows in `manuals`, `operations`, `taskCards`, `workOrders` and `workOrderCopies` rely on the aircraft index alone.
- **Applier entries carry `programUuid` only sometimes.** `costs.ts:583` does; the `fleet.ts:164-173` program row does not.
- **The deletion test.** Delete the demo's `audit()` helper and the Convex `audit` hooks, and nothing is lost if the appliers push their own entries, because `log.replay` already writes them.

**Proposed deepening.** Appliers push their own entries through one constructor. Convex's `audit` hook becomes the default `log.replay(working.audit)`, and the demo adapter writes nothing. Appliers keep the mutate-in-place contract that ADR-0003 requires.

```ts
// src/domain/changeLog.ts
export function recordChange(
  s: Snapshot,
  change: { action: string; entityUuid: string; aircraftUuid?: string; reason?: string; before?: unknown; after?: unknown },
  now = Date.now(),
): AuditEntry; // stamps uuid, at, actorId, and programUuid = owner of aircraftUuid ?? activeProgram(s)
```

**Tests today.** `convex/audit.test.ts`, `auditHistory.test.ts` (278) and `groupAudit.test.ts` (348). Some per-command suites assert audit actions.

**Characterization tests first.** A golden of the server's audit rows for each Command: action, entity, `programUuid`, `aircraftUuid`, reason, and the keys of before and after. The server's rows must stay byte-identical until a separate batch, recorded under ADR-0003, drops the summary rows and stamps `programUuid`.

**Risk: Medium.** The change log is the safeguard (ADR-0005), and the server's rows must not change silently.

**Impact: High.** It closes two ADR-0003 invariants and removes about 10 duplicate compositions. History filtering by Flight Program becomes reliable.

**Batches**

| Batch | Files | What |
|---|---|---|
| b1 | `src/domain/changeLog.ts` (new, with tests) | the constructor |
| b2 | `src/domain/fleet.ts`, `src/domain/costs.ts`, `src/domain/recurringParts.ts` | existing literals use the constructor |
| b3 | `src/domain/purchaseOrders.ts`, `src/domain/partsRequests.ts` | existing literals use the constructor |
| b4, b5… | ≤3 at a time: the applier (domain), its Convex `audit` hook, and the demo method | appliers start pushing their own entries: AD, then deferral and parts, then checklist, task card and plan, then templates |
| last | | drop the summary rows and stamp `programUuid` everywhere, as one recorded ADR-0003 change |

---

### T13. Maintenance due list: one module for "what is due on this aircraft"

**Files**

| File | Lines |
|---|---|
| `src/domain/aircraftStatus.ts` (the Dispatch gate) | 188 |
| `src/domain/alerts.ts` | 359 |
| `src/domain/ownerDue.ts` | 148 |
| `src/domain/partsPlanning.ts` | 206 |
| `src/domain/forecast.ts` | 451 |
| `src/domain/flightPlans.ts` | 206 |
| `src/components/Dashboard.tsx` | 1,012 |
| `src/components/Components.tsx` | 1,966 |
| `src/data/aircraftStatusReport.ts` | 453 |
| `scripts/backup/recordsWorkbook.ts` (`dueItems`, 585–779) | 2,289 |

**Problem.** Three deep status functions answer "how due is this one item": `inspectionStatus`, `requirementStatus` and `adTaskStatus`. Each has its own vocabulary:

- `scheduled`, `due-soon`, `overdue`;
- `Tracked`, `Due soon`, `Due now`, `Past due`;
- `Scheduled`, `Due soon`, `Overdue`.

No module answers "which items are due on this aircraft, and at what level". About nine callers each:

- iterate the three kinds;
- choose which items apply;
- decide what to do when a status throws;
- map the three vocabularies into one level.

They disagree.

**Evidence**

- **ADs on removed Components.**
  - Excluded by the Dispatch gate (`aircraftStatus.ts:107-109`) and the workbook (`recordsWorkbook.ts:724`).
  - Included by `ownerDue.ts:106-110` and `alerts.ts:125-129`. `adAircraftUuid` falls back to the AD's own `aircraftUuid` for a removed Component (`adOwnership.ts:7-9`).
  - Treated as inventory by `forecast.ts:389-391`.
  - So the owner portal and the alerts may list an AD that the Dispatch gate ignores. Confirm with a test.
- **AD applicability.**
  - `aircraftStatus`, `ownerDue`, `forecast` and the workbook skip "Not applicable" and "Superseded".
  - `partsPlanning.ts` keeps only "Applicable" and "PCW", and also skips `reviewRequired`.
  - `alerts.ts:130` uses `SKIPPED_AD_STATUSES` over `adStatus`.
- **When a status throws.** `requirementStatus` throws "Aircraft readings or date precede the installation baseline." (`components.ts:233-236`).
  - Callers that catch it disagree on what to do:
    - `aircraftStatus.ts:82-86` and `alerts.ts:178-182` skip the item;
    - `ownerDue.ts` and the workbook show it as "unknown";
    - `forecast.ts:357` keeps a base item with status "unknown";
    - `flightPlans.ts:183-190` raises a "verify installation baseline" flag.
  - It is **not** wrapped at `partsPlanning.ts:77`, `Dashboard.tsx:315` (inside render), or `Components.tsx:1205` and `1608`.
- **The vocabulary mapping is restated** at `ownerDue.ts:47-50, 78-85, 118-129`, `alerts.ts:183`, `aircraftStatus.ts:91`, `partsPlanning.ts:82`, `Components.tsx:1266, 1619`, and `recordsWorkbook.ts:649, 699, 758`.
- **The deletion test.** No such module exists. The selection and normalisation rules reappear in about nine callers, and they differ.

**Proposed deepening.** A deep, in-process module that sits above the three status functions, which stay as they are. The Dispatch gate maps `overdue` to grounded and `due-soon` to due soon. Every other caller only presents the items.

```ts
// src/domain/dueItems.ts
export interface DueItem {
  kind: "inspection" | "componentRequirement" | "adTask";
  uuid: string; aircraftUuid: string; label: string;
  level: "overdue" | "due-soon" | "ok" | "unknown";   // one vocabulary
  status: string;                                     // the source label, for display
  remaining: { seconds?: number; cycles?: number; landings?: number; days?: number };
  dueDate?: string; urgency: number; problem?: string; // problem: why level is "unknown"
}
export function dueItems(s: Snapshot, aircraftUuid: string, today?: string): DueItem[]; // worst first
```

**Tests today**

- `aircraftStatus.test.ts` (333), `alerts.test.ts` (420), `forecast.test.ts` (293), `flightPlans.test.ts` (345), `components.test.ts` (717), `airworthiness.test.ts` (546), `adRemaining.test.ts` (109);
- `convex/dispatch.test.ts` (296), `convex/ownerPortal.test.ts` (273);
- **no tests** for `ownerDue.ts`, `partsPlanning.ts` or `maintenance.ts`.

**Characterization tests first.** Build a fixture fleet with these cases:

- an AD on a removed Component;
- a Component whose readings precede its baseline, so the status throws;
- a calendar limit due today;
- a usage limit at exactly 0;
- an AD with `reviewRequired`;
- a superseded AD.

Record each consumer's current output. Every difference between consumers is then decided explicitly, one case at a time, because some of these are behaviour fixes.

**Risk: High.** The final batch changes the Dispatch gate's input, and some consumers will change behaviour.

**Impact: High.** About nine callers gain **leverage**, and the safety-relevant rule "what is due" gets one home.

**Batches.** Leaf consumers come first; the Dispatch gate comes last.

| Batch | Files | What |
|---|---|---|
| b1 | `src/domain/dueItems.ts` (new, with tests), `src/domain/ownerDue.ts` | the module; the owner view uses it |
| b2 | `src/domain/partsPlanning.ts`, `src/domain/alerts.ts` | |
| b3 | `src/components/Dashboard.tsx`, `src/components/Components.tsx` | |
| b4 | `src/domain/forecast.ts`, `src/domain/flightPlans.ts` | |
| b5 | `src/domain/aircraftStatus.ts` | must produce identical grounded and due-soon reasons on the characterization fleet; any difference needs sign-off |
| — | T8 b3 and T17 b1 | consume the module |

---

### T14. Recurring-parts occurrences generated inside the appliers

**Files**

| File | Lines | What |
|---|---|---|
| `src/domain/recurringParts.ts` | 97 | |
| `src/domain/partsRequests.ts` | 784 | 368–374, 662–692 |
| `convex/recurringParts.ts` | 88 | |
| `convex/partsRequests.ts` | 62 | |
| `convex/workOrders.ts` | 305 | 104 |
| `convex/workOrderCopies.ts` | 392 | 191 |
| `src/data/demoBackend.ts` | 1,459 | 452–457, 589–597 |

**Problem.** "Saving a recurring parts list, or saving a work order, creates any missing occurrences" is a domain rule, but adapters orchestrate it at five sites. In `partsRequests.execute` it runs *inside `persist`* (`convex/partsRequests.ts:40-49`), after apply, which breaks `runCommand`'s apply-then-persist order. `convex/recurringParts.ts:28-45` restates the domain's matching rule to decide what to load. It is correct only because `applyRequestCommand` normalises template sources at save (`partsRequests.ts:368-374`), an invariant nothing ties to the server copy.

**Evidence**

- **Five call sites:** `convex/partsRequests.ts:43`, `convex/workOrders.ts:104`, `convex/workOrderCopies.ts:191`, `demoBackend.ts:456` and `:595`.
- **Matching knowledge in two places:** `src/domain/recurringParts.ts:16-50` and `convex/recurringParts.ts:28-45`.
- **The deletion test.** Delete the orchestration, and occurrence generation reappears in every adapter path that saves a request or a work order.

**Proposed deepening.** The appliers call `generateRecurringRequests` themselves. The domain also tells the server what to load.

```ts
// src/domain/recurringParts.ts
export function recurringPartsNeeds(order: WorkOrder, requests: PartsRequest[]):
  { inspections: string[]; requirements: string[]; airworthiness: boolean };
// applyRequestCommand(s, c) and saveWorkOrder(s, c, now) generate occurrences
// themselves when s.partsRequests is loaded.
```

**Tests today.** `src/domain/recurringParts.test.ts` (251), `convex/recurringParts.test.ts`, `partsRequests.test.ts`, `workOrders.test.ts` and `workOrderCopies.test.ts` (287).

**Characterization tests first.** A golden of the created occurrences: numbers, sources and audit rows. Run it for saving a recurring list with two open orders, and for adding an inspection with a template that has a recurring list. Run each on both adapters.

**Risk: Medium.** It changes when, inside the transaction, occurrences are created, and their numbering (`PR-00001`).

**Impact: Medium.** It removes five sites, and it restores the order `runCommand` relies on.

**Batches**

| Batch | Files | What | Dependency |
|---|---|---|---|
| b1 | `src/domain/recurringParts.ts`, `src/domain/partsRequests.ts` | the applier generates occurrences; adds `recurringPartsNeeds` | none |
| b2 | `convex/partsRequests.ts` | the generation moves out of `persist` | ideally after T9 b2 |
| b3 | `convex/recurringParts.ts`, `convex/workOrders.ts`, `convex/workOrderCopies.ts` | | |
| b4 | `src/data/demoBackend.ts` | | |

---

### T15. Work-order "add inspection" fast path onto the applier, plus the ADR-0003 post-apply hook

**Files**

| File | Lines | What |
|---|---|---|
| `convex/workOrderCopies.ts` | 392 | `startCopy`, 140–199 |
| `convex/workOrders.ts` | 305 | `delegate`, 36–40 |
| `src/domain/workOrders.ts` | 704 | 309, 380–390, 492, 590–596 |
| `convex/runCommand.ts` | 295 | |

**Problem.** Adding an inspection to a Work order, or copying templates, goes through `delegate`, which leaves `runCommand`. `startCopy` then re-implements the domain's checks in Convex:

- open order;
- version;
- aircraft match;
- already on the order;
- the `newWorkTask` description.

It also writes its own summary row through `audit()`. ADR-0003 instead defines "one post-apply hook … for the work-order job scheduling that must run between apply and persist".

**Evidence**

- **Copied messages and rules.**
  - "Work order changed. Reopen it before saving.": `workOrderCopies.ts:154-155` and `domain/workOrders.ts:309`.
  - "Work item is unavailable for this aircraft.": `workOrderCopies.ts:163-166` and `domain/workOrders.ts:384, 492`.
  - "This item is already on the work order.": `workOrderCopies.ts:168-173` and `domain/workOrders.ts:595`.
  - The server copies throw `ConvexError`; the domain copies throw plain `Error`.
- **`delegate` is a hook whose only use is to bypass the transaction.** `persist` in `workOrders.ts:101-110` already does the scheduling (`queueTemplateCopies`, `prepareRecurringParts`) that ADR-0003 assigns to the post-apply hook.
- **The deletion test.** Delete `startCopy`'s checks and keep the applier, and nothing is lost, because the applier already holds them.

**Proposed deepening.** `Command` loses `delegate` and gains the hook from the ADR. Both work-order paths go through `saveWorkOrder` with `deferTemplateCopies: true`.

```ts
// convex/runCommand.ts: Command<C, W, R, Out>
afterApply?(tx: Transaction, working: W, result: R, command: C): Promise<R>; // job scheduling; runs before persist
// src/domain/workOrders.ts
export function addInspectionTask(order: WorkOrder, inspection: Inspection): WorkOrder; // used by saveWorkOrder
```

**Tests today.** `convex/workOrderCopies.test.ts` (287), `convex/workOrders.test.ts` (642) and `src/domain/workOrders.test.ts`.

**Characterization tests first.** Goldens of the work-order payload, the job rows and the audit rows for both the `add`-inspection path and the `copyTemplates` path.

**Risk: Medium.** The batches touch scheduled jobs.

**Impact: Medium.** It removes a copy of the rules and an escape from the transaction, and delivers an open ADR-0003 interface item.

**Batches**

| Batch | Files | What |
|---|---|---|
| b1 | `src/domain/workOrders.ts` | extract `addInspectionTask` |
| b2 | `convex/runCommand.ts`, `convex/runCommand.test.ts` | adds `afterApply` |
| b3 | `convex/workOrders.ts`, `convex/workOrderCopies.ts` | drops `delegate` and `startCopy`'s checks; scheduling moves to `afterApply` |

---

### T16. Membership and permission-group rules into the domain

**Files**

| File | Lines | What |
|---|---|---|
| `convex/programUsers.ts` | 292 | |
| `convex/admin.ts` | 531 | `saveGroup`, 296–392; 53, 243 |
| `src/data/demoBackend.ts` | 1,459 | 1014–1156, 1362–1411 |
| `src/domain/accountRules.ts` | 23 | |
| `src/domain/groupAircraft.ts` | 79 | |

**Problem.** Rules about who can be added to a Flight Program, with which permission groups, live in the adapters. Some appear three times. These are authorization paths; per AGENTS.md they must never be weakened.

**Evidence**

- **The fallback to the read-only "Observers" group has four copies:** `programUsers.ts:52-68`, `programUsers.ts:103-125`, `admin.ts:243` and `demoBackend.ts:1125-1141`.
- **The email regex and the 150-character name check have three copies:** `programUsers.ts:146`, `admin.ts:53` and `demoBackend.ts:1114`.
- **"At least one group with read access" has four variants of message and condition:** `programUsers.ts:239, 265` and `demoBackend.ts:1041, 1071`.
- **Group save.** The server enforces:
  - a name of 100 characters or fewer, at `admin.ts:329`;
  - "Write permissions also require read access.", at `:332`;
  - de-duplicated aircraft ids and permissions, at `:365-366`;
  - a trimmed name.

  The demo's `saveGroup` (`demoBackend.ts:1362-1411`) does none of these. `assertGroupProgramChange` and `assertGroupAircraftChoice` are already shared, which proves this seam works.

**Proposed deepening**

```ts
// src/domain/accountRules.ts
export function programGroupIds(groups: Group[], programUuid: string, requested: string[]): string[];
// in-program only; dedupe; falls back to Observers or throws the user message
export function normalizeGroup(input: GroupInput, existing: Group | undefined, actorIsAdmin: boolean): GroupFields;
export function normalizeAccount(email: string, name: string): { email: string; name: string };
```

**Tests today.** `convex/programUsers.test.ts` (436), `memberships.test.ts` (210), `groupAccess.test.ts` (259), `groupAudit.test.ts` (348), `src/data/demoGroups.test.ts` (84), `demoGroupAccess.test.ts` (108) and `src/domain/groupAircraft.test.ts` (197). `accountRules.ts` has no test.

**Characterization tests first.** Parity case tables on both adapters for create, add-existing, change-access and save-group, including refusals. **No case may become more permissive.**

**Risk: Medium.** These are authorization paths.

**Impact: Medium.** It removes three or four copies of each rule, and the demo gains the server's group rules.

**Batches**

| Batch | Files | What |
|---|---|---|
| b1 | `src/domain/accountRules.ts` (with test) | the new rules |
| b2 | `convex/programUsers.ts` | uses the rules |
| b3 | `convex/admin.ts` | `saveGroup`, `createUser` |
| b4 | `src/data/demoBackend.ts` | membership and group methods |

---

### T17. Status-record documents: content separate from PDF layout

**Files**

| File | Lines | Vitest suite |
|---|---|---|
| `src/data/aircraftStatusReport.ts` | 453 | none |
| `src/data/adReport.ts` | 360 | `adReport.test.ts`, 104 |
| `src/data/poPdf.ts` | 73 | |
| `src/data/partsRequestPdf.ts` | 82 | |
| `src/data/logbookPdf.ts` | 39 | |
| `src/data/flightPlanPdf.ts` | 58 | |
| `scripts/backup/recordsWorkbook.ts` | | `aircraftSheet`, 806–880 |

**Problem.** Each jsPDF writer mixes two jobs in one module:

- choosing and ordering what a Status record says, which means status calls, filters, sorting and remaining amounts;
- drawing it: wrapping, page breaks and headers.

So the content of a 14 CFR 91.417 Status record is testable only by inspecting a rendered PDF. The workbook builds the same content a second time.

**Evidence**

- **The paragraph and page-break helper is near-identical** in `poPdf.ts:13-25` (`line`) and `partsRequestPdf.ts:12-23` (`text`). `logbookPdf.ts:17-27` and `aircraftStatusReport.ts:59-71` each write their own.
- **The status report computes rules inline.** It calls `componentTotals` with a try/catch (`aircraftStatusReport.ts:220-233`), and filters and sorts inspections (240–260).
- **AD ordering** by section, Component and number lives only in `adReport.ts:45-53`.
- **The Status record content therefore has two adapters:** the PDF and the workbook's aircraft and due sheets. That makes the seam real.

**Proposed deepening**

```ts
// src/domain/statusSheet.ts: pure
export function statusSheet(s: Snapshot, aircraftUuid: string, today: string):
  { header: { registration; makeModel; serial; totals }; sections: { title: string; columns: string[]; rows: string[][] }[] };
// src/data/pdfLayout.ts
export function tablePdf(doc: { header; sections }, page: { format; orientation }): jsPDF;
export function paragraphPdf(lines: { text: string; bold?: boolean }[]): jsPDF;   // PO, parts request
```

**Tests today.** `src/data/adReport.test.ts`, `flightPlanPdf.test.ts` (75) and `tests/e2e/aircraft-status-export.spec.ts` (2 tests, against the demo).

**Characterization tests first.** Extract the text of the status report for the demo fleet with `pdfjs-dist`, which is already a dependency, and keep it as a golden. Do the same for the PO and parts-request PDFs.

**Risk: Medium.** Layout regressions are easy to miss, and the status report has no vitest suite.

**Impact: Medium.** Regulatory content becomes testable as data, and the workbook can share it.

**Batches**

| Batch | Files | What | Dependency |
|---|---|---|---|
| b1 | `src/domain/statusSheet.ts` (new, with test), `src/data/aircraftStatusReport.ts` | content moves to the domain | after T13 b1 |
| b2 | `src/data/pdfLayout.ts` (new), `src/data/poPdf.ts`, `src/data/partsRequestPdf.ts` | the shared paragraph layout | none |
| b3 | `src/data/aircraftStatusReport.ts`, `src/data/adReport.ts` | both use `tablePdf` | after b1 |
| b4 | `scripts/backup/recordsWorkbook.ts` | `aircraftSheet` reads `statusSheet` | after T8 b1 |

---

### T18. Request ids on every command

**Files**

| File | Lines | What |
|---|---|---|
| `convex/runCommand.ts` | 295 | 99–112, 129–134 |
| `convex/schema.ts` | 599 | `managementRequests` |
| every command schema in `src/domain` | | |
| `src/data/backend.ts` | 680 | |

**Problem.** The ADR-0003 invariant is that every command carries a request id in one `commandRequests` table, and a replayed command writes nothing. Today `request` is an opt-in hook, used only by `management.ts:22` and `fleet.ts:17`. The table is still `managementRequests`. Separately, `partsRequests.ts:33-38` reuses a record's uuid as an ad-hoc idempotency check.

**Evidence**

- `rg "request:"` finds 2 of the 21 `runCommand` callers.
- The opt-in hook adds to `Command`'s interface instead of shrinking it.
- The demo's `modify()` has no request ids at all.

**Proposed deepening.** `request` stops being a hook. `runCommand` reads `requestUuid` from every parsed command (a shared zod base), and the table is renamed with a migration.

**Tests today.** `runCommand.test.ts` and `management.test.ts` cover replay. `src/data/store.test.ts` (630) covers the outbox's own ids.

**Characterization tests first.** Replay tests for each command, which document "not idempotent" today. Then a migration test for `managementRequests` → `commandRequests`.

**Risk: High.** It changes stored data (a table rename and new rows), every command schema, and the client: an expand/contract migration.

**Impact: Medium.** It makes retries safe for maintenance writes, which do not go through the outbox.

**Batches**

| Batch | Files | What |
|---|---|---|
| b1 | `convex/schema.ts`, `convex/runCommand.ts` | the new table, written alongside the old one (expand) |
| b2… | ≤3 command schemas and their mutations at a time | the client generates `requestUuid` in `src/data/backend.ts` |
| last | | drop `managementRequests` (contract) |

---

## 3. Cross-cutting note on `runCommand`

`runCommand` passes the deletion test: delete it, and the context check, the replay, the single audit write and the error exposure reappear in 21 mutations. Its *interface* is still wide, though. It has nine hooks, of which `persist`, `audit` and `expose` are re-written per command. Four candidates turn those hooks into defaults:

- T9 makes `writeChanged` the default `persist`;
- T12 makes `log.replay` the default `audit`;
- T10 makes `Rejection` the default `expose`;
- T15 replaces `delegate` with `afterApply`.

Together they shrink the interface toward ADR-0003's "~10-line mutation", without changing the transaction order. Per CONSTRAINTS §2, `convex/runCommand.ts` has no header block; the first batch that touches it must add one.

## 4. New evidence about rejected and limited options

- **F (narrowing `Backend`), not pursued.** `Backend.createAircraft` has no UI caller (see T5). Deleting one dead method is the deletion test applied to one method, not a narrowing for width. F stays not pursued.
- **E (form-to-command shaping), after launch, close-out readings only.**
  - `GuidedFlight.tsx:441-446` bypasses `parseHours` and the tenths rule on a flight-entry path. This is the "unless a bug appears" trigger, so T7 is listed. T7 is a value module, not per-form shaping, and it leaves `WorkOrders.tsx:814-829` to E.
  - `PurchaseOrders.tsx:486-560` holds a multi-vendor split rule with no interface below the React file: one draft per vendor, shipping must be zero across vendors, and an existing draft must match vendor, ship-to and currency. Per ADR-0006 it stays out of scope until after launch.
- **D, second half (shared command table), waits.** T9, T10 and T12 reduce what each adapter must know per command. Once those land, the table would mostly hold `needs` and the applier. That makes its shape easier to prove later; it remains deferred.

## 5. Already deep: do not touch

- **The transaction order and guarantees of `runCommand`**, and `writeAudit` as the only audit insert (A and B). Deepen it only by turning hooks into defaults (§3), never by reordering it.
- **`submitOperation` in `src/domain/flightSubmission.ts`** (C), and how both adapters use it. T11 copies its pattern rather than changing it.
- **Authorization:**
  - `checkContext`, `authorized` and `admin` in `convex/programContext.ts` and `convex/access.ts`;
  - `can()`, `scopedSnapshot()` and `visibleScope()` in `src/domain/programs.ts`, shared with the client.
- **The scoped loaders in `programContext.ts`.** They are per program or per aircraft, include legacy rows, and handle inspections of removed Components. T1 wraps their output; it does not replace them.
- **The three per-item status functions:** `inspectionStatus`, `requirementStatus` with `componentTotals`, and `adTaskStatus` with `adRemaining`. T13 sits above them.
- **The domain appliers with suites:** `saveWorkOrder` and `workOrderCloseout`, `applyManagement`, `applyPOCommand`, `applyADCommand`, `applyFleet`, `transferProgram`.
- **The Workspace and outbox** in `src/data/store.ts` and `local.ts`, with `store.test.ts`. Also the demo's serialized `modify()` (`demoBackend.ts:107-128`).
- **The manual upload ticket flow:** `manuals.ts` `beginUpload`, `claimUpload`, `saveUpload` and `cleanupUploads`, with checksum binding and the sweep. Do not fold it into T4's pipeline.
- **`STORAGE_REFERENCES` with its schema-checked test.** T4 makes it the single list.
- **`rateLimits.consume`; `pdfText.ts` and `pdfOffline.ts`.** These are small but deep: they hide workarounds for Safari and offline use.
- **The `Backend` interface and the thin `convexBackend` adapter.** They are a real seam with two adapters (F, not pursued). **`App.tsx`** stays as it is too.
