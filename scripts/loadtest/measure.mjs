/**
 * Responsibility: The server measurements for one step of the size sweep:
 *   the workspace snapshot per role, change history and the weekly summary,
 *   a new and a held flight, new saves, a full export, and the backend's own
 *   usage figures for each.
 * Layer: Script. Load test only; refuses any backend but a local one.
 * Dependencies: ./common.mjs, ./guard.mjs, node:child_process, node:crypto,
 *   node:fs.
 *
 *   node scripts/loadtest/measure.mjs --step y03 [--no-export]
 * Appends to DATA_DIR/results/server.jsonl. DATA_DIR/data/live.json follows
 * the aircraft the measurements change, so a later step's flights fit.
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import {
  api,
  appendResult,
  DATA_DIR,
  errorText,
  readJson,
  REPO_ROOT,
  signIn,
  spawnConvex,
} from "./common.mjs";
import { localBackendUrl } from "./guard.mjs";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const ERROR_LIMIT = 1200;
const LOG_LINE_LIMIT = 400;
// The log stream needs a moment to connect, and to flush after the last call.
const LOG_STREAM_WARMUP_MS = 4000;
const LOG_STREAM_DRAIN_MS = 3000;
// Log timestamps are whole milliseconds on another clock read.
const LOG_MATCH_SLACK_MS = 50;
// 1.2 hours: a typical leg, in meter seconds.
const FLIGHT_SECONDS = 4320;
const FLIGHT_STARTED_AGO_MS = 120_000;
const SNAPSHOT_RUNS = 5;
const REPEAT_RUNS = 3;
const SUMMARY_PERIODS = [["7d", -7], ["31d", -31], ["92d", -92], ["366d", -366]];
const SNAPSHOT_ROLES = ["admin", "pilot", "owner", "board"];

const step = process.argv[process.argv.indexOf("--step") + 1];
if (!/^y\d\d$/.test(step ?? "")) throw new Error("Usage: measure.mjs --step yNN [--no-export]");
localBackendUrl();
const accounts = readJson(`${DATA_DIR}/accounts.json`);
const state = readJson(`${DATA_DIR}/data/state.json`);
const LIVE_FILE = `${DATA_DIR}/data/live.json`;
const live = existsSync(LIVE_FILE) ? readJson(LIVE_FILE) : endState();
const PROGRAM = accounts.programUuid;
// Each timed call's window, to find its executions in the backend's log.
const windows = [];
const logs = await startLogStream();
const clients = await signInRoles();

const adminSnapshot = await measureSnapshots();
await measureHistory();
await measureNewFlight();
await measureHeldFlightReview();
await measureSaves();
if (!process.argv.includes("--no-export")) measureExport();
await recordUsage();
process.exit(0);

function user(role) {
  return accounts.users.find((u) => u.role === role);
}

function endState() {
  return Object.fromEntries(Object.entries(state.aircraft).map(([id, a]) => [id, { ...a.final }]));
}

function saveLive() {
  writeFileSync(LIVE_FILE, JSON.stringify(live, null, 1));
}

// Exact usage per execution comes from the backend's own log stream.
async function startLogStream() {
  mkdirSync(`${DATA_DIR}/results`, { recursive: true });
  const out = openSync(`${DATA_DIR}/results/logs-${step}.jsonl`, "w");
  const stream = spawn("npx", ["convex", "logs", "--jsonl"], { cwd: REPO_ROOT, stdio: ["ignore", out, "ignore"], detached: true });
  await new Promise((resolve) => setTimeout(resolve, LOG_STREAM_WARMUP_MS));
  return stream;
}

async function signInRoles() {
  const as = (account) => signIn(account.email, account.password);
  return {
    admin: await as(accounts.admin),
    pilot: await as(user("pilot")),
    mechanic: await as(user("mechanic")),
    owner: await as(user("owner")),
    board: await as(user("board")),
  };
}

function record(name, role, result, extra = {}) {
  if (result.fn) windows.push({ name, role, fn: result.fn, t0: result.t0, t1: Date.now() });
  const ms = result.ms ?? [];
  const sorted = [...ms].sort((a, b) => a - b);
  const line = {
    step, area: "server", name, role, ok: result.ok, ms, medianMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    bytes: result.bytes ?? null, error: result.error ?? null, extra, at: new Date().toISOString(),
  };
  appendResult(line);
  const size = result.bytes ? (result.bytes / 1e6).toFixed(2) + " MB" : "";
  console.log(step, name, role, result.ok ? "ok" : "FAILED", "median", line.medianMs, "ms", size, result.error ? result.error.slice(0, 300) : "", JSON.stringify(extra).slice(0, 400));
}

// Runs `call` up to `times` times and stops at the first failure. Before each
// repeat, a cheap audited write in the program makes the next run a cold
// read, not the backend's cached result.
async function timed(call, times = 1, fn = null) {
  const ms = [];
  let value;
  const t0 = Date.now();
  try {
    for (let i = 0; i < times; i++) {
      if (times > 1) await clients.admin.mutation(api.programs.select, { programUuid: PROGRAM });
      const started = performance.now();
      value = await call();
      ms.push(Math.round(performance.now() - started));
    }
    return { ok: true, ms, value, fn, t0 };
  } catch (error) {
    // A refusal past a Convex limit is the measurement, not a crash.
    return { ok: false, ms, error: errorText(error, ERROR_LIMIT), fn, t0 };
  }
}

function withBytes(result) {
  return { ...result, bytes: result.ok ? Buffer.byteLength(JSON.stringify(result.value)) : null };
}

async function measureSnapshots() {
  let adminView;
  for (const role of SNAPSHOT_ROLES) {
    const result = await timed(() => clients[role].query(api.operations.snapshot, {}), SNAPSHOT_RUNS, "operations:snapshot");
    if (result.ok && role === "admin") adminView = result.value;
    const extra = result.ok ? describeSnapshot(result.value, role) : {};
    record("snapshot", role, withBytes(result), extra);
  }
  return adminView;
}

// One index lookup per job card, archived job card and work order; for a
// program administrator one more per stock and component record.
function describeSnapshot(snapshot, role) {
  const arrays = Object.fromEntries(
    Object.entries(snapshot).filter(([, v]) => Array.isArray(v) && v.length).map(([k, v]) => [k, [v.length, Buffer.byteLength(JSON.stringify(v))]]),
  );
  const cards = (snapshot.taskCards?.length ?? 0) + (snapshot.archivedTaskCards?.length ?? 0);
  const orders = snapshot.workOrders?.length ?? 0;
  const stock = (snapshot.management ?? []).filter((m) => m.kind === "stock" || m.kind === "component").length;
  const inventory = role === "admin" ? stock : 0;
  return { arrays, lookups: { cards, orders, inventory, perRecord: cards + orders + inventory } };
}

async function measureHistory() {
  const page = (client, args, runs) => timed(() => client.query(api.auditHistory.page, { programUuid: PROGRAM, cursor: null, numItems: 50, ...args }), runs, "auditHistory:page");
  const first = await page(clients.admin, {}, SNAPSHOT_RUNS);
  record("auditHistory.page", "admin", withBytes(first), first.ok ? { rows: first.value.page?.length ?? first.value.rows?.length, keys: Object.keys(first.value) } : {});
  const byAircraft = await page(clients.admin, { aircraftUuid: accounts.aircraft[3].uuid }, REPEAT_RUNS);
  record("auditHistory.page(aircraft)", "admin", withBytes(byAircraft));
  record("auditHistory.page", "pilot", withBytes(await page(clients.pilot, {}, REPEAT_RUNS)));
  const day = (offset) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
  for (const [label, from] of SUMMARY_PERIODS) {
    const summary = await timed(() => clients.admin.query(api.auditHistory.summary, { programUuid: PROGRAM, from: day(from), to: day(0) }), REPEAT_RUNS, "auditHistory:summary");
    record(`auditHistory.summary(${label})`, "admin", summary, summary.ok ? { truncated: summary.value.truncated } : {});
  }
}

function flightInput(aircraftUuid, fields) {
  return { aircraftUuid, pilotId: user("pilot").id, landings: 1, cycles: 1, operation: "Mission", flightRules: "VFR", discrepancy: "", ...fields };
}

function submitFlight(input, baseVersion) {
  const operation = { programUuid: PROGRAM, kind: "flight", uuid: randomUUID(), authorId: user("pilot").id, baseVersion, input };
  return { operation, run: timed(() => clients.pilot.mutation(api.operations.submit, { operation }), 1, "operations:submit") };
}

// One new flight, which must be accepted.
async function measureNewFlight() {
  const aircraft = accounts.aircraft[0];
  const current = live[aircraft.uuid];
  const startTime = new Date(Math.floor(Date.now() / 1000) * 1000 - FLIGHT_STARTED_AGO_MS).toISOString();
  const input = flightInput(aircraft.uuid, {
    startTime, hobbsOn: current.currentHobbs + FLIGHT_SECONDS, tachOn: current.currentTach + FLIGHT_SECONDS,
    origin: "KCHA", destination: "KAVL", remarks: "Size test flight at " + step,
  });
  const result = await submitFlight(input, current.version).run;
  const accepted = result.ok && result.value.status === "accepted";
  if (accepted) {
    Object.assign(current, { currentHobbs: input.hobbsOn, currentTach: input.tachOn, version: current.version + 1, latestFlightAt: input.startTime });
    saveLive();
  }
  record("flight.submit", "pilot", { ...result, ok: accepted, error: submitError(result) }, { status: result.value?.status });
}

function submitError(result) {
  if (!result.ok) return result.error;
  return result.value.status === "accepted" ? null : "status " + result.value.status;
}

// Worst-case review: a held flight early in the oldest loaded year of an
// aircraft is accepted, so the server replays every flight of that aircraft.
async function measureHeldFlightReview() {
  const aircraft = accounts.aircraft[1];
  const current = live[aircraft.uuid];
  const slot = state.aircraft[aircraft.uuid].slots[step];
  // A rerun of a step puts its held flight an hour after the earlier one.
  current.used = current.used ?? {};
  const reuse = current.used[step] ?? 0;
  current.used[step] = reuse + 1;
  saveLive();
  const startTime = new Date(Date.parse(slot.startTime) + reuse * HOUR_MS).toISOString().replace(".000Z", "Z");
  const input = flightInput(aircraft.uuid, {
    startTime, hobbsOn: slot.hobbsOn, tachOn: slot.tachOn, origin: "KBNA", destination: "KBNA",
    remarks: "Late entry found in the paper log (size test " + step + ")",
  });
  const { operation, run } = submitFlight(input, Math.max(0, current.version - 1));
  const held = await run;
  const isHeld = held.ok && held.value.status === "review";
  record("flight.submit(held)", "pilot", { ...held, ok: isHeld, error: held.ok ? null : held.error }, { status: held.value?.status });
  if (isHeld) await reviewHeldFlight(aircraft, current, operation, input);
}

async function reviewHeldFlight(aircraft, current, operation, input) {
  const reason = "Paper log checked against the tech log (size test).";
  const result = await timed(() => clients.admin.mutation(api.operations.reviewFlight, { programUuid: PROGRAM, uuid: operation.uuid, decision: "accept", reason, input }), 1, "operations:reviewFlight");
  if (result.ok) {
    current.version += 1;
    current.reviewed = (current.reviewed ?? 0) + 1;
    saveLive();
  }
  const flightsOfAircraft = adminSnapshot?.flights.filter((f) => f.aircraftUuid === aircraft.uuid).length ?? null;
  record("flight.review(accept, oldest year)", "admin", result, { flightsOfAircraft });
}

// A new work order and a new job card.
async function measureSaves() {
  const aircraftUuid = accounts.aircraft[2].uuid;
  const tag = `${step}-${Date.now() % 100000}`;
  const order = {
    action: "save", uuid: randomUUID(), version: 0, requestUuid: randomUUID(),
    fields: { number: `WO-SIZE-${tag}`, aircraftUuid, dateOpened: new Date().toISOString().slice(0, 10), supervisor: "Casey Wrench", scope: "Size test work order.", priority: "routine", status: "open", completionDate: "", releaseOutcome: "", finalReview: "" },
    componentUuids: [],
    tasks: [{ uuid: randomUUID(), source: { kind: "manual", uuid: "manual" }, description: "Size test task", status: "requested", notes: "", partsDelay: "" }],
  };
  const saveOrder = () => clients.mechanic.mutation(api.workOrders.save, { programUuid: PROGRAM, payload: JSON.stringify(order) });
  record("workOrder.save(new)", "mechanic", await timed(saveOrder, 1, "workOrders:save"));
  const card = { action: "save", uuid: randomUUID(), version: 0, requestUuid: randomUUID(), fields: jobCardFields(aircraftUuid, `JC-SIZE-${tag}`) };
  const saveCard = () => clients.mechanic.mutation(api.taskCards.save, { programUuid: PROGRAM, payload: JSON.stringify(card) });
  record("taskCard.save(new)", "mechanic", await timed(saveCard, 1, "taskCards:save"));
}

function jobCardFields(aircraftUuid, cardNumber) {
  return {
    aircraftUuid, cardNumber, title: "Size test job card", workOrderUuid: "", inspectionUuid: "", componentUuid: "", requirementUuid: "", discrepancyUuid: "",
    description: "Size test.", includeInLogbook: false, logbookPhrase: "Performed", maintenanceReference: "", referenceRevision: "", referenceDate: "", applicability: "", steps: [], assignedTechnician: "",
    estimatedLabor: null, requiredParts: "", requiredTools: "", prerequisiteUuids: [], prerequisites: "", findings: "", actualWork: "", measurements: "", actualLabor: null, completionDate: "", partsUsed: [],
    inspectionSignoffRequired: false, functionalTestRequired: false, functionalTestOutcome: "not-required", functionalTestResults: "", status: "draft",
  };
}

// A full export, as the nightly backup takes it. Exports are large, so only
// the first step's is kept.
function measureExport() {
  const file = `${DATA_DIR}/exports/${step}.zip`;
  mkdirSync(`${DATA_DIR}/exports`, { recursive: true });
  rmSync(file, { force: true });
  const started = Date.now();
  const result = spawnConvex(["export", "--path", file]);
  const ok = result.status === 0 && existsSync(file);
  const failure = (result.stderr || result.stdout).slice(-600);
  record("convex export", "cli", { ok, ms: [Date.now() - started], bytes: ok ? statSync(file).size : null, error: ok ? null : failure });
  if (ok && step !== "y01") rmSync(file, { force: true });
}

// Exact usage of each uncached execution, from the backend log stream.
async function recordUsage() {
  await new Promise((resolve) => setTimeout(resolve, LOG_STREAM_DRAIN_MS));
  stopLogStream();
  const entries = readLogEntries();
  for (const window of windows) {
    const hits = executionsIn(entries, window);
    if (hits.length) recordExecution(window, hits);
  }
}

function stopLogStream() {
  try {
    process.kill(-logs.pid);
  } catch (error) {
    // The group is gone when the stream already exited; stop the child alone.
    console.warn("Log stream group:", errorText(error, LOG_LINE_LIMIT));
    logs.kill();
  }
}

function readLogEntries() {
  const parse = (line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      // The last line is cut off when the stream is stopped mid-write.
      return [];
    }
  };
  return readFileSync(`${DATA_DIR}/results/logs-${step}.jsonl`, "utf8")
    .split("\n").filter(Boolean).flatMap(parse)
    .filter((e) => e.kind === "Completion" && !e.cachedResult);
}

function executionsIn(entries, window) {
  const within = (e) => e.executionTimestamp * 1000 >= window.t0 - LOG_MATCH_SLACK_MS && e.executionTimestamp * 1000 <= window.t1 + LOG_MATCH_SLACK_MS;
  return entries.filter((e) => e.identifier === window.fn && within(e));
}

// The execution that read the most bytes stands for the call.
function recordExecution(window, hits) {
  const worst = hits.sort((a, b) => b.usageStats.databaseReadBytes - a.usageStats.databaseReadBytes)[0];
  const usage = worst.usageStats;
  const logLines = (worst.logLines ?? []).map((l) => (typeof l === "string" ? l : JSON.stringify(l)).slice(0, LOG_LINE_LIMIT));
  const extra = {
    of: window.name, executions: hits.length, readDocuments: usage.databaseReadDocuments, readBytes: usage.databaseReadBytes,
    writeDocuments: usage.databaseWriteDocuments, writeBytes: usage.databaseWriteBytes, userExecutionMs: Math.round(worst.userExecutionTime * 1000),
    returnBytes: worst.returnBytes, memoryUsedMb: usage.memoryUsedMb, logLines, error: worst.error ? String(worst.error).slice(0, LOG_LINE_LIMIT) : null,
  };
  appendResult({ step, area: "server", name: "usage", role: window.role, ok: worst.error == null, extra, at: new Date().toISOString() });
  console.log(step, "usage", window.name, window.role, JSON.stringify(extra).slice(0, 500));
}
