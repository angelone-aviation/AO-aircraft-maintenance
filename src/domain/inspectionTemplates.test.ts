/**
 * Responsibility: Pins the inspection template library: schema and its
 *   messages, save rules and refusals, manual candidates and CSV import.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/inspectionTemplates.ts, src/domain/programs.ts,
 *   src/domain/rejection.ts, src/data/demo.ts (seed), tests/fixtures.
 */
import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  TEMPLATE_CSV_MAX_BYTES,
  emptyTemplate,
  inspectionTemplateSchema,
  parseTemplateCsv,
  saveInspectionTemplates,
  taskApplicabilityText,
  taskSourceText,
  templateCsvHeaders,
  templateFromCandidate,
  templateIdentity,
  templateTaskSchema,
} from "./inspectionTemplates";
import { scopedSnapshot } from "./programs";
import { Rejection } from "./rejection";
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

it("refuses user mistakes as a Rejection and a repeated uuid as a fault", () => {
  const s = demoSnapshot();
  const t = sample();
  saveInspectionTemplates(s, [t]);
  const refusal = (records: unknown[]) => {
    try {
      saveInspectionTemplates(s, records as never);
    } catch (error) {
      return error;
    }
  };
  const bigTasks = Array.from({ length: 90 }, () => ({
    itemCode: "A",
    instruction: "x".repeat(9000),
    applicability: "",
  }));
  const batch = ["A", "B", "C"].map((name) => ({
    ...sample(),
    name,
    tasks: bigTasks.slice(0, 80),
  }));
  for (const [records, message] of [
    [[t], "Template changed. Reopen it before saving."],
    [
      [{ ...sample(), name: " phase  2" }],
      "Template already exists: phase  2. Edit the saved template instead.",
    ],
    [
      [{ ...sample(), programUuid: "other" }],
      "Template belongs to another Flight Program.",
    ],
    [
      [{ ...sample(), name: "Big", tasks: bigTasks }],
      "A template with its tasks must fit within 800 KB. Split the checklist into smaller templates.",
    ],
    [batch, "Save templates in batches up to 2 MB."],
  ] as const) {
    const error = refusal([...records]);
    expect(error).toBeInstanceOf(Rejection);
    expect(error).toHaveProperty("message", message);
  }
  const fresh = { ...sample(), name: "Fresh" };
  const duplicateIds = refusal([fresh, { ...fresh, name: "Other" }]);
  expect(duplicateIds).toEqual(Error("Duplicate template IDs in this batch."));
  expect(duplicateIds).not.toBeInstanceOf(Rejection);
});

it("returns each save in order and prepends one audit entry per template", () => {
  const s = demoSnapshot();
  const first = sample();
  saveInspectionTemplates(s, [first]);
  const second = { ...sample(), name: "Phase 3" };
  const auditBefore = s.audit.length;
  const results = saveInspectionTemplates(s, [
    { ...s.inspectionTemplates![0], hours: 200 },
    second,
  ]);
  expect(
    results.map(({ before, next }) => [before?.version, next.version]),
  ).toEqual([
    [1, 2],
    [undefined, 1],
  ]);
  expect(s.audit.length - auditBefore).toBe(2);
  expect(s.audit.slice(0, 2).map((entry) => entry.entityUuid)).toEqual([
    second.uuid,
    first.uuid,
  ]);
  expect(s.audit[0]).toMatchObject({
    action: "inspectionTemplate.save",
    before: undefined,
  });
});

it("identifies templates by normalized applicability, group and name", () => {
  const t = sample();
  expect(templateIdentity({ ...t, name: "  PHASE \t 2 ", group: " " })).toBe(
    templateIdentity({ ...t, name: "phase 2", group: "" }),
  );
  expect(templateIdentity({ ...t, name: "Phase 3" })).not.toBe(
    templateIdentity(t),
  );
  expect(
    templateIdentity({
      ...t,
      applicability: { ...t.applicability, kind: "component" },
    }),
  ).not.toBe(templateIdentity(t));
});

it("describes a task's source and applicability, skipping empty parts", () => {
  const task = { itemCode: "A1", instruction: "Inspect", applicability: "" };
  expect(taskSourceText(task)).toBe("");
  expect(taskSourceText({ ...task, referenceText: "5-10", pdfPage: 3 })).toBe(
    "5-10 · PDF page 3",
  );
  expect(taskSourceText({ ...task, pdfPage: 3 })).toBe("PDF page 3");
  expect(taskApplicabilityText({ ...task, zone: "200" })).toBe("Zone: 200");
  expect(
    taskApplicabilityText({ ...task, applicability: "S/N 1-9", zone: "200" }),
  ).toBe("S/N 1-9\nZone: 200");
});

it("falls back to a component scope only for a component candidate", () => {
  const candidate = {
    sourceKey: "manual:pump",
    name: "Pump check",
    kind: "component" as const,
    text: "",
    scheduleText: "",
    warnings: [],
    reference: {
      manualUuid: crypto.randomUUID(),
      section: "",
      printedPage: "",
      pdfPage: 1,
    },
  };
  const scope = {
    kind: "component" as const,
    manufacturer: "Acme",
    model: "P100",
    partNumber: "P-1",
  };
  expect(templateFromCandidate(candidate, scope).applicability).toEqual(scope);
  expect(
    templateFromCandidate(candidate, sample().applicability).applicability,
  ).toEqual({ kind: "component", manufacturer: "", model: "", partNumber: "" });
  expect(
    templateFromCandidate(
      { ...candidate, kind: "inspection" },
      sample().applicability,
    ).applicability,
  ).toEqual(sample().applicability);
});

const csv = (...rows: string[]) =>
  [templateCsvHeaders.join(","), ...rows].join("\n");
const parse = (text: string) =>
  parseTemplateCsv(text, sample().applicability, "G");

it("names a template task's bad field as the task CSV does", () => {
  const task = {
    itemCode: "A1",
    instruction: "Inspect",
    applicability: "",
  };
  const refusals: [object, string][] = [
    [
      { instruction: " " },
      "Enter a task instruction of up to 9,000 characters.",
    ],
    [
      { instruction: "x".repeat(9001) },
      "Enter a task instruction of up to 9,000 characters.",
    ],
    [
      { itemCode: "x".repeat(101) },
      "Item code is too long (up to 100 characters).",
    ],
    [
      { applicability: "x".repeat(1001) },
      "Applicability is too long (up to 1,000 characters).",
    ],
    [{ zone: "x".repeat(1001) }, "Zone is too long (up to 1,000 characters)."],
    [
      { referenceText: "x".repeat(1001) },
      "Manual reference is too long (up to 1,000 characters).",
    ],
    ...[0, 1.5, 100001].map((pdfPage): [object, string] => [
      { pdfPage },
      "PDF page must be a positive whole number up to 100,000.",
    ]),
  ];
  for (const [change, message] of refusals) {
    const result = templateTaskSchema.safeParse({ ...task, ...change });
    expect(result.error?.issues.map((i) => i.message)).toEqual([message]);
  }
  expect(
    templateTaskSchema.parse({
      ...task,
      instruction: "x".repeat(9000),
      itemCode: "x".repeat(100),
      applicability: "x".repeat(1000),
      zone: "x".repeat(1000),
      referenceText: "x".repeat(1000),
      pdfPage: 100000,
    }).pdfPage,
  ).toBe(100000);
});

it("refuses an unusable CSV header as a Rejection", () => {
  for (const [text, message] of [
    [templateCsvHeaders.join(","), "Choose a CSV with headers and records."],
    [
      `${templateCsvHeaders.join(",")},name\n${"x,".repeat(13)}x`,
      "Duplicate CSV column names are not supported.",
    ],
    [
      `${templateCsvHeaders.slice(1).join(",")}\n${"x,".repeat(11)}x`,
      `Use the template CSV columns: ${templateCsvHeaders.join(", ")}`,
    ],
    [
      `${templateCsvHeaders.join(",")},notes\n${"x,".repeat(13)}x`,
      `Use the template CSV columns: ${templateCsvHeaders.join(", ")}`,
    ],
  ]) {
    expect(() => parse(text)).toThrow(new Rejection(message));
    expect(() => parse(text)).toThrow(Rejection);
  }
});

it("reads choice columns case-insensitively and defaults blank ones", () => {
  const [row] = parse(csv("A,,100,,,days,,,,life limits,tso,absolute,"));
  expect(row.template).toMatchObject({
    calendarUnit: "DAYS",
    requirementType: "Life Limits",
    timeBasis: "TSO",
    hourMode: "ABSOLUTE",
    cycleMode: "FROM_LAST_COMPLIED",
    landingMode: "FROM_LAST_COMPLIED",
  });
});

it("turns a narrative-only row's description into its conditions", () => {
  const header = `${templateCsvHeaders.join(",")},landings`;
  const [narrative, scheduled, landingsOnly] = parseTemplateCsv(
    [
      header,
      "Event,After a hard landing,,,,,,,,,,,,",
      "Timed,Every 100 hours,100,,,,,,,,,,,",
      "Landings,Every 500 landings,,,,,,,,,,,,500",
    ].join("\n"),
    sample().applicability,
    "G",
  );
  expect(narrative.template!.conditions).toBe("After a hard landing");
  expect(scheduled.template!.conditions).toBe("");
  // Characterizes current behaviour: landing columns do not count as a
  // schedule.
  expect(landingsOnly.template!.conditions).toBe("Every 500 landings");
});

it("reports bad rows in place and leaves rows not applicable unselected", () => {
  const rows = parse(
    csv(
      "A,,10x,,,,,,,,,,",
      "B,,100,,,,,,",
      "C,,100,,,,,,N/A,,,,",
      "D,,100,,,,,,Not installed on S/N 2,,,,",
      "E,,100,,,,,,,,,,",
    ),
  );
  expect(
    rows.map(({ row, error, selected }) => [row, error, selected]),
  ).toEqual([
    [2, "Invalid number in hours.", false],
    [3, "Column count does not match the header.", false],
    [4, "", false],
    [5, "", false],
    [6, "", true],
  ]);
});

it.each([
  ["name", 200],
  ["group", 150],
  ["description", 10000],
  ["conditions", 2000],
])("accepts a %s of up to %i characters", (key, max) => {
  const parses = (length: number) =>
    inspectionTemplateSchema.safeParse({
      ...sample(),
      [key]: "A".repeat(length),
    }).success;
  expect(parses(max)).toBe(true);
  expect(parses(max + 1)).toBe(false);
});
it("reads a template CSV file of up to 2 MiB", () => {
  expect(TEMPLATE_CSV_MAX_BYTES).toBe(2 * 1024 * 1024);
});
