/**
 * Responsibility: Pins the plain-language glossary: complete, unique, short
 *   entries whose links resolve, and its search, grouping and link parsing.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/glossaryTerms.ts.
 */
import { describe, expect, it } from "vitest";
import {
  GLOSSARY,
  definitionParts,
  glossaryAnchor,
  glossaryEntry,
  groupByLetter,
  plainDefinition,
  searchGlossary,
  termFromAnchor,
} from "./glossaryTerms";

// One or two sentences, as the term tips promise a lay reader.
const MAX_SENTENCES = 2;
// The terms Aaron named for the term tips.
const REQUIRED = [
  "MEL",
  "TSO",
  "IA",
  "A&P",
  "AD",
  "ELT",
  "Hobbs",
  "Tach",
  "Annual inspection",
  "100-hour inspection",
  "Deferral",
  "Airworthy",
  "Grounded",
  "Due soon",
  "Held for review",
];

describe("glossary entries", () => {
  it("each has a term and a plain definition of one or two sentences", () => {
    for (const e of GLOSSARY) {
      expect(e.term.trim(), e.id).not.toBe("");
      const text = plainDefinition(e.definition).trim();
      expect(text, e.id).not.toBe("");
      expect(
        text.split(/[.!?](?:\s|$)/).filter(Boolean).length,
        e.id,
      ).toBeLessThanOrEqual(MAX_SENTENCES);
    }
  });

  it("has no duplicate terms, ignoring case", () => {
    const terms = GLOSSARY.map((e) => e.term.toLowerCase());
    expect(new Set(terms).size).toBe(terms.length);
  });

  it("links only to entries that exist", () => {
    for (const e of GLOSSARY) {
      const raw = [...e.definition.matchAll(/\]\(([^)]+)\)/g)].length;
      const linked = definitionParts(e.definition).filter((p) => p.link);
      expect(linked.length, e.id).toBe(raw);
    }
  });

  it("covers the terms named for the term tips", () => {
    const terms = new Set(GLOSSARY.map((e) => e.term));
    expect(REQUIRED.filter((t) => !terms.has(t))).toEqual([]);
  });

  it("is in A to Z order with numbers first", () => {
    expect(GLOSSARY[0].term).toBe("100-hour inspection");
    const letters = groupByLetter(GLOSSARY).map((g) => g.letter);
    expect(letters[0]).toBe("#");
    expect(letters.slice(1)).toEqual([...letters.slice(1)].sort());
    expect(new Set(letters).size).toBe(letters.length);
  });
});

describe("definitionParts", () => {
  it("splits text and links in order", () => {
    expect(definitionParts("Under the [MEL](mel), see [AD](ad).")).toEqual([
      { text: "Under the " },
      { text: "MEL", link: "mel" },
      { text: ", see " },
      { text: "AD", link: "ad" },
      { text: "." },
    ]);
  });

  it("keeps a link to an unknown id as plain text", () => {
    expect(definitionParts("[x](nope)")).toEqual([{ text: "x" }]);
  });
});

describe("searchGlossary", () => {
  it("matches the long form and definition, ignoring case", () => {
    expect(searchGlossary("minimum equipment").map((e) => e.id)).toContain(
      "mel",
    );
    expect(searchGlossary("  RESCUERS ").map((e) => e.id)).toEqual(["elt"]);
  });

  it("returns every entry for an empty query", () => {
    expect(searchGlossary(" ")).toHaveLength(GLOSSARY.length);
  });
});

describe("lookups", () => {
  it("names an entry's anchor after its id", () => {
    expect(glossaryAnchor("mel")).toBe("term-mel");
    expect(glossaryEntry("tso").longForm).toBe("Time since overhaul");
  });

  it("reads a term back from its anchor, and nothing else", () => {
    expect(termFromAnchor("term-a-and-p")).toBe("a-and-p");
    expect(termFromAnchor("term-nope")).toBeUndefined();
    expect(termFromAnchor("glossary-letter-A")).toBeUndefined();
  });
});
