/**
 * Responsibility: Pins the release-statement list rules and the starter set.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/releaseStatements.ts.
 */
import { describe, expect, it } from "vitest";
import {
  defaultReleaseStatements,
  releaseStatementsSchema,
} from "./releaseStatements";

const statement = (label: string, text = "Work reviewed.") => ({
  label,
  text,
});
const accepts = (items: { label: string; text: string }[]) =>
  releaseStatementsSchema.safeParse(items).success;

describe("releaseStatementsSchema", () => {
  it("trims labels and text, and refuses blank ones", () => {
    expect(
      releaseStatementsSchema.parse([statement(" Maintenance ", " Done. ")]),
    ).toEqual([statement("Maintenance", "Done.")]);
    expect(accepts([statement(" ")])).toBe(false);
    expect(accepts([statement("Maintenance", " ")])).toBe(false);
  });
  it("refuses two labels that match ignoring case", () => {
    const parsed = releaseStatementsSchema.safeParse([
      statement("Annual"),
      statement(" annual "),
    ]);
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
      "Use a unique name for each release statement.",
    ]);
  });
  it("limits label and text length and the number of statements", () => {
    expect(accepts([statement("x".repeat(200), "y".repeat(10000))])).toBe(true);
    expect(accepts([statement("x".repeat(201))])).toBe(false);
    expect(accepts([statement("Long", "y".repeat(10001))])).toBe(false);
    const many = Array.from({ length: 101 }, (_, i) => statement(`S${i}`));
    expect(accepts(many.slice(0, 100))).toBe(true);
    expect(accepts(many)).toBe(false);
  });
  it("starts users with a valid set whose annual text carries a fixed date", () => {
    expect(releaseStatementsSchema.parse(defaultReleaseStatements)).toEqual(
      defaultReleaseStatements,
    );
    expect(
      defaultReleaseStatements.find((s) => s.label.startsWith("Annual"))?.text,
    ).toContain("dated October 2, 2026");
  });
});
