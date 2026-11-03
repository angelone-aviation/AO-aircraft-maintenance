import { getDocument } from "./pdfRuntime";
import { readPdfText } from "./pdfText";
import { validateManualFile } from "../domain/manuals";
export async function inspectManualPdf(file: File) {
  validateManualFile(file);
  const task = getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    useSystemFonts: true,
  });
  const password = new Promise<never>((_, reject) => {
    task.onPassword = () =>
      reject(new Error("Upload a PDF that opens without a password."));
  });
  try {
    return (await Promise.race([task.promise, password])).numPages;
  } finally {
    await task.destroy();
  }
}

export async function searchManualPdf(
  url: string,
  manualUuid: string,
  fromPage: number,
  toPage: number,
  onProgress: (
    page: number,
    candidates: import("../domain/manualDiscovery").ManualCandidate[],
  ) => void,
  signal: AbortSignal,
) {
  const { discoverPage } = await import("../domain/manualDiscovery");
  const task = getDocument({ url, useSystemFonts: true });
  const abort = () => {
    void task.destroy();
  };
  signal.addEventListener("abort", abort, { once: true });
  let textPages = 0;
  const emptyPages: number[] = [];
  try {
    if (signal.aborted) throw new DOMException("Search canceled", "AbortError");
    const password = new Promise<never>((_, reject) => {
      task.onPassword = () =>
        reject(new Error("This PDF requires a password."));
    });
    const pdf = await Promise.race([task.promise, password]);
    if (
      !Number.isInteger(fromPage) ||
      !Number.isInteger(toPage) ||
      fromPage < 1 ||
      toPage > pdf.numPages ||
      fromPage > toPage
    )
      throw new Error("Choose a valid PDF page range.");
    for (let n = fromPage; n <= toPage; n++) {
      if (signal.aborted)
        throw new DOMException("Search canceled", "AbortError");
      const page = await pdf.getPage(n);
      const content = await readPdfText(page);
      let text = "";
      let previousY: number | undefined;
      for (const item of content.items) {
        if (!("str" in item)) continue;
        const y = item.transform[5];
        if (
          previousY !== undefined &&
          Math.abs(previousY - y) > 3 &&
          !text.endsWith("\n")
        )
          text += "\n";
        text += item.str + (item.hasEOL ? "\n" : " ");
        previousY = y;
      }
      if (text.trim().length < 30) emptyPages.push(n);
      else textPages++;
      onProgress(n, discoverPage(manualUuid, n, text));
      page.cleanup();
      // Yield between pages so progress and Cancel remain responsive on large manuals.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return { textPages, emptyPages };
  } finally {
    signal.removeEventListener("abort", abort);
    await task.destroy();
  }
}
