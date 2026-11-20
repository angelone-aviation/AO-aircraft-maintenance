/**
 * Responsibility: Reads a task CSV and imports it, all or nothing, as tasks
 *   on an inspection template or as job cards on an inspection.
 * Layer: Domain. Parser and applier on a working snapshot; no I/O, no React.
 * Dependencies: zod; src/domain/maintenanceCsv.ts, model.ts, programs.ts,
 *   manuals.ts, inspectionTemplates.ts, taskCards.ts, changeLog.ts,
 *   rejection.ts, validationText.ts.
 *
 * Two formats are read: the sample file (taskCsvHeaders) and the legacy
 * tasks.csv export, whose parent ids are ignored for the chosen target.
 */
import { z } from "zod";
import { CSV_MAX_BYTES, readCsvRows, importHeaders } from "./maintenanceCsv";
import { can, type Inspection, type Snapshot } from "./model";
import { ownsActive, programPermission } from "./programs";
import { validateManualReference } from "./manuals";
import {
  templateTaskSchema,
  saveInspectionTemplates,
  taskApplicabilityText,
  taskSourceText,
  type InspectionTemplate,
  type TemplateTask,
} from "./inspectionTemplates";
import {
  taskCardDefaults,
  saveTaskCard,
  type TaskCard,
  type TaskCardCommand,
} from "./taskCards";
import { auditEntry } from "./changeLog";
import { Rejection } from "./rejection";
import { validationText } from "./validationText";

/** The sample task CSV's columns; an optional "Applicability" may follow. */
export const taskCsvHeaders = [
  "Item code",
  "Task",
  "Zone",
  "Manual reference",
  "PDF page",
];

type ImportTarget =
  | { kind: "template"; record: InspectionTemplate }
  | { kind: "inspection"; record: Inspection };

const normalized = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Reads a task CSV in either format into template tasks.
 *
 * @param text - The file's text.
 * @returns One task per data row, in file order.
 * @throws {Rejection} For an over-2 MiB, empty or wrongly headed file, or as
 *   "CSV row N: …" for a bad row, PDF page, or missing or repeated item code
 *   (compared ignoring case and spacing); a task field that fails its schema
 *   gives that schema's {@link validationText}.
 */
export function parseTaskCsv(text: string): TemplateTask[] {
  if (new TextEncoder().encode(text).length > CSV_MAX_BYTES)
    throw new Rejection("Choose a CSV up to 2 MiB.");
  const [rawHeader, ...rows] = readCsvRows(text);
  const header = rawHeader?.cells.map((h) => h.trim());
  if (!header || !rows.length)
    throw new Rejection("Choose a CSV with headers and task rows.");
  const sample = readHeaderFormat(header) === "sample";
  const codes = new Set<string>();
  return rows.map(({ cells, row }) => {
    try {
      const task = parseTaskRow(header, cells, sample);
      if (!task.itemCode)
        throw new Rejection("Item code is required for task identity.");
      const key = normalized(task.itemCode);
      if (codes.has(key))
        throw new Rejection(`Duplicate item code ${task.itemCode}.`);
      codes.add(key);
      return task;
    } catch (e) {
      throw new Rejection(`CSV row ${row}: ${rowErrorText(e)}`);
    }
  });
}

/**
 * A reviewed request to import a task CSV into one template or inspection.
 *
 * @throws {z.ZodError} From `parse()` on a malformed or unreviewed request.
 */
export const taskCsvImportSchema = z.strictObject({
  // Characters here; parseTaskCsv counts the same limit in UTF-8 bytes.
  csv: z.string().min(1).max(CSV_MAX_BYTES),
  targetKind: z.enum(["template", "inspection"]),
  targetUuid: z.string().min(1),
  targetVersion: z.number().int().nonnegative(),
  manualUuid: z.string().uuid().optional(),
  reviewed: z.literal(true),
});

/** A parsed {@link taskCsvImportSchema} request. */
export type TaskCsvImport = z.infer<typeof taskCsvImportSchema>;

/**
 * Imports a task CSV: appends its tasks to a template (one change-log row),
 * or adds one draft job card per task to an inspection (one
 * "taskCard.created_from_csv" row each, the card as `after`). Nothing is
 * written unless every task imports.
 *
 * @param s - The working snapshot; mutated on success.
 * @param raw - The import request.
 * @returns The saved template, or the new job cards, and the task count.
 * @throws {Rejection} When the target is missing, archived, changed or not
 *   maintainable, a linked manual lacks a task's PDF page, a task is already
 *   on the target, or {@link parseTaskCsv} refuses the file.
 */
export function importTaskCsv(s: Snapshot, raw: TaskCsvImport) {
  const input = taskCsvImportSchema.parse(raw);
  const target = findTarget(s, input);
  const tasks = parseTaskCsv(input.csv).map((task) =>
    linkManual(s, task, input.manualUuid),
  );
  for (const task of tasks)
    if (isAlreadyImported(s, target, task))
      throw new Rejection(
        `Task ${task.itemCode} already exists on this ${target.kind}. No tasks were imported. Remove duplicates from the file or edit the existing tasks.`,
      );
  // Saving into a copy, adopted only once every task saves, keeps a failed
  // save from importing part of the file.
  const next = structuredClone(s);
  if (target.kind === "template") {
    const { record } = target;
    const saved = saveInspectionTemplates(next, [
      { ...record, tasks: [...record.tasks, ...tasks] },
    ])[0].next;
    s.inspectionTemplates = next.inspectionTemplates;
    s.audit = next.audit;
    return { template: saved, tasks: [], count: tasks.length };
  }
  const cards = tasks.map((task) =>
    saveTaskCard(next, jobCardCommand(target.record, task)),
  );
  for (const card of cards) logImportedCard(next, target.record, card);
  s.taskCards = next.taskCards;
  s.audit = next.audit;
  return { template: undefined, tasks: cards, count: cards.length };
}

function rowErrorText(error: unknown): string {
  if (error instanceof z.ZodError) return validationText(error);
  return error instanceof Error ? error.message : "Invalid task";
}

function readHeaderFormat(header: string[]): "sample" | "legacy" {
  if (new Set(header).size !== header.length)
    throw new Rejection("Duplicate CSV headers are not allowed.");
  const sample = taskCsvHeaders.every((h) => header.includes(h));
  const supported: readonly string[] = sample
    ? [...taskCsvHeaders, "Applicability"]
    : importHeaders.tasks;
  if (
    (!sample && !importHeaders.tasks.every((h) => header.includes(h))) ||
    header.some((h) => !supported.includes(h))
  )
    throw new Rejection(
      `Use these columns: ${taskCsvHeaders.join(", ")}. The existing tasks.csv format is also supported.`,
    );
  return sample ? "sample" : "legacy";
}

function parseTaskRow(
  header: string[],
  cells: string[],
  sample: boolean,
): TemplateTask {
  if (cells.length !== header.length)
    throw new Rejection(
      "Column count differs from the header; quote fields containing commas.",
    );
  const get = (h: string) => (cells[header.indexOf(h)] ?? "").trim();
  const page = get(sample ? "PDF page" : "pdf_page");
  if (page && !/^\d+$/.test(page))
    throw new Rejection("PDF page must be a positive whole number.");
  const printedPage = get("printed_page");
  return templateTaskSchema.parse({
    itemCode: get(sample ? "Item code" : "item_code"),
    instruction: get(sample ? "Task" : "instruction"),
    zone: sample ? get("Zone") : undefined,
    referenceText: sample
      ? get("Manual reference")
      : [get("section"), printedPage ? `page ${printedPage}` : ""]
          .filter(Boolean)
          .join(" "),
    pdfPage: page ? Number(page) : undefined,
    applicability: get(sample ? "Applicability" : "applicability"),
  });
}

function findTarget(s: Snapshot, input: TaskCsvImport): ImportTarget {
  const template =
    input.targetKind === "template"
      ? s.inspectionTemplates?.find((t) => t.uuid === input.targetUuid)
      : undefined;
  const inspection =
    input.targetKind === "inspection"
      ? s.inspections.find((i) => i.uuid === input.targetUuid)
      : undefined;
  if (
    template
      ? !ownsActive(s, template.programUuid) ||
        !programPermission(s, "maintenance")
      : !inspection || !can(s, inspection.aircraftUuid, "maintenance")
  )
    throw new Rejection(
      "Target is unavailable or maintenance access is denied.",
    );
  const target: ImportTarget = template
    ? { kind: "template", record: template }
    : { kind: "inspection", record: inspection! };
  if (target.record.archived)
    throw new Rejection("Choose an active template or inspection.");
  if ((target.record.version ?? 0) !== input.targetVersion)
    throw new Rejection("Target changed. Preview the file again.");
  return target;
}

// "5-12-02 page 1" splits into section "5-12-02" and printed page "1".
function linkManual(
  s: Snapshot,
  task: TemplateTask,
  manualUuid: string | undefined,
): TemplateTask {
  if (!manualUuid) return task;
  if (!task.pdfPage)
    throw new Rejection(
      `Task ${task.itemCode}: a PDF page is required when linking a manual.`,
    );
  const match = /^(.*?)\s+page\s+(.+)$/i.exec(task.referenceText ?? "");
  const ref = {
    manualUuid,
    pdfPage: task.pdfPage,
    section: match ? match[1] : (task.referenceText ?? ""),
    printedPage: match ? match[2] : "",
  };
  validateManualReference(s, ref);
  return { ...task, manualReference: ref };
}

// The same item code, or the same instruction already on the target, means
// the file was imported before.
function isAlreadyImported(
  s: Snapshot,
  target: ImportTarget,
  task: TemplateTask,
) {
  const code = normalized(task.itemCode);
  const instruction = normalized(task.instruction);
  const sameCode = (itemCode?: string) =>
    !!itemCode && normalized(itemCode) === code;
  if (target.kind === "template")
    return target.record.tasks.some(
      (t) => sameCode(t.itemCode) || normalized(t.instruction) === instruction,
    );
  return (s.taskCards ?? []).some(
    (t) =>
      t.inspectionUuid === target.record.uuid &&
      (sameCode(t.itemCode) ||
        t.sourceKey === csvSourceKey(task.itemCode) ||
        t.steps.some((step) => normalized(step.instruction) === instruction)),
  );
}

function jobCardCommand(
  inspection: Inspection,
  task: TemplateTask,
): TaskCardCommand {
  return {
    action: "save",
    uuid: crypto.randomUUID(),
    version: 0,
    fields: {
      ...taskCardDefaults(inspection.aircraftUuid),
      inspectionUuid: inspection.uuid,
      componentUuid: inspection.componentUuid ?? "",
      sourceKey: csvSourceKey(task.itemCode),
      itemCode: task.itemCode,
      title: `${inspection.reference} — ${task.itemCode}`,
      description: task.instruction,
      applicability: taskApplicabilityText(task),
      maintenanceReference: taskSourceText(task),
      manualReference: task.manualReference,
      steps: [],
    },
  };
}

// Every job card records its creation, as cards copied from a template do
// (T3); the reason names the file's target.
function logImportedCard(s: Snapshot, inspection: Inspection, card: TaskCard) {
  s.audit.unshift(
    auditEntry(s, {
      action: "taskCard.created_from_csv",
      entityUuid: card.uuid,
      aircraftUuid: card.aircraftUuid,
      reason: `Imported from a task file onto ${inspection.reference}.`,
      after: card,
    }),
  );
}

function csvSourceKey(itemCode: string) {
  return `task-csv:${normalized(itemCode)}`;
}
