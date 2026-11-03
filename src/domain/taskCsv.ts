import { z } from "zod";
import { readCsvRows, importHeaders } from "./maintenanceCsv";
import { can, type Snapshot } from "./model";
import { ownsActive, programPermission } from "./programs";
import { validateManualReference } from "./manuals";
import {
  templateTaskSchema,
  saveInspectionTemplates,
  taskApplicabilityText,
  taskSourceText,
  type TemplateTask,
} from "./inspectionTemplates";
import { taskCardDefaults, saveTaskCard } from "./taskCards";
export const taskCsvHeaders = [
  "Item code",
  "Task",
  "Zone",
  "Manual reference",
  "PDF page",
];
const normalized = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
export function parseTaskCsv(text: string): TemplateTask[] {
  if (new TextEncoder().encode(text).length > 2 * 1024 * 1024)
    throw new Error("Choose a CSV up to 2 MB.");
  const [rawHeader, ...rows] = readCsvRows(text);
  const header = rawHeader?.cells.map((h) => h.trim());
  if (!header || !rows.length)
    throw new Error("Choose a CSV with headers and task rows.");
  if (new Set(header).size !== header.length)
    throw new Error("Duplicate CSV headers are not allowed.");
  const sample = taskCsvHeaders.every((h) => header.includes(h));
  const supported: readonly string[] = sample
    ? [...taskCsvHeaders, "Applicability"]
    : importHeaders.tasks;
  if (
    (!sample && !importHeaders.tasks.every((h) => header.includes(h))) ||
    header.some((h) => !supported.includes(h))
  )
    throw new Error(
      `Use these columns: ${taskCsvHeaders.join(", ")}. The existing tasks.csv format is also supported.`,
    );
  const codes = new Set<string>();
  return rows.map(({ cells, row }) => {
    try {
      if (cells.length !== header.length)
        throw new Error(
          "Column count differs from the header; quote fields containing commas.",
        );
      const get = (h: string) => (cells[header.indexOf(h)] ?? "").trim();
      const page = get(sample ? "PDF page" : "pdf_page");
      if (page && !/^\d+$/.test(page))
        throw new Error("PDF page must be a positive whole number.");
      const t = templateTaskSchema.parse({
        itemCode: get(sample ? "Item code" : "item_code"),
        instruction: get(sample ? "Task" : "instruction"),
        zone: sample ? get("Zone") : undefined,
        referenceText: sample
          ? get("Manual reference")
          : [
              get("section"),
              get("printed_page") ? `page ${get("printed_page")}` : "",
            ]
              .filter(Boolean)
              .join(" "),
        pdfPage: page ? Number(page) : undefined,
        applicability: get(sample ? "Applicability" : "applicability"),
      });
      if (!t.itemCode)
        throw new Error("Item code is required for task identity.");
      const key = normalized(t.itemCode);
      if (codes.has(key)) throw new Error(`Duplicate item code ${t.itemCode}.`);
      codes.add(key);
      return t;
    } catch (e) {
      throw new Error(
        `CSV row ${row}: ${e instanceof Error ? e.message : "Invalid task"}`,
      );
    }
  });
}
export const taskCsvImportSchema = z.strictObject({
  csv: z
    .string()
    .min(1)
    .max(2 * 1024 * 1024),
  targetKind: z.enum(["template", "inspection"]),
  targetUuid: z.string().min(1),
  targetVersion: z.number().int().nonnegative(),
  manualUuid: z.string().uuid().optional(),
  reviewed: z.literal(true),
});
export type TaskCsvImport = z.infer<typeof taskCsvImportSchema>;
export function importTaskCsv(s: Snapshot, raw: TaskCsvImport) {
  const input = taskCsvImportSchema.parse(raw);
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
    throw new Error("Target is unavailable or maintenance access is denied.");
  const parent = template ?? inspection!;
  if (parent.archived)
    throw new Error("Choose an active template or inspection.");
  if ((parent.version ?? 0) !== input.targetVersion)
    throw new Error("Target changed. Preview the file again.");
  const tasks = parseTaskCsv(input.csv).map((task) => {
    if (!input.manualUuid) return task;
    if (!task.pdfPage)
      throw new Error(
        `Task ${task.itemCode}: a PDF page is required when linking a manual.`,
      );
    const match = /^(.*?)\s+page\s+(.+)$/i.exec(task.referenceText ?? "");
    const ref = {
      manualUuid: input.manualUuid,
      pdfPage: task.pdfPage,
      section: match ? match[1] : (task.referenceText ?? ""),
      printedPage: match ? match[2] : "",
    };
    validateManualReference(s, ref);
    return { ...task, manualReference: ref };
  });
  for (const task of tasks) {
    const duplicate = template
      ? template.tasks.some(
          (t) =>
            (t.itemCode &&
              normalized(t.itemCode) === normalized(task.itemCode)) ||
            normalized(t.instruction) === normalized(task.instruction),
        )
      : s.taskCards?.some(
          (t) =>
            t.inspectionUuid === inspection!.uuid &&
            ((t.itemCode &&
              normalized(t.itemCode) === normalized(task.itemCode)) ||
              t.sourceKey === `task-csv:${normalized(task.itemCode)}` ||
              t.steps.some(
                (step) =>
                  normalized(step.instruction) === normalized(task.instruction),
              )),
        );
    if (duplicate)
      throw new Error(
        `Task ${task.itemCode} already exists on this ${input.targetKind}. No tasks were imported. Remove duplicates from the file or edit the existing tasks.`,
      );
  }
  const next = structuredClone(s);
  if (template) {
    const saved = saveInspectionTemplates(next, [
      { ...template, tasks: [...template.tasks, ...tasks] },
    ])[0].next;
    s.inspectionTemplates = next.inspectionTemplates;
    s.audit = next.audit;
    return { template: saved, tasks: [], count: tasks.length };
  }
  const cards = tasks.map((task) =>
    saveTaskCard(next, {
      action: "save",
      uuid: crypto.randomUUID(),
      version: 0,
      fields: {
        ...taskCardDefaults(inspection!.aircraftUuid),
        inspectionUuid: inspection!.uuid,
        componentUuid: inspection!.componentUuid ?? "",
        sourceKey: `task-csv:${normalized(task.itemCode)}`,
        itemCode: task.itemCode,
        title: `${inspection!.reference} — ${task.itemCode}`,
        description: task.instruction,
        applicability: taskApplicabilityText(task),
        maintenanceReference: taskSourceText(task),
        manualReference: task.manualReference,
        steps: [],
      },
    }),
  );
  s.taskCards = next.taskCards;
  s.audit = next.audit;
  return { template: undefined, tasks: cards, count: cards.length };
}
