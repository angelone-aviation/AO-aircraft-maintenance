/**
 * Responsibility: Prints the history-paging sweep's results as Markdown:
 *   each operation per step with MiB read, index ranges and user time,
 *   judged against the plan's pass criteria, and the snapshot per role
 *   against year 1.
 * Layer: Script. Load test reporting; reads result files only, no backend.
 * Dependencies: ./common.mjs (DATA_DIR), node:fs.
 *
 *   node scripts/loadtest/pagingTable.mjs
 * Reads DATA_DIR/results/server.jsonl as paging.mjs, measure.mjs and
 * release.mjs write it.
 */
import { readFileSync } from "node:fs";
import { DATA_DIR } from "./common.mjs";

const MIB = 1024 * 1024;
// A quarter of each Convex limit (16 MiB read, 1 s, 4,096 index ranges):
// the plan's 4x headroom (ADR-0013).
const PASS = { mib: 4, ms: 250, indexRanges: 1000 };
// The plan's bar for the snapshot: within 10% of year 1.
const FLAT = 1.1;
const DECIMALS = 2;

const rows = readFileSync(`${DATA_DIR}/results/server.jsonl`, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const steps = [...new Set(rows.map((r) => r.step))].sort();
printOperations();
printSnapshots();

function printOperations() {
  console.log("| Operation | Role | " + steps.join(" | ") + " |");
  console.log("| --- | --- | " + steps.map(() => "---").join(" | ") + " |");
  for (const [name, role] of operations())
    console.log(`| ${name} | ${role} | ` + steps.map((s) => cell(s, name, role)).join(" | ") + " |");
  console.log(`\nEach cell: MiB read (as the 16 MiB limit counts it) / index ranges / user ms; PASS needs at most ${PASS.mib} MiB, ${PASS.indexRanges} ranges and ${PASS.ms} ms.\n`);
}

function operations() {
  const seen = new Map();
  for (const r of rows)
    if (r.name !== "usage" && !r.name.startsWith("release.") && r.area === "server")
      seen.set(`${r.name}|${r.role}`, [r.name, r.role]);
  return [...seen.values()];
}

function cell(step, name, role) {
  const call = rows.findLast((r) => r.step === step && r.name === name && r.role === role);
  if (!call) return "";
  if (!call.ok) return `FAIL: ${String(call.error).slice(0, 60)}`;
  const usage = rows.findLast((r) => r.step === step && r.name === "usage" && r.extra.of === name && r.role === role);
  if (!usage) return `ok, no usage logged`;
  const e = usage.extra;
  const mib = e.limitReadBytes === null ? e.readBytes / MIB : e.limitReadBytes / MIB;
  const verdict = mib <= PASS.mib && (e.indexRanges ?? 0) <= PASS.indexRanges && e.userExecutionMs <= PASS.ms;
  return `${mib.toFixed(DECIMALS)} / ${e.indexRanges ?? "?"} / ${e.userExecutionMs} ${verdict ? "PASS" : "**FAIL**"}`;
}

function printSnapshots() {
  console.log("| Snapshot | " + steps.join(" | ") + " | Within 10% of the first step |");
  console.log("| --- | " + steps.map(() => "---").join(" | ") + " | --- |");
  const roles = [...new Set(rows.filter((r) => r.name === "snapshot").map((r) => r.role))];
  for (const role of roles) {
    const sizes = steps.map((s) => rows.findLast((r) => r.step === s && r.name === "snapshot" && r.role === role)?.bytes ?? null);
    const first = sizes.find((b) => b !== null);
    const flat = sizes.every((b) => b !== null && b <= first * FLAT);
    console.log(`| ${role}, MiB returned | ` + sizes.map((b) => (b === null ? "FAIL" : (b / MIB).toFixed(DECIMALS))).join(" | ") + ` | ${flat ? "yes" : "**no**"} |`);
  }
}
