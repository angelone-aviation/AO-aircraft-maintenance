/**
 * Responsibility: Component templates (a program's recommended components for
 *   one make and model), their CSV form, and applying them as setups.
 * Layer: Domain. Zod schemas, rules and appliers; no I/O, no React.
 * Dependencies: zod, ./maintenanceCsv, ./ata, ./components, ./model,
 *   ./programs, ./rejection, ./changeLog.
 */
import { z } from "zod";
import { readCsvRows } from "./maintenanceCsv";
import { ataChapterSchema } from "./ata";
import { POSITIONS } from "./components";
import { can, type Aircraft, type Snapshot } from "./model";
import { activeProgram, ownsActive, programPermission } from "./programs";
import { Rejection } from "./rejection";
import { auditEntry } from "./changeLog";

const TEXT_MAX_LENGTH = 150;
const TEMPLATE_ROWS_MAX = 500;
const CSV_MAX_BYTES = 2 * 1024 * 1024;
const REQUIRED_HEADER_COUNT = 4;

const text = z.string().trim().min(1).max(TEXT_MAX_LENGTH);

/**
 * One template row: a component to set up, and optionally the row it is
 * mounted on (`parentId`).
 *
 * @throws {z.ZodError} From `parse()` on a missing or over-long field, or an
 *   unknown component type, ATA chapter or position.
 */
export const componentTemplateRowSchema = z.object({
  id: text,
  parentId: z.string().trim().max(TEXT_MAX_LENGTH).default(""),
  componentType: z.enum([
    "Appliance",
    "Engine",
    "Propeller",
    "Main Rotor",
    "Tail Rotor",
  ]),
  ataChapter: ataChapterSchema.optional(),
  partNumber: z.string().trim().max(100),
  model: text,
  manufacturer: z.string().trim().max(TEXT_MAX_LENGTH).default(""),
  installPosition: z.enum(POSITIONS).optional(),
});

/** A program's recommended components for one make and model: 1–500 rows. */
export const componentTemplateSchema = z.object({
  uuid: z.string().uuid(),
  version: z.number().int().nonnegative(),
  programUuid: z.string().optional(),
  name: text,
  make: text,
  model: text,
  rows: z.array(componentTemplateRowSchema).min(1).max(TEMPLATE_ROWS_MAX),
});

/** A saved component template. */
export type ComponentTemplate = z.infer<typeof componentTemplateSchema>;

/**
 * A component a template recommends for one aircraft. It stays pending
 * ("Setup incomplete") until a component is created with its uuid.
 */
export interface ComponentSetup {
  uuid: string;
  programUuid: string;
  aircraftUuid: string;
  templateUuid: string;
  templateName: string;
  row: z.infer<typeof componentTemplateRowSchema>;
  parentComponentUuid?: string;
}

/** The template CSV columns, in export order; the first four are required. */
export const componentTemplateHeaders = [
  "Component type",
  "ATA chapter",
  "Part number",
  "Component Name",
  "Manufacturer",
  "Position",
  "ID",
  "Parent ID",
];

/**
 * Checks that row IDs are unique and that every parent link names a row and
 * leads to no cycle.
 *
 * @param rows - The template rows.
 * @throws {Rejection} "Each row ID must be unique.", "Unknown parent ID:
 *   <id>" or "Parent components cannot form a cycle."
 */
export function validateRows(rows: ComponentTemplate["rows"]) {
  const parentOf = new Map(rows.map((r) => [r.id, r.parentId]));
  if (parentOf.size !== rows.length)
    throw new Rejection("Each row ID must be unique.");
  for (const r of rows) assertParentChain(r.id, parentOf);
}

/**
 * Reads template rows from CSV text. Column names match ignoring case and
 * repeated spaces, in any order; a row without an ID is numbered from 1.
 *
 * @param csv - The file's text; a leading byte-order mark is ignored.
 * @returns The rows, checked by {@link validateRows}.
 * @throws {Rejection} "CSV must be under 2 MB.", "Use columns: …", "CSV row
 *   <n>: <reason>", "Use 1–500 component rows." or a {@link validateRows}
 *   message.
 */
export function parseComponentTemplateCsv(csv: string) {
  if (new TextEncoder().encode(csv).length > CSV_MAX_BYTES)
    throw new Rejection("CSV must be under 2 MB.");
  const [header, ...data] = readCsvRows(csv.replace(/^﻿/, ""));
  const headers = readTemplateHeaders(header?.cells ?? []);
  const rows = data.map(({ cells, row }, index) => {
    try {
      return parseTemplateRow(cells, headers, index);
    } catch (e) {
      throw new Rejection(
        `CSV row ${row}: ${e instanceof Error ? e.message : e}`,
      );
    }
  });
  if (!rows.length || rows.length > TEMPLATE_ROWS_MAX)
    throw new Rejection("Use 1–500 component rows.");
  validateRows(rows);
  return rows;
}

/**
 * Saves a template to the active Flight Program, creating it at version 0,
 * and adds a "componentTemplate.save" change-log entry with the template
 * before and after.
 *
 * @param s - The working snapshot; `componentTemplates` gets the saved
 *   template and the change log its entry.
 * @param raw - A {@link componentTemplateSchema} payload.
 * @returns The template as saved, with its version incremented.
 * @throws {z.ZodError} On an invalid payload.
 * @throws {Rejection} "Maintenance permission is required.", "Template
 *   belongs to another program.", "Template changed. Reopen it.", "Select a
 *   Flight Program." or a {@link validateRows} message.
 */
export function saveComponentTemplate(s: Snapshot, raw: unknown) {
  if (!programPermission(s, "maintenance"))
    throw new Rejection("Maintenance permission is required.");
  const input = componentTemplateSchema.parse(raw);
  validateRows(input.rows);
  const old = s.componentTemplates?.find((t) => t.uuid === input.uuid);
  if (
    (old && !ownsActive(s, old.programUuid)) ||
    (input.programUuid && !ownsActive(s, input.programUuid))
  )
    throw new Rejection("Template belongs to another program.");
  if ((old?.version ?? 0) !== input.version)
    throw new Rejection("Template changed. Reopen it.");
  const programUuid = activeProgram(s);
  if (!programUuid) throw new Rejection("Select a Flight Program.");
  const next = { ...input, programUuid, version: input.version + 1 };
  s.componentTemplates = [
    ...(s.componentTemplates ?? []).filter((t) => t.uuid !== next.uuid),
    next,
  ];
  s.audit.unshift(
    auditEntry(s, {
      action: "componentTemplate.save",
      entityUuid: next.uuid,
      before: old,
      after: next,
    }),
  );
  return next;
}

/**
 * Tells whether a template is for an aircraft's make and model, ignoring case
 * and repeated spaces.
 *
 * @param t - The template.
 * @param a - The aircraft.
 * @returns True when both make and model match.
 */
export function matchesComponentTemplate(
  t: ComponentTemplate,
  a: { make: string; model: string },
) {
  return norm(t.make) === norm(a.make) && norm(t.model) === norm(a.model);
}

/**
 * Tells whether a template row may duplicate a component installed on the
 * aircraft or a setup already recommended for it: the same type, part number
 * and name (ignoring case and repeated spaces) at exactly the same position.
 *
 * @param s - The aircraft's components and setups.
 * @param aircraftUuid - The aircraft.
 * @param row - The template row.
 * @returns True on a possible duplicate.
 */
export function componentDuplicate(
  s: Snapshot,
  aircraftUuid: string,
  row: ComponentTemplate["rows"][number],
) {
  const same = (r: {
    componentType: string;
    partNumber: string;
    model?: string;
    installPosition?: string;
  }) =>
    norm(r.componentType) === norm(row.componentType) &&
    norm(r.partNumber) === norm(row.partNumber) &&
    norm(r.model ?? "") === norm(row.model) &&
    (r.installPosition ?? "") === (row.installPosition ?? "");
  return (
    (s.management ?? []).some(
      (r) =>
        r.kind === "component" &&
        r.aircraftUuid === aircraftUuid &&
        r.installed &&
        same(r),
    ) ||
    (s.componentSetups ?? []).some(
      (r) => r.aircraftUuid === aircraftUuid && same(r.row),
    )
  );
}

/**
 * Recommends the chosen rows of a template for an aircraft as pending setups,
 * linked to their parents. A row already applied to the aircraft is skipped,
 * so applying again adds nothing; any refusal adds nothing at all.
 *
 * @param s - The working snapshot; `componentSetups` gets the new setups, and
 *   the change log a "component.setupImported" entry for each.
 * @param raw - `{ templateUuid, version, aircraftUuid, rowIds }`.
 * @returns The setups added.
 * @throws {z.ZodError} On an invalid payload.
 * @throws {Rejection} The program, access, stale-template, make and model,
 *   unknown row, duplicate, aircraft category or missing parent refusal.
 */
export function applyComponentTemplate(s: Snapshot, raw: unknown) {
  const programUuid = activeProgram(s);
  if (!programUuid) throw new Rejection("Select a Flight Program.");
  const input = applyInputSchema.parse(raw);
  const { t, a } = findApplicableTemplate(s, input);
  const rows = t.rows.filter((r) => input.rowIds.includes(r.id));
  if (rows.length !== new Set(input.rowIds).size)
    throw new Rejection("Unknown template row.");
  const setupOf = mapAppliedSetups(s, t, a);
  const added: ComponentSetup[] = [];
  for (const r of rows) {
    if (setupOf.has(r.id)) continue;
    assertSetupFits(s, a, r, added);
    const d = {
      uuid: crypto.randomUUID(),
      programUuid,
      aircraftUuid: a.uuid,
      templateUuid: t.uuid,
      templateName: t.name,
      row: r,
    };
    added.push(d);
    setupOf.set(r.id, d.uuid);
  }
  linkParents(added, setupOf);
  s.componentSetups = [...(s.componentSetups ?? []), ...added];
  for (const d of added)
    s.audit.unshift(
      auditEntry(s, {
        action: "component.setupImported",
        entityUuid: d.uuid,
        aircraftUuid: d.aircraftUuid,
        after: d,
      }),
    );
  return added;
}

type TemplateRow = ComponentTemplate["rows"][number];

const applyInputSchema = z.object({
  templateUuid: z.string().uuid(),
  version: z.number().int(),
  aircraftUuid: z.string(),
  rowIds: z.array(z.string()).min(1).max(TEMPLATE_ROWS_MAX),
});

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

function assertParentChain(id: string, parentOf: Map<string, string>) {
  const seen = new Set([id]);
  let parent = parentOf.get(id);
  while (parent) {
    if (!parentOf.has(parent))
      throw new Rejection(`Unknown parent ID: ${parent}`);
    if (seen.has(parent))
      throw new Rejection("Parent components cannot form a cycle.");
    seen.add(parent);
    parent = parentOf.get(parent);
  }
}

function readTemplateHeaders(cells: string[]) {
  const headers = cells.map(norm);
  const known = componentTemplateHeaders.map(norm);
  if (
    new Set(headers).size !== headers.length ||
    known.slice(0, REQUIRED_HEADER_COUNT).some((h) => !headers.includes(h)) ||
    headers.some((h) => !known.includes(h))
  )
    throw new Rejection(
      `Use columns: ${componentTemplateHeaders.join(", ")}. The first four are required.`,
    );
  return headers;
}

function parseTemplateRow(cells: string[], headers: string[], index: number) {
  if (cells.length !== headers.length)
    throw new Rejection("Column count does not match header.");
  const get = (h: string) => (cells[headers.indexOf(norm(h))] ?? "").trim();
  return componentTemplateRowSchema.parse({
    id: get("ID") || String(index + 1),
    parentId: get("Parent ID"),
    componentType: get("Component type"),
    ataChapter: get("ATA chapter") || undefined,
    partNumber: get("Part number"),
    model: get("Component Name"),
    manufacturer: get("Manufacturer"),
    installPosition: get("Position") || undefined,
  });
}

function findApplicableTemplate(
  s: Snapshot,
  input: z.infer<typeof applyInputSchema>,
) {
  const t = s.componentTemplates?.find((t) => t.uuid === input.templateUuid);
  const a = s.aircraft.find((a) => a.uuid === input.aircraftUuid);
  if (
    !t ||
    !ownsActive(s, t.programUuid) ||
    !a ||
    !can(s, a.uuid, "maintenance")
  )
    throw new Rejection("Template and aircraft maintenance access required.");
  if (t.version !== input.version)
    throw new Rejection("Template changed. Reopen the preview.");
  if (!matchesComponentTemplate(t, a))
    throw new Rejection("Aircraft make and model must match the template.");
  return { t, a };
}

// Row ID to setup uuid for the rows of this template already applied to the
// aircraft; the first setup wins should a row have been applied twice.
function mapAppliedSetups(s: Snapshot, t: ComponentTemplate, a: Aircraft) {
  const setupOf = new Map<string, string>();
  for (const d of s.componentSetups ?? [])
    if (
      d.aircraftUuid === a.uuid &&
      d.templateUuid === t.uuid &&
      !setupOf.has(d.row.id)
    )
      setupOf.set(d.row.id, d.uuid);
  return setupOf;
}

function assertSetupFits(
  s: Snapshot,
  a: Aircraft,
  r: TemplateRow,
  added: ComponentSetup[],
) {
  const pending = [...(s.componentSetups ?? []), ...added];
  if (componentDuplicate({ ...s, componentSetups: pending }, a.uuid, r))
    throw new Rejection(
      `Possible duplicate: ${r.model}. Deselect it or differentiate its name/position in the template.`,
    );
  if (
    (!a.helicopter && /Rotor$/.test(r.componentType)) ||
    (a.helicopter && r.componentType === "Propeller")
  )
    throw new Rejection(
      "Component type does not match this aircraft category.",
    );
}

function linkParents(added: ComponentSetup[], setupOf: Map<string, string>) {
  for (const d of added) {
    if (!d.row.parentId) continue;
    const parent = setupOf.get(d.row.parentId);
    if (!parent)
      throw new Rejection(`Select the parent row for ${d.row.model} as well.`);
    d.parentComponentUuid = parent;
  }
}
