/**
 * Responsibility: Pins inventory and inspection commands end to end: stock
 *   moves, components and their requirements, inspections, permissions,
 *   idempotency, and the refusals users see.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/management.ts, convex/schema.ts, src/domain/management,
 *   src/domain/aircraftSetup, tests/fixtures/componentMovement,
 *   src/data/demo.ts (fixture).
 */
import { movementOrderCommand } from "../tests/fixtures/componentMovement";
import type { ManagementCommand } from "../src/domain/management";
import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import {
  inspectionSetupHeaders,
  parseInspectionSetupCsv,
  planAircraftSetup,
} from "../src/domain/aircraftSetup";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const a = demoSnapshot().aircraft[0];
    await ctx.db.insert("aircraft", a);
    await ctx.db.insert("programs", demoSnapshot().programs![0]);
    const group = await ctx.db.insert("groups", {
      programUuid: "demo-program",
      name: "Maintenance",
      aircraftIds: [a.uuid],
      permissions: ["read", "maintenance"],
    });
    const admin = await ctx.db.insert("users", {
      name: "Admin",
      active: true,
      isAdmin: true,
      groupIds: [],
    });
    const tech = await ctx.db.insert("users", {
      name: "Tech",
      active: true,
      isAdmin: false,
      groupIds: [group],
    });
    const session = await ctx.db.insert("authSessions", {
      userId: admin,
      expirationTime: Date.now() + 86400000,
    });
    const techSession = await ctx.db.insert("authSessions", {
      userId: tech,
      expirationTime: Date.now() + 86400000,
    });
    return { admin, tech, session, techSession, a };
  });
  return {
    t,
    ids,
    admin: t.withIdentity({ subject: ids.admin + "|" + ids.session }),
    tech: t.withIdentity({ subject: ids.tech + "|" + ids.techSession }),
  };
}
const common = () => ({
  requestUuid: crypto.randomUUID(),
  reason: "Verified in workshop",
});
it("applies stock receipt exactly once and hides shared stock from nonadministrators", async () => {
  const { t, admin, tech } = await fixture();
  await admin.mutation(api.management.execute, {
    programUuid: "demo-program",
    payload: JSON.stringify({
      ...common(),
      action: "record.save",
      record: {
        kind: "location",
        uuid: "L",
        version: 0,
        name: "Store",
        address: "",
        contact: "",
      },
    }),
  });
  await admin.mutation(api.management.execute, {
    programUuid: "demo-program",
    payload: JSON.stringify({
      ...common(),
      action: "record.save",
      record: {
        kind: "stock",
        uuid: "S",
        version: 0,
        partNumber: "P",
        description: "Part",
        alternates: "",
        category: "part",
        condition: "new",
        locationUuid: "L",
        quantity: 0,
        minimum: 1,
      },
    }),
  });
  const payload = JSON.stringify({
    ...common(),
    action: "stock.move",
    uuid: "S",
    version: 1,
    operation: "receive",
    quantity: 4,
  });
  await admin.mutation(api.management.execute, {
    programUuid: "demo-program",
    payload,
  });
  await admin.mutation(api.management.execute, {
    programUuid: "demo-program",
    payload,
  });
  const state = await admin.query(api.operations.snapshot);
  expect(state?.management?.find((r) => r.kind === "stock")).toMatchObject({
    quantity: 4,
    version: 2,
  });
  expect(
    state?.audit.filter((a) => a.action === "stock.move.receive"),
  ).toHaveLength(1);
  expect((await tech.query(api.operations.snapshot))?.management).toEqual([]);
  await expect(
    tech.mutation(api.management.execute, {
      programUuid: "demo-program",
      payload: JSON.stringify({
        ...common(),
        action: "stock.move",
        uuid: "S",
        version: 2,
        operation: "issue",
        quantity: 1,
      }),
    }),
  ).rejects.toThrow("Permission");
  await expect(
    t.mutation(api.management.execute, {
      programUuid: "demo-program",
      payload,
    }),
  ).rejects.toThrow("active account");
});
it("grants aircraft-scoped maintenance and retains completion history", async () => {
  const { admin, tech, ids } = await fixture();
  await tech.mutation(api.management.execute, {
    programUuid: "demo-program",
    payload: JSON.stringify({
      ...common(),
      action: "inspection.save",
      record: {
        uuid: "I",
        version: 0,
        aircraftUuid: ids.a.uuid,
        reference: "Annual",
        description: "Annual inspection",
        materials: "Filter",
        archived: false,
        intervalMonths: 12,
        lastDate: "2025-01-01",
      },
    }),
  });
  const payload = JSON.stringify({
    ...common(),
    action: "inspection.complete",
    uuid: "I",
    version: 1,
    date: "2026-01-12",
    seconds: ids.a.currentHobbs,
    cycles: ids.a.cycles,
  });
  await tech.mutation(api.management.execute, {
    programUuid: "demo-program",
    payload,
  });
  await tech.mutation(api.management.execute, {
    programUuid: "demo-program",
    payload,
  });
  const state = await admin.query(api.operations.snapshot);
  expect(state?.inspections[0]).toMatchObject({
    version: 2,
    dueDate: "2027-01-31",
  });
  expect(
    state?.audit.filter((a) => a.action === "inspection.complete"),
  ).toHaveLength(1);
  await expect(
    tech.mutation(api.management.execute, {
      programUuid: "demo-program",
      payload: JSON.stringify({
        ...common(),
        action: "inspection.save",
        record: {
          uuid: "other",
          version: 0,
          aircraftUuid: "unassigned",
          reference: "Test",
          description: "Test",
          materials: "",
          archived: false,
          dueCycles: 10,
        },
      }),
    }),
  ).rejects.toThrow("Permission");
});

it("persists, updates and clears ATA chapters, and rejects unsupported chapters", async () => {
  const { tech, ids } = await fixture();
  const records = [
    {
      action: "inspection.save",
      record: {
        uuid: "ata-inspection",
        version: 0,
        aircraftUuid: ids.a.uuid,
        reference: "ATA check",
        description: "Check",
        materials: "",
        archived: false,
        dueCycles: 100,
      },
    },
    {
      action: "record.save",
      record: {
        kind: "component",
        componentType: "Engine",
        manufacturer: "",
        notes: "",
        trackTime: true,
        trackCycles: true,
        trackCalendar: true,
        timeSinceRepair: null,
        serviceDaysBase: 0,
        uuid: "ata-component",
        version: 0,
        aircraftUuid: ids.a.uuid,

        partNumber: "ATA-P",
        serial: "ATA-S",

        installed: false,
        partsLocation: "Shelf A",
        installedSeconds: 0,
        installedCycles: 0,
        timeSinceNew: 0,
        timeSinceOverhaul: 0,
        cyclesSinceNew: 0,
      },
    },
  ];
  for (const entry of records) {
    for (const ataChapter of ["17", "43", "85", "5", ""]) {
      await expect(
        tech.mutation(api.management.execute, {
          programUuid: "demo-program",
          payload: JSON.stringify({
            ...common(),
            ...entry,
            record: { ...entry.record, ataChapter },
          }),
        }),
      ).rejects.toThrow();
    }
    for (const [version, ataChapter] of ["00", "84", undefined].entries()) {
      await tech.mutation(api.management.execute, {
        programUuid: "demo-program",
        payload: JSON.stringify({
          ...common(),
          ...entry,
          record: { ...entry.record, version, ataChapter },
        }),
      });
      const snapshot = await tech.query(api.operations.snapshot);
      const saved =
        entry.action === "inspection.save"
          ? snapshot!.inspections.find((i) => i.uuid === entry.record.uuid)
          : snapshot!.management!.find((r) => r.uuid === entry.record.uuid);
      expect(saved).toMatchObject({ version: version + 1 });
      expect(
        saved && "ataChapter" in saved ? saved.ataChapter : undefined,
      ).toBe(ataChapter);
    }
  }
});

it("stores component movements and transfers linked requirements and inspections atomically", async () => {
  const { t, admin, tech, ids } = await fixture();
  const today = new Date().toISOString().slice(0, 10);
  const b = { ...ids.a, uuid: "aircraft-b", registration: "TEST-B" };
  await t.run((ctx) => ctx.db.insert("aircraft", b));
  const execute = (command: unknown) =>
    admin.mutation(api.management.execute, {
      programUuid: "demo-program",
      payload: JSON.stringify(command),
    });
  await execute({
    ...common(),
    action: "record.save",
    record: {
      kind: "component",
      uuid: "tracked",
      version: 0,
      aircraftUuid: ids.a.uuid,
      componentType: "Pump",
      notes: "",

      partNumber: "PUMP",
      serial: "S",

      manufacturer: "Example",
      trackTime: true,
      trackCycles: true,
      trackCalendar: true,
      installed: false,
      partsLocation: "Shelf A",
      installedSeconds: 0,
      installedCycles: 0,
      timeSinceNew: 360000,
      timeSinceOverhaul: null,
      timeSinceRepair: null,
      cyclesSinceNew: 100,

      serviceDaysBase: 10,
    },
  });
  await execute({
    ...common(),
    action: "record.save",
    record: {
      kind: "componentRequirement",
      uuid: "requirement",
      version: 0,
      aircraftUuid: ids.a.uuid,
      componentUuid: "tracked",
      requirementType: "Life Limits",
      description: "Life limit",
      notes: "",
      intervalSeconds: 720000,
      timeBasis: "TSN",
      timeLimitMode: "ABSOLUTE",
      cycleLimitMode: "ABSOLUTE",
      calendarIntervalUnit: "MONTHS",
      warningSeconds: 90000,
      warningCycles: 10,
      warningCalendarMonths: 1,
    },
  });
  await execute({
    ...common(),
    action: "inspection.save",
    record: {
      uuid: "linked",
      version: 0,
      aircraftUuid: ids.a.uuid,
      componentUuid: "tracked",
      reference: "Pump inspection",
      description: "Inspect pump",
      materials: "",
      archived: false,
      dueSeconds: 540000,
    },
  });
  const command = {
    ...common(),
    action: "component.service",
    uuid: "tracked",
    version: 1,
    operation: "install",
    date: today,
    aircraftUuid: b.uuid,
    installPosition: "AUX",
  };
  await expect(
    tech.mutation(api.management.execute, {
      programUuid: "demo-program",
      payload: JSON.stringify(command),
    }),
  ).rejects.toThrow("through a work order");
  await expect(execute(command)).rejects.toThrow("through a work order");
  const move = async (
    command: Extract<ManagementCommand, { action: "component.service" }>,
  ) => {
    const snapshot = (await admin.query(api.operations.snapshot))!;
    const order = movementOrderCommand(snapshot, command);
    await admin.mutation(api.workOrders.save, {
      programUuid: "demo-program",
      payload: JSON.stringify({
        ...order,
        fields: { ...order.fields, status: "open", completionDate: "" },
      }),
    });
    await admin.mutation(api.workOrders.save, {
      programUuid: "demo-program",
      payload: JSON.stringify({ ...order, version: 1 }),
    });
  };
  await move({
    ...command,
    action: "component.service",
    operation: "install",
    installPosition: "AUX",
  });
  const state = await admin.query(api.operations.snapshot);
  expect(state?.management?.find((r) => r.uuid === "tracked")).toMatchObject({
    aircraftUuid: b.uuid,
    installed: true,
    installPosition: "AUX",
    version: 2,
  });
  expect(
    state?.management?.find((r) => r.uuid === "requirement"),
  ).toMatchObject({ aircraftUuid: b.uuid, version: 2 });
  expect(state?.inspections.find((i) => i.uuid === "linked")).toMatchObject({
    aircraftUuid: b.uuid,
    version: 2,
  });
  expect(
    state?.management?.filter((r) => r.kind === "componentMovement"),
  ).toHaveLength(1);
  const scoped = await tech.query(api.operations.snapshot);
  expect(
    scoped?.management?.some((r) =>
      ["tracked", "requirement"].includes(r.uuid),
    ),
  ).toBe(false);
  expect(scoped?.inspections.some((i) => i.uuid === "linked")).toBe(false);
  await move({
    ...common(),
    action: "component.service",
    uuid: "tracked",
    version: 2,
    operation: "remove",
    date: today,
    partsLocation: "Bin 9",
  });
  const after = await admin.query(api.operations.snapshot);
  expect(
    after?.management?.filter((r) => r.kind === "componentMovement"),
  ).toHaveLength(2);
  expect(after?.management?.find((r) => r.uuid === "tracked")).toMatchObject({
    installed: false,
    partsLocation: "Bin 9",
    timeSinceOverhaul: null,
    timeSinceRepair: null,
  });
});

it("persists programs and aircraft edits with permissions, references, and idempotency", async () => {
  const { admin, tech, ids } = await fixture();
  const program = {
    uuid: "demo-program",
    version: 1,
    name: "Mission base",
    address: "Main hangar",
    email: "ops@example.test",
    contactName: "Casey",
    website: "https://example.test",
  };
  await expect(
    tech.mutation(api.fleet.save, {
      programUuid: "demo-program",
      payload: JSON.stringify({ ...common(), action: "program.save", program }),
    }),
  ).rejects.toThrow("Administrator");
  await admin.mutation(api.fleet.save, {
    programUuid: "demo-program",
    payload: JSON.stringify({ ...common(), action: "program.save", program }),
  });
  const command = {
    ...common(),
    action: "aircraft.save",
    aircraft: {
      ...ids.a,
      programUuid: "demo-program",
      meter: "tach",
      adjustmentSeconds: ids.a.currentHobbs - ids.a.currentTach,
      operationalStatus: "maintenance",
    },
  };
  const payload = JSON.stringify(command);
  await tech.mutation(api.fleet.save, { programUuid: "demo-program", payload });
  await tech.mutation(api.fleet.save, { programUuid: "demo-program", payload });
  const state = await tech.query(api.operations.snapshot);
  expect(state?.aircraft[0]).toMatchObject({
    version: 1,
    meter: "tach",
    program: "Mission base",
    operationalStatus: "maintenance",
  });
  expect(state?.aircraft[0].counterEvents).toHaveLength(1);
  expect(state?.programs?.[0]).toMatchObject({
    contactName: "Casey",
    address: "Main hangar",
  });
  await expect(
    tech.mutation(api.fleet.save, {
      programUuid: "demo-program",
      payload: JSON.stringify({ ...command, requestUuid: crypto.randomUUID() }),
    }),
  ).rejects.toThrow("changed");
  await admin.mutation(api.fleet.save, {
    programUuid: "demo-program",
    payload: JSON.stringify({
      ...common(),
      action: "program.save",
      program: { ...program, version: 2, name: "Renamed mission base" },
    }),
  });
  expect((await tech.query(api.operations.snapshot))?.aircraft[0].program).toBe(
    "Renamed mission base",
  );
  await expect(
    admin.mutation(api.fleet.save, {
      programUuid: "demo-program",
      payload: JSON.stringify({
        ...common(),
        action: "aircraft.save",
        aircraft: {
          ...command.aircraft,
          uuid: "new-plane",
          version: 0,
          registration: "NEW",
          programUuid: "missing",
        },
      }),
    }),
  ).rejects.toThrow("Program not found");
});

it("returns a client-visible validation error when TSO exceeds TSN without saving a component", async () => {
  const { t, admin, ids } = await fixture();
  const payload = JSON.stringify({
    ...common(),
    action: "record.save",
    initialAircraftSetup: true,
    record: {
      kind: "component",
      uuid: "invalid-tsn",
      version: 0,
      aircraftUuid: ids.a.uuid,
      componentType: "Engine",
      partNumber: "TEST",
      serial: "TEST",
      manufacturer: "Example",
      notes: "",
      trackTime: true,
      trackCycles: false,
      trackCalendar: false,
      installed: true,
      installedDate: "2025-12-01",
      installPosition: "LEFT",
      installedSeconds: ids.a.currentHobbs,
      installedCycles: 0,
      timeSinceNew: 0,
      timeSinceOverhaul: 2605.5 * 3600,
      timeSinceRepair: null,
      cyclesSinceNew: 0,
      serviceDaysBase: 0,
    },
  });
  await expect(
    admin.mutation(api.management.execute, {
      programUuid: "demo-program",
      payload,
    }),
  ).rejects.toMatchObject({
    name: "ConvexError",
    data: expect.stringContaining("since-new"),
  });
  await t.run(async (ctx) => {
    expect(await ctx.db.query("management").collect()).toHaveLength(0);
  });
  const corrected = JSON.parse(payload);
  corrected.record.timeSinceNew = 3000 * 3600;
  await admin.mutation(api.management.execute, {
    programUuid: "demo-program",
    payload: JSON.stringify(corrected),
  });
  await t.run(async (ctx) => {
    const component = await ctx.db
      .query("management")
      .withIndex("uuid", (q) => q.eq("uuid", "invalid-tsn"))
      .unique();
    expect(JSON.parse(component!.payload).timeSinceNew).toBe(3000 * 3600);
  });
});

it("saves and completes recurring inspections while retaining source identity and stripping database metadata", async () => {
  const { t, admin, ids } = await fixture();
  const execute = (command: unknown) =>
    admin.mutation(api.management.execute, {
      programUuid: "demo-program",
      payload: JSON.stringify(command),
    });
  await execute({
    ...common(),
    action: "inspection.save",
    record: {
      uuid: "inspection-runtime",
      version: 0,
      aircraftUuid: ids.a.uuid,
      sourceKey: "template:runtime:recurring",
      reference: "Runtime regression",
      description: "Recurring inspection",
      materials: "",
      archived: false,
      intervalSeconds: 600 * 3600,
      intervalMonths: 24,
      lastSeconds: 2000 * 3600,
      lastDate: "2024-12-25",
    },
  });
  await t.run(async (ctx) => {
    const saved = (await ctx.db.query("inspections").collect())[0];
    expect(saved).toMatchObject({
      version: 1,
      dueSeconds: 2600 * 3600,
      dueDate: "2026-12-31",
      sourceKey: "template:runtime:recurring",
    });
  });
  await execute({
    ...common(),
    action: "inspection.complete",
    uuid: "inspection-runtime",
    version: 1,
    date: "2025-12-25",
    seconds: 2100 * 3600,
    cycles: 100,
  });
  await t.run(async (ctx) => {
    const saved = (await ctx.db.query("inspections").collect())[0];
    expect(saved).toMatchObject({
      version: 2,
      lastSeconds: 2100 * 3600,
      dueSeconds: 2700 * 3600,
      dueDate: "2027-12-31",
      sourceKey: "template:runtime:recurring",
    });
  });
});

it("refuses a second aircraft setup's inspections, not an ordinary save of the same name (NA-11)", async () => {
  const { t, admin, ids } = await fixture();
  const csv = [
    inspectionSetupHeaders.join(","),
    "Annual,,12,,,2026-01-31,,,,91.409(a)",
    "100-hour,100,,,,2026-08-14,2300.5,,,91.409(b)",
  ].join("\n");
  // Each run is planned from the same snapshot, before either has saved.
  const run = () =>
    planAircraftSetup(demoSnapshot(), ids.a.uuid, {
      inspections: parseInspectionSetupCsv(csv),
      ads: [],
    }).actions;
  const send = (command: unknown) =>
    admin.mutation(api.management.execute, {
      programUuid: "demo-program",
      payload: JSON.stringify(command),
    });
  const names = () =>
    t.run(async (ctx) =>
      (await ctx.db.query("inspections").collect())
        .map((i) => i.description)
        .sort(),
    );
  for (const a of run()) await send(a.command);
  for (const a of run())
    await expect(send(a.command)).rejects.toMatchObject({
      data: "An inspection with this name is already on the aircraft.",
    });
  expect(await names()).toEqual(["100-hour", "Annual"]);
  const { initialAircraftSetup: _setup, ...ordinary } = run()[0].command as {
    initialAircraftSetup?: boolean;
  };
  await send(ordinary);
  expect(await names()).toEqual(["100-hour", "Annual", "Annual"]);
});

it("refuses a new record or inspection whose uuid another program uses, as a ConvexError", async () => {
  const { t, admin, ids } = await fixture();
  const execute = (command: unknown) =>
    admin.mutation(api.management.execute, {
      programUuid: "demo-program",
      payload: JSON.stringify({ ...common(), ...(command as object) }),
    });
  const location = {
    action: "record.save",
    record: {
      kind: "location",
      uuid: "taken-location",
      version: 0,
      name: "Store",
      address: "",
      contact: "",
    },
  };
  const inspection = {
    action: "inspection.save",
    record: {
      uuid: "taken-inspection",
      version: 0,
      aircraftUuid: ids.a.uuid,
      reference: "Annual",
      description: "Annual inspection",
      materials: "",
      archived: false,
      intervalMonths: 12,
      lastDate: "2025-01-01",
    },
  };
  await execute(location);
  await execute(inspection);
  await t.run(async (ctx) => {
    for (const row of await ctx.db.query("management").collect())
      await ctx.db.patch(row._id, { programUuid: "other-program" });
    for (const row of await ctx.db.query("inspections").collect())
      await ctx.db.patch(row._id, { aircraftUuid: "other-aircraft" });
  });
  for (const command of [location, inspection])
    await expect(execute(command)).rejects.toMatchObject({
      name: "ConvexError",
      data: "Record belongs to another Flight Program.",
    });
});

it("logs an inspection that follows its component under the aircraft's program", async () => {
  const { t, admin, ids } = await fixture();
  const b = { ...ids.a, uuid: "aircraft-b", registration: "TEST-B" };
  const execute = (command: unknown) =>
    admin.mutation(api.management.execute, {
      programUuid: "demo-program",
      payload: JSON.stringify(command),
    });
  const baseline = {
    installedSeconds: 0,
    installedCycles: 0,
    timeSinceNew: 360000,
    timeSinceOverhaul: null,
    timeSinceRepair: null,
    cyclesSinceNew: 100,
    serviceDaysBase: 10,
  };
  await execute({
    ...common(),
    action: "record.save",
    record: {
      kind: "component",
      uuid: "tracked",
      version: 0,
      aircraftUuid: ids.a.uuid,
      componentType: "Pump",
      notes: "",
      partNumber: "PUMP",
      serial: "S",
      manufacturer: "Example",
      trackTime: true,
      trackCycles: true,
      trackCalendar: true,
      installed: false,
      partsLocation: "Shelf A",
      ...baseline,
    },
  });
  // Damaged data: the component's inspection was left on another aircraft.
  await t.run(async (ctx) => {
    await ctx.db.insert("aircraft", b);
    await ctx.db.insert("inspections", {
      uuid: "linked",
      version: 0,
      aircraftUuid: b.uuid,
      componentUuid: "tracked",
      reference: "Pump inspection",
      description: "Inspect pump",
      materials: "",
      archived: false,
      dueSeconds: 540000,
    });
  });
  await execute({
    ...common(),
    action: "component.baseline",
    uuid: "tracked",
    version: 1,
    reason: "Logbook reconciliation",
    ...baseline,
  });
  const rows = await t.run((ctx) => ctx.db.query("audit").collect());
  expect(rows.map((r) => [r.action, r.entityUuid, r.programUuid])).toEqual([
    ["record.save", "tracked", "demo-program"],
    // Named no program before T12's final round.
    ["inspection.component_transferred", "linked", "demo-program"],
    ["component.baseline", "tracked", "demo-program"],
  ]);
  expect(rows[1].aircraftUuid).toBe(ids.a.uuid);
});
