import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createDecipheriv } from "node:crypto";
import { importFmd, exportFmd } from "../data/fmd";
import {
  checklistCounts,
  emptyChecklist,
  fmdSchema,
  saveChecklist,
  type ChecklistRecord,
} from "./checklists";
import { demoSnapshot } from "../data/demo";
import { scopedSnapshot } from "./programs";

it("imports the real N377YB file without changing its 598 entries and round-trips all fields", async () => {
  const input = readFileSync("tests/fixtures/N377YB complete Check List.fmd");
  const decipher = createDecipheriv(
    "aes-128-cbc",
    Buffer.from("81e06e41a93f3848"),
    input.subarray(0, 16),
  );
  const original = JSON.parse(
    Buffer.concat([
      decipher.update(input.subarray(16)),
      decipher.final(),
    ]).toString("utf8"),
  );
  const doc = await importFmd(new Uint8Array(input).buffer);
  expect(doc).toEqual(original);
  expect(checklistCounts(doc)).toEqual({
    lists: 12,
    entries: 598,
    checks: 401,
  });
  expect(doc.payload.metadata.name).toBe("N377YB");
  expect(doc.payload.groups[0].items[0].items[0].items[0]).toMatchObject({
    title: "1. LANDING GEAR HANDLE",
    detail: "DOWN",
  });
  const exported = await exportFmd(doc);
  expect(await importFmd(await exported.arrayBuffer())).toEqual(original);
});
it("rejects invalid/corrupt files, duplicate identifiers and unsupported versions", async () => {
  await expect(importFmd(new ArrayBuffer(7))).rejects.toThrow("Invalid FMD");
  await expect(importFmd(new ArrayBuffer(32))).rejects.toThrow(
    "Unable to read",
  );
  const invalid = emptyChecklist();
  invalid.payload.groups[0].objectId = invalid.payload.objectId;
  expect(() => fmdSchema.parse(invalid)).toThrow("duplicate");
  expect(() =>
    fmdSchema.parse({
      ...emptyChecklist(),
      payload: { ...emptyChecklist().payload, schemaVersion: "2.0" },
    }),
  ).toThrow();
});
it("preserves unrecognized extension data and explicit notes on comments", async () => {
  const raw = emptyChecklist();
  raw.extra = { version: 2 };
  raw.payload.groups[0].items.push({
    objectId: "group",
    title: "Notes",
    items: [
      {
        objectId: "list",
        title: "Note list",
        items: [
          {
            objectId: "item",
            type: "comment",
            title: "Header",
            detail: "Keep Case\nAnd Newlines",
            note: "Separate note",
            actions: [{ futureAction: "do not execute" }],
            customField: 42,
          },
        ],
      },
    ],
  });
  expect(await importFmd(await (await exportFmd(raw)).arrayBuffer())).toEqual(
    raw,
  );
});
function record(): ChecklistRecord {
  const s = demoSnapshot();
  return {
    uuid: crypto.randomUUID(),
    version: 0,
    programUuid: s.programs![0].uuid,
    aircraftUuid: s.aircraft[0].uuid,
    sourceName: "test.fmd",
    updatedAt: 0,
    updatedBy: "",
    document: emptyChecklist(),
  };
}
it("saves versioned definitions, rejects stale writes and isolates programs and aircraft", () => {
  const s = demoSnapshot(),
    r = record();
  const first = saveChecklist(s, { record: r, baseVersion: 0 });
  expect(first.version).toBe(1);
  expect(first.updatedBy).toBe(s.user.id);
  expect(() => saveChecklist(s, { record: r, baseVersion: 0 })).toThrow(
    "changed",
  );
  expect(() =>
    saveChecklist(s, {
      record: { ...r, programUuid: "foreign" },
      baseVersion: 1,
    }),
  ).toThrow("permission");
  s.user.isAdmin = false;
  s.user.groupIds = ["reader"];
  s.groups = [
    {
      id: "reader",
      programUuid: r.programUuid,
      name: "Reader",
      aircraftIds: [s.aircraft[1].uuid],
      permissions: ["read"],
    },
  ];
  expect(scopedSnapshot(s).checklists).toEqual([]);
  expect(() => saveChecklist(s, { record: first, baseVersion: 1 })).toThrow(
    "permission",
  );
});

it("includes library checklist history only in the owning program", () => {
  const s = demoSnapshot();
  const r = saveChecklist(s, {
    record: { ...record(), aircraftUuid: "" },
    baseVersion: 0,
  });
  s.audit.push({
    uuid: "checklist-audit",
    actorId: s.user.id,
    at: Date.now(),
    entityUuid: r.uuid,
    programUuid: r.programUuid,
    action: "checklist.saved",
  });
  expect(
    scopedSnapshot(s).audit.some((a) => a.uuid === "checklist-audit"),
  ).toBe(true);
  s.programs!.push({ ...s.programs![0], uuid: "other" });
  s.user.activeProgramUuid = "other";
  expect(
    scopedSnapshot(s).audit.some((a) => a.uuid === "checklist-audit"),
  ).toBe(false);
});
