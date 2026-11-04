/**
 * Responsibility: Reads AD entries from a Word (.docx) AD compliance report.
 * Layer: Data. Browser file parser (fflate, DOMParser); no React.
 * Dependencies: fflate, src/domain/airworthiness.ts.
 *
 * Reads the tables of the CompReport_N626KB.docx layout: a section table
 * ("Airframe", "Engine", ...) with Make, Model and N-No., then one table per
 * AD whose first cell is the AD number and whose other cells are "Label:
 * value" fields.
 */
import { unzipSync, strFromU8 } from "fflate";
import { adNumber, type ADSource } from "../domain/airworthiness";

const SECTIONS: string[] = ["Airframe", "Engine", "Propeller", "Appliance"];
const AD_NUMBER = /^\d{2,4}-\d{2}-\d{2}/;
const MAX_REPORT_BYTES = 10 * 1024 * 1024;
// Caps the unzipped XML, so a small zip cannot expand into a huge document.
const MAX_DOCUMENT_XML_BYTES = 20 * 1024 * 1024;
const DOCUMENT_XML = "word/document.xml";
const WORDPROCESSINGML =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/** AD entries read from a compliance report, for review before import. */
export interface ADImport {
  /** The last N-No. given in a section table, or "". */
  registration: string;
  entries: ADSource[];
  /** Duplicates, circular supersessions and missing effective dates. */
  warnings: string[];
}

/** The section table fields that apply to the AD tables after it. */
type SectionContext = Pick<ADSource, "section" | "make" | "model">;

/**
 * Turns report tables into AD sources, each tagged with the section, make and
 * model of the section table before it ("Airframe" with no make or model
 * until one appears). Other tables are skipped.
 *
 * @param tables - Each table's rows of cell text.
 * @returns The entries in report order, and warnings in entry order.
 *   Recurring is "Unknown" unless the report says exactly "Yes" or "No".
 * @throws {Error} "No AD tables found. Choose a DOCX compliance report with AD
 *   number and subject fields." when no table starts with an AD number.
 */
export function parseADTables(tables: string[][][]): ADImport {
  let context: SectionContext = { section: "Airframe", make: "", model: "" };
  let registration = "";
  const entries: ADSource[] = [];
  for (const rows of tables) {
    const cells = rows.flat();
    const first = cells[0]?.trim() ?? "";
    if (SECTIONS.includes(first)) {
      const text = cells.join("\n");
      context = readSection(first as ADSource["section"], text);
      registration =
        text.match(/N-No\.:\s*([^\n]*)/)?.[1]?.trim() || registration;
    } else if (AD_NUMBER.test(first))
      entries.push(readEntry(rows, cells, first, context));
  }
  if (!entries.length)
    throw Error(
      "No AD tables found. Choose a DOCX compliance report with AD number and subject fields.",
    );
  return { registration, entries, warnings: listWarnings(entries) };
}

/**
 * Reads the AD tables of a .docx compliance report.
 *
 * @param file - The uploaded report.
 * @returns As {@link parseADTables}.
 * @throws {Error} "Choose a .docx Word document. Save older .doc files as
 *   .docx first."; "Report must be smaller than 10 MB." (10 MiB); "Document
 *   is invalid or its contents exceed 20 MB." without a document part under
 *   20 MiB unzipped; "Unable to read Word document XML."; fflate's error for
 *   a file that is not a zip; and as {@link parseADTables}.
 */
export async function importADDocx(file: File): Promise<ADImport> {
  if (!file.name.toLowerCase().endsWith(".docx"))
    throw Error(
      "Choose a .docx Word document. Save older .doc files as .docx first.",
    );
  if (file.size > MAX_REPORT_BYTES)
    throw Error("Report must be smaller than 10 MB.");
  const doc = await readDocumentXml(file);
  return parseADTables(readTables(doc));
}

function readSection(
  section: ADSource["section"],
  text: string,
): SectionContext {
  return {
    section,
    make: text.match(/Make:\s*(.*?)\s*Model:/s)?.[1]?.trim() ?? "",
    model: text.match(/Model:\s*([^\n]*)/)?.[1]?.trim() ?? "",
  };
}

function readEntry(
  rows: string[][],
  cells: string[],
  number: string,
  context: SectionContext,
): ADSource {
  const field = (label: string) =>
    cells
      .find((c) => c.startsWith(label + ":"))
      ?.slice(label.length + 1)
      .trim() ?? "";
  const recurring = field("Recurring");
  return {
    number,
    amendment: field("Amdt"),
    issued: field("Iss"),
    effective: field("Eff"),
    subject: field("Subject"),
    recurring:
      recurring === "Yes" || recurring === "No" ? recurring : "Unknown",
    supersededBy: field("Superseded by"),
    ...context,
    url: "",
    source: "Word compliance report",
    sourceNotes: rows.map((r) => r.join(" | ")).join("\n"),
  };
}

function listWarnings(entries: ADSource[]): string[] {
  const warnings: string[] = [];
  const keys = new Set<string>();
  for (const e of entries) {
    const key = e.section + e.make + e.model + adNumber(e.number);
    if (keys.has(key)) warnings.push(`Duplicate ${e.number} in ${e.section}.`);
    keys.add(key);
    const target = entries.find(
      (t) => adNumber(t.number) === adNumber(e.supersededBy),
    );
    if (target && adNumber(target.supersededBy) === adNumber(e.number))
      warnings.push(
        `${e.number}: circular supersession reference with ${target.number}; verify FAA source.`,
      );
    if (!e.effective) warnings.push(`${e.number}: effective date missing.`);
  }
  return warnings;
}

async function readDocumentXml(file: File): Promise<Document> {
  const zip = unzipSync(new Uint8Array(await file.arrayBuffer()), {
    filter: (e) =>
      e.name === DOCUMENT_XML && e.originalSize < MAX_DOCUMENT_XML_BYTES,
  });
  if (!zip[DOCUMENT_XML])
    throw Error("Document is invalid or its contents exceed 20 MB.");
  const doc = new DOMParser().parseFromString(
    strFromU8(zip[DOCUMENT_XML]),
    "application/xml",
  );
  if (doc.getElementsByTagName("parsererror").length)
    throw Error("Unable to read Word document XML.");
  return doc;
}

// A row also holds its properties (w:trPr), so only its w:tc children are
// cells; a cell's text is its text runs joined by spaces.
function readTables(doc: Document): string[][][] {
  return Array.from(doc.getElementsByTagNameNS(WORDPROCESSINGML, "tbl")).map(
    (t) =>
      Array.from(t.getElementsByTagNameNS(WORDPROCESSINGML, "tr")).map((r) =>
        Array.from(r.children)
          .filter((c) => c.localName === "tc")
          .map((c) =>
            Array.from(c.getElementsByTagNameNS(WORDPROCESSINGML, "t"))
              .map((t) => t.textContent)
              .join(" ")
              .trim(),
          ),
      ),
  );
}
