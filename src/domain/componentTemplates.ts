import { z } from "zod";
import { readCsvRows } from "./maintenanceCsv";
import { ataChapterSchema } from "./ata";
import { POSITIONS } from "./components";
import { can, type Snapshot } from "./model";
import { activeProgram, ownsActive, programPermission } from "./programs";
const text = z.string().trim().min(1).max(150);
export const componentTemplateRowSchema = z.object({
  id: text,
  parentId: z.string().trim().max(150).default(""),
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
  manufacturer: z.string().trim().max(150).default(""),
  installPosition: z.enum(POSITIONS).optional(),
});
export const componentTemplateSchema = z.object({
  uuid: z.string().uuid(),
  version: z.number().int().nonnegative(),
  programUuid: z.string().optional(),
  name: text,
  make: text,
  model: text,
  rows: z.array(componentTemplateRowSchema).min(1).max(500),
});
export type ComponentTemplate = z.infer<typeof componentTemplateSchema>;
export interface ComponentSetup {
  uuid: string;
  programUuid: string;
  aircraftUuid: string;
  templateUuid: string;
  templateName: string;
  row: z.infer<typeof componentTemplateRowSchema>;
  parentComponentUuid?: string;
}
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
const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
export function validateRows(rows: ComponentTemplate["rows"]) {
  const ids = new Set(rows.map((r) => r.id));
  if (ids.size !== rows.length) throw Error("Each row ID must be unique.");
  for (const r of rows) {
    const seen = new Set([r.id]);
    let parent = r.parentId;
    while (parent) {
      if (!ids.has(parent)) throw Error(`Unknown parent ID: ${parent}`);
      if (seen.has(parent))
        throw Error("Parent components cannot form a cycle.");
      seen.add(parent);
      parent = rows.find((r) => r.id === parent)!.parentId;
    }
  }
}
export function parseComponentTemplateCsv(csv: string) {
  if (new TextEncoder().encode(csv).length > 2 * 1024 * 1024)
    throw Error("CSV must be under 2 MB.");
  const [header, ...data] = readCsvRows(csv.replace(/^\uFEFF/, ""));
  const headers = header?.cells.map(norm) ?? [];
  if (
    new Set(headers).size !== headers.length ||
    componentTemplateHeaders
      .slice(0, 4)
      .some((h) => !headers.includes(norm(h))) ||
    headers.some((h) => !componentTemplateHeaders.map(norm).includes(h))
  )
    throw Error(
      `Use columns: ${componentTemplateHeaders.join(", ")}. The first four are required.`,
    );
  const rows = data.map(({ cells, row }, index) => {
    try {
      if (cells.length !== headers.length)
        throw Error("Column count does not match header.");
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
    } catch (e) {
      throw Error(`CSV row ${row}: ${e instanceof Error ? e.message : e}`);
    }
  });
  if (!rows.length || rows.length > 500)
    throw Error("Use 1–500 component rows.");
  validateRows(rows);
  return rows;
}
export function saveComponentTemplate(s: Snapshot, raw: unknown) {
  if (!programPermission(s, "maintenance"))
    throw Error("Maintenance permission is required.");
  const input = componentTemplateSchema.parse(raw);
  validateRows(input.rows);
  const old = s.componentTemplates?.find((t) => t.uuid === input.uuid);
  if (
    (old && !ownsActive(s, old.programUuid)) ||
    (input.programUuid && !ownsActive(s, input.programUuid))
  )
    throw Error("Template belongs to another program.");
  if ((old?.version ?? 0) !== input.version)
    throw Error("Template changed. Reopen it.");
  const programUuid = activeProgram(s);
  if (!programUuid) throw Error("Select a Flight Program.");
  const next = {
    ...input,
    programUuid,
    version: input.version + 1,
  };
  s.componentTemplates = [
    ...(s.componentTemplates ?? []).filter((t) => t.uuid !== next.uuid),
    next,
  ];
  return next;
}
export function matchesComponentTemplate(
  t: ComponentTemplate,
  a: { make: string; model: string },
) {
  return norm(t.make) === norm(a.make) && norm(t.model) === norm(a.model);
}
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
export function applyComponentTemplate(s: Snapshot, raw: unknown) {
  const programUuid = activeProgram(s);
  if (!programUuid) throw Error("Select a Flight Program.");
  const input = z
    .object({
      templateUuid: z.string().uuid(),
      version: z.number().int(),
      aircraftUuid: z.string(),
      rowIds: z.array(z.string()).min(1).max(500),
    })
    .parse(raw);
  const t = s.componentTemplates?.find((t) => t.uuid === input.templateUuid);
  const a = s.aircraft.find((a) => a.uuid === input.aircraftUuid);
  if (
    !t ||
    !ownsActive(s, t.programUuid) ||
    !a ||
    !can(s, a.uuid, "maintenance")
  )
    throw Error("Template and aircraft maintenance access required.");
  if (t.version !== input.version)
    throw Error("Template changed. Reopen the preview.");
  if (!matchesComponentTemplate(t, a))
    throw Error("Aircraft make and model must match the template.");
  const rows = t.rows.filter((r) => input.rowIds.includes(r.id));
  if (rows.length !== new Set(input.rowIds).size)
    throw Error("Unknown template row.");
  const added: ComponentSetup[] = [];
  const mapped = new Map<string, string>();
  for (const r of rows) {
    const prior = s.componentSetups?.find(
      (d) =>
        d.aircraftUuid === a.uuid &&
        d.templateUuid === t.uuid &&
        d.row.id === r.id,
    );
    if (prior) {
      mapped.set(r.id, prior.uuid);
      continue;
    }
    if (
      componentDuplicate(
        { ...s, componentSetups: [...(s.componentSetups ?? []), ...added] },
        a.uuid,
        r,
      )
    )
      throw Error(
        `Possible duplicate: ${r.model}. Deselect it or differentiate its name/position in the template.`,
      );
    if (
      (!a.helicopter && /Rotor$/.test(r.componentType)) ||
      (a.helicopter && r.componentType === "Propeller")
    )
      throw Error("Component type does not match this aircraft category.");
    const d = {
      uuid: crypto.randomUUID(),
      programUuid,
      aircraftUuid: a.uuid,
      templateUuid: t.uuid,
      templateName: t.name,
      row: r,
    };
    added.push(d);
    mapped.set(r.id, d.uuid);
  }
  for (const d of added)
    if (d.row.parentId) {
      const parent =
        mapped.get(d.row.parentId) ??
        s.componentSetups?.find(
          (p) =>
            p.aircraftUuid === a.uuid &&
            p.templateUuid === t.uuid &&
            p.row.id === d.row.parentId,
        )?.uuid;
      if (!parent)
        throw Error(`Select the parent row for ${d.row.model} as well.`);
      d.parentComponentUuid = parent;
    }
  s.componentSetups = [...(s.componentSetups ?? []), ...added];
  return added;
}
