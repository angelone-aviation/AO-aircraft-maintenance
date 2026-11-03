import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import { aircraftInputSchema } from "../src/domain/fleet";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    for (const uuid of ["A", "B"]) {
      await ctx.db.insert("programs", {
        ...demoSnapshot().programs![0],
        uuid,
        name: uuid,
        email: `${uuid}@example.test`,
      });
      await ctx.db.insert("aircraft", {
        ...demoSnapshot().aircraft[0],
        uuid: `plane-${uuid}`,
        registration: uuid,
        programUuid: uuid,
        program: uuid,
      });
      await ctx.db.insert("management", {
        uuid: `location-${uuid}`,
        kind: "location",
        programUuid: uuid,
        payload: JSON.stringify({
          uuid: `location-${uuid}`,
          version: 0,
          kind: "location",
          programUuid: uuid,
          name: `Hangar ${uuid}`,
          address: "",
          contact: "",
        }),
      });
      await ctx.db.insert("discrepancies", {
        uuid: `report-${uuid}`,
        aircraftUuid: `plane-${uuid}`,
        description: `Secret ${uuid}`,
        status: "open",
        authorId: "test",
        createdAt: Date.now(),
      });
    }
    await ctx.db.insert("aircraft", {
      ...demoSnapshot().aircraft[0],
      uuid: "unassigned",
      registration: "UN",
      programUuid: undefined,
    });
    const gA = await ctx.db.insert("groups", {
      name: "A managers",
      programUuid: "A",
      programAdmin: true,
      aircraftIds: [],
      permissions: ["read"],
    });
    const gB = await ctx.db.insert("groups", {
      name: "B readers",
      programUuid: "B",
      aircraftIds: [],
      permissions: ["read"],
    });
    const users: Record<string, string> = {};
    const sessions: Record<string, string> = {};
    for (const [name, groupIds, isAdmin] of [
      ["system", [], true],
      ["multi", [gA, gB], false],
      ["onlyA", [gA], false],
      ["onlyB", [gB], false],
    ] as const) {
      const id = await ctx.db.insert("users", {
        name,
        active: true,
        isAdmin,
        groupIds: [...groupIds],
        activeProgramUuid: name === "onlyB" ? "B" : "A",
      });
      users[name] = id;
      sessions[name] = await ctx.db.insert("authSessions", {
        userId: id,
        expirationTime: Date.now() + 86400000,
      });
    }
    return { users, sessions, gA, gB };
  });
  const client = (name: string) =>
    t.withIdentity({ subject: ids.users[name] + "|" + ids.sessions[name] });
  return {
    t,
    ids,
    system: client("system"),
    multi: client("multi"),
    onlyA: client("onlyA"),
    onlyB: client("onlyB"),
  };
}
const command = (record: unknown) => ({
  requestUuid: crypto.randomUUID(),
  reason: "Test verified",
  action: "record.save",
  record,
});
it("isolates snapshots, pilot directory, stock locations, and unassigned data by program and role", async () => {
  const { onlyA, multi, onlyB } = await setup();
  const a = (await onlyA.query(api.operations.snapshot, {}))!;
  expect(a.aircraft.map((a) => a.uuid)).toEqual(["plane-A"]);
  expect(a.discrepancies.map((d) => d.uuid)).toEqual(["report-A"]);
  expect(a.management?.map((r) => r.uuid)).toEqual(["location-A"]);
  expect(a.programs?.map((p) => p.uuid)).toEqual(["A"]);
  expect(a.members.some((m) => m.name === "onlyB")).toBe(false);
  await expect(
    onlyA.mutation(api.programs.select, { programUuid: "B" }),
  ).rejects.toThrow("denied");
  await multi.mutation(api.programs.select, { programUuid: "B" });
  const b = (await multi.query(api.operations.snapshot, {}))!;
  expect(b.activeProgramUuid).toBe("B");
  expect(b.aircraft.map((a) => a.uuid)).toEqual(["plane-B"]);
  expect(b.management).toEqual([]);
  expect(b.programs?.find((p) => p.uuid === "A")?.email).toBe("");
  expect(
    (await onlyB.query(api.operations.snapshot, {}))?.members.some(
      (m) => m.name === "onlyA",
    ),
  ).toBe(false);
});
it("enforces active program and roles on raw writes, automatic ownership, and stale or forged offline submissions", async () => {
  const { multi, onlyA } = await setup();
  const s = (await multi.query(api.operations.snapshot, {}))!;
  await expect(
    multi.mutation(api.operations.resolveDiscrepancy, {
      programUuid: "A",
      uuid: "report-B",
      resolution: "Fixed",
    }),
  ).rejects.toThrow("permission");
  const plane = aircraftInputSchema.parse({
    ...s.aircraft[0],
    uuid: "new-A",
    registration: "NEW-A",
    programUuid: undefined,
    version: 0,
  });
  await multi.mutation(api.fleet.save, {
    programUuid: "A",
    payload: JSON.stringify({
      action: "aircraft.save",
      requestUuid: crypto.randomUUID(),
      reason: "Verified",
      aircraft: plane,
    }),
  });
  expect(
    (await multi.query(api.operations.snapshot, {}))?.aircraft.find(
      (a) => a.uuid === "new-A",
    )?.programUuid,
  ).toBe("A");
  const foreign = {
    ...plane,
    uuid: "bad",
    registration: "BAD",
    programUuid: "B",
  };
  await expect(
    multi.mutation(api.fleet.save, {
      programUuid: "A",
      payload: JSON.stringify({
        action: "aircraft.save",
        requestUuid: crypto.randomUUID(),
        reason: "Verified",
        aircraft: foreign,
      }),
    }),
  ).rejects.toThrow("transfer");
  const op = {
    kind: "discrepancy" as const,
    uuid: crypto.randomUUID(),
    authorId: s.user.id,
    programUuid: "A",
    aircraftUuid: "plane-A",
    description: "Offline A",
  };
  await multi.mutation(api.programs.select, { programUuid: "B" });
  await expect(
    multi.mutation(api.operations.submit, { operation: op }),
  ).rejects.toThrow("changed");
  await expect(
    multi.mutation(api.operations.submit, {
      operation: { ...op, programUuid: "B" },
    }),
  ).rejects.toThrow("permission");
  await expect(
    multi.mutation(api.operations.resolveDiscrepancy, {
      programUuid: "B",
      uuid: "report-B",
      resolution: "Fixed",
    }),
  ).rejects.toThrow("permission");
  await expect(
    onlyA.mutation(api.admin.saveGroup, {
      name: "Escalate",
      programUuid: "B",
      aircraftIds: [],
      permissions: ["read"],
      programAdmin: true,
    }),
  ).rejects.toThrow("Flight Program changed");
  await multi.mutation(api.programs.select, { programUuid: "A" });
  await multi.mutation(api.operations.submit, { operation: op });
  await multi.mutation(api.operations.submit, { operation: op });
  expect(
    (await multi.query(api.operations.snapshot, {}))?.discrepancies.filter(
      (d) => d.uuid === op.uuid,
    ),
  ).toHaveLength(1);
});
it("enforces ownership on management records and supports explicit system-only transfers with dependent records", async () => {
  const { system, onlyA } = await setup();
  const location = {
    kind: "location",
    uuid: "location-B",
    version: 0,
    name: "Hijack",
    address: "",
    contact: "",
  };
  await expect(
    onlyA.mutation(api.management.execute, {
      programUuid: "A",
      payload: JSON.stringify(command(location)),
    }),
  ).rejects.toThrow("another Flight Program");
  const stock = {
    kind: "stock",
    uuid: "stock",
    version: 0,
    partNumber: "P",
    description: "Part",
    alternates: "",
    category: "part",
    condition: "new",
    locationUuid: "location-B",
    quantity: 0,
    minimum: 1,
  };
  await expect(
    onlyA.mutation(api.management.execute, {
      programUuid: "A",
      payload: JSON.stringify(command(stock)),
    }),
  ).rejects.toThrow("Storage location");
  await onlyA.mutation(api.management.execute, {
    programUuid: "A",
    payload: JSON.stringify(command({ ...stock, locationUuid: "location-A" })),
  });
  await expect(
    onlyA.mutation(api.programs.transfer, {
      programUuid: "A",
      kind: "aircraft",
      uuid: "plane-A",
      destination: "B",
      reason: "Move base",
    }),
  ).rejects.toThrow("System administrator");
  await system.mutation(api.programs.transfer, {
    programUuid: "A",
    kind: "location",
    uuid: "location-A",
    destination: "B",
    reason: "Move stores",
  });
  await system.mutation(api.programs.transfer, {
    programUuid: "A",
    kind: "aircraft",
    uuid: "plane-A",
    destination: "B",
    reason: "Move base",
  });
  expect((await onlyA.query(api.operations.snapshot, {}))?.aircraft).toEqual(
    [],
  );
  expect((await onlyA.query(api.operations.snapshot, {}))?.management).toEqual(
    [],
  );
  await system.mutation(api.programs.select, { programUuid: "B" });
  const b = (await system.query(api.operations.snapshot, {}))!;
  expect(b.aircraft.map((a) => a.uuid)).toContain("plane-A");
  expect(b.discrepancies.map((d) => d.uuid)).toContain("report-A");
  expect(b.management?.find((r) => r.uuid === "stock")?.programUuid).toBe("B");
  expect(b.audit.some((e) => e.action === "program.transferred")).toBe(true);
  await system.mutation(api.programs.select, { programUuid: "" });
  expect(
    (await system.query(api.operations.snapshot, {}))?.aircraft.map(
      (a) => a.uuid,
    ),
  ).toEqual(["unassigned"]);
  await system.mutation(api.programs.transfer, {
    kind: "aircraft",
    uuid: "unassigned",
    destination: "A",
    reason: "Assign verified owner",
  });
  expect((await system.query(api.operations.snapshot, {}))?.aircraft).toEqual(
    [],
  );
});
it("revocation blocks cached writes and group aircraft cannot cross programs", async () => {
  const { t, system, multi, ids } = await setup();
  await expect(
    system.mutation(api.admin.saveGroup, {
      name: "Mixed",
      programUuid: "A",
      aircraftIds: ["plane-B"],
      permissions: ["read"],
    }),
  ).rejects.toThrow("must belong");
  await t.run(async (ctx) => {
    const id = ctx.db.normalizeId("users", ids.users.multi)!;
    await ctx.db.patch(id, { groupIds: [ids.gB] });
  });
  await expect(
    multi.mutation(api.fleet.save, { programUuid: "A", payload: "{}" }),
  ).rejects.toThrow("changed");
  expect(
    (await multi.query(api.operations.snapshot, {}))?.aircraft.map(
      (a) => a.uuid,
    ),
  ).toEqual(["plane-B"]);
});
it("transfers stored component ownership with requirements and history, while blocking cross-program installation", async () => {
  const { system, onlyA, t } = await setup();
  const component = {
    kind: "component",
    uuid: "component-A",
    version: 0,
    aircraftUuid: "",
    componentType: "Pump",
    partNumber: "P",
    serial: "SER",
    manufacturer: "",
    notes: "",
    trackTime: true,
    trackCycles: true,
    trackCalendar: true,
    installed: false,
    partsLocation: "Shelf A",
    installedSeconds: 0,
    installedCycles: 0,
    timeSinceNew: 3600,
    timeSinceOverhaul: null,
    timeSinceRepair: null,
    cyclesSinceNew: 2,
    serviceDaysBase: 10,
  };
  await onlyA.mutation(api.management.execute, {
    programUuid: "A",
    payload: JSON.stringify(command(component)),
  });
  await expect(
    onlyA.mutation(api.management.execute, {
      programUuid: "A",
      payload: JSON.stringify({
        action: "component.service",
        uuid: component.uuid,
        version: 1,
        requestUuid: crypto.randomUUID(),
        reason: "Install",
        operation: "install",
        date: new Date().toISOString().slice(0, 10),
        aircraftUuid: "plane-B",
        installPosition: "MAIN",
      }),
    }),
  ).rejects.toThrow("through a work order");
  const requirement = {
    kind: "componentRequirement",
    uuid: "limit-A",
    version: 0,
    componentUuid: component.uuid,
    aircraftUuid: "",
    requirementType: "Life Limits",
    description: "Pump life",
    notes: "",
    intervalSeconds: 36000,
    timeBasis: "TSN",
    timeLimitMode: "ABSOLUTE",
    cycleLimitMode: "ABSOLUTE",
    calendarIntervalUnit: "MONTHS",
    warningSeconds: 0,
    warningCycles: 0,
    warningCalendarMonths: 1,
  };
  await onlyA.mutation(api.management.execute, {
    programUuid: "A",
    payload: JSON.stringify(command(requirement)),
  });
  await system.mutation(api.programs.transfer, {
    programUuid: "A",
    kind: "component",
    uuid: component.uuid,
    destination: "B",
    reason: "New base",
  });
  expect(
    (await onlyA.query(api.operations.snapshot, {}))?.management?.some(
      (r) => r.uuid === component.uuid,
    ),
  ).toBe(false);
  await system.mutation(api.programs.select, { programUuid: "B" });
  const s = (await system.query(api.operations.snapshot, {}))!;
  expect(s.management?.find((r) => r.uuid === component.uuid)).toMatchObject({
    programUuid: "B",
    aircraftUuid: "",
    timeSinceNew: 3600,
    cyclesSinceNew: 2,
  });
  expect(s.management?.find((r) => r.uuid === requirement.uuid)).toMatchObject({
    programUuid: "B",
    dueSeconds: 36000,
  });
  expect(
    s.audit.some(
      (e) =>
        e.entityUuid === component.uuid && e.action === "program.transferred",
    ),
  ).toBe(true);
  // A read-only program member must not receive stock values through audit history.
  const bReader = await t.run(async (ctx) => {
    const group = await ctx.db
      .query("groups")
      .filter((q) => q.eq(q.field("name"), "B readers"))
      .first();
    const user = await ctx.db.insert("users", {
      name: "Reader",
      active: true,
      groupIds: [group!._id],
    });
    const session = await ctx.db.insert("authSessions", {
      userId: user,
      expirationTime: Date.now() + 86400000,
    });
    await ctx.db.insert("audit", {
      uuid: crypto.randomUUID(),
      programUuid: "B",
      actorId: "test",
      at: Date.now(),
      action: "stock.created",
      entityUuid: "hidden-stock",
      after: JSON.stringify({ quantity: 999 }),
    });
    return `${user}|${session}`;
  });
  expect(
    (
      await t
        .withIdentity({ subject: bReader })
        .query(api.operations.snapshot, {})
    )?.audit.some((e) => e.entityUuid === "hidden-stock"),
  ).toBe(false);
});
it("moves aircraft component history without exposing transferred history through a former aircraft", async () => {
  const { t, system, onlyA } = await setup();
  await t.run(async (ctx) => {
    await ctx.db.insert("aircraft", {
      ...demoSnapshot().aircraft[0],
      uuid: "former-A",
      registration: "FORMER",
      programUuid: "A",
    });
    const c = {
      kind: "component" as const,
      uuid: "installed-component",
      version: 1,
      programUuid: "A",
      aircraftUuid: "plane-A",
      componentType: "Pump",
      partNumber: "P",
      serial: "S",
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
    };
    const m = {
      kind: "componentMovement" as const,
      uuid: "old-movement",
      version: 1,
      programUuid: "A",
      componentUuid: c.uuid,
      aircraftUuid: "former-A",
      action: "REMOVE",
      date: "2026-01-01",
      timeSinceNew: 0,
      timeSinceOverhaul: null,
      timeSinceRepair: null,
      cycles: 0,
      serviceDays: 0,
      note: "Old installation",
      actorId: "test",
      at: 1,
    };
    for (const r of [c, m])
      await ctx.db.insert("management", {
        uuid: r.uuid,
        kind: r.kind,
        programUuid: "A",
        aircraftUuid: r.aircraftUuid,
        payload: JSON.stringify(r),
      });
    await ctx.db.insert("audit", {
      uuid: "old-audit",
      programUuid: "A",
      aircraftUuid: "former-A",
      entityUuid: c.uuid,
      actorId: "test",
      action: "component.removed",
      at: 1,
      after: JSON.stringify(c),
    });
  });
  await system.mutation(api.programs.transfer, {
    programUuid: "A",
    kind: "aircraft",
    uuid: "plane-A",
    destination: "B",
    reason: "Aircraft base transfer",
  });
  // The row is left as written. Program A keeps it only as part of its own
  // aircraft "former-A"'s history; the component itself has left program A.
  const a = (await onlyA.query(api.operations.snapshot, {}))!;
  expect(a.management?.some((r) => r.uuid === "installed-component")).toBe(
    false,
  );
  expect(a.audit.find((e) => e.uuid === "old-audit")).toMatchObject({
    programUuid: "A",
    aircraftUuid: "former-A",
  });
  await system.mutation(api.programs.select, { programUuid: "B" });
  const b = (await system.query(api.operations.snapshot, {}))!;
  expect(b.management?.some((r) => r.uuid === "old-movement")).toBe(true);
  // Program B reaches it through the transfer listing, not its own indexes.
  expect(b.audit.some((e) => e.uuid === "old-audit")).toBe(true);
  const feed = await system.query(api.auditHistory.page, {
    programUuid: "B",
    cursor: null,
    numItems: 100,
  });
  expect(feed.page.some((e) => e.uuid === "old-audit")).toBe(true);
  expect(
    (
      await system.query(api.auditHistory.page, {
        programUuid: "B",
        entityUuid: "installed-component",
        cursor: null,
        numItems: 10,
      })
    ).page.map((e) => e.uuid),
  ).toEqual(["old-audit"]);
});
it("aircraft transfers move aircraft checklists and setups, leave unrelated rows alone, and wait for open parts requests", async () => {
  const { t, system } = await setup();
  const { emptyChecklist } = await import("../src/domain/checklists");
  const { partsRequestSchema, requestDraftSchema } =
    await import("../src/domain/partsRequests");
  const request = partsRequestSchema.parse({
    ...requestDraftSchema.parse({
      uuid: "request-A",
      version: 0,
      source: { kind: "inspection", uuid: "inspection-A" },
      mode: "parts",
      date: "2026-01-01",
      engineer: "Tech",
      priority: "P1 AOG",
      requiredBy: "",
      vendor: "Vendor",
      currency: "USD",
      shipTo: "Hangar",
      lines: [
        { uuid: "line", partNumber: "P1", description: "Part", quantity: 1 },
      ],
    }),
    version: 1,
    programUuid: "A",
    aircraftUuid: "plane-A",
    sourceLabel: "Inspection",
    aircraftRegistration: "A",
    aircraftSerial: "S",
    aircraftModel: "M",
    number: "PR-00001",
    requesterId: "test",
    createdAt: 1,
    updatedAt: 1,
    cancelled: false,
    reservations: [],
    issues: [],
    history: [],
  });
  const checklist = {
    uuid: crypto.randomUUID(),
    version: 1,
    programUuid: "A",
    aircraftUuid: "plane-A",
    document: emptyChecklist(),
    sourceName: "a.fmd",
    updatedAt: 0,
    updatedBy: "test",
  };
  const componentSetup = {
    uuid: "setup-A",
    programUuid: "A",
    aircraftUuid: "plane-A",
    templateUuid: "template",
    templateName: "Template",
    row: { id: "row" },
  };
  const ids = await t.run(async (ctx) => {
    const requestId = await ctx.db.insert("partsRequests", {
      uuid: request.uuid,
      programUuid: "A",
      payload: JSON.stringify(request),
    });
    const checklistId = await ctx.db.insert("checklists", {
      uuid: checklist.uuid,
      programUuid: "A",
      aircraftUuid: "plane-A",
      payload: JSON.stringify(checklist),
    });
    const setupId = await ctx.db.insert("componentSetups", {
      uuid: componentSetup.uuid,
      programUuid: "A",
      aircraftUuid: "plane-A",
      payload: JSON.stringify(componentSetup),
    });
    const otherInspection = await ctx.db.insert("inspections", {
      uuid: "inspection-B",
      programUuid: "B",
      aircraftUuid: "plane-B",
      reference: "B",
      description: "Unrelated",
      version: 3,
    });
    return { requestId, checklistId, setupId, otherInspection };
  });
  const transfer = () =>
    system.mutation(api.programs.transfer, {
      programUuid: "A",
      kind: "aircraft",
      uuid: "plane-A",
      destination: "B",
      reason: "Move base",
    });
  await expect(transfer()).rejects.toThrow(/open parts requests/);
  await t.run((ctx) =>
    ctx.db.patch(ids.requestId, {
      payload: JSON.stringify({ ...request, cancelled: true }),
    }),
  );
  await transfer();
  const after = await t.run(async (ctx) => ({
    checklist: await ctx.db.get(ids.checklistId),
    setup: await ctx.db.get(ids.setupId),
    inspection: await ctx.db.get(ids.otherInspection),
  }));
  expect(after.checklist?.programUuid).toBe("B");
  expect(JSON.parse(after.checklist!.payload).programUuid).toBe("B");
  expect(after.setup?.programUuid).toBe("B");
  expect(JSON.parse(after.setup!.payload).programUuid).toBe("B");
  expect(after.inspection?.version).toBe(3);
});
it("scoped loaders keep another program's job cards and audit out of view and refuse uuid takeovers", async () => {
  const { t, system, onlyA } = await setup();
  const { taskCardCommand } = await import("../tests/fixtures/taskCards");
  // Program B owns a job card.
  await system.mutation(api.programs.select, { programUuid: "B" });
  const card = taskCardCommand();
  card.fields.aircraftUuid = "plane-B";
  await system.mutation(api.taskCards.save, {
    payload: JSON.stringify(card),
    programUuid: "B",
  });
  // A program-A member sees neither the card nor its audit trail.
  const a = (await onlyA.query(api.operations.snapshot, {}))!;
  expect(a.taskCards?.some((c) => c.uuid === card.uuid)).toBe(false);
  expect(a.audit.some((e) => e.entityUuid === card.uuid)).toBe(false);
  // Reusing B's uuid from program A is rejected instead of overwriting it.
  await system.mutation(api.programs.select, { programUuid: "A" });
  const takeover = {
    ...card,
    fields: { ...card.fields, aircraftUuid: "plane-A" },
  };
  await expect(
    system.mutation(api.taskCards.save, {
      payload: JSON.stringify(takeover),
      programUuid: "A",
    }),
  ).rejects.toThrow();
  const stored = await t.run((ctx) =>
    ctx.db
      .query("taskCards")
      .withIndex("uuid", (q) => q.eq("uuid", card.uuid))
      .collect(),
  );
  expect(stored).toHaveLength(1);
  expect(stored[0].aircraftUuid).toBe("plane-B");
});
it("transfers append one entry, leave existing change-log rows byte-identical, and History follows each record's current owner", async () => {
  const { t, system, onlyA, onlyB } = await setup();
  const rows = [
    // A work order on the moving aircraft, written while program A owned it.
    {
      uuid: "wo-row",
      programUuid: "A",
      aircraftUuid: "plane-A",
      entityUuid: "wo-1",
    },
    // A legacy aircraft row without a program column.
    { uuid: "legacy-row", aircraftUuid: "plane-A", entityUuid: "flight-1" },
    // A record that no longer exists, still attached to the moving aircraft.
    {
      uuid: "deleted-row",
      programUuid: "A",
      aircraftUuid: "plane-A",
      entityUuid: "deleted-record",
    },
    // No record and no aircraft: visible to nobody, before or after.
    { uuid: "orphan-row", programUuid: "A", entityUuid: "deleted-orphan" },
    // Program A's own location stays with program A.
    { uuid: "location-row", programUuid: "A", entityUuid: "location-A" },
  ];
  const ours = (uuids: string[]) =>
    uuids.filter((u) => rows.some((r) => r.uuid === u));
  await t.run(async (ctx) => {
    let at = 0;
    for (const row of rows)
      await ctx.db.insert("audit", {
        ...row,
        actorId: "test",
        action: "test.saved",
        at: ++at,
        before: JSON.stringify({ n: at }),
        after: JSON.stringify({ n: at + 1 }),
      });
  });
  const history = async (
    client: typeof onlyA,
    programUuid: string,
    filter: { aircraftUuid?: string; entityUuid?: string } = {},
  ) => {
    const result = await client.query(api.auditHistory.page, {
      programUuid,
      ...filter,
      cursor: null,
      numItems: 100,
    });
    expect(result.isDone).toBe(true);
    return result.page;
  };
  const uuids = async (...args: Parameters<typeof history>) =>
    ours((await history(...args)).map((e) => e.uuid));
  const before = await t.run((ctx) => ctx.db.query("audit").collect());
  expect(await uuids(onlyA, "A")).toEqual([
    "location-row",
    "deleted-row",
    "legacy-row",
    "wo-row",
  ]);
  expect(await uuids(onlyB, "B")).toEqual([]);
  await system.mutation(api.programs.transfer, {
    programUuid: "A",
    kind: "aircraft",
    uuid: "plane-A",
    destination: "B",
    reason: "Aircraft base transfer",
  });
  const after = await t.run((ctx) => ctx.db.query("audit").collect());
  // Every existing row is unchanged, byte for byte; exactly one is appended.
  for (const row of before)
    expect(JSON.stringify(after.find((d) => d._id === row._id))).toBe(
      JSON.stringify(row),
    );
  const added = after.filter((d) => !before.some((b) => b._id === d._id));
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({
    action: "program.transferred",
    entityUuid: "plane-A",
    aircraftUuid: "plane-A",
    programUuid: "B",
    reason: "Aircraft base transfer",
  });
  // The receiving program sees the aircraft's history; the sender no longer does.
  const moved = ["deleted-row", "legacy-row", "wo-row"];
  expect(await uuids(onlyB, "B")).toEqual(moved);
  expect(await uuids(onlyB, "B", { aircraftUuid: "plane-A" })).toEqual(moved);
  expect(
    ours(
      (await onlyB.query(api.operations.snapshot, {}))!.audit.map(
        (e) => e.uuid,
      ),
    ),
  ).toEqual(moved);
  expect(
    (await history(onlyB, "B", { entityUuid: "plane-A" })).map((e) => e.action),
  ).toContain("program.transferred");
  expect(await uuids(onlyA, "A")).toEqual(["location-row"]);
  expect(
    ours(
      (await onlyA.query(api.operations.snapshot, {}))!.audit.map(
        (e) => e.uuid,
      ),
    ),
  ).toEqual(["location-row"]);
  await expect(
    history(onlyA, "A", { aircraftUuid: "plane-A" }),
  ).rejects.toThrow("History not found");
  await expect(history(onlyA, "A", { entityUuid: "plane-A" })).rejects.toThrow(
    "History not found",
  );
});
it("location transfers wait for reserved stock and open purchase-order lines delivering there (#48)", async () => {
  const { t, system } = await setup();
  const { partsRequestSchema, requestDraftSchema } =
    await import("../src/domain/partsRequests");
  const { poDraftSchema, poSchema } =
    await import("../src/domain/purchaseOrders");
  const stock = (reservedQuantity: number) => ({
    kind: "stock",
    uuid: "stock-A",
    version: 1,
    programUuid: "A",
    locationUuid: "location-A",
    partNumber: "FILTER-1",
    description: "Oil filter",
    alternates: "",
    category: "part",
    condition: "new",
    quantity: 5,
    reservedQuantity,
    minimum: 0,
  });
  const request = partsRequestSchema.parse({
    ...requestDraftSchema.parse({
      uuid: "request-A",
      version: 0,
      source: { kind: "stock", uuid: "stock-A" },
      mode: "parts",
      date: "2026-11-03",
      engineer: "Tech",
      priority: "P2 Routine",
      requiredBy: "",
      vendor: "",
      currency: "USD",
      lines: [
        {
          uuid: "line",
          partNumber: "FILTER-1",
          description: "Filter",
          quantity: 3,
        },
      ],
    }),
    version: 1,
    programUuid: "A",
    aircraftUuid: "",
    sourceLabel: "Stock",
    aircraftRegistration: "",
    aircraftSerial: "",
    aircraftModel: "",
    number: "PR-00001",
    requesterId: "test",
    createdAt: 1,
    updatedAt: 1,
    cancelled: false,
    reservations: [{ lineUuid: "line", stockUuid: "stock-A", quantity: 3 }],
    issues: [],
    history: [],
  });
  const order = poSchema.parse({
    ...poDraftSchema.parse({
      uuid: "po-A",
      version: 1,
      vendor: "Vendor",
      vendorContact: "",
      shipTo: "Hangar A",
      expectedDate: "",
      currency: "USD",
      shippingCents: 0,
      notes: "",
      lines: [
        {
          uuid: "po-line",
          stockUuid: "stock-A",
          locationUuid: "location-A",
          partNumber: "FILTER-1",
          description: "Filter",
          quantity: 2,
          unitCents: 100,
          kind: "part",
        },
      ],
    }),
    programUuid: "A",
    number: "PO-00001",
    phase: "issued",
    revision: 0,
    createdAt: 1,
    updatedAt: 1,
    shipments: [],
    receipts: [],
    history: [],
  });
  const ids = await t.run(async (ctx) => ({
    stock: await ctx.db.insert("management", {
      uuid: "stock-A",
      kind: "stock",
      programUuid: "A",
      payload: JSON.stringify(stock(3)),
    }),
    request: await ctx.db.insert("partsRequests", {
      uuid: request.uuid,
      programUuid: "A",
      payload: JSON.stringify(request),
    }),
    order: await ctx.db.insert("purchaseOrders", {
      uuid: order.uuid,
      programUuid: "A",
      payload: JSON.stringify(order),
    }),
  }));
  const transfer = () =>
    system.mutation(api.programs.transfer, {
      programUuid: "A",
      kind: "location",
      uuid: "location-A",
      destination: "B",
      reason: "Base consolidation",
    });
  await expect(transfer()).rejects.toThrow(
    "Release reserved stock (FILTER-1 for PR-00001) and receive or cancel open purchase order lines (FILTER-1 on PO-00001) before transferring this location.",
  );
  await t.run(async (ctx) => {
    await ctx.db.patch(ids.stock, { payload: JSON.stringify(stock(0)) });
    await ctx.db.patch(ids.request, {
      payload: JSON.stringify({ ...request, reservations: [] }),
    });
  });
  await expect(transfer()).rejects.toThrow(
    "Receive or cancel open purchase order lines (FILTER-1 on PO-00001) before transferring this location.",
  );
  const stored = async () =>
    JSON.parse((await t.run((ctx) => ctx.db.get(ids.stock)))!.payload);
  expect((await stored()).programUuid).toBe("A");
  await t.run((ctx) =>
    ctx.db.patch(ids.order, {
      payload: JSON.stringify({ ...order, phase: "closed" }),
    }),
  );
  await transfer();
  expect(await stored()).toMatchObject({
    programUuid: "B",
    reservedQuantity: 0,
  });
});
