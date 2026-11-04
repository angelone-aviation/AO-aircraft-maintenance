/**
 * Responsibility: Pins work-order close-out: compliance, readings at
 *   completion, component data, every refusal in order, and the logbook
 *   wording it freezes.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/workOrderCloseout.ts, ./workOrders, ./logbook,
 *   ./components, ./rejection; tests/fixtures (work orders, task cards);
 *   src/data/demo.ts (seed).
 */
import { it, expect } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  workOrderCommand,
  workOrderComponent,
} from "../../tests/fixtures/workOrders";
import {
  newWorkTask,
  saveWorkOrder,
  workOrderFieldsSchema,
  type WorkOrder,
  type WorkOrderCommand,
} from "./workOrders";
import { totalSeconds } from "./model";
import {
  logbookText,
  inspectionEntryReady,
  emptyInspectionEntry,
} from "./logbook";
import { componentTotals, type ComponentRequirement } from "./components";
import { completeWorkOrder, workPerformedText } from "./workOrderCloseout";
import type { CompletionReadings } from "./workOrderCloseoutSchema";
import { taskCardCommand } from "../../tests/fixtures/taskCards";
import { Rejection } from "./rejection";
const now = Date.parse("2026-10-02T12:00:00Z");
function setup() {
  const s = demoSnapshot();
  const i = s.inspections[0];
  Object.assign(i, {
    intervalSeconds: 100 * 3600,
    intervalCycles: 50,
    intervalMonths: 12,
    lastDate: "2025-10-01",
    lastSeconds: 1,
    lastCycles: 1,
  });
  const cmd = workOrderCommand();
  cmd.tasks = [
    newWorkTask({ kind: "inspection", uuid: i.uuid }, i.description),
  ];
  return { s, cmd, i };
}
function close(
  order: WorkOrder,
): Extract<WorkOrderCommand, { action: "save" }> {
  return {
    action: "save" as const,
    uuid: order.uuid,
    version: order.version,
    componentUuids: order.componentReadings.map((c) => c.componentUuid),
    fields: {
      ...workOrderFieldsSchema.parse(order),
      status: "completed" as const,
      completionDate: "2026-10-02",
      releaseOutcome: "Work reviewed; disposition recorded by certifier.",
      finalReview: "Reviewed",
    },
    tasks: order.tasks.map((t) => ({ ...t, status: "completed" as const })),
  };
}
it("atomically updates routine compliance and retains completion readings and identity after later changes", () => {
  const { s, cmd, i } = setup();
  s.user.licenseNumber = "12345";
  s.user.certificateType = "A&P";
  const order = saveWorkOrder(s, cmd, now);
  s.aircraft[0].currentHobbs += 3600;
  s.aircraft[0].cycles += 2;
  const final = saveWorkOrder(s, close(order), now);
  const updated = s.inspections.find((r) => r.uuid === i.uuid)!;
  expect(updated.lastSeconds).toBe(totalSeconds(s.aircraft[0]));
  expect(updated.dueSeconds).toBe(updated.lastSeconds! + 100 * 3600);
  expect(updated.dueCycles).toBe(s.aircraft[0].cycles + 50);
  expect(updated.dueDate).toBe("2027-10-31");
  expect(updated.archived).toBe(false);
  expect(final.aircraft.totalSeconds).not.toBe(
    final.closeout!.aircraft.totalSeconds,
  );
  expect(final.closeout!.completedBy.licenseNumber).toBe("12345");
  const snapshot = structuredClone(s);
  expect(() => saveWorkOrder(s, close(final), now)).toThrow("closed");
  expect(s).toEqual(snapshot);
  const text = logbookText(s, final, "maintenance", {
    name: s.user.name,
    licenseNumber: "12345",
    certificateType: "A&P",
  });
  s.aircraft[0].currentHobbs += 90000;
  s.aircraft[0].registration = "CHANGED";
  expect(
    logbookText(s, final, "maintenance", {
      name: s.user.name,
      licenseNumber: "12345",
      certificateType: "A&P",
    }),
  ).toBe(text);
  expect(text).toContain("Signature: __________________");
  expect(text).not.toContain("Approved for return to service");
});
it("skips cancelled items and rolls back all compliance updates on a later failure", () => {
  const { s, cmd, i } = setup();
  cmd.tasks.push(
    newWorkTask({ kind: "inspection", uuid: s.inspections[1].uuid }, "Annual"),
  );
  const order = saveWorkOrder(s, cmd, now);
  s.inspections[1].archived = true;
  const snapshot = structuredClone(s);
  expect(() => saveWorkOrder(s, close(order), now)).toThrow("archived");
  expect(s).toEqual(snapshot);
  const command = close(order);
  command.tasks = command.tasks.map((t, n) =>
    n === 1 ? { ...t, status: "cancelled" } : t,
  );
  const final = saveWorkOrder(s, command, now);
  expect(final.closeout!.compliance.map((r) => r.uuid)).toEqual([i.uuid]);
  expect(
    s.inspections.find((r) => r.uuid === snapshot.inspections[1].uuid),
  ).toEqual(snapshot.inspections[1]);
});
it.each([false, true])(
  "captures tracked component data and restarts relative service intervals without resetting lifetime counters (removed: %s)",
  (removed) => {
    const { s, cmd } = setup();
    const c = workOrderComponent();
    c.programUuid = s.aircraft[0].programUuid;
    const req: ComponentRequirement = {
      uuid: "service",
      version: 1,
      programUuid: c.programUuid,
      kind: "componentRequirement",
      aircraftUuid: c.aircraftUuid,
      componentUuid: c.uuid,
      requirementType: "Inspection Requirement",
      description: "Engine recurring inspection",
      notes: "",
      calendarIntervalUnit: "MONTHS",
      calendarIntervalValue: 6,
      timeBasis: "TSN",
      timeLimitMode: "FROM_LAST_COMPLIED",
      intervalSeconds: 10 * 3600,
      cycleLimitMode: "FROM_LAST_COMPLIED",
      intervalCycles: 10,
      lastSeconds: 0,
      lastCycles: 0,
      lastDate: "2026-01-01",
      warningCalendarMonths: 1,
      warningSeconds: 0,
      warningCycles: 0,
    };
    const life = {
      ...req,
      uuid: "life",
      requirementType: "Life Limits" as const,
      timeLimitMode: "ABSOLUTE" as const,
      dueSeconds: 500 * 3600,
    };
    s.management = [c, req, life];
    cmd.tasks = [
      newWorkTask(
        { kind: "componentRequirement", uuid: req.uuid },
        req.description,
      ),
      newWorkTask(
        { kind: "componentRequirement", uuid: life.uuid },
        "Life limit check",
      ),
    ];
    const order = saveWorkOrder(s, cmd, now);
    if (removed) {
      const stored = componentTotals(c, s.aircraft[0], "2026-10-02");
      Object.assign(c, {
        installed: false,
        removedDate: "2026-10-02",
        partsLocation: "Service bench",
        timeSinceNew: stored.timeSinceNew,
        timeSinceOverhaul: stored.timeSinceOverhaul,
        timeSinceRepair: stored.timeSinceRepair,
        cyclesSinceNew: stored.cyclesSinceNew,
        serviceDaysBase: stored.serviceDays,
      });
    }

    const totals = componentTotals(c, s.aircraft[0], "2026-10-02");
    const final = saveWorkOrder(
      s,
      {
        ...close(order),
        componentWork: [
          {
            componentUuid: c.uuid,
            version: c.version,
            action: "service",
            description: "",
            reference: "",
          },
        ],
      },
      now,
    );
    expect(final.closeout!.components[0]).toMatchObject({
      serial: "SN",
      partNumber: "PN",
      timeSinceNew: totals.timeSinceNew,
      cyclesSinceNew: totals.cyclesSinceNew,
    });
    expect(s.management.find((r) => r.uuid === c.uuid)).toEqual(c);
    expect(s.management.find((r) => r.uuid === life.uuid)).toEqual(life);
    expect(s.management.find((r) => r.uuid === req.uuid)).toMatchObject({
      lastSeconds: totals.timeSinceNew,
      dueSeconds: totals.timeSinceNew + 10 * 3600,
      dueCycles: totals.cyclesSinceNew + 10,
      dueDate: "2027-04-30",
    });
    expect(
      logbookText(s, final, "component", {
        name: "Alex",
        licenseNumber: "123",
        certificateType: "A&P",
      }),
    ).toContain("P/N PN; S/N SN");
  },
);
it("requires explicit readings for backdated closeout and rejects invalid readings without mutation", () => {
  const { s, cmd } = setup();
  const order = saveWorkOrder(s, cmd, now);
  const command = close(order);
  command.fields.completionDate = "2026-10-01";
  const snapshot = structuredClone(s);
  expect(() => saveWorkOrder(s, command, now)).toThrow("backdated");
  expect(s).toEqual(snapshot);
  expect(() =>
    saveWorkOrder(
      s,
      {
        ...command,
        completionReadings: { totalSeconds: 0, hobbs: 0, tach: 0, cycles: 0 },
      },
      now,
    ),
  ).toThrow("Completion readings");
  expect(s).toEqual(snapshot);
  const final = saveWorkOrder(
    s,
    {
      ...command,
      completionReadings: {
        totalSeconds: order.aircraft.totalSeconds,
        hobbs: order.aircraft.hobbs,
        tach: order.aircraft.tach,
        cycles: order.aircraft.cycles,
      },
    },
    now,
  );
  expect(final.closeout!.compliance[0].date).toBe("2026-10-01");
});

it.each(["annual", "100-hour"] as const)(
  "renders the %s inspection template only with an explicit airworthy finding",
  (type) => {
    const { s, cmd } = setup();
    const order = saveWorkOrder(s, cmd, now);
    const final = saveWorkOrder(s, close(order), now);
    const signer = {
      name: "José",
      licenseNumber: "12345",
      certificateType: "A&P IA",
    };
    const draft = logbookText(s, final, "inspection", signer);
    expect(draft).not.toContain("was determined to be in airworthy condition");
    expect(inspectionEntryReady(emptyInspectionEntry)).toBe(false);
    const options = {
      type,
      checklist: "Cessna checklist Rev 12",
      reviewedThrough: "Issue 26-20",
      airworthy: true,
    };
    expect(inspectionEntryReady(options)).toBe(true);
    expect(inspectionEntryReady({ ...options, checklist: " " })).toBe(false);
    expect(inspectionEntryReady({ ...options, reviewedThrough: " " })).toBe(
      false,
    );
    const text = logbookText(s, final, "inspection", signer, options);
    expect(text).toContain("Date: 10/02/2026");
    expect(text).toContain(
      `Aircraft Total Time: ${(final.closeout!.aircraft.totalSeconds / 3600).toFixed(1)} Hours`,
    );
    expect(text).toContain(
      "14 CFR Part 43, Appendix D, and Cessna checklist Rev 12",
    );
    expect(text).toContain(
      "Service Bulletins and Airworthiness Directives checked through Issue 26-20.",
    );
    expect(text).toContain(
      `${type} inspection and was determined to be in airworthy condition.`,
    );
    expect(text).toContain("Certificate / license: A&P IA 12345");
    expect(text).toContain("Signature: __________________");
  },
);

it("uses the supplied component release wording only after an explicit outcome", () => {
  const { s, cmd } = setup();
  const final = saveWorkOrder(s, close(saveWorkOrder(s, cmd, now)), now);
  const signer = {
    name: "José Mechanic",
    licenseNumber: "12345",
    certificateType: "A&P",
  };
  const draft = logbookText(s, final, "component", signer);
  expect(draft).not.toContain("The aircraft is approved for return to service");
  const entry = logbookText(s, final, "component", signer, undefined, {
    approvedForReturnToService: true,
  });
  expect(entry).toContain("Date: 10/02/2026");
  expect(entry).toContain(
    `Aircraft Total Time: ${(final.closeout!.aircraft.totalSeconds / 3600).toFixed(1)} Hours`,
  );
  expect(entry).toContain(final.closeout!.workPerformed);
  expect(entry).toContain(
    "The work performed on the aircraft component part identified above has been performed satisfactorily. The aircraft is approved for return to service only for the work performed.",
  );
  expect(entry).toContain("Name: José Mechanic");
  expect(entry).toContain("Certificate / license: A&P 12345");
  expect(entry).toContain("Signature: __________________");
  expect(entry).not.toContain("was determined to be in airworthy condition");
});

it("formats selected tasks with their original numbers, wording, description and reference, and freezes the result", () => {
  const s = demoSnapshot();
  const cmd = workOrderCommand();
  cmd.tasks = ["Excluded", "Fuel pump", "Cabin fittings"].map((description) =>
    newWorkTask({ kind: "manual", uuid: crypto.randomUUID() }, description),
  );
  cmd.tasks[1] = {
    ...cmd.tasks[1],
    includeInLogbook: true,
    logbookPhrase: "Installed",
    maintenanceReference: "AMM 28-20",
  };
  cmd.tasks[2] = {
    ...cmd.tasks[2],
    includeInLogbook: true,
    logbookPhrase: "Inspected",
    maintenanceReference: "  ",
  };
  const order = saveWorkOrder(s, cmd, now);
  const final = saveWorkOrder(s, close(order), now);
  expect(final.closeout!.workPerformed).toBe(
    "Task #2 Fuel pump: installed IAW AMM 28-20\n\nTask #3 Cabin fittings: inspected IAW Standard Practice found in AC43.13",
  );
  s.user.logbookPhrases = ["Changed later"];
  expect(
    logbookText(s, final, "maintenance", {
      name: "Test",
      licenseNumber: "123",
      certificateType: "A&P",
    }),
  ).toContain(final.closeout!.workPerformed);
});

it.each([undefined, "", "  "])(
  "uses standard practice for inspection tasks with blank manual reference (%s)",
  (maintenanceReference) => {
    const { s, cmd, i } = setup();
    i.reference = "test inspection";
    i.description = "test inspection 15 hr & 1 month";
    cmd.tasks[0] = {
      ...cmd.tasks[0],
      description: "test inspection: test inspection 15 hr & 1 month",
      includeInLogbook: true,
      maintenanceReference,
    };
    const order = saveWorkOrder(s, cmd, now);
    const expected =
      "Task #1 test inspection: test inspection 15 hr & 1 month: performed IAW Standard Practice found in AC43.13";
    const signer = {
      name: "Test",
      licenseNumber: "123",
      certificateType: "A&P",
    };
    expect(
      logbookText(s, order, "maintenance", signer, undefined, undefined, true),
    ).toContain(expected);
    const final = saveWorkOrder(s, close(order), now);
    expect(final.closeout!.workPerformed).toBe(expected);
    expect(logbookText(s, final, "maintenance", signer)).toContain(expected);
  },
);

/**
 * An open order on the first inspection, plus an engine with a recurring
 * inspection requirement; `closing` is that order completed today with every
 * item completed.
 */
function closeoutWorld() {
  const { s, cmd } = setup();
  const a = s.aircraft[0];
  const engine = { ...workOrderComponent(), programUuid: a.programUuid };
  const requirement: ComponentRequirement = {
    uuid: "service",
    version: 1,
    programUuid: a.programUuid,
    kind: "componentRequirement",
    aircraftUuid: a.uuid,
    componentUuid: engine.uuid,
    requirementType: "Inspection Requirement",
    description: "Engine recurring inspection",
    notes: "",
    calendarIntervalUnit: "MONTHS",
    calendarIntervalValue: 6,
    timeBasis: "TSN",
    timeLimitMode: "FROM_LAST_COMPLIED",
    intervalSeconds: 10 * 3600,
    cycleLimitMode: "FROM_LAST_COMPLIED",
    lastSeconds: 0,
    lastCycles: 0,
    lastDate: "2026-01-01",
    warningCalendarMonths: 1,
    warningSeconds: 0,
    warningCycles: 0,
  };
  s.management = [engine, requirement];
  cmd.tasks.push(
    newWorkTask(
      { kind: "componentRequirement", uuid: requirement.uuid },
      requirement.description,
    ),
  );
  const order = saveWorkOrder(s, cmd, now);
  const closing: WorkOrder = {
    ...order,
    status: "completed",
    completionDate: "2026-10-02",
    tasks: order.tasks.map((t) => ({ ...t, status: "completed" })),
  };
  const opening = {
    totalSeconds: order.aircraft.totalSeconds,
    hobbs: order.aircraft.hobbs,
    tach: order.aircraft.tach,
    cycles: order.aircraft.cycles,
  };
  return { s, a, engine, requirement, order: closing, opening };
}
type CloseoutWorld = ReturnType<typeof closeoutWorld>;
type Attempt = { order?: WorkOrder; supplied?: CompletionReadings };

// Each refusal, triggered alone; completeWorkOrder checks them in this order.
const closeoutRefusals: [string, (w: CloseoutWorld) => Attempt][] = [
  [
    "Enter aircraft readings at completion for a backdated work order.",
    (w) => ({ order: { ...w.order, completionDate: "2026-10-01" } }),
  ],
  [
    "Completion readings must be between the work-order opening readings and current aircraft readings.",
    (w) => ({ supplied: { ...w.opening, cycles: w.opening.cycles - 1 } }),
  ],
  [
    "Enter the Collective hourmeter reading at completion.",
    (w) => {
      Object.assign(w.a, {
        meter: "cyclic",
        currentCyclicHobbs: w.a.currentHobbs,
      });
      return { supplied: w.opening };
    },
  ],
  [
    "Completion Collective hourmeter must be between opening and current readings.",
    (w) => ({ supplied: { ...w.opening, cyclicHobbs: 1 } }),
  ],
  [
    "Enter the Flight time log reading at completion.",
    (w) => {
      Object.assign(w.a, {
        meter: "flightTimeLog",
        currentFlightTimeLog: w.a.currentHobbs,
      });
      return { supplied: w.opening };
    },
  ],
  [
    "Completion Flight time log must be between opening and current readings.",
    (w) => ({ supplied: { ...w.opening, flightTimeLog: 1 } }),
  ],
  [
    "Enter aircraft total landings at completion.",
    (w) => {
      w.s.inspections[0].dueLandings = 5000;
      return { supplied: w.opening };
    },
  ],
  [
    "Completion landings must be between opening and current aircraft totals.",
    (w) => ({ supplied: { ...w.opening, landings: w.a.landings + 1 } }),
  ],
  [
    "The work-order completion date cannot precede its completed job cards.",
    (w) => {
      const card = taskCardCommand().fields;
      w.s.taskCards = [
        {
          ...card,
          uuid: crypto.randomUUID(),
          version: 1,
          createdAt: now,
          createdBy: w.s.user.id,
          updatedAt: now,
          technicianSignoff: null,
          inspectionSignoff: null,
          stepSignoffs: {},
          workOrderUuid: w.order.uuid,
          status: "completed",
          completionDate: "2026-10-03",
        },
      ];
      return {};
    },
  ],
  [
    "A serviced component has moved or has tracking changes after the completion date. Review its tracking before closing this order.",
    (w) => {
      w.engine.removedDate = "2026-10-05";
      return {};
    },
  ],
  [
    "The inspection is unavailable for this work order.",
    (w) => {
      w.s.inspections[0].aircraftUuid = w.s.aircraft[1].uuid;
      return {};
    },
  ],
  [
    "The component service requirement is unavailable.",
    (w) => {
      w.requirement.aircraftUuid = w.s.aircraft[1].uuid;
      return {};
    },
  ],
  [
    "Component compliance would precede existing compliance or lacks a verified time baseline.",
    (w) => {
      w.requirement.lastDate = "2026-12-01";
      return {};
    },
  ],
];

it.each(closeoutRefusals)("refuses close-out: %s", (message, build) => {
  const w = closeoutWorld();
  const { order = w.order, supplied } = build(w);
  let error: unknown;
  try {
    completeWorkOrder(w.s, order, supplied, now);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Rejection);
  expect((error as Error).message).toBe(message);
});

it("records the close-out: readings, signer, components, compliance and work", () => {
  const w = closeoutWorld();
  w.s.user.licenseNumber = "12345";
  w.s.user.certificateType = "A&P";
  const inspection = w.s.inspections[0].uuid;
  const service = {
    componentUuid: "engine",
    version: w.engine.version,
    action: "service" as const,
    description: "",
    reference: "",
  };
  const closeout = completeWorkOrder(w.s, w.order, undefined, now, [service]);
  const totals = componentTotals(w.engine, w.a, "2026-10-02");
  expect(closeout).toMatchObject({
    recordedAt: now,
    aircraft: {
      totalSeconds: totalSeconds(w.a),
      cycles: w.a.cycles,
      registration: w.a.registration,
    },
    completedBy: {
      userId: w.s.user.id,
      licenseNumber: "12345",
      certificateType: "A&P",
    },
    components: [
      {
        componentUuid: "engine",
        label: "Engine",
        timeSinceNew: totals.timeSinceNew,
        cyclesSinceNew: totals.cyclesSinceNew,
        serviceDays: totals.serviceDays,
      },
    ],
    componentWork: [{ componentUuid: "engine", action: "service" }],
  });
  expect(closeout.compliance.map((c) => [c.kind, c.uuid])).toEqual([
    ["inspection", inspection],
    ["componentRequirement", "service"],
  ]);
  expect(closeout.compliance[1]).toMatchObject({
    timeBasis: "TSN",
    date: "2026-10-02",
    seconds: totals.timeSinceNew,
    dueSeconds: totals.timeSinceNew + 10 * 3600,
  });
  expect(closeout.workPerformed).toBe(workPerformedText(w.s, w.order));
});
