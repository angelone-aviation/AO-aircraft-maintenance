import { internalAction } from "./_generated/server";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
export const upload = internalAction({
  args: { email: v.string(), pdfs: v.array(v.string()) },
  handler: async (ctx, { email, pdfs }): Promise<{ created: boolean }> => {
    if (pdfs.length !== 4) throw new Error("Provide four PDFs.");
    const files = [];
    let committed = false;
    try {
      for (const pdf of pdfs) {
        const bytes = Uint8Array.from(atob(pdf), (c) => c.charCodeAt(0));
        if (
          bytes.length > 1000000 ||
          !new TextDecoder().decode(bytes.slice(0, 5)).startsWith("%PDF-")
        )
          throw new Error("Invalid sample PDF.");
        files.push({
          storageId: await ctx.storage.store(
            new Blob([bytes], { type: "application/pdf" }),
          ),
          size: bytes.length,
        });
      }
      const result = await ctx.runMutation(
        makeFunctionReference<"mutation">("sampleProgram:attach"),
        { email, files },
      );
      committed = result.created;
      return result;
    } finally {
      if (!committed)
        for (const f of files) await ctx.storage.delete(f.storageId);
    }
  },
});
