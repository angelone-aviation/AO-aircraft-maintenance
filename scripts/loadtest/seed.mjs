/**
 * Responsibility: Creates the "Load test fleet" program, its 6 aircraft,
 *   groups and test users through the real API, and writes
 *   DATA_DIR/accounts.json for the other load-test scripts.
 * Layer: Script. Load test only; refuses any backend but a local one.
 * Dependencies: ./common.mjs, ./guard.mjs, node:crypto, node:fs.
 *
 *   node scripts/loadtest/seed.mjs
 * Signs in as the local administrator that `npm run test:local` keeps in
 * .env.local-admin.json. accounts.json holds the generated passwords, so it
 * is written readable by its owner only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { api, DATA_DIR, readJson, REPO_ROOT, signIn } from "./common.mjs";
import { localBackendUrl } from "./guard.mjs";

const HOUR = 3600;
const PASSWORD_BYTES = 24;
const EMAIL_TAG_BYTES = 3;
// The tach starts this many hours behind the Hobbs.
const TACH_BEHIND_HOURS = 80;
const ALL_PERMISSIONS = ["read", "flight", "discrepancy", "resolve", "maintenance"];
const OWNED_AIRCRAFT_COUNT = 2;
// The history-paging measurements' pilot reads two of the six aircraft.
const PARTIAL_PILOT_AIRCRAFT = 2;
// Readings at the START of the 20-year timeline: these become the baselines.
const FLEET = [
  ["N501LT", "Cessna", "208B Grand Caravan", "208B5001", 2200, true],
  ["N502LT", "Cessna", "208B Grand Caravan", "208B5002", 1800, true],
  ["N503LT", "Cessna", "206H Stationair", "20608503", 900, false],
  ["N504LT", "Cessna", "206H Stationair", "20608504", 1200, false],
  ["N505LT", "Quest", "Kodiak 100", "100-0505", 400, true],
  ["N506LT", "Quest", "Kodiak 100", "100-0506", 650, true],
];
const USERS = [
  ["pilot", "Pat Pilot", "pilots"],
  ["pilot2", "Robin Aviator", "pilots"],
  ["pilot3", "Jesse Flyer", "pilots"],
  ["pilotTwo", "Alex Twoship", "pilotsTwo"],
  ["mechanic", "Casey Wrench", "mechanics"],
  ["mechanic2", "Riley Inspector", "mechanics"],
  ["owner", "Sam Owner", "owners"],
  ["board", "Morgan Board", "board"],
];

localBackendUrl();
const admin = readJson(`${REPO_ROOT}/.env.local-admin.json`);
const client = await signIn(admin.email, admin.password);
const { activeProgramUuid } = await client.query(api.operations.snapshot, {});
const programUuid = randomUUID();
await createProgram();
const aircraft = [];
for (const plane of FLEET) aircraft.push(await addAircraft(plane));
const groups = await addGroups();
const users = [];
for (const [role, name, group] of USERS)
  users.push(await addUser(role, name, groups[group]));
const snapshot = await client.query(api.operations.snapshot, {});
mkdirSync(DATA_DIR, { recursive: true });
writeFileSync(
  `${DATA_DIR}/accounts.json`,
  JSON.stringify(
    { programUuid, admin: { ...admin, id: snapshot.user.id, role: "admin" }, users, groups, aircraft },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log("Seeded program", programUuid, "aircraft", snapshot.aircraft.length, "members", snapshot.members.length);

// A new program is saved from the program the administrator works in.
function saveFleet(payload) {
  return client.mutation(api.fleet.save, {
    programUuid: payload.action === "program.save" ? activeProgramUuid : programUuid,
    payload: JSON.stringify({ requestUuid: randomUUID(), reason: "Load test seed", ...payload }),
  });
}

async function createProgram() {
  await saveFleet({
    action: "program.save",
    program: { uuid: programUuid, version: 0, name: "Load test fleet", address: "Hangar 4, Test Field", email: "ops@example.test", contactName: "Load Tester", website: "" },
  });
  await client.mutation(api.programs.select, { programUuid });
}

async function addAircraft([registration, make, model, serial, hours, turbine]) {
  const uuid = randomUUID();
  const start = { hobbs: hours * HOUR, tach: (hours - TACH_BEHIND_HOURS) * HOUR, cycles: hours * 2, landings: hours * 2 };
  await saveFleet({
    action: "aircraft.save",
    aircraft: { uuid, registration, make, model, serial, programUuid, turbine, meter: "hobbs", adjustmentSeconds: 0, currentHobbs: start.hobbs, currentTach: start.tach, cycles: start.cycles, landings: start.landings, version: 0, operationalStatus: "unknown" },
  });
  return { uuid, registration, make, model, serial, start };
}

async function addGroups() {
  const group = (name, permissions, flags = {}) =>
    client.mutation(api.admin.saveGroup, { programUuid, name, aircraftIds: [], allAircraft: true, permissions, ...flags });
  return {
    admins: await group("LT program administrators", ALL_PERMISSIONS, { programAdmin: true }),
    pilots: await group("LT pilots", ["read", "flight", "discrepancy"]),
    pilotsTwo: await client.mutation(api.admin.saveGroup, {
      programUuid,
      name: "LT pilots, two aircraft",
      aircraftIds: aircraft.slice(0, PARTIAL_PILOT_AIRCRAFT).map((a) => a.uuid),
      permissions: ["read", "flight", "discrepancy"],
    }),
    mechanics: await group("LT maintenance", ["read", "discrepancy", "resolve", "maintenance"]),
    owners: await client.mutation(api.admin.saveGroup, {
      programUuid,
      name: "LT aircraft owners",
      aircraftIds: aircraft.slice(0, OWNED_AIRCRAFT_COUNT).map((a) => a.uuid),
      permissions: ["read"],
      owner: true,
    }),
    board: await group("LT board", ["read"], { board: true }),
  };
}

async function addUser(role, name, groupId) {
  const email = `lt-${role}-${randomBytes(EMAIL_TAG_BYTES).toString("hex")}@example.test`;
  const password = randomBytes(PASSWORD_BYTES).toString("base64url");
  const id = await client.action(api.admin.createUser, { email, name, password });
  await client.mutation(api.admin.updateUser, { id, active: true, isAdmin: false, groupIds: [groupId] });
  return { role, id, name, email, password };
}
