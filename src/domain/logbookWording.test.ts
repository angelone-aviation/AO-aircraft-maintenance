/**
 * Responsibility: Pins logbook wording: the phrase lists, a task's logbook
 *   choice, and the work lines selected tasks and job cards add at close-out.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/logbookWording.ts, src/domain/taskCards.ts,
 *   src/domain/workOrders.ts, src/domain/workOrderCloseout.ts,
 *   src/data/demo.ts and tests/fixtures (fixtures).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { demoSnapshot } from "../data/demo";
import { taskCardCommand } from "../../tests/fixtures/taskCards";
import { workOrderCommand } from "../../tests/fixtures/workOrders";
import { saveTaskCard } from "./taskCards";
import { newWorkTask, saveWorkOrder } from "./workOrders";
import { workPerformedText } from "./workOrderCloseout";
import {
  defaultLogbookPhrases,
  logbookPhrasesSchema,
  logbookSelectionFields,
  logbookWorkLine,
} from "./logbookWording";

it("copies procedure logbook choices to job cards and includes only selected completed procedures", () => {
  const s = demoSnapshot();
  const cmd = taskCardCommand();
  cmd.fields.inspectionUuid = s.inspections[0].uuid;
  cmd.fields.includeInLogbook = true;
  cmd.fields.logbookPhrase = "Complied with";
  cmd.fields.title = "Inspection Phase 2 — A243003";
  cmd.fields.description = "Fuel system inspection";
  cmd.fields.maintenanceReference = "AMM 28-00";
  const template = saveTaskCard(s, cmd, Date.now());
  const wo = workOrderCommand();
  wo.tasks = [
    newWorkTask(
      { kind: "inspection", uuid: s.inspections[0].uuid },
      "Inspection",
    ),
  ];
  const order = saveWorkOrder(s, wo, Date.now());
  const card = s.taskCards!.find(
    (c) => c.sourceTaskCardUuid === template.uuid,
  )!;
  expect(card.includeInLogbook).toBe(true);
  expect(card.logbookPhrase).toBe("Complied with");
  card.status = "completed";
  card.technicianSignoff = {
    userId: s.user.id,
    name: "Alex Morgan",
    at: Date.now(),
  };
  order.tasks[0].status = "completed";
  expect(workPerformedText(s, order)).toContain(
    "Task #1 Inspection Phase 2 — A243003: complied with IAW AMM 28-00",
  );
  expect(workPerformedText(s, order)).toContain(
    "\nWork signed by: Alex Morgan",
  );
  const manualUuid = crypto.randomUUID();
  s.manuals = [
    {
      uuid: manualUuid,
      aircraftUuid: order.aircraftUuid,
      title: "Cessna 441 Maintenance Manual",
      documentNumber: "D2518-15-13",
      revision: "Rev 15",
      revisionDate: "",
      filename: "manual.pdf",
      size: 100,
      pageCount: 100,
      uploadedAt: Date.now(),
      uploadedBy: s.user.id,
    },
  ];
  card.manualReference = {
    manualUuid,
    section: "5-12-02",
    printedPage: "1",
    pdfPage: 79,
  };
  card.logbookPhrase = "Inspected";
  expect(workPerformedText(s, order)).toBe(
    "Task #1 Inspection Phase 2 — A243003: inspected IAW Cessna 441 Maintenance Manual, D2518-15-13, revision Rev 15, section 5-12-02, page 1, PDF page 79\nWork signed by: Alex Morgan",
  );
  card.includeInLogbook = false;
  expect(workPerformedText(s, order)).toBe("");
  card.includeInLogbook = true;
  card.status = "in-progress";
  expect(workPerformedText(s, order)).toBe("");
});

it("records the actual work, step results, reference and signoffs for an included job card", () => {
  const s = demoSnapshot();
  const wo = workOrderCommand();
  wo.tasks = [];
  const order = saveWorkOrder(s, wo, Date.now());
  const cmd = taskCardCommand();
  cmd.fields.workOrderUuid = order.uuid;
  cmd.fields.cardNumber = "TC-7";
  cmd.fields.title = "Fuel pump replacement";
  cmd.fields.includeInLogbook = true;
  cmd.fields.logbookPhrase = "Installed";
  cmd.fields.maintenanceReference = "AMM 28-20";
  cmd.fields.referenceRevision = "12";
  cmd.fields.actualWork = "Removed failed pump and installed overhauled unit.";
  cmd.fields.findings = "Pump inlet seal leaking.";
  cmd.fields.notesRemarks = "Leak check satisfactory.";
  cmd.fields.steps[0].result = "Within limits";
  cmd.fields.steps[0].measurement = 15;
  const card = saveTaskCard(s, cmd, Date.now());
  card.status = "completed";
  card.technicianSignoff = { userId: s.user.id, name: "Alex Morgan", at: 1 };
  card.inspectionSignoff = { userId: "i", name: "Jamie Lee", at: 2 };
  expect(workPerformedText(s, order)).toBe(
    [
      "Task #TC-7 Fuel pump replacement: installed IAW AMM 28-20, revision 12",
      "Work performed: Removed failed pump and installed overhauled unit.",
      "Step 1 — Measure pressure: Within limits; 15 psi",
      "Findings: Pump inlet seal leaking.",
      "Notes: Leak check satisfactory.",
      "Work signed by: Alex Morgan",
      "Inspection signed by: Jamie Lee",
    ].join("\n"),
  );
});

it("validates editable phrases", () => {
  expect(logbookPhrasesSchema.parse([" Custom phrase "])).toEqual([
    "Custom phrase",
  ]);
  expect(
    logbookPhrasesSchema.safeParse(["Inspected", "inspected"]).success,
  ).toBe(false);
  expect(logbookPhrasesSchema.safeParse([]).success).toBe(false);
});

// Mirrors the private limit in logbookWording.ts; a change to either fails here.
const PHRASE_MAX_LENGTH = 200;
const AC_43_13 = "IAW Standard Practice found in AC43.13";

describe("logbookWorkLine", () => {
  it("writes the line with trimmed parts, lowercasing a standard phrase", () => {
    expect(
      logbookWorkLine(2, "Inspected", " Cabin fittings ", " AMM 25-10 "),
    ).toBe("Task #2 Cabin fittings: inspected IAW AMM 25-10");
    expect(
      logbookWorkLine("TC-7", "Complied with", "AD 2020-01-01", "AD"),
    ).toBe("Task #TC-7 AD 2020-01-01: complied with IAW AD");
  });
  it("uses Performed for a blank phrase and AC 43.13 for a blank reference", () => {
    expect(logbookWorkLine(1, undefined, "Wash", " ")).toBe(
      `Task #1 Wash: performed ${AC_43_13}`,
    );
    expect(logbookWorkLine(1, "", "Wash", "")).toBe(
      `Task #1 Wash: performed ${AC_43_13}`,
    );
  });
  it("keeps any other phrase as written", () => {
    expect(logbookWorkLine(3, "Overhauled per SB", "Pump", "SB 12")).toBe(
      "Task #3 Pump: Overhauled per SB IAW SB 12",
    );
    // Characterizes current behaviour: only the listed capitalization matches.
    expect(logbookWorkLine(3, "INSPECTED", "Pump", "SB 12")).toBe(
      "Task #3 Pump: INSPECTED IAW SB 12",
    );
  });
});

describe("phrase lists and selections", () => {
  it("starts users on the standard phrases, in menu order", () => {
    expect(defaultLogbookPhrases).toEqual([
      "Performed",
      "Inspected",
      "Repaired",
      "Complied with",
      "Installed",
      "Removed",
      "Updated",
    ]);
  });
  it("limits a saved list to 100 phrases of up to 200 characters", () => {
    const accepts = (phrases: string[]) =>
      logbookPhrasesSchema.safeParse(phrases).success;
    const many = (count: number) =>
      Array.from({ length: count }, (_, i) => `Phrase ${i}`);
    expect(accepts(many(100))).toBe(true);
    expect(accepts(many(101))).toBe(false);
    expect(accepts(["x".repeat(PHRASE_MAX_LENGTH)])).toBe(true);
    expect(accepts(["x".repeat(PHRASE_MAX_LENGTH + 1)])).toBe(false);
    expect(accepts(["  "])).toBe(false);
  });
  it("refuses phrases that repeat once trimmed, ignoring case", () => {
    const result = logbookPhrasesSchema.safeParse([" Repaired", "repaired "]);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      "Remove duplicate phrases.",
    ]);
  });
  it("leaves a task's choice optional and trims its phrase", () => {
    const selection = z.object(logbookSelectionFields);
    expect(selection.parse({})).toEqual({});
    expect(
      selection.parse({ includeInLogbook: false, logbookPhrase: " Repaired " }),
    ).toEqual({ includeInLogbook: false, logbookPhrase: "Repaired" });
    expect(selection.safeParse({ logbookPhrase: " " }).success).toBe(false);
    expect(
      selection.safeParse({ logbookPhrase: "x".repeat(PHRASE_MAX_LENGTH + 1) })
        .success,
    ).toBe(false);
  });
});
