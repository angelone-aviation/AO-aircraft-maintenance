import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { emptyTemplate, inspectionTemplateSchema } from "./inspectionTemplates";
import { activateTemplate } from "./activateTemplate";
import { applyManagement, validateMaintenanceTotals } from "./management";
import { inspectionStatus } from "./maintenance";
import { applyFlight } from "./flights";
import { totalSeconds } from "./model";
import {
  requirementStatus,
  saveRequirement,
  type ComponentRequirement,
} from "./components";
import {
  workOrderCommand,
  workOrderComponent,
} from "../../tests/fixtures/workOrders";
import {
  newWorkTask,
  saveWorkOrder,
  workOrderFieldsSchema,
} from "./workOrders";
import {
  applyADCommand,
  adTaskStatus,
  blankAD,
  blankADTask,
} from "./airworthiness";
import { adRemaining } from "./adRemaining";
const now = Date.parse("2026-10-26T12:00:00Z");
function setup() {
  const s = demoSnapshot();
  const a = s.aircraft[0];
  a.landings = 1200;
  const t = inspectionTemplateSchema.parse({
    ...emptyTemplate(),
    programUuid: a.programUuid,
    name: "Phase 34",
    version: 1,
    landings: 500,
    applicability: {
      kind: "aircraft",
      manufacturer: a.make,
      model: a.model,
      partNumber: "",
    },
  });
  s.inspectionTemplates = [t];
  const input = {
    templateUuid: t.uuid,
    templateVersion: 1,
    targetUuid: a.uuid,
    mode: "recurring" as const,
    description: "Phase 34",
    lastLandings: 1000,
    reviewed: true as const,
  };
  return { s, a, t, input };
}
it("activates a 500-landing inspection, consumes flight landings independently of cycles, and renews from compliance", () => {
  const { s, a, input } = setup();
  const { record } = activateTemplate(s, input);
  expect(record).toMatchObject({
    intervalLandings: 500,
    lastLandings: 1000,
    dueLandings: 1500,
  });
  const inspection = s.inspections.find((i) => i.uuid === record.uuid)!;
  expect(inspectionStatus(inspection, a)).toMatchObject({
    landingsRemaining: 300,
    status: "scheduled",
  });
  const flown = applyFlight(a, {
    aircraftUuid: a.uuid,
    pilotId: s.user.id,
    startTime: "2026-10-26T11:00:00Z",
    hobbsOn: a.currentHobbs + 3600,
    tachOn: a.currentTach + 3600,
    cycles: 0,
    landings: 300,
    origin: "AAA",
    destination: "BBB",
    operation: "Mission",
    flightRules: "VFR",
    remarks: "",
    discrepancy: "",
  });
  expect(flown.cycles).toBe(a.cycles);
  expect(inspectionStatus(inspection, flown)).toMatchObject({
    landingsRemaining: 0,
    status: "overdue",
  });
  s.aircraft[0] = flown;
  const command = {
    action: "inspection.complete" as const,
    uuid: inspection.uuid,
    version: inspection.version!,
    date: "2026-10-26",
    seconds: totalSeconds(flown),
    cycles: flown.cycles,
    landings: 1500,
    requestUuid: crypto.randomUUID(),
    reason: "Verified compliance",
  };
  expect(() =>
    applyManagement(s, { ...command, landings: undefined }, now),
  ).toThrow("landings");
  const next = applyManagement(s, command, now).next;
  expect(next).toMatchObject({
    lastLandings: 1500,
    dueLandings: 2000,
    archived: false,
  });
  expect(() =>
    validateMaintenanceTotals(
      { ...flown, landings: 1499 },
      s.management ?? [],
      s.inspections,
    ),
  ).toThrow("compliance");
});
it("requires a verified baseline and keeps initial landing limits separate", () => {
  const { s, t, input } = setup();
  expect(() =>
    activateTemplate(s, { ...input, lastLandings: undefined }),
  ).toThrow("last compliance");
  expect(() => activateTemplate(s, { ...input, lastLandings: 1300 })).toThrow(
    "totals",
  );
  t.initialLandings = 500;
  const { record } = activateTemplate(s, {
    ...input,
    mode: "initial",
    lastLandings: undefined,
  });
  expect(record).toMatchObject({ dueLandings: 500 });
  expect(record).not.toHaveProperty("intervalLandings", 500);
});
it("captures backdated work-order landing compliance and rejects missing or out-of-range totals", () => {
  const { s, a, input } = setup();
  const { record } = activateTemplate(s, input);
  const cmd = workOrderCommand();
  cmd.tasks = [
    newWorkTask({ kind: "inspection", uuid: record.uuid }, "Phase 34"),
  ];
  const order = saveWorkOrder(s, cmd, now);
  a.landings = 1400;
  const completion = {
    action: "save" as const,
    uuid: order.uuid,
    version: order.version,
    componentUuids: [],
    fields: {
      ...workOrderFieldsSchema.parse(order),
      status: "completed" as const,
      completionDate: "2026-10-25",
      releaseOutcome: "Reviewed",
    },
    tasks: order.tasks.map((t) => ({ ...t, status: "completed" as const })),
    completionReadings: {
      totalSeconds: totalSeconds(a),
      hobbs: a.currentHobbs,
      tach: a.currentTach,
      cycles: a.cycles,
      landings: 1300,
    },
  };
  expect(() =>
    saveWorkOrder(
      s,
      {
        ...completion,
        completionReadings: {
          ...completion.completionReadings,
          landings: undefined,
        },
      },
      now,
    ),
  ).toThrow("landings");
  expect(() =>
    saveWorkOrder(
      s,
      {
        ...completion,
        completionReadings: {
          ...completion.completionReadings,
          landings: 1500,
        },
      },
      now,
    ),
  ).toThrow("landings");
  const completed = saveWorkOrder(s, completion, now);
  expect(completed.closeout?.aircraft.landings).toBe(1300);
  expect(completed.closeout?.compliance[0]).toMatchObject({
    landings: 1300,
    dueLandings: 1800,
  });
  expect(s.inspections.find((i) => i.uuid === record.uuid)).toMatchObject({
    lastLandings: 1300,
    dueLandings: 1800,
  });
});
it("uses aircraft totals for component services and detects a different installation aircraft", () => {
  const { s, a } = setup();
  const c = workOrderComponent();
  c.trackCycles = false;
  s.management = [c];
  const raw: ComponentRequirement = {
    uuid: "landing-service",
    version: 0,
    kind: "componentRequirement",
    componentUuid: c.uuid,
    aircraftUuid: a.uuid,
    requirementType: "Inspection Requirement",
    description: "Landing gear service",
    notes: "",
    intervalLandings: 500,
    lastLandings: 1000,
    landingLimitMode: "FROM_LAST_COMPLIED",
    timeBasis: "TSN",
    timeLimitMode: "ABSOLUTE",
    cycleLimitMode: "ABSOLUTE",
    calendarIntervalUnit: "MONTHS",
    warningCalendarMonths: 1,
    warningSeconds: 36000,
    warningCycles: 10,
  };
  const saved = saveRequirement(s, raw, now);
  expect(saved).toMatchObject({
    dueLandings: 1500,
    landingReferenceAircraftUuid: a.uuid,
  });
  expect(requirementStatus(saved, c, a)).toMatchObject({
    landings: 300,
    status: "Tracked",
  });
  expect(
    requirementStatus(saved, c, { ...a, uuid: "different-aircraft" }).status,
  ).toBe("Set landing baseline");
  expect(() => saveRequirement(s, { ...raw, lastLandings: 1300 }, now)).toThrow(
    "usage",
  );
});
it("renews landing-based AD actions independently of cycles", () => {
  const { s, a } = setup();
  const r = blankAD(a.uuid);
  r.source.number = "2026-01-01";
  r.applicability = "Applicable";
  r.reviewRequired = false;
  r.tasks = [
    {
      ...blankADTask(),
      description: "Inspect landing gear",
      recurrence: "Recurring",
      intervalLandings: 500,
      dueLandings: 1200,
    },
  ];
  applyADCommand(s, { kind: "save", record: r }, now);
  const saved = s.airworthiness![0];
  const entry = {
    uuid: crypto.randomUUID(),
    taskUuid: saved.tasks[0].uuid,
    date: "2026-10-26",
    hours: null,
    cycles: null,
    landings: 1200,
    method: "Inspected",
    serviceBulletin: "",
    terminatedBy: "",
    workOrderUuid: "",
    mechanic: "Mechanic",
    certificate: "123",
    evidence: "",
    recordedAt: 0,
    recordedBy: "",
  };
  expect(() =>
    applyADCommand(
      s,
      {
        kind: "comply",
        uuid: saved.uuid,
        version: saved.version,
        entry: { ...entry, landings: undefined },
      },
      now,
    ),
  ).toThrow("counter");
  applyADCommand(
    s,
    { kind: "comply", uuid: saved.uuid, version: saved.version, entry },
    now,
  );
  const next = s.airworthiness![0];
  expect(next.tasks[0].dueLandings).toBe(1700);
  expect(adTaskStatus(s, next, next.tasks[0])).toBe("Scheduled");
  expect(adRemaining(s, next, next.tasks[0])).toContainEqual({
    label: "Landings remaining",
    value: "500",
  });
});
