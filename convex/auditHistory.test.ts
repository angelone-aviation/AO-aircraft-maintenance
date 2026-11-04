/**
 * Responsibility: Pins History paging: newest first without duplicates, the
 *   snapshot's program and aircraft scoping, refusals that reveal nothing,
 *   cursors, and the per-request scan budget.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/auditHistory, convex/programContext, src/data/demo,
 *   src/domain/auditHistory.
 */
import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import { AUDIT_LIMIT } from "./programContext";
import type { AuditFilter, AuditPage } from "../src/domain/auditHistory";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const component = (
  uuid: string,
  programUuid: string,
  aircraftUuid: string,
) => ({
  kind: "component",
  uuid,
  version: 1,
  programUuid,
  aircraftUuid,
  componentType: "Pump",
  partNumber: "P",
  serial: uuid,
  manufacturer: "",
  notes: "",
  trackTime: true,
  trackCycles: true,
  trackCalendar: true,
  installed: true,
  installedDate: "2026-01-01",
  installedSeconds: 0,
  installedCycles: 0,
  timeSinceNew: 0,
  timeSinceOverhaul: null,
  timeSinceRepair: null,
  cyclesSinceNew: 0,
  serviceDaysBase: 0,
});
async function fixture() {
  const t = convexTest(schema, modules);
  const s = demoSnapshot();
  const [a, b] = s.aircraft;
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("programs", s.programs![0]);
    await ctx.db.insert("programs", {
      ...s.programs![0],
      uuid: "foreign",
      name: "Foreign",
    });
    for (const plane of s.aircraft) await ctx.db.insert("aircraft", plane);
    await ctx.db.insert("aircraft", {
      ...a,
      uuid: "foreign-plane",
      registration: "N999FX",
      programUuid: "foreign",
    });
    const user = async (
      programUuid: string,
      aircraftIds: string[],
      programAdmin = false,
    ) => {
      const group = await ctx.db.insert("groups", {
        programUuid,
        programAdmin,
        name: "G",
        aircraftIds,
        permissions: ["read"],
      });
      const id = await ctx.db.insert("users", {
        name: "U",
        active: true,
        isAdmin: false,
        groupIds: [group],
      });
      const session = await ctx.db.insert("authSessions", {
        userId: id,
        expirationTime: Date.now() + 86400000,
      });
      return `${id}|${session}`;
    };
    // The records whose own History the tests page through.
    for (const [uuid, aircraftUuid, programUuid] of [
      ["wo-a", a.uuid, "demo-program"],
      ["wo-b", b.uuid, "demo-program"],
      ["foreign-wo", "foreign-plane", "foreign"],
    ])
      await ctx.db.insert("management", {
        uuid,
        kind: "component",
        programUuid,
        aircraftUuid,
        payload: JSON.stringify(component(uuid, programUuid, aircraftUuid)),
      });
    let at = 0;
    const log = (fields: {
      entityUuid: string;
      aircraftUuid?: string;
      programUuid?: string;
    }) =>
      ctx.db.insert("audit", {
        ...fields,
        uuid: crypto.randomUUID(),
        actorId: "actor",
        action: "test",
        at: ++at,
      });
    // Legacy aircraft entries carry no program column.
    for (let i = 0; i < AUDIT_LIMIT + 50; i++) {
      await log({ entityUuid: "wo-a", aircraftUuid: a.uuid });
      if (i % 10 === 0) await log({ entityUuid: "wo-b", aircraftUuid: b.uuid });
      if (i % 30 === 0)
        await log({ entityUuid: "demo-program", programUuid: "demo-program" });
      if (i % 30 === 0)
        await log({
          entityUuid: "foreign-wo",
          aircraftUuid: "foreign-plane",
          programUuid: "foreign",
        });
    }
    return {
      manager: await user("demo-program", [], true),
      restricted: await user("demo-program", [a.uuid]),
      outsider: await user("foreign", []),
    };
  });
  return { t, ids, a, b };
}
type Client = ReturnType<
  Awaited<ReturnType<typeof fixture>>["t"]["withIdentity"]
>;
async function all(
  client: Client,
  filter: { entityUuid?: string; aircraftUuid?: string } = {},
  programUuid = "demo-program",
) {
  const entries = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 50; pages++) {
    const result: AuditPage = await client.query(api.auditHistory.page, {
      ...filter,
      programUuid,
      cursor,
      numItems: 40,
    });
    entries.push(...result.page);
    if (result.isDone) return entries;
    cursor = result.continueCursor;
  }
  throw new Error("History did not finish paging.");
}
it("pages the whole program history newest first without duplicates or other programs", async () => {
  const { t, ids } = await fixture();
  const entries = await all(t.withIdentity({ subject: ids.manager }));
  const ats = entries.map((e) => e.at);
  expect(ats).toEqual([...ats].sort((x, y) => y - x));
  expect(new Set(entries.map((e) => e.uuid)).size).toBe(entries.length);
  expect(entries).toHaveLength(AUDIT_LIMIT + 50 + 30 + 10);
  expect(entries.some((e) => e.entityUuid === "foreign-wo")).toBe(false);
  expect(entries[0]).not.toHaveProperty("_id");
});
it("applies the snapshot's aircraft scoping and loads a record's full history by entity", async () => {
  const { t, ids, a, b } = await fixture();
  const restricted = t.withIdentity({ subject: ids.restricted });
  const visible = await all(restricted);
  expect(visible.some((e) => e.aircraftUuid === b.uuid)).toBe(false);
  expect(visible).toHaveLength(AUDIT_LIMIT + 50 + 10);
  // Records the scope does not list (an inspection) page when the caller can
  // see the record's newest entry.
  await t.run(async (ctx) => {
    for (const [entityUuid, aircraftUuid] of [
      ["inspection-a", a.uuid],
      ["inspection-b", b.uuid],
    ])
      await ctx.db.insert("audit", {
        uuid: crypto.randomUUID(),
        entityUuid,
        aircraftUuid,
        actorId: "actor",
        action: "inspection.completed",
        at: 1,
      });
  });
  expect(await all(restricted, { entityUuid: "inspection-a" })).toHaveLength(1);
  await expect(all(restricted, { entityUuid: "inspection-b" })).rejects.toThrow(
    "History not found",
  );
  // A record or aircraft outside the caller's scope is refused before paging.
  await expect(all(restricted, { entityUuid: "wo-b" })).rejects.toThrow(
    "History not found",
  );
  await expect(all(restricted, { aircraftUuid: b.uuid })).rejects.toThrow(
    "History not found",
  );
  // Beyond the snapshot's capped list.
  const record = await all(restricted, { entityUuid: "wo-a" });
  expect(record).toHaveLength(AUDIT_LIMIT + 50);
  expect(record.every((e) => e.aircraftUuid === a.uuid)).toBe(true);
});
it("isolates Flight Programs and requires an active session", async () => {
  const { t, ids } = await fixture();
  const outsider = t.withIdentity({ subject: ids.outsider });
  await expect(all(outsider)).rejects.toThrow("Program changed");
  expect((await all(outsider, {}, "foreign")).map((e) => e.entityUuid)).toEqual(
    Array(10).fill("foreign-wo"),
  );
  await expect(
    all(outsider, { entityUuid: "wo-a" }, "foreign"),
  ).rejects.toThrow("History not found");
  await expect(all(t)).rejects.toThrow("active account");
});
it("refuses another program's record or aircraft with the same answer as an unknown id, and returns no cursor", async () => {
  const { t, ids, a } = await fixture();
  const outsider = t.withIdentity({ subject: ids.outsider });
  const page = (filter: { entityUuid?: string; aircraftUuid?: string }) =>
    outsider.query(api.auditHistory.page, {
      ...filter,
      programUuid: "foreign",
      cursor: null,
      numItems: 5,
    });
  const refusals = [];
  for (const filter of [
    { entityUuid: "wo-a" },
    { aircraftUuid: a.uuid },
    { entityUuid: "no-such-record" },
    { aircraftUuid: "no-such-aircraft" },
  ])
    refusals.push(
      await page(filter).then(
        () => "answered",
        (e: Error) => e.message.split("\n").find((l) => /History/.test(l)),
      ),
    );
  expect(new Set(refusals)).toEqual(new Set([refusals[0]]));
  expect(refusals[0]).toMatch(/History not found\./);
  // The caller's own record still pages.
  expect((await page({ entityUuid: "foreign-wo" })).page).toHaveLength(5);
});
it("builds cursors only from entries the caller can see", async () => {
  const { t, ids, a, b } = await fixture();
  const restricted = t.withIdentity({ subject: ids.restricted });
  // A run of program rows about a record nobody here can see (a user).
  await t.run(async (ctx) => {
    for (let i = 0; i < 30; i++)
      await ctx.db.insert("audit", {
        uuid: crypto.randomUUID(),
        programUuid: "demo-program",
        entityUuid: "some-user",
        actorId: "actor",
        action: "user.permissions_changed",
        at: 10_000 + i,
      });
  });
  const rows = await t.run((ctx) => ctx.db.query("audit").collect());
  const visible = rows
    .filter((d) => d.aircraftUuid === a.uuid || d.entityUuid === "demo-program")
    .map((d) => d._creationTime);
  expect(rows.some((d) => d.aircraftUuid === b.uuid)).toBe(true);
  let cursor: string | null = null;
  const seen = [];
  for (let pages = 0; pages < 100; pages++) {
    const result: AuditPage = await restricted.query(api.auditHistory.page, {
      programUuid: "demo-program",
      cursor,
      numItems: 7,
    });
    seen.push(...result.page);
    // Hidden rows never shorten a page or position a cursor.
    if (!result.isDone) expect(result.page).toHaveLength(7);
    expect(visible).toContain(Number(result.continueCursor));
    if (result.isDone) break;
    cursor = result.continueCursor;
  }
  expect(seen).toHaveLength(visible.length);
});

it("ends a history exactly one page long as done, and combines filters", async () => {
  const { t, ids, a } = await fixture();
  const manager = t.withIdentity({ subject: ids.manager });
  const page = (filter: AuditFilter, numItems: number) =>
    manager.query(api.auditHistory.page, {
      ...filter,
      programUuid: "demo-program",
      cursor: null,
      numItems,
    });
  // wo-b has (AUDIT_LIMIT + 50) / 10 entries.
  const record = await page({ entityUuid: "wo-b" }, 30);
  expect(record).toMatchObject({ isDone: true });
  expect(record.page).toHaveLength(30);
  // wo-b's entries are all on the other aircraft.
  expect(
    await page({ entityUuid: "wo-b", aircraftUuid: a.uuid }, 30),
  ).toMatchObject({ page: [], isDone: true });
});

it("refuses a cursor that is not a number", async () => {
  const { t, ids } = await fixture();
  await expect(
    t.withIdentity({ subject: ids.manager }).query(api.auditHistory.page, {
      programUuid: "demo-program",
      cursor: "next",
      numItems: 5,
    }),
  ).rejects.toThrow("Invalid history cursor.");
});

it("returns a short page after scanning 4,000 entries, then carries on", async () => {
  const { t, ids } = await fixture();
  const restricted = t.withIdentity({ subject: ids.restricted });
  // Each round re-reads the same 7 visible aircraft rows beside 7 hidden
  // program rows, so 2,100 hidden rows outlast the budget.
  await t.run(async (ctx) => {
    for (let i = 0; i < 2100; i++)
      await ctx.db.insert("audit", {
        uuid: crypto.randomUUID(),
        programUuid: "demo-program",
        entityUuid: "some-user",
        actorId: "actor",
        action: "user.permissions_changed",
        at: 10_000 + i,
      });
  });
  const request = { programUuid: "demo-program", numItems: 7 };
  const first = await restricted.query(api.auditHistory.page, {
    ...request,
    cursor: null,
  });
  expect(first).toMatchObject({ page: [], isDone: false });
  // Characterizes current behaviour: this cursor is a hidden row's time.
  const hidden = await t.run((ctx) =>
    ctx.db
      .query("audit")
      .filter((q) => q.eq(q.field("entityUuid"), "some-user"))
      .collect(),
  );
  expect(hidden.map((d) => String(d._creationTime))).toContain(
    first.continueCursor,
  );
  const next = await restricted.query(api.auditHistory.page, {
    ...request,
    cursor: first.continueCursor,
  });
  expect(next.page).toHaveLength(7);
});
