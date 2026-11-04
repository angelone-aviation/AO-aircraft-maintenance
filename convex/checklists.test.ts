/**
 * Responsibility: Pins checklist saving: permission, stale versions, the
 *   snapshot, and the change-log row: the program, and a summary that leaves
 *   out the body.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/checklists, convex/schema, src/domain/checklists,
 *   src/data/demo (fixture).
 */
import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import {
  checklistCounts,
  emptyChecklist,
  type ChecklistRecord,
} from "../src/domain/checklists";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
it("persists checklist definitions and audits, rejects read-only and stale mutations", async () => {
  const t = convexTest(schema, modules),
    s = demoSnapshot();
  const users = await t.run(async (ctx) => {
    for (const a of s.aircraft) await ctx.db.insert("aircraft", a);
    await ctx.db.insert("programs", s.programs![0]);
    const user = async (maintenance: boolean) => {
      const group = await ctx.db.insert("groups", {
        programUuid: s.programs![0].uuid,
        name: "Checklist access",
        aircraftIds: [s.aircraft[0].uuid],
        permissions: maintenance ? ["read", "maintenance"] : ["read"],
      });
      const id = await ctx.db.insert("users", {
        active: true,
        isAdmin: false,
        name: "Checklist tester",
        groupIds: [group],
      });
      const session = await ctx.db.insert("authSessions", {
        userId: id,
        expirationTime: Date.now() + 86400000,
      });
      return { subject: `${id}|${session}` };
    };
    return { editor: await user(true), reader: await user(false) };
  });
  const editor = t.withIdentity(users.editor),
    reader = t.withIdentity(users.reader);
  const record: ChecklistRecord = {
    uuid: crypto.randomUUID(),
    version: 0,
    programUuid: s.programs![0].uuid,
    aircraftUuid: s.aircraft[0].uuid,
    document: emptyChecklist(),
    sourceName: "test.fmd",
    updatedAt: 0,
    updatedBy: "",
  };
  const args = {
    programUuid: record.programUuid,
    payload: JSON.stringify({ record, baseVersion: 0 }),
  };
  await expect(reader.mutation(api.checklists.save, args)).rejects.toThrow(
    "permission",
  );
  await expect(
    reader.mutation(api.checklists.save, args),
  ).rejects.toMatchObject({
    name: "ConvexError",
    data: "Checklist editing permission denied.",
  });
  await editor.mutation(api.checklists.save, args);
  await expect(editor.mutation(api.checklists.save, args)).rejects.toThrow(
    "changed",
  );
  await expect(
    editor.mutation(api.checklists.save, args),
  ).rejects.toMatchObject({
    name: "ConvexError",
    data: "This checklist changed. Reopen it before saving; your draft has not been applied.",
  });
  const snapshot = await reader.query(api.operations.snapshot);
  expect(snapshot!.checklists).toHaveLength(1);
  expect(snapshot!.checklists![0]).toMatchObject({
    version: 1,
    uuid: record.uuid,
  });
  await expect(
    editor.mutation(api.checklists.save, {
      ...args,
      payload: JSON.stringify({
        record: { ...record, aircraftUuid: s.aircraft[1].uuid },
        baseVersion: 1,
      }),
    }),
  ).rejects.toThrow("permission");
  const docs = await t.run((ctx) => ctx.db.query("audit").collect());
  expect(docs.some((d) => d.action === "checklist.saved")).toBe(true);
  const saved = docs.find((d) => d.action === "checklist.saved")!;
  expect(saved).toMatchObject({
    programUuid: record.programUuid,
    entityUuid: record.uuid,
    aircraftUuid: record.aircraftUuid,
  });
  expect(saved).not.toHaveProperty("before");
  expect(saved).not.toHaveProperty("reason");
  expect(JSON.parse(saved.after!)).toEqual({
    version: 1,
    name: record.document.payload.metadata.name,
    ...checklistCounts(record.document),
  });
});

it("saves once per request id: a replay returns nothing and writes nothing", async () => {
  const t = convexTest(schema, modules),
    s = demoSnapshot();
  const subject = await t.run(async (ctx) => {
    for (const a of s.aircraft) await ctx.db.insert("aircraft", a);
    await ctx.db.insert("programs", s.programs![0]);
    const id = await ctx.db.insert("users", {
      active: true,
      isAdmin: true,
      name: "Administrator",
      groupIds: [],
      activeProgramUuid: s.programs![0].uuid,
    });
    const session = await ctx.db.insert("authSessions", {
      userId: id,
      expirationTime: Date.now() + 86400000,
    });
    return `${id}|${session}`;
  });
  const editor = t.withIdentity({ subject });
  const record: ChecklistRecord = {
    uuid: crypto.randomUUID(),
    version: 0,
    programUuid: s.programs![0].uuid,
    aircraftUuid: s.aircraft[0].uuid,
    document: emptyChecklist(),
    sourceName: "test.fmd",
    updatedAt: 0,
    updatedBy: "",
  };
  const requestUuid = crypto.randomUUID();
  const args = (sourceName: string) => ({
    programUuid: record.programUuid,
    payload: JSON.stringify({
      record: { ...record, sourceName },
      baseVersion: 0,
      requestUuid,
    }),
  });
  const stored = () =>
    t.run(async (ctx) => ({
      checklists: await ctx.db.query("checklists").collect(),
      audit: await ctx.db.query("audit").collect(),
      commandRequests: await ctx.db.query("commandRequests").collect(),
    }));

  await expect(
    editor.mutation(api.checklists.save, args("test.fmd")),
  ).resolves.toBe(record.uuid);
  const saved = await stored();
  expect(saved.checklists).toHaveLength(1);
  expect(saved.commandRequests).toMatchObject([
    { uuid: requestUuid, payload: args("test.fmd").payload },
  ]);
  // ADR-0003: a replay succeeds with no payload; the snapshot shows its effect.
  await expect(
    editor.mutation(api.checklists.save, args("test.fmd")),
  ).resolves.toBeNull();
  expect(await stored()).toEqual(saved);
  await expect(
    editor.mutation(api.checklists.save, args("other.fmd")),
  ).rejects.toMatchObject({ data: "Request identifier already used." });
  expect(await stored()).toEqual(saved);
});
