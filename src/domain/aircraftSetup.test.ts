/**
 * Responsibility: Pins the aircraft setup templates: how the two CSVs parse,
 *   what the dry-run plan saves, skips, warns about and refuses, that its
 *   commands pass the real appliers, and which steps count as done.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/aircraftSetup.ts, ./management, ./airworthiness,
 *   ./rejection, src/data/demo.ts (seed).
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  SETUP_GAPS,
  SETUP_NOT_APPLICABLE_REASON,
  adSetupHeaders,
  inspectionSetupHeaders,
  parseAdSetupCsv,
  parseInspectionSetupCsv,
  planAircraftSetup,
  readSetupStep,
  setupStatus,
  type AdSetupRow,
  type InspectionSetupRow,
} from "./aircraftSetup";
import { applyManagement } from "./management";
import { applyADCommand } from "./airworthiness";
import { Rejection } from "./rejection";

const HOUR_SECONDS = 3600;
// N206MA in the demo: 2341.2 h total, 1894 cycles, 2194 landings.
const AIRCRAFT = "demo-206";
const NOW = Date.parse("2026-11-09T12:00:00Z");

const inspectionCsv = [
  inspectionSetupHeaders.join(","),
  'Annual,,12,,,2026-03-15,,,,"Per 91.409(a), 14 CFR"',
  "100-hour,100,,,,2026-10-01,2300.5,,,",
  "Gear retraction,,,,500,2026-10-01,,,2100,",
].join("\n");

const adCsv = [
  adSetupHeaders.join(","),
  "2024-05-01,Fuel line inspection,yes,2026-02-10,2200,Visual inspection,2300,,yes,",
  "2020-12-02,Seat rail wear,no,,,,,,,Different seat rail part number",
  "2025-01-03,Exhaust stud replacement,yes,,,,,2026-12-31,no,",
].join("\n");

describe("parseInspectionSetupCsv", () => {
  it("reads rows with any header order or case, quoted cells and blank unknowns", () => {
    const rows = parseInspectionSetupCsv(inspectionCsv);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      row: 2,
      name: "Annual",
      intervalMonths: 12,
      lastDate: "2026-03-15",
      notes: "Per 91.409(a), 14 CFR",
    });
    expect(rows[0].intervalSeconds).toBeUndefined();
    expect(rows[1]).toMatchObject({
      intervalSeconds: 100 * HOUR_SECONDS,
      lastSeconds: 2300.5 * HOUR_SECONDS,
    });
    expect(rows[2]).toMatchObject({
      intervalLandings: 500,
      lastLandings: 2100,
    });
    const shuffled =
      "Notes,Last done hours,Last-Done Date,last_done_landings,last_done_cycles,interval_landings,interval_cycles,interval_months,interval_hours,NAME\n,,2026-01-01,,,,,12,,Annual";
    expect(parseInspectionSetupCsv(shuffled)[0]).toMatchObject({
      name: "Annual",
      intervalMonths: 12,
    });
  });
  it("gives no rows for a header-only file", () => {
    expect(parseInspectionSetupCsv(inspectionSetupHeaders.join(","))).toEqual(
      [],
    );
  });
  it("refuses other columns, and names the row of a bad value", () => {
    expect(() =>
      parseInspectionSetupCsv(inspectionCsv.replace("notes", "remarks")),
    ).toThrow(
      new Rejection(`Use columns: ${inspectionSetupHeaders.join(", ")}.`),
    );
    expect(() =>
      parseInspectionSetupCsv(inspectionCsv.replace("2300.5", "2300.55")),
    ).toThrow(/^Row 3: Use positive hours with at most one decimal place\./);
    expect(() =>
      parseInspectionSetupCsv(inspectionCsv.replace(",,12,", ",,twelve,")),
    ).toThrow(/^Row 2: Use whole numbers/);
    expect(() =>
      parseInspectionSetupCsv(
        inspectionCsv.replace("2026-03-15", "03/15/2026"),
      ),
    ).toThrow(/^Row 2: /);
    expect(() =>
      parseInspectionSetupCsv(inspectionCsv.replace("Annual,,12", ",,12")),
    ).toThrow(/^Row 2: /);
    expect(() =>
      parseInspectionSetupCsv(
        inspectionCsv.replace("100-hour,100", "100-hour"),
      ),
    ).toThrow("Row 3: column count does not match header.");
  });
});

describe("parseAdSetupCsv", () => {
  it("reads yes/no answers, decimal hours and blank recurrence", () => {
    const rows = parseAdSetupCsv(adCsv);
    expect(rows[0]).toMatchObject({
      number: "2024-05-01",
      applies: true,
      complianceDate: "2026-02-10",
      complianceHours: 2200,
      method: "Visual inspection",
      nextDueHours: 2300,
      recurring: true,
    });
    expect(rows[1]).toMatchObject({ applies: false, recurring: undefined });
    expect(rows[2]).toMatchObject({
      nextDueDate: "2026-12-31",
      recurring: false,
    });
    expect(
      parseAdSetupCsv(adCsv.replace(",yes,2026", ",Y,2026"))[0].applies,
    ).toBe(true);
    expect(parseAdSetupCsv(adCsv.replace(",no,,", ",FALSE,,"))[1].applies).toBe(
      false,
    );
  });
  it("requires a yes or no in applies and refuses other answers in recurring", () => {
    expect(() => parseAdSetupCsv(adCsv.replace(",yes,2026", ",,2026"))).toThrow(
      "Row 2: applies must be yes or no.",
    );
    expect(() =>
      parseAdSetupCsv(adCsv.replace(",2300,,yes,", ",2300,,maybe,")),
    ).toThrow("Row 2: recurring must be yes, no or blank.");
    expect(() => parseAdSetupCsv(adCsv.replace("2200", "2200h"))).toThrow(
      /^Row 2: Use positive hours/,
    );
  });
});

describe("planAircraftSetup", () => {
  const parsed = () => ({
    inspections: parseInspectionSetupCsv(inspectionCsv),
    ads: parseAdSetupCsv(adCsv),
  });
  it("plans one command per row, each with its own request id, and no errors", () => {
    const plan = planAircraftSetup(demoSnapshot(), AIRCRAFT, parsed(), {
      now: NOW,
    });
    expect(plan.errors).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.actions.map((a) => [a.step, a.label])).toEqual([
      ["inspections", "Annual"],
      ["inspections", "100-hour"],
      ["inspections", "Gear retraction"],
      ["ads", "2024-05-01"],
      ["ads", "2020-12-02"],
      ["ads", "2025-01-03"],
    ]);
    expect(plan.actions.map((a) => a.detail)).toEqual([
      "Every 12 months · last done 2026-03-15",
      "Every 100.0 h · last done 2026-10-01 at 2300.5 h",
      "Every 500 landings · last done 2026-10-01 2100 landings",
      "PCW 2026-02-10 at 2200 h · next due 2300 h · recurring",
      "Not applicable",
      "Applicable · next due 2026-12-31 · one-time",
    ]);
    const ids = plan.actions.map((a) => a.command.requestUuid);
    expect(new Set(ids).size).toBe(6);
    expect(plan.actions.map((a) => a.key)).toEqual([
      "inspection:2",
      "inspection:3",
      "inspection:4",
      "ad:2",
      "ad:3",
      "ad:4",
    ]);
  });
  it("builds commands the inspection and AD appliers accept", () => {
    const s = demoSnapshot();
    const plan = planAircraftSetup(s, AIRCRAFT, parsed(), { now: NOW });
    for (const a of plan.actions)
      if (a.step === "inspections") applyManagement(s, a.command, NOW);
      else applyADCommand(s, a.command, NOW);
    const annual = s.inspections.find((i) => i.description === "Annual")!;
    expect(annual).toMatchObject({
      aircraftUuid: AIRCRAFT,
      intervalMonths: 12,
      lastDate: "2026-03-15",
      dueDate: "2027-03-31",
      reference: "Per 91.409(a), 14 CFR",
    });
    const hundred = s.inspections.find((i) => i.description === "100-hour")!;
    expect(hundred.dueSeconds).toBe(2400.5 * HOUR_SECONDS);
    expect(s.airworthiness!.map((r) => r.source.number).sort()).toEqual([
      "2020-12-02",
      "2024-05-01",
      "2025-01-03",
    ]);
    expect(setupStatus(s, AIRCRAFT).gaps).toEqual(["components"]);
  });
  it("records a complied AD as PCW with its prior compliance and next due action", () => {
    const plan = planAircraftSetup(demoSnapshot(), AIRCRAFT, parsed(), {
      now: NOW,
    });
    const ads = plan.actions.flatMap((a) =>
      a.step === "ads" && a.command.kind === "save" ? [a.command.record] : [],
    );
    expect(ads[0]).toMatchObject({
      applicability: "Previously Complied With (PCW)",
      priorCompliance: {
        date: "2026-02-10",
        aircraftHours: 2200,
        componentHours: null,
      },
      reviewRequired: false,
      source: {
        subject: "Fuel line inspection",
        recurring: "Yes",
        source: "Aircraft setup",
        sourceNotes: "Method: Visual inspection",
      },
    });
    expect(ads[0].tasks).toHaveLength(1);
    expect(ads[0].tasks[0]).toMatchObject({
      description: "Fuel line inspection",
      dueHours: 2300,
      dueDate: "",
      recurrence: "Recurring",
    });
    expect(ads[1]).toMatchObject({
      applicability: "Not applicable",
      reason: "Different seat rail part number",
      tasks: [],
      source: { recurring: "Unknown" },
    });
    expect(ads[2]).toMatchObject({ applicability: "Applicable" });
    expect(ads[2].tasks[0]).toMatchObject({
      dueDate: "2026-12-31",
      dueHours: null,
      recurrence: "One-time",
    });
  });
  it("uses the standing reason for a not-applicable AD without notes", () => {
    const rows = parseAdSetupCsv(
      adCsv.replace("Different seat rail part number", ""),
    );
    const plan = planAircraftSetup(
      demoSnapshot(),
      AIRCRAFT,
      { inspections: [], ads: rows },
      { now: NOW },
    );
    const na = plan.actions[1];
    expect(
      na.step === "ads" &&
        na.command.kind === "save" &&
        na.command.record.reason,
    ).toBe(SETUP_NOT_APPLICABLE_REASON);
  });
  it("skips rows already on record or already saved by this setup", () => {
    const rows = parseInspectionSetupCsv(
      inspectionCsv.replace("Annual,", "airframe AND engine inspection,"),
    );
    const plan = planAircraftSetup(
      demoSnapshot(),
      AIRCRAFT,
      { inspections: rows, ads: parseAdSetupCsv(adCsv) },
      { now: NOW, done: ["inspection:3", "ad:3"] },
    );
    expect(plan.errors).toEqual([]);
    expect(plan.skipped).toEqual([
      {
        step: "inspections",
        key: "inspection:2",
        label: "airframe AND engine inspection",
        reason: "Already on record for this aircraft",
      },
      {
        step: "inspections",
        key: "inspection:3",
        label: "100-hour",
        reason: "Already saved by this setup",
      },
      {
        step: "ads",
        key: "ad:3",
        label: "2020-12-02",
        reason: "Already saved by this setup",
      },
    ]);
    expect(plan.actions.map((a) => a.key)).toEqual([
      "inspection:4",
      "ad:2",
      "ad:4",
    ]);
  });
  it("skips an AD already tracked on the airframe, whatever its spacing or case", () => {
    const s = demoSnapshot();
    const first = planAircraftSetup(s, AIRCRAFT, parsed(), { now: NOW });
    applyADCommand(s, first.actions[3].command as never, NOW);
    const rows = parseAdSetupCsv(adCsv.replace("2024-05-01,", " 2024-05-01 ,"));
    const again = planAircraftSetup(
      s,
      AIRCRAFT,
      { inspections: [], ads: rows },
      { now: NOW },
    );
    expect(again.skipped.map((r) => r.label)).toEqual(["2024-05-01"]);
    expect(again.actions).toHaveLength(2);
  });
  it("refuses what the appliers would: missing last-done, future dates, totals exceeded, duplicates", () => {
    const rows: InspectionSetupRow[] = [
      { row: 2, name: "No interval", notes: "" },
      { row: 3, name: "No last done", intervalSeconds: 360, notes: "" },
      { row: 8, name: "No last date", intervalMonths: 12, notes: "" },
      {
        row: 4,
        name: "Future",
        intervalMonths: 12,
        lastDate: "2027-01-01",
        notes: "",
      },
      {
        row: 5,
        name: "Too many hours",
        intervalSeconds: 360,
        lastSeconds: 3000 * HOUR_SECONDS,
        notes: "",
      },
      {
        row: 6,
        name: "Too many cycles",
        intervalCycles: 10,
        lastCycles: 5000,
        notes: "",
      },
      { row: 7, name: "no interval", notes: "" },
    ];
    const ads: AdSetupRow[] = [
      {
        row: 2,
        number: "2024-01-01",
        title: "",
        applies: true,
        complianceDate: "2027-01-01",
        complianceHours: 1,
        method: "",
        notes: "",
      },
      {
        row: 3,
        number: "2024-01-02",
        title: "",
        applies: true,
        complianceDate: "2026-01-01",
        method: "",
        notes: "",
      },
      {
        row: 4,
        number: "2024 -01-02",
        title: "",
        applies: false,
        method: "",
        notes: "",
      },
    ];
    const plan = planAircraftSetup(
      demoSnapshot(),
      AIRCRAFT,
      { inspections: rows, ads },
      { now: NOW },
    );
    expect(plan.actions).toEqual([]);
    expect(plan.errors).toEqual([
      "Row 2 (No interval): enter at least one interval.",
      "Row 3 (No last done): each interval needs its last-done hours, count or date.",
      "Row 8 (No last date): each interval needs its last-done hours, count or date.",
      "Row 4 (Future): the last-done date is in the future.",
      "Row 5 (Too many hours): last-done values are above the aircraft's current totals.",
      "Row 6 (Too many cycles): last-done values are above the aircraft's current totals.",
      "Row 7 (no interval): the name appears twice in the file.",
      "Row 2 (AD 2024-01-01): the compliance date is in the future.",
      "Row 3 (AD 2024-01-02): compliance needs the aircraft total time it was done at.",
      "Row 4 (AD 2024 -01-02): the AD number appears twice in the file.",
    ]);
  });
  it("warns about a missing baseline, limits already passed and ADs with no due limit", () => {
    const s = demoSnapshot();
    const a = s.aircraft.find((a) => a.uuid === AIRCRAFT)!;
    a.currentHobbs = 0;
    a.cycles = 0;
    a.landings = 0;
    const rows: InspectionSetupRow[] = [
      {
        row: 2,
        name: "Oil change",
        intervalSeconds: 50 * HOUR_SECONDS,
        lastSeconds: 0,
        notes: "",
      },
    ];
    const ads: AdSetupRow[] = [
      {
        row: 2,
        number: "2024-01-01",
        title: "",
        applies: true,
        nextDueHours: 0,
        nextDueDate: "2020-01-01",
        method: "",
        notes: "",
      },
      {
        row: 3,
        number: "2024-01-02",
        title: "",
        applies: true,
        method: "",
        notes: "",
      },
      {
        row: 4,
        number: "2024-01-03",
        title: "",
        applies: false,
        method: "",
        notes: "",
      },
    ];
    const plan = planAircraftSetup(
      s,
      AIRCRAFT,
      { inspections: rows, ads },
      {
        now: NOW,
      },
    );
    expect(plan.errors).toEqual([]);
    expect(plan.actions).toHaveLength(4);
    expect(plan.warnings).toEqual([
      "Aircraft total time is 0.0 h. Enter the baseline readings in the Aircraft step before loading history.",
      "Row 2 (AD 2024-01-01): its next due hours have already passed.",
      "Row 2 (AD 2024-01-01): its next due date has already passed.",
      'Row 3 (AD 2024-01-02): no next due limit, so it will show as "Due not set" until one is entered.',
    ]);
    rows[0].lastSeconds = 2000 * HOUR_SECONDS;
    rows[0].intervalSeconds = 100 * HOUR_SECONDS;
    const runOut = planAircraftSetup(
      demoSnapshot(),
      AIRCRAFT,
      { inspections: rows, ads: [] },
      { now: NOW },
    );
    expect(runOut.warnings).toEqual([
      "Row 2 (Oil change): its hours interval has already run out.",
    ]);
    // 0 remaining is overdue (GLOSSARY "Overdue"): due exactly at the current
    // 2341.2 h total still warns; one tenth later does not.
    rows[0].lastSeconds = 2241.2 * HOUR_SECONDS;
    const atZero = planAircraftSetup(
      demoSnapshot(),
      AIRCRAFT,
      { inspections: rows, ads: [] },
      { now: NOW },
    );
    expect(atZero.warnings).toHaveLength(1);
    rows[0].lastSeconds = Math.round(2241.3 * HOUR_SECONDS);
    const ahead = planAircraftSetup(
      demoSnapshot(),
      AIRCRAFT,
      { inspections: rows, ads: [] },
      { now: NOW },
    );
    expect(ahead.warnings).toEqual([]);
  });
  it("reports an unknown aircraft instead of planning", () => {
    const plan = planAircraftSetup(demoSnapshot(), "missing", parsed());
    expect(plan.errors).toEqual(["Aircraft not found."]);
    expect(plan.actions).toEqual([]);
  });
});

describe("setupStatus", () => {
  it("finds the gaps in step order and counts pending component setups", () => {
    const s = demoSnapshot();
    expect(setupStatus(s, AIRCRAFT)).toEqual({
      baseline: true,
      components: false,
      inspections: true,
      ads: false,
      pendingComponents: 0,
      gaps: ["components", "ads"],
    });
    expect(setupStatus(s, "missing").gaps).toEqual([
      "baseline",
      "components",
      "inspections",
      "ads",
    ]);
  });
  it("counts an AD only once its applicability is decided", () => {
    const s = demoSnapshot();
    const [action] = planAircraftSetup(
      s,
      AIRCRAFT,
      { inspections: [], ads: parseAdSetupCsv(adCsv).slice(1, 2) },
      { now: NOW },
    ).actions;
    if (action.step !== "ads" || action.command.kind !== "save")
      throw new Error("expected an AD save");
    const record = action.command.record;
    s.airworthiness = [{ ...record, applicability: "Needs review" }];
    expect(setupStatus(s, AIRCRAFT).ads).toBe(false);
    s.airworthiness = [record];
    expect(setupStatus(s, AIRCRAFT).ads).toBe(true);
  });
  it("names a chip and a step for every gap", () => {
    expect(Object.values(SETUP_GAPS).map((g) => g.step)).toEqual([
      "aircraft",
      "components",
      "inspections",
      "ads",
    ]);
  });
});

it("readSetupStep accepts only the wizard's steps", () => {
  expect(readSetupStep("ads")).toBe("ads");
  expect(readSetupStep("review")).toBe("review");
  expect(readSetupStep("other")).toBeUndefined();
  expect(readSetupStep(undefined)).toBeUndefined();
});
