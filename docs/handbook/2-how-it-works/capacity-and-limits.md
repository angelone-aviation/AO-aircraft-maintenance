# Capacity and limits

How much the app can hold, what was measured, and when to look again. The full tables are in [history paging](../../history-paging.md#measured-at-20-fleet-years-s8-h5-release).

## The short answer

- At the load test's size, **20 years of records** load and save. Every workspace load succeeds. The heaviest, the administrator's, reads **8.84 MiB of Convex's 16 MiB** limit.
- It grows about **0.08 to 0.11 MiB a year**. At that rate the limit is about a hundred years away.
- **One known exception:** accepting a held flight from the oldest year replays that aircraft's flights and passes Convex's one-second limit at about 20 years (S9, set aside on 20 Nov).
- A Summary of a month can say "cut short" at 20 years; a year is cut short at every size.
- Measured on a local Convex backend on a shared four-core machine, not on Convex's cloud. Cloud timing is **not known**.

## The size measured

The load test's model ([`scripts/loadtest/profile.json`](../../../scripts/loadtest/profile.json), [its README](../../../scripts/loadtest/README.md)):

| Per aircraft, per year          |     | Fixed per aircraft |     | Fixed per program |     |
| ------------------------------- | --- | ------------------ | --- | ----------------- | --- |
| Flights                         | 300 | Components         | 100 | Stock records     | 300 |
| Flight plans                    | 60  | Inspections        | 30  | Locations         | 10  |
| Problem reports                 | 30  | ADs                | 40  | Vendors           | 25  |
| Work orders (15 job cards each) | 12  |                    |     | Checklists        | 6   |
| Parts requests                  | 30  |                    |     |                   |     |
| Purchase orders                 | 20  |                    |     |                   |     |
| Component movements             | 10  |                    |     |                   |     |
| Recurring AD compliances        | 20  |                    |     |                   |     |

- **6 aircraft**, 20 years: 36,000 flights and 21,600 job cards in all.
- People: 12 pilots, 3 mechanics, 1 owner, 1 board member.
- One change-log row per write the app would have made.

## Convex's limits, per function call

| Limit                     | Value           | The plan's target (a quarter) |
| ------------------------- | --------------- | ----------------------------- |
| Data read                 | 16 MiB          | 4 MiB                         |
| Index ranges read         | 4,096           | 1,000                         |
| User code time            | 1 second        | 250 ms                        |
| Documents scanned         | 32,000          |                               |
| Data returned             | 16 MiB          |                               |
| Documents or data written | 16,000 / 16 MiB |                               |

A deployment cannot raise these. Source: [Convex limits](https://docs.convex.dev/production/state/limits), as quoted in the [load test README](../../../scripts/loadtest/README.md).

## The 20-year measurements

MiB read / index ranges / milliseconds, from [history paging](../../history-paging.md#measured-at-20-fleet-years-s8-h5-release) (20 Nov 2026, the H5 release):

| Operation                               | 1 year           | 20 years              |
| --------------------------------------- | ---------------- | --------------------- |
| Workspace, administrator                | 7.27 / 649 / 478 | 8.84 / 673 / 606      |
| Workspace, mechanic                     | 7.24 / 650 / 507 | 8.80 / 674 / 632      |
| Workspace, pilot of two aircraft        | 4.45 / 306 / 282 | 6.00 / 318 / 382      |
| Workspace, owner                        | 1.78 / 116 / 216 | 3.88 / 116 / 248      |
| Board view                              | 1.82 / 122 / 257 | 3.92 / 122 / 320      |
| Work order save                         | 1.20 / 102 / 157 | 3.31 / 102 / 269      |
| Parts request save                      | 1.22 / 70 / 181  | 3.33 / 70 / 321       |
| Purchase order save                     | 0.86 / 46 / 140  | 1.69 / 46 / 175       |
| New flight                              | 1.08 / 69 / 182  | 3.45 / 68 / 288       |
| Held flight accepted, oldest year       | 1.20 / 365 / 169 | **refused: over 1 s** |
| Summary, 7 days                         | 1.75 / 69 / 197  | 2.90 / 90 / 222       |
| History pages (flights, reports, plans) | about 0.1        | about 0.1             |
| Older work orders, first page           | 2.39 / 168 / 226 | 3.39 / 219 / 256      |

Against the plan's pass criteria:

| Criterion                              | Met?                                                                                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Every operation succeeds at 20 years   | All but the held-flight review from the oldest year                                                                                          |
| 20-year workspace within 10% of year 1 | No, but growth is small (7.27 → 8.84 MiB)                                                                                                    |
| 4× headroom on every limit             | Index ranges yes (except the held-flight review). Bytes no: workspaces read 4.45–7.27 MiB from year 1. Time no for workspaces (up to 632 ms) |

## Storage and backup size

| Measure                              | Value           | Source                                                                                    | Known or estimate                                                    |
| ------------------------------------ | --------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Full export at 20 years of the model | 68 MB, in 210 s | [Bug hunt size test](../../qa/bug-hunt-2026-11-10/README.md#size-test) ("Records export") | Measured, before the history window; files not included in the model |
| Database size today                  | Near zero       | Production holds no real records yet                                                      | Known                                                                |
| Uploaded files                       | **Not known**   | Manuals, photos and attachments were not part of the load test                            | —                                                                    |

File storage will likely dwarf the records. A single manual PDF can be tens of MB.

## What still grows

| What                                      | Why                                                                                                     | Rate at the model's volume                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| AD compliance history                     | ADR-0013 keeps ADs complete                                                                             | Part of 0.08–0.11 MiB a year                                                |
| Component movements                       | Kept complete                                                                                           | Part of the same                                                            |
| Repairs and restocks settled by a receipt | Their own record can't show they are settled, so the window keeps them                                  | Small; finding 75                                                           |
| Open items                                | Kept however many there are; bounded only by the per-member report limit                                | Depends on use                                                              |
| Index ranges                              | Grow with readable aircraft and kept work orders, not years: 306 for two aircraft, 654 for six (year 1) | About 87 per aircraft; the 1,000 target at about 10 aircraft (**estimate**) |
| Files and backups                         | Monthly archives are kept forever by design                                                             | Depends on uploads                                                          |

Follow-ups are findings 73, 74a, 74b, 74d, 75 and 76a in [REFACTOR_ROADMAP.md](../../../REFACTOR_ROADMAP.md).

## When to look again

| Trigger                                               | What to do                                                                                                                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Every quarter                                         | In the Convex dashboard's logs, look for "Many bytes read" or "took a long time" on `operations:snapshot`, `operations:reviewFlight` and the saves ([recurring tasks](../../go-live-checklist.md#recurring-tasks)) |
| The fleet grows past about 10 aircraft                | Index ranges near the 1,000 target (estimate); re-run the load test                                                                                                                                                |
| Flying much more than 300 flights per aircraft a year | Re-run the load test at the new rate (`scripts/loadtest/paging.sh`)                                                                                                                                                |
| A held flight from years back must be accepted        | Expect it to fail from about 20 years of history (S9)                                                                                                                                                              |
| File storage passes about 1.5 GB                      | Check the nightly export still fits Convex's 50 GB monthly egress ([ADR-0007](../../adr/0007-convex-pro-single-seat.md))                                                                                           |
| A warning appears                                     | Findings 74a or 74d are due ([REFACTOR_ROADMAP.md](../../../REFACTOR_ROADMAP.md))                                                                                                                                  |
