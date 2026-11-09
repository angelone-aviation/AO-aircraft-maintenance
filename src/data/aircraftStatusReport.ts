/**
 * Responsibility: Prints one aircraft's status sheet as a landscape PDF.
 * Layer: Data. Browser-side jsPDF rendering; no React.
 * Dependencies: src/data/tablePdf.ts (layout), src/domain/statusSheet.ts
 *   (content), src/domain/model.ts (localDate).
 *
 * A summary of recorded status for the 14 CFR 91.417(a)(2) records, not a
 * maintenance release: the footer of every page says so.
 */
import type { jsPDF } from "jspdf";
import { localDate, type Snapshot } from "../domain/model";
import { statusSheet, type StatusSectionId } from "../domain/statusSheet";
import { tablePdf } from "./tablePdf";

/** Relative column widths of each status sheet table. */
export const STATUS_COLUMN_SHARES: Record<StatusSectionId, number[]> = {
  overview: [34, 32, 42, 32, 38, 60],
  components: [45, 65, 39, 28, 28, 28, 26],
  inspections: [46, 27, 29, 25, 24, 23, 22, 22, 28],
  airworthiness: [31, 45, 80, 63, 40],
  form337: [170, 50, 39],
  discrepancies: [30, 200, 29],
};

/** Printed in the footer of every page. */
export const STATUS_SHEET_FOOTER =
  "Recorded status only. Consult aircraft records for actual sign-offs; not a maintenance release.";

/**
 * Builds the status sheet for one aircraft, as recorded in the snapshot, in
 * Helvetica: the built-in font draws printable ASCII only, so dashes print
 * as "-" and other characters as spaces (see {@link tablePdf}).
 *
 * @param state - Snapshot holding the aircraft and its records.
 * @param aircraftUuid - The aircraft to report on.
 * @param now - When the sheet is generated; it sets "today" for due dates.
 * @returns The document, ready for `save()`.
 * @throws {Rejection} "Aircraft not found." when the snapshot lacks the
 *   aircraft.
 */
export function aircraftStatusReport(
  state: Snapshot,
  aircraftUuid: string,
  now = new Date(),
): jsPDF {
  const { header, sections } = statusSheet(
    state,
    aircraftUuid,
    localDate(now.getTime()),
  );
  return tablePdf(
    sections.map((section) => ({
      ...section,
      shares: STATUS_COLUMN_SHARES[section.id],
    })),
    {
      orientation: "landscape",
      header: {
        title: `${header.registration} | AIRCRAFT STATUS SHEET`,
        subtitle: `${header.makeModel} | S/N ${header.serial}`,
        right: `Generated ${formatUtc(now)} UTC`,
      },
      footer: { note: STATUS_SHEET_FOOTER, label: header.registration },
    },
  );
}

function formatUtc(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ");
}
