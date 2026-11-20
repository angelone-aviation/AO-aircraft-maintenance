/**
 * Responsibility: Fails when the handbook's glossary page and GLOSSARY.md
 *   differ in any section or term entry.
 * Layer: Test. Reads the two Markdown files; never writes a file.
 * Dependencies: vitest, node:fs, node:path.
 *
 * GLOSSARY.md stays at the root because AGENTS.md and the domain-modelling
 * skill read it there; the handbook carries a full copy for readers.
 *
 * @vitest-environment node
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..");
const ROOT_GLOSSARY = "GLOSSARY.md";
const HANDBOOK_GLOSSARY = "docs/handbook/1-start-here/glossary.md";

it("keeps the handbook glossary identical to GLOSSARY.md", () => {
  const root = termEntries(ROOT_GLOSSARY);
  expect(root.length).toBeGreaterThan(0);
  expect(termEntries(HANDBOOK_GLOSSARY)).toEqual(root);
});

// Each file's own introduction comes before its first section; everything
// from there on is compared, one section heading or term entry at a time.
function termEntries(file: string): string[] {
  const text = readFileSync(path.join(REPO_ROOT, file), "utf8");
  const start = text.search(/^## /m);
  if (start < 0) throw new Error(`${file} has no glossary section.`);
  return text
    .slice(start)
    .split(/\n\s*\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}
