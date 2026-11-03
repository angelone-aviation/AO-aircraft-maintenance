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
