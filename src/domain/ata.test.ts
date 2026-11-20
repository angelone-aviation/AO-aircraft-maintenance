/**
 * Responsibility: Pins the ATA chapter catalog's codes, order and labels.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/ata.ts.
 */
import { describe, expect, it } from "vitest";
import { ATA_CHAPTERS, ATA_GROUPS, ataChapterSchema, ataLabel } from "./ata";

describe("ATA chapter catalog", () => {
  it("lists every grouped chapter, in group order", () => {
    expect(ATA_CHAPTERS).toEqual(
      ATA_GROUPS.flatMap((group) => [...group.chapters]),
    );
    expect(ATA_CHAPTERS[0]).toEqual(["00", "General"]);
    expect(ATA_CHAPTERS.at(-1)).toEqual(["84", "Propulsion Augmentation"]);
  });
  it("accepts catalog codes only, as strings with their leading zeros", () => {
    expect(ataChapterSchema.parse("05")).toBe("05");
    expect(ataChapterSchema.safeParse("5").success).toBe(false);
    // Not in the owner's catalog.
    expect(ataChapterSchema.safeParse("17").success).toBe(false);
  });
  it("labels a chapter with its code and title, or as unassigned", () => {
    expect(ataLabel("05")).toBe("ATA 05: Time Limits / Maintenance Checks");
    expect(ataLabel("67")).toBe("ATA 67: Rotor Flight Controls");
    expect(ataLabel()).toBe("Unassigned");
  });
});
