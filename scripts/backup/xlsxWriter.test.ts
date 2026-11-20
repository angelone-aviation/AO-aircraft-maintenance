/**
 * Responsibility: Pins the records workbook's writer: cell values, row
 *   colours and heights, the table layout and Read me's index.
 * Layer: Test. Vitest suite (Node); never shipped in the build.
 * Dependencies: scripts/backup/xlsxWriter.ts, exceljs.
 */
// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MAX_DATA_ROWS, writeWorkbook, type SheetSpec } from "./xlsxWriter";

const NOTE = "\n… (shortened here; the off-site backup holds the full record)";
const RED = "FFF8D7DA";
const GREEN = "FFD1E7DD";
const ITEMS: SheetSpec = {
  name: "Items",
  title: "Items",
  about: "Every item.",
  columns: [
    { header: "Status", width: 10 },
    { header: "Note", width: 10, fmt: "wrap" },
    { header: "When", width: 12, fmt: "date" },
  ],
  rows: [
    {
      cells: ["Overdue", "", new Date(Number.NaN)],
      tone: "bad",
      statusColumn: 0,
    },
    { cells: ["OK", "a\nb\nc", Infinity], tone: "good", statusColumn: 0 },
    { cells: ["Long", "x".repeat(32_001)] },
    { cells: ["Fits", "y".repeat(32_000)] },
  ],
  count: 4,
};
let dir: string;
let written: { name: string; rows: number }[];
let wb: ExcelJS.Workbook;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "xlsx-writer-"));
  const out = path.join(dir, "book.xlsx");
  written = await writeWorkbook({
    out,
    now: Date.UTC(2026, 10, 4),
    made: "Nov 4, 2026 10:30",
    subtitle: "Times in UTC",
    readMe: {
      title: "Read this",
      facts: [["Made", "Today"]],
      legend: [["bad", "Overdue", "Act now."]],
    },
    sheets: [ITEMS],
  });
  wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const items = () => wb.getWorksheet("Items")!;
const values = (ws: ExcelJS.Worksheet, row: number) =>
  [1, 2, 3].map((c) => ws.getRow(row).getCell(c).value);
const fill = (c: ExcelJS.Cell) =>
  (c.fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb;

it("writes Read me first and returns the rows of each sheet", () => {
  expect(wb.worksheets.map((ws) => ws.name)).toEqual(["Read me", "Items"]);
  expect(written).toEqual([
    { name: "Read me", rows: 1 },
    { name: "Items", rows: 4 },
  ]);
});

it("puts the title and header rows above the data", () => {
  const title = items().getRow(1).getCell(1).value as ExcelJS.CellRichTextValue;
  expect(title.richText.map((r) => r.text).join("")).toBe(
    "Items    Times in UTC",
  );
  expect(values(items(), 2)).toEqual(["Status", "Note", "When"]);
  expect(items().getRow(3).getCell(1).value).toBe("Overdue");
  expect(MAX_DATA_ROWS).toBe(1_048_576 - 2);
});

it("writes empty text, a non-finite number and an invalid date blank", () => {
  expect(values(items(), 3)).toEqual(["Overdue", null, null]);
  expect(values(items(), 4)).toEqual(["OK", "a\nb\nc", null]);
});

it("shortens text over 32,000 characters, with a note", () => {
  expect(items().getRow(5).getCell(2).value).toBe("x".repeat(32_000) + NOTE);
  expect(items().getRow(6).getCell(2).value).toBe("y".repeat(32_000));
});

it("fills a red row; green marks only the status cell, in bold", () => {
  const [overdue, ok] = [items().getRow(3), items().getRow(4)];
  expect([1, 2, 3].map((c) => fill(overdue.getCell(c)))).toEqual([
    RED,
    RED,
    RED,
  ]);
  expect(fill(ok.getCell(1))).toBe(GREEN);
  expect(ok.getCell(1).font.bold).toBe(true);
  expect(fill(ok.getCell(2))).toBeUndefined();
});

it("sizes rows to their wrapped text, up to Excel's tallest row", () => {
  expect(items().getRow(3).height).toBeUndefined();
  expect(items().getRow(4).height).toBe(3 * 13 + 4);
  expect(items().getRow(5).height).toBe(409);
});

it("lays out Read me: title, facts, legend, then an index of the sheets", () => {
  const readMe = wb.getWorksheet("Read me")!;
  const rows = Array.from({ length: 8 }, (_, i) => values(readMe, i + 1));
  expect(rows).toEqual([
    ["Read this", null, null],
    ["Made", "Today", null],
    [null, null, null],
    ["Colours", null, null],
    ["Overdue", "Act now.", null],
    [null, null, null],
    ["Sheet", "What it shows", "Rows"],
    ["Items", "Every item.", 4],
  ]);
  expect(fill(readMe.getRow(5).getCell(1))).toBe(RED);
  expect(readMe.autoFilter).toBe("A7:C8");
});
