import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import { emptyTemplate } from "../src/domain/inspectionTemplates";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
it("persists program-scoped templates without compliance and enforces server authorization", async () => {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const s = demoSnapshot();
    await ctx.db.insert("programs", s.programs![0]);
    await ctx.db.insert("aircraft", {
      ...s.aircraft[0],
      make: "Cessna",
      model: "441",
    });
    const user = async (maintenance: boolean) => {
      const g = await ctx.db.insert("groups", {
        programUuid: "demo-program",
        name: "Templates",
        aircraftIds: [],
        permissions: maintenance ? ["read", "maintenance"] : ["read"],
      });
      const u = await ctx.db.insert("users", {
        active: true,
        isAdmin: false,
        groupIds: [g],
      });
      const session = await ctx.db.insert("authSessions", {
        userId: u,
        expirationTime: Date.now() + 86400000,
      });
      return { subject: `${u}|${session}` };
    };
    return { tech: await user(true), reader: await user(false) };
  });
  const record = {
    ...emptyTemplate(),
    name: "Phase 2",
    hours: 100,
    tasks: [
      { itemCode: "A1", instruction: "Inspect seals", applicability: "All" },
    ],
    applicability: {
      kind: "aircraft",
      manufacturer: "Cessna",
      model: "441",
      partNumber: "",
    },
  };
  const args = {
    programUuid: "demo-program",
    payload: JSON.stringify([record]),
  };
  await expect(
    t.withIdentity(ids.reader).mutation(api.inspectionTemplates.save, args),
  ).rejects.toThrow("permission");
  await expect(
    t.withIdentity(ids.tech).mutation(api.inspectionTemplates.save, {
      ...args,
      programUuid: "wrong",
    }),
  ).rejects.toThrow("Program changed");
  await t.withIdentity(ids.tech).mutation(api.inspectionTemplates.save, args);
  const s = await t.withIdentity(ids.reader).query(api.operations.snapshot);
  expect(s?.inspectionTemplates).toHaveLength(1);
  expect(s?.inspectionTemplates![0]).toMatchObject({ hours: 100, version: 1 });
  expect(s?.inspections).toHaveLength(0);
  await expect(
    t.withIdentity(ids.tech).mutation(api.inspectionTemplates.save, {
      ...args,
      payload: JSON.stringify([
        {
          ...record,
          uuid: crypto.randomUUID(),
          name: "bad",
          lastDate: "2025-01-01",
        },
      ]),
    }),
  ).rejects.toThrow();
  await expect(
    t.withIdentity(ids.tech).mutation(api.inspectionTemplates.save, {
      ...args,
      payload: JSON.stringify([{ ...record, uuid: crypto.randomUUID() }]),
    }),
  ).rejects.toThrow("already exists");
  const activation = {
    programUuid: "demo-program",
    payload: JSON.stringify({
      templateUuid: record.uuid,
      templateVersion: 1,
      targetUuid: demoSnapshot().aircraft[0].uuid,
      mode: "recurring",
      description: "Inspect seals",
      lastSeconds: 2200 * 3600,
      reviewed: true,
    }),
  };
  await expect(
    t
      .withIdentity(ids.reader)
      .mutation(api.inspectionTemplates.activate, activation),
  ).rejects.toThrow("maintenance access");
  await t
    .withIdentity(ids.tech)
    .mutation(api.inspectionTemplates.activate, activation);
  const after = await t.withIdentity(ids.reader).query(api.operations.snapshot);
  expect(after?.inspections).toHaveLength(1);
  expect(after?.taskCards).toHaveLength(1);
  expect(after?.taskCards![0]).toMatchObject({
    status: "draft",
    inspectionUuid: after!.inspections[0].uuid,
  });
  await expect(
    t
      .withIdentity(ids.tech)
      .mutation(api.inspectionTemplates.activate, activation),
  ).rejects.toThrow("already exists");
});

it("atomically deletes selected templates, associated cards and stored evidence with audit history", async () => {
  const { templateDeletionFixture } =
    await import("../tests/fixtures/templateDeletion");
  const { templateDeletionPreview } =
    await import("../src/domain/deleteInspectionTemplates");
  const { s, template, keep, task, job } = templateDeletionFixture();
  const t = convexTest(schema, modules);
  const seeded = await t.run(async (ctx) => {
    await ctx.db.insert("programs", s.programs![0]);
    for (const a of s.aircraft) await ctx.db.insert("aircraft", a);
    for (const i of s.inspections) await ctx.db.insert("inspections", i);
    for (const r of s.inspectionTemplates!)
      await ctx.db.insert("inspectionTemplates", {
        uuid: r.uuid,
        programUuid: r.programUuid,
        payload: JSON.stringify(r),
      });
    for (const r of s.taskCards!)
      await ctx.db.insert("taskCards", {
        uuid: r.uuid,
        aircraftUuid: r.aircraftUuid,
        payload: JSON.stringify(r),
      });
    const id = await ctx.db.insert("users", {
      active: true,
      isAdmin: true,
      groupIds: [],
      activeProgramUuid: "demo-program",
    });
    const session = await ctx.db.insert("authSessions", {
      userId: id,
      expirationTime: Date.now() + 86400000,
    });
    const storageId = await ctx.storage.store(
      new Blob(["evidence"], { type: "text/plain" }),
    );
    await ctx.db.insert("taskEvidence", {
      taskCardUuid: task.uuid,
      storageId,
      name: "evidence.txt",
      size: 8,
      uploadedAt: 0,
      category: "supporting-document",
    });
    return { subject: `${id}|${session}`, storageId };
  });
  const user = t.withIdentity({ subject: seeded.subject });
  const preview = templateDeletionPreview(s, [template.uuid]);
  const args = {
    programUuid: "demo-program",
    payload: JSON.stringify(preview),
  };
  await expect(
    t.mutation(api.inspectionTemplates.remove, args),
  ).rejects.toThrow();
  await expect(
    user.mutation(api.inspectionTemplates.remove, {
      ...args,
      payload: JSON.stringify({ ...preview, taskCards: [] }),
    }),
  ).rejects.toThrow("changed");
  expect(
    await t.run((ctx) => ctx.db.query("inspectionTemplates").collect()),
  ).toHaveLength(2);
  await user.mutation(api.inspectionTemplates.remove, args);
  const remaining = await t.run(async (ctx) => ({
    templates: await ctx.db.query("inspectionTemplates").collect(),
    cards: await ctx.db.query("taskCards").collect(),
    evidence: await ctx.db.query("taskEvidence").collect(),
    blob: await ctx.storage.get(seeded.storageId),
    audit: await ctx.db.query("audit").collect(),
    inspections: await ctx.db.query("inspections").collect(),
  }));
  expect(remaining.templates.map((r) => r.uuid)).toEqual([keep.uuid]);
  expect(remaining.cards.map((r) => r.uuid)).toEqual([job.uuid]);
  expect(remaining.evidence).toEqual([]);
  expect(remaining.blob).toBeNull();
  expect(
    remaining.inspections.some((i) => i.uuid === task.inspectionUuid),
  ).toBe(true);
  expect(
    remaining.audit.some((a) => a.action === "inspectionTemplate.deleted"),
  ).toBe(true);
  expect(
    remaining.audit.some((a) => a.action === "taskCard.deletedWithTemplate"),
  ).toBe(true);
});
