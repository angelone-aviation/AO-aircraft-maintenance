/**
 * Responsibility: Imports a manual's maintenance schedule from CSV files
 *   (inspections, component limits and their tasks) as candidates to review,
 *   and the RFC 4180 CSV reader every CSV import shares.
 * Layer: Domain. Pure parsing; no I/O, no React.
 * Dependencies: zod, ./manuals, ./manualDiscovery, ./rejection.
 */
import type { Manual } from "./manuals";
import type { ManualCandidate } from "./manualDiscovery";
import { z } from "zod";
import { Rejection } from "./rejection";

const NUMBER_MAX = 1000000;
const INSPECTION_TEXT_MAX = 2000;
const COMPONENT_TEXT_MAX = 10000;

/** The largest CSV file {@link readCsvRows} reads by default, in megabytes. */
export const CSV_MAX_MEGABYTES = 2;

/**
 * The same limit in bytes. {@link readCsvRows} measures the decoded text,
 * which is never longer than the file's UTF-8 bytes, so a file within this
 * limit passes its size check.
 */
export const CSV_MAX_BYTES = CSV_MAX_MEGABYTES * 1024 * 1024;

const REQUIREMENT_TYPES = {
  life_limit: "Life Limits",
  overhaul: "Overhaul Requirement",
  inspection: "Inspection Requirement",
} as const;

/** The exact columns of each import file, in order. */
export const importHeaders = {
  inspections: [
    "id",
    "name",
    "description",
    "initial_hours",
    "initial_cycles",
    "repeat_hours",
    "repeat_cycles",
    "repeat_months",
    "conditions",
    "section",
    "printed_page",
    "pdf_page",
  ],
  components: [
    "id",
    "name",
    "description",
    "component_model",
    "manufacturer",
    "part_number",
    "requirement_type",
    "hour_limit",
    "cycle_limit",
    "calendar_value",
    "calendar_unit",
    "time_basis",
    "hour_mode",
    "cycle_mode",
    "conditions",
    "section",
    "printed_page",
    "pdf_page",
  ],
  tasks: [
    "id",
    "parent_type",
    "parent_id",
    "item_code",
    "instruction",
    "applicability",
    "section",
    "printed_page",
    "pdf_page",
  ],
} as const;

/** One of the three import files. */
export type ImportKind = keyof typeof importHeaders;

/** A task instruction read from the tasks file, linked to its parent row. */
export interface ImportedTask {
  id: string;
  parentType: "inspection" | "component_requirement";
  parentId: string;
  itemCode: string;
  instruction: string;
  applicability: string;
  sourceKey: string;
  reference: ManualCandidate["reference"];
}

/** Everything read from one import: candidates per file, and every error. */
export interface ImportBatch {
  inspections: ManualCandidate[];
  components: ManualCandidate[];
  tasks: ImportedTask[];
  errors: string[];
}

/**
 * Keys an imported row by its manual and its own ID, so importing the same
 * file again finds the records it made before.
 *
 * @param manualUuid - The manual the CSV describes.
 * @param kind - The kind of row.
 * @param id - The row's ID column.
 * @returns "<manualUuid>:csv:<kind>:<id>".
 */
export const csvSourceKey = (
  manualUuid: string,
  kind: "inspection" | "component_requirement" | "task",
  id: string,
) => `${manualUuid}:csv:${kind}:${id}`;

/**
 * Reads CSV text into rows of cells, as {@link readCsvRows} does.
 *
 * @param text - The file's text.
 * @returns The non-blank records, header first.
 * @throws {Rejection} As {@link readCsvRows}.
 */
export function readCsv(text: string): string[][] {
  return readCsvRows(text).map((r) => r.cells);
}

/**
 * Reads CSV text with RFC 4180 quoting: commas, doubled quotes and line
 * breaks inside quoted fields, CRLF or LF line ends, and a leading BOM.
 *
 * @param text - The file's text.
 * @param limits - Largest file in megabytes (default 2), and most records
 *   after the header row (default 2,000).
 * @returns The non-blank records, header first, each with its 1-based
 *   spreadsheet row; blank rows are skipped but still counted.
 * @throws {Rejection} "CSV files must be at most N MB.", "Use at most N
 *   records per CSV file.", or a message naming a misplaced or unclosed quote.
 */
export function readCsvRows(
  text: string,
  { maxMegabytes = CSV_MAX_MEGABYTES, maxRecords = 2000 } = {},
): { cells: string[]; row: number }[] {
  if (text.length > maxMegabytes * 1024 * 1024)
    throw new Rejection(`CSV files must be at most ${maxMegabytes} MB.`);
  const body = text.replace(/^﻿/, "");
  const reader = new CsvReader(maxRecords);
  for (let i = 0; i < body.length; i++) i = reader.read(body, i);
  return reader.finish();
}

/**
 * Reads a manual's inspections, component limits and tasks from CSV files.
 * A bad file or row is reported and skipped; the rest are still read.
 *
 * @param files - The text of each file given; missing files are skipped.
 * @param manual - The manual the rows cite; PDF pages must be within it.
 * @returns The candidates in file order, and errors as "<kind>: <message>"
 *   for a file or "<kind>, row <n>: <message>" for a row.
 */
export function parseMaintenanceCsv(
  files: Partial<Record<ImportKind, string>>,
  manual: Manual,
): ImportBatch {
  const result: ImportBatch = {
    inspections: [],
    components: [],
    tasks: [],
    errors: [],
  };
  for (const kind of Object.keys(importHeaders) as ImportKind[]) {
    const file = files[kind];
    if (file === undefined) continue;
    try {
      parseImportFile(kind, file, manual, result);
    } catch (e) {
      result.errors.push(`${kind}: ${messageOf(e, "Invalid file")}`);
    }
  }
  return result;
}

type CsvRow = { cells: string[]; row: number };

// One pass over the text, a character at a time.
class CsvReader {
  private readonly rows: CsvRow[] = [];
  private rowNumber = 0;
  private row: string[] = [];
  private cell = "";
  private quoted = false;
  private closed = false;

  constructor(private readonly maxRecords: number) {}

  // Returns the index of the last character consumed.
  read(text: string, i: number): number {
    const ch = text[i];
    if (this.quoted) return this.readQuoted(text, i);
    if (ch === ",") this.finishCell();
    else if (ch === "\n" || ch === "\r") return this.readLineEnd(text, i);
    else if (ch === '"') this.openQuote();
    else this.appendUnquoted(ch);
    return i;
  }

  finish(): CsvRow[] {
    if (this.quoted)
      throw new Rejection("CSV contains an unclosed quoted field.");
    if (this.cell || this.row.length || this.closed) this.finishRow();
    return this.rows;
  }

  private readQuoted(text: string, i: number) {
    if (text[i] !== '"') {
      this.cell += text[i];
      return i;
    }
    if (text[i + 1] === '"') {
      this.cell += '"';
      return i + 1;
    }
    this.quoted = false;
    this.closed = true;
    return i;
  }

  private readLineEnd(text: string, i: number) {
    const end = text[i] === "\r" && text[i + 1] === "\n" ? i + 1 : i;
    this.finishRow();
    return end;
  }

  private openQuote() {
    if (this.cell || this.closed)
      throw new Rejection(
        "Unexpected quote in CSV. Quote the entire field and double embedded quotes.",
      );
    this.quoted = true;
  }

  private appendUnquoted(ch: string) {
    if (this.closed)
      throw new Rejection("Unexpected text after a closing quote.");
    this.cell += ch;
  }

  private finishCell() {
    this.row.push(this.cell);
    this.cell = "";
    this.closed = false;
  }

  // The header row is not a record, so one more row is allowed.
  private finishRow() {
    this.finishCell();
    this.rowNumber++;
    if (this.row.some((v) => v.trim()))
      this.rows.push({ cells: this.row, row: this.rowNumber });
    this.row = [];
    if (this.rows.length > this.maxRecords + 1)
      throw new Rejection(
        `Use at most ${this.maxRecords.toLocaleString("en-US")} records per CSV file.`,
      );
  }
}

const id = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/,
    "Use a stable ID of 1–80 letters, numbers, dots, underscores or hyphens.",
  );
const short = z.string().trim().min(1).max(200);
const text = z.string().trim().max(10000);

// Blank reads as undefined. Hours take one decimal place; counts are whole.
const numeric = (integer = false) =>
  z.string().transform((s, ctx) => {
    if (!s.trim()) return undefined;
    const message = numberIssue(s, integer);
    if (!message) return Number(s);
    ctx.addIssue({ code: "custom", message });
    return z.NEVER;
  });

const common = {
  id,
  section: z.string().trim().max(200),
  printed_page: z.string().trim().max(100),
  pdf_page: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().positive()),
};
const inspectionRow = z.object({
  ...common,
  name: short,
  description: z.string().trim().min(1).max(1800),
  conditions: z.string().trim().max(1000),
  initial_hours: numeric(),
  initial_cycles: numeric(true),
  repeat_hours: numeric(),
  repeat_cycles: numeric(true),
  repeat_months: numeric(true),
});
const componentRow = z.object({
  ...common,
  name: z.string().trim().min(1).max(100),
  description: text,
  component_model: z.string().trim().max(150),
  manufacturer: z.string().trim().max(150),
  part_number: z.string().trim().max(100),
  requirement_type: z.enum(["life_limit", "overhaul", "inspection"]),
  hour_limit: numeric(),
  cycle_limit: numeric(true),
  calendar_value: numeric(true),
  calendar_unit: z.enum(["DAYS", "MONTHS", "YEARS"]),
  time_basis: z.enum(["TSN", "TSO", "TSR"]),
  hour_mode: z.enum(["ABSOLUTE", "FROM_LAST_COMPLIED"]),
  cycle_mode: z.enum(["ABSOLUTE", "FROM_LAST_COMPLIED"]),
  conditions: z.string().trim().max(2000),
});
const taskRow = z.object({
  ...common,
  parent_type: z.enum(["inspection", "component_requirement"]),
  parent_id: id,
  item_code: z.string().trim().max(100),
  instruction: z.string().trim().min(1).max(9000),
  applicability: z.string().trim().max(1000),
});

type CommonRow = { pdf_page: number; section: string; printed_page: string };

function numberIssue(s: string, integer: boolean) {
  if (!/^\d+(?:\.\d+)?$/.test(s.trim()))
    return "Use a plain positive number without units or thousands separators.";
  const n = Number(s);
  const stepOk = integer ? Number.isInteger(n) : Number.isInteger(n * 10);
  if (n > 0 && n <= NUMBER_MAX && stepOk) return undefined;
  return integer
    ? "Use a positive whole number, at most 1,000,000."
    : "Use positive hours with at most one decimal place, at most 1,000,000.";
}

function parseImportFile(
  kind: ImportKind,
  file: string,
  manual: Manual,
  result: ImportBatch,
) {
  const rows = readCsvRows(file);
  const header = rows.shift()?.cells.map((v) => v.trim());
  const expected: readonly string[] = importHeaders[kind];
  if (
    !header ||
    header.length !== expected.length ||
    new Set(header).size !== header.length ||
    expected.some((k) => !header.includes(k))
  )
    throw new Rejection(`Headers must be exactly: ${expected.join(",")}`);
  if (!rows.length)
    throw new Rejection("The file contains headers but no records.");
  const ids = new Set<string>();
  for (const { cells, row } of rows) {
    try {
      const raw = readRecord(header, cells, ids);
      addRecord(kind, raw, manual, result);
    } catch (e) {
      result.errors.push(`${kind}, row ${row}: ${describeRowError(e)}`);
    }
  }
}

// An ID counts as used once read, even if the rest of its row is invalid.
function readRecord(header: string[], cells: string[], ids: Set<string>) {
  if (cells.length !== header.length)
    throw new Rejection(
      `Expected ${header.length} fields, found ${cells.length}. Quote descriptions containing commas.`,
    );
  const raw = Object.fromEntries(header.map((h, i) => [h, cells[i]]));
  if (ids.has(raw.id)) throw new Rejection(`Duplicate ID: ${raw.id}`);
  ids.add(raw.id);
  return raw;
}

function addRecord(
  kind: ImportKind,
  raw: Record<string, string>,
  manual: Manual,
  result: ImportBatch,
) {
  if (kind === "tasks") result.tasks.push(readTask(taskRow.parse(raw), manual));
  else if (kind === "inspections")
    result.inspections.push(readInspection(inspectionRow.parse(raw), manual));
  else result.components.push(readComponent(componentRow.parse(raw), manual));
}

function readTask(r: z.infer<typeof taskRow>, manual: Manual): ImportedTask {
  return {
    id: r.id,
    parentType: r.parent_type,
    parentId: r.parent_id,
    itemCode: r.item_code,
    instruction: r.instruction,
    applicability: r.applicability,
    sourceKey: csvSourceKey(manual.uuid, "task", r.id),
    reference: citeManual(r, manual),
  };
}

function readInspection(
  r: z.infer<typeof inspectionRow>,
  manual: Manual,
): ManualCandidate {
  const description = joinConditions(r, INSPECTION_TEXT_MAX);
  return {
    importId: r.id,
    sourceKey: csvSourceKey(manual.uuid, "inspection", r.id),
    name: r.name,
    kind: "inspection",
    text: description,
    scheduleText: r.conditions,
    hours: r.repeat_hours,
    cycles: r.repeat_cycles,
    months: r.repeat_months,
    initialHours: r.initial_hours,
    initialCycles: r.initial_cycles,
    warnings: r.conditions ? [r.conditions] : [],
    reference: citeManual(r, manual),
  };
}

function readComponent(
  r: z.infer<typeof componentRow>,
  manual: Manual,
): ManualCandidate {
  const description = joinConditions(r, COMPONENT_TEXT_MAX);
  return {
    importId: r.id,
    sourceKey: csvSourceKey(manual.uuid, "component_requirement", r.id),
    name: r.name,
    kind: "component",
    text: description,
    scheduleText: r.conditions,
    hours: r.hour_limit,
    cycles: r.cycle_limit,
    months: calendarMonths(r.calendar_value, r.calendar_unit),
    warnings: r.conditions ? [r.conditions] : [],
    reference: citeManual(r, manual),
    componentDefaults: {
      componentType: r.name,
      model: r.component_model,
      manufacturer: r.manufacturer,
      partNumber: r.part_number,
    },
    requirementDefaults: {
      requirementType: REQUIREMENT_TYPES[r.requirement_type],
      calendarIntervalValue: r.calendar_value,
      calendarIntervalUnit: r.calendar_unit,
      timeBasis: r.time_basis,
      timeLimitMode: r.hour_mode,
      cycleLimitMode: r.cycle_mode,
    },
  };
}

function joinConditions(
  r: { description: string; conditions: string },
  max: number,
) {
  const description = [
    r.description,
    r.conditions && `Conditions: ${r.conditions}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  if (description.length > max)
    throw new Rejection(
      `Description plus conditions must fit within ${max.toLocaleString("en-US")} characters.`,
    );
  return description;
}

// Days have no month equivalent, so a day interval sets no months.
function calendarMonths(value: number | undefined, unit: string) {
  if (value === undefined) return undefined;
  if (unit === "YEARS") return value * 12;
  return unit === "MONTHS" ? value : undefined;
}

function citeManual(r: CommonRow, manual: Manual) {
  if (r.pdf_page > manual.pageCount)
    throw new Rejection(`PDF page must be between 1 and ${manual.pageCount}.`);
  return {
    manualUuid: manual.uuid,
    pdfPage: r.pdf_page,
    section: r.section,
    printedPage: r.printed_page,
  };
}

function describeRowError(e: unknown) {
  if (e instanceof z.ZodError)
    return e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  return messageOf(e, "Invalid row");
}

function messageOf(e: unknown, fallback: string) {
  return e instanceof Error ? e.message : fallback;
}
