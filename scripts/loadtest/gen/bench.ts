/**
 * Responsibility: The CPU floor of the workspace snapshot's own JavaScript
 *   for N years of generated rows: the zod decoding in convex/collections
 *   plus serialising the result, in plain Node, best of 15 runs.
 * Layer: Script. Load test only; reads the generated files and calls no
 *   backend.
 * Dependencies: convex/collections, node:fs.
 *
 * It leaves out Convex's document conversion, so the real query cannot be
 * faster than this on the same CPU. Bundle and run it as gen/run.sh does
 * gen.ts, passing the years: node "$LOADTEST_DIR/bench.bundle.mjs" 3
 */
import { existsSync, readFileSync } from "node:fs";
import { decode, type PayloadCollection } from "../../../convex/collections";

type Row = { payload: string };

const RUNS = 15;
const FIXED_TABLES = ["management", "costs"];
const HISTORY_TABLES = ["taskCards", "workOrders", "flightPlans", "partsRequests", "purchaseOrders", "costs", "management"];

const folder = process.env.LOADTEST_DIR;
if (!folder) throw new Error("Set LOADTEST_DIR to the folder for the load test's data and results.");
const DATA = `${folder}/data`;
const years = Number(process.argv[2] ?? 1);
const tables = loadTables();
const flights = Array.from({ length: years }, (_, i) => rows(`${DATA}/${yy(i + 1)}/flights.jsonl`)).flat();
const times: number[] = [];
let resultBytes = 0;
for (let i = 0; i < RUNS; i++) {
  const started = performance.now();
  resultBytes = JSON.stringify(decodeAll()).length;
  times.push(performance.now() - started);
}
times.sort((a, b) => a - b);
const rowCounts = Object.fromEntries(Object.entries(tables).map(([t, r]) => [t, r.length]));
console.log(JSON.stringify({ years, rows: rowCounts, resultBytes, minMs: Math.round(times[0]), medianMs: Math.round(times[Math.floor(RUNS / 2)]) }));

function yy(k: number) {
  return "y" + String(k).padStart(2, "0");
}

function rows(file: string): Row[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row);
}

function loadTables() {
  const loaded: Record<string, Row[]> = {};
  const add = (table: string, file: string) => (loaded[table] = [...(loaded[table] ?? []), ...rows(file)]);
  for (const table of FIXED_TABLES) add(table, `${DATA}/fixed/${table}.jsonl`);
  for (let k = 1; k <= years; k++)
    for (const table of HISTORY_TABLES) add(table, `${DATA}/${yy(k)}/${table}.jsonl`);
  add("airworthiness", `${DATA}/${yy(years)}/airworthiness.full.jsonl`);
  return loaded;
}

function decodeAll() {
  const decoded: Record<string, unknown> = { flights };
  for (const [table, stored] of Object.entries(tables))
    decoded[table] = decode(table as PayloadCollection, stored);
  return decoded;
}
