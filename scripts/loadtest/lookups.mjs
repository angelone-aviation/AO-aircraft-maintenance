/**
 * Responsibility: Shows the "index ranges read" limit on its own: a separate
 *   program with one aircraft and ever more small job cards, until the
 *   workspace snapshot fails.
 * Layer: Script. Load test only; refuses any backend but a local one.
 * Dependencies: ./common.mjs, ./guard.mjs, node:crypto, node:fs.
 *
 *   node scripts/loadtest/lookups.mjs
 * The snapshot runs one taskEvidence lookup per job card, so it stops at
 * about 4,000 cards however small they are. Prints REPRODUCED and exits 1
 * when it fails; the administrator is switched back to the test fleet.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  api,
  appendResult,
  DATA_DIR,
  errorText,
  readJson,
  runConvex,
  signIn,
} from "./common.mjs";
import { localBackendUrl } from "./guard.mjs";

// Cards added before each snapshot: just under Convex's 4,096 lookups, then
// across it.
const CARD_BATCHES = [3500, 400, 100, 100, 100];
const ERROR_LIMIT = 500;
// Four digits keep the program name and registration unique per run.
const RUN_TAG = Date.now() % 10000;
const START_SECONDS = 360000;
const CARDS_FILE = `${DATA_DIR}/data/lookup-cards.jsonl`;

localBackendUrl();
const accounts = readJson(`${DATA_DIR}/accounts.json`);
const admin = await signIn(accounts.admin.email, accounts.admin.password);
const programUuid = randomUUID();
const aircraftUuid = randomUUID();
await createLookupProgram();
let total = 0;
const results = [];
for (const count of CARD_BATCHES) {
  importCards(count);
  const result = { jobCards: total, ...(await snapshotOutcome()) };
  results.push(result);
  console.log(JSON.stringify(result));
  recordOutcome(result);
  if (!result.ok) break;
}
await admin.mutation(api.programs.select, { programUuid: accounts.programUuid });
const failed = results.find((r) => !r.ok);
console.log(failed ? `REPRODUCED: the snapshot fails at ${failed.jobCards} small job cards: ${failed.error}` : "NOT REPRODUCED");
process.exit(failed ? 1 : 0);

function saveFleet(program, payload) {
  return admin.mutation(api.fleet.save, {
    programUuid: program,
    payload: JSON.stringify({ requestUuid: randomUUID(), reason: "Lookup limit test", ...payload }),
  });
}

async function createLookupProgram() {
  await saveFleet(accounts.programUuid, {
    action: "program.save",
    program: { uuid: programUuid, version: 0, name: `Lookup limit test ${RUN_TAG}`, address: "", email: "", contactName: "", website: "" },
  });
  await admin.mutation(api.programs.select, { programUuid });
  await saveFleet(programUuid, {
    action: "aircraft.save",
    aircraft: { uuid: aircraftUuid, registration: `N9${RUN_TAG}LT`, make: "Cessna", model: "172", serial: "LOOKUP", programUuid, meter: "hobbs", adjustmentSeconds: 0, currentHobbs: START_SECONDS, currentTach: START_SECONDS, cycles: 10, landings: 10, version: 0, operationalStatus: "unknown" },
  });
}

function jobCard(number) {
  const now = Date.now();
  return {
    aircraftUuid, cardNumber: "JC-" + number, title: "Small job card " + number, workOrderUuid: "", inspectionUuid: "", componentUuid: "", requirementUuid: "", discrepancyUuid: "", description: "",
    includeInLogbook: false, logbookPhrase: "Performed", maintenanceReference: "", referenceRevision: "", referenceDate: "", applicability: "", steps: [], assignedTechnician: "", estimatedLabor: null,
    requiredParts: "", requiredTools: "", prerequisiteUuids: [], prerequisites: "", findings: "", actualWork: "", measurements: "", actualLabor: null, completionDate: "", partsUsed: [],
    inspectionSignoffRequired: false, functionalTestRequired: false, functionalTestOutcome: "not-required", functionalTestResults: "", status: "draft",
    uuid: randomUUID(), version: 1, createdAt: now, createdBy: accounts.admin.id, updatedAt: now, technicianSignoff: null, inspectionSignoff: null, stepSignoffs: {},
  };
}

function importCards(count) {
  writeFileSync(CARDS_FILE, "");
  for (let i = 0; i < count; i++) {
    const card = jobCard(++total);
    appendFileSync(CARDS_FILE, JSON.stringify({ uuid: card.uuid, aircraftUuid, payload: JSON.stringify(card) }) + "\n");
  }
  runConvex(["import", "--table", "taskCards", "--append", "-y", "--format", "jsonLines", CARDS_FILE]);
}

async function snapshotOutcome() {
  try {
    const snapshot = await admin.query(api.operations.snapshot, {});
    return { ok: true, cards: snapshot.taskCards.length, bytes: Buffer.byteLength(JSON.stringify(snapshot)) };
  } catch (error) {
    // The failure is the measurement: Convex refuses the read past its limit.
    return { ok: false, error: errorText(error, ERROR_LIMIT) };
  }
}

function recordOutcome(result) {
  appendResult({
    step: "lookups", area: "server", name: "snapshot (one aircraft, small job cards only)", role: "admin",
    ok: result.ok, ms: [], medianMs: null, bytes: result.bytes ?? null, error: result.error ?? null,
    extra: { jobCards: total }, at: new Date().toISOString(),
  });
}
