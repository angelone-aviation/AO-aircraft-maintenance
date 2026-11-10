/**
 * Responsibility: Pins how the status sheet's AD record (14 CFR
 *   91.417(a)(2)(v)) prints a previous compliance: its date, then the
 *   component hours or else the aircraft hours it was recorded at.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/statusSheet.ts, airworthiness.ts,
 *   src/data/demo.ts (seed).
 */
import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { blankAD, type AD } from "./airworthiness";
import { statusSheet } from "./statusSheet";

const TODAY = "2026-06-15";
const NUMBER = "2015-19-07";
// The AD row's columns: number, asset, subject, limits, status.
const LIMITS = 3;

it("prints the component hours of a previous compliance before the aircraft hours", () => {
  expect(limitsOf({ aircraftHours: 2100.25, componentHours: 812.04 })).toBe(
    "PCW 2019-04-02\nEngine/component 812.0 h",
  );
});

it("prints the aircraft hours when the component hours were not recorded", () => {
  expect(limitsOf({ aircraftHours: 2100.25, componentHours: null })).toBe(
    "PCW 2019-04-02\nAircraft 2100.3 h",
  );
});

it("prints the date alone, with an empty line after it, when no hours were recorded", () => {
  // Characterizes current behaviour: the empty hours line is still joined.
  expect(limitsOf({ aircraftHours: null, componentHours: null })).toBe(
    "PCW 2019-04-02\n",
  );
});

it("prints a dash for an AD with neither a limit nor a previous compliance", () => {
  expect(limitsOf(undefined)).toBe("-");
});

function limitsOf(
  hours:
    { aircraftHours: number | null; componentHours: number | null } | undefined,
): string {
  const s = demoSnapshot();
  const a = s.aircraft[0];
  const r: AD = {
    ...blankAD(a.uuid),
    applicability: "Previously Complied With (PCW)",
    reviewRequired: false,
    priorCompliance: hours && { date: "2019-04-02", ...hours },
  };
  r.source = { ...r.source, number: NUMBER, recurring: "No" };
  s.airworthiness = [r];
  const ads = statusSheet(s, a.uuid, TODAY).sections.find(
    (x) => x.id === "airworthiness",
  );
  const row = ads?.rows.find((cells) => cells[0] === NUMBER);
  if (!row) throw new Error(`The sheet lists no AD ${NUMBER}.`);
  return row[LIMITS];
}
