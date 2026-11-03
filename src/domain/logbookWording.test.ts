import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { taskCardCommand } from "../../tests/fixtures/taskCards";
import { workOrderCommand } from "../../tests/fixtures/workOrders";
import { saveTaskCard } from "./taskCards";
import { newWorkTask, saveWorkOrder } from "./workOrders";
import { workPerformedText } from "./workOrderCloseout";
import { logbookPhrasesSchema } from "./logbookWording";

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
