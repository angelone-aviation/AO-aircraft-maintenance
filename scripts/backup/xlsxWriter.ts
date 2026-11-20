/**
 * Responsibility: Writes the records workbook's sheets to an .xlsx file: cell
 *   values, styles, row heights, frozen panes, filters and print setup.
 * Layer: Script. Node only; lays out the sheets it is given, knows no records.
 * Dependencies: exceljs.
 *
 * Every table sheet has a title row and a header row above its data.
 */
import ExcelJS from "exceljs";

/** Excel's row limit, less the title and header rows of each sheet. */
export const MAX_DATA_ROWS = 1_048_576 - 2;
// Excel holds at most 32,767 characters in a cell; the rest is the note.
const MAX_CELL_TEXT = 32_000;
const LINE_POINTS = 13;
// Excel's tallest row.
const MAX_ROW_POINTS = 409;

/** A cell's value. Empty text, a non-finite number or an invalid date is
 * written blank; text over 32,000 characters is shortened, with a note. */
export type Cell = string | number | Date | null | undefined;
/** A status colour: red, amber or green. */
export type Tone = "bad" | "warn" | "good";
/** A column's number format; "wrap" is text that wraps. */
export type Fmt =
  | "text"
  | "wrap"
  | "date"
  | "datetime"
  | "hours"
  | "count"
  | "money"
  | "amount";

/** A table column; `width` is in characters. */
export interface Column {
  header: string;
  width: number;
  fmt?: Fmt;
}

/** A data row. */
export interface Row {
  cells: Cell[];
  /** Red and amber fill the whole row; green marks only the status cell. */
  tone?: Tone;
  statusColumn?: number;
}

/** A table sheet; Read me lists it with `about` and `count`. */
export interface SheetSpec {
  name: string;
  title: string;
  about: string;
  columns: Column[];
  /** Read once, while the sheet is written. */
  rows: Iterable<Row>;
  count: number;
  freezeFirstColumn?: boolean;
}

/** Read me's own content; the writer adds the index of sheets after it. */
export interface ReadMe {
  title: string;
  facts: [string, string][];
  /** What each colour means: the tone, a label and the explanation. */
  legend: [Tone, string, string][];
}

/** A workbook to write. */
export interface Workbook {
  /** The .xlsx file. */
  out: string;
  /** When the copy is made, stored in the file. */
  now: number;
  /** The same time as text, for every page footer. */
  made: string;
  /** Shown after each table sheet's title. */
  subtitle: string;
  readMe: ReadMe;
  sheets: SheetSpec[];
}

/**
 * Writes Read me, then each table sheet in order, streaming rows to disk.
 *
 * @returns Rows written per sheet, Read me first, counted as the sheets it
 *   lists.
 * @throws {Error} From exceljs, when `out` cannot be written.
 */
export async function writeWorkbook(
  book: Workbook,
): Promise<{ name: string; rows: number }[]> {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: book.out,
    useStyles: true,
    // Shared strings are the form every spreadsheet app reads, line breaks
    // included; they are held in memory until the file is written.
    useSharedStrings: true,
  });
  wb.creator = "Angel One";
  wb.created = new Date(book.now);
  wb.modified = new Date(book.now);
  writeReadMe(wb, book);
  const written = [{ name: "Read me", rows: book.sheets.length }];
  for (const spec of book.sheets)
    written.push({
      name: spec.name,
      rows: writeSheet(wb, spec, book.made, book.subtitle),
    });
  await wb.commit();
  return written;
}

type WorkbookWriter = ExcelJS.stream.xlsx.WorkbookWriter;
type Style = Partial<ExcelJS.Style>;

const COLOURS: Record<Tone, { fill: string; font: string }> = {
  bad: { fill: "FFF8D7DA", font: "FF842029" },
  warn: { fill: "FFFFF3CD", font: "FF664D03" },
  good: { fill: "FFD1E7DD", font: "FF0F5132" },
};
const FORMATS: Record<Fmt, string> = {
  text: "General",
  wrap: "General",
  date: "mmm d, yyyy",
  datetime: "mmm d, yyyy hh:mm",
  hours: "#,##0.0",
  count: "#,##0",
  money: "$#,##0.00",
  amount: "#,##0.00",
};
const thin = { style: "thin" as const, color: { argb: "FFD0D5DD" } };
const border = { top: thin, left: thin, bottom: thin, right: thin };
const styles = new Map<string, Style>();
const titleStyle: Style = {
  font: { name: "Calibri", size: 14, bold: true, color: { argb: "FF1F2A44" } },
  alignment: { vertical: "middle" },
};
const subtitleStyle: Style = {
  font: {
    name: "Calibri",
    size: 10,
    italic: true,
    color: { argb: "FF4A5568" },
  },
  alignment: { vertical: "top" },
};
const headerStyle: Style = {
  font: { name: "Calibri", size: 10, bold: true, color: { argb: "FF1F2A44" } },
  fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDE4EE" } },
  alignment: { vertical: "middle", wrapText: true },
  border: {
    ...border,
    bottom: { style: "medium", color: { argb: "FF7A8699" } },
  },
};
const labelStyle: Style = {
  font: { name: "Calibri", size: 10, bold: true },
  alignment: { vertical: "top", wrapText: true },
};
const bodyStyle: Style = {
  font: { name: "Calibri", size: 10 },
  alignment: { vertical: "top", wrapText: true },
};
const README_COLUMNS: Column[] = [
  { header: "", width: 26, fmt: "wrap" },
  { header: "", width: 84, fmt: "wrap" },
  { header: "", width: 10 },
];

// One shared object per style: exceljs caches style IDs by object identity.
function style(fmt: Fmt, tone?: Tone, strong = false): Style {
  const key = `${fmt}|${tone ?? ""}|${strong}`;
  const cached = styles.get(key);
  if (cached) return cached;
  const made = buildStyle(fmt, tone, strong);
  styles.set(key, made);
  return made;
}

function buildStyle(fmt: Fmt, tone: Tone | undefined, strong: boolean) {
  return {
    numFmt: FORMATS[fmt],
    font: {
      name: "Calibri",
      size: 10,
      bold: strong,
      ...(tone && strong ? { color: { argb: COLOURS[tone].font } } : {}),
    },
    alignment: {
      vertical: "top" as const,
      wrapText: fmt === "wrap",
      horizontal: ["hours", "count", "money", "amount"].includes(fmt)
        ? ("right" as const)
        : ("left" as const),
    },
    border,
    ...(tone
      ? {
          fill: {
            type: "pattern" as const,
            pattern: "solid" as const,
            fgColor: { argb: COLOURS[tone].fill },
          },
        }
      : {}),
  };
}

function cellValue(v: Cell): ExcelJS.CellValue {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  // XML 1.0 holds tab, line feed, carriage return, U+0020-U+D7FF,
  // U+E000-U+FFFD and surrogate pairs: pairs are kept, all else dropped.
  const text = v.replace(
    /[\ud800-\udbff][\udc00-\udfff]|[^\t\n\r\u0020-\ud7ff\ue000-\ufffd]/g,
    (unit) => (unit.length === 2 ? unit : ""),
  );
  return text.length > MAX_CELL_TEXT
    ? text.slice(0, MAX_CELL_TEXT) +
        "\n… (shortened here; the off-site backup holds the full record)"
    : text;
}

// Row heights are set from the text, because spreadsheet apps differ in
// whether they fit wrapped rows when a file opens. Estimates err taller.
function rowHeight(columns: Column[], cells: Cell[]) {
  const lines = Math.max(1, ...columns.map((c, i) => countLines(c, cells[i])));
  return lines > 1
    ? Math.min(MAX_ROW_POINTS, lines * LINE_POINTS + 4)
    : undefined;
}

// A line per line break; in a wrapped column, a long line takes one more for
// about every 1.1 characters of column width it spans.
function countLines(column: Column, value: Cell) {
  if (typeof value !== "string" || !value) return 1;
  const segments = value.slice(0, MAX_CELL_TEXT).split("\n");
  if (column.fmt !== "wrap") return segments.length;
  const perLine = Math.max(4, Math.floor(column.width * 1.1));
  return segments.reduce(
    (sum, s) => sum + Math.max(1, Math.ceil(s.length / perLine)),
    0,
  );
}

function pageOptions(sheet: string, made: string, table = true) {
  return {
    pageSetup: {
      orientation: table ? ("landscape" as const) : ("portrait" as const),
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      // The title and header rows repeat on every printed page.
      ...(table ? { printTitlesRow: "1:2" } : {}),
      margins: {
        left: 0.4,
        right: 0.4,
        top: 0.5,
        bottom: 0.6,
        header: 0.25,
        footer: 0.3,
      },
    },
    headerFooter: {
      oddFooter: `&L&8Angel One records, ${made}&C&8${sheet.replaceAll("&", "&&")}&R&8Page &P of &N`,
    },
  };
}

function writeSheet(
  wb: WorkbookWriter,
  spec: SheetSpec,
  made: string,
  subtitle: string,
) {
  const ws = wb.addWorksheet(spec.name, {
    views: [
      {
        state: "frozen",
        xSplit: spec.freezeFirstColumn ? 1 : 0,
        ySplit: 2,
      },
    ],
    ...pageOptions(spec.name, made),
  });
  ws.columns = spec.columns.map((c) => ({ width: c.width }));
  writeTitle(ws.getRow(1), spec.title, subtitle);
  writeHeader(ws.getRow(2), spec.columns);
  let n = 0;
  for (const row of spec.rows) writeRow(ws.getRow(3 + n++), spec.columns, row);
  ws.autoFilter = {
    from: { row: 2, column: 1 },
    to: { row: 2 + n, column: spec.columns.length },
  };
  ws.commit();
  return n;
}

// One cell, so the text runs across the empty cells to its right.
function writeTitle(r: ExcelJS.Row, title: string, subtitle: string) {
  const richText = [
    { font: titleStyle.font, text: title },
    { font: subtitleStyle.font, text: `    ${subtitle}` },
  ];
  // exceljs keys shared strings by String(value); give each title its own
  // key, or every sheet would show the first sheet's title.
  r.getCell(1).value = {
    richText,
    toString: () => richText.map((t) => t.text).join(""),
  } as ExcelJS.CellRichTextValue;
  r.getCell(1).style = titleStyle;
  r.height = 24;
  r.commit();
}

function writeHeader(r: ExcelJS.Row, columns: Column[]) {
  columns.forEach((c, i) => {
    const cell = r.getCell(i + 1);
    cell.value = c.header;
    cell.style = headerStyle;
  });
  r.height = 30;
  r.commit();
}

function writeRow(r: ExcelJS.Row, columns: Column[], row: Row) {
  const rowTone = row.tone && row.tone !== "good" ? row.tone : undefined;
  columns.forEach((c, i) => {
    const cell = r.getCell(i + 1);
    cell.value = cellValue(row.cells[i]);
    const status = i === row.statusColumn;
    cell.style = style(
      c.fmt ?? "text",
      status ? row.tone : rowTone,
      status && !!row.tone,
    );
  });
  finishRow(r, columns, row.cells);
}

function finishRow(r: ExcelJS.Row, columns: Column[], cells: Cell[]) {
  const height = rowHeight(columns, cells);
  if (height) r.height = height;
  r.commit();
}

type Line = [Cell[], Style[]];

// The title, facts and colour legend, then a filterable index of the sheets.
function writeReadMe(wb: WorkbookWriter, { made, readMe, sheets }: Workbook) {
  const ws = wb.addWorksheet("Read me", {
    views: [{ showGridLines: false }],
    ...pageOptions("Read me", made, false),
  });
  ws.columns = README_COLUMNS.map((c) => ({ width: c.width }));
  const intro = listIntro(readMe);
  const index = listSheetIndex(sheets);
  [...intro, ...index].forEach(([cells, cellStyles], i) =>
    writeLine(ws.getRow(i + 1), cells, cellStyles),
  );
  ws.autoFilter = {
    from: { row: intro.length + 1, column: 1 },
    to: { row: intro.length + index.length, column: 3 },
  };
  ws.commit();
}

function listIntro({ title, facts, legend }: ReadMe): Line[] {
  return [
    [[title], [titleStyle]],
    ...facts.map((fact): Line => [fact, [labelStyle, bodyStyle]]),
    [[], []],
    [["Colours"], [labelStyle]],
    ...legend.map(([tone, label, text]): Line => [
      [label, text],
      [style("text", tone, true), bodyStyle],
    ]),
    [[], []],
  ];
}

function listSheetIndex(sheets: SheetSpec[]): Line[] {
  return [
    [
      ["Sheet", "What it shows", "Rows"],
      [headerStyle, headerStyle, headerStyle],
    ],
    ...sheets.map((s): Line => [
      [s.name, s.about, s.count],
      [style("text"), style("wrap"), style("count")],
    ]),
  ];
}

function writeLine(r: ExcelJS.Row, cells: Cell[], cellStyles: Style[]) {
  cells.forEach((v, i) => {
    r.getCell(i + 1).value = cellValue(v);
    if (cellStyles[i]) r.getCell(i + 1).style = cellStyles[i];
  });
  finishRow(r, README_COLUMNS, cells);
}
