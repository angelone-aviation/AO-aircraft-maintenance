/**
 * Responsibility: Pins the inspection template CSV import against the C441
 *   source sheet, and its field errors.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: node:fs; src/domain/inspectionTemplates.ts, ./maintenanceCsv,
 *   tests/fixtures/c441-inspections-source.csv.
 */
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { readCsv } from "./maintenanceCsv";
import { parseTemplateCsv } from "./inspectionTemplates";

const SOURCE_CSV = "tests/fixtures/c441-inspections-source.csv";
const SOURCE_ROWS = 59;
const C441 = {
  kind: "aircraft" as const,
  manufacturer: "Cessna",
  model: "441",
  partNumber: "",
};

it("imports the supplied C441 inspection CSV without losing descriptions or intervals", () => {
  const csv = readFileSync(SOURCE_CSV, "utf8");
  const rows = parseTemplateCsv(csv, C441, "C441");
  expect(
    rows.filter((r) => r.error).map((r) => ({ row: r.row, error: r.error })),
  ).toEqual([]);
  expect(rows).toHaveLength(SOURCE_ROWS);
  const [headers, ...source] = readCsv(csv);
  for (const [i, row] of rows.entries()) {
    const original = Object.fromEntries(
      headers.map((h, index) => [h, source[i][index]]),
    );
    expect(row.template!.description).toBe(original.description);
    expect(row.template!.name).toBe(original.name);
    for (const [column, field] of [
      ["hours", "hours"],
      ["cycles", "cycles"],
      ["calendar_value", "calendarValue"],
      ["initial_hours", "initialHours"],
      ["initial_cycles", "initialCycles"],
    ] as const)
      expect(row.template![field]).toBe(numberIn(original[column]));
  }
  const event = rows.find(
    (r) => r.template?.name === "C441 Hard or Overweight Landing Check",
  )!.template!;
  expect(event.conditions).toBe(event.description);
  expect(event.hours).toBeUndefined();
  expect(event.calendarValue).toBeUndefined();
  expect(rows[0].template!.calendarUnit).toBe("MONTHS");
});

it("still rejects unknown units and empty requirements with readable field errors", () => {
  const header =
    "name,description,hours,cycles,calendar_value,calendar_unit,initial_hours,initial_cycles,conditions,requirement_type,time_basis,hour_mode,cycle_mode";
  const rows = parseTemplateCsv(
    `${header}\nBad unit,Description,100,,12,fortnights,,,,,,,\nEmpty,,,,,,,,,,,,`,
    C441,
    "",
  );
  expect(rows[0].error).toContain("calendarUnit:");
  expect(rows[0].template).toBeUndefined();
  expect(rows[1].error).toContain("Enter an interval");
});

const numberIn = (cell: string) => (cell ? Number(cell) : undefined);
