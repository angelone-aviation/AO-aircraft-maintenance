/**
 * Responsibility: Checklist documents in ForeFlight's .fmd JSON format, the
 *   stored checklist record, and who may read, edit and save one.
 * Layer: Domain. Zod schemas, rules and an applier on a working snapshot; no
 *   I/O, no React.
 * Dependencies: zod, src/domain/model.ts, src/domain/programs.ts,
 *   src/domain/rejection.ts, src/domain/commandRequest.ts,
 *   src/domain/changeLog.ts.
 *
 * The format nests category → group → list → item; the schemas are loose so
 * fields this app does not read survive import, edit and export unchanged.
 */
import { z } from "zod";
import { can, type Snapshot } from "./model";
import { activeProgram, ownsActive, programPermission } from "./programs";
import { Rejection } from "./rejection";
import { requestUuidField } from "./commandRequest";
import { auditEntry } from "./changeLog";

// Limits from docs/checklists.md. Convex keeps each record in one document of
// at most 1 MiB, so the encoded document must leave room for the record.
const MAX_ENTRIES = 10_000;
const MAX_DOCUMENT_BYTES = 750_000;

const CATEGORY_TYPES = ["normal", "abnormal", "emergency"] as const;

const text = z.string().max(20000);
const id = z.string().min(1).max(200);

/**
 * One checklist entry: a check, or a heading or note when `type` is
 * "comment". `actions` are kept from the source but never run.
 */
export const checklistItemSchema = z.looseObject({
  objectId: id,
  type: z.enum(["comment"]).optional(),
  title: text.optional(),
  detail: text.optional(),
  note: text.optional(),
  actions: z.array(z.unknown()).max(100).optional(),
});

/** One checklist: a titled list of entries. */
export const checklistListSchema = z.looseObject({
  objectId: id,
  title: text,
  items: z.array(checklistItemSchema).max(3000).default([]),
});

/** A titled group of checklists within a category. */
export const checklistGroupSchema = z.looseObject({
  objectId: id,
  title: text,
  items: z.array(checklistListSchema).max(200).default([]),
});

/**
 * A whole .fmd checklist set (schema version 1.0) with at most one normal,
 * abnormal and emergency category.
 *
 * @throws {z.ZodError} From `parse()` on an invalid field, with a custom issue
 *   per repeated object id ("Checklist contains duplicate item identifiers.")
 *   and per repeated category ("Checklist contains a repeated category."), in
 *   document order, then "Checklist is too large. Split it into smaller
 *   checklist files." over 10,000 entries or 750,000 bytes of JSON.
 */
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
            groupType: z.enum(CATEGORY_TYPES),
            items: z.array(checklistGroupSchema).max(100).default([]),
          }),
        )
        .max(3),
    }),
  })
  .superRefine((doc, ctx) => {
    for (const message of listDocumentIssues(doc))
      ctx.addIssue({ code: "custom", message });
  });

/** A parsed .fmd checklist set. */
export type ChecklistDocument = z.infer<typeof fmdSchema>;
/** A parsed checklist entry. */
export type ChecklistItem = z.infer<typeof checklistItemSchema>;
/** A parsed checklist. */
export type ChecklistList = z.infer<typeof checklistListSchema>;
/** A parsed group of checklists. */
export type ChecklistGroup = z.infer<typeof checklistGroupSchema>;

/**
 * A stored checklist set. An empty `aircraftUuid` makes it a program library
 * checklist rather than one for a single aircraft.
 */
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

/** A parsed {@link checklistRecordSchema} record. */
export type ChecklistRecord = z.infer<typeof checklistRecordSchema>;

/**
 * A request to save a checklist set over the version the editor opened, with
 * its request id when the client sends one.
 */
export const checklistCommandSchema = z.object({
  record: checklistRecordSchema,
  baseVersion: z.number().int().nonnegative(),
  ...requestUuidField,
});

/** A parsed {@link checklistCommandSchema} command. */
export type ChecklistCommand = z.infer<typeof checklistCommandSchema>;

/**
 * Makes a new object id in the format's style.
 *
 * @returns A random UUID as 32 lower-case hex digits, without hyphens.
 */
export const checklistId = () => crypto.randomUUID().replaceAll("-", "");

/**
 * Starts a blank checklist set for a person to fill in.
 *
 * @returns A set named "New checklist" with empty normal, abnormal and
 *   emergency categories, in that order, each with a new object id.
 */
export function emptyChecklist(): ChecklistDocument {
  return {
    type: "checklist",
    payload: {
      objectId: checklistId(),
      schemaVersion: "1.0",
      metadata: { name: "New checklist", detail: "", tailNumber: "" },
      groups: CATEGORY_TYPES.map((groupType) => ({
        objectId: checklistId(),
        groupType,
        items: [],
      })),
    },
  };
}

/**
 * Counts what a checklist set holds.
 *
 * @param doc - The checklist set.
 * @returns `lists`, the checklists in every category; `entries`, all their
 *   entries; `checks`, the entries that are not comments.
 */
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

/**
 * Tells whether the user may read a checklist set: it belongs to the active
 * program, and the user may read its aircraft or, for a library checklist,
 * the program.
 *
 * @param s - The snapshot, for the user and their groups.
 * @param record - The checklist set.
 * @returns True when the user may read it.
 */
export function checklistReadable(s: Snapshot, record: ChecklistRecord) {
  if (!ownsActive(s, record.programUuid)) return false;
  return record.aircraftUuid
    ? can(s, record.aircraftUuid, "read")
    : programPermission(s, "read", record.programUuid);
}

/**
 * Tells whether the user may create or edit a checklist set for an aircraft
 * or, with an empty `aircraftUuid`, for the program library.
 *
 * @param s - The snapshot.
 * @param aircraftUuid - The aircraft, or "" for a library checklist.
 * @param programUuid - The program; the active one by default.
 * @returns False unless the program is the active one. For an aircraft, true
 *   when it is in that program and the user has `maintenance` or `flight` on
 *   it; for the library, true for a program administrator.
 */
export function checklistEditable(
  s: Snapshot,
  aircraftUuid: string,
  programUuid = activeProgram(s),
) {
  if (!programUuid || !ownsActive(s, programUuid)) return false;
  if (!aircraftUuid) return programPermission(s, "admin", programUuid);
  const inProgram = s.aircraft.some(
    (a) => a.uuid === aircraftUuid && a.programUuid === programUuid,
  );
  return (
    inProgram &&
    (can(s, aircraftUuid, "maintenance") || can(s, aircraftUuid, "flight"))
  );
}

/**
 * Saves a checklist set over the version the editor opened, as the next
 * version, stamped with the user and time, and adds a "checklist.saved"
 * change-log entry holding its version, name and counts: the body is large
 * and stays out of the change log.
 *
 * @param s - The working snapshot; its `checklists` and change log change.
 * @param raw - The command, untrusted.
 * @param now - The save time in epoch milliseconds.
 * @returns The saved record, which replaces any earlier one with its uuid.
 * @throws {z.ZodError} When the command does not parse.
 * @throws {Rejection} "Checklist editing permission denied." unless the user
 *   may edit both the saved record and the stored one; "This checklist
 *   changed. Reopen it before saving; your draft has not been applied." when
 *   `baseVersion` is not the stored version (0 for a new set).
 */
export function saveChecklist(
  s: Snapshot,
  raw: ChecklistCommand,
  now = Date.now(),
): ChecklistRecord {
  const { record, baseVersion } = checklistCommandSchema.parse(raw);
  const existing = s.checklists?.find((c) => c.uuid === record.uuid);
  assertSavable(s, record, existing, baseVersion);
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
  s.audit.unshift(
    auditEntry(
      s,
      {
        action: "checklist.saved",
        entityUuid: next.uuid,
        aircraftUuid: next.aircraftUuid || undefined,
        after: {
          version: next.version,
          name: next.document.payload.metadata.name,
          ...checklistCounts(next.document),
        },
      },
      now,
    ),
  );
  return next;
}

function assertSavable(
  s: Snapshot,
  record: ChecklistRecord,
  existing: ChecklistRecord | undefined,
  baseVersion: number,
) {
  // Both ends are checked, so a set cannot be moved off or onto an aircraft
  // the user may not edit.
  if (
    !checklistEditable(s, record.aircraftUuid, record.programUuid) ||
    (existing &&
      !checklistEditable(s, existing.aircraftUuid, existing.programUuid))
  )
    throw new Rejection("Checklist editing permission denied.");
  // Unreachable while checklistEditable requires the active program for both.
  if (existing && existing.programUuid !== record.programUuid)
    throw new Error("A checklist cannot change Flight Program.");
  if ((existing?.version ?? 0) !== baseVersion)
    throw new Rejection(
      "This checklist changed. Reopen it before saving; your draft has not been applied.",
    );
}

function listDocumentIssues(doc: ChecklistDocument): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  const categories = new Set<string>();
  const noteId = (objectId: string) => {
    if (ids.has(objectId))
      issues.push("Checklist contains duplicate item identifiers.");
    ids.add(objectId);
  };
  noteId(doc.payload.objectId);
  for (const category of doc.payload.groups) {
    if (categories.has(category.groupType))
      issues.push("Checklist contains a repeated category.");
    categories.add(category.groupType);
    listCategoryIds(category).forEach(noteId);
  }
  if (isTooLarge(doc))
    issues.push(
      "Checklist is too large. Split it into smaller checklist files.",
    );
  return issues;
}

function listCategoryIds(
  category: ChecklistDocument["payload"]["groups"][number],
): string[] {
  return [
    category.objectId,
    ...category.items.flatMap((group) => [
      group.objectId,
      ...group.items.flatMap((list) => [
        list.objectId,
        ...list.items.map((item) => item.objectId),
      ]),
    ]),
  ];
}

function isTooLarge(doc: ChecklistDocument): boolean {
  return (
    checklistCounts(doc).entries > MAX_ENTRIES ||
    new TextEncoder().encode(JSON.stringify(doc)).byteLength >
      MAX_DOCUMENT_BYTES
  );
}
