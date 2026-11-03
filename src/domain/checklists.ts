import { z } from "zod";
import { can, type Snapshot } from "./model";
import { activeProgram, ownsActive, programPermission } from "./programs";
const text = z.string().max(20000);
const id = z.string().min(1).max(200);
// Keep extension fields intact so importing/editing/exporting does not discard source data.
export const checklistItemSchema = z.looseObject({
  objectId: id,
  type: z.enum(["comment"]).optional(),
  title: text.optional(),
  detail: text.optional(),
  note: text.optional(),
  actions: z.array(z.unknown()).max(100).optional(),
});
export const checklistListSchema = z.looseObject({
  objectId: id,
  title: text,
  items: z.array(checklistItemSchema).max(3000).default([]),
});
export const checklistGroupSchema = z.looseObject({
  objectId: id,
  title: text,
  items: z.array(checklistListSchema).max(200).default([]),
});
export const fmdSchema = z
  .looseObject({
    type: z.literal("checklist"),
    payload: z.looseObject({
      objectId: id,
      schemaVersion: z.literal("1.0"),
      metadata: z.looseObject({
        name: text.optional(),
        detail: text.optional(),
        tailNumber: text.optional(),
      }),
      groups: z
        .array(
          z.looseObject({
            objectId: id,
            groupType: z.enum(["normal", "abnormal", "emergency"]),
            items: z.array(checklistGroupSchema).max(100).default([]),
          }),
        )
        .max(3),
    }),
  })
  .superRefine((doc, ctx) => {
    const ids = new Set<string>();
    let count = 0;
    const categories = new Set<string>();
    const unique = (value: string) => {
      if (ids.has(value))
        ctx.addIssue({
          code: "custom",
          message: "Checklist contains duplicate item identifiers.",
        });
      ids.add(value);
    };
    unique(doc.payload.objectId);
    for (const category of doc.payload.groups) {
      if (categories.has(category.groupType))
        ctx.addIssue({
          code: "custom",
          message: "Checklist contains a repeated category.",
        });
      categories.add(category.groupType);
      unique(category.objectId);
      for (const group of category.items) {
        unique(group.objectId);
        for (const list of group.items) {
          unique(list.objectId);
          for (const item of list.items) {
            unique(item.objectId);
            count++;
          }
        }
      }
    }
    if (
      count > 10000 ||
      new TextEncoder().encode(JSON.stringify(doc)).byteLength > 750000
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Checklist is too large. Split it into smaller checklist files.",
      });
  });
export type ChecklistDocument = z.infer<typeof fmdSchema>;
export type ChecklistItem = z.infer<typeof checklistItemSchema>;
export type ChecklistList = z.infer<typeof checklistListSchema>;
export type ChecklistGroup = z.infer<typeof checklistGroupSchema>;
export const checklistRecordSchema = z.object({
  uuid: z.string().uuid(),
  version: z.number().int().nonnegative(),
  programUuid: id,
  aircraftUuid: z.string().max(200),
  sourceName: z.string().max(255),
  updatedAt: z.number(),
  updatedBy: z.string(),
  document: fmdSchema,
});
export type ChecklistRecord = z.infer<typeof checklistRecordSchema>;
export const checklistCommandSchema = z.object({
  record: checklistRecordSchema,
  baseVersion: z.number().int().nonnegative(),
});
export type ChecklistCommand = z.infer<typeof checklistCommandSchema>;
export const checklistId = () => crypto.randomUUID().replaceAll("-", "");
export function emptyChecklist(): ChecklistDocument {
  return {
    type: "checklist",
    payload: {
      objectId: checklistId(),
      schemaVersion: "1.0",
      metadata: { name: "New checklist", detail: "", tailNumber: "" },
      groups: (["normal", "abnormal", "emergency"] as const).map(
        (groupType) => ({ objectId: checklistId(), groupType, items: [] }),
      ),
    },
  };
}
export function checklistCounts(doc: ChecklistDocument) {
  const lists = doc.payload.groups.flatMap((c) =>
    c.items.flatMap((g) => g.items),
  );
  return {
    lists: lists.length,
    entries: lists.reduce((n, l) => n + l.items.length, 0),
    checks: lists.reduce(
      (n, l) => n + l.items.filter((i) => i.type !== "comment").length,
      0,
    ),
  };
}
export function checklistReadable(s: Snapshot, record: ChecklistRecord) {
  return (
    ownsActive(s, record.programUuid) &&
    (record.aircraftUuid
      ? can(s, record.aircraftUuid, "read")
      : programPermission(s, "read", record.programUuid))
  );
}
export function checklistEditable(
  s: Snapshot,
  aircraftUuid: string,
  programUuid = activeProgram(s),
) {
  if (!programUuid || !ownsActive(s, programUuid)) return false;
  if (aircraftUuid)
    return (
      s.aircraft.some(
        (a) => a.uuid === aircraftUuid && a.programUuid === programUuid,
      ) &&
      (can(s, aircraftUuid, "maintenance") || can(s, aircraftUuid, "flight"))
    );
  return programPermission(s, "admin", programUuid);
}
export function saveChecklist(
  s: Snapshot,
  raw: ChecklistCommand,
  now = Date.now(),
) {
  const { record, baseVersion } = checklistCommandSchema.parse(raw);
  const existing = s.checklists?.find((c) => c.uuid === record.uuid);
  if (
    !checklistEditable(s, record.aircraftUuid, record.programUuid) ||
    (existing &&
      !checklistEditable(s, existing.aircraftUuid, existing.programUuid))
  )
    throw new Error("Checklist editing permission denied.");
  if (existing && existing.programUuid !== record.programUuid)
    throw new Error("A checklist cannot change Flight Program.");
  if ((existing?.version ?? 0) !== baseVersion)
    throw new Error(
      "This checklist changed. Reopen it before saving; your draft has not been applied.",
    );
  const next = {
    ...record,
    version: baseVersion + 1,
    updatedAt: now,
    updatedBy: s.user.id,
  };
  s.checklists = [
    ...(s.checklists ?? []).filter((c) => c.uuid !== next.uuid),
    next,
  ];
  return next;
}
