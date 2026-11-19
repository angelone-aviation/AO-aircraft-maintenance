/**
 * Responsibility: Pins how AD report tables become AD sources and warnings,
 *   and which .docx uploads are refused.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/adImport.ts, fflate.
 *
 * The real N626KB report tables are pinned in
 * src/domain/airworthiness.test.ts.
 */
import { strToU8, zipSync } from "fflate";
import { afterEach, expect, it, vi } from "vitest";
import { importADDocx, parseADTables } from "./adImport";

const WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

afterEach(() => vi.unstubAllGlobals());

it("tags each AD with the section table before it", () => {
  const parsed = parseADTables([
    [["2001-01-01", "Recurring: yes"], ["Eff: 1/1/2001"]],
    [["Engine", "Make: Lycoming", "Model: IO-540"], ["N-No.: N1"]],
    [["2002-02-02", "Recurring: No", "Eff: 2/2/2002"]],
    [["Propeller", "Make: Hartzell Model: HC"]],
    [["Not an AD"]],
    [["2003-03-03", "Eff: 3/3/2003", "Subject: Blade"]],
  ]);
  expect(parsed.registration).toBe("N1");
  expect(
    parsed.entries.map((e) => [e.number, e.section, e.make, e.model]),
  ).toEqual([
    ["2001-01-01", "Airframe", "", ""],
    ["2002-02-02", "Engine", "Lycoming", "IO-540"],
    ["2003-03-03", "Propeller", "Hartzell", "HC"],
  ]);
  expect(parsed.entries.map((e) => e.recurring)).toEqual([
    "Unknown",
    "No",
    "Unknown",
  ]);
  expect(parsed.entries[2]).toMatchObject({
    subject: "Blade",
    sourceNotes: "2003-03-03 | Eff: 3/3/2003 | Subject: Blade",
  });
});

it("warns of duplicates, circular supersessions and missing effective dates", () => {
  const { warnings } = parseADTables([
    [["2001-01-01", "Superseded by: 2002-02-02", "Eff: x"]],
    [["2002-02-02", "Superseded by: 2001-01-01", "Eff: x"]],
    [["2001-01-01"]],
  ]);
  expect(warnings).toEqual([
    "2001-01-01: circular supersession reference with 2002-02-02; verify FAA source.",
    "2002-02-02: circular supersession reference with 2001-01-01; verify FAA source.",
    "Duplicate 2001-01-01 in Airframe.",
    "2001-01-01: effective date missing.",
  ]);
});

// Well above what a real report takes and far below what the quadratic reads
// took (17 s for the 40,000 labels here, 4 s for just 5,000 AD tables).
const LINEAR_TIME_BUDGET_MS = 1000;

it("reads a section table with many labels and no Model in linear time", () => {
  const started = performance.now();
  const parsed = parseADTables([
    [["Engine", "Make: ".repeat(40_000)]],
    [["2020-01-01", "Eff: 1/1/2020"]],
  ]);
  expect(performance.now() - started).toBeLessThan(LINEAR_TIME_BUDGET_MS);
  expect(parsed.entries[0]).toMatchObject({ section: "Engine", make: "" });
});

it("reads the make between the first Make and the next Model", () => {
  const parsed = parseADTables([
    [["Engine", "Make: Lycoming", "Make: x", "Model: IO-540", "Model: y"]],
    [["2020-01-01", "Eff: 1/1/2020"]],
  ]);
  expect(parsed.entries[0]).toMatchObject({
    make: "Lycoming\nMake: x",
    model: "IO-540",
  });
});

it("checks supersessions across many AD tables in linear time", () => {
  const tables = Array.from({ length: 10_000 }, (_, i) => [
    [
      `${1000 + Math.floor(i / 100)}-${String(i % 100).padStart(2, "0")}-01`,
      "Eff: x",
      "Superseded by: x",
    ],
  ]);
  const started = performance.now();
  expect(parseADTables(tables).warnings).toEqual([]);
  expect(performance.now() - started).toBeLessThan(LINEAR_TIME_BUDGET_MS);
});

it("refuses a report without AD tables", () => {
  expect(() => parseADTables([[["Airframe"]]])).toThrow(
    "No AD tables found. Choose a DOCX compliance report with AD number and subject fields.",
  );
});

it("refuses other files before reading them", async () => {
  await expect(importADDocx(new File(["x"], "report.doc"))).rejects.toThrow(
    "Choose a .docx Word document. Save older .doc files as .docx first.",
  );
  const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.docx");
  await expect(importADDocx(big)).rejects.toThrow(
    "Report must be smaller than 10 MB.",
  );
  const empty = new File(
    [zipSync({ "word/x.xml": strToU8("<x/>") })],
    "a.docx",
  );
  await expect(importADDocx(empty)).rejects.toThrow(
    "Document is invalid or its contents exceed 20 MB.",
  );
});

it("reads each row's cells as their text runs joined by spaces", async () => {
  const run = (text: string, ns = WORD) => element("t", [], text, ns);
  const cell = (...texts: string[]) =>
    element(
      "tc",
      texts.map((t) => run(t)),
    );
  const table = element("tbl", [
    element("tr", [
      cell("2001-01-01"),
      element("trPr", [run("ignored")]),
      cell("Subject:", " Pump "),
      element("tc", [run("Eff: x"), run("not Word", "urn:other")]),
    ]),
  ]);
  stubDomParser(element("document", [table]));
  const docx = zipSync({ "word/document.xml": strToU8("<w:document/>") });
  const { entries } = await importADDocx(new File([docx], "r.docx"));
  expect(entries[0].sourceNotes).toBe("2001-01-01 | Subject:  Pump | Eff: x");
});

it("lists a table nested in a cell once, as its own table", async () => {
  const cell = (...children: FakeElement[]) => element("tc", children);
  const text = (t: string) => element("p", [element("t", [], t)]);
  const nested = element("tbl", [
    element("tr", [cell(text("2002-02-02")), cell(text("Eff: 2/2/2002"))]),
  ]);
  const outer = element("tbl", [
    element("tr", [cell(text("2001-01-01")), cell(text("Eff: x"), nested)]),
  ]);
  stubDomParser(element("document", [outer]));
  const docx = zipSync({ "word/document.xml": strToU8("<w:document/>") });
  const { entries } = await importADDocx(new File([docx], "r.docx"));
  expect(entries.map((e) => e.number)).toEqual(["2001-01-01", "2002-02-02"]);
  expect(entries[0]).toMatchObject({
    effective: "x",
    sourceNotes: "2001-01-01 | Eff: x",
  });
  expect(entries[1].sourceNotes).toBe("2002-02-02 | Eff: 2/2/2002");
});

type FakeElement = {
  localName: string;
  namespace: string;
  textContent: string;
  children: FakeElement[];
};

function element(
  localName: string,
  children: FakeElement[] = [],
  textContent = "",
  namespace = WORD,
): FakeElement {
  return { localName, namespace, textContent, children };
}

// Just enough of the DOM for importADDocx: tag lookups, children and text.
function stubDomParser(root: FakeElement) {
  const descendants = (e: FakeElement): FakeElement[] =>
    e.children.flatMap((c) => [c, ...descendants(c)]);
  const wrap = (e: FakeElement): object => ({
    localName: e.localName,
    namespaceURI: e.namespace,
    textContent: e.textContent,
    children: e.children.map(wrap),
    getElementsByTagName: (name: string) =>
      descendants(e)
        .filter((d) => d.localName === name)
        .map(wrap),
    getElementsByTagNameNS: (namespace: string, name: string) =>
      descendants(e)
        .filter((d) => d.localName === name && d.namespace === namespace)
        .map(wrap),
  });
  vi.stubGlobal(
    "DOMParser",
    class {
      parseFromString = () => wrap(root);
    },
  );
}
