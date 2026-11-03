import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { emptyTemplate } from "./inspectionTemplates";
import {
  activateTemplate,
  type ActivateTemplateInput,
} from "./activateTemplate";
import type { Component } from "./components";
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
it("creates component requirements preserving day units and TSO limits", () => {
  const { s, t, input } = fixture();
  const c: Component = {
    kind: "component",
    uuid: "pump",
    version: 0,
    programUuid: t.programUuid,
    aircraftUuid: input.targetUuid,
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
