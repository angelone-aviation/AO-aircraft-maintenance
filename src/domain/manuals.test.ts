/**
 * Responsibility: Pins the manual PDF file rule, page references into a
 *   manual, and which fields an edit may change.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/manuals.ts, rejection.ts, src/data/demo.ts
 *   (fixture).
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  MAX_MANUAL_BYTES,
  manualEditSchema,
  validateManualFile,
  validateManualReference,
  type Manual,
} from "./manuals";
import { Rejection } from "./rejection";

describe("manual files", () => {
  it("accepts a PDF of 1 byte to 200 MiB, typed as a PDF or untyped", () => {
    for (const file of [
      { name: "AMM.PDF", size: 1, type: "" },
      { name: "amm.pdf", size: MAX_MANUAL_BYTES, type: "application/pdf" },
    ])
      expect(() => validateManualFile(file)).not.toThrow();
    expect(MAX_MANUAL_BYTES).toBe(200 * 1024 * 1024);
  });
  it("refuses anything else with a Rejection", () => {
    for (const file of [
      { name: "amm.pdf.exe", size: 1, type: "" },
      { name: "amm.pdf", size: 1, type: "image/png" },
      { name: "amm.pdf", size: 0, type: "" },
      { name: "amm.pdf", size: MAX_MANUAL_BYTES + 1, type: "" },
    ]) {
      expect(() => validateManualFile(file)).toThrow(Rejection);
      expect(() => validateManualFile(file)).toThrow(
        Error("Choose a PDF up to 200 MB."),
      );
    }
  });
});

describe("manual references", () => {
  function workspace() {
    const s = demoSnapshot();
    const manual: Manual = {
      uuid: crypto.randomUUID(),
      aircraftUuid: s.aircraft[0].uuid,
      title: "Maintenance manual",
      documentNumber: "",
      revision: "1",
      revisionDate: "",
      filename: "amm.pdf",
      size: 1,
      pageCount: 10,
      uploadedAt: 0,
      uploadedBy: s.user.id,
    };
    s.manuals = [manual];
    const ref = (pdfPage: number) => ({
      manualUuid: manual.uuid,
      section: "",
      printedPage: "",
      pdfPage,
    });
    return { s, manual, ref };
  }
  it("accepts no reference, or a page within a readable manual", () => {
    const { s, ref } = workspace();
    expect(() => validateManualReference(s, null)).not.toThrow();
    expect(() => validateManualReference(s, ref(10))).not.toThrow();
  });
  it("refuses a page past the end, a missing manual and an unreadable one", () => {
    const { s, manual, ref } = workspace();
    expect(() => validateManualReference(s, ref(11))).toThrow(
      Error("PDF page must be between 1 and 10."),
    );
    expect(() => validateManualReference(s, ref(11))).toThrow(Rejection);
    const unavailable = Error(
      "Reference manual is not available in this workspace.",
    );
    expect(() =>
      validateManualReference(s, {
        ...ref(1),
        manualUuid: crypto.randomUUID(),
      }),
    ).toThrow(unavailable);
    manual.aircraftUuid = "elsewhere";
    expect(() => validateManualReference(s, ref(1))).toThrow(Rejection);
    expect(() => validateManualReference(s, ref(1))).toThrow(unavailable);
  });
});

it("refuses an edit to the file itself", () => {
  const edit = {
    title: "AMM",
    documentNumber: "",
    revision: "2",
    revisionDate: "",
    aircraftUuid: "aircraft",
  };
  expect(manualEditSchema.parse(edit)).toEqual(edit);
  expect(
    manualEditSchema.safeParse({ ...edit, filename: "other.pdf" }).success,
  ).toBe(false);
});
