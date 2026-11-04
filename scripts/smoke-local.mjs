/**
 * Responsibility: Smoke-tests a local Convex backend over its real API:
 *   password sign-in, flight sync, conflict review, provisioning, scoped access
 *   and session revocation.
 * Layer: Script. Local, disposable deployments only; refuses any other URL.
 * Dependencies: convex/browser, convex/_generated/api.js, node:assert, the
 *   Convex CLI.
 *
 * The first run creates a local administrator and keeps its generated password
 * in git-ignored .env.local-admin.json, which the live browser test also reads.
 */
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const ADMIN_FILE = ".env.local-admin.json";
// Meter readings are stored in seconds.
const HOUR = 3600;

const url = await readLocalUrl();
const account = await readOrCreateAdmin();
const client = await signInAdmin(account);
let snapshot = await client.query(api.operations.snapshot, {});
assert.equal(snapshot.user.isAdmin, true);
assert.ok(snapshot.authenticatedAt > 0);
const programUuid = await createTestProgram(snapshot.activeProgramUuid);
snapshot = await client.query(api.operations.snapshot, {});
const aircraftUuid = await createTestAircraft(programUuid);
const operation = await checkFlightSync(
  flightOperation(programUuid, aircraftUuid, snapshot.user.id),
);
await checkConflictReview(operation);
await checkScopedPilot(programUuid, aircraftUuid);
await checkAnonymousRefusals(operation);
console.log(
  "Local Convex smoke test passed: real password login, admin access, aircraft creation, idempotent flight sync, discrepancy resolution, conflict review, user provisioning, scoped permissions, password-reset session revocation, blocked signup and anonymous writes.",
);
console.log(
  "Development-only administrator credentials are saved in ignored .env.local-admin.json. No secrets printed.",
);

async function readLocalUrl() {
  const env = await readFile(".env.local", "utf8");
  const localUrl = env.match(/^VITE_CONVEX_URL=(.*)$/m)?.[1]?.trim();
  if (!localUrl || !/^http:\/\/(localhost|127\.0\.0\.1):/.test(localUrl))
    throw new Error("This smoke test only runs on a local Convex backend.");
  return localUrl;
}

async function readOrCreateAdmin() {
  try {
    return JSON.parse(await readFile(ADMIN_FILE, "utf8"));
  } catch {
    // No saved administrator: the first run on this deployment.
    return createLocalAdmin();
  }
}

async function createLocalAdmin() {
  const admin = {
    email: "local-admin@example.test",
    name: "Local Administrator",
    password: generatePassword(),
  };
  const convex = (args, input) =>
    spawnSync("npx", ["convex", ...args], { input, encoding: "utf8" });
  // The password travels over stdin, never in process arguments.
  if (
    convex(["env", "set", "BOOTSTRAP_ADMIN_PASSWORD"], admin.password)
      .status !== 0
  )
    throw new Error("Could not stage the bootstrap password.");
  let result;
  try {
    result = convex([
      "run",
      "admin:bootstrap",
      JSON.stringify({ email: admin.email, name: admin.name }),
    ]);
  } finally {
    convex(["env", "remove", "BOOTSTRAP_ADMIN_PASSWORD"]);
  }
  if (result.status !== 0)
    throw new Error(result.stderr || "Bootstrap failed.");
  await writeFile(ADMIN_FILE, JSON.stringify(admin, null, 2) + "\n", {
    mode: 0o600,
  });
  return admin;
}

async function signInAdmin({ email, password }) {
  const admin = new ConvexHttpClient(url);
  const login = await signIn(admin, email, password);
  assert.ok(login.tokens?.token, "Password sign-in should issue a token");
  admin.setAuth(login.tokens.token);
  return admin;
}

function signIn(convexClient, email, password) {
  return convexClient.action(api.auth.signIn, {
    provider: "password",
    params: { flow: "signIn", email, password },
  });
}

async function createTestProgram(activeProgramUuid) {
  const uuid = randomUUID();
  await client.mutation(api.fleet.save, {
    programUuid: activeProgramUuid,
    payload: JSON.stringify({
      action: "program.save",
      requestUuid: randomUUID(),
      reason: "Local smoke test",
      program: {
        uuid,
        version: 0,
        name: "TEST-PROGRAM-" + uuid,
        address: "",
        email: "",
        contactName: "",
        website: "",
      },
    }),
  });
  await client.mutation(api.programs.select, { programUuid: uuid });
  return uuid;
}

async function createTestAircraft(programUuid) {
  const uuid = randomUUID();
  const aircraft = {
    uuid,
    registration: "TEST-" + randomBytes(3).toString("hex").toUpperCase(),
    make: "Cessna",
    model: "172 (test)",
    serial: "LOCAL-TEST",
    program: "Local smoke test",
    programUuid,
    meter: "hobbs",
    adjustmentSeconds: 0,
    baselineHobbs: 100 * HOUR,
    baselineTach: 90 * HOUR,
    baselineCycles: 100,
    baselineLandings: 200,
    currentHobbs: 100 * HOUR,
    currentTach: 90 * HOUR,
    cycles: 100,
    landings: 200,
    version: 0,
    operationalStatus: "unknown",
  };
  await client.mutation(api.admin.createAircraft, { aircraft, programUuid });
  return uuid;
}

function flightOperation(programUuid, aircraftUuid, userId) {
  return {
    programUuid,
    kind: "flight",
    uuid: randomUUID(),
    authorId: userId,
    baseVersion: 0,
    input: {
      aircraftUuid,
      pilotId: userId,
      startTime: "2026-01-01T10:00:00Z",
      hobbsOn: 101 * HOUR,
      landings: 1,
      cycles: 1,
      origin: "TEST-A",
      destination: "TEST-B",
      operation: "Mission",
      flightRules: "VFR",
      remarks: "Automated local smoke test",
      discrepancy: "Test landing light report",
    },
  };
}

async function checkFlightSync(operation) {
  const { programUuid, input } = operation;
  assert.equal(
    (await client.mutation(api.operations.submit, { operation })).status,
    "accepted",
  );
  // Sent again, as an outbox retry would: it must still be one flight.
  await client.mutation(api.operations.submit, { operation });
  const synced = await client.query(api.operations.snapshot, {});
  assert.equal(
    synced.flights.filter((f) => f.uuid === operation.uuid).length,
    1,
  );
  assert.equal(
    synced.aircraft.find((a) => a.uuid === input.aircraftUuid).cycles,
    101,
  );
  await client.mutation(api.operations.resolveDiscrepancy, {
    programUuid,
    uuid: operation.uuid + "-discrepancy",
    resolution: "Local test repair confirmed",
  });
  return operation;
}

// The second flight still names aircraft version 0, which the first flight
// moved on, so the server holds it for conflict review.
async function checkConflictReview(operation) {
  const second = {
    ...operation,
    uuid: randomUUID(),
    input: {
      ...operation.input,
      startTime: "2026-01-02T10:00:00Z",
      hobbsOn: 102 * HOUR,
      discrepancy: "",
    },
  };
  assert.equal(
    (await client.mutation(api.operations.submit, { operation: second }))
      .status,
    "review",
  );
  await client.mutation(api.operations.reviewFlight, {
    programUuid: operation.programUuid,
    uuid: second.uuid,
    decision: "accept",
    reason: "Local test chronology verified",
    input: second.input,
  });
  const reviewed = await client.query(api.operations.snapshot, {});
  assert.equal(
    reviewed.aircraft.find((a) => a.uuid === operation.input.aircraftUuid)
      .cycles,
    102,
  );
}

async function checkScopedPilot(programUuid, aircraftUuid) {
  const pilot = await provisionPilot(programUuid, aircraftUuid);
  const pilotClient = new ConvexHttpClient(url);
  const pilotLogin = await signIn(pilotClient, pilot.email, pilot.password);
  pilotClient.setAuth(pilotLogin.tokens.token);
  const pilotSnapshot = await pilotClient.query(api.operations.snapshot, {});
  assert.deepEqual(
    pilotSnapshot.aircraft.map((a) => a.uuid),
    [aircraftUuid],
  );
  await assert.rejects(() =>
    pilotClient.mutation(api.admin.saveGroup, {
      programUuid,
      name: "Forbidden",
      aircraftIds: [aircraftUuid],
      permissions: ["read"],
    }),
  );
  await client.action(api.admin.resetPassword, {
    id: pilot.id,
    password: generatePassword(),
  });
  assert.ok(
    (await pilotClient.query(api.operations.snapshot, {})) === null,
    "Password reset must revoke the old session",
  );
}

async function provisionPilot(programUuid, aircraftUuid) {
  const email =
    "local-pilot-" + randomBytes(4).toString("hex") + "@example.test";
  const password = generatePassword();
  const id = await client.action(api.admin.createUser, {
    email,
    name: "Local test pilot",
    password,
  });
  const groupId = await client.mutation(api.admin.saveGroup, {
    programUuid,
    name: "Local test pilots",
    aircraftIds: [aircraftUuid],
    permissions: ["read", "flight", "discrepancy"],
  });
  await client.mutation(api.admin.updateUser, {
    id,
    active: true,
    isAdmin: false,
    groupIds: [groupId],
  });
  return { email, password, id };
}

// Accounts are provisioned by administrators only (ADR-0002), and writes need
// a session.
async function checkAnonymousRefusals(operation) {
  const anonymous = new ConvexHttpClient(url);
  await assert.rejects(() =>
    anonymous.action(api.auth.signIn, {
      provider: "password",
      params: {
        flow: "signUp",
        email: "blocked@example.test",
        password: "blocked-password",
      },
    }),
  );
  await assert.rejects(() =>
    anonymous.mutation(api.operations.submit, { operation }),
  );
}

// 32 characters, inside the 15 to 128 the password rule allows.
function generatePassword() {
  return randomBytes(24).toString("base64url");
}
