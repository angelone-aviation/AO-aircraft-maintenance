/**
 * Responsibility: Pins the records package content: section order and files,
 *   row order and wording per table, placeholders, component fallbacks, the
 *   file plan and its size limit, file paths, the README and the ZIP name.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/recordsPackage.ts, statusSheet.ts,
 *   airworthiness.ts, components.ts, workOrders.ts, model.ts, rejection.ts,
 *   src/data/demo.ts and tests/fixtures (dueFleet, workOrders).
 */
import { describe, expect, it } from "vitest";
import { withoutMeterReading } from "../../tests/fixtures/dueFleet";
import {
  workOrderCommand,
  workOrderComponent,
} from "../../tests/fixtures/workOrders";
import { demoSnapshot } from "../data/demo";
import { blankAD, blankADTask, type ADCompliance } from "./airworthiness";
import { requirementSchema } from "./components";
import type { AuditEntry, Flight, Snapshot } from "./model";
import {
  buildRecordsPackage,
  MAX_PACKAGE_FILE_BYTES,
  planPackageFiles,
  recordsPackageName,
  recordsReadme,
  type PackageFile,
  type RecordsSectionId,
} from "./recordsPackage";
import { Rejection } from "./rejection";
import { statusSheet } from "./statusSheet";
import { saveWorkOrder, workOrderFieldsSchema } from "./workOrders";

const TODAY = "2026-06-15";
const HOUR = 3600;
const DAY_MS = 86_400_000;
const MB = 1024 * 1024;
const AT = Date.parse("2026-06-01T12:00:00Z");
const EMPTY_LOG = { entries: [], complete: true };

function build(s: Snapshot, uuid = s.aircraft[0].uuid, log = EMPTY_LOG) {
  return buildRecordsPackage(s, uuid, TODAY, log);
}

function section(s: Snapshot, id: RecordsSectionId, uuid?: string) {
  const found = build(s, uuid).sections.find((x) => x.id === id);
  if (!found) throw new Error(`No ${id} section`);
  return found;
}

function flight(s: Snapshot, over: Partial<Flight>): Flight {
  return {
    uuid: crypto.randomUUID(),
    authorId: s.user.id,
    submittedAt: AT,
    status: "accepted",
    aircraftUuid: s.aircraft[0].uuid,
    pilotId: s.user.id,
    startTime: "2026-05-01T10:00:00-05:00",
    hobbsOff: 2341.2 * HOUR,
    hobbsOn: 2342.7 * HOUR,
    tachOff: 2261.2 * HOUR,
    tachOn: 2262.5 * HOUR,
    landings: 2,
    cycles: 1,
    origin: "KMIA",
    destination: "MYNN",
    operation: "Mission",
    flightRules: "VFR",
    remarks: "Smooth",
    discrepancy: "",
    ...over,
  };
}

function form337(
  s: Snapshot,
  uuid: string,
  name: string,
  uploadedAt: number,
  size = 2048,
) {
  return {
    uuid,
    aircraftUuid: s.aircraft[0].uuid,
    category: "form-337" as const,
    name,
    type: "application/pdf",
    size,
    uploadedAt,
    url: `data:application/pdf;base64,${uuid}`,
  };
}

function completedOrder(s: Snapshot) {
  const opened = saveWorkOrder(s, workOrderCommand(), AT);
  return saveWorkOrder(
    s,
    {
      action: "save",
      uuid: opened.uuid,
      version: opened.version,
      componentUuids: [],
      fields: {
        ...workOrderFieldsSchema.parse(opened),
        status: "completed",
        completionDate: "2026-06-02",
        releaseOutcome: "Approved for return to service.",
        finalReview: "Reviewed",
      },
      tasks: [],
    },
    AT + DAY_MS,
  );
}

describe("buildRecordsPackage", () => {
  it("lists the status sheet first, then the records, each with its CSV", () => {
    const s = demoSnapshot();
    const pkg = build(s);
    expect(pkg.aircraft).toEqual({
      registration: "N206MA",
      makeModel: "Cessna 206 Stationair",
      serial: "DEMO-demo-206",
      program: "Mission operations",
    });
    expect(pkg.sections.map((x) => [x.id, x.file])).toEqual([
      ["status.overview", "status-overview.csv"],
      ["status.components", "status-components.csv"],
      ["status.inspections", "status-inspections.csv"],
      ["status.airworthiness", "status-airworthiness.csv"],
      ["status.form337", "status-form-337.csv"],
      ["status.discrepancies", "status-discrepancies.csv"],
      ["flights", "flights.csv"],
      ["discrepancies", "discrepancies.csv"],
      ["workOrders", "work-orders.csv"],
      ["adCompliance", "ad-compliance.csv"],
      ["components", "components.csv"],
      ["componentRequirements", "component-requirements.csv"],
      ["form337Copies", "form-337.csv"],
      ["changeLog", "change-log.csv"],
    ]);
    const status = statusSheet(s, s.aircraft[0].uuid, TODAY);
    expect(pkg.sections.slice(0, 6).map((x) => x.rows)).toEqual(
      status.sections.map((x) => x.rows),
    );
    for (const x of pkg.sections) {
      expect(new Set(x.columns).size).toBe(x.columns.length);
      for (const row of x.rows) expect(row).toHaveLength(x.columns.length);
    }
    expect(pkg.files).toEqual([]);
  });

  it("refuses an unknown aircraft", () => {
    expect(() => build(demoSnapshot(), "nope")).toThrow(
      new Rejection("Aircraft not found."),
    );
  });

  it("holds a placeholder row in every empty table", () => {
    const s = demoSnapshot();
    const empties = build(s)
      .sections.slice(6)
      .map((x) => [x.id, x.rows[0][0]]);
    expect(empties).toEqual([
      ["flights", "No flights recorded"],
      ["discrepancies", "No discrepancies recorded"],
      ["workOrders", "No work orders recorded"],
      ["adCompliance", "No AD compliance recorded"],
      ["components", "No component records"],
      ["componentRequirements", "No component requirements recorded"],
      ["form337Copies", "No Form 337 copies on file"],
      ["changeLog", "No changes recorded"],
    ]);
  });

  it("packages an aircraft whose meter has no reading", () => {
    const s = demoSnapshot();
    withoutMeterReading(s, s.aircraft[0]);
    s.inspections = [];
    expect(section(s, "status.overview").rows[0][1]).toBe("Not recorded");
  });

  it("lists this aircraft's flights oldest first with names and readings", () => {
    const s = demoSnapshot();
    s.flights = [
      flight(s, {
        startTime: "2026-05-02T10:00:00-05:00",
        status: "review",
        reviewReason: "Aircraft changed",
        copilotId: "demo-pilot",
        oil: [{ engine: "single", unit: "US qt", added: 1 }],
        cyclicHobbsOff: 10 * HOUR,
        cyclicHobbsOn: 11 * HOUR,
      }),
      flight(s, { startTime: "2026-05-01T10:00:00-05:00" }),
      flight(s, { aircraftUuid: s.aircraft[1].uuid }),
    ];
    const { rows, columns } = section(s, "flights");
    expect(columns[0]).toBe("Date and time");
    expect(rows.map((r) => r[0])).toEqual([
      "2026-05-01T10:00:00-05:00",
      "2026-05-02T10:00:00-05:00",
    ]);
    expect(rows[0]).toEqual([
      "2026-05-01T10:00:00-05:00",
      "Alex Morgan",
      "KMIA - MYNN",
      "2341.2 / 2342.7",
      "2261.2 / 2262.5",
      "-",
      "2",
      "1",
      "-",
      "accepted",
      "Smooth",
    ]);
    expect(rows[1].slice(1, 2)).toEqual([`Alex Morgan / ${s.members[1].name}`]);
    expect(rows[1][5]).toBe("Collective 10.0 / 11.0");
    expect(rows[1][8]).toBe("1 US qt");
    expect(rows[1][9]).toBe("Needs review: Aircraft changed");
  });

  it("lists open and resolved discrepancies with deferrals and resolutions", () => {
    const s = demoSnapshot();
    const a = s.aircraft[1];
    s.discrepancies.push({
      uuid: "fixed",
      aircraftUuid: a.uuid,
      description: "Tire worn",
      status: "resolved",
      authorId: "demo-pilot",
      createdAt: AT - 3 * DAY_MS,
      resolution: "Replaced tire",
      resolvedBy: s.user.id,
      resolvedAt: AT,
      deferral: {
        type: "mel",
        melItem: "32-1",
        category: "C",
        placard: "INOP",
        deferredOn: "2026-05-29",
        deferredAt: AT - 2 * DAY_MS,
        deferredBy: s.user.id,
        deferredByName: "Alex Morgan",
        expiresOn: "2026-06-08",
      },
    });
    const { rows } = section(s, "discrepancies", a.uuid);
    expect(rows).toHaveLength(2);
    expect(rows[0].slice(1, 5)).toEqual([
      s.members[1].name,
      "Tire worn",
      "No",
      "MEL item 32-1, category C; deferred 2026-05-29 by Alex Morgan\nexpires 2026-06-08\nplacard: INOP",
    ]);
    expect(rows[0].slice(5)).toEqual([
      "Resolved",
      "2026-06-01 12:00",
      "Alex Morgan",
      "Replaced tire",
    ]);
    expect(rows[1][2]).toMatch(/^Left landing light/);
    expect(rows[1].slice(4, 9)).toEqual(["-", "Open", "-", "-", "-"]);
  });

  it("writes work orders by date opened with the frozen entry of closed ones", () => {
    const s = demoSnapshot();
    const closed = completedOrder(s);
    const later = saveWorkOrder(
      s,
      {
        ...workOrderCommand(),
        fields: { ...workOrderCommand().fields, dateOpened: "2026-03-01" },
      },
      AT,
    );
    const { rows } = section(s, "workOrders");
    expect(rows.map((r) => r[0])).toEqual([closed.number, later.number]);
    expect(rows[0].slice(1, 8)).toEqual([
      "2026-01-01",
      "2026-06-02",
      "completed",
      "routine",
      "Annual maintenance",
      "Supervisor",
      "Approved for return to service.",
    ]);
    expect(rows[0][8]).toContain("Work performed:");
    expect(rows[0][8]).not.toContain("Signature");
    expect(rows[1].slice(2, 4)).toEqual(["-", "open"]);
    expect(rows[1][8]).toBe("-");
  });

  it("lists every AD compliance entry, naming corrections and the superseded", () => {
    const s = demoSnapshot();
    const a = s.aircraft[0];
    const task = { ...blankADTask(), description: "Inspect cable" };
    const entry = (over: Partial<ADCompliance>): ADCompliance => ({
      uuid: crypto.randomUUID(),
      taskUuid: task.uuid,
      date: "2026-01-10",
      hours: 2300,
      cycles: null,
      method: "Visual inspection",
      serviceBulletin: "",
      terminatedBy: "",
      workOrderUuid: "",
      mechanic: "Pat Doe",
      certificate: "A&P 123",
      evidence: "",
      recordedAt: AT,
      recordedBy: s.user.id,
      ...over,
    });
    const original = entry({});
    const ad = {
      ...blankAD(a.uuid),
      source: {
        ...blankAD(a.uuid).source,
        number: "2024-02-05",
        subject: "Cables",
      },
      tasks: [task],
      history: [
        original,
        entry({
          date: "2026-01-11",
          corrects: original.uuid,
          correctionReason: "Wrong date",
          serviceBulletin: "SB-1",
        }),
      ],
    };
    const other = { ...blankAD(s.aircraft[1].uuid), history: [entry({})] };
    s.airworthiness = [ad, other];
    const { rows } = section(s, "adCompliance");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual([
      "2024-02-05",
      "Cables",
      "Inspect cable",
      "2026-01-10",
      "2300.0",
      "-",
      "-",
      "Visual inspection",
      "-",
      "Pat Doe\nA&P 123",
      "-",
      "Original\nSuperseded by a correction",
    ]);
    expect(rows[1][3]).toBe("2026-01-11");
    expect(rows[1][8]).toBe("SB-1");
    expect(rows[1][11]).toBe("Corrects the entry of 2026-01-10: Wrong date");
  });

  it("lists installed components first and flags usage it cannot compute", () => {
    const s = demoSnapshot();
    const engine = workOrderComponent();
    const removed = {
      ...engine,
      uuid: "prop",
      componentType: "Propeller",
      serial: "P-1",
      installed: false,
      removedDate: "2026-02-01",
      trackCycles: false,
    };
    const broken = {
      ...engine,
      uuid: "bad",
      componentType: "Alternator",
      installedSeconds: engine.installedSeconds + 100 * HOUR,
    };
    s.management = [removed, broken, engine];
    const { rows } = section(s, "components");
    expect(rows.map((r) => r[0])).toEqual([
      "Alternator",
      "Engine",
      "Propeller",
    ]);
    expect(rows[1].slice(3, 10)).toEqual([
      engine.installedDate,
      "-",
      "110.0",
      "30.0",
      "-",
      "40",
      "time, cycles, calendar",
    ]);
    expect(rows[0].slice(5, 9)).toEqual([
      "Review",
      "Review",
      "Review",
      "Review",
    ]);
    expect(rows[2].slice(4, 9)).toEqual([
      "2026-02-01",
      "100.0",
      "20.0",
      "-",
      "Not tracked",
    ]);
  });

  it("lists component requirements with their limits and status", () => {
    const s = demoSnapshot();
    const engine = workOrderComponent();
    const requirement = requirementSchema.parse({
      uuid: "req",
      version: 0,
      kind: "componentRequirement",
      componentUuid: engine.uuid,
      aircraftUuid: engine.aircraftUuid,
      requirementType: "Overhaul Requirement",
      description: "Overhaul",
      notes: "",
      calendarIntervalUnit: "YEARS",
      calendarIntervalValue: 12,
      lastDate: "2020-01-01",
      intervalSeconds: 2000 * HOUR,
      dueSeconds: 2000 * HOUR,
      timeBasis: "TSN",
      timeLimitMode: "ABSOLUTE",
      cycleLimitMode: "ABSOLUTE",
      warningCalendarMonths: 1,
      warningSeconds: 0,
      warningCycles: 0,
    });
    s.management = [engine, requirement];
    const { rows } = section(s, "componentRequirements");
    expect(rows).toEqual([
      [
        "Engine S/N SN",
        "Overhaul Requirement",
        "Overhaul",
        "TSN",
        "2000.0 h\n12 years",
        "2020-01-01",
        "2032-01-31\n2000.0 h",
        "Tracked",
      ],
    ]);
  });

  it("lists every Form 337 copy, archived ones too, and plans their files", () => {
    const s = demoSnapshot();
    s.aircraftFiles = [
      form337(s, "new", "Repair.pdf", AT + DAY_MS),
      {
        ...form337(s, "old", "Repair.pdf", AT),
        archivedAt: AT + 2 * DAY_MS,
        archivedBy: { userId: s.user.id, name: "Alex Morgan" },
        archiveReason: "Superseded",
      },
      form337(s, "same", "Repair.pdf", AT + DAY_MS + 1),
      { ...form337(s, "other", "x.pdf", AT), aircraftUuid: s.aircraft[1].uuid },
    ];
    const pkg = build(s);
    const copies = pkg.sections.find((x) => x.id === "form337Copies")!;
    expect(copies.rows.map((r) => [r[0], r[3], r[4]])).toEqual([
      [
        "Repair.pdf",
        "Archived 2026-06-03 12:00 by Alex Morgan: Superseded",
        "form-337/archived/2026-06-01-Repair.pdf",
      ],
      ["Repair.pdf", "Current", "form-337/2026-06-02-Repair.pdf"],
      ["Repair.pdf", "Current", "form-337/2026-06-02-Repair (2).pdf"],
    ]);
    expect(copies.rows[1].slice(1, 3)).toEqual(["2026-06-02 12:00", "2 KB"]);
    expect(pkg.files.map((f) => [f.path, f.description])).toEqual([
      ["form-337/archived/2026-06-01-Repair.pdf", "Form 337 copy (archived)"],
      ["form-337/2026-06-02-Repair.pdf", "Form 337 copy"],
      ["form-337/2026-06-02-Repair (2).pdf", "Form 337 copy"],
    ]);
    expect(pkg.files[0].url).toBe("data:application/pdf;base64,old");
  });

  it("copies this aircraft's work-order attachments under files/", () => {
    const s = demoSnapshot();
    const order = completedOrder(s);
    const otherOrder = saveWorkOrder(
      s,
      {
        ...workOrderCommand(),
        fields: {
          ...workOrderCommand().fields,
          aircraftUuid: s.aircraft[1].uuid,
        },
      },
      AT,
    );
    s.workOrderAttachments = [
      {
        uuid: "b",
        workOrderUuid: order.uuid,
        name: "invoice:2.pdf",
        size: 10,
        uploadedAt: AT + DAY_MS,
        url: "https://files.test/b",
      },
      {
        uuid: "a",
        workOrderUuid: order.uuid,
        name: "photo.jpg",
        size: 20,
        uploadedAt: AT,
        url: "https://files.test/a",
      },
      {
        uuid: "c",
        workOrderUuid: otherOrder.uuid,
        name: "other.pdf",
        size: 30,
        uploadedAt: AT,
        url: "https://files.test/c",
      },
    ];
    expect(build(s).files).toEqual([
      {
        path: "files/2026-06-01-photo.jpg",
        url: "https://files.test/a",
        size: 20,
        description: `Work order ${order.number} attachment`,
      },
      {
        path: "files/2026-06-02-invoice_2.pdf",
        url: "https://files.test/b",
        size: 10,
        description: `Work order ${order.number} attachment`,
      },
    ]);
  });

  it("writes the change log oldest first with labels, names and notes", () => {
    const s = demoSnapshot();
    const entries: AuditEntry[] = [
      {
        uuid: "2",
        actorId: s.user.id,
        at: AT + 1000,
        action: "flight.reviewed",
        entityUuid: "f1",
        reason: "Looks right",
        before: '{"status":"review"}',
        after: '{"status":"accepted"}',
      },
      {
        uuid: "1",
        actorId: "ghost",
        at: AT,
        action: "flight.logged",
        entityUuid: "f1",
      },
    ];
    const complete = section(s, "changeLog", undefined);
    expect(complete.notes).toEqual([
      "0 entries; the change log is append-only.",
    ]);
    const full = buildRecordsPackage(s, s.aircraft[0].uuid, TODAY, {
      entries,
      complete: true,
    }).sections.at(-1)!;
    expect(full.rows).toEqual([
      ["2026-06-01 12:00", "Flight · logged", "ghost", "f1", "-", "-", "-"],
      [
        "2026-06-01 12:00",
        "Flight · reviewed",
        "Alex Morgan",
        "f1",
        "Looks right",
        '{"status":"review"}',
        '{"status":"accepted"}',
      ],
    ]);
    const partial = buildRecordsPackage(s, s.aircraft[0].uuid, TODAY, {
      entries,
      complete: false,
    }).sections.at(-1)!;
    expect(partial.notes[0]).toMatch(/^2 entries: only the recent changes/);
  });
});

describe("planPackageFiles", () => {
  const file = (path: string, size: number): PackageFile => ({
    path,
    url: path,
    size,
    description: "Form 337 copy",
  });

  it("takes files in order within the limit and skips those that would exceed it", () => {
    const plan = planPackageFiles(
      [
        file("a", 60 * MB),
        file("b", 60 * MB),
        file("c", 50 * MB),
        file("d", 30 * MB),
      ],
      150 * MB,
    );
    expect(plan.included.map((f) => f.path)).toEqual(["a", "b", "d"]);
    expect(plan.skipped).toEqual([
      { file: file("c", 50 * MB), reason: "Over the 150 MB package limit" },
    ]);
  });

  it("defaults to 150 MB", () => {
    expect(MAX_PACKAGE_FILE_BYTES).toBe(157_286_400);
    const plan = planPackageFiles([file("big", MAX_PACKAGE_FILE_BYTES + 1)]);
    expect(plan.skipped[0].reason).toBe("Over the 150 MB package limit");
  });
});

describe("recordsReadme and recordsPackageName", () => {
  it("names the package after the registration and the day", () => {
    expect(recordsPackageName("N206MA", "2026-06-15")).toBe(
      "N206MA-records-2026-06-15.zip",
    );
    expect(recordsPackageName("C-GABC/2", "2026-06-15")).toBe(
      "C-GABC_2-records-2026-06-15.zip",
    );
  });

  it("explains the package, counts rows and lists skipped files", () => {
    const s = demoSnapshot();
    s.flights = [flight(s, {})];
    const pkg = build(s);
    const text = recordsReadme(
      pkg,
      { at: "2026-06-15 09:30 UTC", by: "Alex Morgan" },
      [],
    );
    expect(text).toContain(
      "Aircraft: N206MA - Cessna 206 Stationair, S/N DEMO-demo-206\nFlight Program: Mission operations\nGenerated: 2026-06-15 09:30 UTC by Alex Morgan\n",
    );
    expect(text).toContain("14 CFR 91.417(c)");
    expect(text).toContain("signed entries in the aircraft's logbooks remain");
    expect(text).toContain("\nrecords.pdf - Every table below");
    expect(text).toContain("\nflights.csv - Flights (1 row).\n");
    expect(text).toContain("\nwork-orders.csv - Work orders (0 rows).\n");
    expect(text).toContain("\nform-337/ - Copies of FAA Form 337");
    expect(text).toContain("\nfiles/ - Attachments");
    expect(text).toMatch(/SKIPPED FILES\nNone\.\n$/);
    const skipped = recordsReadme(pkg, { at: "x", by: "y" }, [
      {
        file: {
          path: "files/a.pdf",
          url: "",
          size: 1,
          description: "Work order WO-1 attachment",
        },
        reason: "Could not be downloaded",
      },
    ]);
    expect(skipped).toMatch(
      /SKIPPED FILES\nfiles\/a\.pdf - Work order WO-1 attachment: Could not be downloaded\.\n$/,
    );
  });
});
