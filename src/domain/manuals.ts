import { z } from "zod";
import { can, type Snapshot } from "./model";
export const MAX_MANUAL_BYTES = 200 * 1024 * 1024;
export const manualApplicabilitySchema = z.object({
  kind: z.enum(["aircraft", "component"]),
  manufacturer: z.string().trim().max(150),
  model: z.string().trim().min(1).max(150),
  partNumber: z.string().trim().max(100),
});
export type ManualApplicability = z.infer<typeof manualApplicabilitySchema>;
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
export type ManualInput = z.infer<typeof manualInputSchema>;
export interface Manual extends ManualInput {
  uuid: string;
  uploadedAt: number;
  uploadedBy: string;
}
export const manualReferenceSchema = z.object({
  manualUuid: z.string().uuid(),
  section: z.string().trim().max(200),
  printedPage: z.string().trim().max(100),
  pdfPage: z.number().int().positive(),
});
export type ManualReference = z.infer<typeof manualReferenceSchema>;
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
    throw new Error("Choose a PDF up to 200 MB.");
}
export function validateManualReference(
  s: Snapshot,
  ref?: ManualReference | null,
) {
  if (!ref) return;
  const m = s.manuals?.find((m) => m.uuid === ref.manualUuid);
  if (!m || !can(s, m.aircraftUuid, "read"))
    throw new Error("Reference manual is not available in this workspace.");
  if (ref.pdfPage > m.pageCount)
    throw new Error(`PDF page must be between 1 and ${m.pageCount}.`);
}

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
export type ManualEdit = z.infer<typeof manualEditSchema>;
