/**
 * Responsibility: Pins the paper check PDF and CSV: header and footer, the
 *   two tables with the tracking meter's name, the empty-table row, the
 *   totals line, the CSV columns and the file name.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/paperCheckReport.ts, src/data/demo.ts,
 *   src/domain/model.ts (types).
 */
// @vitest-environment node
import { expect, it } from "vitest";
import { demoSnapshot } from "./demo";
import type { Flight, Snapshot } from "../domain/model";
import {
  paperCheckCsv,
  paperCheckFileName,
  paperCheckPdf,
} from "./paperCheckReport";

const NOW = new Date("2026-04-02T09:30:00Z");
const HOUR = 3600;

function marchFlight(s: Snapshot): Flight {
  return {
    uuid: "march",
    aircraftUuid: s.aircraft[0].uuid,
    authorId: "demo-pilot",
    pilotId: "demo-pilot",
    submittedAt: 1,
    status: "accepted",
    startTime: "2026-03-04T10:00:00-07:00",
    hobbsOff: 100 * HOUR,
    hobbsOn: 101.5 * HOUR,
    landings: 2,
    cycles: 2,
    origin: "A",
    destination: "B",
    operation: "Mission",
    flightRules: "VFR",
    remarks: "",
    discrepancy: "",
  };
}

it("heads and footers every page and names the tracking meter in the flight table", () => {
  const s = demoSnapshot();
  s.flights = [marchFlight(s)];
  const pdf = paperCheckPdf(s, s.aircraft[0].uuid, "2026-03", NOW);
  const output = pdf.output();
  const pages = pdf.getNumberOfPages();
  expect(output).toContain("(N206MA | PAPER CHECK | March 2026) Tj");
  expect(output).toContain("(Generated 2026-04-02 09:30 UTC) Tj");
  expect(output).toContain(`(N206MA | Page ${pages} of ${pages}) Tj`);
  expect(output).toContain("the signed paper record governs.) Tj");
  expect(output).toContain("(FLIGHTS) Tj");
  expect(output).toContain("(Hobbs start) Tj");
  expect(output).toContain("(MAINTENANCE SIGN-OFFS) Tj");
  expect(output).toContain("(Jordan Lee) Tj");
  expect(output).toContain("(1.5) Tj");
  expect(output).toContain(
    "(Month totals \\(accepted flights\\): 1 flights, 1.5 hours, 2 landings.) Tj",
  );
  // Empty cells print "-" except Checked, which stays blank for the pen: the
  // flight's oil cell, and three of the empty work table's four cells.
  expect(output.match(/\(-\) Tj/g)).toHaveLength(4);
  expect(output).toContain("(None recorded) Tj");
  expect(pdf.internal.pageSize.getWidth()).toBeGreaterThan(
    pdf.internal.pageSize.getHeight(),
  );
});

it("refuses what the domain refuses", () => {
  const s = demoSnapshot();
  expect(() => paperCheckPdf(s, "x", "2026-03", NOW)).toThrow(
    "Aircraft not found.",
  );
  expect(() => paperCheckCsv(s, s.aircraft[0].uuid, "2026-3")).toThrow(
    "Choose a month as YYYY-MM.",
  );
});

it("writes the CSV with a Section column, the meter's columns and a totals record", () => {
  const s = demoSnapshot();
  s.flights = [marchFlight(s)];
  const lines = paperCheckCsv(s, s.aircraft[0].uuid, "2026-03").split("\r\n");
  expect(lines[0]).toBe(
    '﻿"Section","Date","Pilot","Hobbs start","Hobbs end","Hours","Landings","Oil added","Status","Work order","Signed by","Photo","Checked","Flights"',
  );
  expect(lines[1]).toBe(
    '"Flight","2026-03-04","Jordan Lee","100.0","101.5","1.5","2","","Accepted","","","No","",""',
  );
  expect(lines[2]).toBe('"Totals","","","","","1.5","2","","","","","","","1"');
  expect(lines).toHaveLength(3);
});

it("names the file after the aircraft and month", () => {
  expect(paperCheckFileName("N206MA", "2026-03", "pdf")).toBe(
    "N206MA-paper-check-2026-03.pdf",
  );
  expect(paperCheckFileName("N/A 1", "2026-03", "csv")).toBe(
    "N_A_1-paper-check-2026-03.csv",
  );
  expect(paperCheckFileName("", "2026-03", "csv")).toBe(
    "aircraft-paper-check-2026-03.csv",
  );
});
