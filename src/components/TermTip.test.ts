/**
 * Responsibility: Pins the term tips: every term a screen explains has a
 *   glossary entry, the key screens explain theirs, and a tip's markup names
 *   its button and links to the Glossary at the term.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/TermTip.tsx, src/domain/glossaryTerms.ts,
 *   node:fs, react-dom/server.
 */
// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GLOSSARY } from "../domain/glossaryTerms";
import { TermTip } from "./TermTip";

vi.mock("@tanstack/react-router", () => ({
  Link: (props: { to: string; hash: string; children: ReactNode }) =>
    createElement("a", { href: `${props.to}#${props.hash}` }, props.children),
}));
const COMPONENTS = join(import.meta.dirname, ".");
// The screens Aaron named: aircraft detail (on the dashboard), flight form,
// discrepancies (in Records) and airworthiness.
const KEY_SCREENS = [
  "Dashboard.tsx",
  "FlightForm.tsx",
  "Records.tsx",
  "Airworthiness.tsx",
];

const termsUsedIn = (file: string) =>
  [
    ...readFileSync(join(COMPONENTS, file), "utf8").matchAll(
      /<TermTip\s+term="([^"]+)"/g,
    ),
  ].map((m) => m[1]);

describe("term tips in the interface", () => {
  it("explain only terms the glossary defines", () => {
    const known = new Set(GLOSSARY.map((e) => e.id));
    const used = readdirSync(COMPONENTS)
      .filter((f) => f.endsWith(".tsx"))
      .flatMap(termsUsedIn);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((id) => !known.has(id as never))).toEqual([]);
  });

  it("appear on each key screen", () => {
    for (const file of KEY_SCREENS)
      expect(termsUsedIn(file).length, file).toBeGreaterThan(0);
  });
});

describe("TermTip", () => {
  it("names its button by the words shown and links to the term's entry", () => {
    const html = renderToStaticMarkup(
      createElement(TermTip, { term: "ad" }, "ADs"),
    );
    expect(html).toContain('aria-label="ADs, what it means"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('popover="auto"');
    expect(html).toContain("Airworthiness directive");
    expect(html).toContain('href="/glossary#term-ad"');
  });
});
