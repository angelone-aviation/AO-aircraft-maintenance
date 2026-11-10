/**
 * Responsibility: Writes the board summary as a one-document PDF: fleet
 *   status, each aircraft's line, the next 30 days' due items, spend against
 *   budget and the backup line.
 * Layer: Data. Browser-side jsPDF rendering through pdfLayout; no React.
 * Dependencies: ./pdfLayout, ./pdfFont, src/domain (boardSummary,
 *   aircraftStatus, costs).
 */
import type { jsPDF } from "jspdf";
import { paragraphPdf, type Paragraph } from "./pdfLayout";
import { loadDejaVuFont } from "./pdfFont";
import type { BoardSummary, BoardAircraftLine } from "../domain/boardSummary";
import { aircraftStatusLabels } from "../domain/aircraftStatus";
import { formatCents } from "../domain/costs";

/**
 * Lays the board summary out as paragraphs, then as a PDF.
 *
 * @param summary - The summary to print.
 * @returns The document, ready for `save()`, in DejaVu Sans.
 * @throws {Error} "Unable to load the PDF font. Reconnect and try again." when
 *   the font request fails with an HTTP error; a network failure rejects with
 *   fetch's own error.
 */
export async function boardSummaryPdf(summary: BoardSummary): Promise<jsPDF> {
  return paragraphPdf(boardSummaryParagraphs(summary), await loadDejaVuFont());
}

/**
 * The board summary as paragraphs, in reading order: title, fleet status,
 * one line per aircraft, the due list, then the backup line and a note that
 * the document reports recorded status only.
 *
 * @param summary - The summary to print.
 * @returns Bold headings and plain lines, in plain punctuation.
 */
export function boardSummaryParagraphs(summary: BoardSummary): Paragraph[] {
  const { fleet } = summary;
  return [
    {
      text: `Board summary - ${summary.programName || "Flight Program"}`,
      bold: true,
    },
    {
      text: `Prepared ${summary.today}. Recorded status only; not a maintenance release.`,
    },
    { text: "Fleet status", bold: true },
    {
      text: `Airworthy ${fleet.airworthy} - Due soon ${fleet["due-soon"]} - Grounded ${fleet.grounded} - Overdue items ${summary.overdue}`,
    },
    { text: "Aircraft", bold: true },
    ...summary.aircraft.map((line) => ({ text: describeAircraft(line) })),
    { text: "Due in the next 30 days", bold: true },
    ...(summary.upcoming.length
      ? summary.upcoming.map((i) => ({
          text: `${i.registration} - ${i.kind} - ${i.label} - ${i.remaining}`,
        }))
      : [{ text: "Nothing falls due in the next 30 days." }]),
    { text: "Off-site backup", bold: true },
    {
      text:
        summary.backup?.message ??
        "Backup status is not available in this view.",
    },
  ];
}

function describeAircraft(line: BoardAircraftLine): string {
  const { aircraft: a, costs } = line;
  const spend = costs
    ? `${costs.quarterLabel} spend ${formatCents(costs.quarterCents)}; ${costs.year} ${formatCents(costs.yearCents)}` +
      (costs.budgetCents === undefined
        ? ", no budget set"
        : ` of ${formatCents(costs.budgetCents)} budget${costs.overBudget ? " (over budget)" : ""}`)
    : "Spend not available";
  return (
    `${a.registration} (${a.make} ${a.model}): ${aircraftStatusLabels[line.status]}. ` +
    `${line.overdue} overdue, ${line.dueSoon} due soon. ` +
    `${line.openDiscrepancies} open discrepancies` +
    (line.grounding ? ` (${line.grounding} grounding)` : "") +
    `. ${spend}.`
  );
}
