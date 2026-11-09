/**
 * Responsibility: Pins the weekly summary query: Flight Program
 *   administrators only, the period checks, counts over the visible entries
 *   of the active program only, and the flag set when the scan budget cuts
 *   the period short.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/auditHistory, src/data/demo, src/domain/auditSummary.
 */
import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import { demoSnapshot } from "../src/data/demo";
import type { AuditSummaryResult } from "../src/domain/auditSummary";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const DAY_MS = 86_400_000;
const PROGRAM = "demo-program";
const NOW = Date.now();
const TODAY = new Date(NOW).toISOString().slice(0, 10);
const WEEK = {
  from: new Date(NOW - 6 * DAY_MS).toISOString().slice(0, 10),
  to: TODAY,
};

type Row = {
  action: string;
  daysAgo: number;
  actorId?: string;
  reason?: string;
  aircraftUuid?: string;
  programUuid?: string;
  after?: string;
};

async function fixture(rows: Row[]) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const s = demoSnapshot();
    for (const a of s.aircraft) await ctx.db.insert("aircraft", a);
    await ctx.db.insert("programs", s.programs![0]);
    await ctx.db.insert("programs", {
      ...s.programs![0],
      uuid: "foreign",
      name: "Foreign",
    });
    for (const row of rows) await insertRow(ctx, row);
    const user = async (programUuid: string, programAdmin: boolean) => {
      const group = await ctx.db.insert("groups", {
        programUuid,
        programAdmin,
        name: programAdmin ? "Managers" : "Observers",
        aircraftIds: [],
        permissions: ["read"],
      });
      const id = await ctx.db.insert("users", {
        name: programAdmin ? "Alex" : "Sam",
        active: true,
        isAdmin: false,
        activeProgramUuid: programUuid,
        groupIds: [group],
      });
      const session = await ctx.db.insert("authSessions", {
        userId: id,
        expirationTime: NOW + DAY_MS,
      });
      return `${id}|${session}`;
    };
    return {
      admin: await user(PROGRAM, true),
      reader: await user(PROGRAM, false),
      outsider: await user("foreign", true),
    };
  });
  return {
    admin: t.withIdentity({ subject: ids.admin }),
    reader: t.withIdentity({ subject: ids.reader }),
    outsider: t.withIdentity({ subject: ids.outsider }),
  };
}

function insertRow(ctx: MutationCtx, row: Row) {
  const { daysAgo, ...fields } = row;
  // Program-tagged rows are visible when they concern a visible record or
  // aircraft; the program itself is one such record.
  return ctx.db.insert("audit", {
    uuid: crypto.randomUUID(),
    actorId: "alex",
    entityUuid: row.programUuid ?? PROGRAM,
    programUuid: PROGRAM,
    ...fields,
    at: NOW - daysAgo * DAY_MS,
  });
}

it("summarizes the week for a program administrator: families, actors, notable events and refused sign-ins", async () => {
  const [a] = demoSnapshot().aircraft;
  const { admin } = await fixture([
    { action: "flight.created", daysAgo: 0, aircraftUuid: a.uuid },
    { action: "flight.created", daysAgo: 1, actorId: "sam" },
    {
      action: "flight.dispatch_override",
      daysAgo: 2,
      actorId: "sam",
      reason: "Positioning flight approved by the chief pilot",
    },
    { action: "inspection.completed", daysAgo: 3 },
    { action: "flight.created", daysAgo: 9 },
    {
      action: "user.sign_in_refused",
      daysAgo: 1,
      actorId: "system",
      after: JSON.stringify({ email: "stranger@example.test" }),
    },
    { action: "flight.created", daysAgo: 0, programUuid: "foreign" },
  ]);
  const result: AuditSummaryResult = await admin.query(
    api.auditHistory.summary,
    { programUuid: PROGRAM, ...WEEK },
  );
  expect(result.truncated).toBe(false);
  expect(result.summary.total).toBe(4);
  expect(result.summary.refusedSignIns).toBe(1);
  expect(result.summary.actors.map((x) => [x.actorId, x.total])).toEqual([
    ["alex", 2],
    ["sam", 2],
  ]);
  expect(result.summary.families).toMatchObject({
    flights: 3,
    maintenance: 1,
  });
  expect(result.summary.notable.map((n) => n.kind)).toEqual([
    "dispatch-override",
  ]);
  expect(JSON.stringify(result)).not.toContain("stranger@");
});

it("refuses readers, outsiders and bad periods", async () => {
  const { admin, reader, outsider } = await fixture([
    { action: "flight.created", daysAgo: 0 },
  ]);
  await expect(
    reader.query(api.auditHistory.summary, { programUuid: PROGRAM, ...WEEK }),
  ).rejects.toThrow("Flight Program administrator required.");
  await expect(
    outsider.query(api.auditHistory.summary, {
      programUuid: PROGRAM,
      ...WEEK,
    }),
  ).rejects.toThrow("Flight Program changed.");
  const foreign = await outsider.query(api.auditHistory.summary, {
    programUuid: "foreign",
    ...WEEK,
  });
  expect(foreign.summary.total).toBe(0);
  await expect(
    admin.query(api.auditHistory.summary, {
      programUuid: PROGRAM,
      from: TODAY,
      to: WEEK.from,
    }),
  ).rejects.toThrow("Choose a start date on or before the end date.");
  await expect(
    admin.query(api.auditHistory.summary, {
      programUuid: PROGRAM,
      from: "last week",
      to: TODAY,
    }),
  ).rejects.toThrow("Choose a start and end date.");
});

it("says when the scan budget cut the period short", async () => {
  const rows: Row[] = [];
  // Rows past the 4,000-entry budget, all inside the period.
  for (let i = 0; i < 4100; i++)
    rows.push({ action: "flight.save", daysAgo: 0 });
  const { admin } = await fixture(rows);
  const result = await admin.query(api.auditHistory.summary, {
    programUuid: PROGRAM,
    ...WEEK,
  });
  expect(result.truncated).toBe(true);
  expect(result.summary.total).toBeGreaterThan(0);
  expect(result.summary.total).toBeLessThan(4100);
}, 60_000);
