/**
 * Responsibility: Pins the AD compliance worksheet: its fields, grouping and
 *   order, page breaks, corrections, file name and print hand-off.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/adReport.ts, src/data/demo.ts,
 *   src/domain/airworthiness.ts, src/domain/components.ts.
 *
 * AD_REPORT_SNAPSHOT=<snapshot.json> also writes a private preview of N626KB.
 */
// @vitest-environment node
import { test, expect, vi, afterEach } from "vitest";
import { adReport, adReportWorkOrders, printADReport } from "./adReport";
import { demoSnapshot } from "./demo";
import { blankAD, blankADTask, type AD } from "../domain/airworthiness";
import { componentSchema } from "../domain/components";
import { totalSeconds, type Snapshot } from "../domain/model";
import { writeFileSync, readFileSync } from "node:fs";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function recordedAD(s: Snapshot, number: string, over: Partial<AD> = {}) {
  const r = blankAD(s.aircraft[0].uuid);
  r.source.number = number;
  return { ...r, ...over };
}

function installedEngine(s: Snapshot, installedSeconds: number) {
  const a = s.aircraft[0];
  return componentSchema.parse({
    uuid: "engine",
    kind: "component",
    version: 1,
    aircraftUuid: a.uuid,
    componentType: "Engine",
    partNumber: "PN",
    serial: "ENGINE-SN",
    manufacturer: "Lycoming",
    notes: "",
    trackTime: true,
    trackCycles: true,
    trackCalendar: true,
    installed: true,
    installedDate: "2026-01-01",
    installedSeconds,
    installedCycles: a.cycles,
    timeSinceNew: 100 * 3600,
    timeSinceOverhaul: null,
    timeSinceRepair: null,
    cyclesSinceNew: 20,
    serviceDaysBase: 0,
  });
}

function complianceEntry(taskUuid: string) {
  return {
    uuid: crypto.randomUUID(),
    taskUuid,
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
}

function printTab() {
  return { close: vi.fn(), location: { href: "" } };
}

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
  expect(pdf.output()).toContain("(AD 2026-02-02 \\(continued\\)) Tj");
});

test("prints a corrected compliance entry once, with the original it replaced", () => {
  const s = demoSnapshot();
  const r = blankAD(s.aircraft[0].uuid);
  r.source.number = "2026-03-03";
  r.applicability = "Applicable";
  r.reviewRequired = false;
  const task = { ...blankADTask(), description: "Inspect", intervalHours: 100 };
  r.tasks = [task];
  const original = complianceEntry(task.uuid);
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

test("groups by section, then component, then AD number in numeric order, a page each", () => {
  const s = demoSnapshot();
  const a = s.aircraft[0];
  s.management = [installedEngine(s, totalSeconds(a))];
  const engineAD = recordedAD(s, "2020-ENGINE", { componentUuid: "engine" });
  engineAD.source.section = "Engine";
  s.airworthiness = [
    engineAD,
    recordedAD(s, "2026-10-01"),
    recordedAD(s, "2026-9-01"),
    recordedAD(s, "2026-OTHER", { aircraftUuid: s.aircraft[1].uuid }),
  ];
  const { pdf } = adReport(s, a.uuid);
  const output = pdf.output();
  const order = ["(2026-9-01)", "(2026-10-01)", "(Engine)", "(2020-ENGINE)"];
  const at = order.map((text) => output.indexOf(text));
  expect(at.every((i) => i > 0)).toBe(true);
  expect(at).toEqual([...at].sort((x, z) => x - z));
  expect(output).not.toContain("2026-OTHER");
  expect(output).toContain("Number of ADs: 2 recorded for this airframe.");
  expect(output).toContain("(Hours \\(TSN\\): 100.0) Tj");
  expect(pdf.getNumberOfPages()).toBe(2);
});

test("marks component hours Unavailable when its usage cannot be computed", () => {
  const s = demoSnapshot();
  const a = s.aircraft[0];
  s.management = [installedEngine(s, totalSeconds(a) + 3600)];
  s.airworthiness = [recordedAD(s, "2020-ENGINE", { componentUuid: "engine" })];
  const output = adReport(s, a.uuid).pdf.output();
  expect(output).toContain("(Hours \\(TSN\\): Unavailable) Tj");
});

test("says when no ADs are recorded instead of printing an empty worksheet", () => {
  const s = demoSnapshot();
  const output = adReport(s, s.aircraft[0].uuid).pdf.output();
  expect(output).toContain("No AD records have been entered for this");
});

test("names the file and dates each page footer by today's local date", () => {
  vi.useFakeTimers({ now: new Date(2026, 5, 15, 12), toFake: ["Date"] });
  const s = demoSnapshot();
  const { pdf, filename } = adReport(s, s.aircraft[0].uuid);
  expect(filename).toBe("AD-Compliance-N206MA-2026-06-15.pdf");
  expect(pdf.output()).toContain("N206MA | AD Compliance Report | 2026-06-15");
  expect(pdf.output()).toContain("(Page 1 of 1) Tj");
});

test("refuses an unknown aircraft", () => {
  expect(() => adReport(demoSnapshot(), "missing")).toThrow(
    "Aircraft not found.",
  );
});

test("prints in the given tab and releases its URL after two minutes", () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:report");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockReturnValue();
  const tab = printTab();
  const s = demoSnapshot();
  printADReport(s, s.aircraft[0].uuid, tab as unknown as Window);
  expect(tab.location.href).toBe("blob:report");
  vi.advanceTimersByTime(119999);
  expect(revoke).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(revoke).toHaveBeenCalledWith("blob:report");
});

test("asks for pop-ups without a tab, and closes the tab when the report fails", () => {
  const s = demoSnapshot();
  expect(() => printADReport(s, s.aircraft[0].uuid, null)).toThrow(
    "Allow pop-ups to print the report.",
  );
  const tab = printTab();
  expect(() => printADReport(s, "missing", tab as unknown as Window)).toThrow(
    "Aircraft not found.",
  );
  expect(tab.close).toHaveBeenCalled();
});

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

test("names each work order the aircraft's compliance history cites, once", () => {
  const s = demoSnapshot();
  const task = blankADTask();
  const entry = (workOrderUuid: string) => ({
    ...complianceEntry(task.uuid),
    workOrderUuid,
  });
  s.airworthiness = [
    recordedAD(s, "2020-01-01", {
      tasks: [task],
      history: [entry("wo-old"), entry(""), entry("wo-old")],
    }),
    recordedAD(s, "2021-02-02", { tasks: [task], history: [entry("wo-new")] }),
    {
      ...recordedAD(s, "2022-03-03", { history: [entry("wo-other")] }),
      aircraftUuid: s.aircraft[1].uuid,
    },
  ];
  expect(adReportWorkOrders(s, s.aircraft[0].uuid)).toEqual([
    "wo-old",
    "wo-new",
  ]);
});
