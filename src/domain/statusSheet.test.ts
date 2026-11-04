/**
 * Responsibility: Pins the status sheet content: header, section order,
 *   placeholder rows, sort orders, which records are listed, component
 *   fallbacks, the failure on an uncomputable inspection, and the notes
 *   under each table.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/statusSheet.ts, airworthiness.ts, components.ts,
 *   model.ts, rejection.ts, src/data/demo.ts (fixture).
 */
import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { blankAD } from "./airworthiness";
import { componentSchema } from "./components";
import { totalSeconds, type Inspection, type Snapshot } from "./model";
import { Rejection } from "./rejection";
import { statusSheet, type StatusSectionId } from "./statusSheet";

const TODAY = "2026-06-15";
const HOUR_SECONDS = 3600;

function sheet(s: Snapshot) {
  return statusSheet(s, s.aircraft[0].uuid, TODAY);
}

function section(s: Snapshot, id: StatusSectionId) {
  const found = sheet(s).sections.find((x) => x.id === id);
  if (!found) throw new Error(`No ${id} section`);
  return found;
}

function component(s: Snapshot, uuid: string, over: object = {}) {
  const a = s.aircraft[0];
  return componentSchema.parse({
    uuid,
    kind: "component",
    version: 1,
    aircraftUuid: a.uuid,
    componentType: "Engine",
    partNumber: "PN",
    serial: "SN-" + uuid,
    manufacturer: "",
    notes: "",
    trackTime: true,
    trackCycles: true,
    trackCalendar: true,
    installed: true,
    installedDate: "2026-01-01",
    installedSeconds: totalSeconds(a),
    installedCycles: a.cycles,
    timeSinceNew: 100 * HOUR_SECONDS,
    timeSinceOverhaul: null,
    timeSinceRepair: null,
    cyclesSinceNew: 20,
    serviceDaysBase: 0,
    ...over,
  });
}

function inspection(s: Snapshot, over: Partial<Inspection>): Inspection {
  return {
    uuid: crypto.randomUUID(),
    aircraftUuid: s.aircraft[0].uuid,
    reference: "",
    description: "",
    ...over,
  };
}

function form337(
  s: Snapshot,
  name: string,
  uploadedAt: number,
  archivedAt?: number,
) {
  return {
    uuid: name,
    aircraftUuid: s.aircraft[0].uuid,
    category: "form-337" as const,
    name,
    type: "application/pdf",
    size: 2049,
    uploadedAt,
    url: "",
    archivedAt,
  };
}

it("heads the sheet with the aircraft and lists six sections in order", () => {
  const s = demoSnapshot();
  const a = s.aircraft[0];
  const result = sheet(s);
  expect(result.header).toEqual({
    registration: a.registration,
    makeModel: `${a.make} ${a.model}`,
    serial: a.serial,
  });
  expect(result.sections.map((x) => [x.id, x.title])).toEqual([
    ["overview", "Aircraft overview"],
    ["components", "Installed components"],
    ["inspections", "Inspection schedules"],
    ["airworthiness", "Airworthiness directives"],
    ["form337", "Form 337 copies"],
    ["discrepancies", "Open discrepancies"],
  ]);
  for (const x of result.sections)
    for (const row of x.rows) expect(row).toHaveLength(x.columns.length);
});

it("refuses an aircraft the snapshot does not hold", () => {
  const run = () => statusSheet(demoSnapshot(), "missing", TODAY);
  expect(run).toThrow(Rejection);
  expect(run).toThrow("Aircraft not found.");
});

it("holds one placeholder row for each empty table", () => {
  const s = demoSnapshot();
  s.management = [];
  s.inspections = [];
  s.airworthiness = [];
  s.aircraftFiles = [];
  s.discrepancies = [];
  const rows = sheet(s)
    .sections.slice(1)
    .map((x) => x.rows);
  expect(rows).toEqual([
    [["No installed component records", "-", "-", "-", "-", "-", "-"]],
    [["No active inspection schedules", ...Array(8).fill("-")]],
    [["No AD records", "-", "-", "-", "-"]],
    [["No Form 337 copies on file", "-", "-"]],
    [["-", "No open discrepancies recorded", "-"]],
  ]);
});

it("lists installed components and reviews times it cannot compute", () => {
  const s = demoSnapshot();
  const a = s.aircraft[0];
  s.management = [
    component(s, "eng", { installPosition: "LEFT" }),
    component(s, "prop", { trackTime: false, trackCycles: false }),
    component(s, "bad", { installedSeconds: totalSeconds(a) + HOUR_SECONDS }),
    component(s, "off", { installed: false }),
    component(s, "other", { aircraftUuid: s.aircraft[1].uuid }),
  ];
  expect(section(s, "components").rows).toEqual([
    ["LEFT Engine", "PN", "SN-eng", "100.0", "-", "-", "20"],
    [
      " Engine",
      "PN",
      "SN-prop",
      "Not tracked",
      "Not tracked",
      "Not tracked",
      "Not tracked",
    ],
    [" Engine", "PN", "SN-bad", "Review", "Review", "Review", "Review"],
  ]);
});

it("orders active inspections by reference, digits as numbers", () => {
  const s = demoSnapshot();
  s.inspections = [
    inspection(s, { reference: "10-HR" }),
    inspection(s, { reference: "ARCH", archived: true }),
    inspection(s, { reference: "2-HR" }),
    inspection(s, { reference: "OTHER", aircraftUuid: s.aircraft[1].uuid }),
    inspection(s, { reference: "", description: "One-time check" }),
  ];
  const rows = section(s, "inspections").rows;
  expect(rows.map((r) => r[0])).toEqual(["One-time check", "2-HR", "10-HR"]);
  expect(rows[0].slice(1, 5)).toEqual(["One-time", "-", "-", "-"]);
});

it("fails when an inspection's status cannot be computed", () => {
  const s = demoSnapshot();
  const a = s.aircraft[0];
  s.management = [
    component(s, "bad", { installedSeconds: totalSeconds(a) + HOUR_SECONDS }),
  ];
  s.inspections = [inspection(s, { reference: "BAD", componentUuid: "bad" })];
  expect(() => sheet(s)).toThrow(
    "Aircraft readings or date precede the installation baseline.",
  );
});

it("notes each calendar exemption reason once, after the table", () => {
  const s = demoSnapshot();
  const exempt = { intervalMonths: 12, calendarExempt: true };
  s.inspections = [
    inspection(s, {
      ...exempt,
      reference: "ELT",
      calendarExemptReason: "Stored",
    }),
    inspection(s, { ...exempt, reference: "PITOT" }),
    inspection(s, {
      ...exempt,
      reference: "XPDR",
      calendarExemptReason: "Stored",
    }),
  ];
  const result = section(s, "inspections");
  expect(result.rows[0].slice(1, 5)).toEqual([
    "12 mo (exempt)",
    "-",
    "-",
    "Calendar exempt",
  ]);
  expect(result.notes).toEqual([
    "Calendar exemption - ELT, XPDR: Stored",
    "Calendar exemption - PITOT: Reason not recorded",
    expect.stringMatching(/^\* Months remaining are approximate;/),
  ]);
});

it("orders ADs by Component uuid, then AD number with digits as numbers", () => {
  const s = demoSnapshot();
  const ad = (number: string, componentUuid = "") => {
    const r = { ...blankAD(s.aircraft[0].uuid), componentUuid };
    r.source = { ...r.source, number };
    return r;
  };
  s.management = [component(s, "eng")];
  s.airworthiness = [
    ad("2020-10-01"),
    ad("2019-01-01", "eng"),
    ad("2020-9-01"),
    { ...ad("2018-01-01"), aircraftUuid: s.aircraft[1].uuid },
  ];
  const rows = section(s, "airworthiness").rows;
  expect(rows.map((r) => r[0])).toEqual([
    "2020-9-01",
    "2020-10-01",
    "2019-01-01",
  ]);
  expect(rows[2][1]).toBe(" Engine\nS/N SN-eng");
});

it("lists closed ADs and a removed Component's AD under its section", () => {
  const s = demoSnapshot();
  const ad = (number: string, over: object) => {
    const r = { ...blankAD(s.aircraft[0].uuid), ...over };
    r.source = { ...r.source, number, section: "Appliance" as const };
    return r;
  };
  s.management = [component(s, "off", { installed: false })];
  s.airworthiness = [
    ad("2020-01-01", {
      applicability: "Not applicable",
      reviewRequired: false,
    }),
    ad("2020-02-01", { applicability: "Superseded", reviewRequired: false }),
    ad("2020-03-01", { componentUuid: "off" }),
  ];
  const rows = section(s, "airworthiness").rows;
  expect(rows.map((r) => [r[0], r[1], r[4]])).toEqual([
    ["2020-01-01", "Appliance", "Not applicable"],
    ["2020-02-01", "Appliance", "Superseded"],
    ["2020-03-01", "Appliance", "Removed component"],
  ]);
});

it("notes the flight time log only when kept and read, and the collective hourmeter when read", () => {
  const s = demoSnapshot();
  const a = s.aircraft[0];
  const notes = () => section(s, "overview").notes;
  expect(notes()).toEqual([expect.stringMatching(/^Data synchronized /)]);
  Object.assign(a, { flightTimeLog: true });
  expect(notes()).toHaveLength(1);
  Object.assign(a, {
    flightTimeLog: false,
    currentFlightTimeLog: 12.5 * HOUR_SECONDS,
  });
  expect(notes()).toHaveLength(1);
  Object.assign(a, {
    flightTimeLog: true,
    currentCyclicHobbs: 7 * HOUR_SECONDS,
  });
  expect(notes().slice(0, 2)).toEqual([
    "Flight time log: 12.5 hours",
    "Collective hourmeter: 7.0 hours",
  ]);
});

it("lists current Form 337 copies oldest first and counts archived ones", () => {
  const s = demoSnapshot();
  s.aircraftFiles = [
    form337(s, "b.pdf", 2e12),
    form337(s, "a.pdf", 1e12),
    form337(s, "old.pdf", 0, 1),
  ];
  const result = section(s, "form337");
  expect(result.rows.map((r) => [r[0], r[2]])).toEqual([
    ["a.pdf", "3 KB"],
    ["b.pdf", "3 KB"],
  ]);
  expect(result.notes).toEqual([
    expect.stringMatching(/^1 archived Form 337 copy is not listed\./),
  ]);
  s.aircraftFiles.push(form337(s, "older.pdf", 0, 2));
  expect(section(s, "form337").notes[0]).toMatch(
    /^2 archived Form 337 copies are/,
  );
});

it("lists only this aircraft's open discrepancies", () => {
  const s = demoSnapshot();
  const report = { ...s.discrepancies[0], aircraftUuid: s.aircraft[0].uuid };
  s.discrepancies = [
    { ...report, uuid: "open", description: "Open leak" },
    { ...report, uuid: "done", description: "Fixed", status: "resolved" },
    { ...report, uuid: "other", aircraftUuid: s.aircraft[1].uuid },
  ];
  expect(section(s, "discrepancies").rows.map((r) => r.slice(1))).toEqual([
    ["Open leak", "Open"],
  ]);
});
