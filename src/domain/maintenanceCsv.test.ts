/**
 * Responsibility: Pins the CSV reader and the manual schedule import: header
 *   and row checks, error labels, limits and the candidates produced.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/maintenanceCsv.ts, ./csv, ./taskCards,
 *   ./rejection, src/data/demo.ts (seed), tests/fixtures/taskCards.ts.
 */
import { expect, it } from "vitest";
import {
  CSV_MAX_BYTES,
  CSV_MAX_MEGABYTES,
  csvSourceKey,
  decodeCsvFile,
  importHeaders,
  parseMaintenanceCsv,
  readCsv,
  readCsvRows,
  type ImportKind,
} from "./maintenanceCsv";
import { Rejection } from "./rejection";
import { toCsv } from "./csv";
import { demoSnapshot } from "../data/demo";
import { taskCardCommand } from "../../tests/fixtures/taskCards";
import { saveTaskCard } from "./taskCards";
import type { Manual } from "./manuals";
const manual: Manual = {
  uuid: crypto.randomUUID(),
  aircraftUuid: "demo-206",
  title: "Test",
  documentNumber: "",
  revision: "1",
  revisionDate: "",
  filename: "test.pdf",
  size: 100,
  pageCount: 100,
  uploadedAt: 0,
  uploadedBy: "test",
};
const csv = (kind: ImportKind, rows: Record<string, unknown>[]) =>
  toCsv(
    rows.map((row) => ({
      ...Object.fromEntries(importHeaders[kind].map((h) => [h, ""])),
      ...row,
    })),
  );
it("reads UTF-8 BOM, CRLF, quoted commas/newlines and doubled quotes without executing text", () => {
  expect(
    readCsv(
      '\uFEFFid,description\r\np2,"Inspect vents, then\ncheck ""A""."\r\n',
    ),
  ).toEqual([
    ["id", "description"],
    ["p2", 'Inspect vents, then\ncheck "A".'],
  ]);
  expect(readCsv("id,text\nx,=1+1")).toEqual([
    ["id", "text"],
    ["x", "=1+1"],
  ]);
  expect(() => readCsv('id,text\nx,"unfinished')).toThrow("unclosed");
  expect(() => readCsv('id,text\nx,"bad"suffix')).toThrow("closing quote");
});
it("preserves initial/repeat thresholds, component bases and parent-linked task source pages", () => {
  const batch = parseMaintenanceCsv(
    {
      inspections: csv("inspections", [
        {
          id: "phase-8",
          name: "Phase 8",
          description: "Check lines",
          initial_hours: 1900,
          repeat_hours: 600,
          pdf_page: 79,
          conditions: "After initial compliance",
        },
      ]),
      components: csv("components", [
        {
          id: "pump",
          name: "Pump",
          component_model: "P100",
          part_number: "P1",
          requirement_type: "overhaul",
          hour_limit: 1000,
          calendar_value: 3,
          calendar_unit: "YEARS",
          time_basis: "TSO",
          hour_mode: "ABSOLUTE",
          cycle_mode: "FROM_LAST_COMPLIED",
          pdf_page: 62,
        },
      ]),
      tasks: csv("tasks", [
        {
          id: "phase-8-lines",
          parent_type: "inspection",
          parent_id: "phase-8",
          item_code: "B291002",
          instruction: 'Perform "pressure" test, inspect\nconnections.',
          applicability: "Applicable equipment only",
          pdf_page: 80,
        },
      ]),
    },
    manual,
  );
  expect(batch.errors).toEqual([]);
  expect(batch.inspections[0]).toMatchObject({
    initialHours: 1900,
    hours: 600,
    sourceKey: csvSourceKey(manual.uuid, "inspection", "phase-8"),
  });
  expect(batch.components[0].requirementDefaults).toMatchObject({
    timeBasis: "TSO",
    timeLimitMode: "ABSOLUTE",
    calendarIntervalValue: 3,
    calendarIntervalUnit: "YEARS",
  });
  expect(batch.tasks[0]).toMatchObject({
    parentId: "phase-8",
    itemCode: "B291002",
    reference: { pdfPage: 80 },
  });
  expect(batch.tasks[0].instruction).toContain("\nconnections.");
});
it("reports incorrect headers, duplicate IDs, invalid values, column counts and page bounds", () => {
  expect(
    parseMaintenanceCsv({ inspections: "id,name\nx,Test" }, manual).errors[0],
  ).toContain("Headers");
  const row = { id: "p2", name: "Phase 2", description: "Test", pdf_page: 1 };
  expect(
    parseMaintenanceCsv({ inspections: csv("inspections", [row, row]) }, manual)
      .errors[0],
  ).toContain("Duplicate ID");
  for (const repeat_hours of [
    "N/A",
    "1,000",
    "100 hours",
    "-100",
    "0",
    "Infinity",
    "1e3",
    "10.25",
  ]) {
    expect(
      parseMaintenanceCsv(
        { inspections: csv("inspections", [{ ...row, repeat_hours }]) },
        manual,
      ).errors.length,
    ).toBeGreaterThan(0);
  }
  expect(
    parseMaintenanceCsv(
      { inspections: csv("inspections", [{ ...row, pdf_page: 101 }]) },
      manual,
    ).errors[0],
  ).toContain("PDF page");
  expect(
    parseMaintenanceCsv(
      { inspections: importHeaders.inspections.join(",") + "\nx,Test" },
      manual,
    ).errors[0],
  ).toContain("fields");
});
it("keeps unknown values blank and validates calendar units without rounding them", () => {
  const batch = parseMaintenanceCsv(
    {
      inspections: csv("inspections", [
        {
          id: "event",
          name: "Event inspection",
          description: "Check after event",
          pdf_page: 1,
        },
      ]),
    },
    manual,
  );
  expect(batch.errors).toEqual([]);
  expect(batch.inspections[0].hours).toBeUndefined();
  expect(batch.inspections[0].months).toBeUndefined();
});
it("rejects oversized or excessive-row files", () => {
  expect(() => readCsv("x".repeat(2 * 1024 * 1024 + 1))).toThrow("2 MiB");
  expect(() => readCsv("id\n" + "x\n".repeat(2001))).toThrow("2,000");
});
it("reads text up to the exported default size", () => {
  expect(readCsv("x".repeat(CSV_MAX_BYTES))).toHaveLength(1);
  expect(() => readCsv("x".repeat(CSV_MAX_BYTES + 1))).toThrow(
    `CSV files must be at most ${CSV_MAX_MEGABYTES} MiB.`,
  );
});
it("deduplicates imported tasks per saved parent while allowing the same source for another parent", () => {
  const s = demoSnapshot();
  const c = taskCardCommand();
  c.fields.sourceKey = "manual:csv:task:step1";
  c.fields.inspectionUuid = s.inspections[0].uuid;
  const saved = saveTaskCard(s, c);
  expect(saved.status).toBe("draft");
  expect(saved.technicianSignoff).toBeNull();
  expect(() => saveTaskCard(s, { ...c, uuid: crypto.randomUUID() })).toThrow(
    "already been imported",
  );
  const other = {
    ...c,
    uuid: crypto.randomUUID(),
    fields: { ...c.fields, inspectionUuid: s.inspections[1].uuid },
  };
  expect(saveTaskCard(s, other).inspectionUuid).toBe(s.inspections[1].uuid);
  s.user = { ...s.user, isAdmin: false, groupIds: [] };
  expect(() => saveTaskCard(s, { ...c, uuid: crypto.randomUUID() })).toThrow(
    "access denied",
  );
});
it("reports spreadsheet rows, counting blank rows the reader skips", () => {
  expect(readCsvRows('id\n\nx\r\n\n"y\nz"\nw')).toEqual([
    { cells: ["id"], row: 1 },
    { cells: ["x"], row: 3 },
    { cells: ["y\nz"], row: 5 },
    { cells: ["w"], row: 6 },
  ]);
  const [header, record] = csv("inspections", [
    { id: "p2", name: "", description: "Test", pdf_page: 1 },
  ]).split("\r\n");
  expect(
    parseMaintenanceCsv(
      { inspections: `${header}\r\n\r\n\r\n${record}` },
      manual,
    ).errors[0],
  ).toContain("inspections, row 4:");
});

it("refuses unreadable files as a Rejection", () => {
  for (const [text, message] of [
    ["x".repeat(1024 * 1024 + 1), "CSV files must be at most 1 MiB."],
    ["id\na\nb\nc", "Use at most 2 records per CSV file."],
    ['id\nx"y', "Unexpected quote in CSV."],
    ['id\n"x"y', "Unexpected text after a closing quote."],
    ['id\n"x', "CSV contains an unclosed quoted field."],
  ]) {
    const read = () => readCsvRows(text, { maxMegabytes: 1, maxRecords: 2 });
    expect(read).toThrow(Rejection);
    expect(read).toThrow(message);
  }
  expect(readCsvRows("id\na\nb", { maxRecords: 2 })).toHaveLength(3);
});

it("labels file and row errors and keeps reading the other files", () => {
  const row = { id: "p2", name: "Phase 2", description: "Test", pdf_page: 1 };
  const batch = parseMaintenanceCsv(
    {
      inspections: importHeaders.inspections.join(","),
      components: "id\nx",
      tasks: csv("tasks", [
        {
          id: "t1",
          parent_type: "inspection",
          parent_id: "p2",
          instruction: "",
        },
        {
          id: "t1",
          parent_type: "inspection",
          parent_id: "p2",
          instruction: "Do",
          pdf_page: 2,
        },
      ]),
    },
    manual,
  );
  expect(batch.errors).toEqual([
    "inspections: The file contains headers but no records.",
    `components: Headers must be exactly: ${importHeaders.components.join(",")}`,
    expect.stringMatching(/^tasks, row 2: /),
    "tasks, row 3: Duplicate ID: t1",
  ]);
  expect(batch.tasks).toEqual([]);
  expect(
    parseMaintenanceCsv({ inspections: csv("inspections", [row]) }, manual),
  ).toMatchObject({
    inspections: [{ importId: "p2" }],
    components: [],
    tasks: [],
    errors: [],
  });
});

it("maps component limits, calendar units and conditions", () => {
  const component = (row: Record<string, unknown>) =>
    parseMaintenanceCsv(
      {
        components: csv("components", [
          {
            id: "pump",
            name: "Pump",
            requirement_type: "life_limit",
            calendar_unit: "MONTHS",
            time_basis: "TSN",
            hour_mode: "ABSOLUTE",
            cycle_mode: "ABSOLUTE",
            pdf_page: 1,
            ...row,
          },
        ]),
      },
      manual,
    );
  expect(
    ["YEARS", "MONTHS", "DAYS"].map(
      (calendar_unit) =>
        component({ calendar_value: 2, calendar_unit }).components[0].months,
    ),
  ).toEqual([24, 2, undefined]);
  expect(
    ["life_limit", "overhaul", "inspection"].map(
      (requirement_type) =>
        component({ requirement_type }).components[0].requirementDefaults
          ?.requirementType,
    ),
  ).toEqual(["Life Limits", "Overhaul Requirement", "Inspection Requirement"]);
  expect(
    component({ description: "Replace", conditions: "If leaking" })
      .components[0],
  ).toMatchObject({
    text: "Replace\n\nConditions: If leaking",
    scheduleText: "If leaking",
    warnings: ["If leaking"],
  });
  expect(
    component({ description: "d".repeat(9990), conditions: "c" }).errors,
  ).toEqual([
    "components, row 2: Description plus conditions must fit within 10,000 characters.",
  ]);
  expect(component({ cycle_limit: "5.5" }).errors[0]).toContain(
    "Use a positive whole number, at most 1,000,000.",
  );
});

it("caps an inspection's description plus conditions at 2,000 characters", () => {
  const inspection = (conditions: string) =>
    parseMaintenanceCsv(
      {
        inspections: csv("inspections", [
          {
            id: "p",
            name: "P",
            description: "d".repeat(1800),
            conditions,
            pdf_page: 1,
          },
        ]),
      },
      manual,
    ).errors;
  expect(inspection("c".repeat(186))).toEqual([]);
  expect(inspection("c".repeat(187))).toEqual([
    "inspections, row 2: Description plus conditions must fit within 2,000 characters.",
  ]);
});

it("decodes a UTF-8 file, dropping its byte-order mark", () => {
  const bytes = new TextEncoder().encode(
    "\uFEFFname\nInspección §91.409 – 12 mo",
  );
  expect(decodeCsvFile(bytes)).toBe("name\nInspección §91.409 – 12 mo");
  expect(decodeCsvFile(bytes.buffer)).toBe("name\nInspección §91.409 – 12 mo");
});
it("refuses a Windows-1252 file instead of reading replacement characters", () => {
  // "Inspección §91.409 – 12 mo" as Excel's plain CSV writes it.
  const cp1252 = Uint8Array.from([
    ...new TextEncoder().encode("Inspecci"),
    0xf3,
    ...new TextEncoder().encode("n "),
    0xa7,
    ...new TextEncoder().encode("91.409 "),
    0x96,
    ...new TextEncoder().encode(" 12 mo"),
  ]);
  expect(() => decodeCsvFile(cp1252)).toThrow(
    new Rejection(
      'This file is not UTF-8 text. Save it as "CSV UTF-8 (Comma delimited)" in Excel, or as CSV with UTF-8 encoding in another spreadsheet, and choose it again.',
    ),
  );
});
