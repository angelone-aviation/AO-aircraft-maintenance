/**
 * Responsibility: Reference manuals: the stored manual and what it applies
 *   to, the rules for editing one, the PDF file rule, and references to a
 *   manual's pages.
 * Layer: Domain. Pure zod schemas and functions; no I/O, no React.
 * Dependencies: zod, src/domain/model.ts, src/domain/rejection.ts.
 */
import { z } from "zod";
import { can, type Snapshot } from "./model";
import { Rejection } from "./rejection";

/** The largest manual PDF accepted: 200 MiB. */
export const MAX_MANUAL_BYTES = 200 * 1024 * 1024;

/** Longest manufacturer or model an applicability names. */
export const APPLICABILITY_NAME_MAX_LENGTH = 150;
/** Longest part number an applicability names. */
export const APPLICABILITY_PART_NUMBER_MAX_LENGTH = 100;

/** The aircraft or component model a manual applies to. */
export const manualApplicabilitySchema = z.object({
  kind: z.enum(["aircraft", "component"]),
  manufacturer: z.string().trim().max(APPLICABILITY_NAME_MAX_LENGTH),
  model: z.string().trim().min(1).max(APPLICABILITY_NAME_MAX_LENGTH),
  partNumber: z.string().trim().max(APPLICABILITY_PART_NUMBER_MAX_LENGTH),
});

/** A parsed {@link manualApplicabilitySchema} applicability. */
export type ManualApplicability = z.infer<typeof manualApplicabilitySchema>;

/** A manual as uploaded: its aircraft, title, revision and PDF details. */
export const manualInputSchema = z.object({
  applicability: manualApplicabilitySchema.optional(),
  aircraftUuid: z.string().min(1).max(200),
  title: z.string().trim().min(1).max(300),
  documentNumber: z.string().trim().max(200),
  revision: z.string().trim().min(1).max(300),
  revisionDate: z.union([z.iso.date(), z.literal("")]),
  filename: z.string().min(1).max(300),
  size: z.number().int().positive().max(MAX_MANUAL_BYTES),
  pageCount: z.number().int().positive().max(100000),
});

/** A parsed {@link manualInputSchema} manual. */
export type ManualInput = z.infer<typeof manualInputSchema>;

/** A stored manual, with who uploaded it and when. */
export interface Manual extends ManualInput {
  uuid: string;
  uploadedAt: number;
  uploadedBy: string;
}

/** A section, printed page and PDF page in a manual. */
export const manualReferenceSchema = z.object({
  manualUuid: z.string().uuid(),
  section: z.string().trim().max(200),
  printedPage: z.string().trim().max(100),
  pdfPage: z.number().int().positive(),
});

/** A parsed {@link manualReferenceSchema} reference. */
export type ManualReference = z.infer<typeof manualReferenceSchema>;

/**
 * Checks a manual file before upload.
 *
 * @param file - The file's name, size in bytes and MIME type ("" if unknown).
 * @throws {Rejection} "Choose a PDF up to 200 MiB." unless the name ends in
 *   ".pdf" (any case), the type is "" or a PDF's, and the size is in range.
 */
export function validateManualFile(file: {
  name: string;
  size: number;
  type: string;
}) {
  if (
    !/\.pdf$/i.test(file.name) ||
    (file.type && file.type !== "application/pdf") ||
    file.size <= 0 ||
    file.size > MAX_MANUAL_BYTES
  )
    throw new Rejection("Choose a PDF up to 200 MiB.");
}

/**
 * Checks that a reference points within a manual the user can read.
 *
 * @param s - The snapshot, for the manuals and the user's access.
 * @param ref - The reference; none is valid.
 * @throws {Rejection} "Reference manual is not available in this workspace."
 *   for a missing manual or one the user cannot read; "PDF page must be
 *   between 1 and <page count>." past its last page.
 */
export function validateManualReference(
  s: Snapshot,
  ref?: ManualReference | null,
) {
  if (!ref) return;
  const m = s.manuals?.find((m) => m.uuid === ref.manualUuid);
  if (!m || !can(s, m.aircraftUuid, "read"))
    throw new Rejection("Reference manual is not available in this workspace.");
  if (ref.pdfPage > m.pageCount)
    throw new Rejection(`PDF page must be between 1 and ${m.pageCount}.`);
}

/** A manual's editable fields; any other key, such as the file's, is refused. */
export const manualEditSchema = manualInputSchema
  .pick({
    title: true,
    documentNumber: true,
    revision: true,
    revisionDate: true,
    aircraftUuid: true,
    applicability: true,
  })
  .strict();

/** A parsed {@link manualEditSchema} edit. */
export type ManualEdit = z.infer<typeof manualEditSchema>;

/**
 * A checked change to one manual: the fields to write, and the change-log
 * entry's `before` and `after`.
 */
export interface ManualChange<T> {
  /** The fields to set; a key present as `undefined` clears that field. */
  patch: Partial<ManualEdit>;
  before: T;
  after: T;
}

/**
 * Refuses a manual the user may not maintain.
 *
 * @param s - The snapshot, for the user's access.
 * @param manual - The manual, or nothing when it does not exist.
 * @throws {Rejection} "Maintenance access is required." for a missing manual
 *   or one on an aircraft the user cannot maintain.
 */
export function assertManualMaintainer<M extends Manual>(
  s: Snapshot,
  manual: M | null | undefined,
): asserts manual is M {
  if (!manual || !can(s, manual.aircraftUuid, "maintenance"))
    throw new Rejection("Maintenance access is required.");
}

/**
 * Checks an edit to a manual's details. It may move the manual to another
 * aircraft of the same Flight Program that the user maintains.
 *
 * @param s - The snapshot, for the aircraft and the user's access.
 * @param manual - The manual, or nothing when it does not exist.
 * @param raw - The details, as {@link manualEditSchema}; leaving out
 *   applicability clears it.
 * @returns The details to write; `before` holds the editable fields as they
 *   were, and `after` the parsed details.
 * @throws {Rejection} As {@link assertManualMaintainer}, first; then "Choose
 *   an aircraft in the same Flight Program with maintenance access."
 * @throws {z.ZodError} For invalid details, after the access check.
 */
export function editManual(
  s: Snapshot,
  manual: Manual | null | undefined,
  raw: unknown,
): ManualChange<ManualEdit> {
  assertManualMaintainer(s, manual);
  const input = manualEditSchema.parse(raw);
  assertSameProgramTarget(s, manual.aircraftUuid, input.aircraftUuid);
  return {
    // Named even when absent, so writing the patch clears the stored one.
    patch: { ...input, applicability: input.applicability },
    before: {
      title: manual.title,
      documentNumber: manual.documentNumber,
      revision: manual.revision,
      revisionDate: manual.revisionDate,
      aircraftUuid: manual.aircraftUuid,
      applicability: manual.applicability,
    },
    after: input,
  };
}

/**
 * Checks a new title for a manual; its PDF and references stay.
 *
 * @param s - The snapshot, for the user's access.
 * @param manual - The manual, or nothing when it does not exist.
 * @param raw - The title; trimmed, 1 to 300 characters.
 * @returns The title to write, with the old and new title for the change log.
 * @throws {Rejection} As {@link assertManualMaintainer}, first.
 * @throws {z.ZodError} For an invalid title.
 */
export function renameManual(
  s: Snapshot,
  manual: Manual | null | undefined,
  raw: unknown,
): ManualChange<{ title: string }> {
  assertManualMaintainer(s, manual);
  const title = manualInputSchema.shape.title.parse(raw);
  return {
    patch: { title },
    before: { title: manual.title },
    after: { title },
  };
}

/**
 * Checks the aircraft or component model a manual applies to.
 *
 * @param s - The snapshot, for the user's access.
 * @param manual - The manual, or nothing when it does not exist.
 * @param raw - The applicability, as {@link manualApplicabilitySchema}.
 * @returns The applicability to write, with the old and new one for the
 *   change log.
 * @throws {Rejection} As {@link assertManualMaintainer}, first.
 * @throws {z.ZodError} For an invalid applicability.
 */
export function setManualApplicability(
  s: Snapshot,
  manual: Manual | null | undefined,
  raw: unknown,
): ManualChange<ManualApplicability | undefined> {
  assertManualMaintainer(s, manual);
  const applicability = manualApplicabilitySchema.parse(raw);
  return {
    patch: { applicability },
    before: manual.applicability,
    after: applicability,
  };
}

function assertSameProgramTarget(
  s: Snapshot,
  fromUuid: string,
  toUuid: string,
): void {
  const source = s.aircraft.find((a) => a.uuid === fromUuid);
  const target = s.aircraft.find((a) => a.uuid === toUuid);
  if (
    !target ||
    !source ||
    target.programUuid !== source.programUuid ||
    !can(s, target.uuid, "maintenance")
  )
    throw new Rejection(
      "Choose an aircraft in the same Flight Program with maintenance access.",
    );
}
