/**
 * Responsibility: Pins the manual PDF file rule, applicability limits, page
 *   references into a manual, and the rules for editing, renaming and
 *   re-associating one.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/manuals.ts, rejection.ts, src/data/demo.ts
 *   (fixture).
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { ZodError } from "zod";
import {
  MAX_MANUAL_BYTES,
  editManual,
  manualApplicabilitySchema,
  manualEditSchema,
  renameManual,
  setManualApplicability,
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

describe("manual changes", () => {
  // A technician who maintains only the first aircraft of the program.
  function workspace() {
    const s = demoSnapshot();
    s.user = { ...s.user, isAdmin: false, groupIds: ["techs"] };
    s.groups = [
      ...s.groups,
      {
        id: "techs",
        name: "Technicians",
        programUuid: s.user.activeProgramUuid!,
        aircraftIds: [s.aircraft[0].uuid],
        permissions: ["read", "maintenance"],
      },
    ];
    const manual: Manual = {
      uuid: "manual",
      aircraftUuid: s.aircraft[0].uuid,
      title: "Maintenance manual",
      documentNumber: "D-1",
      revision: "1",
      revisionDate: "",
      filename: "amm.pdf",
      size: 1,
      pageCount: 10,
      uploadedAt: 0,
      uploadedBy: "user",
    };
    const edit = {
      title: " Corrected ",
      documentNumber: "D-2",
      revision: "2",
      revisionDate: "2026-01-01",
      aircraftUuid: manual.aircraftUuid,
    };
    return { s, manual, edit };
  }
  const access = Error("Maintenance access is required.");

  it("refuses a missing manual or one the user cannot maintain, before reading the input", () => {
    const { s, manual } = workspace();
    const elsewhere = { ...manual, aircraftUuid: s.aircraft[1].uuid };
    for (const target of [undefined, null, elsewhere])
      for (const change of [editManual, renameManual, setManualApplicability]) {
        expect(() => change(s, target, "not input")).toThrow(Rejection);
        expect(() => change(s, target, "not input")).toThrow(access);
      }
  });

  it("moves a manual only to an aircraft of its program the user maintains", () => {
    const { s, manual, edit } = workspace();
    const refusal = Error(
      "Choose an aircraft in the same Flight Program with maintenance access.",
    );
    for (const aircraftUuid of [s.aircraft[1].uuid, "missing"]) {
      const moved = { ...edit, aircraftUuid };
      expect(() => editManual(s, manual, moved)).toThrow(Rejection);
      expect(() => editManual(s, manual, moved)).toThrow(refusal);
    }
    expect(() => editManual(s, manual, { ...edit, size: 2 })).toThrow(ZodError);
  });

  it("writes the parsed details, clearing an applicability left out, and logs the editable fields as they were", () => {
    const { s, manual, edit } = workspace();
    const applicability = {
      kind: "aircraft" as const,
      manufacturer: "Cessna",
      model: "206",
      partNumber: "",
    };
    const change = editManual(s, { ...manual, applicability }, edit);
    expect(change.after).toEqual({ ...edit, title: "Corrected" });
    expect(change.patch).toHaveProperty("applicability", undefined);
    expect(change.patch).toEqual(change.after);
    expect(change.before).toEqual({
      title: manual.title,
      documentNumber: manual.documentNumber,
      revision: manual.revision,
      revisionDate: manual.revisionDate,
      aircraftUuid: manual.aircraftUuid,
      applicability,
    });
  });

  it("renames to the trimmed title and logs the old and new title", () => {
    const { s, manual } = workspace();
    expect(renameManual(s, manual, "  New title ")).toEqual({
      patch: { title: "New title" },
      before: { title: manual.title },
      after: { title: "New title" },
    });
    expect(() => renameManual(s, manual, " ")).toThrow(ZodError);
  });

  it("sets the applicability and logs the one it replaces", () => {
    const { s, manual } = workspace();
    const applicability = {
      kind: "component",
      manufacturer: " Maker ",
      model: "M-1",
      partNumber: "PN",
    };
    const parsed = { ...applicability, manufacturer: "Maker" };
    expect(setManualApplicability(s, manual, applicability)).toEqual({
      patch: { applicability: parsed },
      before: undefined,
      after: parsed,
    });
    expect(() =>
      setManualApplicability(s, manual, { ...applicability, model: "" }),
    ).toThrow(ZodError);
  });
});

describe("manual applicability", () => {
  const applicability = {
    kind: "aircraft" as const,
    manufacturer: "Cessna",
    model: "441",
    partNumber: "",
  };

  it.each([
    ["manufacturer", 150],
    ["model", 150],
    ["partNumber", 100],
  ])("accepts a %s of up to %i characters", (key, max) => {
    const parses = (length: number) =>
      manualApplicabilitySchema.safeParse({
        ...applicability,
        [key]: "A".repeat(length),
      }).success;
    expect(parses(max)).toBe(true);
    expect(parses(max + 1)).toBe(false);
  });
});
