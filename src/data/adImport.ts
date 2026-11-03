import { unzipSync, strFromU8 } from "fflate";
import { adNumber, type ADSource } from "../domain/airworthiness";
export interface ADImport {
  registration: string;
  entries: ADSource[];
  warnings: string[];
}
export function parseADTables(tables: string[][][]): ADImport {
  let section: ADSource["section"] = "Airframe",
    make = "",
    model = "",
    registration = "";
  const entries: ADSource[] = [];
  const warnings: string[] = [];
  for (const rows of tables) {
    const cells = rows.flat();
    const first = cells[0]?.trim() ?? "";
    if (["Airframe", "Engine", "Propeller", "Appliance"].includes(first)) {
      section = first as ADSource["section"];
      const text = cells.join("\n");
      make = text.match(/Make:\s*(.*?)\s*Model:/s)?.[1]?.trim() ?? "";
      model = text.match(/Model:\s*([^\n]*)/)?.[1]?.trim() ?? "";
      registration =
        text.match(/N-No\.:\s*([^\n]*)/)?.[1]?.trim() || registration;
      continue;
    }
    if (!/^\d{2,4}-\d{2}-\d{2}/.test(first)) continue;
    const field = (label: string) =>
      cells
        .find((c) => c.startsWith(label + ":"))
        ?.slice(label.length + 1)
        .trim() ?? "";
    const recurring = field("Recurring");
    entries.push({
      number: first,
      amendment: field("Amdt"),
      issued: field("Iss"),
      effective: field("Eff"),
      subject: field("Subject"),
      recurring:
        recurring === "Yes" || recurring === "No" ? recurring : "Unknown",
      supersededBy: field("Superseded by"),
      section,
      make,
      model,
      url: "",
      source: "Word compliance report",
      sourceNotes: rows.map((r) => r.join(" | ")).join("\n"),
    });
  }
  if (!entries.length)
    throw Error(
      "No AD tables found. Choose a DOCX compliance report with AD number and subject fields.",
    );
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
  return { registration, entries, warnings };
}
export async function importADDocx(file: File): Promise<ADImport> {
  if (!file.name.toLowerCase().endsWith(".docx"))
    throw Error(
      "Choose a .docx Word document. Save older .doc files as .docx first.",
    );
  if (file.size > 10 * 1024 * 1024)
    throw Error("Report must be smaller than 10 MB.");
  const zip = unzipSync(new Uint8Array(await file.arrayBuffer()), {
    filter: (e) =>
      e.name === "word/document.xml" && e.originalSize < 20 * 1024 * 1024,
  });
  if (!zip["word/document.xml"])
    throw Error("Document is invalid or its contents exceed 20 MB.");
  const doc = new DOMParser().parseFromString(
    strFromU8(zip["word/document.xml"]),
    "application/xml",
  );
  if (doc.getElementsByTagName("parsererror").length)
    throw Error("Unable to read Word document XML.");
  const ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  return parseADTables(
    Array.from(doc.getElementsByTagNameNS(ns, "tbl")).map((t) =>
      Array.from(t.getElementsByTagNameNS(ns, "tr")).map((r) =>
        Array.from(r.children)
          .filter((c) => c.localName === "tc")
          .map((c) =>
            Array.from(c.getElementsByTagNameNS(ns, "t"))
              .map((t) => t.textContent)
              .join(" ")
              .trim(),
          ),
      ),
    ),
  );
}
