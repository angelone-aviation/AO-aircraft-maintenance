/**
 * Responsibility: Pins the aircraft status sheet: header and footer, warning
 *   colours, printable text, component fallbacks and the Form 337 notes.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/aircraftStatusReport.ts, src/data/demo.ts,
 *   src/domain/airworthiness.ts, src/domain/components.ts.
 */
// @vitest-environment node
import { expect, it } from "vitest";
import { aircraftStatusReport } from "./aircraftStatusReport";
import { demoSnapshot } from "./demo";
import { blankAD, blankADTask } from "../domain/airworthiness";
import { componentSchema } from "../domain/components";
import { totalSeconds, type Snapshot } from "../domain/model";

const NOW = new Date("2026-06-15T09:30:00Z");
const RED = "0.647 0.137 0.137";
const AMBER = "0.525 0.325 0.";
const INK = "0.137 0.188 0.169";

function report(s: Snapshot) {
  return aircraftStatusReport(s, s.aircraft[0].uuid, NOW);
}

function colourOf(output: string, text: string) {
  return output.match(
    new RegExp(`([\\d. ]+) rg\\n[^\\n]* Td\\n\\(${text}\\) Tj`),
  )?.[1];
}

function component(s: Snapshot, over: object) {
  const a = s.aircraft[0];
  return componentSchema.parse({
    uuid: "c",
    kind: "component",
    version: 1,
    aircraftUuid: a.uuid,
    componentType: "Prop—Hartzell ü",
    partNumber: "PN",
    serial: "SN",
    manufacturer: "",
    notes: "",
    trackTime: true,
    trackCycles: true,
    trackCalendar: true,
    installed: true,
    installedDate: "2026-01-01",
    installedSeconds: totalSeconds(a),
    installedCycles: a.cycles,
    timeSinceNew: 0,
    timeSinceOverhaul: null,
    timeSinceRepair: null,
    cyclesSinceNew: 0,
    serviceDaysBase: 0,
    ...over,
  });
}

it("heads and footers every page and refuses an unknown aircraft", () => {
  const pdf = report(demoSnapshot());
  const output = pdf.output();
  const pages = pdf.getNumberOfPages();
  expect(output).toContain("(Generated 2026-06-15 09:30 UTC) Tj");
  expect(output).toContain(`(N206MA | Page ${pages} of ${pages}) Tj`);
  expect(output).toContain("not a maintenance release.) Tj");
  expect(() => aircraftStatusReport(demoSnapshot(), "x")).toThrow(
    "Aircraft not found.",
  );
});

it("prints negative remaining values red and reviews amber", () => {
  const s = demoSnapshot();
  const a = s.aircraft[0];
  s.inspections = [
    {
      uuid: "i",
      aircraftUuid: a.uuid,
      reference: "50-HR",
      description: "",
      dueSeconds: totalSeconds(a) - 3600 * 2,
    },
  ];
  s.airworthiness = [blankAD(a.uuid)];
  const output = report(s).output();
  expect(colourOf(output, "-2.0")).toBe(RED);
  expect(colourOf(output, "Needs review")).toBe(AMBER);
});

it("colours a status by its value and leaves words in other cells in ink", () => {
  const s = demoSnapshot();
  const a = s.aircraft[0];
  s.inspections = [];
  s.airworthiness = [
    {
      ...blankAD(a.uuid),
      applicability: "Applicable",
      reviewRequired: false,
      tasks: [{ ...blankADTask(), dueDate: "2026-06-20" }],
    },
  ];
  s.discrepancies = [
    {
      uuid: "report",
      aircraftUuid: a.uuid,
      description: "Oil change overdue",
      status: "open",
      authorId: "pilot",
      createdAt: NOW.getTime(),
      grounding: true,
    },
  ];
  const output = report(s).output();
  expect(colourOf(output, "Due soon")).toBe(AMBER);
  expect(colourOf(output, "Grounded")).toBe(RED);
  expect(colourOf(output, "Open: grounds the aircraft")).toBe(RED);
  expect(colourOf(output, "Oil change overdue")).toBe(INK);
});

it("prints text as ASCII and flags component times it cannot compute", () => {
  const s = demoSnapshot();
  const after = totalSeconds(s.aircraft[0]) + 3600;
  s.management = [component(s, { installedSeconds: after })];
  const output = report(s).output();
  expect(output).toContain("( Prop-Hartzell  ) Tj");
  expect(output.match(/\(Review\) Tj/g)).toHaveLength(4);
  s.management = [component(s, { trackTime: false, trackCycles: false })];
  expect(
    report(s)
      .output()
      .match(/\(Not tracked\) Tj/g),
  ).toHaveLength(4);
});

it("lists current Form 337 copies and counts archived ones", () => {
  const s = demoSnapshot();
  const file = (name: string, archivedAt?: number) => ({
    uuid: name,
    aircraftUuid: s.aircraft[0].uuid,
    category: "form-337" as const,
    name,
    type: "application/pdf",
    size: 2049,
    uploadedAt: 0,
    url: "",
    archivedAt,
  });
  s.aircraftFiles = [file("current.pdf"), file("old.pdf", 1)];
  const output = report(s).output();
  expect(output).toContain("(current.pdf) Tj");
  expect(output).toContain("(3 KB) Tj");
  expect(output).not.toContain("(old.pdf) Tj");
  expect(output).toContain("(1 archived Form 337 copy is not listed.");
  s.aircraftFiles.push(file("older.pdf", 2));
  expect(report(s).output()).toContain("2 archived Form 337 copies are");
});
