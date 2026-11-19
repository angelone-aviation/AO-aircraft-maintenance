/**
 * Responsibility: Pins activating an inspection template as an inspection or
 *   component requirement with task cards, every refusal, and the source
 *   key, duplicate check, limits and next due the activation form shares.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/activateTemplate.ts, ./inspectionTemplates,
 *   ./components, ./rejection, src/data/demo.ts (seed).
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { emptyTemplate } from "./inspectionTemplates";
import {
  activateTemplate,
  activateTemplateSchema,
  TEMPLATE_DESCRIPTION_MAX_LENGTH,
  templateActivationIssue,
  templateLimits,
  templateNextDue,
  templateScheduleExists,
  templateSourceKey,
  type ActivateTemplateInput,
} from "./activateTemplate";
import { REQUIREMENT_WARNING_DEFAULTS, type Component } from "./components";
import { Rejection } from "./rejection";
function fixture() {
  const s = demoSnapshot(),
    a = s.aircraft[0];
  const t = {
    ...emptyTemplate(),
    version: 1,
    programUuid: a.programUuid,
    name: "Template phase",
    hours: 100,
    calendarValue: 12,
    applicability: {
      kind: "aircraft" as const,
      manufacturer: a.make,
      model: a.model,
      partNumber: "",
    },
    tasks: [
      { itemCode: "A1", instruction: "Inspect seals", applicability: "All" },
    ],
  };
  s.inspectionTemplates = [t];
  const input: ActivateTemplateInput = {
    templateUuid: t.uuid,
    templateVersion: 1,
    targetUuid: a.uuid,
    mode: "recurring",
    description: "Inspect seals",
    lastSeconds: 2200 * 3600,
    lastDate: "2025-12-12",
    reviewed: true,
  };
  return { s, t, input };
}
it("creates a schedule and linked unsigned tasks without changing the template", () => {
  const { s, t, input } = fixture();
  const result = activateTemplate(s, input);
  expect(result.record).toMatchObject({
    dueSeconds: 2300 * 3600,
    dueDate: "2026-12-31",
  });
  expect(result.tasks[0]).toMatchObject({
    inspectionUuid: result.record.uuid,
    status: "draft",
    technicianSignoff: null,
    steps: [],
  });
  expect(s.inspectionTemplates![0]).toEqual(t);
  expect(() => activateTemplate(s, input)).toThrow("already exists");
});
it("rejects missing baselines, wrong models and stale templates atomically", () => {
  const { s, input, t } = fixture(),
    before = structuredClone(s);
  expect(() => activateTemplate(s, { ...input, lastDate: undefined })).toThrow(
    "last compliance",
  );
  expect(s).toEqual(before);
  expect(() =>
    activateTemplate(s, { ...input, targetUuid: s.aircraft[1].uuid }),
  ).toThrow("matching aircraft");
  t.version = 2;
  expect(() => activateTemplate(s, input)).toThrow("changed");
});
it("keeps initial thresholds separate from recurring intervals", () => {
  const { s, t, input } = fixture();
  t.initialHours = 1900;
  const initial = activateTemplate(s, {
    ...input,
    mode: "initial",
    lastSeconds: undefined,
    lastDate: undefined,
  });
  expect(initial.record).toMatchObject({ dueSeconds: 1900 * 3600 });
  expect(initial.record).not.toHaveProperty("intervalSeconds", 360000);
  const recurring = activateTemplate(s, input);
  expect(recurring.record).toMatchObject({ intervalSeconds: 360000 });
});
function pump(programUuid: string | undefined, aircraftUuid: string) {
  const c: Component = {
    kind: "component",
    uuid: "pump",
    version: 0,
    programUuid,
    aircraftUuid,
    componentType: "Pump",
    model: "P100",
    manufacturer: "Acme",
    partNumber: "P1",
    serial: "S1",
    notes: "",
    trackTime: true,
    trackCycles: true,
    trackCalendar: true,
    installed: true,
    installedSeconds: 0,
    installedCycles: 0,
    timeSinceNew: 10000000,
    timeSinceOverhaul: 9000000,
    timeSinceRepair: null,
    cyclesSinceNew: 100,
    serviceDaysBase: 0,
  };
  return c;
}
it("creates component requirements preserving day units and TSO limits", () => {
  const { s, t, input } = fixture();
  const c = pump(t.programUuid, input.targetUuid);
  s.management = [c];
  s.inspectionTemplates = [
    {
      ...t,
      applicability: {
        kind: "component",
        model: "P100",
        manufacturer: "Acme",
        partNumber: "P1",
      },
      timeBasis: "TSO",
      calendarUnit: "DAYS",
      calendarValue: 30,
    },
  ];
  const result = activateTemplate(s, {
    ...input,
    targetUuid: c.uuid,
    lastDate: "2025-12-12",
  });
  expect(result.record).toMatchObject({
    kind: "componentRequirement",
    componentUuid: c.uuid,
    timeBasis: "TSO",
    calendarIntervalUnit: "DAYS",
    dueDate: "2026-01-11",
  });
  expect(result.tasks[0]).toMatchObject({
    requirementUuid: result.record.uuid,
    componentUuid: c.uuid,
  });
});
it("refuses a component schedule once the template scheduled that aircraft (characterizes current behaviour)", () => {
  const { s, t, input } = fixture();
  activateTemplate(s, input);
  const c = pump(t.programUuid, input.targetUuid);
  s.management = [...(s.management ?? []), c];
  s.inspectionTemplates = [
    {
      ...t,
      applicability: {
        kind: "component",
        model: "P100",
        manufacturer: "Acme",
        partNumber: "P1",
      },
    },
  ];
  expect(() => activateTemplate(s, { ...input, targetUuid: c.uuid })).toThrow(
    "This template schedule already exists for the selected target.",
  );
});
it("gives template requirements the default warning window and their limit modes", () => {
  const { s, t, input } = fixture();
  const c = pump(t.programUuid, input.targetUuid);
  s.management = [c];
  s.inspectionTemplates = [
    {
      ...t,
      applicability: {
        kind: "component",
        model: "P100",
        manufacturer: "Acme",
        partNumber: "P1",
      },
      hourMode: "ABSOLUTE",
    },
  ];
  const { record } = activateTemplate(s, { ...input, targetUuid: c.uuid });
  expect(record).toMatchObject({
    intervalSeconds: 100 * 3600,
    timeLimitMode: "ABSOLUTE",
    cycleLimitMode: "FROM_LAST_COMPLIED",
    ...REQUIREMENT_WARNING_DEFAULTS,
  });
});
it("schedules a yearly template in months", () => {
  const { s, t, input } = fixture();
  t.calendarUnit = "YEARS";
  t.calendarValue = 2;
  expect(activateTemplate(s, input).record).toMatchObject({
    intervalMonths: 24,
  });
});
it("explains which aircraft templates cannot be scheduled yet", () => {
  const { t } = fixture();
  expect(templateActivationIssue(t)).toBe("");
  expect(
    templateActivationIssue({ ...t, calendarUnit: "DAYS", calendarValue: 30 }),
  ).toMatch(/^Aircraft inspection schedules currently support months/);
  expect(templateActivationIssue({ ...t, timeBasis: "TSO" })).toBe(
    "Aircraft inspections use aircraft total time. Use a component-model template for TSO or TSR limits.",
  );
});
it.each([
  ["otherProgram", "Template is unavailable in this Flight Program."],
  [
    "archived",
    "Template changed or was archived. Reopen it before creating a schedule.",
  ],
  [
    "days",
    "Aircraft inspection schedules currently support months or years, not recurring days. Keep this template until a day-based schedule is available.",
  ],
  [
    "noLimits",
    "This schedule has no numeric limits. Add verified intervals to the template first.",
  ],
  [
    "duplicate",
    "This template schedule already exists for the selected target. Open the existing record to edit it.",
  ],
  ["removedComponent", "Choose an installed component of the template model."],
] as const)("refuses a %s activation, changing nothing", (mode, message) => {
  const { s, t, input } = fixture();
  let target = input;
  if (mode === "otherProgram") t.programUuid = "other";
  if (mode === "archived") t.archived = true;
  if (mode === "days") Object.assign(t, { calendarUnit: "DAYS" });
  if (mode === "noLimits")
    Object.assign(t, { hours: undefined, calendarValue: undefined });
  if (mode === "duplicate") activateTemplate(s, input);
  if (mode === "removedComponent") {
    const c = { ...pump(t.programUuid, input.targetUuid), installed: false };
    s.management = [c];
    s.inspectionTemplates = [
      {
        ...t,
        applicability: {
          kind: "component",
          model: "P100",
          manufacturer: "Acme",
          partNumber: "P1",
        },
      },
    ];
    target = { ...input, targetUuid: c.uuid };
  }
  const before = structuredClone(s);
  const activate = () => activateTemplate(s, target);
  expect(activate).toThrow(Rejection);
  expect(activate).toThrow(message);
  expect(s).toEqual(before);
});

describe("what the activation form shares with the server", () => {
  const component = {
    kind: "component" as const,
    model: "P100",
    manufacturer: "Acme",
    partNumber: "P1",
  };

  it("keys a schedule by template and mode", () => {
    expect(templateSourceKey("t-1", "initial")).toBe("template:t-1:initial");
  });

  it("finds a schedule already made on the target, or on a component's aircraft", () => {
    const { s, t, input } = fixture();
    const c = pump(t.programUuid, input.targetUuid);
    s.management = [c];
    const moved = { ...t, applicability: component };
    expect(templateScheduleExists(s, t, "recurring", input.targetUuid)).toBe(
      false,
    );
    activateTemplate(s, input);
    expect(templateScheduleExists(s, t, "recurring", input.targetUuid)).toBe(
      true,
    );
    expect(templateScheduleExists(s, t, "initial", input.targetUuid)).toBe(
      false,
    );
    expect(templateScheduleExists(s, t, "recurring", "other")).toBe(false);
    expect(templateScheduleExists(s, moved, "recurring", c.uuid)).toBe(true);
    s.inspections = [];
    expect(templateScheduleExists(s, moved, "recurring", c.uuid)).toBe(false);
    s.inspectionTemplates = [moved];
    activateTemplate(s, { ...input, targetUuid: c.uuid });
    expect(templateScheduleExists(s, moved, "recurring", c.uuid)).toBe(true);
  });

  it("takes absolute first-time thresholds for an initial schedule", () => {
    const { t } = fixture();
    Object.assign(t, { initialHours: 50, initialLandings: 5, landings: 9 });
    expect(templateLimits(t, true)).toEqual({
      hours: 50,
      cycles: undefined,
      landings: 5,
      calendar: undefined,
      absoluteHours: true,
      absoluteCycles: true,
      absoluteLandings: true,
    });
    expect(templateLimits(t, false)).toEqual({
      hours: 100,
      cycles: undefined,
      landings: 9,
      calendar: 12,
      absoluteHours: false,
      absoluteCycles: false,
      absoluteLandings: false,
    });
    Object.assign(t, { hourMode: "ABSOLUTE", landingMode: "ABSOLUTE" });
    expect(templateLimits(t, false)).toMatchObject({
      absoluteHours: true,
      absoluteLandings: true,
    });
  });

  it("falls due after the last compliance, absolute limits as they stand", () => {
    const { t } = fixture();
    Object.assign(t, { hours: 0.2, cycles: 50, landings: 50 });
    expect(
      templateNextDue(t, false, { hours: 0.1, cycles: 5, date: "2025-12-12" }),
    ).toEqual({
      hours: 0.3,
      cycles: 55,
      landings: undefined,
      date: "2026-12-31",
    });
    Object.assign(t, { cycleMode: "ABSOLUTE", landingMode: "ABSOLUTE" });
    expect(templateNextDue(t, false, {})).toEqual({
      hours: undefined,
      cycles: 50,
      landings: 50,
      date: undefined,
    });
    expect(templateNextDue({ ...t, initialHours: 7 }, true, {})).toEqual({
      hours: 7,
      cycles: undefined,
      landings: undefined,
      date: undefined,
    });
  });

  it("dates an aircraft inspection to its month end and a component requirement exactly", () => {
    const { t } = fixture();
    const date = "2025-12-12";
    const yearly = { ...t, calendarValue: 1, calendarUnit: "YEARS" as const };
    expect(templateNextDue(yearly, false, { date }).date).toBe("2026-12-31");
    const days = {
      ...t,
      applicability: component,
      calendarValue: 30,
      calendarUnit: "DAYS" as const,
    };
    expect(templateNextDue(days, false, { date }).date).toBe("2026-01-11");
    for (const typing of ["2026-1", "2026-02-30"]) {
      expect(templateNextDue(t, false, { date: typing }).date).toBeUndefined();
      expect(
        templateNextDue(days, false, { date: typing }).date,
      ).toBeUndefined();
    }
  });

  it("limits the description to the exported length", () => {
    const { input } = fixture();
    const parse = (description: string) =>
      activateTemplateSchema.safeParse({ ...input, description }).success;
    expect(parse("x".repeat(TEMPLATE_DESCRIPTION_MAX_LENGTH))).toBe(true);
    expect(parse("x".repeat(TEMPLATE_DESCRIPTION_MAX_LENGTH + 1))).toBe(false);
  });
});
