/**
 * Responsibility: Stores the four example PDFs of the hosted sample program
 *   and hands them to sampleProgram:attach.
 * Layer: Server. Internal action, run by hand after sampleProgram:seed.
 * Dependencies: convex/server, convex/values, convex/_generated/server.
 */
import { internalAction, type ActionCtx } from "./_generated/server";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

// One PDF for each of the four sample aircraft.
const SAMPLE_PDF_COUNT = 4;
const MAX_SAMPLE_PDF_BYTES = 1000000;
const PDF_SIGNATURE = "%PDF-";

type SampleFile = { storageId: Id<"_storage">; size: number };

/**
 * Attaches four example PDFs to the sample program's manuals, task evidence,
 * inventory, work-order and PO files. A repeat run creates nothing.
 *
 * @param email - An administrator's email; sampleProgram:attach refuses others.
 * @param pdfs - Four base64-encoded PDFs of at most 1,000,000 bytes each.
 * @returns `created: false` when the sample documents were already attached.
 * @throws {Error} "Provide four PDFs." or "Invalid sample PDF.", or an error
 *   from sampleProgram:attach. Stored files nothing took are deleted.
 */
export const upload = internalAction({
  args: { email: v.string(), pdfs: v.array(v.string()) },
  handler: async (ctx, { email, pdfs }): Promise<{ created: boolean }> => {
    if (pdfs.length !== SAMPLE_PDF_COUNT) throw new Error("Provide four PDFs.");
    const files: SampleFile[] = [];
    let committed = false;
    try {
      for (const pdf of pdfs) files.push(await storeSamplePdf(ctx, pdf));
      const result = await ctx.runMutation(
        makeFunctionReference<"mutation">("sampleProgram:attach"),
        { email, files },
      );
      committed = result.created;
      return result;
    } finally {
      // File storage is not part of the mutation's transaction, so blobs that
      // no record took must be deleted here.
      if (!committed) await deleteStoredFiles(ctx, files);
    }
  },
});

async function storeSamplePdf(
  ctx: ActionCtx,
  pdf: string,
): Promise<SampleFile> {
  const bytes = Uint8Array.from(atob(pdf), (c) => c.charCodeAt(0));
  const signature = new TextDecoder().decode(
    bytes.slice(0, PDF_SIGNATURE.length),
  );
  if (
    bytes.length > MAX_SAMPLE_PDF_BYTES ||
    !signature.startsWith(PDF_SIGNATURE)
  )
    throw new Error("Invalid sample PDF.");
  return {
    storageId: await ctx.storage.store(
      new Blob([bytes], { type: "application/pdf" }),
    ),
    size: bytes.length,
  };
}

async function deleteStoredFiles(
  ctx: ActionCtx,
  files: SampleFile[],
): Promise<void> {
  for (const file of files) await ctx.storage.delete(file.storageId);
}
