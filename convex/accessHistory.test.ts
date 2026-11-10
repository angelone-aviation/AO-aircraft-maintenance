/**
 * Responsibility: Pins who reads the change-log rows of access changes:
 *   permission groups saved and deleted and program access changed are for
 *   the program's administrators and system administrators; account-wide
 *   rows stay with system administrators in Unassigned records.
 * Layer: Test. convex-test suite; never shipped.
 * Dependencies: convex/admin.ts, convex/programUsers.ts,
 *   convex/groupDeletion.ts, convex/identities.ts, convex/auditHistory.ts,
 *   convex/operations.ts, tests/fixtures/alertProgram.ts.
 *
 * Every row is written by the mutation that writes it in production, so the
 * tests fail when a writer and the history filter stop agreeing.
 */
import { expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  DEMO_PROGRAM,
  OTHER_PROGRAM,
  seedAlertProgram,
  type AlertWorld,
} from "../tests/fixtures/alertProgram";

const DAY_MS = 86_400_000;
const ACCESS_ACTIONS = [
  "group.deleted",
  "user.program_access_changed",
  "group.saved",
];
type Client = AlertWorld["a"];

const today = () => new Date().toISOString().slice(0, 10);

async function systemAdmin({ t }: AlertWorld, activeProgramUuid: string) {
  const subject = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      active: true,
      isAdmin: true,
      name: "root",
      email: `root-${activeProgramUuid || "none"}@example.test`,
      groupIds: [],
      activeProgramUuid,
    });
    const session = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + DAY_MS,
    });
    return `${userId}|${session}`;
  });
  return t.withIdentity({ subject });
}

// The demo program's administrator creates a group, moves the reader into
// it, back out, and deletes it.
async function changeAccess(world: AlertWorld) {
  const { a, ids, t } = world;
  const inProgram = { programUuid: DEMO_PROGRAM };
  const night = await a.mutation(api.admin.saveGroup, {
    ...inProgram,
    name: "Night crew",
    aircraftIds: [],
    allAircraft: true,
    permissions: ["read", "flight"],
  });
  const reader = ids.reader.userId as Id<"users">;
  const before = (await t.run((ctx) => ctx.db.get(reader)))!.groupIds!;
  await a.mutation(api.programUsers.updateAccess, {
    ...inProgram,
    groupIds: [...before, night],
    userId: reader,
    remove: false,
  });
  const plan = await a.query(api.groupDeletion.preview, {
    ...inProgram,
    id: night,
  });
  await a.mutation(api.groupDeletion.remove, {
    ...inProgram,
    id: night,
    expected: plan.expected,
  });
}

async function historyActions(client: Client, programUuid?: string) {
  const { page } = await client.query(api.auditHistory.page, {
    programUuid,
    cursor: null,
    numItems: 100,
  });
  return page.map((e) => e.action);
}

async function snapshotActions(client: Client) {
  const snapshot = await client.query(api.operations.snapshot, {});
  return snapshot!.audit.map((e) => e.action);
}

it("shows a program's access changes to its administrators and to system administrators there", async () => {
  const world = await seedAlertProgram();
  await changeAccess(world);
  const root = await systemAdmin(world, DEMO_PROGRAM);
  for (const client of [world.a, root]) {
    expect(await historyActions(client, DEMO_PROGRAM)).toEqual(ACCESS_ACTIONS);
    expect(await snapshotActions(client)).toEqual(ACCESS_ACTIONS);
    const { summary } = await client.query(api.auditHistory.summary, {
      programUuid: DEMO_PROGRAM,
      from: today(),
      to: today(),
    });
    expect(summary.families.access).toBe(3);
    expect(summary.notable.map((n) => [n.kind, n.action])).toEqual(
      ACCESS_ACTIONS.map((action) => ["permission-change", action]),
    );
  }
});

it("keeps them from members without administrator permission and from every other program", async () => {
  const world = await seedAlertProgram();
  await changeAccess(world);
  expect(await historyActions(world.reader, DEMO_PROGRAM)).toEqual([]);
  expect(await snapshotActions(world.reader)).toEqual([]);
  expect(await historyActions(world.b, OTHER_PROGRAM)).toEqual([]);
  expect(await snapshotActions(world.b)).toEqual([]);
  const elsewhere = await systemAdmin(world, OTHER_PROGRAM);
  expect(await historyActions(elsewhere, OTHER_PROGRAM)).toEqual([]);
  // Asking for the group's own history by its id reaches the rows through
  // another index; the answer is the same.
  const [saved] = await world.t.run((ctx) => ctx.db.query("audit").collect());
  const own = { entityUuid: saved.entityUuid, cursor: null, numItems: 10 };
  for (const [client, programUuid] of [
    [world.reader, DEMO_PROGRAM],
    [world.b, OTHER_PROGRAM],
    [elsewhere, OTHER_PROGRAM],
  ] as const)
    await expect(
      client.query(api.auditHistory.page, { ...own, programUuid }),
    ).rejects.toThrow("History not found.");
});

it("leaves account-wide rows with system administrators in Unassigned records", async () => {
  const world = await seedAlertProgram();
  const { t, a, ids } = world;
  const root = await systemAdmin(world, DEMO_PROGRAM);
  const reader = ids.reader.userId as Id<"users">;
  const groupIds = (await t.run((ctx) => ctx.db.get(reader)))!.groupIds!;
  await root.mutation(api.admin.updateUser, {
    id: reader,
    active: false,
    isAdmin: false,
    groupIds,
  });
  await t.mutation(internal.identities.recordRefusal, {
    provider: "google",
    providerAccountId: "1234567890",
    email: "stranger@example.test",
    reason: "no_account",
  });
  const accountWide = [
    "user.sign_in_refused",
    "user.sessions_ended",
    "user.permissions_changed",
  ];
  const written = await t.run((ctx) => ctx.db.query("audit").collect());
  expect(written.map((r) => [r.action, r.programUuid]).reverse()).toEqual(
    accountWide.map((action) => [action, undefined]),
  );
  for (const client of [a, root]) {
    expect(await historyActions(client, DEMO_PROGRAM)).toEqual([]);
    expect(await snapshotActions(client)).toEqual([]);
  }
  const unassigned = await systemAdmin(world, "");
  expect(await historyActions(unassigned)).toEqual(accountWide);
});
