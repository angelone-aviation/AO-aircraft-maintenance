// @vitest-environment node
import { test, expect } from "vitest";
import { adReport } from "./adReport";
import { demoSnapshot } from "./demo";
import { blankAD, blankADTask } from "../domain/airworthiness";
import { writeFileSync, readFileSync } from "node:fs";

test("prints the worksheet fields, applicability and PCW without inventing signatures", () => {
  const s = demoSnapshot();
  const a = s.aircraft[0];
  const r = blankAD(a.uuid);
  r.source.number = "2026-01-01";
  r.source.subject = "Inspect fittings";
  r.applicability = "Previously Complied With (PCW)";
  r.reviewRequired = false;
  r.priorCompliance = {
    date: "2025-12-01",
    aircraftHours: 1200,
    componentHours: null,
  };
  s.airworthiness = [r];
  const { pdf } = adReport(s, a.uuid);
  const output = pdf.output();
  for (const label of [
    "2026-01-01",
    "Inspect fittings",
    "Superseded by:",
    "Prepared by:",
    "Terminated by:",
    "Sig:",
    "1200.0",
  ])
    expect(output).toContain(label);
  expect(pdf.getNumberOfPages()).toBe(1);
});

test("paginates long entries without dropping the final text", () => {
  const s = demoSnapshot();
  const r = blankAD(s.aircraft[0].uuid);
  r.source.number = "2026-02-02";
  r.reason = "Long applicability detail. ".repeat(700) + "FINAL-TEXT";
  s.airworthiness = [r];
  const { pdf } = adReport(s, s.aircraft[0].uuid);
  expect(pdf.getNumberOfPages()).toBeGreaterThan(1);
  expect(pdf.output()).toContain("FINAL-TEXT");
});

test("prints a corrected compliance entry once, with the original it replaced", () => {
  const s = demoSnapshot();
  const r = blankAD(s.aircraft[0].uuid);
  r.source.number = "2026-03-03";
  r.applicability = "Applicable";
  r.reviewRequired = false;
  const task = { ...blankADTask(), description: "Inspect", intervalHours: 100 };
  r.tasks = [task];
  const original = {
    uuid: crypto.randomUUID(),
    taskUuid: task.uuid,
    date: "2026-01-02",
    hours: 2340,
    cycles: null,
    method: "ORIGINAL-METHOD",
    serviceBulletin: "",
    terminatedBy: "",
    workOrderUuid: "",
    mechanic: "Mechanic",
    certificate: "",
    evidence: "",
    recordedAt: Date.parse("2026-01-02T12:00:00Z"),
    recordedBy: "demo-admin",
  };
  r.history = [
    original,
    {
      ...original,
      uuid: crypto.randomUUID(),
      hours: 2330,
      method: "CORRECTED-METHOD",
      corrects: original.uuid,
      correctionReason: "WRONG-PAGE",
      recordedAt: Date.parse("2026-01-05T12:00:00Z"),
    },
  ];
  s.airworthiness = [r];
  const output = adReport(s, s.aircraft[0].uuid).pdf.output();
  expect(output).toContain("Method: CORRECTED-METHOD");
  expect(output).toContain("WRONG-PAGE");
  expect(output).toContain("Method: ORIGINAL-METHOD | Name: Mechanic");
  expect(output.match(/Compliance record: 1\/2\/2026/g)).toHaveLength(1);
});

// Optional private preview of the current aircraft, with no production writes.
if (process.env.AD_REPORT_SNAPSHOT)
  test("exports the current aircraft preview", () => {
    const s = JSON.parse(readFileSync(process.env.AD_REPORT_SNAPSHOT!, "utf8"));
    const a = s.aircraft.find(
      (a: { registration: string }) => a.registration === "N626KB",
    );
    const { pdf } = adReport(s, a.uuid);
    writeFileSync(
      ".convex/production/N626KB-compliance-preview.pdf",
      Buffer.from(pdf.output("arraybuffer")),
    );
  });
