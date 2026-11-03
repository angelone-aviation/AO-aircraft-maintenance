import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  emptyTemplate,
  inspectionTemplateSchema,
  parseTemplateCsv,
  saveInspectionTemplates,
  templateFromCandidate,
} from "./inspectionTemplates";
import { scopedSnapshot } from "./programs";
import { readFileSync } from "node:fs";
const sample = () => ({
  ...emptyTemplate(),
  name: "Phase 2",
  applicability: {
    kind: "aircraft" as const,
    manufacturer: "Cessna",
    model: "441",
    partNumber: "",
  },
  hours: 100,
  calendarValue: 12,
});
it("saves reusable intervals without history and rejects operational fields", () => {
  const s = demoSnapshot();
  const t = sample();
  saveInspectionTemplates(s, [t]);
  expect(s.inspectionTemplates![0]).toMatchObject({
    hours: 100,
    calendarValue: 12,
    version: 1,
    programUuid: "demo-program",
  });
  expect(s.inspections).toEqual(demoSnapshot().inspections);
  expect(
    inspectionTemplateSchema.safeParse({ ...t, lastDate: "2025-01-01" })
      .success,
  ).toBe(false);
  expect(
    inspectionTemplateSchema.safeParse({ ...t, aircraftUuid: "demo-206" })
      .success,
  ).toBe(false);
});
it("rejects duplicate batches atomically, stale edits and cross-program writes", () => {
  const s = demoSnapshot();
  const t = sample();
  expect(() =>
    saveInspectionTemplates(s, [t, { ...t, uuid: crypto.randomUUID() }]),
  ).toThrow("already exists");
  expect(s.inspectionTemplates).toBeUndefined();
  saveInspectionTemplates(s, [t]);
  expect(() => saveInspectionTemplates(s, [t])).toThrow("changed");
  expect(() =>
    saveInspectionTemplates(s, [{ ...sample(), programUuid: "other" }]),
  ).toThrow("another Flight Program");
  const saved = s.inspectionTemplates![0];
  saveInspectionTemplates(s, [{ ...saved, hours: 200 }]);
  expect(s.inspectionTemplates![0].hours).toBe(200);
});
it("requires maintenance permission and scopes library records", () => {
  const s = demoSnapshot();
  saveInspectionTemplates(s, [sample()]);
  s.inspectionTemplates!.push({ ...sample(), programUuid: "other" });
  expect(scopedSnapshot(s).inspectionTemplates).toHaveLength(1);
  s.user.isAdmin = false;
  s.user.groupIds = [];
  expect(() => saveInspectionTemplates(s, [sample()])).toThrow("permission");
});
it("imports C441 intervals only, preserving exclusions and discarding compliance", () => {
  const rows = parseTemplateCsv(
    readFileSync("tests/fixtures/c441-template-source.csv", "utf8"),
    sample().applicability,
    "Phases",
  );
  expect(rows).toHaveLength(29);
  expect(rows[0].selected).toBe(false);
  expect(rows[1].template).toMatchObject({
    name: "Phase 2",
    hours: 100,
    calendarValue: 12,
    group: "Phases",
  });
  expect(rows[1].template).not.toHaveProperty("lastDate");
  expect(rows[1].template).not.toHaveProperty("dueSeconds");
  expect(rows[12].selected).toBe(false);
});
it("retains component bases, original units and linked task instructions", () => {
  const ref = {
    manualUuid: crypto.randomUUID(),
    section: "5",
    printedPage: "2",
    pdfPage: 2,
  };
  const t = templateFromCandidate(
    {
      importId: "pump",
      sourceKey: "manual:pump",
      name: "Pump check",
      kind: "component",
      text: "Check pump",
      scheduleText: "Restrictions",
      hours: 100,
      warnings: [],
      reference: ref,
      componentDefaults: {
        model: "P100",
        manufacturer: "Acme",
        partNumber: "P-1",
      },
      requirementDefaults: {
        requirementType: "Life Limits",
        timeBasis: "TSO",
        timeLimitMode: "ABSOLUTE",
        cycleLimitMode: "FROM_LAST_COMPLIED",
        calendarIntervalValue: 30,
        calendarIntervalUnit: "DAYS",
      },
    },
    sample().applicability,
    [
      {
        id: "task",
        parentId: "pump",
        parentType: "component_requirement",
        itemCode: "A1",
        instruction: "Inspect seals",
        applicability: "Serial range",
        reference: ref,
        sourceKey: "task",
      },
    ],
  );
  expect(inspectionTemplateSchema.parse(t)).toMatchObject({
    applicability: { kind: "component", model: "P100" },
    calendarValue: 30,
    calendarUnit: "DAYS",
    hourMode: "ABSOLUTE",
    timeBasis: "TSO",
    tasks: [{ instruction: "Inspect seals" }],
  });
});
