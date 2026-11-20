/**
 * Responsibility: Runs history paging's release steps after a load-test
 *   import, as a deployment runs them after a restore: the backfill and the
 *   two rebuilds until each reports 0, then the cost ledger's reconcile.
 * Layer: Script. Load test only; refuses any backend but a local one.
 * Dependencies: ./common.mjs, ./guard.mjs.
 *
 *   node scripts/loadtest/release.mjs --step y03
 * Appends one "release.<function>" line per step to results/server.jsonl.
 * Exits 1 when a step does not reach 0 or the reconcile finds differences.
 */
import { appendResult, runConvex } from "./common.mjs";
import { localBackendUrl } from "./guard.mjs";

const STEPS = [
  "migrations:backfillHistoryColumns",
  "migrations:rebuildRecordNumbers",
  "migrations:rebuildCostLedger",
];
// Each run fills what one action's ten minutes allow; a few runs always
// reach 0 at the load test's volume.
const MAX_RUNS = 5;
// The backend's limit warnings, when turned on, share the CLI's output.
const WARNING_LINE = /^\[CONVEX /;

const step = process.argv[process.argv.indexOf("--step") + 1];
if (!/^y\d\d$/.test(step ?? ""))
  throw new Error("Usage: release.mjs --step yNN");
localBackendUrl();
let failed = false;
for (const fn of STEPS) failed = !untilZero(fn) || failed;
failed = !reconcile() || failed;
process.exit(failed ? 1 : 0);

function untilZero(fn) {
  const runs = [];
  for (let run = 0; run < MAX_RUNS; run++) {
    const { out, ms } = runConvex(["run", fn]);
    runs.push({ ms, ...resultOf(out) });
    if (runs.at(-1).missing === 0) break;
  }
  const ok = runs.at(-1).missing === 0;
  report(fn, ok, runs);
  return ok;
}

function reconcile() {
  const fn = "migrations:reconcileCostLedger";
  const { out, ms } = runConvex(["run", fn]);
  const result = resultOf(out);
  const ok = result.differing === 0;
  report(fn, ok, [{ ms, ...result }]);
  return ok;
}

function resultOf(out) {
  const json = out
    .split("\n")
    .filter((line) => !WARNING_LINE.test(line))
    .join("\n");
  return JSON.parse(json);
}

function report(fn, ok, runs) {
  const ms = runs.map((r) => r.ms);
  appendResult({
    step, area: "server", name: `release.${fn.split(":")[1]}`, role: "cli",
    ok, ms, medianMs: ms.at(-1), bytes: null,
    error: ok ? null : JSON.stringify(runs.at(-1)), extra: { runs },
    at: new Date().toISOString(),
  });
  console.log(step, fn, ok ? "ok" : "FAILED", JSON.stringify(runs));
}
