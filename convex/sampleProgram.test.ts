/**
 * Responsibility: Pins the hosted sample program: who may seed it, the linked
 *   records it creates once with their derived columns, the active program it
 *   selects, and the example documents it attaches once.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/sampleProgram, convex/sampleDocuments,
 *   convex/collections, convex/schema, tests/fixtures/derivedColumns.
 */
import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import { makeFunctionReference } from "convex/server";
import schema from "./schema";
import { decode, type PayloadCollection } from "./collections";
import type { Id } from "./_generated/dataModel";
import {
  expectDerivedColumns,
  expectRecordNumbers,
  expectPurchasingKeys,
  type DerivedTable,
} from "../tests/fixtures/derivedColumns";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const seed = makeFunctionReference<"mutation">("sampleProgram:seed");
const attach = makeFunctionReference<"mutation">("sampleProgram:attach");
// Each decodes through the codec, which throws for a record its schema refuses.
const PAYLOAD_TABLES = [
  "management",
  "taskCards",
  "workOrders",
  "airworthiness",
  "purchaseOrders",
  "checklists",
  "inspectionTemplates",
  "flightPlans",
] as const;
const ADMIN = {
  name: "Admin",
  email: "admin@example.test",
  active: true,
  isAdmin: true,
  groupIds: [],
};
it("creates linked sample records once, without changing real aircraft or administrator membership", async () => {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      name: "Admin",
      email: "admin@example.test",
      active: true,
      isAdmin: true,
      groupIds: [],
      activeProgramUuid: "real-program",
    }),
  );
  const seed = makeFunctionReference<"mutation">("sampleProgram:seed");
  await expect(
    t.mutation(seed, { email: "unknown@example.test" }),
  ).rejects.toThrow();
  await expect(
    t.mutation(seed, { email: "admin@example.test" }),
  ).resolves.toMatchObject({ created: true });
  await expect(
    t.mutation(seed, { email: "admin@example.test" }),
  ).resolves.toMatchObject({ created: false });
  await t.run(async (ctx) => {
    for (const table of [
      "aircraft",
      "flights",
      "inspections",
      "workOrders",
      "taskCards",
      "inspectionTemplates",
      "checklists",
      "discrepancies",
      "airworthiness",
      "purchaseOrders",
    ] as const)
      expect(await ctx.db.query(table).collect()).toHaveLength(4);
    expect(await ctx.db.query("groups").collect()).toHaveLength(10);
    expect(await ctx.db.query("flightPlans").collect()).toHaveLength(8);
    expect(await ctx.db.query("management").collect()).toHaveLength(24);
    expect(await ctx.db.get(userId)).toMatchObject({
      activeProgramUuid: "real-program",
      groupIds: [],
    });
    const aircraft = await ctx.db.query("aircraft").collect();
    for (const f of await ctx.db.query("flights").collect()) {
      const a = aircraft.find((a) => a.uuid === f.aircraftUuid)!;
      // `*Off` is where the flight started and `*On` where it ended
      // (src/domain/model.ts, Flight).
      expect(f.hobbsOff).toBe(a.baselineHobbs);
      expect(f.hobbsOn).toBe(a.currentHobbs);
      expect(f.tachOff).toBe(a.baselineTach);
      expect(f.tachOn).toBe(a.currentTach);
      expect(f.hobbsOn).toBeGreaterThan(f.hobbsOff!);
    }
    const cards = await ctx.db.query("taskCards").collect();
    const orders = await ctx.db.query("workOrders").collect();
    for (const c of cards) {
      const card = JSON.parse(c.payload);
      const wo = JSON.parse(
        orders.find((o) => o.uuid === card.workOrderUuid)!.payload,
      );
      expect(
        wo.tasks.some((t: { uuid: string }) => t.uuid === card.workTaskUuid),
      ).toBe(true);
    }
  });
});

it("refuses anyone but an active administrator, before writing anything", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("users", { ...ADMIN, active: false });
    await ctx.db.insert("users", {
      ...ADMIN,
      email: "member@example.test",
      isAdmin: false,
    });
  });
  for (const email of [ADMIN.email, "member@example.test"])
    await expect(t.mutation(seed, { email })).rejects.toThrow(
      "An active administrator is required.",
    );
  expect(await t.run((ctx) => ctx.db.query("programs").collect())).toEqual([]);
});

it("selects the sample program for an administrator without an active one", async () => {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) => ctx.db.insert("users", ADMIN));
  await expect(t.mutation(seed, { email: ADMIN.email })).resolves.toEqual({
    programUuid: "sample-aviation-program-v1",
    created: true,
  });
  expect(await t.run((ctx) => ctx.db.get(userId))).toMatchObject({
    activeProgramUuid: "sample-aviation-program-v1",
  });
});

// Characterizes current behaviour: the states each sample aircraft shows.
it("seeds records that parse with their schemas, one sample state per aircraft", async () => {
  const t = convexTest(schema, modules);
  await t.run((ctx) => ctx.db.insert("users", ADMIN));
  await t.mutation(seed, { email: ADMIN.email });
  const read = <N extends PayloadCollection>(table: N) =>
    t.run(async (ctx) => decode(table, await ctx.db.query(table).collect()));
  for (const table of PAYLOAD_TABLES) await read(table);
  const orders = await read("purchaseOrders");
  const stock = (await read("management")).flatMap((r) =>
    r.kind === "stock" ? [[r.partNumber, r.quantity, r.cost]] : [],
  );
  const flights = await t.run((ctx) => ctx.db.query("flights").collect());
  expect({
    status: (await read("workOrders")).map((w) => w.status),
    phase: orders.map((po) => po.phase),
    shipped: orders.map((po) => po.shipments.map((s) => s.lines[0].quantity)),
    stock,
    engines: flights.map((f) => (f.oil ?? []).map((o) => o.engine)),
  }).toEqual({
    status: ["open", "parts-delay", "in-progress", "awaiting-approval"],
    phase: ["draft", "issued", "issued", "issued"],
    shipped: [[], [], [2], [4]],
    stock: [
      ["SAMPLE-FILTER", 8, 35],
      ["SAMPLE-TIRE", 0, 180],
      ["SAMPLE-LAMP", 2, 65],
      ["SAMPLE-OIL", 24, 12],
    ],
    engines: [["single"], ["single"], ["left", "right"], ["single"]],
  });
});

it("stores the derived columns, number rows and lookup keys on every record it seeds that has them (ADR-0013)", async () => {
  const t = convexTest(schema, modules);
  await t.run((ctx) => ctx.db.insert("users", ADMIN));
  await t.mutation(seed, { email: ADMIN.email });
  const tables: DerivedTable[] = [
    "flights",
    "workOrders",
    "taskCards",
    "purchaseOrders",
  ];
  for (const table of tables) {
    const rows = await t.run((ctx) => ctx.db.query(table).collect());
    await expectDerivedColumns(
      t,
      table,
      rows.map((r) => r.uuid),
    );
    if (table === "workOrders" || table === "taskCards")
      await expectRecordNumbers(
        t,
        table,
        rows.map((r) => r.uuid),
      );
    if (table === "purchaseOrders")
      await expectPurchasingKeys(
        t,
        table,
        rows.map((r) => r.uuid),
      );
  }
});

it("links sample PDFs to each operational area and prevents duplicate attachments", async () => {
  const t = convexTest(schema, modules);
  await t.run((ctx) =>
    ctx.db.insert("users", {
      name: "Admin",
      email: "admin@example.test",
      active: true,
      isAdmin: true,
      groupIds: [],
    }),
  );
  await t.mutation(makeFunctionReference<"mutation">("sampleProgram:seed"), {
    email: "admin@example.test",
  });
  const upload = makeFunctionReference<"action">("sampleDocuments:upload");
  const args = {
    email: "admin@example.test",
    pdfs: Array(4).fill(btoa("%PDF-1.4\nSAMPLE\n%%EOF")),
  };
  await expect(t.action(upload, args)).resolves.toEqual({ created: true });
  await expect(t.action(upload, args)).resolves.toEqual({ created: false });
  await t.run(async (ctx) => {
    for (const table of [
      "manuals",
      "taskEvidence",
      "inventoryFiles",
      "workOrderFiles",
      "poFiles",
    ] as const)
      expect(await ctx.db.query(table).collect()).toHaveLength(4);
    expect(await ctx.db.system.query("_storage").collect()).toHaveLength(4);
  });
});

it("attaches documents only for an administrator, after a complete seed", async () => {
  const t = convexTest(schema, modules);
  const files = await t.run(async (ctx) => {
    await ctx.db.insert("users", ADMIN);
    await ctx.db.insert("users", {
      ...ADMIN,
      email: "member@example.test",
      isAdmin: false,
    });
    const stored: { storageId: Id<"_storage">; size: number }[] = [];
    for (let i = 0; i < 4; i++)
      stored.push({
        storageId: await ctx.storage.store(new Blob(["%PDF-"])),
        size: 5,
      });
    return stored;
  });
  const run = (email: string, given = files) =>
    t.mutation(attach, { email, files: given });
  await expect(run(ADMIN.email, files.slice(1))).rejects.toThrow(
    "Exactly four example PDFs are required.",
  );
  await expect(run("member@example.test")).rejects.toThrow(
    "Administrator required.",
  );
  await expect(run(ADMIN.email)).rejects.toThrow(
    "Seed the sample program first.",
  );
  await t.mutation(seed, { email: ADMIN.email });
  await t.run(async (ctx) => {
    const card = await ctx.db
      .query("taskCards")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", "sample-aircraft-4"))
      .first();
    await ctx.db.delete(card!._id);
  });
  await expect(run(ADMIN.email)).rejects.toThrow("Sample links are missing.");
  expect(await t.run((ctx) => ctx.db.query("manuals").collect())).toEqual([]);
});
