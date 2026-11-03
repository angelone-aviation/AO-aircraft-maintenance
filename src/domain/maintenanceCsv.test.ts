import { expect, it } from "vitest";
import {
  csvSourceKey,
  importHeaders,
  parseMaintenanceCsv,
  readCsv,
  readCsvRows,
  type ImportKind,
} from "./maintenanceCsv";
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
  expect(() => readCsv("x".repeat(2 * 1024 * 1024 + 1))).toThrow("2 MB");
  expect(() => readCsv("id\n" + "x\n".repeat(2001))).toThrow("2,000");
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
