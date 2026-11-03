import type { Manual } from "./manuals";
import type { ManualCandidate } from "./manualDiscovery";
import { z } from "zod";

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
export type ImportKind = keyof typeof importHeaders;
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
export interface ImportBatch {
  inspections: ManualCandidate[];
  components: ManualCandidate[];
  tasks: ImportedTask[];
  errors: string[];
}
export const csvSourceKey = (
  manualUuid: string,
  kind: "inspection" | "component_requirement" | "task",
  id: string,
) => `${manualUuid}:csv:${kind}:${id}`;

// RFC 4180 quoting, including commas, escaped quotes and embedded newlines.
export function readCsv(text: string): string[][] {
  return readCsvRows(text).map((r) => r.cells);
}
/** Non-blank records with their 1-based spreadsheet row; blank rows still count. */
export function readCsvRows(
  text: string,
  { maxMegabytes = 2, maxRecords = 2000 } = {},
): { cells: string[]; row: number }[] {
  if (text.length > maxMegabytes * 1024 * 1024)
    throw new Error(`CSV files must be at most ${maxMegabytes} MB.`);
  text = text.replace(/^\uFEFF/, "");
  const rows: { cells: string[]; row: number }[] = [];
  let rowNumber = 0;
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  const finishCell = () => {
    row.push(cell);
    cell = "";
    closed = false;
  };
  const finishRow = () => {
    finishCell();
    rowNumber++;
    if (row.some((v) => v.trim())) rows.push({ cells: row, row: rowNumber });
    row = [];
    if (rows.length > maxRecords + 1)
      throw new Error(
        `Use at most ${maxRecords.toLocaleString("en-US")} records per CSV file.`,
      );
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += ch;
    } else if (ch === ",") finishCell();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      finishRow();
    } else if (ch === '"') {
      if (cell || closed)
        throw new Error(
          "Unexpected quote in CSV. Quote the entire field and double embedded quotes.",
        );
      quoted = true;
    } else {
      if (closed) throw new Error("Unexpected text after a closing quote.");
      cell += ch;
    }
  }
  if (quoted) throw new Error("CSV contains an unclosed quoted field.");
  if (cell || row.length || closed) finishRow();
  return rows;
}
const id = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/,
    "Use a stable ID of 1–80 letters, numbers, dots, underscores or hyphens.",
  );
const short = z.string().trim().min(1).max(200);
const text = z.string().trim().max(10000);
const numeric = (integer = false) =>
  z.string().transform((s, ctx) => {
    if (!s.trim()) return undefined;
    if (!/^\d+(?:\.\d+)?$/.test(s.trim())) {
      ctx.addIssue({
        code: "custom",
        message:
          "Use a plain positive number without units or thousands separators.",
      });
      return z.NEVER;
    }
    const n = Number(s);
    if (
      !(n > 0) ||
      n > 1000000 ||
      (integer && !Number.isInteger(n)) ||
      (!integer && !Number.isInteger(n * 10))
    ) {
      ctx.addIssue({
        code: "custom",
        message: integer
          ? "Use a positive whole number, at most 1,000,000."
          : "Use positive hours with at most one decimal place, at most 1,000,000.",
      });
      return z.NEVER;
    }
    return n;
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
    if (files[kind] === undefined) continue;
    try {
      const rows = readCsvRows(files[kind]!);
      const header = rows.shift()?.cells.map((v) => v.trim());
      const expected: readonly string[] = importHeaders[kind];
      if (
        !header ||
        header.length !== expected.length ||
        new Set(header).size !== header.length ||
        expected.some((k) => !header.includes(k))
      )
        throw new Error(`Headers must be exactly: ${expected.join(",")}`);
      if (!rows.length)
        throw new Error("The file contains headers but no records.");
      const ids = new Set<string>();
      rows.forEach(({ cells, row }) => {
        const label = `${kind}, row ${row}`;
        try {
          if (cells.length !== header.length)
            throw new Error(
              `Expected ${header.length} fields, found ${cells.length}. Quote descriptions containing commas.`,
            );
          const raw = Object.fromEntries(header.map((h, i) => [h, cells[i]]));
          if (ids.has(raw.id)) throw new Error(`Duplicate ID: ${raw.id}`);
          ids.add(raw.id);
          const reference = (
            r:
              | z.infer<typeof taskRow>
              | z.infer<typeof inspectionRow>
              | z.infer<typeof componentRow>,
          ) => {
            if (r.pdf_page > manual.pageCount)
              throw new Error(
                `PDF page must be between 1 and ${manual.pageCount}.`,
              );
            return {
              manualUuid: manual.uuid,
              pdfPage: r.pdf_page,
              section: r.section,
              printedPage: r.printed_page,
            };
          };
          if (kind === "tasks") {
            const r = taskRow.parse(raw);
            result.tasks.push({
              id: r.id,
              parentType: r.parent_type,
              parentId: r.parent_id,
              itemCode: r.item_code,
              instruction: r.instruction,
              applicability: r.applicability,
              sourceKey: csvSourceKey(manual.uuid, "task", r.id),
              reference: reference(r),
            });
          } else if (kind === "inspections") {
            const r = inspectionRow.parse(raw);
            const description = [
              r.description,
              r.conditions && `Conditions: ${r.conditions}`,
            ]
              .filter(Boolean)
              .join("\n\n");
            if (description.length > 2000)
              throw new Error(
                "Description plus conditions must fit within 2,000 characters.",
              );
            result.inspections.push({
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
              reference: reference(r),
            });
          } else {
            const r = componentRow.parse(raw);
            const description = [
              r.description,
              r.conditions && `Conditions: ${r.conditions}`,
            ]
              .filter(Boolean)
              .join("\n\n");
            if (description.length > 10000)
              throw new Error(
                "Description plus conditions must fit within 10,000 characters.",
              );
            result.components.push({
              importId: r.id,
              sourceKey: csvSourceKey(
                manual.uuid,
                "component_requirement",
                r.id,
              ),
              name: r.name,
              kind: "component",
              text: description,
              scheduleText: r.conditions,
              hours: r.hour_limit,
              cycles: r.cycle_limit,
              months:
                r.calendar_value === undefined
                  ? undefined
                  : r.calendar_unit === "YEARS"
                    ? r.calendar_value * 12
                    : r.calendar_unit === "MONTHS"
                      ? r.calendar_value
                      : undefined,
              warnings: r.conditions ? [r.conditions] : [],
              reference: reference(r),
              componentDefaults: {
                componentType: r.name,
                model: r.component_model,
                manufacturer: r.manufacturer,
                partNumber: r.part_number,
              },
              requirementDefaults: {
                requirementType:
                  r.requirement_type === "life_limit"
                    ? "Life Limits"
                    : r.requirement_type === "overhaul"
                      ? "Overhaul Requirement"
                      : "Inspection Requirement",
                calendarIntervalValue: r.calendar_value,
                calendarIntervalUnit: r.calendar_unit,
                timeBasis: r.time_basis,
                timeLimitMode: r.hour_mode,
                cycleLimitMode: r.cycle_mode,
              },
            });
          }
        } catch (e) {
          result.errors.push(
            `${label}: ${e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : e instanceof Error ? e.message : "Invalid row"}`,
          );
        }
      });
    } catch (e) {
      result.errors.push(
        `${kind}: ${e instanceof Error ? e.message : "Invalid file"}`,
      );
    }
  }
  return result;
}
