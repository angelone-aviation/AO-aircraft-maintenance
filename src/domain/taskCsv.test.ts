/**
 * Responsibility: Pins task CSV parsing in both formats and all-or-nothing
 *   imports to templates and inspections, with the refusals users see.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/taskCsv.ts, inspectionTemplates.ts,
 *   activateTemplate.ts, maintenanceCsv.ts, rejection.ts; src/data/demo.ts,
 *   tests/fixtures/taskCards.ts and phase-2-tasks.csv (fixtures).
 */
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  parseTaskCsv,
  importTaskCsv,
  taskCsvImportSchema,
  type TaskCsvImport,
} from "./taskCsv";
import { CSV_MAX_BYTES } from "./maintenanceCsv";
import { demoSnapshot } from "../data/demo";
import { emptyTemplate } from "./inspectionTemplates";
import { activateTemplate } from "./activateTemplate";
import { Rejection } from "./rejection";
import { taskCardCommand } from "../../tests/fixtures/taskCards";
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
    'Item code,Task,Zone,Manual reference,PDF page\r\nA1,"First line\nSecond, ""quoted"" line",,,\r\n';
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
// A 79-page manual; the fixture's first task cites PDF page 79.
const manual = (aircraftUuid: string, uploadedBy: string) => ({
  uuid: crypto.randomUUID(),
  aircraftUuid,
  title: "Manual",
  documentNumber: "",
  revision: "test",
  revisionDate: "",
  filename: "manual.pdf",
  size: 100,
  pageCount: 79,
  uploadedAt: 0,
  uploadedBy,
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
  s.manuals = [manual(s.aircraft[0].uuid, s.user.id)];
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

const HEADER = "Item code,Task,Zone,Manual reference,PDF page";
const COLUMNS =
  "Use these columns: Item code, Task, Zone, Manual reference, PDF page. The existing tasks.csv format is also supported.";

it("refuses a file or row it cannot read, naming the row", () => {
  const cases: [string, string][] = [
    ["é".repeat(1024 * 1024 + 1), "Choose a CSV up to 2 MB."],
    [HEADER, "Choose a CSV with headers and task rows."],
    [`Task,${HEADER}\nA1`, "Duplicate CSV headers are not allowed."],
    [`${HEADER},Notes\nA1,Inspect,,,,`, COLUMNS],
    ["id,item_code\nstep1,A1", COLUMNS],
    [
      `${HEADER}\nA1,Inspect,1`,
      "CSV row 2: Column count differs from the header; quote fields containing commas.",
    ],
    [
      `${HEADER}\nA1,Inspect,,,1.5`,
      "CSV row 2: PDF page must be a positive whole number.",
    ],
    [
      `${HEADER}\n,Inspect,,,`,
      "CSV row 2: Item code is required for task identity.",
    ],
    [
      `${HEADER}\nA 1,Inspect,,,\na  1,Check,,,`,
      "CSV row 3: Duplicate item code a  1.",
    ],
    [
      `${HEADER}\nA1, ,,,`,
      "CSV row 2: Enter a task instruction of up to 9,000 characters.",
    ],
    [
      `${HEADER}\n${"A".repeat(101)},Inspect,,,100001`,
      "CSV row 2: Item code is too long (up to 100 characters).\nPDF page must be a positive whole number up to 100,000.",
    ],
  ];
  for (const [text, message] of cases) {
    expect(() => parseTaskCsv(text)).toThrow(Rejection);
    expect(() => parseTaskCsv(text)).toThrow(Error(message));
  }
});

it("measures the CSV limit in UTF-8 bytes when parsing, in characters in a request", () => {
  const atLimit = "é".repeat(CSV_MAX_BYTES / 2);
  const size = "Choose a CSV up to 2 MB.";
  expect(() => parseTaskCsv(atLimit)).not.toThrow(size);
  expect(() => parseTaskCsv(atLimit + "x")).toThrow(size);
  const field = taskCsvImportSchema.shape.csv;
  expect(field.safeParse("é".repeat(CSV_MAX_BYTES)).success).toBe(true);
  expect(field.safeParse("é".repeat(CSV_MAX_BYTES + 1)).success).toBe(false);
});

it("refuses an unavailable, archived or changed target and a manual link without a PDF page", () => {
  const { s, t, input } = fixture();
  s.manuals = [];
  const attempt = (change: Partial<TaskCsvImport>) => () =>
    importTaskCsv(structuredClone(s), { ...input, ...change });
  const archived = () => {
    t.archived = true;
    return attempt({})();
  };
  for (const [move, message] of [
    [
      attempt({ targetUuid: "gone" }),
      "Target is unavailable or maintenance access is denied.",
    ],
    [attempt({ targetVersion: 2 }), "Target changed. Preview the file again."],
    [
      attempt({ csv: `${HEADER}\nA1,Inspect,,,`, manualUuid: t.uuid }),
      "Task A1: a PDF page is required when linking a manual.",
    ],
    [archived, "Choose an active template or inspection."],
  ] as const) {
    expect(move).toThrow(Rejection);
    expect(move).toThrow(Error(message));
  }
});

it("names job cards by source key and finds earlier job cards by code, source key or step", () => {
  const { s, input } = fixture();
  const inspection = s.inspections[0];
  const request = {
    ...input,
    targetKind: "inspection" as const,
    targetUuid: inspection.uuid,
    targetVersion: 0,
  };
  const audit = s.audit.length;
  importTaskCsv(s, request);
  // Characterizes current behaviour: imported job cards log no rows.
  expect(s.audit).toHaveLength(audit);
  const card = s.taskCards![0];
  expect(card).toMatchObject({
    sourceKey: "task-csv:a243003",
    title: `${inspection.reference} — A243003`,
    status: "draft",
  });
  const shouting = `  ${parseTaskCsv(csv)[0].instruction.toUpperCase()} `;
  const unmarked = { ...card, itemCode: "", sourceKey: "" };
  const measureStep = taskCardCommand().fields.steps[0];
  for (const earlier of [
    { ...unmarked, itemCode: " a243003" },
    { ...unmarked, sourceKey: card.sourceKey },
    { ...unmarked, steps: [{ ...measureStep, instruction: shouting }] },
  ]) {
    s.taskCards = [earlier];
    expect(() => importTaskCsv(s, request)).toThrow(Rejection);
    expect(() => importTaskCsv(s, request)).toThrow("already exists");
  }
});

it("finds earlier template tasks by code or text, and logs the template save", () => {
  const { s, t, input } = fixture();
  const shouting = `  ${parseTaskCsv(csv)[0].instruction.toUpperCase()} `;
  for (const task of [
    { itemCode: "A243003 ", instruction: "Other", applicability: "" },
    { itemCode: "", instruction: shouting, applicability: "" },
  ]) {
    s.inspectionTemplates = [{ ...t, tasks: [task] }];
    expect(() => importTaskCsv(s, input)).toThrow(Rejection);
    expect(() => importTaskCsv(s, input)).toThrow("already exists");
  }
  s.inspectionTemplates = [t];
  const audit = s.audit.length;
  importTaskCsv(s, input);
  expect(s.audit).toHaveLength(audit + 1);
  expect(s.audit[0].action).toBe("inspectionTemplate.save");
});
