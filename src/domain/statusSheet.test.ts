/**
 * Responsibility: Pins the status sheet content: header, section order,
 *   placeholder rows, sort orders, which records are listed, component
 *   fallbacks, the failure on an uncomputable inspection, a total it cannot
 *   read, the notes under each table, each status cell's tone, and that the
 *   sheet's status and marks agree with aircraftStatus in every grounding
 *   state.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/statusSheet.ts, aircraftStatus.ts,
 *   airworthiness.ts, components.ts, model.ts, rejection.ts,
 *   src/data/demo.ts and tests/fixtures/dueFleet.ts (fixtures).
 */
import { describe, expect, it } from "vitest";
import {
  DUE_FLEET_TODAY,
  dueFleet,
  withoutMeterReading,
} from "../../tests/fixtures/dueFleet";
import { demoSnapshot } from "../data/demo";
import { aircraftStatus, aircraftStatusLabels } from "./aircraftStatus";
import { blankAD, blankADTask } from "./airworthiness";
import { componentSchema } from "./components";
import {
  totalSeconds,
  type Aircraft,
  type Discrepancy,
  type Inspection,
  type Snapshot,
} from "./model";
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

// Leaves the first aircraft with nothing due, grounding or open; its setup
// then has gaps, so it shows "Setup incomplete" until setUp() fills them.
function quiet(s: Snapshot) {
  s.aircraft[0].operationalStatus = "airworthy";
  s.management = [];
  s.inspections = [];
  s.airworthiness = [];
  s.discrepancies = [];
}

// Fills the first aircraft's setup gaps without adding anything due: a
// component with no limits, a distant inspection and an AD that does not
// apply.
function setUp(s: Snapshot) {
  const ad = blankAD(s.aircraft[0].uuid);
  ad.applicability = "Not applicable";
  s.management = [...(s.management ?? []), component(s, "set-up-engine")];
  s.inspections.push(
    inspection(s, { reference: "Annual", dueDate: "2030-01-01" }),
  );
  s.airworthiness = [...(s.airworthiness ?? []), ad];
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

it("heads the sheet with the aircraft and lists seven sections in order", () => {
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
    ["limits", "Component limits"],
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
    [["No component limits recorded", "-", "-", "-", "-"]],
    [["No active inspection schedules", ...Array(8).fill("-")]],
    [["No AD records", "-", "-", "-", "-"]],
    [["No Form 337 copies on file", "-", "-"]],
    [["-", "No open discrepancies recorded", "-", "-"]],
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

// Characterizes current behaviour: its inspections still fail the sheet, as
// any uncomputable inspection does.
it("records a total it cannot read as not recorded", () => {
  const s = demoSnapshot();
  withoutMeterReading(s, s.aircraft[0]);
  expect(() => sheet(s)).toThrow(
    new Rejection("Flight time log reading is required."),
  );
  s.inspections = [];
  expect(section(s, "overview").rows[0][1]).toBe("Not recorded");
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
  quiet(s);
  setUp(s);
  const notes = () => section(s, "overview").notes.slice(1);
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
    ["Open leak", "-", "Open"],
  ]);
});

// One record of the due fleet at a time, on an aircraft otherwise airworthy.
function fleetWith(build: (s: Snapshot, a: Aircraft) => void) {
  const { s, a } = dueFleet();
  quiet(s);
  build(s, a);
  return { s, a };
}

function keep<T extends { uuid: string }>(records: T[], ...uuids: string[]) {
  return records.filter((r) => uuids.includes(r.uuid));
}

function report(a: Aircraft, over: Partial<Discrepancy>): Discrepancy {
  return {
    uuid: "report",
    aircraftUuid: a.uuid,
    description: "Cabin light inoperative",
    status: "open",
    authorId: "pilot",
    createdAt: Date.parse("2026-10-20T12:00:00Z"),
    ...over,
  };
}

function melDeferral(expiresOn: string): Discrepancy["deferral"] {
  return {
    type: "mel",
    melItem: "33-1",
    category: "B",
    placard: "INOP",
    deferredOn: "2026-10-20",
    deferredAt: 0,
    deferredBy: "admin",
    deferredByName: "Admin",
    expiresOn,
  };
}

const full = dueFleet().s;
const HOURS_95 = 95 * HOUR_SECONDS;

// Each state grounds the aircraft by one record; `mark` is what that
// record's own row must say.
const GROUNDING_STATES: [
  string,
  (s: Snapshot, a: Aircraft) => void,
  StatusSectionId,
  RegExp,
][] = [
  [
    "the profile",
    (_s, a) => Object.assign(a, { operationalStatus: "grounded" }),
    "overview",
    /Profile status entered on the aircraft record: grounded/,
  ],
  [
    "an overdue inspection",
    (s) => (s.inspections = keep(full.inspections, "i-late")),
    "inspections",
    /"overdue"/,
  ],
  [
    "a component past its life limit",
    (s) => {
      s.management = keep(structuredClone(full.management!), "pump", "r-now");
      Object.assign(s.management[1], { dueSeconds: HOURS_95 });
    },
    "limits",
    /"95\.0 h TSN","-5\.0 h","Past due \(overdue\)"/,
  ],
  [
    "a component limit with nothing left",
    (s) => (s.management = keep(full.management!, "pump", "r-now")),
    "limits",
    /"100\.0 h TSN","0\.0 h","Due now \(overdue\)"/,
  ],
  [
    "an overdue AD action",
    (s) => (s.airworthiness = keep(full.airworthiness!, "ad-overdue")),
    "airworthiness",
    /"Overdue"/,
  ],
  [
    "a grounding discrepancy",
    (s, a) => (s.discrepancies = [report(a, { grounding: true })]),
    "discrepancies",
    /"-","Open: grounds the aircraft"/,
  ],
  [
    "an expired MEL deferral",
    (s, a) =>
      (s.discrepancies = [report(a, { deferral: melDeferral("2026-10-23") })]),
    "discrepancies",
    /MEL 33-1 \(Category B\)\\nDeferred 2026-10-20\\nExpires 2026-10-23","Open: deferral expired, grounds the aircraft"/,
  ],
];

describe("agrees with aircraftStatus", () => {
  it.each(GROUNDING_STATES)(
    "when %s grounds the aircraft",
    (_name, build, id, mark) => {
      const { s, a } = fleetWith(build);
      const status = aircraftStatus(s, a.uuid, DUE_FLEET_TODAY);
      expect(status.level).toBe("grounded");
      const result = statusSheet(s, a.uuid, DUE_FLEET_TODAY);
      const [overview] = result.sections;
      expect(overview.columns[0]).toBe("Aircraft status:");
      expect(overview.rows[0][0]).toBe("Grounded");
      expect(overview.notes[0]).toBe(
        `Grounded: ${status.reasons.map((r) => r.label).join("; ")}.`,
      );
      const rows = result.sections.find((x) => x.id === id)!;
      expect(JSON.stringify([rows.rows, rows.notes])).toMatch(mark);
    },
  );

  it("when several records ground it, naming every reason", () => {
    const { s, a } = fleetWith((s, a) => {
      for (const [, build] of GROUNDING_STATES.slice(1, 3)) build(s, a);
      s.discrepancies = [report(a, { grounding: true })];
    });
    const labels = aircraftStatus(s, a.uuid, DUE_FLEET_TODAY).reasons.map(
      (r) => r.label,
    );
    expect(labels).toHaveLength(3);
    const [overview] = statusSheet(s, a.uuid, DUE_FLEET_TODAY).sections;
    expect(overview.notes[0]).toBe(`Grounded: ${labels.join("; ")}.`);
  });

  it("when a deferral is about to expire or still has time", () => {
    const { s, a } = fleetWith((s, a) => {
      setUp(s);
      s.discrepancies = [
        report(a, { uuid: "soon", deferral: melDeferral("2026-11-01") }),
        report(a, { uuid: "later", deferral: melDeferral("2026-12-01") }),
      ];
    });
    const status = aircraftStatus(s, a.uuid, DUE_FLEET_TODAY);
    const result = statusSheet(s, a.uuid, DUE_FLEET_TODAY);
    expect(status.level).toBe("due-soon");
    expect(result.sections[0].rows[0][0]).toBe(
      aircraftStatusLabels["due-soon"],
    );
    expect(result.sections[0].notes[0]).toBe(
      "Due soon: MEL 33-1 (Category B) deferral expires 2026-11-01.",
    );
    expect(result.sections.at(-1)!.rows.map((r) => r[3])).toEqual([
      "Open: deferral expires soon",
      "Open: deferred",
    ]);
  });

  it("when nothing is due: airworthy, with no reason note", () => {
    const { s, a } = fleetWith(setUp);
    const [overview] = statusSheet(s, a.uuid, DUE_FLEET_TODAY).sections;
    expect(aircraftStatus(s, a.uuid, DUE_FLEET_TODAY).level).toBe("airworthy");
    expect(overview.rows[0][0]).toBe("Airworthy");
    expect(overview.notes[0]).toBe(
      "Aircraft status is computed from the records on this sheet. Profile status entered on the aircraft record: airworthy.",
    );
  });
});

it("shows setup incomplete with the gaps for an aircraft not yet set up, though nothing grounds it", () => {
  const { s, a } = fleetWith(() => {});
  expect(aircraftStatus(s, a.uuid, DUE_FLEET_TODAY).level).toBe("airworthy");
  const [overview] = statusSheet(s, a.uuid, DUE_FLEET_TODAY).sections;
  expect(overview.rows[0][0]).toBe("Setup incomplete");
  expect(overview.notes[0]).toBe(
    "Setup incomplete: Components missing; Inspections missing; ADs not reviewed.",
  );
});

it("lists each installed component's limits in component order and reviews one it cannot compute", () => {
  const { s, a } = dueFleet();
  s.inspections = [];
  const rows = statusSheet(s, a.uuid, DUE_FLEET_TODAY).sections.find(
    (x) => x.id === "limits",
  )!.rows;
  expect(rows.map((r) => [r[1].split("\n")[0], r[4]])).toEqual([
    ["r-now limit", "Due now (overdue)"],
    ["r-today limit", "Due soon"],
    ["r-tracked limit", "Tracked"],
    ["r-landing limit", "Set landing baseline"],
    ["r-early limit", "Review"],
    ["r-gear-tso limit", "Set time baseline"],
  ]);
  expect(rows[0]).toEqual([
    " Type pump\nS/N SN-pump",
    "r-now limit\nLife Limits",
    "100.0 h TSN",
    "0.0 h",
    "Due now (overdue)",
  ]);
  expect(rows[1].slice(2, 4)).toEqual([DUE_FLEET_TODAY, "0 days"]);
  expect(rows[4].slice(2)).toEqual(["Review", "Review", "Review"]);
});

it("tones each status cell by its status value, not its words", () => {
  const { s, a } = dueFleet();
  // Their status cannot be computed, which fails the whole sheet.
  s.inspections = s.inspections.filter(
    (i) => !["i-calendar-unread", "i-missing"].includes(i.uuid),
  );
  s.discrepancies = [
    report(a, { uuid: "grounds", grounding: true }),
    report(a, { uuid: "soon", deferral: melDeferral("2026-11-01") }),
    report(a, { uuid: "later", deferral: melDeferral("2026-12-01") }),
  ];
  const result = statusSheet(s, a.uuid, DUE_FLEET_TODAY);
  const toned = (id: StatusSectionId) => {
    const x = result.sections.find((y) => y.id === id)!;
    return x.rows.map((r, i) => [r[x.statusColumn!], x.tones![i]]);
  };
  expect(toned("overview")).toEqual([["Grounded", "danger"]]);
  expect(toned("limits")).toEqual(
    expect.arrayContaining([
      ["Due now (overdue)", "danger"],
      ["Due soon", "caution"],
      ["Review", "caution"],
      ["Tracked", undefined],
      ["Set landing baseline", undefined],
    ]),
  );
  expect(toned("inspections")).toEqual(
    expect.arrayContaining([
      ["overdue", "danger"],
      ["due-soon", "caution"],
      ["scheduled", undefined],
    ]),
  );
  expect(toned("airworthiness")).toEqual(
    expect.arrayContaining([
      ["Overdue", "danger"],
      ["Due soon", "caution"],
      ["Needs review", "caution"],
      ["Counter unavailable", undefined],
      ["Not applicable", undefined],
      ["Complied", undefined],
    ]),
  );
  expect(toned("discrepancies")).toEqual([
    ["Open: grounds the aircraft", "danger"],
    ["Open: deferral expires soon", "caution"],
    ["Open: deferred", undefined],
  ]);
  const plain = ["components", "form337"].map((id) =>
    result.sections.find((x) => x.id === id)!,
  );
  for (const x of plain)
    expect([x.statusColumn, x.tones]).toEqual([undefined, undefined]);
});

it("prints the next due of an AD action that has a limit but no repeat interval", () => {
  const s = demoSnapshot();
  quiet(s);
  const hours = totalSeconds(s.aircraft[0]) / HOUR_SECONDS;
  const limited = (number: string, limits: object) => {
    const r = blankAD(s.aircraft[0].uuid);
    r.applicability = "Applicable";
    r.reviewRequired = false;
    r.source = { ...r.source, number };
    r.tasks = [{ ...blankADTask(), recurrence: "One-time", ...limits }];
    return r;
  };
  s.airworthiness = [
    limited("2026-01-01", { dueDate: "2020-01-01" }),
    limited("2026-01-02", { dueHours: hours + 10 }),
  ];
  const rows = section(s, "airworthiness").rows.map((r) => r.slice(3));
  expect(rows).toEqual([
    ["Due 2020-01-01\nMonths remaining (approx.): 77.4 overdue", "Overdue"],
    [`Due at ${(hours + 10).toFixed(1)} h\nHours remaining: 10.0`, "Due soon"],
  ]);
});
