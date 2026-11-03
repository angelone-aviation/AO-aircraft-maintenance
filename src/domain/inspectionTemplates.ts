import { z } from "zod";
import type { Snapshot } from "./model";
import { activeProgram, ownsActive, programPermission } from "./programs";
import {
  manualApplicabilitySchema,
  manualReferenceSchema,
  validateManualReference,
  type ManualApplicability,
} from "./manuals";
import type { ManualCandidate } from "./manualDiscovery";
import { readCsvRows, type ImportedTask } from "./maintenanceCsv";

const integer = z.number().int().positive().max(1000000);
const hours = z
  .number()
  .positive()
  .max(1000000)
  .refine((n) => Number.isInteger(n * 10), "Use tenths of an hour.");
export const templateTaskSchema = z.strictObject({
  itemCode: z.string().max(100),
  instruction: z.string().trim().min(1).max(9000),
  applicability: z.string().max(1000),
  manualReference: manualReferenceSchema.optional(),
  zone: z.string().max(1000).optional(),
  referenceText: z.string().max(1000).optional(),
  pdfPage: z.number().int().positive().max(100000).optional(),
});
export type TemplateTask = z.infer<typeof templateTaskSchema>;
export function taskSourceText(t: TemplateTask) {
  return [
    t.referenceText,
    t.pdfPage !== undefined ? `PDF page ${t.pdfPage}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
export function taskApplicabilityText(t: TemplateTask) {
  return [t.applicability, t.zone ? `Zone: ${t.zone}` : ""]
    .filter(Boolean)
    .join("\n");
}
export const inspectionTemplateSchema = z
  .strictObject({
    uuid: z.string().uuid(),
    version: z.number().int().nonnegative(),
    programUuid: z.string().optional(),
    sourceKey: z.string().max(300).optional(),
    name: z.string().trim().min(1).max(200),
    group: z.string().trim().max(150),
    applicability: manualApplicabilitySchema,
    description: z.string().trim().max(10000),
    conditions: z.string().trim().max(2000),
    requirementType: z.enum([
      "Inspection Requirement",
      "Overhaul Requirement",
      "Life Limits",
    ]),
    hours: hours.optional(),
    cycles: integer.optional(),
    landings: integer.optional(),
    initialLandings: integer.optional(),
    landingMode: z.enum(["ABSOLUTE", "FROM_LAST_COMPLIED"]).optional(),
    calendarValue: integer.optional(),
    calendarUnit: z.enum(["DAYS", "MONTHS", "YEARS"]),
    initialHours: hours.optional(),
    initialCycles: integer.optional(),
    timeBasis: z.enum(["TSN", "TSO", "TSR"]),
    hourMode: z.enum(["ABSOLUTE", "FROM_LAST_COMPLIED"]),
    cycleMode: z.enum(["ABSOLUTE", "FROM_LAST_COMPLIED"]),
    manualReference: manualReferenceSchema.optional(),
    archived: z.boolean(),
    tasks: z.array(templateTaskSchema).max(2000),
  })
  .refine(
    (t) =>
      t.hours !== undefined ||
      t.cycles !== undefined ||
      t.landings !== undefined ||
      t.initialLandings !== undefined ||
      t.calendarValue !== undefined ||
      t.initialHours !== undefined ||
      t.initialCycles !== undefined ||
      !!t.conditions,
    "Enter an interval, initial threshold, or conditions describing the requirement.",
  );
export type InspectionTemplate = z.infer<typeof inspectionTemplateSchema>;
export function emptyTemplate(): InspectionTemplate {
  return {
    uuid: crypto.randomUUID(),
    version: 0,
    name: "",
    group: "",
    applicability: {
      kind: "aircraft",
      manufacturer: "",
      model: "",
      partNumber: "",
    },
    description: "",
    conditions: "",
    requirementType: "Inspection Requirement",
    calendarUnit: "MONTHS",
    timeBasis: "TSN",
    hourMode: "FROM_LAST_COMPLIED",
    cycleMode: "FROM_LAST_COMPLIED",
    archived: false,
    tasks: [],
  };
}
const normalize = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
export function templateIdentity(t: InspectionTemplate) {
  return JSON.stringify(
    [
      t.applicability.kind,
      t.applicability.manufacturer,
      t.applicability.model,
      t.applicability.partNumber,
      t.group,
      t.name,
    ].map(normalize),
  );
}
export function saveInspectionTemplates(
  s: Snapshot,
  raw: InspectionTemplate[],
) {
  if (!programPermission(s, "maintenance"))
    throw new Error("Maintenance permission is required to save templates.");
  const parsed = z.array(inspectionTemplateSchema).min(1).max(2000).parse(raw);
  if (new Set(parsed.map((t) => t.uuid)).size !== parsed.length)
    throw new Error("Duplicate template IDs in this batch.");
  if (new TextEncoder().encode(JSON.stringify(parsed)).length > 2 * 1024 * 1024)
    throw new Error("Save templates in batches up to 2 MB.");
  if (
    parsed.some(
      (t) => new TextEncoder().encode(JSON.stringify(t)).length > 800000,
    )
  )
    throw new Error(
      "A template with its tasks must fit within 800 KB. Split the checklist into smaller templates.",
    );
  const records = [...(s.inspectionTemplates ?? [])];
  const results = parsed.map((input) => {
    const before = records.find((t) => t.uuid === input.uuid);
    if (
      (before && !ownsActive(s, before.programUuid)) ||
      (input.programUuid !== undefined && !ownsActive(s, input.programUuid))
    )
      throw new Error("Template belongs to another Flight Program.");
    if (input.version !== (before?.version ?? 0))
      throw new Error("Template changed. Reopen it before saving.");
    validateManualReference(s, input.manualReference);
    input.tasks.forEach((t) => validateManualReference(s, t.manualReference));
    if (
      records.some(
        (t) =>
          t.uuid !== input.uuid &&
          ownsActive(s, t.programUuid) &&
          (templateIdentity(t) === templateIdentity(input) ||
            (input.sourceKey &&
              t.sourceKey === input.sourceKey &&
              JSON.stringify(t.applicability) ===
                JSON.stringify(input.applicability))),
      )
    )
      throw new Error(
        `Template already exists: ${input.name}. Edit the saved template instead.`,
      );
    const next = {
      ...input,
      programUuid: activeProgram(s),
      version: input.version + 1,
    };
    const index = records.findIndex((t) => t.uuid === input.uuid);
    if (index < 0) records.push(next);
    else records[index] = next;
    return { before, next };
  });
  s.inspectionTemplates = records;
  for (const { before, next } of results)
    s.audit.unshift({
      uuid: crypto.randomUUID(),
      programUuid: next.programUuid,
      actorId: s.user.id,
      at: Date.now(),
      action: "inspectionTemplate.save",
      entityUuid: next.uuid,
      before: before ? JSON.stringify(before) : undefined,
      after: JSON.stringify(next),
    });
  return results;
}
export function templateFromCandidate(
  row: ManualCandidate,
  scope: ManualApplicability,
  tasks: ImportedTask[] = [],
): InspectionTemplate {
  const component = row.componentDefaults;
  const requirement = row.requirementDefaults;
  const applicability =
    row.kind === "component"
      ? {
          kind: "component" as const,
          manufacturer:
            component?.manufacturer ||
            (scope.kind === "component" ? scope.manufacturer : ""),
          model:
            component?.model || (scope.kind === "component" ? scope.model : ""),
          partNumber:
            component?.partNumber ||
            (scope.kind === "component" ? scope.partNumber : ""),
        }
      : scope;
  return {
    ...emptyTemplate(),
    name: row.name,
    applicability,
    description: row.text,
    conditions: row.scheduleText,
    hours: row.hours,
    cycles: row.cycles,
    calendarValue: requirement?.calendarIntervalValue ?? row.months,
    calendarUnit: requirement?.calendarIntervalUnit ?? "MONTHS",
    initialHours: row.initialHours,
    initialCycles: row.initialCycles,
    requirementType: requirement?.requirementType ?? "Inspection Requirement",
    timeBasis: requirement?.timeBasis ?? "TSN",
    hourMode: requirement?.timeLimitMode ?? "FROM_LAST_COMPLIED",
    cycleMode: requirement?.cycleLimitMode ?? "FROM_LAST_COMPLIED",
    sourceKey: row.sourceKey,
    manualReference: row.reference,
    tasks: tasks
      .filter(
        (t) =>
          t.parentId === row.importId &&
          t.parentType ===
            (row.kind === "inspection"
              ? "inspection"
              : "component_requirement"),
      )
      .map((t) => ({
        itemCode: t.itemCode,
        instruction: t.instruction,
        applicability: t.applicability,
        manualReference: t.reference,
      })),
  };
}
export const templateCsvHeaders = [
  "name",
  "description",
  "hours",
  "cycles",
  "calendar_value",
  "calendar_unit",
  "initial_hours",
  "initial_cycles",
  "conditions",
  "requirement_type",
  "time_basis",
  "hour_mode",
  "cycle_mode",
];
export const templateLandingCsvHeaders = [
  "landings",
  "initial_landings",
  "landing_mode",
];
export function parseTemplateCsv(
  text: string,
  scope: ManualApplicability,
  group: string,
) {
  const [rawHeader, ...rows] = readCsvRows(text);
  const header = rawHeader?.cells.map((h) => h.trim());
  if (!header || !rows.length)
    throw new Error("Choose a CSV with headers and records.");
  const namedHeaders = header.filter(Boolean);
  if (new Set(namedHeaders).size !== namedHeaders.length)
    throw new Error("Duplicate CSV column names are not supported.");
  const status =
    header.includes("INSPECTION / COMPONENT") &&
    header.includes("SVC LIFE HRS/LAND");
  if (
    !status &&
    (header.some(
      (h) =>
        !templateCsvHeaders.includes(h) &&
        !templateLandingCsvHeaders.includes(h),
    ) ||
      new Set(header).size !== header.length ||
      templateCsvHeaders.some((h) => !header.includes(h)))
  )
    throw new Error(
      `Use the template CSV columns: ${templateCsvHeaders.join(", ")}`,
    );
  return rows.map(({ cells, row }) => {
    try {
      if (cells.length !== header.length)
        throw new Error("Column count does not match the header.");
      const get = (h: string) => (cells[header.indexOf(h)] ?? "").trim();
      const num = (h: string) => {
        const v = get(h);
        if (!v) return undefined;
        if (!/^\d+(\.\d+)?$/.test(v))
          throw new Error(`Invalid number in ${h}.`);
        return Number(v);
      };
      let conditions = status
        ? [
            get("Part Number/Notes"),
            get("Serial Number/Notes"),
            get("SVC life Corrosion Insp Progm"),
          ]
            .filter(Boolean)
            .join("; ")
        : get("conditions");
      const description = status ? "" : get("description");
      // Narrative-only requirements remain unscheduled. Preserve their supplied
      // event / bulletin instructions as conditions, without inferring intervals.
      if (
        !status &&
        !conditions &&
        description &&
        [
          "hours",
          "cycles",
          "calendar_value",
          "initial_hours",
          "initial_cycles",
        ].every((h) => !get(h))
      ) {
        conditions = description;
      }
      const canonical = (
        column: string,
        values: string[],
        fallback: string,
      ) => {
        const raw = get(column);
        return (
          values.find((v) => v.toLowerCase() === raw.toLowerCase()) ??
          (raw || fallback)
        );
      };
      const template = inspectionTemplateSchema.parse({
        ...emptyTemplate(),
        applicability: scope,
        group,
        name: get(status ? "INSPECTION / COMPONENT" : "name"),
        description,
        conditions,
        hours: num(status ? "SVC LIFE HRS/LAND" : "hours"),
        cycles: status ? undefined : num("cycles"),
        landings: status ? undefined : num("landings"),
        initialLandings: status ? undefined : num("initial_landings"),
        landingMode: canonical(
          "landing_mode",
          ["ABSOLUTE", "FROM_LAST_COMPLIED"],
          "FROM_LAST_COMPLIED",
        ),
        calendarValue: num(status ? "SVC LIFE MONTHS" : "calendar_value"),
        calendarUnit: status
          ? "MONTHS"
          : canonical("calendar_unit", ["DAYS", "MONTHS", "YEARS"], "MONTHS"),
        initialHours: status ? undefined : num("initial_hours"),
        initialCycles: status ? undefined : num("initial_cycles"),
        requirementType: status
          ? "Inspection Requirement"
          : canonical(
              "requirement_type",
              ["Inspection Requirement", "Overhaul Requirement", "Life Limits"],
              "Inspection Requirement",
            ),
        timeBasis: status
          ? "TSN"
          : canonical("time_basis", ["TSN", "TSO", "TSR"], "TSN"),
        hourMode: status
          ? "FROM_LAST_COMPLIED"
          : canonical(
              "hour_mode",
              ["ABSOLUTE", "FROM_LAST_COMPLIED"],
              "FROM_LAST_COMPLIED",
            ),
        cycleMode: status
          ? "FROM_LAST_COMPLIED"
          : canonical(
              "cycle_mode",
              ["ABSOLUTE", "FROM_LAST_COMPLIED"],
              "FROM_LAST_COMPLIED",
            ),
      });
      return {
        row,
        template,
        error: "",
        selected: !/not used|not installed|\bna\b|n\/a/i.test(conditions),
      };
    } catch (e) {
      return {
        row,
        template: undefined,
        error:
          e instanceof z.ZodError
            ? e.issues
                .map(
                  (issue) =>
                    `${issue.path.join(".") || "Requirement"}: ${issue.message}`,
                )
                .join("; ")
            : e instanceof Error
              ? e.message
              : "Invalid row",
        selected: false,
      };
    }
  });
}
