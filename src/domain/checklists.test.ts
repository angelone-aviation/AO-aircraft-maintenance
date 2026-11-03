/**
 * Responsibility: Pins the .fmd checklist schema against a real file, its
 *   limits, and who may read, edit and save a checklist set.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/checklists.ts, src/domain/programs.ts,
 *   src/domain/rejection.ts, src/data/fmd.ts, src/data/demo.ts (fixture),
 *   tests/fixtures (a real .fmd file).
 */
import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createDecipheriv } from "node:crypto";
import { importFmd, exportFmd } from "../data/fmd";
import {
  checklistCounts,
  checklistEditable,
  checklistId,
  checklistReadable,
  emptyChecklist,
  fmdSchema,
  saveChecklist,
  type ChecklistDocument,
  type ChecklistRecord,
} from "./checklists";
import { demoSnapshot } from "../data/demo";
import { scopedSnapshot } from "./programs";
import { Rejection } from "./rejection";
import type { Permission, Snapshot } from "./model";

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

it("starts a blank set with the three categories in order and fresh ids", () => {
  const doc = emptyChecklist();
  expect(doc.payload.metadata.name).toBe("New checklist");
  expect(doc.payload.groups.map((c) => c.groupType)).toEqual([
    "normal",
    "abnormal",
    "emergency",
  ]);
  const ids = [
    doc.payload.objectId,
    ...doc.payload.groups.map((c) => c.objectId),
  ];
  expect(new Set(ids).size).toBe(4);
  expect(checklistId()).toMatch(/^[0-9a-f]{32}$/);
  expect(fmdSchema.parse(doc)).toEqual(doc);
});

function issues(doc: ChecklistDocument) {
  const parsed = fmdSchema.safeParse(doc);
  return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
}

it("reports each repeated id and category in document order", () => {
  const duplicate = "Checklist contains duplicate item identifiers.";
  const repeated = "Checklist contains a repeated category.";
  const idFirst = emptyChecklist();
  idFirst.payload.groups[0].objectId = idFirst.payload.objectId;
  idFirst.payload.groups[1].groupType = "normal";
  idFirst.payload.groups[2].objectId = idFirst.payload.objectId;
  expect(issues(idFirst)).toEqual([duplicate, repeated, duplicate]);
  const categoryFirst = emptyChecklist();
  categoryFirst.payload.groups[1].groupType = "normal";
  categoryFirst.payload.groups[2].objectId = categoryFirst.payload.objectId;
  expect(issues(categoryFirst)).toEqual([repeated, duplicate]);
});

function withEntries(count: number, detail = "") {
  const doc = emptyChecklist();
  const items = Array.from({ length: count }, (_, i) => ({
    objectId: `item-${i}`,
    detail,
  }));
  const lists = Array.from({ length: Math.ceil(count / 3000) }, (_, i) => ({
    objectId: `list-${i}`,
    title: "List",
    items: items.slice(i * 3000, (i + 1) * 3000),
  }));
  doc.payload.groups[0].items = [
    { objectId: "group", title: "G", items: lists },
  ];
  return doc;
}

it("refuses a set over 10,000 entries or 750,000 bytes", () => {
  const tooLarge =
    "Checklist is too large. Split it into smaller checklist files.";
  expect(issues(withEntries(10_000))).toEqual([]);
  expect(issues(withEntries(10_001))).toEqual([tooLarge]);
  expect(issues(withEntries(37, "d".repeat(20000)))).toEqual([]);
  expect(issues(withEntries(38, "d".repeat(20000)))).toEqual([tooLarge]);
});

function memberOf(permissions: Permission[], programAdmin = false): Snapshot {
  const s = demoSnapshot();
  s.user.isAdmin = false;
  s.user.groupIds = ["crew"];
  s.groups = [
    {
      id: "crew",
      programUuid: s.programs![0].uuid,
      name: "Crew",
      aircraftIds: [],
      permissions: ["read", ...permissions],
      programAdmin,
    },
  ];
  return s;
}

it("lets flight or maintenance crew edit an aircraft's set and only program administrators the library", () => {
  const aircraft = demoSnapshot().aircraft[0].uuid;
  expect(checklistEditable(memberOf(["flight"]), aircraft)).toBe(true);
  expect(checklistEditable(memberOf(["maintenance"]), aircraft)).toBe(true);
  expect(checklistEditable(memberOf(["discrepancy"]), aircraft)).toBe(false);
  expect(checklistEditable(memberOf(["flight"]), "")).toBe(false);
  expect(checklistEditable(memberOf([], true), "")).toBe(true);
  const elsewhere = memberOf(["flight"]);
  elsewhere.aircraft[0].programUuid = "other";
  expect(checklistEditable(elsewhere, aircraft)).toBe(false);
  expect(checklistEditable(memberOf(["flight"]), aircraft, "other")).toBe(
    false,
  );
});

it("lets any program reader read a library set", () => {
  const library = { ...record(), aircraftUuid: "" };
  expect(checklistReadable(memberOf([]), library)).toBe(true);
  const outsider = memberOf([]);
  outsider.groups[0].programUuid = "other";
  expect(checklistReadable(outsider, library)).toBe(false);
});

it("refuses with a Rejection and replaces the saved set in place", () => {
  const s = demoSnapshot();
  const r = record();
  saveChecklist(s, { record: r, baseVersion: 0 }, 1);
  const second = saveChecklist(s, { record: r, baseVersion: 1 }, 2);
  expect(second).toMatchObject({ version: 2, updatedAt: 2 });
  expect(s.checklists!.filter((c) => c.uuid === r.uuid)).toEqual([second]);
  const stale = () => saveChecklist(s, { record: r, baseVersion: 1 });
  expect(stale).toThrow(Rejection);
  expect(stale).toThrow(
    "This checklist changed. Reopen it before saving; your draft has not been applied.",
  );
  const denied = () =>
    saveChecklist(memberOf(["discrepancy"]), { record: r, baseVersion: 0 });
  expect(denied).toThrow(Rejection);
  expect(denied).toThrow(Error("Checklist editing permission denied."));
});
