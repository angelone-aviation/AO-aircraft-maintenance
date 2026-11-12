/**
 * Responsibility: Pins expiring dates on the server: who may save program and
 *   system-wide dates, what the snapshot shows whom, stale versions, replays
 *   and who reads their change-log rows.
 * Layer: Test. convex-test suite; never shipped.
 * Dependencies: convex/expiringItems.ts, convex/operations.ts,
 *   convex/auditHistory.ts, convex/recordsDate.ts, convex/schema.ts,
 *   src/domain/auditHistory.ts, tests/fixtures/alertProgram.ts.
 */
import { afterEach, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import { recordsDate } from "./recordsDate";
import {
  DEMO_PROGRAM,
  OTHER_PROGRAM,
  seedAlertProgram,
  type AlertWorld,
} from "../tests/fixtures/alertProgram";
import { HISTORY_NOT_FOUND } from "../src/domain/auditHistory";

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

const firstPage = { ...inProgram, cursor: null, numItems: 50 };
// A summary without day bounds counts days in the records time zone, where
// it is still yesterday for the first hours of each UTC day.
const today = () => recordsDate();

it("keeps an aircraft's expiring date out of the change log of members without administrator permission", async () => {
  const world = await seedAlertProgram();
  const { a, reader, ids } = world;
  const hull = policy({
    aircraftUuid: ids.aircraftUuid,
    label: "Hull policy 4471",
    note: "Broker login is in the safe",
  });
  await a.mutation(api.expiringItems.save, save(hull));
  await a.mutation(api.expiringItems.save, {
    ...inProgram,
    payload: JSON.stringify({ action: "archive", uuid: ITEM_UUID, version: 1 }),
  });
  // The reader's group covers the aircraft the rows are tagged with.
  const snapshot = await reader.query(api.operations.snapshot, {});
  expect(snapshot?.aircraft.map((x) => x.uuid)).toContain(ids.aircraftUuid);
  expect(snapshot?.audit).toEqual([]);
  expect((await reader.query(api.auditHistory.page, firstPage)).page).toEqual(
    [],
  );
  const onAircraft = { ...firstPage, aircraftUuid: ids.aircraftUuid };
  expect((await reader.query(api.auditHistory.page, onAircraft)).page).toEqual(
    [],
  );
  await expect(
    reader.query(api.auditHistory.page, {
      ...firstPage,
      entityUuid: ITEM_UUID,
    }),
  ).rejects.toMatchObject({ data: HISTORY_NOT_FOUND });
  // The other program's administrator is no administrator of this one.
  await expect(
    world.b.query(api.auditHistory.page, {
      ...firstPage,
      programUuid: OTHER_PROGRAM,
      entityUuid: ITEM_UUID,
    }),
  ).rejects.toMatchObject({ data: HISTORY_NOT_FOUND });
});

it("shows a program's expiring-date changes to its administrators in every history read", async () => {
  const world = await seedAlertProgram();
  const { a, ids } = world;
  const onAircraft = policy({ aircraftUuid: ids.aircraftUuid });
  await a.mutation(api.expiringItems.save, save(onAircraft));
  const other = "22222222-2222-4222-8222-222222222222";
  await a.mutation(api.expiringItems.save, save(policy({ uuid: other })));
  await a.mutation(api.expiringItems.save, {
    ...inProgram,
    payload: JSON.stringify({ action: "archive", uuid: other, version: 1 }),
  });
  const expected = [
    "expiring-date.archived",
    "expiring-date.saved",
    "expiring-date.saved",
  ];
  for (const client of [a, await systemAdmin(world)]) {
    const snapshot = await client.query(api.operations.snapshot, {});
    expect(snapshot?.audit.map((e) => e.action)).toEqual(expected);
    const { page } = await client.query(api.auditHistory.page, firstPage);
    expect(page.map((e) => e.action)).toEqual(expected);
    const own = await client.query(api.auditHistory.page, {
      ...firstPage,
      entityUuid: other,
    });
    expect(own.page.map((e) => e.action)).toEqual(expected.slice(0, 2));
    const { summary } = await client.query(api.auditHistory.summary, {
      ...inProgram,
      from: today(),
      to: today(),
    });
    expect(summary.total).toBe(3);
    expect(summary.notable.map((n) => [n.kind, n.action])).toEqual([
      ["archive", "expiring-date.archived"],
    ]);
  }
});

it("opens a system-wide date's history to system administrators only", async () => {
  const world = await seedAlertProgram();
  const root = await systemAdmin(world);
  const secret = {
    uuid: SYSTEM_UUID,
    kind: "secret",
    label: "Entra client secret",
    expiresOn: "2027-06-01",
    version: 0,
  };
  await root.mutation(api.expiringItems.save, save(secret));
  const own = { ...firstPage, entityUuid: SYSTEM_UUID };
  expect(
    (await root.query(api.auditHistory.page, own)).page.map((e) => e.action),
  ).toEqual(["expiring-date.saved"]);
  await expect(world.a.query(api.auditHistory.page, own)).rejects.toMatchObject(
    { data: HISTORY_NOT_FOUND },
  );
});

it("moves an aircraft's expiring dates with it to the new Flight Program, audited", async () => {
  const world = await seedAlertProgram();
  const { t, a, b, ids } = world;
  const registration = policy({
    kind: "registration",
    label: "N-number registration",
    aircraftUuid: ids.aircraftUuid,
  });
  const unrelated = "22222222-2222-4222-8222-222222222222";
  await a.mutation(api.expiringItems.save, save(registration));
  await a.mutation(api.expiringItems.save, save(policy({ uuid: unrelated })));
  const root = await systemAdmin(world);
  await root.mutation(api.programs.transfer, {
    ...inProgram,
    kind: "aircraft",
    uuid: ids.aircraftUuid,
    destination: OTHER_PROGRAM,
    reason: "Sold to the other program",
  });
  const rows = await t.run((ctx) => ctx.db.query("expiringItems").collect());
  const moved = rows.find((r) => r.uuid === ITEM_UUID)!;
  expect(moved.programUuid).toBe(OTHER_PROGRAM);
  expect(JSON.parse(moved.payload)).toMatchObject({
    programUuid: OTHER_PROGRAM,
    aircraftUuid: ids.aircraftUuid,
    version: 2,
  });
  expect(rows.find((r) => r.uuid === unrelated)!.programUuid).toBe(
    DEMO_PROGRAM,
  );
  // The destination's administrators see, edit and read the history of it;
  // the source's no longer hold it.
  const theirs = await b.query(api.operations.snapshot, {});
  expect(theirs?.expiringItems?.map((i) => i.uuid)).toEqual([ITEM_UUID]);
  const ours = await a.query(api.operations.snapshot, {});
  expect(ours?.expiringItems?.map((i) => i.uuid)).toEqual([unrelated]);
  await b.mutation(api.expiringItems.save, {
    programUuid: OTHER_PROGRAM,
    payload: JSON.stringify({
      action: "save",
      item: { ...registration, programUuid: OTHER_PROGRAM, version: 2 },
    }),
  });
  const history = await b.query(api.auditHistory.page, {
    programUuid: OTHER_PROGRAM,
    entityUuid: ITEM_UUID,
    cursor: null,
    numItems: 10,
  });
  expect(history.page.map((e) => [e.action, e.programUuid])).toEqual([
    ["expiring-date.saved", OTHER_PROGRAM],
    ["expiring-date.transferred", OTHER_PROGRAM],
    ["expiring-date.saved", DEMO_PROGRAM],
  ]);
  const transferred = history.page[1];
  expect(transferred.reason).toBe("Sold to the other program");
  expect(JSON.parse(transferred.before!)).toMatchObject({
    programUuid: DEMO_PROGRAM,
  });
  expect(JSON.parse(transferred.after!)).toMatchObject({
    programUuid: OTHER_PROGRAM,
  });
});
