import { applyThroughWorkOrder } from "../../tests/fixtures/componentMovement";
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { applyManagement } from "./management";
import {
  serviceComponent,
  validateComponent,
  calendarDue,
  requirementDueDate,
  componentTotals,
  requirementStatus,
  moveRequirement,
  type Component,
  type ComponentRequirement,
} from "./components";
import { totalSeconds } from "./model";
const now = Date.parse("2026-09-29T12:00:00Z");
const common = () => ({
  requestUuid: crypto.randomUUID(),
  reason: "Verified against workshop records",
});
const base = (aircraftUuid = ""): Component => ({
  uuid: "component",
  version: 0,
  kind: "component",
  aircraftUuid,
  componentType: "Hydraulic pump",
  partNumber: "PN1",
  serial: "SN1",
  manufacturer: "Example",
  notes: "Verified records",
  trackTime: true,
  trackCycles: true,
  trackCalendar: true,
  installed: false,
  partsLocation: "Shelf A",
  installedSeconds: 0,
  installedCycles: 0,
  timeSinceNew: 100 * 3600,
  timeSinceOverhaul: null,
  timeSinceRepair: 10 * 3600,
  cyclesSinceNew: 25,
  serviceDaysBase: 30,
});
const requirement = (aircraftUuid = ""): ComponentRequirement => ({
  uuid: "requirement",
  version: 0,
  kind: "componentRequirement",
  componentUuid: "component",
  aircraftUuid,
  requirementType: "Inspection Requirement",
  description: "Inspect pump",
  notes: "",
  intervalSeconds: 20 * 3600,
  timeBasis: "TSR",
  timeLimitMode: "FROM_LAST_COMPLIED",
  lastSeconds: 5 * 3600,
  intervalCycles: 100,
  cycleLimitMode: "ABSOLUTE",
  lastDate: "2026-01-31",
  calendarIntervalValue: 1,
  calendarIntervalUnit: "MONTHS",
  warningCalendarMonths: 1,
  warningSeconds: 5 * 3600,
  warningCycles: 10,
});
describe("legacy component behavior", () => {
  it("preserves explicit dates without a recurring calendar interval", () => {
    const r = {
      ...requirement(),
      calendarIntervalValue: undefined,
      dueDate: "2026-12-12",
    };
    expect(requirementDueDate(r)).toBe("2026-12-12");
    expect(requirementDueDate({ ...r, dueDate: undefined })).toBeUndefined();
  });
  it.each(["MONTHS", "YEARS"] as const)(
    "flags recurring %s requirements in the correct due month",
    (unit) => {
      const r = {
        ...requirement(),
        intervalSeconds: undefined,
        intervalCycles: undefined,
        lastDate: "2025-12-12",
        calendarIntervalValue: unit === "MONTHS" ? 12 : 1,
        calendarIntervalUnit: unit,
        dueDate: "2027-01-31",
      };
      expect(calendarDue(r.lastDate, r.calendarIntervalValue, unit)).toBe(
        "2026-12-31",
      );
      expect(requirementDueDate(r)).toBe("2026-12-31");
      expect(requirementStatus(r, base(), undefined, "2026-12-01").status).toBe(
        "Due soon",
      );
      expect(requirementStatus(r, base(), undefined, "2026-12-31").days).toBe(
        0,
      );
      expect(requirementStatus(r, base(), undefined, "2027-01-01").status).toBe(
        "Past due",
      );
    },
  );

  it("calculates historical installation usage, nullable overhaul/repair readings and installed service days", () => {
    const s = demoSnapshot(),
      a = s.aircraft[0];
    const c = {
      ...base(a.uuid),
      installed: true,
      installedDate: "2026-09-19",
      installPosition: "LEFT" as const,
      installedSeconds: totalSeconds(a) - 10 * 3600,
      installedCycles: a.cycles - 4,
    };
    validateComponent(s, c, undefined, now);
    expect(componentTotals(c, a, "2026-09-29")).toMatchObject({
      timeSinceNew: 110 * 3600,
      timeSinceOverhaul: null,
      timeSinceRepair: 20 * 3600,
      cyclesSinceNew: 29,
      serviceDays: 40,
    });
    const calendarOnly = { ...c, trackTime: false, trackCycles: false };
    expect(componentTotals(calendarOnly, a, "2026-09-29")).toMatchObject({
      timeSinceNew: 100 * 3600,
      cyclesSinceNew: 25,
      serviceDays: 40,
    });
  });

  it("treats an installation dated one day ahead as time-zone skew, not a reading before the baseline", () => {
    const s = demoSnapshot(),
      a = s.aircraft[0];
    const c = {
      ...base(a.uuid),
      installed: true,
      installedSeconds: totalSeconds(a),
      installedCycles: a.cycles,
      trackTime: false,
      trackCycles: false,
    };
    // A device east of UTC stamps tomorrow's UTC date; the server's today lags.
    expect(
      componentTotals({ ...c, installedDate: "2026-09-30" }, a, "2026-09-29")
        .serviceDays,
    ).toBe(30);
    expect(() =>
      componentTotals({ ...c, installedDate: "2026-10-01" }, a, "2026-09-29"),
    ).toThrow("precede the installation baseline");
  });
  it("freezes usage in inventory, resumes on another aircraft and carries schedules with the component", () => {
    const s = demoSnapshot(),
      a = s.aircraft[0],
      b = s.aircraft[1];
    applyThroughWorkOrder(
      s,
      { ...common(), action: "record.save", record: base(a.uuid) },
      now,
    );
    applyThroughWorkOrder(
      s,
      { ...common(), action: "record.save", record: requirement(a.uuid) },
      now,
    );
    s.inspections.push({
      uuid: "linked",
      aircraftUuid: a.uuid,
      componentUuid: "component",
      reference: "Check",
      description: "Check",
      dueSeconds: 200 * 3600,
    });
    applyThroughWorkOrder(
      s,
      {
        ...common(),
        action: "component.service",
        uuid: "component",
        version: 1,
        date: "2026-09-29",
        operation: "install",
        aircraftUuid: a.uuid,
        installPosition: "LEFT",
      },
      now,
    );
    a.currentHobbs += 7200;
    a.cycles += 2;
    applyThroughWorkOrder(
      s,
      {
        ...common(),
        action: "component.service",
        uuid: "component",
        version: 2,
        date: "2026-09-29",
        operation: "remove",
        partsLocation: "Bin 2",
      },
      now,
    );
    const stored = s.management!.find(
      (r): r is Component => r.kind === "component",
    )!;
    expect(componentTotals(stored, undefined, "2027-01-01")).toMatchObject({
      timeSinceNew: 102 * 3600,
      cyclesSinceNew: 27,
      serviceDays: 30,
    });
    const due = s.management!.find(
      (r): r is ComponentRequirement => r.kind === "componentRequirement",
    )!;
    expect(requirementStatus(due, stored, undefined, "2027-01-01").status).toBe(
      "Past due",
    );
    applyThroughWorkOrder(
      s,
      {
        ...common(),
        action: "component.service",
        uuid: "component",
        version: 3,
        date: "2026-09-29",
        operation: "install",
        aircraftUuid: b.uuid,
        installPosition: "RIGHT",
      },
      now,
    );
    const installed = s.management!.find(
      (r): r is Component => r.kind === "component",
    )!;
    expect(componentTotals(installed, b, "2026-09-29").timeSinceNew).toBe(
      102 * 3600,
    );
    expect(
      s.management!.find((r) => r.kind === "componentRequirement"),
    ).toMatchObject({
      aircraftUuid: b.uuid,
      version: 2,
      dueSeconds: 25 * 3600,
      dueDate: "2026-02-28",
    });
    expect(s.inspections.find((i) => i.uuid === "linked")?.aircraftUuid).toBe(
      b.uuid,
    );
    expect(
      s.management!.filter((r) => r.kind === "componentMovement"),
    ).toHaveLength(3);
  });
  it("calculates absolute and relative TSN/TSO/TSR limits and calendar warnings", () => {
    const s = demoSnapshot();
    applyThroughWorkOrder(
      s,
      { ...common(), action: "record.save", record: base() },
      now,
    );
    const c = s.management![0] as Component;
    applyThroughWorkOrder(
      s,
      { ...common(), action: "record.save", record: requirement() },
      now,
    );
    const r = s.management!.find(
      (r): r is ComponentRequirement => r.kind === "componentRequirement",
    )!;
    expect(r).toMatchObject({
      dueSeconds: 25 * 3600,
      dueCycles: 100,
      dueDate: "2026-02-28",
    });
    expect(
      requirementStatus(
        { ...r, calendarIntervalValue: undefined, dueDate: undefined },
        c,
        undefined,
        "2026-09-29",
      ),
    ).toMatchObject({ seconds: 15 * 3600, cycles: 75, status: "Tracked" });
    expect(
      requirementStatus(
        {
          ...r,
          calendarIntervalValue: undefined,
          dueDate: undefined,
          dueSeconds: 10 * 3600,
        },
        c,
        undefined,
        "2026-09-29",
      ).status,
    ).toBe("Due now");
    expect(
      requirementStatus(
        {
          ...r,
          calendarIntervalValue: undefined,
          dueDate: undefined,
          dueSeconds: 12 * 3600,
        },
        c,
        undefined,
        "2026-09-29",
      ).status,
    ).toBe("Due soon");
    expect(() =>
      applyThroughWorkOrder(
        s,
        {
          ...common(),
          action: "record.save",
          record: { ...requirement(), uuid: "tso", timeBasis: "TSO" },
        },
        now,
      ),
    ).toThrow("verified TSO baseline");
    expect(calendarDue("2024-02-29", 1, "YEARS")).toBe("2025-02-28");
    expect(calendarDue("2026-01-15", 1, "MONTHS")).toBe("2026-02-28");
    expect(calendarDue("2024-01-15", 1, "MONTHS")).toBe("2024-02-29");
    expect(calendarDue("2026-12-10", 2, "MONTHS")).toBe("2027-02-28");
    expect(calendarDue("2026-04-10", 1, "YEARS")).toBe("2027-04-30");
    expect(calendarDue("2026-01-31", 2, "DAYS")).toBe("2026-02-02");
  });
  it("rejects invalid baselines, no tracking, dimension removal in use, and stale movement versions", () => {
    const s = demoSnapshot(),
      a = s.aircraft[0];
    expect(() =>
      applyThroughWorkOrder(
        s,
        {
          ...common(),
          action: "record.save",
          record: {
            ...base(),
            trackCalendar: false,
            trackCycles: false,
            trackTime: false,
          },
        },
        now,
      ),
    ).toThrow("tracking dimension");
    expect(() =>
      applyThroughWorkOrder(
        s,
        {
          ...common(),
          action: "record.save",
          record: {
            ...base(a.uuid),
            installed: true,
            installPosition: "MAIN",
            installedDate: "2026-09-01",
            installedSeconds: totalSeconds(a) + 3600,
          },
        },
        now,
      ),
    ).toThrow("through a work order");
    applyThroughWorkOrder(
      s,
      { ...common(), action: "record.save", record: base() },
      now,
    );
    applyThroughWorkOrder(
      s,
      { ...common(), action: "record.save", record: requirement() },
      now,
    );
    const c = s.management!.find(
      (r): r is Component => r.kind === "component",
    )!;
    expect(() =>
      applyThroughWorkOrder(
        s,
        {
          ...common(),
          action: "record.save",
          record: { ...c, trackTime: false },
        },
        now,
      ),
    ).toThrow("requirement still uses");
    expect(() =>
      applyThroughWorkOrder(
        s,
        {
          ...common(),
          action: "component.service",
          uuid: c.uuid,
          version: 0,
          date: "2026-09-29",
          operation: "repair",
        },
        now,
      ),
    ).toThrow("changed");
    expect(() =>
      applyThroughWorkOrder(
        s,
        {
          ...common(),
          action: "component.service",
          uuid: c.uuid,
          version: 1,
          date: "2026-09-28",
          operation: "repair",
        },
        now,
      ),
    ).toThrow("today");
  });
  it("requires both source and destination maintenance permission when installing elsewhere", () => {
    const s = demoSnapshot(),
      a = s.aircraft[0];
    applyThroughWorkOrder(
      s,
      { ...common(), action: "record.save", record: base(a.uuid) },
      now,
    );
    s.user = { ...s.user, isAdmin: false, groupIds: ["mechanic"] };
    s.groups = [
      {
        id: "mechanic",
        name: "Mechanic",
        programUuid: "demo-program",
        aircraftIds: [a.uuid],
        permissions: ["read", "maintenance"],
      },
    ];
    expect(() =>
      applyThroughWorkOrder(
        s,
        {
          ...common(),
          action: "component.service",
          uuid: "component",
          version: 1,
          date: "2026-09-29",
          operation: "install",
          aircraftUuid: s.aircraft[1].uuid,
          installPosition: "MAIN",
        },
        now,
      ),
    ).toThrow("maintenance access denied");
  });
});

it("tracks collective usage independently from airframe hours and fails if its meter is unavailable", () => {
  const a = {
    ...demoSnapshot().aircraft[0],
    helicopter: true,
    currentCyclicHobbs: 1432.5 * 3600,
  };
  const c: Component = {
    ...base(a.uuid),
    installed: true,
    installedDate: "2026-09-01",
    trackCycles: false,
    usageMeter: "collective",
    installedSeconds: 1000 * 3600,
  };
  const before = componentTotals(c, a);
  expect(before.timeSinceNew).toBe(532.5 * 3600);
  expect(
    componentTotals(c, { ...a, currentHobbs: a.currentHobbs + 3600 })
      .timeSinceNew,
  ).toBe(before.timeSinceNew);
  expect(
    componentTotals(c, {
      ...a,
      currentCyclicHobbs: a.currentCyclicHobbs + 7200,
    }).timeSinceNew,
  ).toBe(before.timeSinceNew + 7200);
  expect(() =>
    componentTotals(c, { ...a, currentCyclicHobbs: undefined }),
  ).toThrow("Collective");
});

it("uses collective time for inspection status without changing aircraft total time", async () => {
  const { inspectionCounters } = await import("./management");
  const { inspectionStatus } = await import("./maintenance");
  const a = {
    ...demoSnapshot().aircraft[0],
    helicopter: true,
    currentCyclicHobbs: 1400 * 3600,
  };
  const i = {
    uuid: "i",
    aircraftUuid: a.uuid,
    reference: "100h",
    description: "",
    usageMeter: "collective" as const,
    dueSeconds: 1500 * 3600,
  };
  expect(inspectionCounters(i, a).seconds).toBe(1400 * 3600);
  expect(inspectionStatus(i, a).hoursRemaining).toBe(100);
});

it("preserves collective component life when removed and installed through work orders", () => {
  const s = demoSnapshot();
  const a = s.aircraft[0];
  a.helicopter = true;
  a.currentCyclicHobbs = 500 * 3600;
  const c: Component = {
    ...base(a.uuid),
    version: 1,
    installed: true,
    installedDate: "2026-09-01",
    installPosition: "MAIN",
    trackCycles: false,
    usageMeter: "collective",
    installedSeconds: 490 * 3600,
  };
  s.management = [c];
  applyThroughWorkOrder(
    s,
    {
      ...common(),
      action: "component.service",
      uuid: c.uuid,
      version: 1,
      date: "2026-09-29",
      operation: "remove",
      partsLocation: "Shelf",
    },
    now,
  );
  const stored = s.management!.find(
    (r): r is Component => r.kind === "component",
  )!;
  expect(stored.timeSinceNew).toBe(110 * 3600);
  a.currentCyclicHobbs += 100 * 3600;
  applyThroughWorkOrder(
    s,
    {
      ...common(),
      action: "component.service",
      uuid: c.uuid,
      version: stored.version,
      date: "2026-09-29",
      operation: "install",
      aircraftUuid: a.uuid,
      installPosition: "MAIN",
    },
    now,
  );
  const installed = s.management!.find(
    (r): r is Component => r.kind === "component",
  )!;
  expect(installed.installedSeconds).toBe(600 * 3600);
  expect(componentTotals(installed, a, "2026-09-29").timeSinceNew).toBe(
    110 * 3600,
  );
});

it("keeps calendar overhaul age through movements and resets it only on overhaul", () => {
  const s = demoSnapshot(),
    a = s.aircraft[0];
  const c: Component = {
    ...base(a.uuid),
    installed: true,
    installedDate: "2026-09-19",
    calendarOverhaulDaysBase: 20,
    installedSeconds: totalSeconds(a),
    installedCycles: a.cycles,
  };
  expect(componentTotals(c, a, "2026-09-29").calendarOverhaulDays).toBe(30);
  const removed = serviceComponent(
    s,
    c,
    { operation: "remove", date: "2026-09-29", partsLocation: "Shelf A" },
    now,
  );
  expect(componentTotals(removed, a, "2026-10-29").calendarOverhaulDays).toBe(
    30,
  );
  const repaired = serviceComponent(
    s,
    removed,
    { operation: "repair", date: "2026-09-29" },
    now,
  );
  expect(repaired.calendarOverhaulDaysBase).toBe(30);
  const overhauled = serviceComponent(
    s,
    removed,
    { operation: "overhaul", date: "2026-09-29" },
    now,
  );
  expect(overhauled.calendarOverhaulDaysBase).toBe(0);
  expect(overhauled.serviceDaysBase).toBe(40);
  expect(
    componentTotals(base(), undefined, "2026-09-29").calendarOverhaulDays,
  ).toBeNull();
  expect(
    componentTotals({ ...c, trackCalendar: false }, a, "2026-09-29")
      .calendarOverhaulDays,
  ).toBe(20);
});
it("reports a computable overdue limit before a missing landing or time baseline", () => {
  const c = base();
  const r: ComponentRequirement = {
    ...requirement(),
    lastDate: undefined,
    calendarIntervalValue: undefined,
    dueLandings: 600,
  };
  const status = (patch: Partial<ComponentRequirement>) =>
    requirementStatus({ ...r, ...patch }, c, undefined, "2026-09-29").status;
  // The component has 25 cycles; inventory components cannot count landings.
  expect(status({ dueCycles: 20 })).toBe("Past due");
  expect(status({ dueCycles: 25 })).toBe("Due now");
  expect(status({ dueCycles: 500 })).toBe("Set landing baseline");
  expect(
    status({
      dueLandings: undefined,
      timeBasis: "TSO",
      dueSeconds: 3600,
      dueCycles: 20,
    }),
  ).toBe("Past due");
});
it("keeps landing limits tied to the aircraft they were counted on when a component moves", () => {
  const legacy = { ...requirement("old"), dueLandings: 500 };
  expect(moveRequirement(legacy, "new")).toMatchObject({
    aircraftUuid: "new",
    version: 1,
    landingReferenceAircraftUuid: "old",
  });
  expect(
    moveRequirement({ ...legacy, landingReferenceAircraftUuid: "first" }, "new")
      .landingReferenceAircraftUuid,
  ).toBe("first");
  expect(
    moveRequirement(requirement("old"), "new").landingReferenceAircraftUuid,
  ).toBeUndefined();
});
it("re-bases TSO requirements and renews overhaul limits when overhaul is recorded outside a work order", () => {
  const s = demoSnapshot();
  applyManagement(
    s,
    {
      ...common(),
      action: "record.save",
      record: { ...base(), timeSinceOverhaul: 50 * 3600 },
    },
    now,
  );
  const tso = {
    ...requirement(),
    timeBasis: "TSO" as const,
    intervalCycles: undefined,
    calendarIntervalValue: undefined,
    lastDate: undefined,
  };
  for (const record of [
    {
      ...tso,
      uuid: "inspect",
      intervalSeconds: 100 * 3600,
      lastSeconds: 20 * 3600,
    },
    {
      ...tso,
      uuid: "overhaul",
      requirementType: "Overhaul Requirement" as const,
      intervalSeconds: 200 * 3600,
      timeLimitMode: "ABSOLUTE" as const,
      lastSeconds: undefined,
    },
  ])
    applyManagement(s, { ...common(), action: "record.save", record }, now);
  applyManagement(
    s,
    {
      ...common(),
      action: "component.service",
      uuid: "component",
      version: 1,
      date: "2026-09-29",
      operation: "overhaul",
    },
    now,
  );
  const find = (uuid: string) =>
    s.management!.find(
      (r): r is ComponentRequirement =>
        r.kind === "componentRequirement" && r.uuid === uuid,
    )!;
  // 120 h due on the old TSO counter at 50 h leaves 70 h after the reset.
  expect(find("inspect")).toMatchObject({
    timeResetSeconds: 50 * 3600,
    lastSeconds: -30 * 3600,
    dueSeconds: 70 * 3600,
  });
  expect(find("overhaul")).toMatchObject({
    lastDate: "2026-09-29",
    lastSeconds: 0,
    dueSeconds: 200 * 3600,
  });
});
it("accepts any time zone's local today for current-reading service dates", () => {
  const s = demoSnapshot();
  const c = { ...base(), timeSinceOverhaul: 50 * 3600 };
  // now is 2026-09-29T12:00Z: local today is 09-29 or 09-30 somewhere.
  for (const date of ["2026-09-29", "2026-09-30"])
    expect(
      serviceComponent(s, c, { operation: "repair", date }, now)
        .timeSinceRepair,
    ).toBe(0);
  expect(() =>
    serviceComponent(s, c, { operation: "repair", date: "2026-10-01" }, now),
  ).toThrow("today");
});
