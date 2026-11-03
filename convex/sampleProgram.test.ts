import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import { makeFunctionReference } from "convex/server";
import schema from "./schema";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
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
    expect(await ctx.db.query("groups").collect()).toHaveLength(9);
    expect(await ctx.db.query("flightPlans").collect()).toHaveLength(8);
    expect(await ctx.db.query("management").collect()).toHaveLength(24);
    expect(await ctx.db.get(userId)).toMatchObject({
      activeProgramUuid: "real-program",
      groupIds: [],
    });
    const aircraft = await ctx.db.query("aircraft").collect();
    for (const f of await ctx.db.query("flights").collect()) {
      const a = aircraft.find((a) => a.uuid === f.aircraftUuid)!;
      expect(a.currentHobbs).toBe(f.hobbsOff);
      expect(f.hobbsOn).toBe(a.baselineHobbs);
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
