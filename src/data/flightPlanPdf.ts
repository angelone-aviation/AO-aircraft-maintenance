import { getDocument } from "./pdfRuntime";
import { readPdfText } from "./pdfText";
import { parseIcao } from "../domain/pdf/icao";
export async function readFlightPlanPdf(
  file: File,
  onStage: (stage: string) => void = () => {},
) {
  onStage("Validate file");
  if (!/\.pdf$/i.test(file.name) || file.size > 10 * 1024 * 1024)
    throw new Error("Choose a PDF smaller than 10 MB.");
  onStage("Read file bytes");
  const data = await file.arrayBuffer();
  onStage("Calculate file fingerprint");
  const hash = await crypto.subtle.digest("SHA-256", data);
  const sourceHash = [...new Uint8Array(hash)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
  onStage("Create PDF reader");
  const task = getDocument({
    data: new Uint8Array(data),
    useSystemFonts: true,
  });
  let failed = false;
  try {
    onStage("Open PDF");
    const pdf = await task.promise;
    if (pdf.numPages !== 1)
      throw new Error("Upload the single-page ICAO flight-plan form.");
    onStage("Read first page");
    const page = await pdf.getPage(1);
    onStage("Extract PDF text");
    const content = await readPdfText(page);
    onStage("Normalize PDF text coordinates");
    const [x0, y0, x1, y1] = page.view;
    const items = content.items.flatMap((i) =>
      "str" in i
        ? [
            {
              str: i.str,
              x: ((i.transform[4] - x0) * 594.95996) / (x1 - x0),
              y: ((i.transform[5] - y0) * 841.91998) / (y1 - y0),
            },
          ]
        : [],
    );
    onStage("Parse flight-plan fields");
    return { ...parseIcao(items), sourceName: file.name, sourceHash };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (failed) await task.destroy().catch(() => {});
    else {
      onStage("Close PDF reader");
      await task.destroy();
    }
  }
}
