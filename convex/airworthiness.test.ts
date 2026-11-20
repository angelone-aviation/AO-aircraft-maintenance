/**
 * Responsibility: Pins AD records: atomic saves, maintenance access, version
 *   checks, compliance and its correction, an AD uuid another Flight Program
 *   holds, the change-log rows an import writes, that keeping a stale draft
 *   never puts back a due point a later compliance moved, and the work order
 *   an entry names.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/airworthiness, convex/operations, convex/workOrders,
 *   src/data/demo, src/domain/airworthiness, src/domain/recordMerge,
 *   src/domain/keepMineRules, tests/fixtures/workOrders.
 */
import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import {
  adAuditRecord,
  adSchema,
  blankAD,
  blankADTask,
  type AD,
} from "../src/domain/airworthiness";
import { mergeKeepMine } from "../src/domain/recordMerge";
import { AD_KEEP_MINE } from "../src/domain/keepMineRules";
import { workOrderCommand } from "../tests/fixtures/workOrders";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
it("persists AD records atomically and enforces maintenance access and version checks", async () => {
  const t = convexTest(schema, modules),
    s = demoSnapshot();
  const identities = await t.run(async (ctx) => {
    for (const a of s.aircraft) await ctx.db.insert("aircraft", a);
    await ctx.db.insert("programs", s.programs![0]);
    async function user(maintenance: boolean) {
      const group = await ctx.db.insert("groups", {
        programUuid: "demo-program",
        name: "AD testers",
        aircraftIds: [s.aircraft[0].uuid],
        permissions: maintenance ? ["read", "maintenance"] : ["read"],
      });
      const id = await ctx.db.insert("users", {
        active: true,
        isAdmin: false,
        name: "Tester",
        groupIds: [group],
        activeProgramUuid: "demo-program",
      });
      const session = await ctx.db.insert("authSessions", {
        userId: id,
        expirationTime: Date.now() + 86400000,
      });
      return { subject: `${id}|${session}` };
    }
    return { editor: await user(true), reader: await user(false) };
  });
  const editor = t.withIdentity(identities.editor),
    reader = t.withIdentity(identities.reader);
  const r = blankAD(s.aircraft[0].uuid);
  r.source.number = "2026-01-01";
  r.source.subject = "Inspect";
  const args = {
    programUuid: "demo-program",
    payload: JSON.stringify({ kind: "save", record: r }),
  };
  await expect(reader.mutation(api.airworthiness.save, args)).rejects.toThrow(
    "permission",
  );
  await editor.mutation(api.airworthiness.save, args);
  await expect(editor.mutation(api.airworthiness.save, args)).rejects.toThrow(
    "changed",
  );
  const docs = await t.run((ctx) => ctx.db.query("airworthiness").collect());
  expect(docs).toHaveLength(1);
  expect(JSON.parse(docs[0].payload).version).toBe(1);
  // Due-limit edits are recorded with the values before and after.
  const saved = JSON.parse(docs[0].payload);
  saved.applicability = "Applicable";
  saved.reviewRequired = false;
  saved.tasks = [
    {
      ...blankADTask(),
      description: "Inspect fittings",
      recurrence: "One-time",
      dueHours: 2300,
    },
  ];
  await editor.mutation(api.airworthiness.save, {
    programUuid: "demo-program",
    payload: JSON.stringify({ kind: "save", record: saved }),
  });
  const applicable = JSON.parse(
    (await t.run((ctx) => ctx.db.query("airworthiness").first()))!.payload,
  );
  applicable.tasks[0].dueHours = 3000;
  // Changing a decided AD is a correction and needs a reason (issue #21).
  await expect(
    editor.mutation(api.airworthiness.save, {
      programUuid: "demo-program",
      payload: JSON.stringify({ kind: "save", record: applicable }),
    }),
  ).rejects.toThrow("reason");
  await editor.mutation(api.airworthiness.save, {
    programUuid: "demo-program",
    payload: JSON.stringify({
      kind: "save",
      record: applicable,
      reason: "Due hours corrected from paragraph (g)",
    }),
  });
  const audits = (await t.run((ctx) => ctx.db.query("audit").collect())).filter(
    (a) => a.action === "ad.save",
  );
  expect(audits).toHaveLength(3);
  expect(audits[0].before).toBeUndefined();
  expect(JSON.parse(audits[0].after!)).toMatchObject({
    uuid: r.uuid,
    source: { number: "2026-01-01" },
    version: 1,
  });
  expect(JSON.parse(audits[2].before!)).toMatchObject({
    version: 2,
    applicability: "Applicable",
    tasks: [{ dueHours: 2300 }],
  });
  expect(JSON.parse(audits[2].after!)).toMatchObject({
    version: 3,
    tasks: [{ dueHours: 3000 }],
  });
  expect(audits[1].reason).toBeUndefined();
  expect(audits[2].reason).toBe("Due hours corrected from paragraph (g)");
  await expect(
    reader.mutation(api.faa.command, {
      programUuid: "demo-program",
      payload: JSON.stringify({
        kind: "configure",
        aircraftUuid: r.aircraftUuid,
        enabled: true,
        terms: ["441"],
      }),
    }),
  ).rejects.toThrow("permission");
  await editor.mutation(api.faa.command, {
    programUuid: "demo-program",
    payload: JSON.stringify({
      kind: "configure",
      aircraftUuid: r.aircraftUuid,
      enabled: true,
      terms: ["441"],
    }),
  });
  expect(
    await t.run((ctx) => ctx.db.query("faaMonitors").collect()),
  ).toHaveLength(1);
});

it("lets maintenance record AD compliance but only a Flight Program administrator correct it", async () => {
  const t = convexTest(schema, modules),
    s = demoSnapshot();
  const identities = await t.run(async (ctx) => {
    for (const a of s.aircraft) await ctx.db.insert("aircraft", a);
    await ctx.db.insert("programs", s.programs![0]);
    async function user(programAdmin: boolean) {
      const group = await ctx.db.insert("groups", {
        programUuid: "demo-program",
        name: programAdmin ? "Administrators" : "Maintenance",
        programAdmin,
        aircraftIds: [],
        permissions: programAdmin ? ["read"] : ["read", "maintenance"],
      });
      const id = await ctx.db.insert("users", {
        active: true,
        isAdmin: false,
        name: programAdmin ? "Program admin" : "Mechanic",
        groupIds: [group],
        activeProgramUuid: "demo-program",
      });
      const session = await ctx.db.insert("authSessions", {
        userId: id,
        expirationTime: Date.now() + 86400000,
      });
      return { subject: `${id}|${session}` };
    }
    return { mechanic: await user(false), admin: await user(true) };
  });
  const mechanic = t.withIdentity(identities.mechanic),
    admin = t.withIdentity(identities.admin);
  const send = (as: typeof admin, command: object) =>
    as.mutation(api.airworthiness.save, {
      programUuid: "demo-program",
      payload: JSON.stringify(command),
    });
  const stored = async () =>
    adSchema.parse(
      JSON.parse(
        (await t.run((ctx) => ctx.db.query("airworthiness").first()))!.payload,
      ),
    );
  const r = blankAD(s.aircraft[0].uuid);
  r.source.number = "2026-07-07";
  r.source.subject = "Inspect fittings";
  r.applicability = "Applicable";
  r.reviewRequired = false;
  r.tasks = [
    {
      ...blankADTask(),
      description: "Inspect fittings",
      recurrence: "Recurring",
      intervalHours: 100,
      dueHours: 2400,
    },
  ];
  await send(mechanic, { kind: "save", record: r });
  const original = {
    uuid: crypto.randomUUID(),
    taskUuid: r.tasks[0].uuid,
    date: "2026-01-02",
    hours: 2340,
    cycles: null,
    method: "Inspected per paragraph (g)",
    serviceBulletin: "",
    terminatedBy: "",
    workOrderUuid: "",
    mechanic: "Mechanic",
    certificate: "A&P 123",
    evidence: "Logbook page 4",
    recordedAt: 0,
    recordedBy: "",
  };
  // Recording new compliance keeps maintenance permission.
  await send(mechanic, {
    kind: "comply",
    uuid: r.uuid,
    version: 1,
    entry: original,
  });
  expect((await stored()).tasks[0].dueHours).toBe(2440);
  const correction = {
    kind: "correct",
    uuid: r.uuid,
    version: 2,
    corrects: original.uuid,
    reason: "Hours copied from the wrong logbook page",
    entry: { ...original, uuid: crypto.randomUUID(), hours: 2330 },
  };
  await expect(send(mechanic, correction)).rejects.toThrow(
    "Flight Program administrator",
  );
  await expect(send(admin, { ...correction, reason: " " })).rejects.toThrow();
  expect((await stored()).history).toHaveLength(1);
  await send(admin, correction);
  const corrected = await stored();
  expect(corrected.history).toHaveLength(2);
  expect(corrected.history[0]).toMatchObject({
    uuid: original.uuid,
    hours: 2340,
  });
  expect(corrected.history[1]).toMatchObject({
    corrects: original.uuid,
    correctionReason: "Hours copied from the wrong logbook page",
    hours: 2330,
  });
  expect(corrected.tasks[0].dueHours).toBe(2430);
  const [entry] = (
    await t.run((ctx) => ctx.db.query("audit").collect())
  ).filter((a) => a.action === "ad.correct");
  expect(entry.reason).toBe("Hours copied from the wrong logbook page");
  expect(JSON.parse(entry.before!)).toMatchObject({
    tasks: [{ dueHours: 2440 }],
    complianceEntries: 1,
  });
  expect(JSON.parse(entry.after!)).toMatchObject({
    tasks: [{ dueHours: 2430 }],
    complianceEntries: 2,
    latestCompliance: { corrects: original.uuid, hours: 2330 },
  });
});

it("refuses an AD uuid another Flight Program holds, and writes nothing", async () => {
  const t = convexTest(schema, modules),
    s = demoSnapshot();
  const r = blankAD(s.aircraft[0].uuid);
  r.source.number = "2026-01-01";
  r.source.subject = "Inspect";
  const subject = await t.run(async (ctx) => {
    for (const a of s.aircraft) await ctx.db.insert("aircraft", a);
    await ctx.db.insert("programs", s.programs![0]);
    await ctx.db.insert("airworthiness", {
      uuid: r.uuid,
      aircraftUuid: "other-aircraft",
      programUuid: "other",
      payload: "{}",
    });
    const id = await ctx.db.insert("users", {
      active: true,
      isAdmin: true,
      name: "Administrator",
      groupIds: [],
      activeProgramUuid: "demo-program",
    });
    const session = await ctx.db.insert("authSessions", {
      userId: id,
      expirationTime: Date.now() + 86400000,
    });
    return `${id}|${session}`;
  });
  const stored = () =>
    t.run(async (ctx) => ({
      ads: await ctx.db.query("airworthiness").collect(),
      audit: await ctx.db.query("audit").collect(),
    }));
  const before = await stored();
  await expect(
    t.withIdentity({ subject }).mutation(api.airworthiness.save, {
      programUuid: "demo-program",
      payload: JSON.stringify({ kind: "save", record: r }),
    }),
  ).rejects.toThrow("Record belongs to another Flight Program.");
  expect(await stored()).toEqual(before);
});

it("writes one ad.import row per changed AD, in the order of the entries", async () => {
  const t = convexTest(schema, modules),
    s = demoSnapshot();
  const aircraftUuid = s.aircraft[0].uuid;
  const subject = await administrator(t, s);
  const source = (number: string, subject = "Inspect") => ({
    ...blankAD(aircraftUuid).source,
    number,
    subject,
  });
  const importADs = (...sources: ReturnType<typeof source>[]) =>
    t.withIdentity({ subject }).mutation(api.airworthiness.save, {
      programUuid: "demo-program",
      payload: JSON.stringify({
        kind: "import",
        aircraftUuid,
        entries: sources.map((s) => ({ source: s, componentUuid: "" })),
      }),
    });
  const stored = () =>
    t.run(async (ctx) => ({
      ads: (await ctx.db.query("airworthiness").collect()).map((d) =>
        adSchema.parse(JSON.parse(d.payload)),
      ),
      rows: (await ctx.db.query("audit").collect()).map((a) => ({
        action: a.action,
        entityUuid: a.entityUuid,
        programUuid: a.programUuid,
        aircraftUuid: a.aircraftUuid,
        reason: a.reason,
        before: a.before && JSON.parse(a.before),
        after: a.after && JSON.parse(a.after),
      })),
    }));
  const row = (after: AD, before?: AD) => ({
    action: "ad.import",
    entityUuid: after.uuid,
    programUuid: "demo-program",
    aircraftUuid,
    reason: undefined,
    before: before && adAuditRecord(before),
    after: adAuditRecord(after),
  });
  const byNumber = (ads: AD[], number: string) =>
    ads.find((r) => r.source.number === number)!;

  await expect(
    importADs(source("2026-02-02"), source("2026-01-01")),
  ).resolves.toBe(2);
  const first = await stored();
  const [later, earlier] = ["2026-02-02", "2026-01-01"].map((n) =>
    byNumber(first.ads, n),
  );
  expect(first.rows).toEqual([row(later), row(earlier)]);

  await expect(
    importADs(source("2026-02-02"), source("2026-01-01", "Inspect again")),
  ).resolves.toBe(1);
  const second = await stored();
  expect(second.rows).toEqual([
    ...first.rows,
    row(byNumber(second.ads, "2026-01-01"), earlier),
  ]);
});

it("applies an AD command once per request id: a replay returns nothing and writes nothing", async () => {
  const t = convexTest(schema, modules),
    s = demoSnapshot();
  const editor = t.withIdentity({ subject: await administrator(t, s) });
  const r = blankAD(s.aircraft[0].uuid);
  r.source.number = "2026-01-01";
  r.source.subject = "Inspect";
  const requestUuid = crypto.randomUUID();
  const args = (subject: string) => ({
    programUuid: "demo-program",
    payload: JSON.stringify({
      kind: "save",
      record: { ...r, source: { ...r.source, subject } },
      requestUuid,
    }),
  });
  const stored = () =>
    t.run(async (ctx) => ({
      ads: await ctx.db.query("airworthiness").collect(),
      audit: await ctx.db.query("audit").collect(),
      commandRequests: await ctx.db.query("commandRequests").collect(),
    }));

  await expect(
    editor.mutation(api.airworthiness.save, args("Inspect")),
  ).resolves.toBe(1);
  const saved = await stored();
  expect(saved.ads).toHaveLength(1);
  expect(saved.commandRequests).toMatchObject([
    { uuid: requestUuid, payload: args("Inspect").payload },
  ]);
  // Without the id this retry would be refused as stale ("AD changed.").
  // ADR-0003: a replay succeeds with no payload.
  await expect(
    editor.mutation(api.airworthiness.save, args("Inspect")),
  ).resolves.toBeNull();
  expect(await stored()).toEqual(saved);
  await expect(
    editor.mutation(api.airworthiness.save, args("Inspect again")),
  ).rejects.toMatchObject({ data: "Request identifier already used." });
  expect(await stored()).toEqual(saved);
});

it("keeps a later compliance's next due when a stale AD draft is kept", async () => {
  const t = convexTest(schema, modules),
    s = demoSnapshot();
  const editor = t.withIdentity({ subject: await administrator(t, s) });
  const send = (command: object) =>
    editor.mutation(api.airworthiness.save, {
      programUuid: "demo-program",
      payload: JSON.stringify(command),
    });
  const stored = async (): Promise<AD> =>
    JSON.parse(
      (await t.run((ctx) => ctx.db.query("airworthiness").first()))!.payload,
    );
  await send({ kind: "save", record: trackedAD(s.aircraft[0].uuid) });
  const loaded = await stored();
  await send({
    kind: "comply",
    uuid: loaded.uuid,
    version: loaded.version,
    entry: complianceAt(loaded.tasks[0].uuid, 2340),
  });
  const complied = await stored();
  expect(complied.tasks[0].dueHours).toBe(2440);
  const mine = structuredClone(loaded);
  mine.source.subject = "Inspect wing attachment fittings";
  const reason = "Subject wording corrected.";

  // The whole stale draft, re-sent at the current version, is refused.
  const stale = { ...mine, version: complied.version };
  await expect(
    send({ kind: "save", record: stale, reason }),
  ).rejects.toMatchObject({
    data: expect.stringMatching(
      /^Compliance was recorded on required action 1/,
    ),
  });
  expect(await stored()).toEqual(complied);

  // Keep mine sends only the subject over the current record.
  const merge = mergeKeepMine(
    { base: loaded, mine, theirs: complied },
    { rules: AD_KEEP_MINE },
  );
  await send({
    kind: "save",
    record: { ...merge.merged!, version: complied.version },
    reason,
  });
  const kept = await stored();
  expect(kept.source.subject).toBe("Inspect wing attachment fittings");
  expect(kept.tasks[0].dueHours).toBe(2440);
  expect(kept.history).toEqual(complied.history);
});

function trackedAD(aircraftUuid: string): AD {
  const record = blankAD(aircraftUuid);
  record.source.number = "2026-01-01";
  record.source.subject = "Inspect attachment fittings";
  record.applicability = "Applicable";
  record.reviewRequired = false;
  record.tasks = [
    {
      ...blankADTask(),
      description: "Inspect fittings per paragraph (g)",
      recurrence: "Recurring",
      dueHours: 2300,
      intervalHours: 100,
    },
  ];
  return record;
}

function complianceAt(taskUuid: string, hours: number) {
  return {
    uuid: crypto.randomUUID(),
    taskUuid,
    date: "2026-01-02",
    hours,
    cycles: null,
    method: "Inspected fittings; no defects",
    serviceBulletin: "",
    terminatedBy: "",
    workOrderUuid: "",
    mechanic: "A. Mechanic",
    certificate: "",
    evidence: "",
    recordedAt: 0,
    recordedBy: "",
  };
}

// Stores the demo aircraft and program, and signs in a system administrator
// working in that program.
async function administrator(
  t: ReturnType<typeof convexTest>,
  s: ReturnType<typeof demoSnapshot>,
) {
  return t.run(async (ctx) => {
    for (const a of s.aircraft) await ctx.db.insert("aircraft", a);
    await ctx.db.insert("programs", s.programs![0]);
    const id = await ctx.db.insert("users", {
      active: true,
      isAdmin: true,
      name: "Administrator",
      groupIds: [],
      activeProgramUuid: "demo-program",
    });
    const session = await ctx.db.insert("authSessions", {
      userId: id,
      expirationTime: Date.now() + 86400000,
    });
    return `${id}|${session}`;
  });
}

// The save reads the work order an entry names by its uuid (ADR-0013).
it("accepts compliance under a work order of the AD's aircraft, and refuses one of another aircraft", async () => {
  const t = convexTest(schema, modules),
    s = demoSnapshot();
  const as = t.withIdentity({ subject: await administrator(t, s) });
  const send = (to: "workOrders" | "airworthiness", command: object) =>
    as.mutation(
      to === "workOrders" ? api.workOrders.save : api.airworthiness.save,
      { programUuid: "demo-program", payload: JSON.stringify(command) },
    );
  const onFirst = workOrderCommand();
  const onSecond = workOrderCommand();
  onSecond.fields.aircraftUuid = s.aircraft[1].uuid;
  await send("workOrders", onFirst);
  await send("workOrders", onSecond);
  const ad = trackedAD(s.aircraft[0].uuid);
  await send("airworthiness", { kind: "save", record: ad });
  const comply = (workOrderUuid: string, version: number) =>
    send("airworthiness", {
      kind: "comply",
      uuid: ad.uuid,
      version,
      entry: { ...complianceAt(ad.tasks[0].uuid, 2300), workOrderUuid },
    });
  await expect(comply(onSecond.uuid, 1)).rejects.toThrow(
    "Select an appropriate work order for this aircraft.",
  );
  await comply(onFirst.uuid, 1);
});
