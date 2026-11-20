---
status: accepted
date: 2026-11-01
---

# Server writes go through one command-transaction module

Twenty-two Convex mutations in seventeen files hand-write the same sequence around a tested domain applier: check the Flight Program context, hydrate a partial Snapshot from payload-blob tables, call the applier, diff, upsert rows, replay the applier's audit entries, and sometimes de-duplicate by request id. We decided to give that sequence one interface, a `runCommand` module in `convex/`, and move all twenty-two mutations onto it in one change rather than in stages, so that two persistence styles never coexist.

The module's interface fixes these invariants for every command:

- The domain applier contract `(snapshot, command) => void` is unchanged; `runCommand` owns hydrate, diff and persist.
- Every command carries a request id, recorded in one `commandRequests` table (the former `managementRequests`); a replay returns the earlier outcome and writes nothing.
- A command whose record versions are stale is rejected with a `ConvexError`, uniformly, instead of last-writer-wins.
- `runCommand` is the sole writer of audit rows for commands: it replays the applier's entries stamped with `programUuid` and `aircraftUuid`. The per-mutation summary rows and the seven raw `ctx.db.insert("audit", …)` calls are removed. `access.audit()` remains for non-command mutations (administration, uploads).
- Only the collections a command declares in its `needs` list are hydrated; the rest are `undefined`, never an empty array, so a rule that reads an unloaded collection fails loudly.
- One post-apply hook receives the context and the applied Snapshot, for the work-order job scheduling that must run between apply and persist.
- Commands that carry no version today (management, parts requests, fleet, engine trends) gain a version of the record they target; there is no exemption list.
- The applier's parameter is typed as a partial Snapshot (only the declared `needs` are present), so the compiler, not a runtime surprise, reports a rule that reads an unloaded collection.
- A replayed command returns success with no payload; the reactive snapshot query already carries its effect.

## Considered options

- Keep per-mutation glue and add tests to each (rejected: the glue is the same code eighteen times; the bugs it has produced, such as audit rows without `programUuid`, recur per copy).
- Change appliers to return results instead of mutating (rejected for now: 66 tested domain modules and the demo adapter speak the mutate-in-place contract).
- Introduce the shared command table for the demo adapter in the same change (deferred: server-only first, demo parity follows once the table shape has proven itself).

## Consequences

- The per-mutation convex-test glue suites are replaced by one `runCommand` suite covering hydrate, persist, audit stamping, idempotency and version rejection for each persistence shape, plus one happy-path test per command.
- Command schemas that lack a request id or a version field gain them; the client already generates request ids for offline operations.
- `docs/maintenance-workflows.md`'s promise that every write checks record versions and audits in the same transaction becomes true in one place.

## Status

- 2026-11-03: implemented in part. `convex/runCommand.ts` owns the transaction and `writeAudit` is the single audit insert; the applier-backed mutations run through it with their stored data, audit rows and errors unchanged. Uniform request ids and version rejection, removing the summary rows, stamping every row with `programUuid`, `undefined` for unloaded collections and the partial-Snapshot type are still to do (see `docs/architecture/README.md`).
- 2026-11-04: T9, T12 and T18 (`docs/architecture/tier2-candidates.md`).
  - One writer: the payload-table writes of twelve command files go through `writeChanged` (`convex/runCommand.ts`), which encodes rows with the codec in `convex/collections.ts`, rewrites only rows that changed and never deletes. A new record whose uuid is stored outside the rows the command loaded is refused with one `ConvexError`, "Record belongs to another Flight Program.", for every record type.
  - Appliers record their own change-log entries through `auditEntry` (`src/domain/changeLog.ts`): AD, deferral, resolution, discrepancy parts, checklist and job card, besides fleet, costs, recurring parts, parts requests and purchase orders. The mutation replays them, and the demo adapter adds none of its own for them. Flight plans and templates still compose theirs in the mutation, and some replays still clear or set `programUuid` to keep stored rows as they were, so dropping the summary rows and stamping `programUuid` on every row remain open.
  - Request ids: every `runCommand` command accepts one, recorded in `commandRequests`; a replay succeeds with no payload and writes nothing, and reusing an id for another payload is refused. The id is optional, so a command sent without one runs each time. `managementRequests` is retired but still declared in `convex/schema.ts`: nothing reads or writes it, and the production deployment, live since 2026-11-03, may hold rows, which Convex refuses to deploy a schema without. A later batch drops it once it is empty; until then a request id recorded there before the switch is not replayed. Exceptions: `operations.submit`, idempotent on the outbox entry's uuid; parts requests and purchase orders, which keep their required ids, replayed from the record history; and, since 2026-11-19, `operations.reviewFlight`, whose id is required so that a review sent again is never applied twice.
  - Still open: uniform stale-version rejection, `undefined` for unloaded collections, and the partial-Snapshot type.
- 2026-11-04, later: T12 done. Flight plans, inspection-template saves and deletions, and component templates record their entries in the applier too, and every entry these appliers and the management command record names its Flight Program: the aircraft's, else the active one, or the program a fleet command saves. `CommandLog.replay` and `record` no longer re-stamp or clear `programUuid`, so new rows from job-card commands, flight plans, discrepancy resolutions and parts, and inspection completions on a work order now name the program, where they named none. Stored rows keep their values. Still open: the summary rows (`workOrder.<action>` and the management rows `convex/management.ts` composes), flight submission and review rows, which name no program, and the items above.
- 2026-11-04, final: T12's leftovers. Flight submission and review build their entries through `auditEntry`, as do the `workOrder.<action>` summary row (server and demo) and the management mutation's `inspection.component_transferred` rows; the management mutation replays the applier's own entry instead of composing a copy. New `flight.created`, `flight.held`, `flight.reviewed`, `flight.resequenced`, `discrepancy.created`, `workOrder.<action>` and `inspection.component_transferred` rows name the aircraft's program; stored rows keep their values. `CommandLog.replayOldestFirst` writes a change log kept newest first in the order the changes happened. Still open: the work-order summary row is composed by the mutation and the demo, not by `saveWorkOrder`; the demo writes no `inspection.component_transferred` rows; rows written through `access.audit()`, such as account, attachment, manual, FAA and template-copy resumption rows, name no program; and the items above.
