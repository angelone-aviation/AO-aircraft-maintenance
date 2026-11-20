# Load test

The size test: how many years of records a Flight Program can hold before a Convex per-function limit is hit or the app gets too slow. It loads a realistic 20-year history into a **local** backend, a year at a time, and measures the server and the browser at each step. The results of the 2026-11 run are under "Size test" in [the 2026-11-10 bug hunt](../../docs/qa/bug-hunt-2026-11-10/README.md#size-test).

## Hard rules

1. **Local backends only.** Every script that reaches a backend refuses to start unless `.env.local` names `http://localhost:<port>` or `http://127.0.0.1:<port>`, the Convex CLI's deployment is `local:` or `anonymous:`, and no `CONVEX_DEPLOY_KEY`, `CONVEX_DEPLOYMENT_TOKEN` or `CONVEX_SELF_HOSTED_URL` is set. The browser scripts also refuse an `ANGELONE_URL` that is not local. The check is `scripts/loadtest/guard.mjs`, pinned by `scripts/loadtestGuard.test.ts`. Never weaken or bypass it: the scripts import, replace and delete table rows.
2. **No outside services.** Leave the email, push, FAA and address-lookup keys unset on the local deployment, so nothing leaves the machine.
3. **One local backend, left alone.** Do not start a second `convex dev`, and do not edit `convex/` or `src/` while a run is going: `convex dev` redeploys on every change, and the steps would measure two versions.
4. **Report honestly:** what was run, what passed, what failed and what was not tested.

## Before you start

- A local backend: `npm run dev:local` in its own terminal, then `npm run setup:auth` and `npm run test:local` once. The smoke test keeps the local administrator in `.env.local-admin.json`, which the seed signs in with.
- For the browser scripts: `npm run build` (it picks up the local `VITE_CONVEX_URL`), served with `node scripts/serve-dist.mjs --report-csp --port 4391`. `--report-csp` lets the build reach the local backend. Set `ANGELONE_URL` for another local address, and `CHROMIUM_PATH` if Playwright cannot find its browser.
- `LOADTEST_DIR`: a folder outside the repository for the data, accounts, results and screenshots. Every script reads it.

## Run

```sh
export LOADTEST_DIR=/path/outside/the/repo/loadtest
node scripts/loadtest/seed.mjs              # program, 6 aircraft, groups, users
bash scripts/loadtest/gen/run.sh            # 20 yearly slices of history
node scripts/loadtest/load.mjs init         # fixed records, aircraft end state
node scripts/loadtest/load.mjs step 1       # newest year
node scripts/loadtest/measure.mjs --step y01
node scripts/loadtest/browser.mjs --step y01
bash scripts/loadtest/sweep.sh 2 3 5 8 10 15 20
python3 -I scripts/loadtest/table.py "$LOADTEST_DIR"
```

`gen/run.sh` copies `profile.json`, the volume model, into `LOADTEST_DIR` unless one is there already; edit that copy to change the model.

| Script | What it does |
| --- | --- |
| `measure.mjs --step yNN [--no-export]` | Snapshot per role, change history and summary, a new and a held flight, new saves, a full export, and each call's usage from the backend log |
| `browser.mjs --step yNN` | Sign-in to a usable Overview and the Flights list, normal and with a 4x CPU slowdown, and the offline copy's size |
| `wsbytes.mjs --step yNN` | WebSocket bytes on first load, and after another user reports one problem |
| `returning.mjs prime` then `check yNN` | A device that already holds the offline copy, reopened after the snapshot fails |
| `blank.mjs` | What a user sees once the snapshot fails (REPRODUCED, exit 1, on a blank page) |
| `lookups.mjs` | The 4,096 index-lookup limit on its own: one aircraft, ever more small job cards |
| `rerun.sh --wipe-local-database` | A clean pass of years 1 to 3 on a fresh local database. It deletes this checkout's local Convex data first, so it asks for the flag |
| `gen/bench.ts` | The CPU floor of the snapshot's own decoding for N years, in plain Node (bundle it as `gen/run.sh` does `gen.ts`) |
| `usage.py <results folder>` | Per-step usage summary from the backend log; `table.py` uses it |
| `paging.sh --wipe-local-database 1 3 10 20` | The history-paging sweep on a fresh local database ([above](#the-history-paging-sweep)) |
| `paging.mjs --step yNN` | The windowed workspace, bounded saves, numbering and history queries per role, with index ranges |
| `release.mjs --step yNN` | History paging's release steps after an import, each until 0 |
| `pagingTable.mjs` | The history-paging sweep's pass/fail table |
| `logUsage.mjs` | Shared by `measure.mjs` and `paging.mjs`: each call's usage, index ranges and limit bytes from the backend's log |

## The history-paging sweep

`paging.sh` measures the windowed workspace (ADR-0013) on a fresh local database, as stage S8 of [history paging](../../docs/history-paging.md) did. With the local backend stopped:

```sh
export LOADTEST_DIR=/path/outside/the/repo/loadtest
bash scripts/loadtest/paging.sh --wipe-local-database 1 3 10 20
node scripts/loadtest/pagingTable.mjs
```

It seeds, generates and loads as above, and after each step's import runs the release steps (`release.mjs`: `backfillHistoryColumns`, `rebuildRecordNumbers` and `rebuildCostLedger` until each reports 0, then `reconcileCostLedger`), then `paging.mjs` and `measure.mjs --no-export`. `paging.mjs` measures, as an administrator, a mechanic, a pilot of two aircraft, an owner and a board member: the snapshot; the bounded saves (work order, job card, evidence, parts request with its reserve and issue, part unit cost, purchase order, AD, and the Weekly summary over 7, 31 and 365 days), the new work order, job card, parts request and purchase order each numbered on save; and `history.flights`, `discrepancies`, `workOrders`, `partsRequests`, `purchaseOrders` and `flightPlans` first and halfway back (a cursor at that position), `history.workOrder` and `history.records` on the oldest loaded year, `history.flightsInRange` and `history.costReport`. `pagingTable.mjs` prints each operation per step as MiB read, index ranges and user time against the plan's bar (4 MiB, 1,000 ranges, 250 ms), and each role's snapshot against the first step.

### Index ranges

The backend's usage log has no index-range count, but its limit warnings do ("Many reads in a single function execution (actual: N, limit: 4096)", likewise bytes read as the 16 MiB limit counts them). `paging.sh` starts the backend for the measured steps with `FUNCTION_LIMIT_WARNING_RATIO` set below any real count, so every call logs them, and `logUsage.mjs` reads them per call. The warnings also go to the Convex CLI's standard output, which breaks `npm run setup:auth` and `convex data`, so the setup runs before the backend is restarted with them; `release.mjs` drops them from what it parses.

## The sweep

The generator writes one 20-year timeline ending now, cut into yearly slices `y01` (newest) to `y20` (oldest). Step k loads slices `y01` to `yk`, so each aircraft's current totals, version and last flight are the same at every step and older history is added behind them. Open items live only in the newest slice.

Limits tested, per query or mutation ([Convex limits](https://docs.convex.dev/production/state/limits)): 32,000 documents scanned, 16 MiB read, 16 MiB returned, 4,096 index ranges read, 1 s of user code, 16,000 documents and 16 MiB written.

## Files in `LOADTEST_DIR`

| Path | Contents |
| --- | --- |
| `profile.json` | The volume model |
| `accounts.json` | The seeded program, aircraft and users, with their generated passwords; readable by its owner only, never commit or share it |
| `data/` | `fixed/`, `yNN/` and `state.json` from the generator; `loaded.json` and `live.json` kept by the scripts |
| `results/server.jsonl`, `results/browser.jsonl` | One measurement per line |
| `results/logs-yNN.jsonl`, `results/logs-paging-yNN.jsonl` | The backend's log stream during a step of `measure.mjs` and of `paging.mjs` |
| `shots/`, `exports/`, `backend.log`, `browser-profile/` | Screenshots, the first step's export, `rerun.sh`'s backend output, `returning.mjs`'s browser profile |

A result line:

```json
{"step":"y03","area":"server","name":"snapshot","role":"admin","ok":true,"ms":[118,123,131],"medianMs":123,"bytes":456789,"error":null,"extra":{},"at":"2026-11-09T12:00:00.000Z"}
```
