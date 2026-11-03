// Exercises a local, disposable Convex deployment only. Never runs against cloud.
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
const env = await readFile(".env.local", "utf8");
const url = env.match(/^VITE_CONVEX_URL=(.*)$/m)?.[1]?.trim();
if (!url || !/^http:\/\/(localhost|127\.0\.0\.1):/.test(url))
  throw new Error("This smoke test only runs on a local Convex backend.");
let account;
try {
  account = JSON.parse(await readFile(".env.local-admin.json", "utf8"));
} catch {
  account = {
    email: "local-admin@example.test",
    name: "Local Administrator",
    password: randomBytes(24).toString("base64url"),
  };
  const convex = (args, input) =>
    spawnSync("npx", ["convex", ...args], { input, encoding: "utf8" });
  // The password travels over stdin, never in process arguments.
  if (
    convex(["env", "set", "BOOTSTRAP_ADMIN_PASSWORD"], account.password)
      .status !== 0
  )
    throw new Error("Could not stage the bootstrap password.");
  let result;
  try {
    result = convex([
      "run",
      "admin:bootstrap",
      JSON.stringify({ email: account.email, name: account.name }),
    ]);
  } finally {
    convex(["env", "remove", "BOOTSTRAP_ADMIN_PASSWORD"]);
  }
  if (result.status !== 0)
    throw new Error(result.stderr || "Bootstrap failed.");
  await writeFile(
    ".env.local-admin.json",
    JSON.stringify(account, null, 2) + "\n",
    { mode: 0o600 },
  );
}
const client = new ConvexHttpClient(url);
const login = await client.action(api.auth.signIn, {
  provider: "password",
  params: { flow: "signIn", email: account.email, password: account.password },
});
assert.ok(login.tokens?.token, "Password sign-in should issue a token");
client.setAuth(login.tokens.token);
let snapshot = await client.query(api.operations.snapshot, {});
assert.equal(snapshot.user.isAdmin, true);
assert.ok(snapshot.authenticatedAt > 0);
const programUuid = randomUUID();
await client.mutation(api.fleet.save, {
  programUuid: snapshot.activeProgramUuid,
  payload: JSON.stringify({
    action: "program.save",
    requestUuid: randomUUID(),
    reason: "Local smoke test",
    program: {
      uuid: programUuid,
      version: 0,
      name: "TEST-PROGRAM-" + programUuid,
      address: "",
      email: "",
      contactName: "",
      website: "",
    },
  }),
});
await client.mutation(api.programs.select, { programUuid });
snapshot = await client.query(api.operations.snapshot, {});
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
  baselineHobbs: 360000,
  baselineTach: 324000,
  baselineCycles: 100,
  baselineLandings: 200,
  currentHobbs: 360000,
  currentTach: 324000,
  cycles: 100,
  landings: 200,
  version: 0,
  operationalStatus: "unknown",
};
await client.mutation(api.admin.createAircraft, { aircraft, programUuid });
const operation = {
  programUuid,
  kind: "flight",
  uuid: randomUUID(),
  authorId: snapshot.user.id,
  baseVersion: 0,
  input: {
    aircraftUuid: uuid,
    pilotId: snapshot.user.id,
    startTime: "2026-01-01T10:00:00Z",
    hobbsOn: 363600,
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
assert.equal(
  (await client.mutation(api.operations.submit, { operation })).status,
  "accepted",
);
await client.mutation(api.operations.submit, { operation });
snapshot = await client.query(api.operations.snapshot, {});
assert.equal(
  snapshot.flights.filter((f) => f.uuid === operation.uuid).length,
  1,
);
assert.equal(snapshot.aircraft.find((a) => a.uuid === uuid).cycles, 101);
await client.mutation(api.operations.resolveDiscrepancy, {
  programUuid,
  uuid: operation.uuid + "-discrepancy",
  resolution: "Local test repair confirmed",
});
const second = {
  ...operation,
  uuid: randomUUID(),
  input: {
    ...operation.input,
    startTime: "2026-01-02T10:00:00Z",
    hobbsOn: 367200,
    discrepancy: "",
  },
};
assert.equal(
  (await client.mutation(api.operations.submit, { operation: second })).status,
  "review",
);
await client.mutation(api.operations.reviewFlight, {
  programUuid,
  uuid: second.uuid,
  decision: "accept",
  reason: "Local test chronology verified",
  input: second.input,
});
snapshot = await client.query(api.operations.snapshot, {});
assert.equal(snapshot.aircraft.find((a) => a.uuid === uuid).cycles, 102);
const pilotEmail =
  "local-pilot-" + randomBytes(4).toString("hex") + "@example.test";
const pilotPassword = randomBytes(24).toString("base64url");
const pilotId = await client.action(api.admin.createUser, {
  email: pilotEmail,
  name: "Local test pilot",
  password: pilotPassword,
});
const groupId = await client.mutation(api.admin.saveGroup, {
  programUuid,
  name: "Local test pilots",
  aircraftIds: [uuid],
  permissions: ["read", "flight", "discrepancy"],
});
await client.mutation(api.admin.updateUser, {
  id: pilotId,
  active: true,
  isAdmin: false,
  groupIds: [groupId],
});
const pilotClient = new ConvexHttpClient(url);
const pilotLogin = await pilotClient.action(api.auth.signIn, {
  provider: "password",
  params: { flow: "signIn", email: pilotEmail, password: pilotPassword },
});
pilotClient.setAuth(pilotLogin.tokens.token);
const pilotSnapshot = await pilotClient.query(api.operations.snapshot, {});
assert.deepEqual(
  pilotSnapshot.aircraft.map((a) => a.uuid),
  [uuid],
);
await assert.rejects(() =>
  pilotClient.mutation(api.admin.saveGroup, {
    programUuid,
    name: "Forbidden",
    aircraftIds: [uuid],
    permissions: ["read"],
  }),
);
await client.action(api.admin.resetPassword, {
  id: pilotId,
  password: randomBytes(24).toString("base64url"),
});
assert.ok(
  (await pilotClient.query(api.operations.snapshot, {})) === null,
  "Password reset must revoke the old session",
);
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
console.log(
  "Local Convex smoke test passed: real password login, admin access, aircraft creation, idempotent flight sync, discrepancy resolution, conflict review, user provisioning, scoped permissions, password-reset session revocation, blocked signup and anonymous writes.",
);
console.log(
  "Development-only administrator credentials are saved in ignored .env.local-admin.json. No secrets printed.",
);
