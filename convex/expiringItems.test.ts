/**
 * Responsibility: Pins expiring dates on the server: who may save program and
 *   system-wide dates, what the snapshot shows whom, stale versions, replays
 *   and the change log.
 * Layer: Test. convex-test suite; never shipped.
 * Dependencies: convex/expiringItems.ts, convex/operations.ts,
 *   convex/schema.ts, tests/fixtures/alertProgram.ts.
 */
import { afterEach, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import {
  DEMO_PROGRAM,
  seedAlertProgram,
  type AlertWorld,
} from "../tests/fixtures/alertProgram";

const ITEM_UUID = "11111111-1111-4111-8111-111111111111";
const SYSTEM_UUID = "33333333-3333-4333-8333-333333333333";
const inProgram = { programUuid: DEMO_PROGRAM };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function save(item: object, requestUuid = crypto.randomUUID()) {
  return {
    ...inProgram,
    payload: JSON.stringify({ action: "save", requestUuid, item }),
  };
}

const policy = (patch: object = {}) => ({
  uuid: ITEM_UUID,
  programUuid: DEMO_PROGRAM,
  kind: "insurance",
  label: "Hull policy",
  expiresOn: "2030-01-31",
  version: 0,
  ...patch,
});

async function systemAdmin(world: AlertWorld) {
  const identity = await world.t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      active: true,
      isAdmin: true,
      name: "root",
      email: "root@example.test",
      groupIds: [],
      activeProgramUuid: DEMO_PROGRAM,
    });
    const session = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 86_400_000,
    });
    return { subject: `${userId}|${session}` };
  });
  return world.t.withIdentity(identity);
}

it("lets a program administrator save a date that only administrators see", async () => {
  const world = await seedAlertProgram();
  const { t, a, reader } = world;
  expect(await a.mutation(api.expiringItems.save, save(policy()))).toEqual({
    uuid: ITEM_UUID,
    version: 1,
  });
  const rows = await t.run((ctx) => ctx.db.query("expiringItems").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ uuid: ITEM_UUID, programUuid: DEMO_PROGRAM });
  expect(JSON.parse(rows[0].payload)).toMatchObject({
    label: "Hull policy",
    warnDays: 60,
    version: 1,
  });
  const audit = await t.run((ctx) => ctx.db.query("audit").collect());
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    action: "expiring-date.saved",
    entityUuid: ITEM_UUID,
    programUuid: DEMO_PROGRAM,
    actorId: world.ids.a.userId,
  });
  const mine = await a.query(api.operations.snapshot, {});
  expect(mine?.expiringItems?.map((i) => i.uuid)).toEqual([ITEM_UUID]);
  const theirs = await reader.query(api.operations.snapshot, {});
  expect(theirs?.expiringItems).toEqual([]);
  const root = await systemAdmin(world);
  const rootSnapshot = await root.query(api.operations.snapshot, {});
  expect(rootSnapshot?.expiringItems?.map((i) => i.uuid)).toEqual([ITEM_UUID]);
});

it("refuses members without administrator permission, with the message they see", async () => {
  const { reader } = await seedAlertProgram();
  await expect(
    reader.mutation(api.expiringItems.save, save(policy())),
  ).rejects.toMatchObject({
    name: "ConvexError",
    data: "Flight Program administrator required.",
  });
});

it("keeps system-wide dates to system administrators", async () => {
  const world = await seedAlertProgram();
  const { t, a } = world;
  const system = {
    uuid: SYSTEM_UUID,
    kind: "secret",
    label: "Entra client secret",
    expiresOn: "2027-06-01",
    version: 0,
  };
  await expect(
    a.mutation(api.expiringItems.save, save(system)),
  ).rejects.toMatchObject({
    name: "ConvexError",
    data: "Administrator permission required.",
  });
  const root = await systemAdmin(world);
  await root.mutation(api.expiringItems.save, save(system));
  const rows = await t.run((ctx) => ctx.db.query("expiringItems").collect());
  expect(rows[0].programUuid).toBeUndefined();
  expect((await a.query(api.operations.snapshot, {}))?.expiringItems).toEqual(
    [],
  );
  expect(
    (await root.query(api.operations.snapshot, {}))?.expiringItems?.map(
      (i) => i.uuid,
    ),
  ).toEqual([SYSTEM_UUID]);
  // The row for the audit entry carries no program: it is the deployment's.
  const audit = await t.run((ctx) => ctx.db.query("audit").collect());
  expect(audit[0].programUuid).toBeUndefined();
});

it("refuses a stale version, a malformed command, and replays a request id once", async () => {
  const { t, a } = await seedAlertProgram();
  const requestUuid = crypto.randomUUID();
  await a.mutation(api.expiringItems.save, save(policy(), requestUuid));
  // A replay returns nothing, which crosses the wire as null.
  expect(
    await a.mutation(api.expiringItems.save, save(policy(), requestUuid)),
  ).toBeNull();
  expect(
    await t.run((ctx) => ctx.db.query("expiringItems").collect()),
  ).toHaveLength(1);
  expect(await t.run((ctx) => ctx.db.query("audit").collect())).toHaveLength(1);
  await expect(
    a.mutation(api.expiringItems.save, save(policy({ label: "Again" }))),
  ).rejects.toMatchObject({
    name: "ConvexError",
    data: "This expiring date changed. Refresh and try again.",
  });
  await expect(
    a.mutation(
      api.expiringItems.save,
      save(policy({ expiresOn: "31/01/2030", version: 1 })),
    ),
  ).rejects.toMatchObject({ name: "ConvexError" });
  const archived = await a.mutation(api.expiringItems.save, {
    ...inProgram,
    payload: JSON.stringify({ action: "archive", uuid: ITEM_UUID, version: 1 }),
  });
  expect(archived).toEqual({ uuid: ITEM_UUID, version: 2 });
  const [row] = await t.run((ctx) => ctx.db.query("expiringItems").collect());
  expect(JSON.parse(row.payload)).toMatchObject({ archived: true, version: 2 });
  const actions = (await t.run((ctx) => ctx.db.query("audit").collect())).map(
    (r) => r.action,
  );
  expect(actions.sort()).toEqual([
    "expiring-date.archived",
    "expiring-date.saved",
  ]);
});
