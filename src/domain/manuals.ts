/**
 * Responsibility: Reference manuals: the stored manual and what it applies
 *   to, edits to one, the PDF file rule, and references to a manual's pages.
 * Layer: Domain. Pure zod schemas and functions; no I/O, no React.
 * Dependencies: zod, src/domain/model.ts, src/domain/rejection.ts.
 */
import { z } from "zod";
import { can, type Snapshot } from "./model";
import { Rejection } from "./rejection";

/** The largest manual PDF accepted: 200 MiB (the refusal says "200 MB"). */
export const MAX_MANUAL_BYTES = 200 * 1024 * 1024;

/** The aircraft or component model a manual applies to. */
export const manualApplicabilitySchema = z.object({
  kind: z.enum(["aircraft", "component"]),
  manufacturer: z.string().trim().max(150),
  model: z.string().trim().min(1).max(150),
  partNumber: z.string().trim().max(100),
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
 * @throws {Rejection} "Choose a PDF up to 200 MB." unless the name ends in
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
    throw new Rejection("Choose a PDF up to 200 MB.");
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
