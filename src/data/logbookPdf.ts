import { jsPDF } from "jspdf";
export async function logbookPdf(text: string) {
  const response = await fetch(
    `${import.meta.env.BASE_URL}fonts/DejaVuSans.ttf`,
  );
  if (!response.ok)
    throw new Error("Unable to load the PDF font. Reconnect and try again.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const pdf = new jsPDF({ unit: "mm", format: "a4", compress: true });
  pdf.addFileToVFS("DejaVuSans.ttf", btoa(binary));
  pdf.addFont("DejaVuSans.ttf", "DejaVu", "normal");
  pdf.setFont("DejaVu");
  pdf.setFontSize(10);
  const lines: string[] = pdf.splitTextToSize(
    text
      .replace(/\r/g, "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ""),
    174,
  );
  let y = 20;
  for (const line of lines) {
    if (y > 275) {
      pdf.addPage();
      y = 20;
    }
    pdf.text(line, 18, y);
    y += 5;
  }
  const pages = pdf.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    pdf.setPage(page);
    pdf.setFontSize(8);
    pdf.text(`Page ${page} of ${pages}`, 192, 287, { align: "right" });
  }
  return pdf;
}
