import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseTaskCsv, importTaskCsv, type TaskCsvImport } from "./taskCsv";
import { demoSnapshot } from "../data/demo";
import { emptyTemplate } from "./inspectionTemplates";
import { activateTemplate } from "./activateTemplate";
const csv = readFileSync("tests/fixtures/phase-2-tasks.csv", "utf8");
function fixture() {
  const s = demoSnapshot();
  const a = s.aircraft[0];
  const t = {
    ...emptyTemplate(),
    name: "Phase 2",
    hours: 100,
    version: 1,
    programUuid: a.programUuid,
    applicability: {
      kind: "aircraft" as const,
      manufacturer: a.make,
      model: a.model,
      partNumber: "",
    },
  };
  s.inspectionTemplates = [t];
  const input: TaskCsvImport = {
    csv,
    targetKind: "template",
    targetUuid: t.uuid,
    targetVersion: 1,
    reviewed: true,
  };
  return { s, t, input };
}
it("reads the supplied 14 task file preserving source text and quoted zones", () => {
  const tasks = parseTaskCsv(csv);
  expect(tasks).toHaveLength(14);
  expect(tasks[0]).toMatchObject({
    itemCode: "A243003",
    zone: "131",
    referenceText: "5-12-02 page 1",
    pdfPage: 79,
  });
  expect(tasks[4].zone).toBe("410, 420");
  expect(tasks[12].instruction).toContain("Hartzell only");
  const multiline =
    'Item code,Task,Zone,Manual reference,PDF page\r\nA1,"First line\nSecond, \"\"quoted\"\" line",,,\r\n';
  expect(parseTaskCsv(multiline)[0].instruction).toBe(
    'First line\nSecond, "quoted" line',
  );
});
it("appends to a template and preserves metadata when activating later", () => {
  const { s, t, input } = fixture();
  importTaskCsv(s, input);
  expect(s.inspectionTemplates![0].tasks).toHaveLength(14);
  expect(s.taskCards ?? []).toHaveLength(0);
  const activated = activateTemplate(s, {
    templateUuid: t.uuid,
    templateVersion: 2,
    targetUuid: s.aircraft[0].uuid,
    mode: "recurring",
    lastSeconds: 2200 * 3600,
    description: "Phase 2",
    reviewed: true,
  });
  expect(activated.tasks).toHaveLength(14);
  expect(activated.tasks[0]).toMatchObject({
    itemCode: "A243003",
    maintenanceReference: "5-12-02 page 1 · PDF page 79",
    applicability: "Zone: 131",
    status: "draft",
    technicianSignoff: null,
  });
  expect(() =>
    importTaskCsv(s, {
      ...input,
      targetKind: "inspection",
      targetUuid: activated.record.uuid,
      targetVersion: 1,
    }),
  ).toThrow("already exists");
});
it("imports one complete batch to an inspection with no duplicates or partial writes", () => {
  const { s, input } = fixture();
  const request = {
    ...input,
    targetKind: "inspection" as const,
    targetUuid: s.inspections[0].uuid,
    targetVersion: 0,
  };
  importTaskCsv(s, request);
  expect(s.taskCards).toHaveLength(14);
  expect(
    s.taskCards!.every(
      (t) => t.inspectionUuid === request.targetUuid && t.status === "draft",
    ),
  ).toBe(true);
  const before = structuredClone(s);
  expect(() => importTaskCsv(s, request)).toThrow("already exists");
  expect(s).toEqual(before);
  expect(() =>
    importTaskCsv(s, { ...request, csv: csv + "BAD,,,,0\r\n" }),
  ).toThrow();
  expect(s).toEqual(before);
});
it("validates permissions, stale versions, duplicate codes and manual page bounds", () => {
  const { s, input, t } = fixture();
  expect(() => parseTaskCsv(csv + csv.split("\n")[1] + "\n")).toThrow(
    "Duplicate item code",
  );
  expect(() => importTaskCsv(s, { ...input, targetVersion: 0 })).toThrow(
    "changed",
  );
  t.archived = true;
  expect(() => importTaskCsv(s, input)).toThrow("active");
  t.archived = false;
  s.manuals = [
    {
      uuid: crypto.randomUUID(),
      aircraftUuid: s.aircraft[0].uuid,
      title: "Manual",
      documentNumber: "",
      revision: "test",
      revisionDate: "",
      filename: "manual.pdf",
      size: 100,
      pageCount: 79,
      uploadedAt: 0,
      uploadedBy: s.user.id,
    },
  ];
  expect(() =>
    importTaskCsv(s, { ...input, manualUuid: s.manuals![0].uuid }),
  ).toThrow("between 1 and 79");
  expect(s.inspectionTemplates![0].tasks).toHaveLength(0);
  s.manuals[0].pageCount = 80;
  importTaskCsv(s, { ...input, manualUuid: s.manuals![0].uuid });
  expect(s.inspectionTemplates![0].tasks[0].manualReference).toMatchObject({
    pdfPage: 79,
    section: "5-12-02",
    printedPage: "1",
  });
  s.user.isAdmin = false;
  s.user.groupIds = [];
  expect(() => importTaskCsv(s, { ...input, targetVersion: 2 })).toThrow(
    "access",
  );
});
it("accepts the legacy task CSV and uses the file destination instead of source parent IDs", () => {
  const { s, input } = fixture();
  const legacy =
    "id,parent_type,parent_id,item_code,instruction,applicability,section,printed_page,pdf_page\nstep1,inspection,old-parent,A1,Inspect seal,All,5-12-02,1,79";
  importTaskCsv(s, { ...input, csv: legacy });
  expect(s.inspectionTemplates![0].tasks[0]).toMatchObject({
    itemCode: "A1",
    instruction: "Inspect seal",
    referenceText: "5-12-02 page 1",
    pdfPage: 79,
  });
});
it("reports the spreadsheet row of an invalid task after blank rows", () => {
  expect(() =>
    parseTaskCsv(
      "Item code,Task,Zone,Manual reference,PDF page\nA1,Inspect,1,,1\n\nA2,Inspect,1,,x",
    ),
  ).toThrow("CSV row 4:");
});
