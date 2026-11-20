/**
 * Responsibility: The history-paging measurements (ADR-0013, stage S8) for
 *   one step of the size sweep: the workspace snapshot per role, the saves
 *   the window bounded, number allocation, and the history queries.
 * Layer: Script. Load test only; refuses any backend but a local one.
 * Dependencies: ./common.mjs, ./guard.mjs, ./logUsage.mjs, node:crypto,
 *   node:fs.
 *
 *   node scripts/loadtest/paging.mjs --step y03
 * Appends to DATA_DIR/results/server.jsonl: one line per call, then one
 * "usage" line per call with its index ranges, bytes and user time from the
 * backend's log. pagingTable.mjs turns them into the pass/fail table.
 */
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  api,
  appendResult,
  DATA_DIR,
  errorText,
  readJson,
  signIn,
} from "./common.mjs";
import { localBackendUrl } from "./guard.mjs";
import { recordUsage, startUsageLog } from "./logUsage.mjs";

const DAY_MS = 86_400_000;
const YEAR_MS = 365.25 * DAY_MS;
const ERROR_LIMIT = 600;
const SNAPSHOT_RUNS = 3;
const PAGE_SIZE = 50;
// history.records takes at most 100 uuids, split across its three lists.
const RECORDS_PER_LIST = 33;
// Sorts after every real uuid, so a deep cursor starts at its key.
const LAST_UUID = "ffffffff-ffff-4fff-bfff-ffffffffffff";
const DATE_LENGTH = 10;
// A one-page PDF's first bytes pass the upload's content check.
const EVIDENCE_PDF = "%PDF-1.4\n% size test evidence\n";
const SNAPSHOT_ROLES = ["admin", "mechanic", "pilotTwo", "owner", "board"];
const HISTORY_ROLES = ["admin", "mechanic", "pilotTwo"];
// The Weekly summary's week, a month, and a year, which reaches its cut.
const SUMMARY_DAYS = [7, 31, 365];
const CLOSED_STATUSES = new Set(["completed", "cancelled"]);

const step = process.argv[process.argv.indexOf("--step") + 1];
if (!/^y\d\d$/.test(step ?? ""))
  throw new Error("Usage: paging.mjs --step yNN");
localBackendUrl();
const years = Number(step.slice(1));
const accounts = readJson(`${DATA_DIR}/accounts.json`);
const PROGRAM = accounts.programUuid;
const windows = [];
const log = await startUsageLog(`paging-${step}`);
const clients = await signInRoles();

await measureSnapshots();
const targets = await findTargets();
await measureSaves(targets);
for (const role of HISTORY_ROLES) await measureHistory(role);
await measureLookups(targets);
await recordUsage(log, step, windows);
process.exit(0);

async function signInRoles() {
  const as = (account) => signIn(account.email, account.password);
  const user = (role) => accounts.users.find((u) => u.role === role);
  const pilotTwo = user("pilotTwo");
  if (!pilotTwo)
    throw new Error("accounts.json has no pilotTwo; run seed.mjs again.");
  return {
    admin: await as(accounts.admin),
    mechanic: await as(user("mechanic")),
    pilotTwo: await as(pilotTwo),
    owner: await as(user("owner")),
    board: await as(user("board")),
  };
}

// Runs `run` `times` times as `role`, recording the client's time and the
// returned size; a busting write before each repeat keeps each run uncached.
async function call(name, role, fn, run, times = 1) {
  const ms = [];
  const t0 = Date.now();
  let value;
  let error = null;
  try {
    value = await runTimed(() => run(clients[role]), times, ms);
  } catch (caught) {
    // A refusal past a Convex limit is the measurement, not a crash.
    error = errorText(caught, ERROR_LIMIT);
  }
  windows.push({ name, role, fn, t0, t1: Date.now() });
  record(name, role, { ms, value, error });
  return error ? undefined : value;
}

async function runTimed(run, times, ms) {
  let value;
  for (let i = 0; i < times; i++) {
    if (times > 1) await bustCache();
    const started = performance.now();
    value = await run();
    ms.push(Math.round(performance.now() - started));
  }
  return value;
}

function bustCache() {
  return clients.admin.mutation(api.programs.select, { programUuid: PROGRAM });
}

function record(name, role, { ms, value, error }) {
  const sorted = [...ms].sort((a, b) => a - b);
  const medianMs = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  const bytes = error ? null : Buffer.byteLength(JSON.stringify(value ?? null));
  appendResult({
    step, area: "server", name, role, ok: !error, ms, medianMs, bytes,
    error, extra: { paging: true }, at: new Date().toISOString(),
  });
  console.log(step, name, role, error ? `FAILED ${error}` : `ok ${medianMs} ms`);
}

async function measureSnapshots() {
  for (const role of SNAPSHOT_ROLES)
    await call("snapshot", role, "operations:snapshot",
      (c) => c.query(api.operations.snapshot, {}), SNAPSHOT_RUNS);
}

// The records the saves act on, from the generated files, since a snapshot
// may be the thing that fails: the newest slice's first open work order as
// stored now, a stock item with stock on hand (another each step, as each
// step issues one) and one of the order's aircraft's ADs, as this step
// loaded them.
async function findTargets() {
  const data = `${DATA_DIR}/data`;
  const open = payloadsOf(`${data}/y01/workOrders.jsonl`)
    .find((w) => !CLOSED_STATUSES.has(w.status));
  if (!open) throw new Error("No open work order in the newest slice.");
  const found = await call("history.workOrder(open)", "admin",
    "history:workOrder", (c) => c.query(api.history.workOrder,
      { programUuid: PROGRAM, uuid: open.uuid }));
  const order = found?.workOrder ?? open;
  const stocks = payloadsOf(`${data}/fixed/management.jsonl`)
    .filter((r) => r.kind === "stock" && r.quantity > 0 && r.locationUuid);
  const ad = payloadsOf(`${data}/${step}/airworthiness.full.jsonl`)
    .find((a) => a.aircraftUuid === order.aircraftUuid && a.tasks.length);
  const stock = stocks[years % stocks.length];
  return { order, stock, ad, aircraftUuid: order.aircraftUuid };
}

async function measureSaves(targets) {
  const card = await saveNewCard(targets);
  if (card) await saveCardEdit(card);
  if (card) await uploadEvidence(card);
  await saveOrderEdit(targets.order);
  await saveNewOrder(targets);
  if (card) await issueAndPrice(targets, card);
  await savePurchaseOrder(targets);
  await saveAd(targets);
  for (const days of SUMMARY_DAYS)
    await call(`auditHistory.summary(${days}d)`, "admin",
      "auditHistory:summary", (c) => c.query(api.auditHistory.summary, {
        programUuid: PROGRAM, from: dateOf(Date.now() - days * DAY_MS),
        to: dateOf(Date.now()),
      }));
}

function command(payload) {
  return { programUuid: PROGRAM, payload: JSON.stringify(payload) };
}

// A blank number is numbered from the recordNumbers rows (numbering).
async function saveNewCard({ order, aircraftUuid }) {
  const uuid = randomUUID();
  const fields = jobCardFields(aircraftUuid, order.uuid);
  const saved = await call("taskCard.save(new, numbered)", "mechanic",
    "taskCards:save", (c) => c.mutation(api.taskCards.save, command({
      action: "save", uuid, version: 0, requestUuid: randomUUID(), fields,
    })));
  if (!saved) return undefined;
  const found = await call("history.records(card)", "mechanic",
    "history:records", (c) => c.query(api.history.records, {
      programUuid: PROGRAM, discrepancyUuids: [], taskCardUuids: [uuid],
      flightPlanUuids: [],
    }));
  return found?.taskCards?.find((t) => t.uuid === uuid);
}

function saveCardEdit(card) {
  const fields = { ...card, findings: "No defects found; size test." };
  return call("taskCard.save", "mechanic", "taskCards:save",
    (c) => c.mutation(api.taskCards.save, command({
      action: "save", uuid: card.uuid, version: card.version,
      requestUuid: randomUUID(), fields,
    })));
}

// The action stores the file, then checkUpload and finishUpload read the
// card; finishUpload's reads stand for the save.
function uploadEvidence(card) {
  const bytes = new TextEncoder().encode(EVIDENCE_PDF).buffer;
  return call("taskCard.evidence", "mechanic", "taskCards:finishUpload",
    (c) => c.action(api.taskCards.upload, {
      programUuid: PROGRAM, taskCardUuid: card.uuid, name: "size-test.pdf",
      type: "application/pdf", bytes, category: "photo",
    }));
}

function saveOrderEdit(order) {
  return call("workOrder.save", "mechanic", "workOrders:save",
    (c) => c.mutation(api.workOrders.save, command({
      action: "save", uuid: order.uuid, version: order.version,
      requestUuid: randomUUID(),
      fields: { ...order, scope: `${order.scope} Size test ${step}.` },
      componentUuids: [], tasks: order.tasks,
    })));
}

function saveNewOrder({ aircraftUuid }) {
  const fields = {
    number: "", aircraftUuid, dateOpened: dateOf(Date.now()),
    supervisor: "Casey Wrench", scope: "Size test work order.",
    priority: "routine", status: "open", completionDate: "",
    releaseOutcome: "", finalReview: "",
  };
  const tasks = [{
    uuid: randomUUID(), source: { kind: "manual", uuid: "manual" },
    description: "Size test task", status: "requested", notes: "",
    partsDelay: "",
  }];
  return call("workOrder.save(new, numbered)", "mechanic", "workOrders:save",
    (c) => c.mutation(api.workOrders.save, command({
      action: "save", uuid: randomUUID(), version: 0,
      requestUuid: randomUUID(), fields, componentUuids: [], tasks,
    })));
}

// A request on the new card, numbered on save, then reserved and issued, so
// the part's unit cost has an issue on the work order to price.
async function issueAndPrice({ stock, order }, card) {
  if (!stock) return;
  const uuid = randomUUID();
  const lineUuid = randomUUID();
  const saved = await call("partsRequest.save(new, numbered)", "mechanic",
    "partsRequests:execute", (c) => c.mutation(api.partsRequests.execute,
      command({ kind: "save", requestUuid: randomUUID(),
        draft: requestDraft(uuid, lineUuid, stock, card) })));
  if (saved === undefined) return;
  const stockCommand = { uuid, lineUuid, stockUuid: stock.uuid, quantity: 1 };
  if (!(await stockStep("reserve", stockCommand, 1))) return;
  if (!(await stockStep("issue", stockCommand, 2))) return;
  await call("cost.partUnitCost", "admin", "costs:execute",
    (c) => c.mutation(api.costs.execute, command({
      action: "part.unitCost", requestUuid: randomUUID(),
      workOrderUuid: order.uuid, stockUuid: stock.uuid, unitCents: 2600,
    })));
}

function stockStep(kind, stockCommand, version) {
  return call(`partsRequest.${kind}`, "admin", "partsRequests:execute",
    (c) => c.mutation(api.partsRequests.execute, command({
      kind, requestUuid: randomUUID(), version, date: dateOf(Date.now()),
      ...stockCommand,
    })));
}

function requestDraft(uuid, lineUuid, stock, card) {
  return {
    uuid, version: 0, mode: "parts", date: dateOf(Date.now()),
    source: { kind: "jobCard", uuid: card.uuid, workOrderUuid: card.workOrderUuid },
    engineer: "Casey Wrench", priority: "P2 Routine", requiredBy: "",
    currency: "USD",
    lines: [{ uuid: lineUuid, partNumber: stock.partNumber,
      description: stock.description, quantity: 1 }],
  };
}

function savePurchaseOrder({ stock, order }) {
  if (!stock) return undefined;
  const line = {
    uuid: randomUUID(), stockUuid: stock.uuid, locationUuid: stock.locationUuid,
    partNumber: stock.partNumber, description: stock.description,
    quantity: 2, unitCents: 2495, kind: stock.category,
    aircraftUuid: order.aircraftUuid, workOrderUuid: order.uuid,
  };
  const draft = {
    uuid: randomUUID(), version: 0, vendor: "Example Aviation Supply 1",
    vendorContact: "", shipTo: "Hangar 4, Test Field", expectedDate: "",
    currency: "USD", shippingCents: 0, notes: "", lines: [line],
  };
  return call("purchaseOrder.save(new, numbered)", "admin",
    "purchaseOrders:execute", (c) => c.mutation(api.purchaseOrders.execute,
      command({ kind: "save", requestUuid: randomUUID(), drafts: [draft] })));
}

function saveAd({ ad, order }) {
  if (!ad) return undefined;
  // Scheduling the AD's action on the open order makes the save look the
  // order up, the one work-order read an AD save has.
  const [first, ...rest] = ad.tasks;
  const tasks = [{ ...first, workOrderUuid: order.uuid }, ...rest];
  const record = { ...ad, tasks };
  return call("airworthiness.save", "admin", "airworthiness:save",
    (c) => c.mutation(api.airworthiness.save, command({
      kind: "save", requestUuid: randomUUID(), record,
      reason: "Size test review.",
    })));
}

// Each list's first page, and a page from halfway back through the loaded
// years, by a cursor at that position (the cursor is a sort key and uuid).
async function measureHistory(role) {
  const half = Date.now() - (years * YEAR_MS) / 2;
  const byTime = JSON.stringify([Math.round(half), LAST_UUID]);
  const lists = [
    ["flights", byTime],
    ["discrepancies", byTime],
    ["workOrders", JSON.stringify([dateOf(half), LAST_UUID])],
    ["partsRequests", byTime],
    ["purchaseOrders", byTime],
    ["flightPlans", byTime],
  ];
  for (const [list, deep] of lists) {
    await historyPage(list, role, null, "first");
    await historyPage(list, role, deep, "deep");
  }
}

function historyPage(list, role, cursor, depth) {
  return call(`history.${list}(${depth})`, role, `history:${list}`,
    (c) => c.query(api.history[list], {
      programUuid: PROGRAM, cursor, numItems: PAGE_SIZE,
    }));
}

// One older work order whole, records named by uuid from the oldest loaded
// year, a month of flights halfway back, and a year's cost report.
async function measureLookups({ aircraftUuid }) {
  const oldest = `${DATA_DIR}/data/${step}`;
  const [order] = uuidsOf(`${oldest}/workOrders.jsonl`, 1);
  await call("history.workOrder(oldest year)", "admin", "history:workOrder",
    (c) => c.query(api.history.workOrder, { programUuid: PROGRAM, uuid: order }));
  await call("history.records(100, oldest year)", "admin", "history:records",
    (c) => c.query(api.history.records, {
      programUuid: PROGRAM,
      discrepancyUuids: uuidsOf(`${oldest}/discrepancies.jsonl`, RECORDS_PER_LIST),
      taskCardUuids: uuidsOf(`${oldest}/taskCards.jsonl`, RECORDS_PER_LIST + 1),
      flightPlanUuids: uuidsOf(`${oldest}/flightPlans.jsonl`, RECORDS_PER_LIST),
    }));
  await measureRanges(aircraftUuid);
}

async function measureRanges(aircraftUuid) {
  const from = Date.now() - (years * YEAR_MS) / 2;
  await call("history.flightsInRange(30 days)", "admin",
    "history:flightsInRange", (c) => c.query(api.history.flightsInRange, {
      programUuid: PROGRAM, aircraftUuid, from: Math.round(from),
      to: Math.round(from + 30 * DAY_MS),
    }));
  const year = new Date().getUTCFullYear();
  await call("history.costReport(this year)", "admin", "history:costReport",
    (c) => c.query(api.history.costReport, {
      programUuid: PROGRAM, aircraftUuid, from: `${year}-01-01`,
      to: `${year}-12-31`,
    }));
}

function payloadsOf(file) {
  return readFileSync(file, "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(JSON.parse(line).payload));
}

function uuidsOf(file, count) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean)
    .slice(0, count).map((line) => JSON.parse(line).uuid);
}

function dateOf(ms) {
  return new Date(ms).toISOString().slice(0, DATE_LENGTH);
}

function jobCardFields(aircraftUuid, workOrderUuid) {
  return {
    aircraftUuid, cardNumber: "", title: "Size test job card", workOrderUuid,
    inspectionUuid: "", componentUuid: "", requirementUuid: "",
    discrepancyUuid: "", description: "Size test.", includeInLogbook: false,
    logbookPhrase: "Performed", maintenanceReference: "",
    referenceRevision: "", referenceDate: "", applicability: "", steps: [],
    assignedTechnician: "", estimatedLabor: null, requiredParts: "",
    requiredTools: "", prerequisiteUuids: [], prerequisites: "", findings: "",
    actualWork: "", measurements: "", actualLabor: null, completionDate: "",
    partsUsed: [], inspectionSignoffRequired: false,
    functionalTestRequired: false, functionalTestOutcome: "not-required",
    functionalTestResults: "", status: "draft",
  };
}
