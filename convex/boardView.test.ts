/**
 * Responsibility: Pins the board view on the server: the snapshot a board
 *   member gets (totals and status inputs, no rates, flights, change log,
 *   people or typed text), the backup time it carries, and that every call
 *   but the snapshot is refused as read-only.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/operations, convex/costs, convex/workOrders,
 *   convex/auditHistory, convex/alerts, src/data/demo, src/domain
 *   (airworthiness, boardView), tests/fixtures.
 */
import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import { workOrderCommand } from "../tests/fixtures/workOrders";
import { OWNED_AIRCRAFT, seedSampleRoles } from "../tests/fixtures/sampleRoles";
import { adSchema } from "../src/domain/airworthiness";
import { BOARD_TERMINATED } from "../src/domain/boardView";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const DAY_MS = 86_400_000;
const PROGRAM = "demo-program";
const READ_ONLY = "Board access is read-only.";
const today = new Date().toISOString().slice(0, 10);

/** The demo program with a program administrator and a board member. */
async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const s = demoSnapshot();
    for (const a of s.aircraft) await ctx.db.insert("aircraft", a);
    await ctx.db.insert("programs", s.programs![0]);
    await ctx.db.insert("discrepancies", s.discrepancies[0]);
    const makeUser = async (group: {
      programAdmin?: boolean;
      board?: boolean;
      permissions: ("read" | "maintenance")[];
    }) => {
      const groupId = await ctx.db.insert("groups", {
        programUuid: PROGRAM,
        name: group.board ? "Board (read-only)" : "Program managers",
        aircraftIds: [],
        ...group,
      });
      const user = await ctx.db.insert("users", {
        name: group.board ? "Jordan Board" : "Alex Admin",
        email: group.board ? "jordan@example.test" : "alex@example.test",
        active: true,
        isAdmin: false,
        activeProgramUuid: PROGRAM,
        groupIds: [groupId],
      });
      const session = await ctx.db.insert("authSessions", {
        userId: user,
        expirationTime: Date.now() + DAY_MS,
      });
      return { subject: `${user}|${session}` };
    };
    return {
      admin: await makeUser({
        programAdmin: true,
        permissions: ["read", "maintenance"],
      }),
      board: await makeUser({ board: true, permissions: ["read"] }),
    };
  });
  return {
    t,
    admin: t.withIdentity(ids.admin),
    board: t.withIdentity(ids.board),
  };
}

type Client = ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;
const cost = (client: Client, command: unknown) =>
  client.mutation(api.costs.execute, {
    programUuid: PROGRAM,
    payload: JSON.stringify(command),
  });

it("gives a board member totals and status inputs, never rates, flights, the change log or other people", async () => {
  const { admin, board } = await fixture();
  const order = workOrderCommand();
  await admin.mutation(api.workOrders.save, {
    programUuid: PROGRAM,
    payload: JSON.stringify(order),
  });
  const aircraftUuid = order.fields.aircraftUuid;
  await cost(admin, { action: "settings.laborRate", laborRateCents: 9500 });
  await cost(admin, {
    action: "budget.set",
    aircraftUuid,
    year: Number(today.slice(0, 4)),
    amountCents: 500_000,
  });
  await cost(admin, {
    action: "other.add",
    workOrderUuid: order.uuid,
    entry: {
      uuid: crypto.randomUUID(),
      date: today,
      description: "Ferry fuel",
      amountCents: 12_345,
    },
  });
  await cost(admin, {
    action: "labor.add",
    workOrderUuid: order.uuid,
    entry: {
      uuid: crypto.randomUUID(),
      date: today,
      technician: "Pat Technician",
      minutes: 90,
    },
  });

  const view = (await board.query(api.operations.snapshot, {}))!;
  expect(view.activeProgramUuid).toBe(PROGRAM);
  expect(view.aircraft.map((a) => a.uuid).sort()).toEqual(
    demoSnapshot()
      .aircraft.map((a) => a.uuid)
      .sort(),
  );
  expect(view.flights).toEqual([]);
  expect(view.audit).toEqual([]);
  expect(view.members).toHaveLength(1);
  expect(view.members[0].id).toBe(view.user.id);
  expect(view.costs).toBeUndefined();
  expect(view.aircraftFiles).toBeUndefined();
  expect(view.inventoryAttachments).toBeUndefined();
  expect(view.manuals).toBeUndefined();
  // 90 minutes at $95/h plus the other cost, totalled, with no line items.
  const totals = view.boardCosts!.find((c) => c.aircraftUuid === aircraftUuid);
  expect(totals).toMatchObject({
    yearCents: 14_250 + 12_345,
    quarterCents: 14_250 + 12_345,
    budgetCents: 500_000,
    overBudget: false,
  });
  expect(view.discrepancies).toHaveLength(1);
  expect(view.discrepancies[0].description).toBe("");
  expect(view.discrepancies[0].authorId).toBe("");
  const text = JSON.stringify(view);
  expect(text).not.toMatch(
    /rateCents|laborRateCents|Ferry fuel|Pat Technician|Alex Admin|alex@/,
  );
  expect(view.offsiteBackupAt).toBeUndefined();

  const adminView = (await admin.query(api.operations.snapshot, {}))!;
  expect(adminView.boardCosts).toBeUndefined();
  expect(adminView.costs?.length).toBeGreaterThan(0);
});

it("carries the newest off-site backup's time to the board", async () => {
  const { t, board } = await fixture();
  const completedAt = Date.now() - DAY_MS;
  await t.run(async (ctx) => {
    for (const at of [completedAt - DAY_MS, completedAt])
      await ctx.db.insert("backupRuns", {
        completedAt: at,
        objectKey: `daily/${at}.zip.age`,
        bytes: 10,
        sha256: "0".repeat(64),
        envUploaded: false,
        recordedAt: at,
      });
  });
  const view = (await board.query(api.operations.snapshot, {}))!;
  expect(view.offsiteBackupAt).toBe(completedAt);
});

it("refuses every program call from a board member as read-only", async () => {
  const { board } = await fixture();
  const report = demoSnapshot().discrepancies[0];
  await expect(
    board.mutation(api.operations.resolveDiscrepancy, {
      programUuid: PROGRAM,
      uuid: report.uuid,
      resolution: "Fixed.",
    }),
  ).rejects.toThrow(READ_ONLY);
  await expect(
    board.query(api.auditHistory.page, {
      programUuid: PROGRAM,
      cursor: null,
      numItems: 10,
    }),
  ).rejects.toThrow(READ_ONLY);
  await expect(
    board.query(api.alerts.readKeys, { programUuid: PROGRAM }),
  ).rejects.toThrow(READ_ONLY);
});

// Text typed on an AD and a deferral of the sample program's first aircraft,
// each value marked so that any that reaches the board is found by name.
async function seedTypedText() {
  const world = await seedSampleRoles();
  await world.t.run(async (ctx) => {
    const doc = (await ctx.db
      .query("airworthiness")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", OWNED_AIRCRAFT))
      .first())!;
    const ad = adSchema.parse(JSON.parse(doc.payload));
    const taskUuid = crypto.randomUUID();
    const typed = adSchema.parse({
      ...ad,
      reason: "MARK-reason",
      source: { ...ad.source, sourceNotes: "MARK-sourceNotes" },
      sourceHistory: [
        { at: 1, source: { ...ad.source, sourceNotes: "MARK-oldNotes" } },
      ],
      tasks: [
        {
          uuid: taskUuid,
          description: "MARK-task",
          dueDate: "",
          dueHours: null,
          dueCycles: null,
          intervalDays: null,
          intervalHours: 100,
          intervalCycles: null,
          recurrence: "Recurring",
          workOrderUuid: "",
        },
      ],
      history: [
        {
          uuid: crypto.randomUUID(),
          taskUuid,
          date: "2026-01-01",
          hours: 10,
          cycles: null,
          method: "MARK-method",
          serviceBulletin: "MARK-serviceBulletin",
          terminatedBy: "MARK-terminatedBy",
          workOrderUuid: "",
          mechanic: "MARK-mechanic",
          certificate: "MARK-certificate",
          evidence: "MARK-evidence",
          recordedAt: 1,
          recordedBy: "MARK-recordedBy",
        },
      ],
    });
    await ctx.db.patch(doc._id, { payload: JSON.stringify(typed) });
    const report = (await ctx.db
      .query("discrepancies")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", OWNED_AIRCRAFT))
      .first())!;
    await ctx.db.patch(report._id, {
      status: "open",
      deferral: {
        type: "mel",
        melItem: "MARK-melItem",
        category: "C",
        placard: "MARK-placard",
        deferredOn: "2026-11-01",
        deferredAt: 1,
        deferredBy: "MARK-deferredBy",
        deferredByName: "MARK-deferredByName",
        expiresOn: "2026-11-11",
      },
    });
  });
  return world;
}

it("passes the board no text typed on ADs and deferrals, only what decides status", async () => {
  const world = await seedTypedText();
  const view = (await world.board.query(api.operations.snapshot, {}))!;
  expect(JSON.stringify(view).match(/MARK-[A-Za-z]+/g) ?? []).toEqual([]);
  const ad = view.airworthiness!.find((r) => r.history.length)!;
  // A terminating action stops the recurrence, so its presence passes.
  expect(ad.history[0]).toMatchObject({
    date: "2026-01-01",
    hours: 10,
    terminatedBy: BOARD_TERMINATED,
  });
  expect(ad.tasks[0]).toMatchObject({ intervalHours: 100, description: "" });
  const deferred = view.discrepancies.find((d) => d.deferral)!;
  expect(deferred.deferral).toMatchObject({
    type: "mel",
    category: "C",
    deferredOn: "2026-11-01",
    expiresOn: "2026-11-11",
    melItem: "",
    placard: "",
  });
  // The program administrator still reads every value.
  const admin = await world.manager.query(api.operations.snapshot, {});
  expect(JSON.stringify(admin)).toContain("MARK-terminatedBy");
});
