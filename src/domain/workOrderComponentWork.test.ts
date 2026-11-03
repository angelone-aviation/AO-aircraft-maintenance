import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  workOrderCommand,
  workOrderComponent,
} from "../../tests/fixtures/workOrders";
import {
  saveWorkOrder,
  workOrderFieldsSchema,
  newWorkTask,
} from "./workOrders";
import {
  componentTotals,
  type Component,
  type ComponentRequirement,
  requirementStatus,
  saveRequirement,
} from "./components";
import type { ComponentWork } from "./workOrderComponentWork";
import { totalSeconds } from "./model";
import { logbookText } from "./logbook";
const now = Date.parse("2026-10-02T12:00:00Z");
function setup(action: ComponentWork["action"] = "both") {
  const s = demoSnapshot();
  const c = { ...workOrderComponent(), timeSinceRepair: 5 * 3600 };
  s.management = [c];
  const cmd = workOrderCommand();
  cmd.componentUuids = [c.uuid];
  const order = saveWorkOrder(s, cmd, now);
  const completion = {
    ...cmd,
    version: order.version,
    fields: {
      ...workOrderFieldsSchema.parse(order),
      status: "completed" as const,
      completionDate: "2026-10-02",
      releaseOutcome: "Reviewed",
      finalReview: "Reviewed",
    },
    componentWork: [
      {
        componentUuid: c.uuid,
        version: c.version,
        action,
        description: "Bench work completed",
        reference: "AMM 72",
      },
    ],
  };
  return { s, c, order, completion };
}
it.each(["service", "repair", "overhaul", "both"] as const)(
  "applies %s exactly once and preserves lifetime usage",
  (action) => {
    const { s, c, completion } = setup(action);
    const before = componentTotals(c, s.aircraft[0], "2026-10-02");
    const final = saveWorkOrder(s, completion, now);
    const next = s.management!.find((r) => r.uuid === c.uuid) as Component;
    const after = componentTotals(next, s.aircraft[0], "2026-10-02");
    expect(after).toEqual({
      ...before,
      calendarOverhaulDays: ["overhaul", "both"].includes(action)
        ? 0
        : before.calendarOverhaulDays,
      timeSinceOverhaul: ["overhaul", "both"].includes(action)
        ? 0
        : before.timeSinceOverhaul,
      timeSinceRepair: ["repair", "both"].includes(action)
        ? 0
        : before.timeSinceRepair,
    });
    expect(final.closeout!.componentWork![0]).toMatchObject({
      action,
      before,
      after,
    });
    const saved = structuredClone(s);
    expect(() =>
      saveWorkOrder(s, { ...completion, version: final.version }, now),
    ).toThrow("closed");
    expect(s).toEqual(saved);
    if (action !== "service")
      expect(
        logbookText(s, final, "maintenance", {
          name: "Test",
          licenseNumber: "123",
          certificateType: "A&P",
        }),
      ).toContain("Bench work completed IAW AMM 72");
    s.aircraft[0].currentHobbs += 3600;
    expect(componentTotals(next, s.aircraft[0]).timeSinceNew).toBe(
      before.timeSinceNew + 3600,
    );
  },
);
it("requires explicit selections and rejects stale, duplicate and foreign components atomically", () => {
  for (const kind of ["missing", "stale", "duplicate", "foreign"] as const) {
    const { s, completion } = setup();
    if (kind === "missing") completion.componentWork = [];
    if (kind === "stale") completion.componentWork[0].version++;
    if (kind === "duplicate")
      completion.componentWork.push(completion.componentWork[0]);
    if (kind === "foreign") completion.componentWork[0].componentUuid = "other";
    const before = structuredClone(s);
    expect(() => saveWorkOrder(s, completion, now)).toThrow();
    expect(s).toEqual(before);
  }
});
it("uses backdated completion readings and retains subsequent flight usage", () => {
  const { s, c, completion } = setup();
  const a = s.aircraft[0];
  const before = componentTotals(c, a, "2026-10-01");
  completion.fields.completionDate = "2026-10-01";
  const completionReadings = {
    totalSeconds: totalSeconds(a),
    hobbs: a.currentHobbs,
    tach: a.currentTach,
    cycles: a.cycles,
  };
  a.currentHobbs += 7200;
  a.cycles += 2;
  const final = saveWorkOrder(s, { ...completion, completionReadings }, now);
  const c2 = s.management!.find((r) => r.uuid === c.uuid) as Component;
  expect(componentTotals(c2, a, "2026-10-02")).toMatchObject({
    timeSinceOverhaul: 7200,
    timeSinceRepair: 7200,
    timeSinceNew: before.timeSinceNew + 7200,
    cyclesSinceNew: before.cyclesSinceNew + 2,
  });
  expect(final.closeout!.componentWork![0].after.timeSinceOverhaul).toBe(0);
});
it("renews overhaul intervals while preserving other inspections and lifetime limits", () => {
  const { s, c, completion } = setup("overhaul");
  const totals = componentTotals(c, s.aircraft[0], "2026-10-02");
  const base: ComponentRequirement = {
    uuid: "oh",
    version: 1,
    kind: "componentRequirement",
    componentUuid: c.uuid,
    aircraftUuid: c.aircraftUuid,
    requirementType: "Overhaul Requirement",
    description: "Overhaul",
    notes: "",
    calendarIntervalUnit: "MONTHS",
    calendarIntervalValue: 12,
    lastDate: "2025-01-01",
    lastSeconds: 0,
    lastCycles: 0,
    timeBasis: "TSO",
    timeLimitMode: "FROM_LAST_COMPLIED",
    intervalSeconds: 100 * 3600,
    dueSeconds: 100 * 3600,
    intervalCycles: 100,
    cycleLimitMode: "FROM_LAST_COMPLIED",
    warningCalendarMonths: 1,
    warningSeconds: 0,
    warningCycles: 0,
  };
  const inspection = {
    ...base,
    uuid: "inspect",
    requirementType: "Inspection Requirement" as const,
    lastSeconds: 20 * 3600,
    dueSeconds: 120 * 3600,
  };
  const life = {
    ...base,
    uuid: "life",
    requirementType: "Life Limits" as const,
    timeBasis: "TSN" as const,
    timeLimitMode: "ABSOLUTE" as const,
  };
  s.management!.push(base, inspection, life);
  const remaining = requirementStatus(
    inspection,
    c,
    s.aircraft[0],
    "2026-10-02",
  );
  saveWorkOrder(s, completion, now);
  const next = s.management!.find((r) => r.uuid === c.uuid) as Component;
  const req = s.management!.find(
    (r) => r.uuid === "oh",
  ) as ComponentRequirement;
  expect(req).toMatchObject({
    lastSeconds: 0,
    dueSeconds: base.intervalSeconds,
    lastCycles: totals.cyclesSinceNew,
    dueCycles: totals.cyclesSinceNew + 100,
    lastDate: "2026-10-02",
    dueDate: "2027-10-31",
  });
  expect(s.management!.find((r) => r.uuid === "life")).toEqual(life);
  const rebased = s.management!.find(
    (r) => r.uuid === "inspect",
  ) as ComponentRequirement;
  expect(requirementStatus(rebased, next, s.aircraft[0], "2026-10-02")).toEqual(
    remaining,
  );
  expect(saveRequirement(s, rebased, now).dueSeconds).toBe(rebased.dueSeconds);
});

it("rolls back an earlier component reset if a later component selection is stale", () => {
  const { s, c, completion } = setup();
  const other = { ...c, uuid: "other-engine", serial: "OTHER" };
  s.management!.push(other);
  completion.componentUuids.push(other.uuid);
  completion.componentWork.push({
    ...completion.componentWork[0],
    componentUuid: other.uuid,
    version: other.version + 1,
  });
  const before = structuredClone(s);
  expect(() => saveWorkOrder(s, completion, now)).toThrow("tracking changed");
  expect(s).toEqual(before);
});

it("shows and saves component service choices while open without changing tracking", () => {
  const { s, c, completion } = setup("repair");
  const requirement: ComponentRequirement = {
    uuid: "planned-service",
    version: 1,
    kind: "componentRequirement",
    componentUuid: c.uuid,
    aircraftUuid: c.aircraftUuid,
    requirementType: "Inspection Requirement",
    description: "Component service",
    notes: "",
    calendarIntervalUnit: "MONTHS",
    timeBasis: "TSN",
    timeLimitMode: "ABSOLUTE",
    intervalSeconds: 1000 * 3600,
    cycleLimitMode: "ABSOLUTE",
    warningCalendarMonths: 1,
    warningSeconds: 0,
    warningCycles: 0,
  };
  s.management!.push(requirement);
  const task = newWorkTask(
    { kind: "componentRequirement", uuid: requirement.uuid },
    requirement.description,
  );
  const before = structuredClone(s.management);
  const saved = saveWorkOrder(
    s,
    {
      ...completion,
      fields: { ...completion.fields, status: "open" },
      componentUuids: [],
      tasks: [task],
      componentWork: [{ ...completion.componentWork[0], description: "" }],
    },
    now,
  );
  expect(saved.componentWork).toHaveLength(1);
  expect(saved.componentWork![0]).toMatchObject({
    action: "repair",
    description: "",
  });
  expect(saved.closeout).toBeUndefined();
  expect(s.management).toEqual(before);
  const finishing = {
    ...completion,
    version: saved.version,
    componentUuids: [],
    tasks: [{ ...task, status: "completed" as const }],
    componentWork: undefined,
  };
  expect(() => saveWorkOrder(s, finishing, now)).toThrow(
    "Describe the component repair",
  );
  const finished = saveWorkOrder(
    s,
    {
      ...finishing,
      componentWork: [
        { ...saved.componentWork![0], description: "Repair finished" },
      ],
    },
    now,
  );
  expect(finished.closeout!.componentWork![0]).toMatchObject({
    action: "repair",
    description: "Repair finished",
  });
});
