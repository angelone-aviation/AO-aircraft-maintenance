/**
 * Responsibility: Loads the generated history into the local backend with
 *   `convex import`: the fixed records and the aircraft end state, then the
 *   yearly slices up to a step of the sweep.
 * Layer: Script. Load test only; refuses any backend but a local one.
 * Dependencies: ./common.mjs, ./guard.mjs, node:fs.
 *
 *   node scripts/loadtest/load.mjs init     fixed records, aircraft end state
 *   node scripts/loadtest/load.mjs step 3   appends the slices up to y03
 * DATA_DIR/data/loaded.json keeps the newest slice loaded.
 */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { DATA_DIR, readJson, runConvex, sliceName } from "./common.mjs";
import { localBackendUrl } from "./guard.mjs";

const DATA = `${DATA_DIR}/data`;
const LOADED_FILE = `${DATA}/loaded.json`;
const FIXED_TABLES = ["management", "costs", "inspections"];
const HISTORY_TABLES = [
  "flights",
  "flightPlans",
  "discrepancies",
  "workOrders",
  "taskCards",
  "costs",
  "partsRequests",
  "purchaseOrders",
  "management",
  "audit",
];
// More than the seeded fleet, so one read returns every aircraft.
const AIRCRAFT_READ_LIMIT = 1000;

localBackendUrl();
const [command, argument] = process.argv.slice(2);
if (command === "init") loadFixedRecords();
else if (command === "step") loadStep(Number(argument));
else throw new Error("Usage: load.mjs init | step <n>");

function loadFixedRecords() {
  for (const table of FIXED_TABLES)
    console.log(table, importFile(table, `${DATA}/fixed/${table}.jsonl`).ms, "ms");
  console.log("aircraft", replaceAircraft().ms, "ms");
  writeFileSync(LOADED_FILE, JSON.stringify({ loaded: 0 }));
}

// The aircraft rows keep their ids and baselines (the readings at the start
// of the timeline, set through the API) and take the timeline's end state.
function replaceAircraft() {
  const state = readJson(`${DATA}/state.json`);
  const listed = runConvex([
    "data",
    "aircraft",
    "--limit",
    String(AIRCRAFT_READ_LIMIT),
    "--format",
    "jsonArray",
  ]);
  const rows = JSON.parse(listed.out).map((row) => ({
    ...row,
    ...(state.aircraft[row.uuid]?.final ?? {}),
  }));
  const file = `${DATA}/aircraft.replace.jsonl`;
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return importFile("aircraft", file, "--replace");
}

function loadStep(target) {
  const { loaded } = readJson(LOADED_FILE);
  if (target <= loaded) throw new Error(`Already at ${sliceName(loaded)}.`);
  const timing = {};
  for (const table of HISTORY_TABLES)
    timing[table] = appendSlices(table, loaded, target);
  const ads = `${DATA}/${sliceName(target)}/airworthiness.full.jsonl`;
  timing.airworthiness = importFile("airworthiness", ads, "--replace").ms;
  writeFileSync(LOADED_FILE, JSON.stringify({ loaded: target }));
  console.log("loaded", sliceName(target), JSON.stringify(timing));
}

// One import per table, of the slices after `loaded` up to `target` joined.
function appendSlices(table, loaded, target) {
  const batch = `${DATA}/batch.jsonl`;
  rmSync(batch, { force: true });
  for (let years = loaded + 1; years <= target; years++) {
    const file = `${DATA}/${sliceName(years)}/${table}.jsonl`;
    if (existsSync(file)) appendFileSync(batch, readFileSync(file));
  }
  const { ms } = importFile(table, batch);
  rmSync(batch, { force: true });
  return ms;
}

function importFile(table, file, mode = "--append") {
  return runConvex(
    ["import", "--table", table, mode, "-y", "--format", "jsonLines", file],
  );
}
